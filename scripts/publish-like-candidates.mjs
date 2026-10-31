import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REPOSITORIES = new Set(['neronote100/Prince_like_giver', 'neronote100/nero_comment_reader']);
const BRANCH = 'manual-candidates';
const FILE = 'data/like-candidates.json';
const OWNER = 'nero_notelover';
const SHA = /^[a-f0-9]{40}$/;
const PARTIAL_REASONS = new Set(['source_exhausted', 'profile_limit', 'request_limit', 'time_limit']);
const SUMMARY_KEYS = ['scanned', 'already_liked', 'existing_relationship_or_unknown', 'insufficient_follow_gap', 'inactive_30_days', 'unknown_like_state', 'unknown_articles', 'invalid_profile', 'errors'];
const whole = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

export class PublishError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
  }
}

/** Only the public feed schema crosses the boundary into the public branch. */
export function publicCandidateReport(input, now = Date.now()) {
  if (!object(input) || input.owner !== OWNER || input.version !== 1 || input.targetCount !== 30 ||
      !Array.isArray(input.candidates) || input.candidates.length > 30 || typeof input.complete !== 'boolean')
    throw new PublishError('CANDIDATE_REPORT_INVALID');
  if (input.rateLimited === true || input.reason === 'note_access_paused') throw new PublishError('NOTE_ACCESS_PAUSED');
  if (input.rateLimited !== false || input.complete !== (input.candidates.length === 30) ||
      (input.complete ? input.reason !== 'target_reached' : !PARTIAL_REASONS.has(input.reason)))
    throw new PublishError('CANDIDATE_REPORT_INVALID');
  const generated = Date.parse(input.generatedAt);
  if (!Number.isFinite(generated) || new Date(generated).toISOString() !== input.generatedAt || generated > now + 30_000 ||
      now - generated > 2 * 60 * 60 * 1000) throw new PublishError('CANDIDATE_REPORT_STALE');
  if (!object(input.summary) || SUMMARY_KEYS.some(key => !whole(input.summary[key])) ||
      ['requests', 'scannedSeedCount', 'pooledUsers'].some(key => !whole(input[key]))) throw new PublishError('CANDIDATE_REPORT_INVALID');
  if (input.candidates.length === 0 && input.summary.errors > 0) throw new PublishError('COLLECTION_INCOMPLETE');
  const users = new Set(), keys = new Set();
  const candidates = input.candidates.map(row => {
    if (!object(row) || typeof row.user !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(row.user) || row.user === OWNER || users.has(row.user) ||
        !text(row.name, 80) || !text(row.articleTitle, 150) || !whole(row.following) || !whole(row.followers) ||
        row.following - row.followers < 10 || row.following * 100 < row.followers * 115 ||
        row.gap !== row.following - row.followers || row.liked !== false || row.status !== 'review_only')
      throw new PublishError('CANDIDATE_REPORT_INVALID');
    const match = typeof row.articleUrl === 'string' && row.articleUrl.match(/^https:\/\/note\.com\/([a-z0-9_-]{1,64})\/n\/(n[a-f0-9]{8,32})$/);
    if (!match || match[1] !== row.user || keys.has(match[2]) || row.profileUrl !== 'https://note.com/' + row.user)
      throw new PublishError('CANDIDATE_REPORT_INVALID');
    const published = Date.parse(row.publishedAt);
    if (!Number.isFinite(published) || published > generated || generated - published > 30 * 86400_000)
      throw new PublishError('CANDIDATE_REPORT_INVALID');
    users.add(row.user); keys.add(match[2]);
    return {
      user: row.user, name: row.name, profileUrl: row.profileUrl,
      following: row.following, followers: row.followers, gap: row.gap,
      articleTitle: row.articleTitle, publishedAt: row.publishedAt,
      articleUrl: row.articleUrl, liked: false, status: 'review_only'
    };
  });
  return {
    version: 1, owner: OWNER, generatedAt: input.generatedAt, targetCount: 30,
    complete: input.complete, reason: input.reason, rateLimited: false,
    requests: input.requests, scannedSeedCount: input.scannedSeedCount, pooledUsers: input.pooledUsers,
    summary: Object.fromEntries(SUMMARY_KEYS.map(key => [key, input.summary[key]])), candidates
  };
}

export async function publishCandidateReport({ report, repository, token, fetcher = globalThis.fetch, now = Date.now() } = {}) {
  if (!REPOSITORIES.has(repository) || typeof token !== 'string' || !token || token.length > 1024 || /[\s\u0000-\u001f\u007f]/.test(token) ||
      typeof fetcher !== 'function') throw new PublishError('PUBLISH_CONFIGURATION_INVALID');
  const feed = publicCandidateReport(report, now);
  const root = 'https://api.github.com/repos/' + repository;
  async function api(method, path, body, missing = false) {
    let response;
    try {
      response = await fetcher(root + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'nero-comment-reader-candidates',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch { throw new PublishError('PUBLISH_NETWORK_FAILED'); }
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new PublishError('PUBLISH_HTTP_FAILED', response.status);
    try {
      const raw = await response.text();
      if (raw.length > 2_000_000) throw Error();
      return JSON.parse(raw);
    } catch { throw new PublishError('PUBLISH_RESPONSE_INVALID'); }
  }
  async function head() {
    const result = await api('GET', '/git/ref/heads/' + BRANCH, undefined, true);
    if (result === null) return null;
    if (result.ref !== 'refs/heads/' + BRANCH || result.object?.type !== 'commit' || !SHA.test(result.object?.sha))
      throw new PublishError('PUBLISH_RESPONSE_INVALID');
    return result.object.sha;
  }
  const parent = await head();
  const tree = await api('POST', '/git/trees', { tree: [{ path: FILE, mode: '100644', type: 'blob', content: JSON.stringify(feed, null, 2) + '\n' }] });
  if (!SHA.test(tree?.sha)) throw new PublishError('PUBLISH_RESPONSE_INVALID');
  const commit = await api('POST', '/git/commits', {
    message: 'Update manual note candidates (' + feed.candidates.length + '/30)',
    tree: tree.sha,
    // An orphan bootstrap contains no source or workflow files.
    parents: parent === null ? [] : [parent]
  });
  if (!SHA.test(commit?.sha)) throw new PublishError('PUBLISH_RESPONSE_INVALID');
  if (await head() !== parent) throw new PublishError('PUBLISH_CONCURRENT_UPDATE');
  if (parent === null) await api('POST', '/git/refs', { ref: 'refs/heads/' + BRANCH, sha: commit.sha });
  else await api('PATCH', '/git/refs/heads/' + BRANCH, { sha: commit.sha, force: false });
  if (await head() !== commit.sha) throw new PublishError('PUBLISH_UNCONFIRMED');
  return { count: feed.candidates.length, targetCount: 30, complete: feed.complete, reason: feed.reason, commit: commit.sha,
    url: 'https://raw.githubusercontent.com/' + repository + '/' + BRANCH + '/' + FILE };
}

async function main() {
  const raw = await readFile('data/like-candidates.json', 'utf8');
  if (raw.length > 300_000) throw new PublishError('CANDIDATE_REPORT_INVALID');
  let report;
  try { report = JSON.parse(raw); } catch { throw new PublishError('CANDIDATE_REPORT_INVALID'); }
  const result = await publishCandidateReport({ report, repository: process.env.CANDIDATE_PUBLISH_REPOSITORY, token: process.env.GITHUB_TOKEN });
  console.log('CANDIDATE_FEED_PUBLISHED ' + JSON.stringify(result));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '手動スキ候補: **' + result.count + ' / 30人**\n\n' +
    '抽出結果: `' + result.reason + '`。noteへのスキ送信は行いません。\n\n' +
    '[Comment Readerで候補を開く](https://neronote100.github.io/nero_comment_reader/#like-candidates)\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = error instanceof PublishError ? error.code : 'PUBLISH_FAILED';
    console.error('CANDIDATE_PUBLISH_FAILED ' + JSON.stringify({ code, ...(error instanceof PublishError && error.status ? { status: error.status } : {}) }));
    process.exitCode = 1;
  });
}
