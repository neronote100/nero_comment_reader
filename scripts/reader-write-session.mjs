import { sessionValue } from './collect-like-candidates.mjs';

export class ReaderWriteSessionError extends Error {
  constructor(code = 'WRITE_SESSION_UNAVAILABLE') { super(code); this.code = code; }
}
const NOTE = 'https://note.com';
const secretNames = new Set(['NOTE_SESSION_COOKIE', 'GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL']);
function csrf(value) {
  if (typeof value !== 'string' || !value || value.length > 8192) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !/[\u0000-\u0020\u007f]/.test(decoded) ? encodeURIComponent(decoded) : null;
  } catch { return null; }
}
function uniqueCookie(cookies, name) {
  const values = [...new Set(cookies.filter(cookie => cookie.name === name &&
    ['note.com', '.note.com'].includes(cookie.domain) && cookie.path === '/' &&
    typeof cookie.value === 'string' && cookie.value && !/[\s;\u0000-\u001f\u007f]/.test(cookie.value)).map(cookie => cookie.value))];
  return values.length === 1 ? values[0] : null;
}

/** Read a real note browser session. No note mutation or credential file is used. */
export async function prepareReaderWriteSession({ rawCookie, chromePath, launch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), maxChecks = 20 } = {}) {
  if (!Number.isSafeInteger(maxChecks) || maxChecks < 1 || maxChecks > 20) throw new ReaderWriteSessionError();
  const value = sessionValue(rawCookie);
  if (!launch) { const { chromium } = await import('playwright-core'); launch = options => chromium.launch(options); }
  let browser;
  try {
    browser = await launch({ headless: true, executablePath: chromePath || '/usr/bin/google-chrome',
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !secretNames.has(key))) });
    const context = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    await context.addCookies([{ name: '_note_session_v5', value, domain: '.note.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    await context.route('**/*', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
    const page = await context.newPage();
    let headerToken = null;
    page.on('response', response => {
      try {
        if (new URL(response.url()).origin !== NOTE || response.status() < 200 || response.status() >= 300) return;
        Promise.resolve(response.allHeaders()).then(headers => { const token = csrf(headers['x-xsrf-token']); if (token) headerToken = token; }).catch(() => {});
      } catch { /* Only fixed note response headers can become credentials. */ }
    });
    await page.goto(NOTE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (new URL(page.url()).origin !== NOTE) throw new ReaderWriteSessionError();
    // The browser initializes note's ordinary CSRF cookie. Reads remain
    // allowed; the route above blocks every POST, PUT, PATCH and DELETE.
    for (let n = 0; n < maxChecks; n++) {
      const cookies = await context.cookies(NOTE);
      if (csrf(uniqueCookie(cookies, 'XSRF-TOKEN')) || headerToken) break;
      if (n + 1 < maxChecks) await wait(250);
    }
    const response = await context.request.get(NOTE + '/api/v1/current_user', {
      timeout: 15000, maxRetries: 0, maxRedirects: 0,
      headers: { Accept: 'application/json', Referer: NOTE + '/' },
    });
    try {
      if (response.status() !== 200) throw new ReaderWriteSessionError('WRITE_SESSION_OWNER_REQUIRED');
      const body = await response.text();
      if (body.length > 1000000) throw new ReaderWriteSessionError('WRITE_SESSION_OWNER_REQUIRED');
      const payload = JSON.parse(body), owner = payload?.data?.user ?? payload?.data ?? payload?.user ?? payload;
      if (owner?.urlname !== 'nero_notelover' || owner?.is_me === false || !/^[a-f0-9]{24,40}$/i.test(String(owner?.key ?? '')))
        throw new ReaderWriteSessionError('WRITE_SESSION_OWNER_REQUIRED');
      const headers = response.headers();
      headerToken = csrf(headers['x-xsrf-token']) || headerToken;
    } finally { await response.dispose().catch(() => {}); }
    const cookies = await context.cookies(NOTE), session = uniqueCookie(cookies, '_note_session_v5');
    const token = headerToken || csrf(uniqueCookie(cookies, 'XSRF-TOKEN'));
    if (!session || !token) throw new ReaderWriteSessionError();
    const cookie = '_note_session_v5=' + session + '; XSRF-TOKEN=' + token;
    if (cookie.length > 16384) throw new ReaderWriteSessionError();
    return cookie;
  } catch (error) {
    throw new ReaderWriteSessionError(error instanceof ReaderWriteSessionError ? error.code : 'WRITE_SESSION_UNAVAILABLE');
  } finally { await browser?.close().catch(() => {}); }
}
