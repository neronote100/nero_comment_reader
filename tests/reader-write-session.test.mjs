import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReaderWriteSession } from '../scripts/reader-write-session.mjs';

function fixture({ xsrf = 'VALID%2FTOKEN', owner = 'nero_notelover', header = null } = {}) {
  const events = [], cookies = [{ name: '_note_session_v5', value: 'PRIVATE_NOTE_COOKIE', domain: '.note.com', path: '/' }];
  if (xsrf) cookies.push({ name: 'XSRF-TOKEN', value: xsrf, domain: 'note.com', path: '/' });
  let route, launchOptions;
  const context = {
    addCookies: async values => { assert.equal(values[0].name, '_note_session_v5'); },
    route: async (_pattern, handler) => { route = handler; },
    cookies: async () => cookies,
    newPage: async () => ({ on() {}, goto: async url => events.push(['GET', url]), url: () => 'https://note.com/' }),
    request: { get: async (url, options) => {
      events.push(['GET', url]); assert.equal(options.maxRetries, 0); assert.equal(options.maxRedirects, 0);
      return { status: () => 200, text: async () => JSON.stringify({ data: { urlname: owner, key: 'a'.repeat(24) } }),
        headers: () => header ? { 'x-xsrf-token': header } : {}, dispose: async () => {} };
    } },
  };
  const launch = async options => { launchOptions = options; return { newContext: async () => context, close: async () => events.push(['CLOSE']) }; };
  return { launch, events, get route() { return route; }, get launchOptions() { return launchOptions; } };
}
test('a verified browser session supplies only the two required cookies without any note mutation', async () => {
  const f = fixture();
  const value = await prepareReaderWriteSession({ rawCookie: 'PRIVATE_NOTE_COOKIE', launch: f.launch, wait: async () => {} });
  assert.equal(value, '_note_session_v5=PRIVATE_NOTE_COOKIE; XSRF-TOKEN=VALID%2FTOKEN');
  assert.ok(f.events.every(([method]) => ['GET', 'CLOSE'].includes(method)));
  assert.deepEqual(f.events.at(-1), ['CLOSE']);
  for (const name of ['NOTE_SESSION_COOKIE', 'GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'])
    assert.equal(Object.hasOwn(f.launchOptions.env, name), false);
  let continued = 0, blocked = 0;
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) await f.route({ request: () => ({ method: () => method }), continue: async () => continued++, abort: async () => blocked++ });
  assert.equal(continued, 2); assert.equal(blocked, 3);
});
test('verified response headers can supply the write token when the browser cookie is absent', async () => {
  const f = fixture({ xsrf: null, header: 'HEADER%2BTOKEN' });
  assert.equal(await prepareReaderWriteSession({ rawCookie: 'PRIVATE', launch: f.launch, wait: async () => {}, maxChecks: 1 }),
    '_note_session_v5=PRIVATE_NOTE_COOKIE; XSRF-TOKEN=HEADER%2BTOKEN');
});
test('another owner or a missing or unsafe token cannot report a ready write session', async () => {
  for (const settings of [{ owner: 'someone_else' }, { xsrf: null }, { xsrf: 'PRIVATE%0ATOKEN' }]) {
    const f = fixture(settings);
    await assert.rejects(prepareReaderWriteSession({ rawCookie: 'PRIVATE', launch: f.launch, wait: async () => {}, maxChecks: 1 }), error =>
      ['WRITE_SESSION_OWNER_REQUIRED', 'WRITE_SESSION_UNAVAILABLE'].includes(error.code) && !error.message.includes('PRIVATE'));
    assert.deepEqual(f.events.at(-1), ['CLOSE']);
  }
});
