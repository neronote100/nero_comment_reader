import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const READER_SESSION_ENDPOINT = 'https://ouji-note-mcp.nero-prince.workers.dev/reader/session/import';
const OWNER = 'nero_notelover';
const MAX_JSON = 32_768;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SERVER_CODES = new Set([
  'ACTIONS_IDENTITY_INVALID', 'ACTIONS_TOKEN_INVALID', 'ACTIONS_CONFIGURATION', 'ACTIONS_TOKEN_EXPIRED',
  'ACTIONS_KEYS_UNAVAILABLE', 'ACTIONS_KEY_UNKNOWN', 'ACTIONS_SIGNATURE_INVALID', 'ACTIONS_SERVER_ONLY',
  'SESSION_IMPORT_INVALID', 'SESSION_IMPORT_UNAVAILABLE', 'NOTE_SESSION_SYNC_REJECTED',
  'NOTE_SESSION_REQUIRED', 'NOTE_ACCESS_PAUSED', 'NOTE_READ_FAILED', 'IMPORT_REJECTED', 'STORAGE_FAILED',
]);

export class ReaderSessionSyncError extends Error {
  constructor(code, status, diagnostic) {
    super(code);
    this.name = 'ReaderSessionSyncError';
    this.code = code;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
    if (SERVER_CODES.has(diagnostic?.code)) this.reason = diagnostic.code;
    if (Number.isInteger(diagnostic?.noteStatus) && diagnostic.noteStatus >= 100 && diagnostic.noteStatus <= 599) this.noteStatus = diagnostic.noteStatus;
  }
}

async function readJson(response, code, allowErrorStatus = false) {
  if (!response || (!allowErrorStatus && (response.status < 200 || response.status >= 300)) || !response.body)
    throw new ReaderSessionSyncError(code, response?.status);
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_JSON) throw new ReaderSessionSyncError(code);
      chunks.push(next.value);
    }
    const result = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result));
  } catch {
    await reader.cancel().catch(() => {});
    throw new ReaderSessionSyncError(code);
  }
}

function configuration(cookie, requestUrl, requestToken) {
  if (typeof cookie !== 'string' || !cookie.trim() || cookie.length > 16_384 || /[\r\n\u0000]/.test(cookie.trim()) ||
      typeof requestToken !== 'string' || !requestToken || requestToken.length > 16_384 || /[\s\u0000-\u001f\u007f]/.test(requestToken) ||
      typeof requestUrl !== 'string' || requestUrl.length > 8192 || /[\u0000-\u0020\u007f]/.test(requestUrl))
    throw new ReaderSessionSyncError('SYNC_CONFIGURATION_INVALID');
  let url;
  try { url = new URL(requestUrl); } catch { throw new ReaderSessionSyncError('SYNC_CONFIGURATION_INVALID'); }
  // This URL is supplied by the Actions runner, never by the webpage or workflow inputs.
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.port)
    throw new ReaderSessionSyncError('SYNC_CONFIGURATION_INVALID');
  url.searchParams.set('audience', READER_SESSION_ENDPOINT);
  return { cookie: cookie.trim(), url: url.href };
}

/** Exchange the runner's short-lived identity for one fixed session-import call. */
export async function syncReaderSession({ cookie, requestUrl, requestToken, fetcher = globalThis.fetch } = {}) {
  if (typeof fetcher !== 'function') throw new ReaderSessionSyncError('SYNC_CONFIGURATION_INVALID');
  const configured = configuration(cookie, requestUrl, requestToken);
  let response;
  try {
    response = await fetcher(configured.url, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: 'Bearer ' + requestToken, Accept: 'application/json' },
    });
  } catch { throw new ReaderSessionSyncError('OIDC_REQUEST_FAILED'); }
  const identity = await readJson(response, 'OIDC_REQUEST_FAILED');
  if (typeof identity?.value !== 'string' || identity.value.length > 16_384 || !TOKEN.test(identity.value))
    throw new ReaderSessionSyncError('OIDC_RESPONSE_INVALID');
  try {
    response = await fetcher(READER_SESSION_ENDPOINT, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: 'Bearer ' + identity.value, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: configured.cookie }),
    });
  } catch { throw new ReaderSessionSyncError('SESSION_SYNC_FAILED'); }
  const result = await readJson(response, 'SESSION_SYNC_FAILED', true);
  if (response.status < 200 || response.status >= 300) throw new ReaderSessionSyncError('SESSION_SYNC_FAILED', response.status, result);
  if (result?.ok !== true || result.account !== OWNER || result.noteReady !== true)
    throw new ReaderSessionSyncError('SESSION_SYNC_RESPONSE_INVALID');
  return { ok: true, account: OWNER, noteReady: true };
}

async function summary(message) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try { await appendFile(process.env.GITHUB_STEP_SUMMARY, message + '\n'); } catch { /* A missing summary does not expose an error or credential. */ }
}

async function main() {
  try {
    const result = await syncReaderSession({ cookie: process.env.NOTE_SESSION_COOKIE,
      requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL, requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN });
    console.log('READER_SESSION_SYNC_READY ' + JSON.stringify(result));
    await summary('Comment Readerのnote接続を更新しました。本人アカウント確認済み。');
  } catch (error) {
    const safe = error instanceof ReaderSessionSyncError;
    console.error('READER_SESSION_SYNC_FAILED ' + JSON.stringify({ code: safe ? error.code : 'SESSION_SYNC_FAILED',
      ...(safe && error.status ? { status: error.status } : {}),
      ...(safe && error.reason ? { reason: error.reason } : {}),
      ...(safe && error.noteStatus ? { noteStatus: error.noteStatus } : {}) }));
    await summary('Comment Readerのnote接続更新は確認待ちです。通常の候補収集は継続します。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
