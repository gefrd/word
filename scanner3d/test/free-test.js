// In-page driver for the markerless tests (see run-free.mjs).
import { buildMarkerlessModel, frameFeatures, PROFILES } from '/src/markerless.js';
import { loadRMBG, segmentObject, segmentCrop } from '/src/rmbg.js';
import { reconstructWithMasks } from '/src/reconstruct.js';
import { poseErrors, gridIoU, gridIoUScaleFit, hollowEmpty } from './eval-util.js';
import { labelMask, objectThumb, fixMasks } from '/src/markerless.js';

async function decode(url, w, h) {
    const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, w, h);
    return x.getImageData(0, 0, w, h).data;
}

// Imitate a monocular depth network from the true depth: relative inverse
// depth with unknown scale and offset, low resolution, blurred edges, a
// smooth warp and noise. (The real Depth Anything is used in the app.)
async function fakeNetworkDepth(url, w, h, seed, fw, fh) {
    // decode at native size: packed bytes must not be interpolated
    const d = await decode(url, fw, fh);
    const dW = 182, dH = Math.round(182 * h / w / 14) * 14 || 98;
    let rng = 1000 + seed * 77;
    const rnd = () => { rng = (rng * 16807) % 2147483647; return rng / 2147483647; };
    const inv = new Float32Array(dW * dH);
    let far = Infinity;
    for (let y = 0; y < dH; y++) for (let x = 0; x < dW; x++) {
        const px = Math.min(fw - 1, Math.floor((x + 0.5) * fw / dW)), py = Math.min(fh - 1, Math.floor((y + 0.5) * fh / dH)), i = (py * fw + px) * 4;
        const z = (d[i] * 65536 + d[i + 1] * 256 + d[i + 2]) / 16777215 * 4000;
        inv[y * dW + x] = z > 1 ? 1 / z : 0;
        if (z > 1) far = Math.min(far, 1 / z);
    }
    for (let i = 0; i < inv.length; i++) if (!inv[i]) inv[i] = far * 0.6; // background: farther
    // blur (the network is smooth at depth edges)
    const bl = new Float32Array(inv.length);
    for (let y = 0; y < dH; y++) for (let x = 0; x < dW; x++) {
        let s = 0, n = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < dW && yy < dH) { s += inv[yy * dW + xx]; n++; } }
        bl[y * dW + x] = s / n;
    }
    const a = 300 + rnd() * 900, b = rnd() * 0.5, ph = rnd() * 6;
    const depth = new Float32Array(inv.length);
    for (let y = 0; y < dH; y++) for (let x = 0; x < dW; x++) {
        const warp = 1 + 0.03 * Math.sin(x / dW * 3 + ph) * Math.cos(y / dH * 2 + ph);
        depth[y * dW + x] = a * bl[y * dW + x] * warp * (1 + (rnd() - 0.5) * 0.02) + b;
    }
    return { depth, dW, dH, trueFit: { a: 1 / a, b: -b / a, spread: 0.01 } };
}

window.runFree = async (o = {}) => {
    const T = {}, t = () => performance.now();
    let t0 = t();
    const prof = PROFILES[o.profile || 'mid'];
    const nFr = o.n || 30;
    const depthIdx = o.depth ? Array.from({ length: o.depthViews || 8 }, (_, k) => Math.floor((k + 0.5) * nFr / (o.depthViews || 8))) : null;
    const data = o.mode === 'turntable'
        ? window.renderTurntable(nFr, { masks: o.masks === 'gt', depthIdx, ...o.render })
        : window.renderWalk(nFr, { masks: o.masks === 'gt', depthIdx, ...o.render });
    T.render = t() - t0;
    const s = prof.featSide / Math.max(data.width, data.height);
    const w = Math.round(data.width * s), h = Math.round(data.height * s);
    if (o.masks !== 'gt') {
        t0 = t();
        await loadRMBG({ url: '/test/models/briaai/RMBG-1.4/onnx/model_quantized.onnx', wasmPaths: '/node_modules/onnxruntime-web/dist/' });
        T.loadModel = t() - t0;
    }
    const frames = [];
    const res0 = [];
    T.mask = 0; T.features = 0;
    const maskIoU = [];
    for (const fr of data.frames) {
        const rgba = await decode(fr.url, w, h);
        let prob;
        t0 = t();
        if (o.masks === 'gt') {
            const m = await decode(fr.mask, w, h);
            prob = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) prob[i] = m[i * 4];
        } else {
            prob = await segmentObject(rgba, w, h, o.segSide || prof.segSide);
        }
        T.mask += t() - t0;
        if (o.compareMasks && fr.mask) { /* filled below when both exist */ }
        t0 = t();
        const feat = frameFeatures(rgba, w, h, prob, { maxFeatures: prof.maxFeatures });
        T.features += t() - t0;
        const entry = { feat, prob, thumb: objectThumb(rgba, w, h, prob) };
        if (fr.depth) entry.depth = await fakeNetworkDepth(fr.depth, w, h, frames.length, data.width, data.height);
        frames.push(entry);
    }
    if (o.masks !== 'gt' && o.fixMasks !== false) {
        t0 = t();
        const logs0 = [];
        await fixMasks(frames, w, h, {
            getRGBA: (i) => decode(data.frames[i].url, w, h),
            segmentCrop: (rgba, ww, hh, box) => segmentCrop(rgba, ww, hh, box, o.segSide || prof.segSide),
            maxFeatures: prof.maxFeatures, log: (m) => logs0.push(m),
        });
        T.fixMasks = t() - t0;
        res0.push(...logs0);
    }
    // mask quality vs ground truth (needs a second render with masks)
    if (o.masks !== 'gt' && o.maskEval) {
        const gtData = o.mode === 'turntable' ? window.renderTurntable(o.n || 30, { masks: true, ...o.render }) : window.renderWalk(o.n || 30, { masks: true, ...o.render });
        for (let k = 0; k < frames.length; k++) {
            const m = await decode(gtData.frames[k].mask, w, h);
            let a = 0, u = 0;
            for (let i = 0; i < w * h; i++) { if (frames[k].noVote && frames[k].noVote[i]) continue; const g = m[i * 4] > 127, e = frames[k].prob[i] >= 110; if (g && e) a++; if (g || e) u++; }
            maskIoU.push(a / u);
        }
    }
    const logs = [];
    if (o.dumpPair) {
        const { matchFeatures } = await import('/src/features.js');
        const [i, j] = o.dumpPair;
        const m = matchFeatures(frames[i].feat, frames[j].feat, { maxDist: 64, ratio: 0.85 });
        return { dump: { m: Array.from(m), fi: { x: Array.from(frames[i].feat.x), y: Array.from(frames[i].feat.y), level: Array.from(frames[i].feat.level) }, fj: { x: Array.from(frames[j].feat.x), y: Array.from(frames[j].feat.y) },
            Pi: { R: data.frames[i].R, t: data.frames[i].t }, Pj: { R: data.frames[j].R, t: data.frames[j].t }, f: data.f * s, w, h, urlI: data.frames[i].url, urlJ: data.frames[j].url } };
    }
    const getFrame = async (i, side) => {
        const ss = side / Math.max(data.width, data.height);
        const ww = Math.round(data.width * ss), hh = Math.round(data.height * ss);
        return { rgba: await decode(data.frames[i].url, ww, hh), width: ww, height: hh };
    };
    t0 = t();
    let out = null, err = null;
    try {
        out = await buildMarkerlessModel({ frames, width: w, height: h, getFrame }, {
            gridRes: o.gridRes || prof.gridRes, colorSide: prof.colorSide, log: (m) => logs.push(m), sfm: o.sfm || {}, similarK: o.similarK ?? 2,
            field: o.field, recrop: o.masks === 'gt' || o.norecrop ? null : async (i, box) => segmentCrop(await decode(data.frames[i].url, w, h), w, h, box, o.segSide || prof.segSide), refine: o.refine, colourRefine: o.colour, colourThreshold: o.colourT, texture: !!o.texture,
        });
    } catch (e) { err = e.message + (e.stats ? ' ' + JSON.stringify(e.stats) : ''); }
    T.reconstruct = t() - t0;
    logs.unshift(...res0);
    const res = { T, logs, err, featCounts: frames.map(f => f.feat.n), maskIoU };
    const gtPoses = data.frames.map(fr => ({ R: fr.R, t: fr.t }));
    const gtBox = window.gtBox();
    if (out) {
        const pe = poseErrors(out.poses, gtPoses);
        res.pose = { ...pe, align: undefined, scale: pe.align.s };
        // ground plane and up axis of the estimated object frame vs truth
        const A = pe.align;
        res.groundErrMm = A.t[2] / A.s;          // where the true ground (z=0) lands, in true mm
        res.upErrDeg = Math.acos(Math.min(1, A.R[8])) * 180 / Math.PI;
        res.fEst = out.f / s; res.fGT = data.f;
        res.registered = out.registered.length;
        res.info = out.info;
        res.iou = gridIoU(out.grid, pe.align, window.gtInside, gtBox, o.evalStep || 3);
        res.iouShape = gridIoUScaleFit(out.grid, pe.align, window.gtInside, gtBox, o.evalStep || 4);
        res.verts = out.positions.length / 3;
        // the mug's inside (a hollow silhouettes can't see)
        if (new URLSearchParams(location.search).get('obj') === 'mug') {
            const pts = [];
            for (let z = 15; z < 88; z += 4) for (let y = -28; y <= 28; y += 4) for (let x = -28; x <= 28; x += 4) if (Math.hypot(x, y) < 28) pts.push([x, y, z]);
            res.hollow = hollowEmpty(out.grid, pe.align, pts);
        }
        res.mesh = o.keepMesh ? { positions: Array.from(out.positions), indices: Array.from(out.indices), colors: Array.from(out.colors) } : null;
        if (out.textured && o.keepMesh) {
            const a = out.textured.atlas, c = document.createElement('canvas'); c.width = a.width; c.height = a.height;
            c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(a.data.buffer), a.width, a.height), 0, 0);
            res.texMesh = { positions: Array.from(out.textured.positions), indices: Array.from(out.textured.indices), uvs: Array.from(out.textured.uvs), tex: c.toDataURL('image/jpeg', 0.85) };
        }
    }
    if (o.groundCheck) {
        const { createCarver } = await import('/src/reconstruct.js');
        const { estimateGround } = await import('/src/markerless.js');
        const labels = frames.map(fr => labelMask(fr.prob, w, h, {}, fr.noVote));
        const [lo, hi] = gtBox;
        const views = gtPoses.map((p, k) => ({ R: p.R, t: p.t, f: data.f * s, width: w, height: h, mask: labels[k] }));
        for (const res of [56, 90, 130]) {
            const b = { x0: lo[0] - 20, x1: hi[0] + 20, y0: lo[1] - 20, y1: hi[1] + 20, z0: -60, z1: hi[2] + 20 };
            const c = createCarver({ bounds: b, voxel: Math.max(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0) / res, bgFrac: 0.08, keepFrac: 0.2 });
            for (const v of views) c.addView(v);
            const g = estimateGround(c.finish(), views);
            logs.push(`GT-pose ground check res ${res}: pcts ${g && g.pcts} (true 0)`);
        }
    }
    // Upper bound: same masks, ground-truth poses (mask error only)
    if (o.gtPoseCheck) {
        const labels = frames.map(fr => labelMask(fr.prob, w, h, {}, fr.noVote));
        const [lo, hi] = gtBox;
        const pad = 15;
        const bounds = { x0: lo[0] - pad, x1: hi[0] + pad, y0: lo[1] - pad, y1: hi[1] + pad, z0: 0, z1: hi[2] + pad };
        const vox = Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0, bounds.z1) / (o.gridRes || prof.gridRes);
        const r2 = await reconstructWithMasks({
            count: frames.length, getFrame, getMask: async (k) => ({ mask: labels[k], width: w, height: h }),
            poses: gtPoses, f: data.f * s, fullWidth: w, fullHeight: h,
        }, { bounds, voxel: vox, bgFrac: 0.08, keepFrac: 0.15, skipBg: 5, colorSide: 480, refineGrid: o.depth ? async (grid) => {
            const { depthCarve, erodeForeground, fitDepthToShape } = await import('/src/refine.js');
            const dv = [];
            frames.forEach((fr, k) => { if (fr.depth) { const v = { ...fr.depth, R: gtPoses[k].R, t: gtPoses[k].t, f: data.f * s, width: w, height: h, mask: erodeForeground(labels[k], w, h, 4) }; v.fit = o.trueFit ? fr.depth.trueFit : fitDepthToShape(grid, v, []); if (v.fit) dv.push(v); } });
            logs.push('GT-pose fits: ' + JSON.stringify(dv.map(v => [+(v.fit.spread).toFixed(3), +(v.fit.a / v.trueFit.a).toFixed(3)])));
            logs.push('GT-pose depth carve removed ' + depthCarve(grid, dv, { minViews: 2 }));
        } : null });
        if (new URLSearchParams(location.search).get('obj') === 'mug') {
            const pts = [];
            for (let z = 15; z < 88; z += 4) for (let y = -28; y <= 28; y += 4) for (let x = -28; x <= 28; x += 4) if (Math.hypot(x, y) < 28) pts.push([x, y, z]);
            res.hollowGT = hollowEmpty(r2.grid, { s: 1, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, pts);
        }
        res.iouGTPoses = gridIoU(r2.grid, { s: 1, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, window.gtInside, gtBox, o.evalStep || 3);
    }
    return res;
};
window.testReady = true;
