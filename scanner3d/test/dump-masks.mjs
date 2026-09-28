// Saves RMBG masks next to the frames for a quick visual check.
import { chromium } from 'playwright-core'; import fs from 'fs';
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto(`http://localhost:5190/test/free-test.html?obj=${arg('obj', 'sneaker')}`);
await page.waitForFunction(() => window.ready && window.testReady);
const out = await page.evaluate(async ({ mode, side, idx }) => {
  const { loadRMBG, segmentObject } = await import('/src/rmbg.js');
  await loadRMBG({ url: '/test/models/briaai/RMBG-1.4/onnx/model_quantized.onnx', wasmPaths: '/node_modules/onnxruntime-web/dist/' });
  const d = mode === 'turntable' ? window.renderTurntable(30) : window.renderWalk(30, { loops: [25, 45] });
  const res = [];
  for (const i of idx) {
    const img = new Image(); img.src = d.frames[i].url; await img.decode();
    const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 640, 360);
    const id = x.getImageData(0, 0, 640, 360);
    const m = await segmentObject(id.data, 640, 360, side);
    for (let k = 0; k < m.length; k++) { const a = m[k] / 255; id.data[k * 4] = id.data[k * 4] * (0.35 + 0.65 * a) + 255 * (1 - a) * 0.6; id.data[k * 4 + 1] *= 0.35 + 0.65 * a; id.data[k * 4 + 2] *= 0.35 + 0.65 * a; }
    x.putImageData(id, 0, 0); res.push(c.toDataURL('image/jpeg', 0.8));
  }
  return res;
}, { mode: arg('mode', 'walk'), side: +arg('side', 384), idx: arg('idx', '0,8,20').split(',').map(Number) });
out.forEach((u, k) => fs.writeFileSync(`test/out/rmbg-${arg('mode', 'walk')}-${arg('side', 384)}-${k}.jpg`, Buffer.from(u.split(',')[1], 'base64')));
await browser.close();
