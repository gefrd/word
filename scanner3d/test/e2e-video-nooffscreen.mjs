import { chromium } from 'playwright-core'; import fs from 'fs';
const throttle = +(process.env.CPU || 4);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', acceptDownloads: true });
await ctx.addInitScript(() => { delete window.OffscreenCanvas; }); const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
page.on('console', m => m.type() === 'error' && console.log('console', m.text().slice(0, 200)));
await page.goto('http://localhost:5191/');
await page.waitForSelector('#live');
await page.screenshot({ path: 'test/out/ui-home.png', fullPage: true });
const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
const t0 = Date.now();
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#video')]);
await fc.setFiles('test/out/walkaround.webm');
await page.waitForSelector('.stages', { timeout: 10000 });
let shot = false;
const stageLog = [];
const poll = setInterval(async () => {
  try {
    const s = await page.evaluate(() => { const a = document.querySelector('.stages li.active'); return a ? a.textContent + ' ' + (document.querySelector('#detail')?.textContent || '') : null; });
    if (s && stageLog[stageLog.length - 1] !== s.split(' ')[0]) stageLog.push(s.split(' ')[0]);
    if (!shot && s && /Вырезание|Carving/.test(s)) { shot = true; await page.screenshot({ path: 'test/out/ui-processing.png' }); }
  } catch {}
}, 500);
const res = await Promise.race([
  page.waitForSelector('.viewer-screen', { timeout: 900000 }).then(() => 'viewer'),
  page.waitForSelector('.error-box', { timeout: 900000 }).then(async () => 'error: ' + await page.textContent('.error-box')),
]);
clearInterval(poll);
console.log('result:', res, 'in', ((Date.now() - t0) / 1000).toFixed(1), 's (CPU x' + throttle + ')');
console.log('stages:', stageLog.join(' → '));
await page.waitForTimeout(2500);
console.log('stats:', await page.textContent('#stats').catch(() => ''), '|', await page.textContent('#note').catch(() => ''));
await page.screenshot({ path: 'test/out/ui-viewer.png' });
// exports
for (const id of ['glb', 'stl', 'obj']) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), page.click('#' + id)]);
  if (dl) { const p = 'test/out/export.' + id; await dl.saveAs(p); console.log(id, fs.statSync(p).size, 'bytes'); } else console.log(id, 'no download');
}
await page.click('#save'); await page.waitForTimeout(1500);
console.log('toast:', await page.textContent('.toast').catch(() => ''));
await page.click('#back'); await page.waitForTimeout(1000);
console.log('saved cards:', await page.locator('.model-card').count());
await browser.close();
