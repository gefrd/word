import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://localhost:5190/test/synth.html'); await page.waitForFunction(() => window.ready);
const r = await page.evaluate(async () => {
  const { detectMarkers, poseFromDetections, viewAngles } = await import('/src/tracker.js');
  const v = document.createElement('video'); v.muted = true; v.src = '/test/out/walkaround.webm';
  await new Promise(r => v.onloadedmetadata = r);
  let dur = v.duration; if (!isFinite(dur)) { v.currentTime = 1e6; await new Promise(r => v.onseeked = r); dur = v.duration; }
  const out = []; console.log('dur');
  const c = document.createElement('canvas'); c.width = 360; c.height = 640; const x = c.getContext('2d');
  const c2 = document.createElement('canvas'); c2.width = 720; c2.height = 1280; const x2 = c2.getContext('2d');
  for (let i = 0; i < 40; i++) {
    v.currentTime = (i + 0.5) * dur / 40; await new Promise(r => v.onseeked = r);
    x.drawImage(v, 0, 0, 360, 640); x2.drawImage(v, 0, 0, 720, 1280);
    const d1 = detectMarkers(x.getImageData(0, 0, 360, 640), 2);
    const d2 = detectMarkers(x2.getImageData(0, 0, 720, 1280), 1);
    const p = poseFromDetections(d2, 950, 720, 1280);
    out.push(`${d1.ids.length}/${d2.ids.length}${p ? '@' + Math.round(viewAngles(p).el) : ''}`);
  }
  return { dur, out: out.join(' ') };
});
console.log(r);
await browser.close();
