import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, collectCandidates, evaluateProfile, qualifiesByFollowRatio, sessionValue } from '../scripts/collect-like-candidates.mjs';
import { PRIORITY_SEEDS, normalizePrioritySources, rankCandidates } from '../candidate-priority.js';

const NOW = Date.parse('2026-11-01T03:00:00Z');
const OWNER_KEY = 'a'.repeat(24);
const SEED_KEY = 'b'.repeat(24);
const wait = async () => {};
const profile = (user = 'writer', extra = {}) => ({ data: { urlname: user, nickname: 'Writer',
  isFollowing: false, isFollowed: false, followingCount: 115, followerCount: 100, ...extra } });
const article = (index = 1, extra = {}) => ({ key: 'n' + index.toString(16).padStart(12, '0'),
  name: 'Article ' + index, publishAt: '2026-10-31T03:00:00Z', isLiked: false, ...extra });
const contents = (...articles) => ({ data: { contents: articles } });
const collectLegacy = options => collectCandidates({ prioritySeeds: [], ...options });

function fixture({ refusePath = '', refuseStatus = 429 } = {}) {
  const calls = [];
  async function read(path) {
    calls.push(path);
    if (path === refusePath) throw Object.assign(new Error('PRIVATE_HTTP_BODY'), { status: refuseStatus });
    if (path === '/api/v1/current_user') return { data: { urlname: 'nero_notelover', key: OWNER_KEY } };
    if (path.includes('/followings?')) return { data: { follows: [{ urlname: 'seed' }], isLastPage: true } };
    if (path === '/api/v2/creators/seed') return profile('seed', { key: SEED_KEY });
    if (path.includes('/followers?page=1&')) return { data: { follows: Array.from({ length: 20 }, (_, index) => ({ urlname: 'writer' + index })) } };
    if (path.includes('/followers?page=2&')) return { data: { follows:
      Array.from({ length: 20 }, (_, index) => ({ urlname: 'writer' + (index + 20) })), isLastPage: true } };
    const match = path.match(/^\/api\/v2\/creators\/writer(\d+)(\/contents\?.*)?$/);
    if (match) return match[2] ? contents(article(Number(match[1]) + 1)) : profile('writer' + match[1], {
      followingCount: 200 + Number(match[1]),
      privateCredential: 'PRIVATE_PROFILE_FIELD',
    });
    throw new Error('Unexpected fixture path: ' + path);
  }
  return { read, calls };
}

function priorityFixture({ priorityGraphs = {}, fallbackGraphs = {}, profiles = {}, missingSources = [] } = {}) {
  const calls = [];
  const sources = [...PRIORITY_SEEDS, ...Object.keys(fallbackGraphs)];
  const keys = new Map(sources.map((source, index) => [source, (100 + index).toString(16).padStart(24, '0')]));
  const graphs = { ...priorityGraphs, ...fallbackGraphs };
  async function read(path) {
    calls.push(path);
    if (path === '/api/v1/current_user') return { data: { urlname: 'nero_notelover', key: OWNER_KEY } };
    if (path.includes('/followings?')) return { data: { follows: Object.keys(fallbackGraphs).map(urlname => ({ urlname })), isLastPage: true } };
    const graph = path.match(/^\/api\/v3\/users\/([a-f0-9]+)\/followers\?page=(\d+)&per=20$/);
    if (graph) {
      const source = sources.find(name => keys.get(name) === graph[1]);
      const pages = graphs[source] ?? [[]], page = Number(graph[2]);
      return { data: { follows: (pages[page - 1] ?? []).map(urlname => ({ urlname })), nextPage: page < pages.length ? page + 1 : null } };
    }
    const user = path.match(/^\/api\/v2\/creators\/([a-z0-9_-]+)(\/contents\?.*)?$/);
    if (user) {
      const name = user[1];
      if (missingSources.includes(name)) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
      if (user[2]) return contents(article());
      return profile(name, { followingCount: 200, ...(keys.has(name) ? { key: keys.get(name) } : {}), ...profiles[name] });
    }
    throw new Error('Unexpected fixture path: ' + path);
  }
  return { read, calls, keys };
}

test('priority evidence is a strict canonical subset, and legacy candidates keep gap and date ranking', () => {
  assert.deepEqual(normalizePrioritySources(undefined), []);
  assert.deepEqual(normalizePrioritySources(['sessha', 'sikkokusimeji']), ['sikkokusimeji', 'sessha']);
  for (const value of [null, 'sessha', ['unknown'], ['sessha', 'sessha'], [undefined]])
    assert.throws(() => normalizePrioritySources(value), TypeError);
  const older = { gap: 20, publishedAt: '2026-10-20T00:00:00Z' };
  const newer = { gap: 20, publishedAt: '2026-10-31T00:00:00Z' };
  assert.deepEqual([older, newer].sort(rankCandidates), [newer, older]);
});

test('preferred sources are searched without an owner follow and overlaps precede larger gaps before the target cap', async () => {
  const f = priorityFixture({ priorityGraphs: {
    sikkokusimeji: [['single_high', 'shared']], rosanna_lips: [['shared']],
  }, fallbackGraphs: { fallback_seed: [['fallback_person']] }, profiles: { single_high: { followingCount: 1000 } } });
  const report = await collectCandidates({ ...f, now: () => NOW, wait, targetCount: 1 });
  assert.equal(report.candidates[0].user, 'shared');
  assert.deepEqual(report.candidates[0].prioritySources, ['sikkokusimeji', 'rosanna_lips']);
  assert.equal(f.calls.includes('/api/v2/creators/sikkokusimeji'), true);
  assert.equal(f.calls.includes('/api/v2/creators/single_high/contents?kind=note&disabled_pinned=true&page=1'), false);
  assert.ok(f.calls.indexOf('/api/v3/users/' + f.keys.get('rosanna_lips') + '/followers?page=1&per=20') <
    f.calls.findIndex(path => path.includes('/followings?')));
});

test('repeated followers on one preferred source only count once and fallback fills the remaining batch', async () => {
  const f = priorityFixture({ priorityGraphs: {
    sikkokusimeji: [['repeated', 'repeated'], ['repeated', 'shared']],
    akari_seaart: [['shared']],
  }, fallbackGraphs: { fallback_seed: [['fallback_person']] }, profiles: { fallback_person: { followingCount: 1000 } } });
  const report = await collectCandidates({ ...f, now: () => NOW, wait, targetCount: 3 });
  assert.deepEqual(report.candidates.map(row => row.user), ['shared', 'repeated', 'fallback_person']);
  assert.deepEqual(report.candidates.map(row => row.prioritySources), [
    ['sikkokusimeji', 'akari_seaart'], ['sikkokusimeji'], [],
  ]);
  assert.equal(report.complete, true);
  assert.equal(report.summary.scanned, 3);
  assert.equal(f.calls.filter(path => path === '/api/v2/creators/repeated').length, 1);
});

test('all three priority pages are sampled before fallback can fill the bounded pool', async () => {
  const names = offset => Array.from({ length: 20 }, (_, index) => 'writer' + (offset + index));
  const priorityGraphs = Object.fromEntries(PRIORITY_SEEDS.map((source, index) => [source,
    [names(index * 60), names(index * 60 + 20), names(index * 60 + 40)]]));
  priorityGraphs.akari_seaart[2][0] = 'late_priority';
  const fallbackGraphs = Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['fallback_seed' + i, [names(1000 + i * 20)]]));
  const f = priorityFixture({ priorityGraphs, fallbackGraphs });
  const report = await collectCandidates({ ...f, now: () => NOW, wait });
  assert.equal(report.pooledUsers, 450);
  const lastPriority = f.calls.indexOf('/api/v3/users/' + f.keys.get('akari_seaart') + '/followers?page=3&per=20');
  const firstFallback = f.calls.indexOf('/api/v3/users/' + f.keys.get('fallback_seed0') + '/followers?page=1&per=20');
  assert.ok(lastPriority >= 0 && firstFallback > lastPriority);
  assert.equal(report.scannedSeedCount, 16);
});

test('unavailable preferred profiles are counted once and do not block fallback or loosen eligibility', async () => {
  const f = priorityFixture({ missingSources: PRIORITY_SEEDS.slice(1), priorityGraphs: { sikkokusimeji: [['already_following', 'liked_person']] },
    fallbackGraphs: { fallback_seed: [['fallback_person']] }, profiles: { already_following: { isFollowing: true } } });
  const report = await collectCandidates({ now: () => NOW, wait, targetCount: 2, read: async path => {
    if (path === '/api/v2/creators/liked_person/contents?kind=note&disabled_pinned=true&page=1') return contents(article(1, { isLiked: true }));
    return f.read(path);
  } });
  assert.deepEqual(report.candidates.map(row => row.user), ['fallback_person']);
  assert.equal(report.reason, 'source_exhausted');
  assert.equal(report.summary.errors, 5);
  assert.equal(report.summary.existing_relationship_or_unknown, 1);
  assert.equal(report.summary.already_liked, 1);
  assert.equal(report.rateLimited, false);
});

test('preferred discovery obeys request and seed budgets and pauses immediately on denied access', async () => {
  const f = priorityFixture();
  const limited = await collectCandidates({ ...f, now: () => NOW, wait, maxRequests: 4 });
  assert.equal(limited.reason, 'request_limit');
  assert.equal(limited.requests, 4);
  assert.equal(f.calls.length, 4);

  const bounded = priorityFixture({ fallbackGraphs: { fallback_seed: [['fallback_person']] } });
  const small = await collectCandidates({ ...bounded, now: () => NOW, wait, maxSeeds: 2 });
  assert.equal(small.scannedSeedCount, 2);
  assert.equal(bounded.calls.some(path => path.includes('/followings?')), false);
  assert.equal(bounded.calls.includes('/api/v2/creators/hono9556'), false);

  for (const status of [401, 403, 429]) {
    const calls = [];
    const report = await collectCandidates({ now: () => NOW, wait, read: async path => {
      calls.push(path);
      if (path === '/api/v1/current_user') return { data: { urlname: 'nero_notelover', key: OWNER_KEY } };
      throw Object.assign(new Error('PRIVATE_ERROR'), { status });
    } });
    assert.equal(report.reason, 'note_access_paused');
    assert.equal(report.rateLimited, true);
    assert.equal(report.summary.errors, 1);
    assert.deepEqual(calls, ['/api/v1/current_user', '/api/v2/creators/sikkokusimeji']);
  }
});

test('follow ratio requires both exactly 15 percent and a ten-person difference', () => {
  assert.equal(qualifiesByFollowRatio(115, 100), true);
  assert.equal(qualifiesByFollowRatio(114, 100), false);
  assert.equal(qualifiesByFollowRatio(30, 20), true);
  assert.equal(qualifiesByFollowRatio(23, 20), false);
  assert.equal(qualifiesByFollowRatio('115', '100'), true);
  for (const invalid of [null, undefined, '', true, false, NaN, -1, 1.5, {}, []])
    assert.equal(qualifiesByFollowRatio(115, invalid), false);
});

test('chooses only newest recent article and exports only public fixed fields', () => {
  const got = evaluateProfile(profile('writer', { cookie: 'PRIVATE_SECRET' }), contents(
    article(1, { publishAt: '2026-10-20T00:00:00Z' }), article(2),
    article(3, { publishAt: '2026-09-01T00:00:00Z', isLiked: true })), NOW);
  assert.equal(got.reason, 'eligible');
  assert.equal(got.candidate.articleUrl, 'https://note.com/writer/n/n000000000002');
  assert.equal(got.candidate.status, 'review_only');
  assert.equal(JSON.stringify(got).includes('PRIVATE_SECRET'), false);
});

test('one existing like excludes the whole person, and unknown is not unliked', () => {
  assert.equal(evaluateProfile(profile(), contents(article(1), article(2, { isLiked: true })), NOW).reason, 'already_liked');
  assert.equal(evaluateProfile(profile(), contents(article(1), article(2, { isLiked: undefined })), NOW).reason, 'unknown_like_state');
});

test('relationship, missing counts, owner, and article activity must be verified', () => {
  for (const field of ['isFollowing', 'isFollowed']) {
    assert.equal(evaluateProfile(profile('writer', { [field]: true }), contents(article()), NOW).reason, 'existing_relationship_or_unknown');
    assert.equal(evaluateProfile(profile('writer', { [field]: undefined }), contents(article()), NOW).reason, 'existing_relationship_or_unknown');
  }
  assert.equal(evaluateProfile(profile('nero_notelover'), contents(article()), NOW).reason, 'invalid_profile');
  assert.equal(evaluateProfile(profile('writer', { followingCount: null }), contents(article()), NOW).reason, 'insufficient_follow_gap');
  assert.equal(evaluateProfile(profile(), {}, NOW).reason, 'unknown_articles');
  assert.equal(evaluateProfile(profile(), contents(article(1, { publishAt: '2026-09-01T00:00:00Z' })), NOW).reason, 'inactive_30_days');
  assert.equal(evaluateProfile(profile(), contents(article(1, { publishAt: '2026-11-02T00:00:00Z' })), NOW).reason, 'inactive_30_days');
});

test('collects thirty distinct people across follower pages and ranks the resulting batch', async () => {
  const { read, calls } = fixture();
  const report = await collectLegacy({ read, now: () => NOW, wait });
  assert.equal(report.targetCount, 30);
  assert.equal(report.candidates.length, 30);
  assert.equal(report.complete, true);
  assert.equal(report.reason, 'target_reached');
  assert.equal(report.summary.scanned, 30);
  assert.equal(report.pooledUsers, 40);
  assert.equal(new Set(report.candidates.map(row => row.user)).size, 30);
  assert.equal(report.candidates[0].user, 'writer29');
  assert.equal(report.candidates[29].user, 'writer0');
  assert.ok(calls.some(path => path.includes('/followers?page=2&')));
  assert.equal(calls.filter(path => path === '/api/v2/creators/writer0').length, 1);
  assert.equal(JSON.stringify(report).includes('PRIVATE_PROFILE_FIELD'), false);
});

test('expanded search can pass ninety rejected profiles before finding thirty eligible people', async () => {
  const calls = [];
  const seedKey = i => (100 + i).toString(16).padStart(24, '0');
  const read = async path => {
    calls.push(path);
    if (path === '/api/v1/current_user') return { data: { urlname: 'nero_notelover', key: OWNER_KEY } };
    if (path.includes('/followings?')) return { data: { follows: Array.from({ length: 6 }, (_, i) => ({ urlname: 'seed' + i })), isLastPage: true } };
    const seed = path.match(/^\/api\/v2\/creators\/seed(\d+)$/);
    if (seed) return profile('seed' + seed[1], { key: seedKey(Number(seed[1])) });
    const graph = path.match(/^\/api\/v3\/users\/([a-f0-9]+)\/followers\?page=(\d+)&per=20$/);
    if (graph) {
      const i = parseInt(graph[1], 16) - 100, page = Number(graph[2]);
      return { data: { follows: Array.from({ length: 20 }, (_, j) => ({ urlname: 'writer' + ((page - 1) * 120 + i * 20 + j) })), isLastPage: page === 2 } };
    }
    const user = path.match(/^\/api\/v2\/creators\/writer(\d+)(\/contents\?.*)?$/);
    if (user) return user[2] ? contents(article(Number(user[1]) + 1)) : profile('writer' + user[1], { followingCount: Number(user[1]) < 100 ? 100 : 200 });
    throw new Error('Unexpected fixture path');
  };
  const report = await collectLegacy({ read, now: () => NOW, wait, maxFollowerPages: 2 });
  assert.equal(report.complete, true);
  assert.equal(report.candidates.length, 30);
  assert.equal(report.summary.scanned, 130);
  assert.equal(report.summary.insufficient_follow_gap, 100);
  assert.equal(report.scannedSeedCount, 6);
});

test('insufficient source is reported honestly without relaxing eligibility', async () => {
  const { read } = fixture();
  const report = await collectLegacy({ now: () => NOW, wait, read: async path => {
    if (path.includes('/followers?')) return { data: { follows: [{ urlname: 'writer1' }], isLastPage: true } };
    return read(path);
  } });
  assert.equal(report.candidates.length, 1);
  assert.equal(report.complete, false);
  assert.equal(report.reason, 'source_exhausted');
});

test('401, 403, and 429 stop all further reads and identify paused partial reports', async () => {
  for (const status of [401, 403, 429]) {
    const failedPath = '/api/v2/creators/writer1';
    const { read, calls } = fixture({ refusePath: failedPath, refuseStatus: status });
    const report = await collectLegacy({ read, now: () => NOW, wait });
    assert.equal(report.complete, false);
    assert.equal(report.reason, 'note_access_paused');
    assert.equal(report.rateLimited, true);
    assert.equal(report.candidates.length, 1);
    assert.equal(calls.at(-1), failedPath);
    assert.equal(calls.includes('/api/v2/creators/writer2'), false);
    assert.equal(JSON.stringify(report).includes('PRIVATE_HTTP_BODY'), false);
  }
});

test('request and elapsed-time budgets stop collection without extra reads', async () => {
  const f = fixture();
  const limited = await collectLegacy({ read: f.read, now: () => NOW, wait, maxRequests: 5 });
  assert.equal(limited.reason, 'request_limit');
  assert.equal(limited.requests, 5);
  assert.equal(f.calls.length, 5);
  let time = NOW;
  const t = fixture();
  const expired = await collectLegacy({ read: t.read, now: () => time,
    wait: async ms => { time += ms; }, maxDurationMs: 10 });
  assert.equal(expired.reason, 'time_limit');
  assert.equal(t.calls.length, 1);
});

test('a different session owner is rejected before follower or candidate discovery', async () => {
  const paths = [];
  await assert.rejects(collectCandidates({ read: async path => { paths.push(path); return { data: { urlname: 'someone_else', key: OWNER_KEY } }; },
    now: () => NOW, wait }), error => error.code === 'OWNER_REQUIRED');
  assert.deepEqual(paths, ['/api/v1/current_user']);
});

test('session parser accepts raw values and full cookie strings and rejects ambiguity', () => {
  assert.equal(sessionValue('private_value'), 'private_value');
  assert.equal(sessionValue('private_value\n'), 'private_value');
  assert.equal(sessionValue('Cookie: other=value; _note_session_v5=private_value; xsrf=another'), 'private_value');
  for (const invalid of ['', 'abc def', 'abc\r\ndef', '_note_session_v5=a; _note_session_v5=b'])
    assert.throws(() => sessionValue(invalid), error => error.code === 'SESSION_INVALID' && !error.message.includes('private_value'));
});

test('browser adapter makes only note GET requests, strips child credentials, and closes resources', async () => {
  const f = fixture();
  let closed = false, disposed = 0, requestCount = 0;
  const cookieValue = 'PRIVATE_SESSION_COOKIE';
  const report = await collect({ rawCookie: cookieValue, now: () => NOW, wait, prioritySeeds: [],
    launch: async settings => {
      assert.equal(Object.hasOwn(settings.env, 'NOTE_SESSION_COOKIE'), false);
      assert.equal(Object.hasOwn(settings.env, 'GITHUB_TOKEN'), false);
      return { close: async () => { closed = true; }, newContext: async () => ({
        addCookies: async cookies => { assert.equal(cookies[0].value, cookieValue); },
        request: { get: async (url, options) => {
          requestCount++;
          assert.equal(new URL(url).origin, 'https://note.com');
          assert.equal(options.maxRetries, 0);
          assert.equal(options.maxRedirects, 0);
          const payload = await f.read(new URL(url).pathname + new URL(url).search);
          return { status: () => 200, text: async () => JSON.stringify(payload), dispose: async () => { disposed++; } };
        } },
      }) };
    } });
  assert.equal(report.candidates.length, 30);
  assert.equal(closed, true);
  assert.equal(disposed, requestCount);
  assert.equal(JSON.stringify(report).includes(cookieValue), false);
});
