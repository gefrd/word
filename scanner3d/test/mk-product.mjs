import { chromium } from 'playwright-core'; import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto('http://localhost:5190/test/synth.html'); await page.waitForFunction(() => window.ready);
const url = await page.evaluate(() => window.renderProduct());
fs.writeFileSync('test/out/product.jpg', Buffer.from(url.split(',')[1], 'base64'));
await browser.close();
