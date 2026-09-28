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

import { loadRMBG, segmentObject, segmentCrop, releaseRMBG } from './rmbg.js';
import { loadDepth, estimateDepth, releaseDepth } from './depth.js';
import { frameFeatures, buildMarkerlessModel, carveInBox, objectThumb, fixMasks, PROFILES } from './markerless.js';

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
    const { w: fw, h: fh } = size;
    post({ type: 'progress', stage: 'mask', p: 1 });
    await fixMasks(list, fw, fh, {
        getRGBA: async (i) => (await decode(list[i].index, list[i].blob, 0, size)).rgba,
        segmentCrop: (rgba, w, h, box) => segmentCrop(rgba, w, h, box, profile.segSide),
        maxFeatures: profile.maxFeatures,
        log: (m) => post({ type: 'log', message: m }),
    });
    // The mask model is not needed any more: free its memory.
    if (opts.lowMemory || profile.depthViews) await releaseRMBG();
    // AI depth for a few frames spread around (helps carve hollows)
    if (opts.refine && profile.depthViews && opts.depth !== false) {
        try {
            await loadDepth({ url: cfg.depthUrl, wasmPaths: cfg.wasmPaths, onProgress: (p) => post({ type: 'progress', stage: 'download', p }) });
            const K = Math.min(profile.depthViews, list.length);
            for (let k = 0; k < K; k++) {
                const i = Math.floor((k + 0.5) * list.length / K);
                const fr = await decode(list[i].index, list[i].blob, 0, size);
                list[i].depth = await estimateDepth(fr.rgba, fw, fh, 364);
                post({ type: 'progress', stage: 'depth', p: (k + 1) / K });
            }
        } catch (err) {
            post({ type: 'log', message: 'depth skipped: ' + (err && err.message) }); // offline first run etc.: still works without
        }
        await releaseDepth();
    }
    const { w, h } = size;
    const getFrame = async (i, side) => {
        const fr = await decode(list[i].index, list[i].blob, side);
        return { rgba: fr.rgba, width: fr.width, height: fr.height };
    };
    const out = await buildMarkerlessModel({ frames: list, width: w, height: h, getFrame }, {
        gridRes: profile.gridRes, colorSide: profile.colorSide, refineSide: profile.refineSide, refine: !!opts.refine, atlasSize: profile.atlasSize, textureSide: profile.textureSide, texture: opts.texture !== false, similarK: opts.unordered ? 4 : 2,
        sfm: { f0: opts.f0 ? opts.f0 * Math.max(w, h) : undefined },
        onProgress: (stage, p) => post({ type: 'progress', stage, p }),
        log: (m) => post({ type: 'log', message: m }),
    });
    postModel(out, list.length);
}

let last = null; // what the box editor needs to rebuild: { scene, shift, frames }

function postModel(out, nFrames) {
    last = { scene: out.scene, shift: out.info.shift, frames: nFrames };
    const { positions, indices, normals, colors } = out;
    const info = { ...out.info, registered: out.registered.length, frames: nFrames };
    delete info.box;
    // the box as the viewer sees it (model frame: floor at z = 0, centred)
    const b = out.info.box, sh = out.info.shift;
    info.viewBox = out.info.fitBox || { x0: b.x0 - sh[0], x1: b.x1 - sh[0], y0: b.y0 - sh[1], y1: b.y1 - sh[1], z0: b.z0 - sh[2], z1: b.z1 - sh[2] };
    delete info.fitBox;
    const tx = out.textured;
    const msg = { type: 'done', positions, indices, normals, colors, info };
    const transfer = [positions.buffer, indices.buffer, normals.buffer, colors.buffer];
    if (tx) {
        msg.textured = { positions: tx.positions, indices: tx.indices, uvs: tx.uvs, atlas: tx.atlas };
        transfer.push(tx.positions.buffer, tx.indices.buffer, tx.uvs.buffer, tx.atlas.data.buffer);
    }
    post(msg, transfer);
}

/** Rebuild inside a box given in the viewer's model frame. */
async function rebuild(vb) {
    if (!last) throw new Error('Nothing to rebuild');
    const sh = last.shift;
    const box = { x0: vb.x0 + sh[0], x1: vb.x1 + sh[0], y0: vb.y0 + sh[1], y1: vb.y1 + sh[1], z0: vb.z0 + sh[2], z1: vb.z1 + sh[2] };
    if (!(box.x1 > box.x0 && box.y1 > box.y0 && box.z1 > box.z0)) throw new Error('Empty box');
    const out = await carveInBox(last.scene, box);
    postModel(out, last.frames);
}

self.onmessage = (e) => {
    const m = e.data;
    if (m.cmd === 'config') {
        profile = PROFILES[m.profile] || PROFILES.mid;
        cfg = { modelUrl: m.modelUrl, depthUrl: m.depthUrl, wasmPaths: m.wasmPaths };
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
    if (m.cmd === 'rebuild') {
        rebuild(m.box).catch((err) => post({ type: 'error', message: err.message || String(err), code: err.code || err.message }));
        return;
    }
    if (m.cmd === 'solve') {
        solve(m.opts).catch((err) => post({ type: 'error', message: err.message || String(err), code: err.code || err.message }));
    }
};
