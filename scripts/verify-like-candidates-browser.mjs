import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(new URL('../', import.meta.url).pathname);
const now = Date.now();
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
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] || 'application/json' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP' });
  let offline = false;
  const writes = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') { writes.push(request.method() + ' ' + url.origin); await route.abort(); return; }
    if (url.pathname.endsWith('/like-candidates.json')) {
      if (offline) await route.abort();
      else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feed) });
    } else if (url.origin === origin) await route.continue();
    else if (url.hostname === 'nero-comment-reader.nero-prince.workers.dev') await route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, snapshot: { version: 5, items: [], updatedAt: new Date(now).toISOString() } }),
    });
    else await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Mock article</p>' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#like-candidates');
  await page.waitForFunction(() => document.querySelectorAll('.candidateCard').length === 30);
  assert.equal(await page.locator('.candidateCount').innerText(), '30人');
  assert.equal(await page.locator('.candidatePerson script').count(), 0);
  assert.ok((await page.locator('.candidatePerson').first().innerText()).includes('<script>'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile layout must fit the screen');
  const article = page.locator('.candidateActions a').first();
  assert.equal(await article.getAttribute('href'), feed.candidates[0].articleUrl);
  assert.match(await article.getAttribute('rel'), /noopener/);
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
  await page.locator('[data-view="comments"]').click();
  assert.ok(await page.locator('#commentsView').evaluate(node => node.classList.contains('active')));
  await page.locator('[data-view="likeCandidates"]').click();
  assert.equal(await page.locator('.candidateCard').count(), 30);
  assert.deepEqual(writes, [], 'manual candidate UI must not issue a write request');
  assert.deepEqual(errors, []);
  await page.evaluate(() => scrollTo(0, 0));
  await mkdir(resolve(root, '.tmp'), { recursive: true });
  await page.screenshot({ path: resolve(root, '.tmp/like-candidates-mobile.png') });
  console.log('MANUAL_CANDIDATES_BROWSER_OK: 30 cards, mobile fit, manual records, retained results, no write requests.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
