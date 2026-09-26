import { chromium } from 'playwright-core'; import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto('http://localhost:5190/test/synth.html'); await page.waitForFunction(() => window.ready);
const b64 = await page.evaluate(() => window.recordWalkaround({ seconds: 36, fps: 6 }));
fs.writeFileSync('test/out/walkaround.webm', Buffer.from(b64, 'base64'));
console.log('video bytes', fs.statSync('test/out/walkaround.webm').size);
await browser.close();
