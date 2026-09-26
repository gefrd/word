import { chromium } from 'playwright-core'; import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto('http://localhost:5190/test/view-mesh.html'); await page.waitForFunction(() => window.ready);
const shots = await page.evaluate(() => window.show('/test/out/' + (new URLSearchParams(location.search).get('f') || 'mesh.json')));
// stitch 2x2 via canvas
const grid = await page.evaluate(async (shots) => { const c = document.createElement('canvas'); c.width = 1800; c.height = 1200; const x = c.getContext('2d');
  for (let i = 0; i < 4; i++) { const im = new Image(); im.src = shots[i]; await im.decode(); x.drawImage(im, (i % 2) * 900, Math.floor(i / 2) * 600); } return c.toDataURL('image/jpeg', 0.8); }, shots);
fs.writeFileSync(process.argv[2] || 'test/out/mesh.jpg', Buffer.from(grid.split(',')[1], 'base64'));
await browser.close();
