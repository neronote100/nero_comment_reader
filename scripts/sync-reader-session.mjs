import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { prepareReaderWriteSession, ReaderWriteSessionError } from './reader-write-session.mjs';

export const READER_SESSION_ENDPOINT = 'https://ouji-note-mcp.nero-prince.workers.dev/reader/session/import';
const OWNER = 'nero_notelover';
const MAX_JSON = 32_768;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const REUSABLE = /^neronote100\/nero_comment_reader\/\.github\/workflows\/like-candidates\.yml@([a-f0-9]{40})$/;
const IDENTITY_CHECK_KEYS = Object.freeze([
  'issuerMatch', 'audienceMatch', 'repositoryMatch', 'repositoryIdMatch', 'ownerIdMatch',
  'refMatch', 'subjectMatch', 'workflowRefMatch', 'reusableWorkflowRefMatch', 'jobWorkflowShaMatch',
  'eventAllowed', 'runIdValid', 'jwtIdValid', 'repositoryIdIsString', 'ownerIdIsString',
  'repositoryIdPresent', 'ownerIdPresent', 'subjectPresent', 'workflowRefPresent',
  'reusableWorkflowRefPresent', 'jobWorkflowShaPresent', 'runIdPresent', 'jwtIdPresent',
]);
const SERVER_CODES = new Set([
  'ACTIONS_IDENTITY_INVALID', 'ACTIONS_TOKEN_INVALID', 'ACTIONS_CONFIGURATION', 'ACTIONS_TOKEN_EXPIRED',
  'ACTIONS_KEYS_UNAVAILABLE', 'ACTIONS_KEY_UNKNOWN', 'ACTIONS_SIGNATURE_INVALID', 'ACTIONS_SERVER_ONLY',
  'SESSION_IMPORT_INVALID', 'SESSION_IMPORT_UNAVAILABLE', 'NOTE_SESSION_SYNC_REJECTED',
  'NOTE_SESSION_REQUIRED', 'NOTE_ACCESS_PAUSED', 'NOTE_READ_FAILED', 'NOTE_CSRF_REQUIRED', 'NOTE_SEND_REJECTED', 'IMPORT_REJECTED', 'STORAGE_FAILED',
]);

export function connectionDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output = {};
  if (typeof value.csrfReady === 'boolean') output.csrfReady = value.csrfReady;
  if (Number.isSafeInteger(value.activeOwnerSessions) && value.activeOwnerSessions >= 0 && value.activeOwnerSessions <= 128)
    output.activeOwnerSessions = value.activeOwnerSessions;
  if (value.recentAttempts && typeof value.recentAttempts === 'object' && !Array.isArray(value.recentAttempts)) {
    const counts = {};
    for (const key of ['inspected', 'liked', 'unknown', 'attempting', 'refused', 'notSent']) {
      const count = value.recentAttempts[key];
      if (Number.isSafeInteger(count) && count >= 0 && count <= 20) counts[key] = count;
    }
    if (Object.keys(counts).length) output.recentAttempts = counts;
  }
  if (value.lastHttpStatus === null || Number.isInteger(value.lastHttpStatus) && value.lastHttpStatus >= 100 && value.lastHttpStatus <= 599)
    output.lastHttpStatus = value.lastHttpStatus;
  if (value.lastFailureCode === null || SERVER_CODES.has(value.lastFailureCode)) output.lastFailureCode = value.lastFailureCode;
  return Object.keys(output).length ? output : undefined;
}

export class ReaderSessionSyncError extends Error {
  constructor(code, status, diagnostic, identityChecks) {
    super(code);
    this.name = 'ReaderSessionSyncError';
    this.code = code;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
    if (SERVER_CODES.has(diagnostic?.code)) this.reason = diagnostic.code;
    if (Number.isInteger(diagnostic?.noteStatus) && diagnostic.noteStatus >= 100 && diagnostic.noteStatus <= 599) this.noteStatus = diagnostic.noteStatus;
    if (this.reason === 'ACTIONS_IDENTITY_INVALID' && identityChecks && typeof identityChecks === 'object') {
      this.identityChecks = Object.fromEntries(IDENTITY_CHECK_KEYS.filter(key => typeof identityChecks[key] === 'boolean')
        .map(key => [key, identityChecks[key]]));
    }
  }
}

/** Diagnostic comparisons only. The token and claim values never leave this function. */
export function actionsIdentityChecks(jwt) {
  try {
    if (typeof jwt !== 'string' || jwt.length > 16_384 || !TOKEN.test(jwt)) return null;
    const payload = jwt.split('.')[1];
    if (payload.length > 12_000) return null;
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.toString('base64url') !== payload) return null;
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
    const reusable = typeof claims.job_workflow_ref === 'string' && claims.job_workflow_ref.match(REUSABLE);
    const present = key => Object.hasOwn(claims, key);
    return {
      issuerMatch: claims.iss === 'https://token.actions.githubusercontent.com',
      audienceMatch: claims.aud === READER_SESSION_ENDPOINT,
      repositoryMatch: claims.repository === 'neronote100/Prince_like_giver',
      repositoryIdMatch: claims.repository_id === '1438673284',
      ownerIdMatch: claims.repository_owner_id === '330726672',
      refMatch: claims.ref === 'refs/heads/main',
      subjectMatch: claims.sub === 'repo:neronote100/Prince_like_giver:ref:refs/heads/main',
      workflowRefMatch: claims.workflow_ref === 'neronote100/Prince_like_giver/.github/workflows/candidates.yml@refs/heads/main',
      reusableWorkflowRefMatch: Boolean(reusable),
      jobWorkflowShaMatch: claims.job_workflow_sha === undefined || Boolean(reusable && claims.job_workflow_sha === reusable[1]),
      eventAllowed: ['push', 'schedule', 'workflow_dispatch'].includes(claims.event_name),
      runIdValid: typeof claims.run_id === 'string' && /^[1-9]\d{0,31}$/.test(claims.run_id),
      jwtIdValid: typeof claims.jti === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(claims.jti),
      repositoryIdIsString: typeof claims.repository_id === 'string',
      ownerIdIsString: typeof claims.repository_owner_id === 'string',
      repositoryIdPresent: present('repository_id'), ownerIdPresent: present('repository_owner_id'),
      subjectPresent: present('sub'), workflowRefPresent: present('workflow_ref'),
      reusableWorkflowRefPresent: present('job_workflow_ref'), jobWorkflowShaPresent: present('job_workflow_sha'),
      runIdPresent: present('run_id'), jwtIdPresent: present('jti'),
    };
  } catch { return null; }
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
  if (response.status < 200 || response.status >= 300) throw new ReaderSessionSyncError('SESSION_SYNC_FAILED', response.status, result,
    result?.code === 'ACTIONS_IDENTITY_INVALID' ? actionsIdentityChecks(identity.value) : undefined);
  if (result?.ok !== true || result.account !== OWNER || result.noteReady !== true)
    throw new ReaderSessionSyncError('SESSION_SYNC_RESPONSE_INVALID');
  const diagnostics = connectionDiagnostics(result.diagnostics);
  return { ok: true, account: OWNER, noteReady: true, ...(diagnostics ? { diagnostics } : {}) };
}

async function summary(message) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try { await appendFile(process.env.GITHUB_STEP_SUMMARY, message + '\n'); } catch { /* A missing summary does not expose an error or credential. */ }
}

async function main() {
  try {
    let cookie = process.env.NOTE_SESSION_COOKIE;
    if (process.env.READER_PREPARE_BROWSER_SESSION === 'true') {
      try { cookie = await prepareReaderWriteSession({ rawCookie: cookie, chromePath: process.env.CHROME_BIN }); }
      catch (error) {
        if (!(error instanceof ReaderWriteSessionError) || error.code === 'WRITE_SESSION_OWNER_REQUIRED') throw error;
        console.log('READER_OPTIONAL_CSRF_UNAVAILABLE');
      }
    }
    const result = await syncReaderSession({ cookie,
      requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL, requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN });
    console.log('READER_SESSION_SYNC_READY ' + JSON.stringify(result));
    await summary('Comment Readerのnote接続を更新しました。本人アカウント確認済み。');
  } catch (error) {
    const safe = error instanceof ReaderSessionSyncError || error instanceof ReaderWriteSessionError;
    console.error('READER_SESSION_SYNC_FAILED ' + JSON.stringify({ code: safe ? error.code : 'SESSION_SYNC_FAILED',
      ...(safe && error.status ? { status: error.status } : {}),
      ...(safe && error.reason ? { reason: error.reason } : {}),
      ...(safe && error.noteStatus ? { noteStatus: error.noteStatus } : {}),
      ...(safe && error.identityChecks ? { identityChecks: error.identityChecks } : {}) }));
    await summary('Comment Readerのnote接続更新は確認待ちです。通常の候補収集は継続します。');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
