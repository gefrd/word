// Kivu 3D Scan — app shell and flows.
import './style.css';
import { t, applyI18n } from './i18n.js';
import { boardSVG } from './board.js';
import { sheetPDF } from './sheet-pdf.js';
import { LiveCapture, BANDS, SECTORS, solveKeyframes, keyframesFromVideo, keyframesFromPhotos, framesFromVideo, framesFromPhotos, LiveFreeCapture } from './capture.js';
import { MarkerlessJob } from './markerless-client.js';
import { arCaptureSupported, arBlockedByFrame } from './arsupport.js';
import { scanVolume } from './reconstruct.js';
import { projectPoint } from './geometry.js';
import { downloadBlob } from './download.js';
// three.js (~600 KB) loads only when a 3D view is opened, keeping the first
// screen light on slow mobile data.
const lazyExport = () => import('./export.js');
const lazyViewer = () => import('./viewer.js');
import { saveModel, listModels, getModel, deleteModel } from './storage.js';

const app = document.getElementById('app');

// ---------------------------------------------------------------------
// Device profile: one app, settings scaled to the phone.
// ---------------------------------------------------------------------
const PROFILE = (() => {
    const mem = navigator.deviceMemory;
    const cores = navigator.hardwareConcurrency || 4;
    let tier = 'mid';
    if (typeof mem === 'number') tier = mem <= 2 ? 'low' : mem <= 4 ? 'mid' : 'high';
    else if (cores >= 6 && /iPhone|iPad|Mac/.test(navigator.userAgent)) tier = 'mid';
    const P = {
        low: { keyframeSide: 1280, detectSide: 480, maskSide: 480, colorSide: 720, voxel: 2.5, photoGrid: 110, photoSide: 768 },
        mid: { keyframeSide: 1280, detectSide: 640, maskSide: 640, colorSide: 960, voxel: 2.0, photoGrid: 150, photoSide: 1024 },
        high: { keyframeSide: 1600, detectSide: 640, maskSide: 800, colorSide: 1280, voxel: 1.6, photoGrid: 200, photoSide: 1024 },
    }[tier];
    return { tier, mem, cores, ...P };
})();

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function el(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
}
function show(node) {
    cleanupScreen();
    app.replaceChildren(node);
    applyI18n(node);
    window.scrollTo(0, 0);
}
let screenCleanup = null;
function cleanupScreen() {
    if (screenCleanup) { try { screenCleanup(); } catch (_) {} screenCleanup = null; }
}
function toast(msg, ms = 2600) {
    const n = el(`<div class="toast" role="status"></div>`);
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), ms);
}
function pickFiles(accept, multiple = false, capture = null) {
    return new Promise((resolve) => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = accept; inp.multiple = multiple;
        if (capture) inp.setAttribute('capture', capture);
        inp.onchange = () => resolve([...(inp.files || [])]);
        inp.click();
    });
}
const ICON = {
    logo: `<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><rect x="1" y="1" width="32" height="32" rx="9" fill="#232730" stroke="#2e333d"/><path d="M17 7l9 5v10l-9 5-9-5V12z" fill="none" stroke="#ff8a3d" stroke-width="2" stroke-linejoin="round"/><path d="M8 12l9 5 9-5M17 17v10" fill="none" stroke="#ff8a3d" stroke-width="2" stroke-linejoin="round"/></svg>`,
    ring: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="16" rx="9" ry="4"/><path d="M12 3v9M9 6l3-3 3 3"/></svg>`,
    photo: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/></svg>`,
    cube: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>`,
    back: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>`,
    sheet: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="14" height="18" rx="2"/><rect x="7.5" y="5.5" width="3" height="3"/><rect x="13.5" y="15.5" width="3" height="3"/></svg>`,
    torch: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>`,
};

// ---------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------
async function home() {
    const tierLabel = { low: 'tierLow', mid: 'tierMid', high: 'tierHigh' }[PROFILE.tier];
    const node = el(`
    <div class="screen"><div class="page">
      <div class="topbar">
        <div class="brand">${ICON.logo}<h1 data-i18n="appTitle"></h1></div>
      </div>
      <p class="muted" data-i18n="tagline"></p>
      <span class="device-chip">${t('device')}: <b>${PROFILE.mem ? PROFILE.mem + ' GB' : '—'} · ${PROFILE.cores} CPU</b> · ${t(tierLabel)}</span>

      <section class="mode featured">
        <div class="mode-head"><span class="glyph">${ICON.ring}</span>
          <div><span class="tag" data-i18n="freeTag"></span><h3 data-i18n="freeTitle"></h3><p class="muted small" data-i18n="freeDesc"></p></div>
        </div>
        <div class="ar-offer" id="arRow" hidden>
          <div class="btn-row"><button class="btn primary" id="freeAR" data-i18n="arStart"></button></div>
          <p class="muted small" data-i18n="arDesc"></p>
        </div>
        <div class="btn-row"><button class="btn primary" id="freeLive" data-i18n="startLive"></button></div>
        <div class="btn-row">
          <button class="btn" id="freeVideo" data-i18n="fromVideo"></button>
          <button class="btn" id="freePhotos" data-i18n="fromPhotos"></button>
        </div>
        <details class="how">
          <summary data-i18n="freeHow"></summary>
          <ul class="tips small"><li data-i18n="freeTip1"></li><li data-i18n="freeTip2"></li><li data-i18n="freeTip3"></li><li data-i18n="freeTip4"></li><li data-i18n="freeTip5"></li><li data-i18n="freeTip6"></li></ul>
          <p class="muted small" data-i18n="freeModelNote"></p>
        </details>
        <label class="check small"><input type="checkbox" id="refine"> <span data-i18n="refineToggle"></span></label>
      </section>

      <section class="mode">
        <div class="mode-head"><span class="glyph">${ICON.sheet}</span>
          <div><span class="tag">360° · exact size</span><h3 data-i18n="scan360Title"></h3><p class="muted small" data-i18n="scan360Desc"></p></div>
        </div>
        <div class="btn-row">
          <button class="btn" id="live" data-i18n="startLive"></button>
          <button class="btn" id="sheet" data-i18n="getSheet"></button>
        </div>
        <div class="btn-row">
          <button class="btn" id="video" data-i18n="fromVideo"></button>
          <button class="btn" id="photos" data-i18n="fromPhotos"></button>
        </div>
      </section>

      <section class="mode">
        <div class="mode-head"><span class="glyph">${ICON.photo}</span>
          <div><span class="tag">AI</span><h3 data-i18n="photoTitle"></h3><p class="muted small" data-i18n="photoDesc"></p></div>
        </div>
        <div class="btn-row">
          <button class="btn" id="takePhoto" data-i18n="takePhoto"></button>
          <button class="btn" id="pickPhoto" data-i18n="pickPhoto"></button>
        </div>
      </section>

      <section class="mode">
        <div class="mode-head"><span class="glyph">${ICON.cube}</span>
          <div><h3 data-i18n="demoTitle"></h3><p class="muted small" data-i18n="demoDesc"></p></div>
        </div>
        <div class="btn-row"><button class="btn" id="demo" data-i18n="openDemo"></button></div>
      </section>

      <section style="display:flex;flex-direction:column;gap:10px">
        <h2 data-i18n="myModels"></h2>
        <div class="models" id="models"><p class="muted small" data-i18n="noModels"></p></div>
      </section>
      <footer class="note" data-i18n="installHint"></footer>
    </div></div>`);
    const refineBox = node.querySelector('#refine');
    try { refineBox.checked = localStorage.getItem('k3d-refine') === '1'; } catch (_) {}
    refineBox.onchange = () => { try { localStorage.setItem('k3d-refine', refineBox.checked ? '1' : '0'); } catch (_) {} };
    node.querySelector('#freeLive').onclick = () => freeLive();
    node.querySelector('#freeVideo').onclick = async () => { const [f] = await pickFiles('video/*'); if (f) freeFromVideo(f); };
    node.querySelector('#freePhotos').onclick = async () => { const fs = await pickFiles('image/*', true); if (fs.length) freeFromPhotos(fs); };
    node.querySelector('#live').onclick = () => liveScan();
    node.querySelector('#sheet').onclick = () => sheetScreen();
    node.querySelector('#video').onclick = async () => { const [f] = await pickFiles('video/*'); if (f) fromVideo(f); };
    node.querySelector('#photos').onclick = async () => { const fs = await pickFiles('image/*', true); if (fs.length) fromPhotos(fs); };
    node.querySelector('#takePhoto').onclick = async () => { const [f] = await pickFiles('image/*', false, 'environment'); if (f) photoTo3D(f); };
    node.querySelector('#pickPhoto').onclick = async () => { const [f] = await pickFiles('image/*'); if (f) photoTo3D(f); };
    node.querySelector('#demo').onclick = () => openDemo();
    show(node);
    renderSaved(node.querySelector('#models'));
    // AR scan with the live box: Android Chrome with ARCore only
    const arRow = node.querySelector('#arRow');
    if (arBlockedByFrame()) {
        // embedded without xr permission: open the app as a full page for AR
        arRow.hidden = false;
        node.querySelector('#freeAR').onclick = () => window.open(location.href.split('#')[0] + '#ar', '_blank');
    } else {
        arCaptureSupported().then((ok) => {
            if (!ok || !node.isConnected) return;
            arRow.hidden = false;
            node.querySelector('#freeAR').onclick = () => freeAR();
        });
    }
}

async function renderSaved(container) {
    const models = await listModels();
    if (!models.length) return;
    container.replaceChildren();
    for (const m of models) {
        const card = el(`<div class="model-card"><img alt=""><div class="meta"><b></b><span class="muted"></span><div class="row"><button class="btn">${t('open')}</button><button class="btn ghost">${t('deleteModel')}</button></div></div></div>`);
        card.querySelector('img').src = m.thumb || '';
        card.querySelector('b').textContent = m.name;
        card.querySelector('.muted').textContent = new Date(m.created).toLocaleDateString();
        const [openBtn, delBtn] = card.querySelectorAll('button');
        openBtn.onclick = async () => {
            const rec = await getModel(m.id);
            const mesh = await loadGLB(rec.glb);
            viewerScreen({ mesh, name: rec.name, kind: rec.kind, saved: true });
        };
        delBtn.onclick = async () => {
            if (delBtn.dataset.confirm) { await deleteModel(m.id); card.remove(); return; }
            delBtn.dataset.confirm = '1'; delBtn.textContent = '✓ ?';
        };
        container.appendChild(card);
    }
}

// ---------------------------------------------------------------------
// Marker sheet
// ---------------------------------------------------------------------
function sheetScreen() {
    const node = el(`
    <div class="screen"><div class="page">
      <div class="topbar"><button class="icon-btn" id="back" aria-label="${t('back')}">${ICON.back}</button><h2 data-i18n="sheetTitle"></h2></div>
      <p class="muted small" data-i18n="sheetHelp"></p>
      <div class="btn-row">
        <button class="btn primary" id="pdf" data-i18n="downloadPdf"></button>
        <button class="btn" id="full" data-i18n="fullscreenSheet"></button>
      </div>
      <div class="sheet-preview">${boardSVG()}</div>
      <h3 data-i18n="tipsTitle"></h3>
      <ol class="tips small"><li data-i18n="tip1"></li><li data-i18n="tip2"></li><li data-i18n="tip3"></li><li data-i18n="tip4"></li></ol>
    </div></div>`);
    node.querySelector('#back').onclick = home;
    node.querySelector('#pdf').onclick = () => downloadBlob(sheetPDF(), 'kivu-3d-scan-sheet-A4.pdf');
    node.querySelector('#full').onclick = async () => {
        const full = el(`<div class="sheet-full">${boardSVG()}</div>`);
        full.onclick = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); full.remove(); };
        document.body.appendChild(full);
        try { await full.requestFullscreen(); } catch (_) {}
        try { await navigator.wakeLock.request('screen'); } catch (_) {}
    };
    show(node);
}

// ---------------------------------------------------------------------
// Live 360° scan
// ---------------------------------------------------------------------
async function liveScan() {
    const node = el(`
    <div class="scan">
      <video playsinline muted></video>
      <canvas class="overlay"></canvas>
      <div class="flash"></div>
      <div class="hud-top">
        <button class="icon-btn" id="back" aria-label="${t('back')}">${ICON.back}</button>
        <div class="hint" id="hint">…</div>
        <button class="icon-btn" id="torch" aria-label="torch">${ICON.torch}</button>
      </div>
      <div class="hud-bottom">
        <svg class="dome" id="dome" viewBox="-54 -54 108 108"></svg>
        <button class="shutter" id="shot" aria-label="capture"></button>
        <div class="done-col">
          <div class="count"><span id="count">0</span> ${t('shots')}</div>
          <button class="btn primary" id="done" disabled data-i18n="done"></button>
        </div>
      </div>
    </div>`);
    show(node);
    const video = node.querySelector('video');
    const overlay = node.querySelector('canvas.overlay');
    const octx = overlay.getContext('2d');
    const hintEl = node.querySelector('#hint');
    const dome = node.querySelector('#dome');
    const flash = node.querySelector('.flash');
    let wakeLock = null;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}

    const cap = new LiveCapture(video, {
        longSide: PROFILE.keyframeSide,
        detectSide: PROFILE.detectSide,
        onUpdate: (s) => drawHud(s),
        onKeyframe: () => { flash.classList.add('on'); setTimeout(() => flash.classList.remove('on'), 60); if (navigator.vibrate) navigator.vibrate(15); },
    });
    screenCleanup = () => { cap.stop(); if (wakeLock) wakeLock.release().catch(() => {}); };
    node.querySelector('#back').onclick = () => home();
    let torch = false;
    node.querySelector('#torch').onclick = async () => { torch = !torch; if (!(await cap.toggleTorch(torch))) torch = false; };
    node.querySelector('#shot').onclick = () => cap.manualShot();
    node.querySelector('#done').onclick = () => {
        const kfs = cap.keyframes.slice();
        cap.stop();
        processScan(kfs);
    };

    try {
        await cap.start();
    } catch (e) {
        hintEl.textContent = t('cameraError');
        hintEl.className = 'hint warn';
        return;
    }
    const vol = scanVolume({ zMax: 140 });
    drawDome(dome, cap.coverage, null);

    function drawHud(s) {
        const cw = overlay.clientWidth, ch = overlay.clientHeight;
        if (overlay.width !== cw * devicePixelRatio) { overlay.width = cw * devicePixelRatio; overlay.height = ch * devicePixelRatio; }
        octx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        octx.clearRect(0, 0, cw, ch);
        // object-fit: cover mapping from video pixels to screen
        const sc = Math.max(cw / s.videoW, ch / s.videoH);
        const ox = (cw - s.videoW * sc) / 2, oy = (ch - s.videoH * sc) / 2;
        const map = (p) => [p[0] * sc + ox, p[1] * sc + oy];
        octx.lineWidth = 2;
        octx.strokeStyle = '#4cc38a';
        for (let i = 0; i < s.det.ids.length; i++) {
            octx.beginPath();
            for (let k = 0; k < 4; k++) { const [x, y] = map(s.det.image[i * 4 + k]); k ? octx.lineTo(x, y) : octx.moveTo(x, y); }
            octx.closePath(); octx.stroke();
        }
        if (s.pose && cap.f) {
            // scan volume box, so people keep the object inside it
            const P = (X) => map(projectPoint(s.pose.R, s.pose.t, cap.f, s.videoW / 2, s.videoH / 2, X));
            const c = [];
            for (const z of [0, vol.z1]) for (const [x, y] of [[vol.x0, vol.y0], [vol.x1, vol.y0], [vol.x1, vol.y1], [vol.x0, vol.y1]]) c.push(P([x, y, z]));
            octx.strokeStyle = 'rgba(255,138,61,0.9)'; octx.setLineDash([6, 5]);
            const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
            octx.beginPath();
            for (const [a, b] of edges) { octx.moveTo(...c[a]); octx.lineTo(...c[b]); }
            octx.stroke(); octx.setLineDash([]);
        }
        // guidance text
        let key = s.hint, cls = 'warn';
        if (!key) {
            const cov = s.coverage;
            const counts = [0, 1, 2].map(b => cov.bandCount(b));
            const band = s.angles ? BANDS.findIndex(b => s.angles.el >= b.min && s.angles.el < b.max) : -1;
            if (cov.count() >= 26) { key = 'hint_enough'; cls = 'good'; }
            else if (band >= 0 && counts[band] >= SECTORS - 1) {
                const need = counts.findIndex(c => c < SECTORS - 3);
                key = need === 0 ? 'hint_needLow' : need === 1 ? 'hint_needMid' : need === 2 ? 'hint_needHigh' : 'hint_enough';
                cls = key === 'hint_enough' ? 'good' : '';
            } else { key = 'hint_good'; cls = 'good'; }
        } else key = 'hint_' + key;
        hintEl.textContent = t(key);
        hintEl.className = 'hint ' + cls;
        node.querySelector('#count').textContent = s.count;
        node.querySelector('#done').disabled = s.count < 10;
        drawDome(dome, s.coverage, s.angles);
    }
}

/** Coverage "dome": rings = height bands (outer = low), sectors = directions. */
function drawDome(svg, coverage, angles) {
    const radii = [[38, 52], [24, 37], [10, 23]];
    let s = '<circle r="53" fill="rgba(18,20,24,0.72)"/>';
    for (let b = 0; b < 3; b++) {
        const [r0, r1] = radii[b];
        for (let k = 0; k < SECTORS; k++) {
            const a0 = (k / SECTORS) * Math.PI * 2 - Math.PI / 2, a1 = ((k + 1) / SECTORS) * Math.PI * 2 - Math.PI / 2 - 0.05;
            const p = (r, a) => `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`;
            const fill = coverage.filled(b, k) ? '#4cc38a' : 'rgba(255,255,255,0.14)';
            s += `<path d="M${p(r0, a0)}L${p(r1, a0)}A${r1},${r1} 0 0 1 ${p(r1, a1)}L${p(r0, a1)}A${r0},${r0} 0 0 0 ${p(r0, a0)}Z" fill="${fill}"/>`;
        }
    }
    if (angles) {
        const b = BANDS.findIndex(x => angles.el >= x.min && angles.el < x.max);
        const r = b < 0 ? (angles.el < BANDS[0].min ? 53 : 5) : (radii[b][0] + radii[b][1]) / 2;
        const a = (angles.az / 360) * Math.PI * 2 - Math.PI / 2;
        s += `<circle cx="${(r * Math.cos(a)).toFixed(1)}" cy="${(r * Math.sin(a)).toFixed(1)}" r="5" fill="#ff8a3d" stroke="#fff" stroke-width="1.5"/>`;
    }
    svg.innerHTML = s;
}

// ---------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------
function processingScreen(stages) {
    const node = el(`
    <div class="screen"><div class="page">
      <div class="progress-wrap">
        <h2 data-i18n="processing"></h2>
        <div class="bar"><i></i></div>
        <ul class="stages">${stages.map(s => `<li data-stage="${s}">${t('stage_' + s)}</li>`).join('')}</ul>
        <p class="muted small mono" id="detail"></p>
        <div id="err"></div>
      </div>
    </div></div>`);
    show(node);
    const bar = node.querySelector('.bar > i');
    return {
        set(stage, p, detail) {
            const idx = stages.indexOf(stage);
            node.querySelectorAll('.stages li').forEach((li, i) => { li.className = i < idx ? 'done' : i === idx ? 'active' : ''; });
            const total = (idx + Math.min(1, Math.max(0, p || 0))) / stages.length;
            bar.style.width = (total * 100).toFixed(1) + '%';
            node.querySelector('#detail').textContent = detail || '';
        },
        error(msg, actions = []) {
            const box = el(`<div class="error-box"></div>`);
            box.textContent = `${t('errorPrefix')}: ${msg}`;
            const row = el(`<div class="btn-row" style="margin-top:12px"></div>`);
            for (const a of actions) { const b = el(`<button class="btn primary"></button>`); b.textContent = a.label; b.onclick = a.run; row.appendChild(b); }
            const back = el(`<button class="btn">${t('back')}</button>`);
            back.onclick = home;
            row.appendChild(back);
            node.querySelector('#err').replaceChildren(box, row);
        },
    };
}

async function fromVideo(file) {
    const ui = processingScreen(['video', 'pose', 'segment', 'carve', 'mesh', 'color']);
    try {
        const kfs = await keyframesFromVideo(file, {
            longSide: PROFILE.keyframeSide,
            onProgress: (p, s) => ui.set('video', p, `${s.cells} / ${BANDS.length * SECTORS}`),
        });
        await runReconstruction(kfs, ui);
    } catch (e) { ui.error(e.message); }
}

async function fromPhotos(files) {
    const ui = processingScreen(['photos', 'pose', 'segment', 'carve', 'mesh', 'color']);
    try {
        const kfs = await keyframesFromPhotos(files, {
            longSide: PROFILE.keyframeSide,
            onProgress: (p, s) => ui.set('photos', p, `${s.found} / ${files.length}`),
        });
        await runReconstruction(kfs, ui);
    } catch (e) { ui.error(e.message); }
}

async function processScan(keyframes) {
    const ui = processingScreen(['pose', 'segment', 'carve', 'mesh', 'color']);
    try { await runReconstruction(keyframes, ui); }
    catch (e) { ui.error(e.message); }
}

async function runReconstruction(keyframes, ui) {
    ui.set('pose', 0, `${keyframes.length} frames`);
    await new Promise(r => setTimeout(r, 30));
    let solved;
    try { solved = solveKeyframes(keyframes); }
    catch (_) { throw new Error(t('tooFew')); }
    if (solved.posed.length < 8) throw new Error(t('tooFew'));
    ui.set('pose', 1, `f = ${solved.f.toFixed(0)} px · ${solved.posed.length} views`);

    const t0 = performance.now();
    const job = {
        frames: solved.posed.map(k => k.blob),
        poses: solved.posed.map(k => ({ R: k.R, t: k.t })),
        f: solved.f, fullWidth: solved.width, fullHeight: solved.height,
        opts: { voxel: PROFILE.voxel, maskSide: PROFILE.maskSide, colorSide: PROFILE.colorSide },
    };
    const onProgress = (stage, p) => ui.set(stage === 'done' ? 'color' : stage, p, `${((performance.now() - t0) / 1000).toFixed(1)} s`);
    let result;
    if (typeof OffscreenCanvas !== 'undefined') {
        result = await reconstructInWorker(job, onProgress).catch((e) => {
            // e.g. iOS < 16.4 has no 2D OffscreenCanvas inside workers
            if (/OffscreenCanvas|getContext|not supported|undefined is not/i.test(e.message)) return null;
            throw e;
        });
    }
    if (!result) result = await reconstructOnMainThread(job, onProgress);

    const { buildMesh } = await lazyExport();
    const mesh = buildMesh({ positions: result.positions, indices: result.indices, colors: result.colors, name: 'Kivu 3D Scan' });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    viewerScreen({ mesh, name: 'Scan ' + new Date().toLocaleString(), kind: 'scan', note: `${solved.posed.length} views · ${secs} s` });
}

function reconstructInWorker(job, onProgress) {
    const worker = new Worker(new URL('./recon.worker.js', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
        worker.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'progress') onProgress(m.stage, m.p);
            else if (m.type === 'done') resolve(m);
            else reject(new Error(m.message));
        };
        worker.onerror = (e) => reject(new Error(e.message || 'Worker failed'));
        worker.postMessage(job);
    }).finally(() => worker.terminate());
}

async function reconstructOnMainThread(job, onProgress) {
    const { reconstructStreaming } = await import('./reconstruct.js');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const getFrame = async (i, side) => {
        const bmp = await createImageBitmap(job.frames[i]);
        const s = Math.min(1, side / Math.max(bmp.width, bmp.height));
        canvas.width = Math.round(bmp.width * s); canvas.height = Math.round(bmp.height * s);
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close && bmp.close();
        await new Promise(r => setTimeout(r, 0)); // let the progress bar paint
        return { rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
    };
    return reconstructStreaming({ count: job.frames.length, getFrame, poses: job.poses, f: job.f, fullWidth: job.fullWidth, fullHeight: job.fullHeight },
        { ...job.opts, onProgress });
}

// ---------------------------------------------------------------------
// No-sheet 360° scan (AI masks + structure from motion, all on the phone)
// ---------------------------------------------------------------------
const FREE_STAGES = ['download', 'mask', 'depth', 'match', 'pose', 'carve', 'refine', 'mesh', 'color', 'texture'];

function startFreeJob(ui, expected) {
    let added = 0;
    const job = new MarkerlessJob({
        profile: PROFILE.tier,
        onProgress: (stage, p) => {
            if (stage === 'download') ui && ui.set('download', p, `AI model ${Math.round(p * 100)} %`);
            else if (FREE_STAGES.includes(stage) && ui) ui.set(stage, p);
        },
        onAdded: () => { added++; if (ui) ui.set('mask', added / Math.max(1, expected()), `${added} / ${expected()}`); },
        onLog: (m) => console.log('[scan]', m),
    });
    return job;
}

async function freeMesh(r) {
    const { buildMesh } = await lazyExport();
    if (!r.textured) return buildMesh({ positions: r.positions, indices: r.indices, colors: r.colors, name: 'Kivu 3D Scan' });
    // photo texture atlas → canvas texture (saved as JPEG inside the GLB)
    const { CanvasTexture, SRGBColorSpace } = await import('three');
    const a = r.textured.atlas;
    const c = document.createElement('canvas'); c.width = a.width; c.height = a.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(a.data.buffer), a.width, a.height), 0, 0);
    const texture = new CanvasTexture(c);
    texture.colorSpace = SRGBColorSpace; texture.flipY = true; texture.anisotropy = 4;
    texture.userData.mimeType = 'image/jpeg';
    return buildMesh({ positions: r.textured.positions, indices: r.textured.indices, uvs: r.textured.uvs, texture, name: 'Kivu 3D Scan' });
}

async function finishFreeJob(job, ui, opts = {}, view = {}) {
    const t0 = performance.now();
    let refine = false;
    try { refine = localStorage.getItem('k3d-refine') === '1'; } catch (_) {}
    const r = await job.solve({ lowMemory: PROFILE.tier === 'low', refine, ...opts });
    const mesh = await freeMesh(r);
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    const cov = Math.round(r.info.coverageDeg || 0);
    // the job stays alive in the viewer: "Adjust box" rebuilds from it
    viewerScreen({ mesh, name: 'Scan ' + new Date().toLocaleString(), kind: 'free', note: `${r.info.registered}/${r.info.frames} views · ${cov}° around · ${secs} s${view.real ? ' · ' + t('arRealSize') : ''}`, sizeEdit: view.real ? 'ar' : true, job, viewBox: r.info.viewBox });
}

function freeFail(ui, e) {
    const code = e && (e.code || e.message);
    const known = t('freeFail_' + code);
    const msg = `${t('freeFailTitle')} ${known !== 'freeFail_' + code ? known : (e && e.message) || ''} ${t('freeFailTry')}`;
    ui.error(msg, [{ label: t('tryPhoto'), run: async () => { const [f] = await pickFiles('image/*'); if (f) photoTo3D(f); } }]);
}

async function freeFromVideo(file) {
    const ui = processingScreen(['frames', ...FREE_STAGES]);
    let job = null;
    try {
        const frames = await framesFromVideo(file, {
            longSide: PROFILE.keyframeSide, count: { low: 30, mid: 36, high: 40 }[PROFILE.tier],
            onProgress: (p, s) => ui.set('frames', p, `${s.frames} frames`),
        });
        if (frames.length < 8) throw Object.assign(new Error('TOO_FEW_FRAMES'), { code: 'TOO_FEW_FRAMES' });
        job = startFreeJob(ui, () => frames.length);
        for (const f of frames) job.add(f.blob);
        await finishFreeJob(job, ui, {});
    } catch (e) { if (job) job.terminate(); freeFail(ui, e); }
}

async function freeFromPhotos(files) {
    const ui = processingScreen(['photos', ...FREE_STAGES]);
    let job = null;
    try {
        const { frames, fRatio } = await framesFromPhotos(files, {
            longSide: PROFILE.keyframeSide,
            onProgress: (p, s) => ui.set('photos', p, `${s.frames} / ${files.length}`),
        });
        if (frames.length < 8) throw Object.assign(new Error('TOO_FEW_FRAMES'), { code: 'TOO_FEW_FRAMES' });
        job = startFreeJob(ui, () => frames.length);
        for (const f of frames) job.add(f.blob);
        // photos may be in any order; EXIF gives the lens focal length
        await finishFreeJob(job, ui, { unordered: true, f0: fRatio || undefined });
    } catch (e) { if (job) job.terminate(); freeFail(ui, e); }
}

async function freeLive() {
    const TARGET = 32;
    const node = el(`
    <div class="scan">
      <video playsinline muted></video>
      <div class="flash"></div>
      <div class="hud-top">
        <button class="icon-btn" id="back" aria-label="${t('back')}">${ICON.back}</button>
        <div class="hint" id="hint">…</div>
        <button class="icon-btn" id="torch" aria-label="torch">${ICON.torch}</button>
      </div>
      <div class="hud-bottom">
        <svg class="dome" id="ring" viewBox="-54 -54 108 108"></svg>
        <button class="shutter" id="shot" aria-label="capture"></button>
        <div class="done-col">
          <div class="count"><span id="count">0</span> ${t('shots')}</div>
          <div class="count" id="dl"></div>
          <button class="btn primary" id="done" disabled data-i18n="done"></button>
        </div>
      </div>
    </div>`);
    show(node);
    const video = node.querySelector('video');
    const hintEl = node.querySelector('#hint'), ring = node.querySelector('#ring'), flash = node.querySelector('.flash'), dl = node.querySelector('#dl');
    let wakeLock = null;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
    let processed = 0, count = 0, finished = false;
    const job = new MarkerlessJob({
        profile: PROFILE.tier,
        onProgress: (stage, p) => { if (stage === 'download') dl.textContent = `AI ${Math.round(p * 100)} %`; },
        onAdded: () => { processed++; },
        onLog: (m) => console.log('[scan]', m),
    });
    const drawRing = () => {
        const f = Math.min(1, count / TARGET), a = f * Math.PI * 2 - Math.PI / 2;
        const large = f > 0.5 ? 1 : 0;
        ring.innerHTML = `<circle r="53" fill="rgba(18,20,24,0.72)"/><circle r="40" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="10"/>` +
            (f > 0 ? (f >= 1 ? `<circle r="40" fill="none" stroke="#4cc38a" stroke-width="10"/>` : `<path d="M0,-40 A40,40 0 ${large} 1 ${(40 * Math.cos(a)).toFixed(1)},${(40 * Math.sin(a)).toFixed(1)}" fill="none" stroke="#ff8a3d" stroke-width="10" stroke-linecap="round"/>`) : '') +
            `<text y="6" text-anchor="middle" fill="#fff" font-size="18" font-family="monospace">${count}</text>`;
    };
    drawRing();
    const cap = new LiveFreeCapture(video, {
        longSide: PROFILE.keyframeSide, target: TARGET, max: 44,
        onFrame: (blob) => {
            job.add(blob); count++;
            flash.classList.add('on'); setTimeout(() => flash.classList.remove('on'), 60);
            if (navigator.vibrate) navigator.vibrate(15);
            drawRing();
        },
        onUpdate: (st) => {
            const key = 'hintFree_' + st.hint;
            hintEl.textContent = t(key);
            hintEl.className = 'hint ' + (st.hint === 'slow' || st.hint === 'blurry' ? 'warn' : st.hint === 'enough' || st.hint === 'shot' ? 'good' : '');
            node.querySelector('#count').textContent = st.count;
            node.querySelector('#done').disabled = st.count < 12;
        },
    });
    screenCleanup = () => { cap.stop(); if (wakeLock) wakeLock.release().catch(() => {}); if (!finished) job.terminate(); };
    node.querySelector('#back').onclick = () => home();
    let torch = false;
    node.querySelector('#torch').onclick = async () => { torch = !torch; if (!(await cap.toggleTorch(torch))) torch = false; };
    node.querySelector('#shot').onclick = () => cap.manualShot();
    node.querySelector('#done').onclick = async () => {
        finished = true;
        cap.stop();
        const ui = processingScreen(FREE_STAGES);   // (replaces the camera screen)
        ui.set('mask', processed / Math.max(1, count), `${processed} / ${count}`);
        job.opts.onProgress = (stage, p) => { if (stage === 'download') ui.set('download', p); else if (FREE_STAGES.includes(stage)) ui.set(stage, p); };
        job.opts.onAdded = () => { processed++; ui.set('mask', processed / Math.max(1, count), `${processed} / ${count}`); };
        try { await finishFreeJob(job, ui, {}); }
        catch (e) { job.terminate(); freeFail(ui, e); }
    };
    try { await cap.start(); }
    catch (e) { hintEl.textContent = t('cameraError'); hintEl.className = 'hint warn'; }
}

// AR scan: the phone tracks itself (ARCore), a box placed on the table is
// the field, every frame comes with its real position → no guessing of the
// camera path, real size. The heavy part is the same worker as above.
async function freeAR() {
    const { startARCapture } = await import('./arcapture.js');
    const overlay = el(`
    <div class="ar-ui">
      <div class="ar-panel ar-top">
        <div class="hint" id="arHint">…</div>
        <button class="icon-btn" id="arCancel" aria-label="${t('back')}">${ICON.back}</button>
      </div>
      <div class="ar-panel ar-size" id="arSizes" hidden>
        ${['w', 'd', 'h'].map(k => `<label class="slider"><span data-i18n="arSize_${k}"></span><input type="range" min="5" max="80" step="1" value="30" data-k="${k}"><b data-v="${k}">30 cm</b></label>`).join('')}
        <button class="btn primary" id="arGo" disabled data-i18n="arGo"></button>
      </div>
      <div class="ar-panel ar-bottom" id="arScanBar" hidden>
        <span class="count"><span id="arCount">0</span> ${t('shots')} · <span id="arCov">0</span> %</span>
        <button class="btn primary" id="arDone" disabled data-i18n="done"></button>
      </div>
      <div class="ar-panel ar-bottom" id="arNoCam" hidden>
        <button class="btn primary" id="arNormal" data-i18n="startLive"></button>
      </div>
    </div>`);
    applyI18n(overlay);
    document.body.appendChild(overlay);
    const $ = (q) => overlay.querySelector(q);
    const shots = [];
    // on strong phones masks are made while you walk; otherwise afterwards,
    // so the AI does not slow down the phone's own tracking
    const concurrent = PROFILE.tier === 'high';
    let processed = 0, cap = null, next = 'home';
    const job = new MarkerlessJob({
        profile: PROFILE.tier,
        onProgress: () => {},
        onAdded: () => { processed++; },
        onLog: (m) => console.log('[scan]', m),
    });
    const size = { w: 30, d: 30, h: 30 };
    overlay.querySelectorAll('input[type=range]').forEach((inp) => {
        inp.oninput = () => {
            size[inp.dataset.k] = +inp.value;
            $(`[data-v="${inp.dataset.k}"]`).textContent = inp.value + ' cm';
            if (cap) cap.setSize(size.w / 100, size.d / 100, size.h / 100);
        };
    });
    const onState = (st) => {
        const hint = $('#arHint');
        const key = st.state === 'scan' ? (st.hint || 'arWalk') : st.state === 'place' ? 'arPlace' : st.state === 'size' ? 'arSizeHint' : st.state === 'nocamera' ? 'arNoCamera' : 'arFinishing';
        hint.textContent = t(key);
        hint.className = 'hint ' + (/TooClose|TooFar|Aim|Slow|NoCamera/.test(key) ? 'warn' : key === 'arGot' ? 'good' : '');
        $('#arSizes').hidden = st.state !== 'size';
        $('#arGo').disabled = st.state !== 'size';
        $('#arScanBar').hidden = st.state !== 'scan';
        $('#arNoCam').hidden = st.state !== 'nocamera';
        $('#arCount').textContent = st.frames;
        $('#arCov').textContent = Math.round(100 * st.covered / st.sectors);
        $('#arDone').disabled = !st.canFinish;
    };
    const onFrame = (blob, meta) => {
        shots.push({ blob, meta });
        if (concurrent) job.add(blob, meta);
        if (navigator.vibrate) navigator.vibrate(12);
    };
    const onEnd = async ({ state, frames }) => {
        overlay.remove();
        if (next === 'live') { job.terminate(); freeLive(); return; }
        if (frames < 16) {
            job.terminate();
            home();
            if (state !== 'cancel') toast(t('arTooFew'), 4000);
            return;
        }
        const ui = processingScreen(FREE_STAGES);
        job.opts.onProgress = (stage, p) => { if (stage === 'download') ui.set('download', p); else if (FREE_STAGES.includes(stage)) ui.set(stage, p); };
        job.opts.onAdded = () => { processed++; ui.set('mask', processed / shots.length, `${processed} / ${shots.length}`); };
        if (!concurrent) for (const s of shots) job.add(s.blob, s.meta);
        try { await finishFreeJob(job, ui, { box: cap.box() }, { real: true }); }
        catch (e) { job.terminate(); freeFail(ui, e); }
    };
    $('#arCancel').onclick = () => { if (cap) cap.cancel(); };
    $('#arGo').onclick = () => cap && cap.start();
    $('#arDone').onclick = () => cap && cap.finish();
    $('#arNormal').onclick = () => { next = 'live'; if (cap) cap.cancel(); };
    try {
        cap = await startARCapture(overlay, { onState, onFrame, onEnd });
        cap.setSize(size.w / 100, size.d / 100, size.h / 100);
    } catch (e) {
        overlay.remove();
        job.terminate();
        console.log('[scan] AR failed', e && e.message);
        toast(t('arFail'), 4000);
    }
}

// ---------------------------------------------------------------------
// Photo → 3D (AI)
// ---------------------------------------------------------------------
async function photoTo3D(file) {
    const ui = processingScreen(['download', 'mask', 'depth', 'mesh']);
    try {
        const { loadPhoto, analyzePhoto, reliefMesh, aiDevice } = await import('./photo3d.js');
        const { buildMesh } = await lazyExport();
        const photo = await loadPhoto(file, PROFILE.photoSide);
        const ai = await analyzePhoto(photo, {}, (stage, p, m) => {
            if (stage === 'download') ui.set('download', p, m.file ? `${m.model}: ${m.file} ${Math.round(p * 100)}%` : '');
            else ui.set(stage, p, aiDevice() ? `device: ${aiDevice()}` : '');
        });
        ui.set('mesh', 0);
        const params = { grid: PROFILE.photoGrid, thickness: 0.35, heightMm: 150 };
        const build = () => {
            const r = reliefMesh(photo, ai, params);
            return buildMesh({ positions: r.positions, indices: r.indices, uvs: r.uvs, texture: r.texture, name: 'Kivu Photo 3D' });
        };
        const note = ai.depth ? t('depthNote') : t('noDepth');
        viewerScreen({ mesh: build(), name: 'Photo 3D ' + new Date().toLocaleString(), kind: 'photo', note, rebuild: { params, build } });
        if (ai.warning) console.warn(ai.warning);
    } catch (e) {
        ui.error(e.message + (/fetch|network|Failed to/i.test(e.message) ? ' — internet is needed for the first download.' : ''));
    }
}

// ---------------------------------------------------------------------
// Demo model
// ---------------------------------------------------------------------
async function loadGLB(blobOrUrl) {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    try {
        const gltf = await new GLTFLoader().loadAsync(url);
        let mesh = null;
        gltf.scene.traverse(o => { if (!mesh && o.isMesh) mesh = o; });
        if (!mesh) throw new Error('No mesh in file');
        mesh.updateWorldMatrix(true, false);
        mesh.geometry.applyMatrix4(mesh.matrixWorld);
        mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0); mesh.scale.set(1, 1, 1);
        return mesh;
    } finally {
        if (typeof blobOrUrl !== 'string') URL.revokeObjectURL(url);
    }
}

async function openDemo() {
    try {
        const mesh = await loadGLB(new URL('demo.glb', document.baseURI).href);
        viewerScreen({ mesh, name: t('demoTitle'), kind: 'demo', note: 'Reconstructed from 30 synthetic walk-around frames' });
    } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------
function meshToScanModel(mesh) {
    // three (metres, Y up) → scan units (mm, Z up) for STL/OBJ
    const g = mesh.geometry;
    const p = g.getAttribute('position');
    const positions = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
        positions[i * 3] = p.getX(i) * 1000;
        positions[i * 3 + 1] = -p.getZ(i) * 1000;
        positions[i * 3 + 2] = p.getY(i) * 1000;
    }
    let indices = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: p.count }, (_, i) => i);
    let colors = null;
    const c = g.getAttribute('color');
    if (c) {
        colors = new Float32Array(c.count * 3);
        const toS = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
        for (let i = 0; i < c.count; i++) { colors[i * 3] = toS(c.getX(i)); colors[i * 3 + 1] = toS(c.getY(i)); colors[i * 3 + 2] = toS(c.getZ(i)); }
    }
    return { positions, indices, colors };
}

async function viewerScreen({ mesh, name, kind, note, rebuild, saved, sizeEdit, job, viewBox }) {
    const [{ Viewer, arSupport, openQuickLook, startWebXR, startARLite }, { exportGLB, exportSTL, exportOBJ }] = await Promise.all([lazyViewer(), lazyExport()]);
    const node = el(`
    <div class="viewer-screen">
      <div class="viewer-canvas" id="vc">
        <div class="viewer-top">
          <button class="icon-btn" id="back" aria-label="${t('back')}">${ICON.back}</button>
          <div class="title" data-i18n="viewer"></div>
        </div>
      </div>
      <div class="viewer-panel">
        <div class="stats mono" id="stats"></div>
        ${note ? `<div class="stats" id="note"></div>` : ''}
        ${job && viewBox ? `<div class="box-edit"><button class="btn" id="boxBtn" data-i18n="adjustBox"></button><div class="box-panel" id="boxPanel" hidden>
          <p class="muted small" data-i18n="boxHelp"></p>
          <div class="sliders">
            <label data-i18n="boxFloor"></label><input type="range" data-k="z0" min="-0.3" max="0.6" step="0.01" value="0">
            <label data-i18n="boxTop"></label><input type="range" data-k="z1" min="-0.6" max="0.3" step="0.01" value="0">
            <label data-i18n="boxLeft"></label><input type="range" data-k="x0" min="-0.3" max="0.45" step="0.01" value="0">
            <label data-i18n="boxRight"></label><input type="range" data-k="x1" min="-0.45" max="0.3" step="0.01" value="0">
            <label data-i18n="boxFront"></label><input type="range" data-k="y0" min="-0.3" max="0.45" step="0.01" value="0">
            <label data-i18n="boxBack"></label><input type="range" data-k="y1" min="-0.45" max="0.3" step="0.01" value="0">
          </div>
          <div class="btn-row"><button class="btn primary" id="boxApply" data-i18n="boxRebuild"></button><button class="btn ghost" id="boxReset" data-i18n="boxResetLbl"></button></div>
        </div></div>` : ''}
        ${sizeEdit ? `<div class="size-row"><label for="len" data-i18n="realLength"></label><div class="size-in"><input id="len" type="number" inputmode="decimal" min="1" max="500" step="0.1"><button class="btn" id="applyLen" data-i18n="applySize"></button></div><p class="muted small" data-i18n="${sizeEdit === 'ar' ? 'arSizeNote' : 'freeSizeNote'}"></p></div>` : ''}
        ${rebuild ? `<div class="sliders"><label for="thick" data-i18n="thickness"></label><input type="range" id="thick" min="0.1" max="0.9" step="0.05" value="${rebuild.params.thickness}"></div>` : ''}
        <div class="btn-row">
          <button class="btn primary" id="ar" data-i18n="arView"></button>
          <button class="btn" id="arlite" data-i18n="arLite"></button>
        </div>
        <div class="export-row">
          <button class="btn" id="glb">GLB</button><button class="btn" id="stl">STL</button><button class="btn" id="obj">OBJ</button><button class="btn" id="share" data-i18n="share"></button>
        </div>
        <div class="btn-row">
          ${saved ? '' : `<button class="btn" id="save" data-i18n="save"></button>`}
          <button class="btn ghost" id="new" data-i18n="newScan"></button>
        </div>
      </div>
    </div>`);
    show(node);
    if (note) node.querySelector('#note').textContent = note;
    const viewer = new Viewer(node.querySelector('#vc'));
    let current = mesh;
    const setMesh = (m) => {
        current = m;
        const { size } = viewer.setObject(m);
        const v = m.geometry.getAttribute('position').count;
        node.querySelector('#stats').textContent = t('stats', {
            v: v.toLocaleString(), w: Math.round(size.x * 1000), d: Math.round(size.z * 1000), h: Math.round(size.y * 1000),
        });
    };
    setMesh(mesh);
    screenCleanup = () => { viewer.dispose(); if (job) job.terminate(); };

    let userScale = 1; // "real length" rescales the shown model; the box works in scan units
    if (job && viewBox) {
        const { Box3, Box3Helper, Vector3, Color } = await import('three');
        let base = { ...viewBox };
        const panel = node.querySelector('#boxPanel');
        const sliders = [...panel.querySelectorAll('input[type=range]')];
        const helper = new Box3Helper(new Box3(), new Color(0xff8a3d));
        helper.visible = false;
        viewer.scene.add(helper);
        const boxNow = () => {
            const b = { ...base }, sx = base.x1 - base.x0, sy = base.y1 - base.y0, sz = base.z1 - base.z0;
            for (const el of sliders) {
                const k = el.dataset.k, v = +el.value;
                b[k] += v * (k[0] === 'x' ? sx : k[0] === 'y' ? sy : sz);
            }
            return b;
        };
        const draw = () => {
            const b = boxNow(), k = userScale / 1000;
            // scan frame (mm, z up) → viewer (metres, y up, −y forward)
            helper.box.set(new Vector3(b.x0 * k, b.z0 * k, -b.y1 * k), new Vector3(b.x1 * k, b.z1 * k, -b.y0 * k));
        };
        node.querySelector('#boxBtn').onclick = () => {
            panel.hidden = !panel.hidden; helper.visible = !panel.hidden; viewer.controls.autoRotate = panel.hidden;
            node.querySelector('.viewer-panel').classList.toggle('boxing', !panel.hidden);
            viewer.resize && viewer.resize();
            draw();
        };
        sliders.forEach(el => { el.oninput = draw; });
        node.querySelector('#boxReset').onclick = () => { sliders.forEach(el => { el.value = 0; }); draw(); };
        node.querySelector('#boxApply').onclick = async () => {
            const btn = node.querySelector('#boxApply');
            btn.disabled = true; btn.textContent = t('boxWorking');
            try {
                const r = await job.rebuild(boxNow());
                const m = await freeMesh(r);
                if (userScale !== 1) m.geometry.scale(userScale, userScale, userScale);
                setMesh(m);
                base = { ...r.info.viewBox };
                sliders.forEach(el => { el.value = 0; });
                draw();
                toast(t('boxDone'));
            } catch (e) { toast(e.message); }
            btn.disabled = false; btn.textContent = t('boxRebuild');
        };
    }
    if (sizeEdit) {
        node.querySelector('#applyLen').onclick = () => {
            const cm = parseFloat(String(node.querySelector('#len').value).replace(',', '.'));
            if (!(cm > 0)) return;
            const g = current.geometry;
            g.computeBoundingBox();
            const b = g.boundingBox, longest = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
            if (!(longest > 0)) return;
            const k = cm / 100 / longest;
            g.scale(k, k, k);
            userScale *= k;
            g.computeBoundingBox(); g.computeBoundingSphere();
            setMesh(current);
            toast(t('sizeApplied'));
        };
    }
    if (rebuild) {
        let pending = null;
        node.querySelector('#thick').oninput = (e) => {
            rebuild.params.thickness = +e.target.value;
            clearTimeout(pending);
            pending = setTimeout(() => setMesh(rebuild.build()), 120);
        };
    }
    const safeName = (name || 'model').replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 40);
    node.querySelector('#back').onclick = home;
    node.querySelector('#new').onclick = home;
    node.querySelector('#glb').onclick = async () => downloadBlob(await exportGLB(current), safeName + '.glb');
    node.querySelector('#stl').onclick = () => downloadBlob(exportSTL(meshToScanModel(current)), safeName + '.stl');
    node.querySelector('#obj').onclick = () => downloadBlob(exportOBJ(meshToScanModel(current)), safeName + '.obj');
    node.querySelector('#share').onclick = async () => {
        const file = new File([await exportGLB(current)], safeName + '.glb', { type: 'model/gltf-binary' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try { await navigator.share({ files: [file], title: name }); } catch (_) {}
        } else downloadBlob(file, file.name);
    };
    const saveBtn = node.querySelector('#save');
    if (saveBtn) saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        try {
            const glb = await exportGLB(current);
            await saveModel({ name, glb, thumb: viewer.snapshot(), kind });
            toast(t('saved'));
        } catch (e) { toast(e.message); saveBtn.disabled = false; }
    };

    const arBtn = node.querySelector('#ar');
    const liteBtn = node.querySelector('#arlite');
    arSupport().then((sup) => {
        if (!sup.webxr && !sup.quickLook) arBtn.hidden = true;
        if (!sup.lite) liteBtn.hidden = true;
        arBtn.onclick = async () => {
            try {
                if (sup.webxr) {
                    const overlay = el(`<div class="xr-overlay"><button class="arlite-close">✕</button></div>`);
                    document.body.appendChild(overlay);
                    viewer.running = false;
                    const session = await startWebXR(current, overlay, () => { overlay.remove(); viewer.running = true; });
                    overlay.querySelector('button').onclick = () => session.end();
                } else if (sup.quickLook) {
                    await openQuickLook(current);
                }
            } catch (e) { toast(e.message); viewer.running = true; }
        };
        liteBtn.onclick = async () => {
            viewer.running = false;
            try {
                const r = await startARLite(current, document.body, () => { viewer.running = true; });
                r.hint.textContent = t('arliteHint');
            } catch (e) { toast(e.message); viewer.running = true; }
        };
    });
}

// ---------------------------------------------------------------------
document.documentElement.lang = 'en';
home();
if ('serviceWorker' in navigator && location.protocol === 'https:' && window.top === window) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
}
