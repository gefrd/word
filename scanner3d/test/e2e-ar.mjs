// End-to-end: the AR scan (live box) through the real app UI, with a fake
// WebXR device. The fake plays a synthetic walk-around: each step gives the
// true camera pose as an ARCore phone would (metres, y up, camera looks −z),
// the camera picture as a GL texture (getCameraImage), and a hit-test result
// on the table. Everything after that is the real app: overlay, box sliders,
// automatic frames, worker, model, viewer.
//   node test/e2e-ar.mjs [--obj=sneaker] [--n=36] [--gpu] [--cpu=4] [--noise] [--stored=flipY|none]
//   --stored=none: the texture holds the picture top row first (the other
//   way round) — the app must notice by itself and still get it right.
// Needs: dev server on 5190 (synthetic scene), built app served on 5191,
// RMBG weights in test/models (see e2e-free.mjs).
import { chromium } from 'playwright-core'; import fs from 'fs'; import path from 'path'; import { execSync } from 'child_process';
import { xrPoseToObject } from '../src/markerless.js';
const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const obj = arg('obj', 'sneaker'), n = +arg('n', 36), cpu = +arg('cpu', 1), W = 720, H = 1280, F = 1000;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.argv.includes('--gpu') ? ['--enable-unsafe-webgpu'] : [])] });
fs.mkdirSync('test/out', { recursive: true });

// 1. the walk-around with true poses (object frame, mm, z up; OpenCV camera)
const gen = await browser.newPage();
await gen.goto(`http://localhost:5190/test/synth-free.html?obj=${obj}`);
await gen.waitForFunction(() => window.ready);
const walk = await gen.evaluate((o) => window.renderWalk(o.n, { w: o.W, h: o.H, f: o.F, loops: [25, 45] }), { n, W, H, F });
const gtBox = await gen.evaluate(() => window.gtBox());
await gen.close();

// 2. object frame → AR world (metres, y up): the object's floor point sits at FLOOR
const FLOOR = [0.21, -1.05, -0.48];
const Mo = [1, 0, 0, 0, 0, 1, 0, -1, 0];                // object (x, y, z) → world (x, z, −y)
const mv = (A, v) => [0, 1, 2].map(r => A[r * 3] * v[0] + A[r * 3 + 1] * v[1] + A[r * 3 + 2] * v[2]);
const mm = (A, B) => { const C = []; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C.push(A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]); return C; };
const tr = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
let rng = 7; const rn = () => { rng = (rng * 16807) % 2147483647; return rng / 2147483647 - 0.5; };
const noise = process.argv.includes('--noise');
const poses = walk.frames.map((fr) => {
    const Rt = tr(fr.R), c = mv(Rt, fr.t).map(v => -v);
    const Rwc = mm(mm(Mo, Rt), [1, 0, 0, 0, -1, 0, 0, 0, -1]);   // columns: camera right, up, back in world
    const p = mv(Mo, c).map((v, i) => FLOOR[i] + v / 1000 + (noise ? rn() * 0.004 : 0));
    const m = [Rwc[0], Rwc[3], Rwc[6], 0, Rwc[1], Rwc[4], Rwc[7], 0, Rwc[2], Rwc[5], Rwc[8], 0, p[0], p[1], p[2], 1];
    // round trip through the app's own conversion
    const back = xrPoseToObject(m, FLOOR);
    const err = Math.max(...back.R.map((v, i) => Math.abs(v - fr.R[i]))) + (noise ? 0 : Math.max(...back.t.map((v, i) => Math.abs(v - fr.t[i]))) / 1000);
    if (err > 1e-6) throw new Error('pose round trip failed ' + err);
    return m;
});
console.log(`${n} frames ${W}×${H}, pose round trip ok`);

// 3. the app, with the fake WebXR device
const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36' });
await ctx.route(/huggingface\.co|hf\.co/, async (route) => {
    const m = route.request().url().match(/briaai\/RMBG-1\.4\/resolve\/[^/]+\/(.+)$/);
    const local = m && path.join('test/models/briaai/RMBG-1.4', decodeURIComponent(m[1]));
    if (local && fs.existsSync(local)) return route.fulfill({ status: 200, body: fs.readFileSync(local), headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*', 'content-length': String(fs.statSync(local).size) } });
    return route.fulfill({ status: 404, body: 'not found', headers: { 'access-control-allow-origin': '*' } });
});
await ctx.route(/cdn\.jsdelivr\.net/, async (route) => {
    const file = route.request().url().split('/').pop().split('?')[0];
    for (const dir of ['node_modules/@huggingface/transformers/dist', 'node_modules/onnxruntime-web/dist']) {
        const p = path.join(dir, file);
        if (fs.existsSync(p)) return route.fulfill({ status: 200, body: fs.readFileSync(p), headers: { 'content-type': file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'access-control-allow-origin': '*' } });
    }
    return route.fulfill({ status: 404, body: '' });
});
await ctx.addInitScript(({ W, H, F, FLOOR }) => {
    const near = 0.05, far = 100;
    const proj = [2 * F / W, 0, 0, 0, 0, 2 * F / H, 0, 0, 0, 0, -(far + near) / (far - near), -1, 0, 0, -2 * far * near / (far - near), 0];
    const inv = (m) => {   // rigid 4×4 (column-major) inverse
        const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0];
        const t = [m[12], m[13], m[14]];
        return [r[0], r[1], r[2], 0, r[4], r[5], r[6], 0, r[8], r[9], r[10], 0,
            -(r[0] * t[0] + r[4] * t[1] + r[8] * t[2]), -(r[1] * t[0] + r[5] * t[1] + r[9] * t[2]), -(r[2] * t[0] + r[6] * t[1] + r[10] * t[2]), 1];
    };
    const X = window.__xr = { poses: [], images: [], index: 0, session: null, shots: 0, texReads: 0 };
    const source = { handedness: 'none', targetRayMode: 'screen', targetRaySpace: {}, profiles: [], gamepad: null };
    class FakeSession extends EventTarget {
        constructor(init) {
            super();
            this.enabledFeatures = ['hit-test', 'dom-overlay', 'camera-access'];
            this.renderState = { baseLayer: null, depthNear: 0.1, depthFar: 1000 };
            this.inputSources = [source];
            this.environmentBlendMode = 'alpha-blend';
            this.domOverlayState = { type: 'screen' };
            this.ended = false;
            X.session = this; X.init = init;
            setTimeout(() => { const e = new Event('inputsourceschange'); e.added = [source]; e.removed = []; this.dispatchEvent(e); }, 50);
        }
        updateRenderState(s) { Object.assign(this.renderState, s); }
        async requestReferenceSpace(type) { return { type, getOffsetReferenceSpace() { return this; } }; }
        async requestHitTestSource() { return { cancel() {} }; }
        requestAnimationFrame(cb) { return setTimeout(() => { if (!this.ended) cb(performance.now(), this.frame()); }, 33); }
        cancelAnimationFrame(id) { clearTimeout(id); }
        async end() { if (this.ended) return; this.ended = true; setTimeout(() => this.dispatchEvent(new Event('end')), 0); }
        frame() {
            const m = X.poses[X.index], session = this;
            const transform = { matrix: new Float32Array(m), inverse: { matrix: new Float32Array(inv(m)) }, position: { x: m[12], y: m[13], z: m[14], w: 1 } };
            const view = { eye: 'none', projectionMatrix: new Float32Array(proj), transform, camera: { width: W, height: H, index: X.index } };
            return {
                session,
                getViewerPose: () => ({ emulatedPosition: false, transform, views: [view] }),
                getPose: () => null,
                getHitTestResults: () => [{ getPose: () => ({ transform: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, FLOOR[0], FLOOR[1], FLOOR[2], 1]) } }) }],
            };
        }
    }
    const xr = {
        isSessionSupported: async (mode) => mode === 'immersive-ar',
        requestSession: async (mode, init) => new FakeSession(init),
        addEventListener() {}, removeEventListener() {},
    };
    Object.defineProperty(Navigator.prototype, 'xr', { get: () => xr, configurable: true });
    window.XRWebGLLayer = class {
        constructor(session, gl) { this.framebuffer = null; this.framebufferWidth = gl.drawingBufferWidth; this.framebufferHeight = gl.drawingBufferHeight; this.antialias = true; this.ignoreDepthValues = false; }
        getViewport() { return { x: 0, y: 0, width: this.framebufferWidth, height: this.framebufferHeight }; }
    };
    window.XRWebGLBinding = class {
        constructor(session, gl) { this.gl = gl; this.tex = null; this.loaded = -1; }
        getCameraImage(camera) {
            const gl = this.gl;
            if (!this.tex) this.tex = gl.createTexture();
            if (this.loaded !== camera.index) {
                // like a GL camera texture: first row = bottom of the picture
                gl.bindTexture(gl.TEXTURE_2D, this.tex);
                // (ImageBitmap ignores UNPACK_FLIP_Y: the bitmap is made pre-flipped)
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, X.images[camera.index]);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.bindTexture(gl.TEXTURE_2D, null);
                this.loaded = camera.index;
            }
            X.texReads++;
            return this.tex;
        }
    };
    for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) if (C) C.prototype.makeXRCompatible = async function () {};
    X.select = () => { const e = new Event('select'); e.inputSource = source; e.frame = X.session.frame(); X.session.dispatchEvent(e); };
}, { W, H, F, FLOOR });

const page = await ctx.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
const logs = [];
page.on('console', m => { const t = m.text(); if (t.startsWith('[scan]')) logs.push(t); else if (m.type() === 'error') console.log('console', t.slice(0, 200)); });
await page.goto('http://localhost:5191/');
await page.waitForSelector('#freeAR', { state: 'visible', timeout: 15000 });
await page.screenshot({ path: 'test/out/ui-ar-home.png', fullPage: true });
// the camera pictures and poses go to the fake device
await page.evaluate(async ({ urls, poses, stored }) => {
    window.__xr.poses = poses;
    // flipY: stored the GL way, bottom row first (like a GL camera texture)
    window.__xr.images = await Promise.all(urls.map(async (u) => createImageBitmap(await (await fetch(u)).blob(), { imageOrientation: stored })));
}, { urls: walk.frames.map(f => f.url), poses, stored: arg('stored', 'flipY') === 'none' ? 'from-image' : 'flipY' });
if (cpu > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu }); }
let peak = 0;
const mem = setInterval(() => {
    try {
        const out = execSync(`ps -o rss=,args= -e | grep -- '--type=renderer' | grep -v grep || true`).toString();
        let rss = 0; for (const l of out.split('\n')) if (l.includes('--type=renderer')) rss += +l.trim().split(/\s+/)[0] || 0;
        peak = Math.max(peak, rss / 1024);
    } catch (_) {}
}, 500);

const hint = () => page.textContent('#arHint');
await page.click('#freeAR');
await page.waitForFunction(() => window.__xr.session && document.querySelector('#arHint') && /tap to put the box/.test(document.querySelector('#arHint').textContent), null, { timeout: 15000 })
    .catch(async (e) => { console.log('stuck:', logs, await page.evaluate(() => ({ session: !!window.__xr.session, hint: document.querySelector('#arHint')?.textContent, toast: document.querySelector('.toast')?.textContent }))); await page.screenshot({ path: 'test/out/ui-ar-stuck.png' }); throw e; });
console.log('1.', await hint());
await page.waitForTimeout(300);
await page.evaluate(() => window.__xr.select());          // tap on the table
await page.waitForSelector('#arSizes:not([hidden])');
console.log('2.', await hint());
// a box around the object: true extent + 3 cm each side, whole cm
const [lo, hi] = gtBox;
const cm = (v) => Math.ceil(v / 10);
const sz = { w: cm(2 * Math.max(-lo[0], hi[0]) + 60), d: cm(2 * Math.max(-lo[1], hi[1]) + 60), h: cm(hi[2] + 30) };
for (const k of ['w', 'd', 'h']) await page.$eval(`input[data-k="${k}"]`, (e, v) => { e.value = v; e.dispatchEvent(new Event('input')); }, sz[k]);
console.log(`box ${sz.w}×${sz.d}×${sz.h} cm (object ${((hi[0] - lo[0]) / 10).toFixed(1)}×${((hi[1] - lo[1]) / 10).toFixed(1)}×${(hi[2] / 10).toFixed(1)} cm)`);
await page.screenshot({ path: 'test/out/ui-ar-size.png' });
await page.click('#arGo');
const t0 = Date.now();
// walk: one step of the path every 0.5 s
const seen = new Set();
for (let i = 0; i < n; i++) {
    await page.evaluate((i) => { window.__xr.index = i; }, i);
    await page.waitForTimeout(500);
    seen.add(await hint());
}
console.log('3. hints while walking:', [...seen].join(' | '));
console.log('   counter:', await page.textContent('#arCount'), 'frames,', await page.textContent('#arCov'), '% covered; camera reads', await page.evaluate(() => window.__xr.texReads));
await page.screenshot({ path: 'test/out/ui-ar-scan.png' });
await page.waitForFunction(() => !document.querySelector('#arDone').disabled, null, { timeout: 10000 });
await page.click('#arDone');
const res = await Promise.race([
    page.waitForSelector('.viewer-screen', { timeout: 1800000 }).then(() => 'viewer'),
    page.waitForSelector('.error-box', { timeout: 1800000 }).then(async () => 'error: ' + await page.textContent('.error-box')),
]);
clearInterval(mem);
const secs = (Date.now() - t0) / 1000;
console.log(`4. result: ${res} in ${secs.toFixed(1)} s after Start (walk ${(n * 0.5).toFixed(0)} s)`);
for (const l of logs) console.log('  ' + l);
if (res === 'viewer') {
    await page.waitForTimeout(2500);
    console.log('   stats:', await page.textContent('#stats'), '|', await page.textContent('#note'));
    await page.screenshot({ path: 'test/out/ui-ar-viewer.png' });
}
console.log(`peak renderer RSS ≈ ${peak.toFixed(0)} MB`);
await browser.close();
process.exit(res === 'viewer' ? 0 : 1);
