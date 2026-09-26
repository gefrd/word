import { chromium } from 'playwright-core'; import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto('http://localhost:5190/test/synth.html'); await page.waitForFunction(() => window.ready);
const out = await page.evaluate(async () => {
  const { buildMesh, exportGLB } = await import('/src/export.js');
  const m = await (await fetch('/test/out/mesh.json')).json();
  const mesh = buildMesh({ positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices), colors: new Float32Array(m.colors), name: 'Kivu demo scan' });
  const glb = new Uint8Array(await (await exportGLB(mesh)).arrayBuffer());
  const icons = {};
  for (const s of [192, 512]) {
    const img = new Image(); img.src = '/public/icon.svg'; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = s; c.getContext('2d').drawImage(img, 0, 0, s, s); icons[s] = c.toDataURL('image/png');
  }
  let bin = ''; for (const v of glb) bin += String.fromCharCode(v);
  return { glb: btoa(bin), icons };
});
fs.writeFileSync('public/demo.glb', Buffer.from(out.glb, 'base64'));
for (const [s, url] of Object.entries(out.icons)) fs.writeFileSync(`public/icon-${s}.png`, Buffer.from(url.split(',')[1], 'base64'));
console.log('demo.glb', fs.statSync('public/demo.glb').size);
await browser.close();
