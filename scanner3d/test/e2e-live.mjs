import { chromium } from 'playwright-core'; import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + process.cwd() + '/test/out/camera.mjpeg'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', permissions: ['camera'] });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
page.on('console', m => m.type() === 'error' && console.log('console', m.text().slice(0, 200)));
await page.goto('http://localhost:5191/');
await page.click('#live');
const hints = new Map();
const t0 = Date.now();
let shotTaken = false;
while (Date.now() - t0 < 120000) {
  await page.waitForTimeout(700);
  const st = await page.evaluate(() => ({ hint: document.querySelector('#hint')?.textContent, n: +document.querySelector('#count')?.textContent, done: !document.querySelector('#done')?.disabled, vw: document.querySelector('video')?.videoWidth }));
  hints.set(st.hint, (hints.get(st.hint) || 0) + 1);
  if (!shotTaken && st.n >= 8) { shotTaken = true; await page.screenshot({ path: 'test/out/ui-live.png' }); }
  if (st.n >= 30) break;
}
const n = await page.textContent('#count');
console.log('keyframes after', ((Date.now() - t0) / 1000).toFixed(0), 's:', n);
console.log('hints seen:', [...hints.entries()].map(([h, c]) => `${h} (${c})`).join(' | '));
await page.click('#done');
const res = await Promise.race([
  page.waitForSelector('.viewer-screen', { timeout: 600000 }).then(() => 'viewer'),
  page.waitForSelector('.error-box', { timeout: 600000 }).then(async () => 'error: ' + await page.textContent('.error-box')),
]);
console.log('result:', res);
await page.waitForTimeout(2000);
console.log('stats:', await page.textContent('#stats').catch(() => ''), '|', await page.textContent('#note').catch(() => ''));
await page.screenshot({ path: 'test/out/ui-live-viewer.png' });
await browser.close();
