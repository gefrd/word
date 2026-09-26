import { chromium } from 'playwright-core'; import fs from 'fs'; import path from 'path';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU' });
const seen = [];
await ctx.route(/huggingface\.co|hf\.co/, async (route) => {
  const url = route.request().url(); seen.push(url);
  const m = url.match(/briaai\/RMBG-1\.4\/resolve\/[^/]+\/(.+)$/);
  const local = m && path.join('test/models/briaai/RMBG-1.4', decodeURIComponent(m[1]));
  if (local && fs.existsSync(local)) return route.fulfill({ status: 200, body: fs.readFileSync(local), headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' } });
  return route.fulfill({ status: 404, body: 'not found', headers: { 'access-control-allow-origin': '*' } });
});
await ctx.route(/cdn\.jsdelivr\.net/, async (route) => {
  const url = route.request().url(); seen.push(url);
  const file = url.split('/').pop();
  for (const dir of ['node_modules/onnxruntime-web/dist', 'node_modules/@huggingface/transformers/dist']) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return route.fulfill({ status: 200, body: fs.readFileSync(p), headers: { 'content-type': file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'access-control-allow-origin': '*' } });
  }
  return route.fulfill({ status: 404, body: '' });
});
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
page.on('console', m => ['error', 'warning'].includes(m.type()) && console.log('console', m.type(), m.text().slice(0, 160)));
await page.goto('http://localhost:5191/');
const t0 = Date.now();
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#pickPhoto')]);
await fc.setFiles('test/out/product.jpg');
const res = await Promise.race([
  page.waitForSelector('.viewer-screen', { timeout: 600000 }).then(() => 'viewer'),
  page.waitForSelector('.error-box', { timeout: 600000 }).then(async () => 'error: ' + await page.textContent('.error-box')),
]);
console.log('result:', res, ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.waitForTimeout(2500);
console.log('stats:', await page.textContent('#stats').catch(() => ''), '|', await page.textContent('#note').catch(() => ''));
await page.screenshot({ path: 'test/out/ui-photo-viewer.png' });
// thickness slider
await page.$eval('#thick', (e) => { e.value = 0.7; e.dispatchEvent(new Event('input')); }).catch(e => console.log('no slider', e.message));
await page.waitForTimeout(1500);
console.log('after slider:', await page.textContent('#stats').catch(() => ''));
console.log('requested:\n ' + [...new Set(seen.map(u => u.replace(/\?.*/, '')))].join('\n '));
await browser.close();
