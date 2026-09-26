import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
page.on('console', m => m.type() === 'error' && console.log('console', m.text()));
await page.goto('http://localhost:5190/test/synth.html');
await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
const res = await page.evaluate(async () => {
  const views = window.renderViews(24, { f: 1000 });
  const { detectMarkers, poseFromDetections, viewAngles } = await import('/src/tracker.js');
  const { estimateFocal, cameraCenter } = await import('/src/geometry.js');
  const dets = [];
  const out = [];
  for (const v of views) {
    const img = new Image(); img.src = v.url; await img.decode();
    const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const t0 = performance.now();
    // detect on a half-size copy, like the live mode on phones
    const s = document.createElement('canvas'); s.width = v.width / 2; s.height = v.height / 2; s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
    const det = detectMarkers(s.getContext('2d').getImageData(0, 0, s.width, s.height), 2);
    const ms = performance.now() - t0;
    dets.push(det); out.push({ n: det.ids.length, ms: Math.round(ms) });
  }
  const f = estimateFocal(dets.filter(d => d.ids.length >= 2).map(d => ({ world: d.world, image: d.image })), 1280, 720);
  views.forEach((v, i) => {
    const p = poseFromDetections(dets[i], f, 1280, 720);
    if (!p) { out[i].err = 'no pose'; return; }
    const C = cameraCenter(p.R, p.t), G = cameraCenter(v.R, v.t);
    out[i].posErr = +Math.hypot(C[0]-G[0], C[1]-G[1], C[2]-G[2]).toFixed(1);
    out[i].rms = +p.rms.toFixed(2);
    out[i].el = Math.round(viewAngles(p).el);
  });
  return { f, out, sample: views[0].url };
});
console.log('estimated f', res.f.toFixed(1), '(true 1000)');
console.log(res.out.map((o, i) => `${i}: markers=${o.n} det=${o.ms}ms posErr=${o.posErr}mm rms=${o.rms}px el=${o.el} ${o.err||''}`).join('\n'));
const fs = await import('fs'); fs.writeFileSync('test/out/view0.jpg', Buffer.from(res.sample.split(',')[1], 'base64'));
await browser.close();
