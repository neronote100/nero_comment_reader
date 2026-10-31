import test from 'node:test';
import assert from 'node:assert/strict';
import { syncReaderSession, ReaderSessionSyncError, READER_SESSION_ENDPOINT } from '../scripts/sync-reader-session.mjs';
import { collect } from '../scripts/collect-like-candidates.mjs';

const COOKIE = '_note_session_v5=PRIVATE_NOTE_COOKIE';
const REQUEST_TOKEN = 'PRIVATE_ACTIONS_REQUEST_TOKEN';
const IDENTITY = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.private_signature';
const REQUEST_URL = 'https://runner.actions.githubusercontent.com/_apis/oidctoken?api-version=2.0&audience=old';
const SETTINGS = { cookie: COOKIE, requestUrl: REQUEST_URL, requestToken: REQUEST_TOKEN };

function fixture({ identity = IDENTITY, final = { ok: true, account: 'nero_notelover', noteReady: true }, finalStatus = 200 } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? Response.json({ value: identity }) : Response.json(final, { status: finalStatus });
  };
  return { fetcher, calls };
}

test('sync exchanges the runner identity for one fixed Cookie import and returns public status only', async () => {
  const f = fixture();
  const result = await syncReaderSession({ ...SETTINGS, fetcher: f.fetcher });
  assert.deepEqual(result, { ok: true, account: 'nero_notelover', noteReady: true });
  assert.equal(f.calls.length, 2);
  const first = new URL(f.calls[0].url);
  assert.equal(first.origin, 'https://runner.actions.githubusercontent.com');
  assert.equal(first.pathname, '/_apis/oidctoken');
  assert.equal(first.searchParams.get('api-version'), '2.0');
  assert.deepEqual(first.searchParams.getAll('audience'), [READER_SESSION_ENDPOINT]);
  assert.equal(f.calls[0].options.method, 'GET');
  assert.equal(f.calls[0].options.headers.Authorization, 'Bearer ' + REQUEST_TOKEN);
  assert.equal(f.calls[0].options.body, undefined);
  assert.equal(f.calls[1].url, READER_SESSION_ENDPOINT);
  assert.equal(f.calls[1].options.method, 'POST');
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer ' + IDENTITY);
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { cookie: COOKIE });
  assert.ok(f.calls.every(call => call.options.redirect === 'manual' && call.options.signal instanceof AbortSignal));
  const publicResult = JSON.stringify(result);
  for (const secret of [COOKIE, REQUEST_TOKEN, IDENTITY]) assert.ok(!publicResult.includes(secret));
});

test('outer Cookie whitespace is accepted but embedded control characters and unsafe runner URLs stop before requests', async () => {
  const f = fixture();
  await syncReaderSession({ ...SETTINGS, cookie: '\n' + COOKIE + '\n', fetcher: f.fetcher });
  assert.equal(JSON.parse(f.calls[1].options.body).cookie, COOKIE);
  for (const change of [{ cookie: '' }, { cookie: 'private\r\nsecret' }, { requestToken: 'bad token' },
    { requestUrl: 'http://runner.example/token' }, { requestUrl: 'https://user:secret@runner.example/token' },
    { requestUrl: 'https://runner.example/token#secret' }, { requestUrl: 'https://runner.example:8443/token' },
    { requestUrl: ' https://runner.example/token' }]) {
    let requests = 0;
    await assert.rejects(syncReaderSession({ ...SETTINGS, ...change, fetcher: async () => { requests++; } }),
      error => error instanceof ReaderSessionSyncError && error.code === 'SYNC_CONFIGURATION_INVALID');
    assert.equal(requests, 0);
  }
});

test('OIDC redirects, failures, oversize responses and invalid identities never send the Cookie', async () => {
  for (const response of [new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }),
    Response.json({ error: COOKIE }, { status: 403 }), new Response('PRIVATE_INVALID_JSON'),
    Response.json({ value: 'not-a-jwt' }), Response.json({ value: IDENTITY + 'x'.repeat(33_000) })]) {
    const calls = [];
    await assert.rejects(syncReaderSession({ ...SETTINGS, fetcher: async (...args) => { calls.push(args); return response; } }), error => {
      assert.ok(['OIDC_REQUEST_FAILED', 'OIDC_RESPONSE_INVALID'].includes(error.code));
      assert.ok(!error.message.includes(COOKIE));
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].body, undefined);
  }
});

test('HTTP import refusal, redirects and network exceptions use fixed diagnostics and are never retried', async () => {
  for (const finalStatus of [302, 401, 403, 429, 503]) {
    const f = fixture({ finalStatus, final: { error: COOKIE + REQUEST_TOKEN + IDENTITY } });
    await assert.rejects(syncReaderSession({ ...SETTINGS, fetcher: f.fetcher }), error =>
      error.code === 'SESSION_SYNC_FAILED' && error.status === finalStatus && !error.message.includes('PRIVATE'));
    assert.equal(f.calls.length, 2);
  }
  let calls = 0;
  await assert.rejects(syncReaderSession({ ...SETTINGS, fetcher: async () => {
    if (++calls === 1) return Response.json({ value: IDENTITY });
    throw Error(COOKIE + REQUEST_TOKEN);
  } }), error => error.code === 'SESSION_SYNC_FAILED' && !error.message.includes('PRIVATE'));
  assert.equal(calls, 2);
});

test('a success status without confirmed owner and ready connection is not reported as synced', async () => {
  for (const final of [{ ok: false }, { ok: true, account: 'someone_else', noteReady: true },
    { ok: true, account: 'nero_notelover', noteReady: false }]) {
    const f = fixture({ final });
    await assert.rejects(syncReaderSession({ ...SETTINGS, fetcher: f.fetcher }), { code: 'SESSION_SYNC_RESPONSE_INVALID' });
    assert.equal(f.calls.length, 2);
  }
});

test('only reviewed fixed import diagnostics may reach the runner error', async () => {
  const known = fixture({ finalStatus: 502, final: { ok: false, code: 'NOTE_ACCESS_PAUSED', noteStatus: 403, error: COOKIE } });
  await assert.rejects(syncReaderSession({ ...SETTINGS, fetcher: known.fetcher }), error => {
    assert.equal(error.reason, 'NOTE_ACCESS_PAUSED'); assert.equal(error.noteStatus, 403);
    assert.ok(!JSON.stringify(error).includes(COOKIE)); return true;
  });
  const unknown = fixture({ finalStatus: 403, final: { code: 'PRIVATE_NOTE_COOKIE', error: REQUEST_TOKEN, noteStatus: IDENTITY } });
  await assert.rejects(syncReaderSession({ ...SETTINGS, fetcher: unknown.fetcher }), error => {
    assert.equal(error.reason, undefined); assert.equal(error.noteStatus, undefined);
    assert.ok(!JSON.stringify(error).includes('PRIVATE')); return true;
  });
});

test('Chrome cannot inherit the runner identity request credentials', async () => {
  const names = ['NOTE_SESSION_COOKIE', 'GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'PRIVATE_ENV_VALUE';
    await assert.rejects(collect({ rawCookie: 'private_session_value', launch: async options => {
      for (const name of names) assert.equal(Object.hasOwn(options.env, name), false);
      throw Error('PROBE_STOP');
    } }), /PROBE_STOP/);
  } finally {
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
});

