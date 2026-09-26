import { chromium } from 'playwright-core'; import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://localhost:4173/?tool=converter'); await page.waitForFunction(() => window.__inited);
const b64 = fs.readFileSync('test/out/sheet.pdf').toString('base64');
const png = await page.evaluate(async (b64) => {
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const img = await window.__mod.convertFile(new File([bin], 'sheet.pdf', { type: 'application/pdf' }), 'png');
  const ab = new Uint8Array(await img.arrayBuffer()); let s = ''; for (const v of ab) s += String.fromCharCode(v); return btoa(s);
}, b64);
fs.writeFileSync('test/out/sheet-pdf.png', Buffer.from(png, 'base64'));
const p2 = await browser.newPage();
await p2.goto('http://localhost:5190/test/synth.html'); await p2.waitForFunction(() => window.ready);
const r = await p2.evaluate(async (png) => {
  const { detectMarkers } = await import('/src/tracker.js');
  const im = new Image(); im.src = 'data:image/png;base64,' + png; await im.decode();
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
  const d = detectMarkers(x.getImageData(0, 0, c.width, c.height));
  return { w: im.width, h: im.height, ids: d.ids };
}, png);
console.log(r);
await browser.close();
