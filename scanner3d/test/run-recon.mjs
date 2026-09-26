// End-to-end test: synthetic walk-around → markers → poses → carve → mesh.
import { chromium } from 'playwright-core'; import fs from 'fs';
const useGT = process.argv.includes('--gt');
const nViews = +(process.argv.find(a => a.startsWith('--n='))?.slice(4) || 24);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('pageerror', e.message)); page.on('console', m => m.text().startsWith('markers') && console.log(m.text()));
await page.goto('http://localhost:5190/test/synth.html?el=' + (process.argv.find(a => a.startsWith('--el='))?.slice(5) || '30,55'));
await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
const res = await page.evaluate(async ({ useGT, nViews }) => {
  const views = window.renderViews(nViews, { f: 1000, elevations: (new URLSearchParams(location.search).get('el') || '30,55').split(',').map(Number) });
  const { detectMarkers, poseFromDetections } = await import('/src/tracker.js');
  const { estimateFocal } = await import('/src/geometry.js');
  const R = await import('/src/reconstruct.js');
  const grab = async (url, w, h) => { const img = new Image(); img.src = url; await img.decode(); const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h); return x.getImageData(0, 0, w, h); };
  const dets = [];
  for (const v of views) dets.push(detectMarkers(await grab(v.url, 1280, 720), 1));
  console.log('markers per view', dets.map(d => d.ids.length).join(','));
  const f = useGT ? 1000 : estimateFocal(dets.filter(d => d.ids.length >= 2), 1280, 720);
  const poses = [], urls = [];
  for (let i = 0; i < views.length; i++) {
    const pose = useGT ? { R: views[i].R, t: views[i].t } : poseFromDetections(dets[i], f, 1280, 720);
    if (pose) { poses.push(pose); urls.push(views[i].url); }
  }
  const getFrame = async (i, side) => { const w = side, h = Math.round(side * 720 / 1280); const d = await grab(urls[i], w, h); return { rgba: d.data, width: w, height: h }; };
  const t0 = performance.now();
  const out = await R.reconstructStreaming({ count: poses.length, getFrame, poses, f, fullWidth: 1280, fullHeight: 720 }, { voxel: 2, keepMasks: true });
  const ms = performance.now() - t0;
  const kf = poses;
  // IoU vs ground truth on the voxel grid
  const g = out.grid; const pts = [];
  for (let k = 0; k < g.nz; k += 1) for (let j = 0; j < g.ny; j += 2) for (let i = 0; i < g.nx; i += 2) pts.push([g.origin[0] + (i + .5) * g.voxel, g.origin[1] + (j + .5) * g.voxel, g.origin[2] + (k + .5) * g.voxel, g.occ[(k * g.ny + j) * g.nx + i]]);
  const gt = window.gtInside(pts.map(p => p.slice(0, 3)));
  let inter = 0, uni = 0, extra = 0, missing = 0;
  pts.forEach((p, n) => { const a = p[3] === 1, b = gt[n]; if (a && b) inter++; if (a || b) uni++; if (a && !b) extra++; if (!a && b) missing++; });
  // mask preview of view 0
  const mc = document.createElement('canvas'); mc.width = 640; mc.height = 360; const mx = mc.getContext('2d'); const id = mx.createImageData(640, 360);
  out.masks[0].forEach((v, i) => { const c = v === 2 ? [255, 60, 60] : v === 0 ? [255, 255, 255] : [90, 90, 90]; id.data.set([...c, 255], i * 4); }); mx.putImageData(id, 0, 0);
  return { ms: Math.round(ms), f, keyframes: kf.length, verts: out.positions.length / 3, tris: out.indices.length / 3, iou: inter / uni, extra, missing, gtCount: gt.filter(Boolean).length, mask: mc.toDataURL(),
    mesh: { positions: Array.from(out.positions), indices: Array.from(out.indices), colors: Array.from(out.colors) } };
}, { useGT, nViews });
console.log(`poses=${useGT ? 'ground truth' : 'estimated'} f=${res.f.toFixed(1)} keyframes=${res.keyframes} recon=${res.ms}ms verts=${res.verts} tris=${res.tris}`);
console.log(`IoU=${res.iou.toFixed(3)} extra=${res.extra} missing=${res.missing} (gt voxels ${res.gtCount})`);
fs.writeFileSync('test/out/mask0.png', Buffer.from(res.mask.split(',')[1], 'base64'));
fs.writeFileSync('test/out/mesh.json', JSON.stringify(res.mesh));
await browser.close();
