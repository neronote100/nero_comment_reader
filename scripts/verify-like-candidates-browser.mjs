import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(new URL('../', import.meta.url).pathname);
const now = Date.now(), service = 'https://ouji-note-mcp.nero-prince.workers.dev';
const bearer = 'T'.repeat(43), code = 'C'.repeat(43);
const feed = {
  version: 1, owner: 'nero_notelover', generatedAt: new Date(now).toISOString(),
  targetCount: 30, complete: true, reason: 'target_reached', rateLimited: false,
  summary: { scanned: 180 },
  candidates: Array.from({ length: 30 }, (_, i) => ({
    user: 'writer' + i, name: i === 0 ? '書き手 <script>確認用</script>' : '書き手 ' + (i + 1),
    profileUrl: 'https://note.com/writer' + i, following: 150, followers: 100, gap: 50,
    articleTitle: '日々の小さな気づきを、言葉にしてみました ' + (i + 1),
    publishedAt: new Date(now - 86400000).toISOString(),
    articleUrl: 'https://note.com/writer' + i + '/n/n' + (i + 1).toString(16).padStart(12, '0'),
    liked: false, status: 'review_only',
  })),
};
// Serve the exact source through interception: no listening socket or external
// network is needed, while HTTPS origins still exercise browser CORS and PKCE.
const origin = 'https://reader-fixture.invalid';
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP' });
  let offline = false, fallback = false, starts = 0, nexts = 0;
  const writes = [], forbidden = [], states = {};
  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const fulfill = value => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin === service) {
      if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
      if (url.pathname === '/reader/connect') {
        const nonce = url.searchParams.get('nonce');
        assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
        assert.match(url.searchParams.get('challenge'), /^[A-Za-z0-9_-]{43}$/);
        const callback = origin + '/#reader-code=' + code + '&reader-nonce=' + nonce;
        const script = fallback
          ? 'window.opener=null;location.replace(' + JSON.stringify(callback) + ');'
          : 'window.opener.postMessage(' + JSON.stringify({ type: 'ouji-reader-connected', code, nonce }) + ',' + JSON.stringify(origin) + ');';
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><script>' + script + '</script>' });
        return;
      }
      if (url.pathname !== '/reader/exchange') assert.equal(request.headers().authorization, 'Bearer ' + bearer);
      if (request.method() === 'POST') writes.push({ path: url.pathname, body: request.postDataJSON() });
      if (url.pathname === '/reader/exchange') {
        assert.equal(request.headers().authorization, undefined);
        assert.equal(request.postDataJSON().code, code);
        assert.match(request.postDataJSON().verifier, /^[A-Za-z0-9_-]{43}$/);
        await fulfill({ ok: true, token: bearer, owner: 'nero_notelover', expiresAt: now + 3600000 });
      } else if (url.pathname === '/reader/status') await fulfill({ ok: true, connected: true, noteReady: true, expiresAt: now + 3600000 });
      else if (url.pathname === '/reader/candidates') await fulfill({ ok: true, ...feed, states });
      else if (url.pathname === '/reader/candidates/start') {
        starts++;
        await fulfill({ ok: true, scanId: 'scan-1', done: false, phase: 'profiles', scanned: 12, candidateCount: 2, requests: 24 });
      } else if (url.pathname === '/reader/candidates/next') {
        nexts++;assert.equal(request.postDataJSON().scanId, 'scan-1');
        await fulfill({ ok: true, scanId: 'scan-1', done: true, phase: 'done', scanned: 180, candidateCount: 30, requests: 246, report: feed });
      } else if (url.pathname === '/reader/like') {
        const key = request.postDataJSON().key;
        if (key === feed.candidates[1].articleUrl.split('/').at(-1)) {
          states[key] = 'unknown';
          await route.fulfill({ status: 202, headers: cors, contentType: 'application/json', body: JSON.stringify({ ok: true, key, liked: false, confirmationPending: true, outcomeUnknown: true }) });
        } else {
          states[key] = 'liked';
          await fulfill({ ok: true, key, liked: true });
        }
      } else if (url.pathname === '/reader/like-status') {
        const key = url.searchParams.get('key');states[key] = 'liked';await fulfill({ ok: true, key, liked: true });
      } else if (url.pathname === '/reader/logout') await fulfill({ ok: true });
      else await route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{"ok":false}' });
      return;
    }
    if (request.method() !== 'GET') { forbidden.push(request.method() + ' ' + url.origin); await route.abort(); return; }
    if (url.pathname.endsWith('/like-candidates.json')) {
      if (offline) await route.abort();
      else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feed) });
    } else if (url.origin === origin) {
      const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(root + sep)) { await route.fulfill({ status: 403, body: '' }); return; }
      try {
        await route.fulfill({ status: 200, contentType: ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] || 'application/json', body: await readFile(file) });
      } catch { await route.fulfill({ status: 404, body: '' }); }
    }
    else if (url.hostname === 'nero-comment-reader.nero-prince.workers.dev') await route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, snapshot: { version: 5, items: [], updatedAt: new Date(now).toISOString() } }),
    });
    else await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Mock article</p>' });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  context.on('page', popup => popup.on('pageerror', error => errors.push(error.message)));
  const awaitConnection = async target => {
    try {
      await target.waitForFunction(() => document.querySelector('.candidateConnectionStatus')?.textContent.includes('王子のnoteに接続済み'));
    } catch (error) {
      // This harness contains fixture codes only. Log UI state and route names,
      // never authorization headers, payloads or URLs containing auth codes.
      console.error('READER_BROWSER_CONNECTION_FAILED ' + JSON.stringify({
        status: await target.locator('.candidateConnectionStatus').textContent().catch(() => 'unavailable'),
        errors, requests: writes.map(write => write.path),
        pages: context.pages().map(openPage => {
          try { const url = new URL(openPage.url()); return url.origin + url.pathname; } catch { return 'unavailable'; }
        }),
      }));
      throw error;
    }
  };
  await page.goto(origin + '/#like-candidates');
  await page.waitForFunction(() => document.querySelectorAll('.candidateCard').length === 30);
  assert.equal(await page.locator('.candidateCount').innerText(), '30人');
  assert.equal(await page.locator('.candidatePerson script').count(), 0);
  assert.ok((await page.locator('.candidatePerson').first().innerText()).includes('<script>'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile layout must fit the screen');
  const article = page.locator('.candidateActions a').first();
  assert.equal(await article.getAttribute('href'), feed.candidates[0].articleUrl);
  assert.match(await article.getAttribute('rel'), /noopener/);
  assert.equal(writes.length, 0, 'opening the list must not send or collect anything');
  await page.locator('.candidateSend').first().click();
  assert.equal(writes.length, 0, 'a like before authentication must not issue a POST');
  await page.locator('.candidateSearch').click();
  assert.equal(starts, 0, 'search before authentication must not start note reads');
  await page.locator('.candidateMark input').first().check();
  assert.match(await page.locator('.candidateMeta').innerText(), /未確認 29人/);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.candidateCard').length === 30);
  assert.equal(await page.locator('.candidateMark input').first().isChecked(), true);
  await page.locator('.candidateFilter input').check();
  assert.equal(await page.locator('.candidateCard').count(), 29);
  await page.locator('.candidateFilter input').uncheck();
  offline = true;
  await page.getByRole('button', { name: '↻ 最新候補を表示', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.candidateStatus')?.textContent.includes('前回の候補'));
  assert.equal(await page.locator('.candidateCard').count(), 30, 'failed refresh must preserve existing candidates');
  offline = false;

  await page.locator('.candidateConnect').click();
  await awaitConnection(page);
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 0, 'connecting must not send a previously clicked like');
  await page.locator('.candidateSearch').click();
  await page.waitForFunction(() => document.querySelector('.candidateProgress')?.hidden === true);
  assert.equal(starts, 1);assert.equal(nexts, 1, 'new extraction must complete inside the page');
  await page.locator('.candidateSend').first().click();
  await page.waitForFunction(() => document.querySelector('.candidateSend')?.textContent.includes('スキ送信済み'));
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 1);
  assert.equal(writes.find(w => w.path === '/reader/like').body.key, feed.candidates[0].articleUrl.split('/').at(-1));
  assert.equal(await page.locator('.candidateSend').first().isDisabled(), true);
  await page.locator('.candidateSend').nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll('.candidateCheckDelivery').length === 1);
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 2);
  assert.equal(await page.locator('.candidateSend').nth(1).isDisabled(), true);
  await page.locator('.candidateCheckDelivery').click();
  await page.waitForFunction(() => document.querySelectorAll('.candidateCheckDelivery').length === 0);
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 2, 'checking an uncertain result must never resend a like');
  await page.locator('[data-view="comments"]').click();
  assert.ok(await page.locator('#commentsView').evaluate(node => node.classList.contains('active')));
  await page.locator('[data-view="likeCandidates"]').click();
  assert.equal(await page.locator('.candidateCard').count(), 30);
  assert.deepEqual(forbidden, [], 'all actual note writes must stay mocked and no other write service is allowed');

  // A browser that loses window.opener must recover from the copied PKCE proof.
  fallback = true;
  const source = await context.newPage();
  await source.goto(origin + '/#like-candidates');
  await source.waitForSelector('.candidateConnect');
  const callbackPagePromise = source.waitForEvent('popup');
  await source.locator('.candidateConnect').click();
  const callbackPage = await callbackPagePromise;
  callbackPage.on('pageerror', error => errors.push(error.message));
  await awaitConnection(callbackPage);
  assert.equal(new URL(callbackPage.url()).hash, '#like-candidates', 'authorization code must be removed from browser URL');
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 2, 'fallback authentication cannot send likes');
  assert.deepEqual(errors, []);
  await callbackPage.close();
  await source.close();
  await page.bringToFront();
  await page.evaluate(() => scrollTo(0, 0));
  await mkdir(resolve(root, '.tmp'), { recursive: true });
  await page.screenshot({ path: resolve(root, '.tmp/like-candidates-mobile.png'), animations: 'disabled' });
  console.log('MANUAL_CANDIDATES_BROWSER_OK: 30 mobile cards, owner popup and fallback, in-page extraction, explicit single likes, uncertain outcome lookup without resending.');
} finally {
  await browser?.close();
}
