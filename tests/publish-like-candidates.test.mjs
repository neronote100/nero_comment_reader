import test from 'node:test';
import assert from 'node:assert/strict';
import { publicCandidateReport, publishCandidateReport } from '../scripts/publish-like-candidates.mjs';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const ROOT = 'https://api.github.com/repos/neronote100/Prince_like_giver';
const OLD = 'a'.repeat(40), TREE = 'b'.repeat(40), COMMIT = 'c'.repeat(40);
function report(count = 30) {
  return {
    version: 1, owner: 'nero_notelover', generatedAt: new Date(NOW).toISOString(),
    targetCount: 30, complete: count === 30, reason: count === 30 ? 'target_reached' : 'source_exhausted',
    rateLimited: false, requests: 90, scannedSeedCount: 5, pooledUsers: 80,
    summary: { scanned: 80, already_liked: 0, existing_relationship_or_unknown: 0, insufficient_follow_gap: 0,
      inactive_30_days: 0, unknown_like_state: 0, unknown_articles: 0, invalid_profile: 0, errors: 0 },
    candidates: Array.from({ length: count }, (_, i) => ({
      user: 'writer' + i, name: '候補' + i, profileUrl: 'https://note.com/writer' + i,
      following: 200, followers: 100, gap: 100, articleTitle: '記事' + i,
      publishedAt: new Date(NOW - 60_000).toISOString(),
      articleUrl: 'https://note.com/writer' + i + '/n/n' + (i + 1).toString(16).padStart(12, '0'),
      liked: false, status: 'review_only'
    }))
  };
}

function github({ initial = null, fail, race = false, badFinal = false } = {}) {
  const calls = [];
  let head = initial, reads = 0;
  return {
    calls,
    async fetcher(url, options) {
      assert.ok(url.startsWith(ROOT + '/git/'));
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer PRIVATE_TEST_TOKEN');
      const path = url.slice(ROOT.length), body = options.body === undefined ? undefined : JSON.parse(options.body);
      calls.push({ method: options.method, path, body });
      if (fail?.path === path && fail?.method === options.method) return new Response('PRIVATE_SERVER_BODY', { status: fail.status });
      let payload;
      if (options.method === 'GET' && path === '/git/ref/heads/manual-candidates') {
        reads++;
        if (race && reads === 2) head = OLD;
        if (badFinal && reads === 3) head = OLD;
        if (head === null) return new Response('{}', { status: 404 });
        payload = { ref: 'refs/heads/manual-candidates', object: { type: 'commit', sha: head } };
      } else if (options.method === 'POST' && path === '/git/trees') payload = { sha: TREE };
      else if (options.method === 'POST' && path === '/git/commits') payload = { sha: COMMIT };
      else if (options.method === 'POST' && path === '/git/refs') { head = body.sha; payload = { ref: body.ref }; }
      else if (options.method === 'PATCH' && path === '/git/refs/heads/manual-candidates') { head = body.sha; payload = { ref: 'refs/heads/manual-candidates' }; }
      else assert.fail(options.method + ' ' + path);
      return new Response(JSON.stringify(payload), { status: 200 });
    }
  };
}
const publish = (input, api, options = {}) => publishCandidateReport({ report: input,
  repository: 'neronote100/Prince_like_giver', token: 'PRIVATE_TEST_TOKEN', fetcher: api.fetcher, now: NOW, ...options });

test('bootstraps a public feed with thirty people and no source/workflow parent', async () => {
  const api = github();
  const input = report();
  input.privateCookie = 'PRIVATE_DO_NOT_PUBLISH';
  input.candidates[0].privateDetail = 'PRIVATE_DO_NOT_PUBLISH';
  const result = await publish(input, api);
  assert.equal(result.count, 30);
  assert.equal(result.complete, true);
  assert.equal(result.commit, COMMIT);
  assert.equal(result.url, 'https://raw.githubusercontent.com/neronote100/Prince_like_giver/manual-candidates/data/like-candidates.json');
  const tree = api.calls.find(call => call.path === '/git/trees');
  assert.equal(tree.body.tree.length, 1);
  assert.equal(tree.body.tree[0].path, 'data/like-candidates.json');
  const feed = JSON.parse(tree.body.tree[0].content);
  assert.equal(feed.candidates.length, 30);
  assert.ok(!JSON.stringify(api.calls).includes('PRIVATE_DO_NOT_PUBLISH'));
  assert.deepEqual(api.calls.find(call => call.path === '/git/commits').body.parents, []);
  assert.ok(api.calls.some(call => call.method === 'POST' && call.path === '/git/refs'));
});

test('updates only the feed branch with a non-forced descendant commit', async () => {
  const api = github({ initial: OLD });
  await publish(report(), api);
  assert.deepEqual(api.calls.find(call => call.path === '/git/commits').body.parents, [OLD]);
  assert.deepEqual(api.calls.find(call => call.method === 'PATCH').body, { sha: COMMIT, force: false });
  assert.ok(api.calls.every(call => !call.path.includes('heads/main')));
});

test('publishes honest partial and zero-person results', async () => {
  for (const count of [0, 17, 29]) {
    const api = github();
    const result = await publish(report(count), api);
    assert.equal(result.count, count);
    assert.equal(result.complete, false);
    assert.equal(result.reason, 'source_exhausted');
  }
});

test('access refusal preserves the previous public feed without any GitHub request', async () => {
  for (const changes of [{ rateLimited: true }, { reason: 'note_access_paused' }]) {
    const api = github({ initial: OLD });
    await assert.rejects(publish({ ...report(7), ...changes }, api), { code: 'NOTE_ACCESS_PAUSED' });
    assert.equal(api.calls.length, 0);
  }
});

test('a zero-result scan with collection failures retains the previous feed', async () => {
  const api = github({ initial: OLD });
  const input = report(0);
  input.summary.errors = 1;
  await assert.rejects(publish(input, api), { code: 'COLLECTION_INCOMPLETE' });
  assert.equal(api.calls.length, 0);
});

test('publication preserves eligibility at the collection-time thirty-day boundary', async () => {
  const input = report();
  input.candidates[0].publishedAt = new Date(NOW - 30 * 86400_000).toISOString();
  input.candidates[0].following = 200_000;
  input.candidates[0].followers = 100_001;
  input.candidates[0].gap = 99_999;
  const api = github();
  const result = await publish(input, api, { now: NOW + 60_000 });
  assert.equal(result.count, 30);
});

test('rejects duplicate, unsafe, inconsistent and unverified candidate data', () => {
  const cases = [
    value => { value.candidates[0].articleUrl = 'https://evil.invalid/a'; },
    value => { value.candidates[1] = { ...value.candidates[0] }; },
    value => { value.candidates[0].liked = undefined; },
    value => { value.candidates[0].following = 114; value.candidates[0].gap = 14; },
    value => { value.candidates[0].following = 20; value.candidates[0].followers = 17; value.candidates[0].gap = 3; },
    value => { value.candidates[0].publishedAt = new Date(NOW + 1).toISOString(); },
    value => { value.complete = false; },
    value => { value.summary.errors = '0'; },
    value => { value.owner = 'another_owner'; }
  ];
  for (const change of cases) {
    const value = report(); change(value);
    assert.throws(() => publicCandidateReport(value, NOW), { code: 'CANDIDATE_REPORT_INVALID' });
  }
});

test('requires a fresh report and an allowed publication repository', async () => {
  const stale = report(); stale.generatedAt = new Date(NOW - 2 * 3600_000 - 1).toISOString();
  assert.throws(() => publicCandidateReport(stale, NOW), { code: 'CANDIDATE_REPORT_STALE' });
  const api = github();
  await assert.rejects(publish(report(), api, { repository: 'attacker/repository' }), { code: 'PUBLISH_CONFIGURATION_INVALID' });
  await assert.rejects(publish(report(), api, { token: '' }), { code: 'PUBLISH_CONFIGURATION_INVALID' });
  assert.equal(api.calls.length, 0);
});

test('concurrent publication stops before changing the branch', async () => {
  const api = github({ race: true });
  await assert.rejects(publish(report(), api), { code: 'PUBLISH_CONCURRENT_UPDATE' });
  assert.ok(api.calls.every(call => call.path !== '/git/refs' && call.method !== 'PATCH'));
});

test('ref update refusal and unconfirmed writes expose fixed diagnostics only', async () => {
  const api = github({ initial: OLD, fail: { path: '/git/refs/heads/manual-candidates', method: 'PATCH', status: 403 } });
  await assert.rejects(publish(report(), api), error => {
    assert.equal(error.code, 'PUBLISH_HTTP_FAILED');
    assert.equal(error.status, 403);
    assert.ok(!String(error).includes('PRIVATE_SERVER_BODY'));
    assert.ok(!String(error).includes('PRIVATE_TEST_TOKEN'));
    return true;
  });
  await assert.rejects(publish(report(), github({ badFinal: true })), { code: 'PUBLISH_UNCONFIRMED' });
});
