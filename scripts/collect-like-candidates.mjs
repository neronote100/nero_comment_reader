import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const OWNER = 'nero_notelover';
const ROOT = 'https://note.com';
const NAME = /^[a-z0-9_-]{1,64}$/i;
const USER_KEY = /^[a-f0-9]{24,40}$/i;
const NOTE_KEY = /^n[a-f0-9]{8,32}$/i;
const RECENT_MS = 30 * 86_400_000;
const ACCESS_REFUSED = new Set([401, 403, 429]);
const DEFAULTS = Object.freeze({
  targetCount: 30, maxProfiles: 450, maxSeeds: 30, maxFollowerPages: 3,
  maxFollowingPages: 3, maxRequests: 1100, maxDurationMs: 10 * 60 * 1000,
  requestDelayMs: 250,
});

export class CandidateCollectionError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'CandidateCollectionError';
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
  }
}

function integerCount(value) {
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function qualifiesByFollowRatio(followingRaw, followersRaw) {
  const following = integerCount(followingRaw), followers = integerCount(followersRaw);
  return following !== null && followers !== null && following > followers &&
    following - followers >= 10 && BigInt(following) * 100n >= BigInt(followers) * 115n;
}

const cleanText = (value, length) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, length);

export function evaluateProfile(profile, articlePayload, now = Date.now()) {
  const p = profile?.data ?? profile;
  const username = String(p?.urlname ?? '').toLowerCase();
  if (!p || !NAME.test(username) || username === OWNER) return { reason: 'invalid_profile' };
  if (p.isFollowing !== false || p.isFollowed !== false) return { reason: 'existing_relationship_or_unknown' };
  if (!qualifiesByFollowRatio(p.followingCount, p.followerCount)) return { reason: 'insufficient_follow_gap' };
  const articles = articlePayload?.data?.contents;
  if (!Array.isArray(articles)) return { reason: 'unknown_articles' };
  const recent = articles.filter(article => {
    const time = Date.parse(String(article?.publishAt ?? article?.publishedAt ?? ''));
    return Number.isFinite(time) && time <= now && now - time <= RECENT_MS && NOTE_KEY.test(String(article?.key ?? ''));
  });
  if (!recent.length) return { reason: 'inactive_30_days' };
  if (recent.some(article => article.isLiked === true)) return { reason: 'already_liked' };
  if (recent.some(article => article.isLiked !== false)) return { reason: 'unknown_like_state' };
  recent.sort((a, b) => Date.parse(b.publishAt ?? b.publishedAt) - Date.parse(a.publishAt ?? a.publishedAt));
  const article = recent[0];
  const following = integerCount(p.followingCount), followers = integerCount(p.followerCount);
  return { reason: 'eligible', candidate: {
    user: username, name: cleanText(p.nickname ?? username, 80),
    profileUrl: ROOT + '/' + username, following, followers, gap: following - followers,
    articleTitle: cleanText(article.name ?? article.title, 150),
    publishedAt: new Date(article.publishAt ?? article.publishedAt).toISOString(),
    articleUrl: ROOT + '/' + username + '/n/' + String(article.key).toLowerCase(),
    liked: false, status: 'review_only',
  } };
}

export function sessionValue(raw) {
  const source = String(raw ?? '');
  const trimmed = source.trim();
  if (!trimmed || source.length > 16_384 || /[\r\n\u0000]/.test(trimmed)) throw new CandidateCollectionError('SESSION_INVALID');
  const text = trimmed.replace(/^cookie:\s*/i, '').trim().replace(/^['"]|['"]$/g, '');
  const pairs = text.split(';').map(value => value.trim()).filter(value => value.startsWith('_note_session_v5='));
  if (pairs.length > 1) throw new CandidateCollectionError('SESSION_INVALID');
  const value = (pairs.length ? pairs[0].slice('_note_session_v5='.length) : text).replace(/^['"]|['"]$/g, '');
  if (!value || /[\s;\u0000-\u001f\u007f]/.test(value)) throw new CandidateCollectionError('SESSION_INVALID');
  return value;
}

function followPage(payload, page) {
  const data = payload?.data;
  if (!data || !Array.isArray(data.follows)) throw new CandidateCollectionError('FOLLOW_DATA_INVALID');
  const names = [...new Set(data.follows.map(row => String(row?.urlname ?? '').toLowerCase())
    .filter(name => NAME.test(name) && name !== OWNER))];
  const explicit = data.next_page ?? data.nextPage ?? payload.next_page ?? payload.nextPage;
  const last = data.isLastPage === true || data.is_last_page === true || data.lastPage === true;
  const explicitEnd = ['next_page', 'nextPage'].some(key =>
    Object.hasOwn(data, key) && data[key] === null || Object.hasOwn(payload, key) && payload[key] === null);
  let next = null;
  if (!last && !explicitEnd) {
    if (explicit !== undefined && explicit !== null) {
      const numeric = Number(explicit);
      if (!Number.isSafeInteger(numeric) || numeric <= page) throw new CandidateCollectionError('FOLLOW_DATA_INVALID');
      next = numeric;
    } else if (data.follows.length >= 20) next = page + 1;
  }
  return { names, next };
}

function optionsFrom(options) {
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (options[key] !== undefined) settings[key] = options[key];
    const minimum = key === 'requestDelayMs' ? 0 : 1;
    if (!Number.isSafeInteger(settings[key]) || settings[key] < minimum || settings[key] > DEFAULTS[key])
      throw new CandidateCollectionError('CONFIG_INVALID');
  }
  return settings;
}

/** Read-only selection. `read` receives only fixed note API GET paths. */
export async function collectCandidates({ read, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), ...options } = {}) {
  if (typeof read !== 'function' || typeof now !== 'function' || typeof wait !== 'function') throw new CandidateCollectionError('CONFIG_INVALID');
  const config = optionsFrom(options);
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new CandidateCollectionError('CONFIG_INVALID');
  const summary = { scanned: 0, already_liked: 0, existing_relationship_or_unknown: 0,
    insufficient_follow_gap: 0, inactive_30_days: 0, unknown_like_state: 0,
    unknown_articles: 0, invalid_profile: 0, errors: 0 };
  const candidates = [], pool = new Set(), seedNames = [], seedKeys = [];
  let requests = 0, reason = null, rateLimited = false;
  async function checkedRead(path) {
    if (reason) throw new CandidateCollectionError('COLLECTION_STOPPED');
    if (requests >= config.maxRequests) {
      reason = 'request_limit';
      throw new CandidateCollectionError('REQUEST_LIMIT');
    }
    if (requests) await wait(config.requestDelayMs);
    if (now() - startedAt >= config.maxDurationMs) {
      reason = 'time_limit';
      throw new CandidateCollectionError('TIME_LIMIT');
    }
    requests++;
    try { return await read(path); }
    catch (error) {
      if (ACCESS_REFUSED.has(error?.status)) { rateLimited = true; reason = 'note_access_paused'; }
      throw new CandidateCollectionError('NOTE_READ_FAILED', error?.status);
    }
  }
  function failed() { summary.errors++; }
  const payload = await checkedRead('/api/v1/current_user');
  const owner = payload?.data?.user ?? payload?.data ?? payload?.user ?? payload;
  if (owner?.urlname !== OWNER || owner?.is_me === false || !USER_KEY.test(String(owner?.key ?? '')))
    throw new CandidateCollectionError('OWNER_REQUIRED');

  // Expand the former single 20-person page so the same criteria can yield 30 people.
  for (let page = 1; page <= config.maxFollowingPages && seedNames.length < config.maxSeeds && !reason;) {
    try {
      const found = followPage(await checkedRead('/api/v3/users/' + owner.key + '/followings?page=' + page + '&per=20'), page);
      for (const name of found.names) if (!seedNames.includes(name) && seedNames.length < config.maxSeeds) seedNames.push(name);
      if (found.next === null || found.next > config.maxFollowingPages) break;
      page = found.next;
    } catch { failed(); break; }
  }
  for (const name of seedNames) {
    if (reason) break;
    try {
      const profile = await checkedRead('/api/v2/creators/' + name);
      const p = profile?.data ?? profile;
      if (String(p?.urlname ?? '').toLowerCase() !== name || !USER_KEY.test(String(p?.key ?? ''))) { failed(); continue; }
      seedKeys.push({ key: String(p.key).toLowerCase(), page: 1 });
    } catch { failed(); }
  }
  // Round-robin pages across seeds, instead of filling the entire pool from one person.
  for (let round = 1; round <= config.maxFollowerPages && pool.size < config.maxProfiles && !reason; round++) {
    for (const seed of seedKeys) {
      if (reason || pool.size >= config.maxProfiles) break;
      if (seed.page !== round) continue;
      try {
        const found = followPage(await checkedRead('/api/v3/users/' + seed.key + '/followers?page=' + round + '&per=20'), round);
        for (const name of found.names) {
          if (pool.size >= config.maxProfiles) break;
          pool.add(name);
        }
        seed.page = found.next;
      } catch { failed(); seed.page = null; }
    }
  }
  for (const username of pool) {
    if (reason || summary.scanned >= config.maxProfiles || candidates.length >= config.targetCount) break;
    summary.scanned++;
    try {
      const profile = await checkedRead('/api/v2/creators/' + username);
      const p = profile?.data ?? profile;
      if (String(p?.urlname ?? '').toLowerCase() !== username) { summary.invalid_profile++; continue; }
      if (p.isFollowing !== false || p.isFollowed !== false) { summary.existing_relationship_or_unknown++; continue; }
      if (!qualifiesByFollowRatio(p.followingCount, p.followerCount)) { summary.insufficient_follow_gap++; continue; }
      const articles = await checkedRead('/api/v2/creators/' + username + '/contents?kind=note&disabled_pinned=true&page=1');
      const verdict = evaluateProfile(profile, articles, now());
      if (verdict.candidate) candidates.push(verdict.candidate);
      else summary[verdict.reason]++;
    } catch { failed(); }
  }
  const complete = candidates.length >= config.targetCount;
  if (complete) reason = 'target_reached';
  else if (!reason) reason = summary.scanned >= config.maxProfiles ? 'profile_limit' : 'source_exhausted';
  candidates.sort((a, b) => b.gap - a.gap || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return { version: 1, owner: OWNER, generatedAt: new Date(now()).toISOString(), targetCount: config.targetCount,
    complete, reason, rateLimited, requests, scannedSeedCount: seedKeys.length, pooledUsers: pool.size,
    summary, candidates };
}

function permittedReadPath(path) {
  return path === '/api/v1/current_user' ||
    /^\/api\/v2\/creators\/[a-z0-9_-]{1,64}(?:\/contents\?kind=note&disabled_pinned=true&page=1)?$/.test(path) ||
    /^\/api\/v3\/users\/[a-f0-9]{24,40}\/(?:followers|followings)\?page=[1-9]\d{0,2}&per=20$/.test(path);
}

export async function collect({ rawCookie, chromePath, launch, ...options } = {}) {
  const value = sessionValue(rawCookie);
  if (!launch) {
    const { chromium } = await import('playwright-core');
    launch = settings => chromium.launch(settings);
  }
  const browser = await launch({ headless: true, executablePath: chromePath || '/usr/bin/google-chrome',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NOTE_SESSION_COOKIE', 'GITHUB_TOKEN', 'GH_TOKEN'].includes(key))) });
  try {
    const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    await context.addCookies([{ name: '_note_session_v5', value, domain: '.note.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    return await collectCandidates({ ...options, read: async path => {
      if (!permittedReadPath(path)) throw new CandidateCollectionError('NOTE_PATH_INVALID');
      let response;
      try {
        response = await context.request.get(ROOT + path, { timeout: 20_000, maxRetries: 0, maxRedirects: 0,
          headers: { Accept: 'application/json' } });
        if (response.status() !== 200) throw new CandidateCollectionError('NOTE_READ_FAILED', response.status());
        const text = await response.text();
        if (text.length > 1_000_000) throw new CandidateCollectionError('NOTE_DATA_INVALID');
        try { return JSON.parse(text); } catch { throw new CandidateCollectionError('NOTE_DATA_INVALID'); }
      } catch (error) {
        throw new CandidateCollectionError('NOTE_READ_FAILED', error?.status);
      } finally { if (response?.dispose) await response.dispose().catch(() => {}); }
    } });
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collect({ rawCookie: process.env.NOTE_SESSION_COOKIE, chromePath: process.env.CHROME_BIN }).then(async result => {
    await mkdir('data', { recursive: true });
    await writeFile('data/like-candidates.json', JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log('CANDIDATE_SUMMARY ' + JSON.stringify({ generatedAt: result.generatedAt, candidates: result.candidates.length,
      targetCount: result.targetCount, complete: result.complete, reason: result.reason,
      scanned: result.summary.scanned, requests: result.requests, errors: result.summary.errors }));
  }).catch(error => {
    const allowed = new Set(['SESSION_INVALID', 'OWNER_REQUIRED', 'CONFIG_INVALID', 'NOTE_READ_FAILED']);
    console.error('CANDIDATE_COLLECTION_FAILED ' + JSON.stringify({ code: allowed.has(error?.code) ? error.code : 'COLLECTION_FAILED' }));
    process.exitCode = 1;
  });
}
