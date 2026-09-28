// End-to-end: the no-sheet scan through the real app UI (built app).
//   node test/e2e-free.mjs --input=video|photos [--obj=sneaker] [--mode=walk|turntable] [--cpu=4] [--noseek]
// Needs: dev server on 5190 (to render the synthetic scene), built app
// served on 5191 (npx vite build --outDir X && npx vite preview --port 5191 --outDir X),
// RMBG weights in test/models (requests to Hugging Face / jsDelivr are
// answered with local files, like on a phone that has them cached).
import { chromium } from 'playwright-core'; import fs from 'fs'; import path from 'path'; import { execSync } from 'child_process';
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const input = arg('input', 'video'), obj = arg('obj', 'sneaker'), mode = arg('mode', 'walk'), cpu = +arg('cpu', 1);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', ...(process.argv.includes('--gpu') ? ['--enable-unsafe-webgpu'] : [])] });
fs.mkdirSync('test/out', { recursive: true });

// 1. make the input with the synthetic scene
const gen = await browser.newPage();
await gen.goto(`http://localhost:5190/test/synth-free.html?obj=${obj}`);
await gen.waitForFunction(() => window.ready);
const files = [];
if (input === 'video') {
    const v = await gen.evaluate((m) => window.recordVideo(m, { seconds: 36, fps: 6, loops: [25, 45] }), mode);
    const p = `test/out/free-${obj}-${mode}.webm`;
    fs.writeFileSync(p, Buffer.from(v.b64, 'base64'));
    files.push(p);
    console.log('video', p, fs.statSync(p).size, 'bytes');
} else {
    const r = await gen.evaluate((m) => (m === 'turntable' ? window.renderTurntable(28, { w: 960, h: 1280, f: 1050 }) : window.renderWalk(30, { w: 960, h: 1280, f: 1050, loops: [30, 50] })), mode);
    r.frames.forEach((fr, i) => { const p = `test/out/free-photo-${String(i).padStart(2, '0')}.jpg`; fs.writeFileSync(p, Buffer.from(fr.url.split(',')[1], 'base64')); files.push(p); });
    console.log('photos', files.length);
}
await gen.close();

// 2. run the app like a phone
const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const seen = [];
await ctx.route(/huggingface\.co|hf\.co/, async (route) => {
    const url = route.request().url(); seen.push(url);
    const m = url.match(/briaai\/RMBG-1\.4\/resolve\/[^/]+\/(.+)$/);
    const local = m && path.join('test/models/briaai/RMBG-1.4', decodeURIComponent(m[1]));
    if (local && fs.existsSync(local)) return route.fulfill({ status: 200, body: fs.readFileSync(local), headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*', 'content-length': String(fs.statSync(local).size) } });
    return route.fulfill({ status: 404, body: 'not found', headers: { 'access-control-allow-origin': '*' } });
});
await ctx.route(/cdn\.jsdelivr\.net/, async (route) => {
    const url = route.request().url(); seen.push(url);
    const file = url.split('/').pop().split('?')[0];
    for (const dir of ['node_modules/@huggingface/transformers/dist', 'node_modules/onnxruntime-web/dist']) {
        const p = path.join(dir, file);
        if (fs.existsSync(p)) return route.fulfill({ status: 200, body: fs.readFileSync(p), headers: { 'content-type': file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'access-control-allow-origin': '*' } });
    }
    return route.fulfill({ status: 404, body: '' });
});
if (process.argv.includes('--noseek')) {
    // Android WebView bug: seeking a <video> never fires "seeked"
    await ctx.addInitScript(() => {
        const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { get() { return d.get.call(this); }, set(v) { if (this.paused && v > 0 && v < 1e6) return; d.set.call(this, v); } });
    });
}
const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
const logs = [];
page.on('console', m => { const t = m.text(); if (t.startsWith('[scan]')) logs.push(t); else if (m.type() === 'error') console.log('console', t.slice(0, 200)); });
await page.goto('http://localhost:5191/');
await page.waitForSelector('#freeLive');
await page.screenshot({ path: 'test/out/ui-free-home.png', fullPage: true });
if (cpu > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu }); }
let peak = 0;
const mem = setInterval(() => {
    try {
        const out = execSync(`ps -o rss=,args= -e | grep -- '--type=renderer' | grep -v grep || true`).toString();
        let rss = 0; for (const l of out.split('\n')) if (l.includes('--type=renderer')) rss += +l.trim().split(/\s+/)[0] || 0;
        peak = Math.max(peak, rss / 1024);
    } catch (_) {}
}, 500);
const t0 = Date.now();
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(input === 'video' ? '#freeVideo' : '#freePhotos')]);
await fc.setFiles(files);
await page.waitForSelector('.stages', { timeout: 20000 });
const stageLog = [];
let shot = false;
const poll = setInterval(async () => {
    try {
        const s = await page.evaluate(() => { const a = document.querySelector('.stages li.active'); return a ? a.textContent : null; });
        if (s && stageLog[stageLog.length - 1]?.[0] !== s) stageLog.push([s, ((Date.now() - t0) / 1000).toFixed(0) + 's']);
        if (!shot && s && /Carving/.test(s)) { shot = true; await page.screenshot({ path: 'test/out/ui-free-processing.png' }); }
    } catch {}
}, 400);
const res = await Promise.race([
    page.waitForSelector('.viewer-screen', { timeout: 1800000 }).then(() => 'viewer'),
    page.waitForSelector('.error-box', { timeout: 1800000 }).then(async () => 'error: ' + await page.textContent('.error-box')),
]);
clearInterval(poll); clearInterval(mem);
const secs = (Date.now() - t0) / 1000;
console.log(`result: ${res} in ${secs.toFixed(1)} s${cpu > 1 ? ` (CPU ×${cpu})` : ''}`);
console.log('stages:', stageLog.map(s => s.join(' @')).join(' → '));
for (const l of logs) console.log('  ' + l);
console.log(`peak renderer RSS ≈ ${peak.toFixed(0)} MB`);
if (res === 'viewer') {
    await page.waitForTimeout(2500);
    console.log('stats:', await page.textContent('#stats'), '|', await page.textContent('#note'));
    await page.screenshot({ path: `test/out/ui-free-viewer-${input}.png` });
    // "the field": lift the floor a little and pull the sides in, rebuild
    await page.click('#boxBtn');
    await page.$eval('input[data-k="z0"]', (e) => { e.value = 0.08; e.dispatchEvent(new Event('input')); });
    await page.$eval('input[data-k="x0"]', (e) => { e.value = 0.05; e.dispatchEvent(new Event('input')); });
    await page.screenshot({ path: `test/out/ui-free-box-${input}.png` });
    const tb = Date.now();
    await page.click('#boxApply');
    await page.waitForFunction(() => document.querySelector('#boxApply') && !document.querySelector('#boxApply').disabled, null, { timeout: 600000 });
    console.log(`box rebuild: ${((Date.now() - tb) / 1000).toFixed(1)} s →`, await page.textContent('#stats'), '| toast:', await page.textContent('.toast').catch(() => ''));
    await page.fill('#len', '26');
    await page.click('#applyLen');
    await page.waitForTimeout(800);
    console.log('after real length 26 cm:', await page.textContent('#stats'));
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), page.click('#glb')]);
    if (dl) { const p = 'test/out/free-export.glb'; await dl.saveAs(p); console.log('GLB', fs.statSync(p).size, 'bytes'); }
} else {
    await page.screenshot({ path: `test/out/ui-free-error-${input}.png` });
    console.log('try-photo button:', await page.locator('.error-box + .btn-row .btn.primary').count());
}
console.log('network (model/runtime):', [...new Set(seen.map(u => u.replace(/\?.*/, '').split('/').slice(-2).join('/')))].join(', '));
fs.writeFileSync(`test/out/e2e-free-${input}.json`, JSON.stringify({ res, secs, stageLog, peak, logs }, null, 1));
await browser.close();
