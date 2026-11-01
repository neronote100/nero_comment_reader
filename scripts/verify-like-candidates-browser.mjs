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
  let offline = false, fallback = false, starts = 0, nexts = 0, refusedSends = 0;
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
        } else if (key === feed.candidates[2].articleUrl.split('/').at(-1) && refusedSends++ === 0) {
          states[key] = 'refused';
          await fulfill({ ok: true, key, liked: false, retryable: true, confirmationPending: false, code: 'NOTE_SEND_REJECTED', noteStatus: 403 });
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
      await target.waitForFunction(() => !document.querySelector('.candidateConnect')?.disabled);
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
  await awaitConnection(page);
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 0, 'an unauthenticated like tap opens owner connection without queuing a like');
  await page.locator('.candidateDisconnect').click();
  await page.waitForFunction(() => document.querySelector('.candidateDisconnect')?.hidden === true);
  await page.locator('.candidateSearch').click();
  await awaitConnection(page);
  assert.equal(starts, 0, 'an unauthenticated search tap opens owner connection and waits for a fresh search click');
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 0);
  await page.locator('.candidateDisconnect').click();
  await page.waitForFunction(() => document.querySelector('.candidateDisconnect')?.hidden === true);
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
  const firstKey = feed.candidates[0].articleUrl.split('/').at(-1);
  const secondKey = feed.candidates[1].articleUrl.split('/').at(-1);
  const thirdKey = feed.candidates[2].articleUrl.split('/').at(-1);
  const cardFor = key => page.locator('.candidateCard[data-key="' + key + '"]');
  await cardFor(firstKey).locator('.candidateSend').click();
  await cardFor(firstKey).waitFor({ state: 'detached' });
  assert.equal(await page.locator('.candidateCard').count(), 29, 'a confirmed like must disappear immediately');
  assert.equal(await page.locator('.candidateCount').innerText(), '29人');
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 1);
  assert.equal(writes.find(w => w.path === '/reader/like').body.key, firstKey);
  await page.getByRole('button', { name: '↻ 最新候補を表示', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.candidateRefresh')?.disabled);
  assert.equal(await cardFor(firstKey).count(), 0, 'a refreshed public batch must not restore a confirmed like');
  await cardFor(secondKey).locator('.candidateSend').click();
  await page.waitForFunction(() => document.querySelectorAll('.candidateCheckDelivery').length === 1);
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 2);
  assert.equal(await cardFor(secondKey).count(), 1, 'an uncertain send must remain visible');
  assert.equal(await cardFor(secondKey).locator('.candidateSend').isDisabled(), true);
  assert.equal(await page.locator('.candidateCard').count(), 29);
  const exchangesBeforeReload = writes.filter(w => w.path === '/reader/exchange').length;
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.candidateCard').length === 29);
  await awaitConnection(page);
  assert.equal(writes.filter(w => w.path === '/reader/exchange').length, exchangesBeforeReload, 'same-tab reload restores its existing owner session without another OAuth exchange');
  assert.equal(await cardFor(firstKey).count(), 0, 'confirmed results must survive the same-tab reload');
  assert.equal(await cardFor(secondKey).count(), 1, 'an uncertain send cannot be hidden as completed');
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 2, 'reload cannot resend an uncertain like');
  await cardFor(secondKey).locator('.candidateCheckDelivery').waitFor();
  assert.equal(await cardFor(secondKey).locator('.candidateSend').isDisabled(), true, 'authenticated server history restores the uncertain state');
  await cardFor(secondKey).locator('.candidateCheckDelivery').click();
  await page.waitForFunction(() => document.querySelectorAll('.candidateCheckDelivery').length === 0);
  await cardFor(secondKey).waitFor({ state: 'detached' });
  assert.equal(await page.locator('.candidateCard').count(), 28, 'a positive status lookup hides the newly confirmed article');
  assert.equal(await page.locator('.candidateCount').innerText(), '28人');
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 2, 'checking an uncertain result must never resend a like');
  await cardFor(thirdKey).locator('.candidateSend').click();
  await page.waitForFunction(key => {
    const card = document.querySelector('.candidateCard[data-key="' + key + '"]');
    return card && !card.querySelector('.candidateSend')?.disabled;
  }, thirdKey);
  assert.equal(await cardFor(thirdKey).count(), 1, 'a known refusal cannot hide an article as completed');
  assert.equal(await page.locator('.candidateCard').count(), 28);
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 3);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 3, 'a known refusal cannot automatically retry');
  await cardFor(thirdKey).locator('.candidateSend').click();
  await cardFor(thirdKey).waitFor({ state: 'detached' });
  assert.equal(await page.locator('.candidateCard').count(), 27, 'a fresh manual click can confirm and hide a previously refused article');
  assert.equal(await page.locator('.candidateCount').innerText(), '27人');
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 4);
  await page.locator('[data-view="comments"]').click();
  assert.ok(await page.locator('#commentsView').evaluate(node => node.classList.contains('active')));
  await page.locator('[data-view="likeCandidates"]').click();
  assert.equal(await page.locator('.candidateCard').count(), 27);
  const finalExchangesBeforeReload = writes.filter(w => w.path === '/reader/exchange').length;
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.candidateCard').length === 27);
  await awaitConnection(page);
  assert.equal(writes.filter(w => w.path === '/reader/exchange').length, finalExchangesBeforeReload);
  assert.equal(await cardFor(firstKey).count(), 0);
  assert.equal(await cardFor(secondKey).count(), 0);
  assert.equal(await cardFor(thirdKey).count(), 0);
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 4, 'persisted confirmation never resends a like');
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
  assert.equal(await callbackPage.locator('.candidateCard').count(), 27, 'confirmed results are hidden after OAuth fallback and feed reload');
  assert.equal(new URL(callbackPage.url()).hash, '#like-candidates', 'authorization code must be removed from browser URL');
  assert.equal(writes.filter(w => w.path === '/reader/like').length, 4, 'fallback authentication cannot send likes');
  assert.deepEqual(errors, []);
  await callbackPage.close();
  await source.close();
  await page.bringToFront();
  await page.evaluate(() => scrollTo(0, 0));
  await mkdir(resolve(root, '.tmp'), { recursive: true });
  await page.screenshot({ path: resolve(root, '.tmp/like-candidates-mobile.png'), animations: 'disabled' });
  console.log('MANUAL_CANDIDATES_BROWSER_OK: 30 mobile cards, owner popup and fallback, explicit single likes, confirmed results hidden across refresh/reload, uncertain outcome lookup without resending.');
} finally {
  await browser?.close();
}
