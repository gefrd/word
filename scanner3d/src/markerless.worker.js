// No-sheet scan worker: everything heavy runs here, off the main thread.
//
// Messages in:
//   { cmd: 'config', profile, modelUrl?, wasmPaths? }
//   { cmd: 'add', index, blob }        a frame (JPEG/PNG blob); processed in
//                                      order as soon as it arrives, so a live
//                                      scan gets its masks while you walk
//   { cmd: 'solve', opts }             build the model from all frames
// Messages out:
//   { type: 'progress', stage, p, detail? }
//   { type: 'added', index, coverage, features }
//   { type: 'done', positions, indices, normals, colors, info }
//   { type: 'error', message, code? }

import { loadRMBG, segmentObject, releaseRMBG } from './rmbg.js';
import { frameFeatures, buildMarkerlessModel, objectThumb, PROFILES } from './markerless.js';

let profile = PROFILES.mid, cfg = {};
const frames = [];      // { blob, feat, prob, thumb }
let size = null;        // feature/mask image size shared by all frames
let queue = Promise.resolve();
let canvas = null, ctx = null;

// iOS < 16.4 has no OffscreenCanvas in workers: the page decodes for us.
const HAS_OFFSCREEN = typeof OffscreenCanvas !== 'undefined';
const waiting = new Map();
let reqId = 0;
function requestFrame(index, side, fixed) {
    return new Promise((resolve, reject) => {
        const id = ++reqId;
        waiting.set(id, { resolve, reject });
        post({ type: 'need', id, index, side, w: fixed && fixed.w, h: fixed && fixed.h });
    });
}

async function decode(index, blob, longSide, fixed) {
    if (!HAS_OFFSCREEN) return requestFrame(index, longSide, fixed);
    const bmp = await createImageBitmap(blob);
    let w, h;
    if (fixed) { w = fixed.w; h = fixed.h; }
    else {
        const s = Math.min(1, longSide / Math.max(bmp.width, bmp.height));
        w = Math.max(1, Math.round(bmp.width * s)); h = Math.max(1, Math.round(bmp.height * s));
    }
    if (!canvas) { canvas = new OffscreenCanvas(w, h); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(bmp, 0, 0, w, h);
    const ar = bmp.width / bmp.height;
    bmp.close();
    return { rgba: ctx.getImageData(0, 0, w, h).data, width: w, height: h, ar };
}

const post = (m, t) => self.postMessage(m, t || []);

async function ensureModel() {
    await loadRMBG({
        url: cfg.modelUrl, wasmPaths: cfg.wasmPaths,
        onProgress: (p) => post({ type: 'progress', stage: 'download', p }),
    });
}

async function addFrame(index, blob) {
    await ensureModel();
    const fr = await decode(index, blob, profile.featSide, size);
    if (!size) size = { w: fr.width, h: fr.height, ar: fr.ar };
    else if (Math.abs(fr.ar - size.ar) > 0.02) { post({ type: 'added', index, skipped: true }); return; } // rotated phone / other camera
    const prob = await segmentObject(fr.rgba, fr.width, fr.height, profile.segSide);
    let cov = 0;
    for (let i = 0; i < prob.length; i++) if (prob[i] >= 110) cov++;
    cov /= prob.length;
    const feat = frameFeatures(fr.rgba, fr.width, fr.height, prob, { maxFeatures: profile.maxFeatures });
    frames[index] = { index, blob, feat, prob, thumb: objectThumb(fr.rgba, fr.width, fr.height, prob), coverage: cov };
    post({ type: 'added', index, coverage: cov, features: feat.n });
}

async function solve(opts = {}) {
    await queue;
    const list = frames.filter(Boolean);
    if (list.length < 8) throw Object.assign(new Error('TOO_FEW_FRAMES'), { code: 'TOO_FEW_FRAMES' });
    const bad = list.filter(f => f.coverage < 0.004).length;
    if (bad > list.length / 2) throw Object.assign(new Error('NO_OBJECT'), { code: 'NO_OBJECT' });
    // The AI model is not needed any more: free its memory before carving.
    if (opts.lowMemory) await releaseRMBG();
    const { w, h } = size;
    const getFrame = async (i, side) => {
        const fr = await decode(list[i].index, list[i].blob, side);
        return { rgba: fr.rgba, width: fr.width, height: fr.height };
    };
    const out = await buildMarkerlessModel({ frames: list, width: w, height: h, getFrame }, {
        gridRes: profile.gridRes, colorSide: profile.colorSide, similarK: opts.unordered ? 4 : 2,
        sfm: { f0: opts.f0 ? opts.f0 * Math.max(w, h) : undefined },
        onProgress: (stage, p) => post({ type: 'progress', stage, p }),
        log: (m) => post({ type: 'log', message: m }),
    });
    const { positions, indices, normals, colors } = out;
    const info = { ...out.info, registered: out.registered.length, frames: list.length };
    post({ type: 'done', positions, indices, normals, colors, info }, [positions.buffer, indices.buffer, normals.buffer, colors.buffer]);
}

self.onmessage = (e) => {
    const m = e.data;
    if (m.cmd === 'config') {
        profile = PROFILES[m.profile] || PROFILES.mid;
        cfg = { modelUrl: m.modelUrl, wasmPaths: m.wasmPaths };
        // start the model download/compile right away
        queue = queue.then(() => ensureModel()).catch((err) => post({ type: 'error', message: err.message || String(err), code: 'MODEL' }));
        return;
    }
    if (m.cmd === 'frame') {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (w) m.error ? w.reject(new Error(m.error)) : w.resolve({ rgba: m.rgba, width: m.width, height: m.height, ar: m.ar });
        return;
    }
    if (m.cmd === 'add') {
        queue = queue.then(() => addFrame(m.index, m.blob)).catch((err) => post({ type: 'error', message: err.message || String(err), code: 'FRAME' }));
        return;
    }
    if (m.cmd === 'solve') {
        solve(m.opts).catch((err) => post({ type: 'error', message: err.message || String(err), code: err.code || err.message }));
    }
};
