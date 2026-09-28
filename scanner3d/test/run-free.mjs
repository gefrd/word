// Markerless (no sheet) reconstruction test on synthetic scenes.
//   node test/run-free.mjs --mode=walk|turntable --obj=sneaker|toy|bottle --masks=rmbg|gt --n=30
// Needs: npx vite --port 5190 (dev server) and, for --masks=rmbg, the RMBG
// weights in test/models/briaai/RMBG-1.4/onnx/model_quantized.onnx.
import { chromium } from 'playwright-core'; import fs from 'fs'; import { execSync } from 'child_process';
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const mode = arg('mode', 'walk'), obj = arg('obj', 'sneaker'), masks = arg('masks', 'rmbg'), n = +arg('n', 30);
const throttle = +arg('throttle', 1), profile = arg('profile', 'mid');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && console.log('console', m.text().slice(0, 300)));
await page.goto(`http://localhost:5190/test/free-test.html?obj=${obj}${process.argv.includes('--plain') ? '&plain=1' : ''}`);
await page.waitForFunction(() => window.ready && window.testReady, null, { timeout: 60000 });
if (throttle > 1) { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
// peak memory of the browser's renderer processes (RSS, MB)
let peak = 0;
const sample = () => {
    try {
        const out = execSync(`ps -o rss=,args= -e | grep -- '--type=renderer' | grep -v grep || true`).toString();
        let rss = 0;
        for (const line of out.split('\n')) if (line.includes('--type=renderer')) rss += +line.trim().split(/\s+/)[0] || 0;
        peak = Math.max(peak, rss / 1024);
    } catch (_) {}
};
const timer = setInterval(sample, 500);
const t0 = Date.now();
const res = await page.evaluate((o) => window.runFree(o), {
    mode, n, masks, profile, maskEval: process.argv.includes('--maskEval'), gtPoseCheck: process.argv.includes('--gtPoses'),
    keepMesh: process.argv.includes('--mesh'), render: arg('loops') ? { loops: arg('loops').split(',').map(Number) } : {}, sfm: { debug: process.argv.includes('--debug') },
});
clearInterval(timer);
const r = (x, d = 0) => (x == null ? '-' : (+x).toFixed(d));
console.log(`== ${obj} / ${mode} / masks=${masks} / n=${n} / profile=${profile}${throttle > 1 ? ' / cpu×' + throttle : ''}`);
for (const l of res.logs) console.log('  ' + l);
if (res.err) console.log('ERROR', res.err);
console.log(`times ms: ${Object.entries(res.T).map(([k, v]) => `${k}=${r(v)}`).join(' ')}  (wall ${Date.now() - t0})`);
console.log(`features/frame: median ${res.featCounts.sort((a, b) => a - b)[res.featCounts.length >> 1]}`);
if (res.maskIoU.length) console.log(`mask IoU vs truth: mean ${r(res.maskIoU.reduce((a, b) => a + b, 0) / res.maskIoU.length, 3)} min ${r(Math.min(...res.maskIoU), 3)}`);
if (res.pose) {
    console.log(`registered ${res.registered}/${n}; camera position err median ${r(res.pose.posErrMedMm, 1)} mm (max ${r(res.pose.posErrMaxMm, 1)}) at ~${r(res.pose.camDistMm)} mm; rotation err median ${r(res.pose.rotErrMedDeg, 2)}° (max ${r(res.pose.rotErrMaxDeg, 2)}°)`);
    console.log(`focal est ${r(res.fEst, 1)} vs true ${res.fGT} (${r((res.fEst / res.fGT - 1) * 100, 1)} %); scale est/true ${r(res.pose.scale, 3)}`);
    console.log(`IoU ${r(res.iou.iou, 3)}  extra ${r(res.iou.extraFrac, 3)}  missing ${r(res.iou.missingFrac, 3)}  verts ${res.verts}`);
}
if (res.iouGTPoses) console.log(`IoU with true poses (mask error only): ${r(res.iouGTPoses.iou, 3)} extra ${r(res.iouGTPoses.extraFrac, 3)} missing ${r(res.iouGTPoses.missingFrac, 3)}`);
console.log(`peak renderer RSS ≈ ${r(peak)} MB`);
fs.mkdirSync('test/out', { recursive: true });
if (res.mesh) fs.writeFileSync(`test/out/free-${obj}-${mode}.json`, JSON.stringify(res.mesh));
fs.writeFileSync(`test/out/free-${obj}-${mode}-${masks}.result.json`, JSON.stringify({ ...res, mesh: undefined }, null, 1));
await browser.close();
