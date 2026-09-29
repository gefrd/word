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
import { detectFeatures, rgbaToGray } from './features.js';
import { loadDepth, estimateDepth, releaseDepth } from './depth.js';
import { frameFeatures, buildMarkerlessModel, buildKnownPoseModel, carveInBox, objectThumb, fixMasks, detectImageFlip, flipImage, PROFILES } from './markerless.js';

let profile = PROFILES.mid, cfg = {};
const frames = [];      // { blob, feat, prob, thumb }
let size = null;        // feature/mask image size shared by all frames
let queue = Promise.resolve();
let canvas = null, ctx = null;
let flip = 'none';      // AR pictures stored mirrored/upside down (found in solve)

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
    if (!HAS_OFFSCREEN) {
        const fr = await requestFrame(index, longSide, fixed);
        if (flip !== 'none') flipImage(new Uint32Array(fr.rgba.buffer, fr.rgba.byteOffset, fr.width * fr.height), fr.width, fr.height, flip);
        return fr;
    }
    const bmp = await createImageBitmap(blob);
    let w, h;
    if (fixed) { w = fixed.w; h = fixed.h; }
    else {
        const s = Math.min(1, longSide / Math.max(bmp.width, bmp.height));
        w = Math.max(1, Math.round(bmp.width * s)); h = Math.max(1, Math.round(bmp.height * s));
    }
    if (!canvas) { canvas = new OffscreenCanvas(w, h); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const fx = flip === 'x' || flip === 'xy', fy = flip === 'y' || flip === 'xy';
    ctx.setTransform(fx ? -1 : 1, 0, 0, fy ? -1 : 1, fx ? w : 0, fy ? h : 0);
    ctx.drawImage(bmp, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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

async function addFrame(index, blob, meta) {
    await ensureModel();
    const fr = await decode(index, blob, profile.featSide, size);
    if (!size) size = { w: fr.width, h: fr.height, ar: fr.ar };
    else if (Math.abs(fr.ar - size.ar) > 0.02) { post({ type: 'added', index, skipped: true }); return; } // rotated phone / other camera
    const prob = await segmentObject(fr.rgba, fr.width, fr.height, profile.segSide);
    let cov = 0;
    for (let i = 0; i < prob.length; i++) if (prob[i] >= 110) cov++;
    cov /= prob.length;
    // AR frames come with the phone's own pose: no features needed
    const feat = meta && meta.pose ? { n: 0, x: new Float32Array(0), y: new Float32Array(0), desc: new Uint32Array(0) } : frameFeatures(fr.rgba, fr.width, fr.height, prob, { maxFeatures: profile.maxFeatures });
    frames[index] = { index, blob, feat, prob, thumb: objectThumb(fr.rgba, fr.width, fr.height, prob), coverage: cov };
    if (meta && meta.pose) {
        // f given for the image as captured; scale it to the working size
        frames[index].pose = meta.pose;
        frames[index].fWork = meta.f * fr.width / meta.imageWidth;
        // the phone's depth map (metres, view orientation) → 1/mm like the other depth maps
        if (meta.depth && meta.depth.m) {
            const m = meta.depth.m, inv = new Float32Array(m.length);
            for (let i = 0; i < m.length; i++) inv[i] = m[i] > 0 ? 1 / (m[i] * 1000) : 0;
            frames[index].arDepth = { inv, w: meta.depth.w, h: meta.depth.h };
        }
    }
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
    const known = list.length && list.every(f => f.pose);
    const fKnown = known ? list.reduce((a, f) => a + f.fWork, 0) / list.length : undefined;
    if (known) {
        // how the phone stores its camera picture: checked, not assumed —
        // matches between neighbouring frames must fit the phone's motion
        const pairs = [], feats = new Map();
        const featOf = async (i) => {
            if (!feats.has(i)) { const fr = await decode(list[i].index, list[i].blob, 0, size); feats.set(i, detectFeatures(rgbaToGray(fr.rgba, fw * fh), fw, fh, null, { maxFeatures: 600 })); }
            return feats.get(i);
        };
        const step = Math.max(1, Math.floor((list.length - 1) / 6));
        for (let i = 0; i + 1 < list.length && pairs.length < 6; i += step) pairs.push({ A: await featOf(i), B: await featOf(i + 1), poseA: list[i].pose, poseB: list[i + 1].pose });
        const d = detectImageFlip(pairs, fw, fh, fKnown);
        post({ type: 'log', message: `AR picture orientation: ${d.flip} (${Object.entries(d.scores).map(([k, v]) => k + ' ' + v.toFixed(2)).join(', ')}; ${d.matches} matches)` });
        if (d.flip !== 'none') {
            flip = d.flip;
            for (const fr of list) flipImage(fr.prob, fw, fh, flip);
        }
    }
    await fixMasks(list, fw, fh, {
        getRGBA: async (i) => (await decode(list[i].index, list[i].blob, 0, size)).rgba,
        segmentCrop: (rgba, w, h, box) => segmentCrop(rgba, w, h, box, profile.segSide),
        maxFeatures: profile.maxFeatures,
        log: (m) => post({ type: 'log', message: m }),
    });
    // (the mask model stays loaded: bad masks are redone once the field is known)
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
    const build = known ? buildKnownPoseModel : buildMarkerlessModel;
    const out = await build({ frames: list, width: w, height: h, getFrame }, {
        box: opts.box, f: fKnown,
        recrop: async (i, box) => {
            const fr = list[i];
            const rgba = (await decode(fr.index, fr.blob, 0, size)).rgba;
            return segmentCrop(rgba, fw, fh, box, profile.segSide);
        },
        // masks are final after this point: free the mask model on small phones
        afterMasks: async () => { if (opts.lowMemory) await releaseRMBG(); },
        gridRes: profile.gridRes, colorSide: profile.colorSide, refineSide: profile.refineSide, refine: !!opts.refine, mvs: opts.mvs !== false, mvsSide: profile.mvsSide, mvsPlanes: profile.mvsPlanes, atlasSize: profile.atlasSize, textureSide: profile.textureSide, texture: opts.texture !== false, similarK: opts.unordered ? 4 : 2,
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
        queue = queue.then(() => addFrame(m.index, m.blob, m.meta)).catch((err) => post({ type: 'error', message: err.message || String(err), code: 'FRAME' }));
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
