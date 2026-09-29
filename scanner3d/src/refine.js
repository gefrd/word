// Refining the carved volume beyond what silhouettes can see.
//
// A silhouette never shows a hollow (the inside of a cup, the gap between a
// toy's arm and its body), so pure silhouette carving leaves those filled.
// Two extra cues remove such volume:
//   • depth: a depth map (AI, relative scale) fitted to the sparse 3D points
//     of that view says "the surface is this far away here" — voxels clearly
//     in front of it are empty;
//   • colour: a point on the real surface looks the same from every camera
//     that sees it; a voxel floating in front of the surface projects onto
//     different places of the object in different views and gets mixed
//     colours → it is carved (space carving, Kutulakos & Seitz 2000).
// Both are conservative: small margins, several agreeing views, and a
// safety stop if a pass wants to remove too much (bad lighting, reflections).

import { FOREGROUND, BACKGROUND } from './reconstruct.js';

const cam = (v) => {
    const { R, t } = v;
    return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
};

/** Occupied voxels with at least one empty 6-neighbour, plus outward normals. */
function surfaceVoxels(grid) {
    const { occ, nx, ny, nz } = grid, sxy = nx * ny;
    const idx = [], nrm = [];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const n = k * sxy + j * nx + i;
        if (!occ[n]) continue;
        let gx = 0, gy = 0, gz = 0;
        if (i === 0 || !occ[n - 1]) gx -= 1;
        if (i === nx - 1 || !occ[n + 1]) gx += 1;
        if (j === 0 || !occ[n - nx]) gy -= 1;
        if (j === ny - 1 || !occ[n + nx]) gy += 1;
        if (k > 0 && !occ[n - sxy]) gz -= 1;            // the bottom rests on the ground: never "open" downwards
        if (k === nz - 1 || !occ[n + sxy]) gz += 1;
        if (!gx && !gy && !gz) continue;
        const l = Math.hypot(gx, gy, gz);
        idx.push(n); nrm.push(gx / l, gy / l, gz / l);
    }
    return { idx: Int32Array.from(idx), nrm: Float32Array.from(nrm) };
}

function voxelCentre(grid, n) {
    const { nx, ny, origin, voxel } = grid;
    const i = n % nx, j = ((n / nx) | 0) % ny, k = (n / (nx * ny)) | 0;
    return [origin[0] + (i + 0.5) * voxel, origin[1] + (j + 0.5) * voxel, origin[2] + (k + 0.5) * voxel];
}

/** Per-view z-buffer of the current surface (low resolution), for visibility. */
function zBuffers(grid, surf, views) {
    return views.map((v) => {
        const W = v.zw, H = v.zh, s = W / v.width;
        const zb = new Float32Array(W * H).fill(Infinity);
        const f = v.f * s, cx = W / 2, cy = H / 2, R = v.R, t = v.t;
        for (let q = 0; q < surf.idx.length; q++) {
            const X = voxelCentre(grid, surf.idx[q]);
            const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
            if (z <= 1) continue;
            const u = f * (R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0]) / z + cx, w = f * (R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1]) / z + cy;
            const r = Math.max(1, Math.ceil(0.6 * grid.voxel * f / z)); // voxel footprint
            const x0 = Math.max(0, (u | 0) - r), x1 = Math.min(W - 1, (u | 0) + r), y0 = Math.max(0, (w | 0) - r), y1 = Math.min(H - 1, (w | 0) + r);
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (z < zb[y * W + x]) zb[y * W + x] = z;
        }
        return zb;
    });
}

// ---------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------

/**
 * Fit metric depth to a relative AI depth map: 1/z ≈ a·d + b, robustly,
 * from the sparse 3D points seen in that view. Returns { a, b, spread }
 * (spread = typical relative depth error) or null.
 */
export function fitDepth(view, pts) {
    const { depth, dW, dH, R, t, f, width, height } = view;
    const S = [];
    for (const X of pts) {
        const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
        if (z <= 1) continue;
        const u = f * (R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0]) / z + width / 2, v = f * (R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1]) / z + height / 2;
        const du = u / width * dW - 0.5, dv = v / height * dH - 0.5;
        if (du < 1 || dv < 1 || du > dW - 2 || dv > dH - 2) continue;
        S.push([sampleF(depth, dW, du, dv), 1 / z]);
    }
    if (S.length < 12) return null;
    // IRLS on 1/z = a·d + b (Cauchy weights)
    let a = 0, b = 0, w = S.map(() => 1);
    for (let it = 0; it < 8; it++) {
        let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        S.forEach(([d, y], k) => { const q = w[k]; sw += q; sx += q * d; sy += q * y; sxx += q * d * d; sxy += q * d * y; });
        const det = sw * sxx - sx * sx;
        if (Math.abs(det) < 1e-18) return null;
        a = (sw * sxy - sx * sy) / det; b = (sy - a * sx) / sw;
        const res = S.map(([d, y]) => Math.abs((a * d + b) - y) / y);
        const med = [...res].sort((p, q) => p - q)[res.length >> 1] || 1e-3;
        w = res.map(r => 1 / (1 + (r / (2 * med + 1e-4)) ** 2));
    }
    if (!(a > 0)) return null; // AI depth must grow with nearness
    const rel = S.map(([d, y]) => Math.abs(1 / (a * d + b) - 1 / y) * y).sort((p, q) => p - q);
    return { a, b, spread: rel[Math.floor(rel.length * 0.68)] };
}

function sampleF(a, w, x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
    // 0 = "no depth here" (dense-stereo maps): never blend it in
    if (!(a[i] > 0 && a[i + 1] > 0 && a[i + w] > 0 && a[i + w + 1] > 0)) return 0;
    return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + w] * (1 - fx) + a[i + w + 1] * fx) * fy;
}

/**
 * Remove voxels that at least `minViews` depth maps see clearly in front of
 * the visible surface. Returns the number removed.
 */
export function depthCarve(grid, depthViews, opts = {}) {
    const { occ, nx, ny, nz, voxel } = grid;
    const votes = new Uint8Array(occ.length);
    // hitRatio: many noisy maps (a phone's depth sensor) — a voxel that other
    // maps see right on the surface ("hits") is kept unless the "empty"
    // votes outnumber them hitRatio to one
    const hits = opts.hitRatio ? new Uint8Array(occ.length) : null;
    const perView = [];
    for (const v of depthViews) {
        let tested = 0, cast = 0;
        const { depth, dW, dH, R, t, f, width, height, fit, mask } = v;
        const margin = (z) => Math.max(2 * voxel, z * Math.max(0.012, 1.5 * fit.spread));
        for (let n = 0; n < occ.length; n++) {
            if (!occ[n]) continue;
            const X = voxelCentre(grid, n);
            const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
            if (z <= 1) continue;
            const u = f * (R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0]) / z + width / 2, q = f * (R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1]) / z + height / 2;
            const ui = u | 0, qi = q | 0;
            if (ui < 0 || qi < 0 || ui >= width || qi >= height) continue;
            // only well inside the object: depth is blurry at its outline
            if (mask[qi * width + ui] !== FOREGROUND) continue;
            const du = u / width * dW - 0.5, dv = q / height * dH - 0.5;
            if (du < 1 || dv < 1 || du > dW - 2 || dv > dH - 2) continue;
            const inv = fit.a * sampleF(depth, dW, du, dv) + fit.b + (fit.c || 0) * ((du + 0.5) / dW - 0.5) + (fit.e || 0) * ((dv + 0.5) / dH - 0.5);
            if (!(inv > 0)) continue;
            const zs = 1 / inv;
            tested++;
            const mz = margin(zs);
            if (z < zs - mz) { if (votes[n] < 255) { votes[n]++; cast++; } }
            else if (hits && z <= zs + mz && hits[n] < 255) hits[n]++;
        }
        perView.push([tested, cast, +fit.spread.toFixed(3)]);
    }
    if (opts.log) opts.log(`depth views [tested, votes, spread]: ${JSON.stringify(perView)}`);
    let removed = 0;
    const minViews = opts.minViews ?? 2, hitRatio = opts.hitRatio;
    for (let n = 0; n < occ.length; n++) if (occ[n] && votes[n] >= minViews && !(hits && votes[n] < hitRatio * hits[n])) { occ[n] = 0; removed++; }
    void nx; void ny; void nz;
    return removed;
}

/**
 * Fit the AI depth of one view to the carved shape itself: where the shape
 * is already tight (most of the outside), its front surface is the true
 * surface. Model 1/z ≈ a·d + b + c·x + e·y (the linear terms absorb a gentle
 * tilt in the AI depth); Cauchy-weighted least squares ignores hollows,
 * which only ever make the true surface farther than the shape's.
 * extraPts: known surface points (sparse 3D) with extra weight.
 */
export function fitDepthToShape(grid, view, extraPts = []) {
    const { depth, dW, dH, R, t, f, width, height, mask } = view;
    const surf = surfaceVoxels(grid);
    const zb = zBuffers(grid, surf, [{ ...view, zw: dW, zh: dH }])[0];
    const rows = [];
    for (let y = 1; y < dH - 1; y++) for (let x = 1; x < dW - 1; x++) {
        const z = zb[y * dW + x];
        if (!isFinite(z)) continue;
        const mx = Math.min(width - 1, Math.floor((x + 0.5) * width / dW)), my = Math.min(height - 1, Math.floor((y + 0.5) * height / dH));
        if (mask[my * width + mx] !== FOREGROUND) continue;
        rows.push([depth[y * dW + x], x / dW - 0.5, y / dH - 0.5, 1 / z, 1]);
    }
    for (const X of extraPts) {
        const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
        if (z <= 1) continue;
        const u = f * (R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0]) / z + width / 2, v = f * (R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1]) / z + height / 2;
        const du = u / width * dW - 0.5, dv = v / height * dH - 0.5;
        if (du < 1 || dv < 1 || du > dW - 2 || dv > dH - 2) continue;
        rows.push([sampleF(depth, dW, du, dv), (du + 0.5) / dW - 0.5, (dv + 0.5) / dH - 0.5, 1 / z, 5]);
    }
    if (rows.length < 40) return null;
    let p = [0, 0, 0, 0], w = rows.map(r => r[4]);
    for (let it = 0; it < 10; it++) {
        // weighted normal equations for [a, b, c, e]
        const A = new Float64Array(16), g = new Float64Array(4);
        rows.forEach((r, k) => {
            const q = [r[0], 1, r[1], r[2]], wk = w[k];
            for (let i = 0; i < 4; i++) { g[i] += wk * q[i] * r[3]; for (let j = 0; j < 4; j++) A[i * 4 + j] += wk * q[i] * q[j]; }
        });
        // no tilt terms: over a small object they mimic its own depth slope
        // and steal the scale — fit only a and b
        for (let i = 2; i < 4; i++) { for (let j = 0; j < 4; j++) { A[i * 4 + j] = 0; A[j * 4 + i] = 0; } A[i * 4 + i] = 1; g[i] = 0; }
        for (let i = 0; i < 4; i++) A[i * 4 + i] += 1e-12;
        const sol = solve4(A, g);
        if (!sol) return null;
        p = sol;
        // signed relative error of the predicted nearness; hollows can only
        // be farther than the shape (negative), so those are let go quickly
        const res = rows.map(r => (p[0] * r[0] + p[1] + p[2] * r[1] + p[3] * r[2] - r[3]) / r[3]);
        const sd = 1.4826 * ([...res].map(Math.abs).sort((x, y) => x - y)[res.length >> 1] || 1e-3) + 1e-4;
        w = res.map((e, k) => rows[k][4] * (e < -sd ? 1 / (1 + (e / sd) ** 4) : 1 / (1 + (e / (2 * sd)) ** 2)));
    }
    if (!(p[0] > 0)) return null;
    // spread from the side hollows can't reach (AI surface nearer than the shape)
    const pos = rows.map(r => (1 / r[3] - 1 / (p[0] * r[0] + p[1] + p[2] * r[1] + p[3] * r[2])) * r[3]).filter(e => e > 0).sort((x, y) => x - y);
    if (pos.length < 20) return null;
    return { a: p[0], b: p[1], c: p[2], e: p[3], spread: pos[Math.floor(pos.length * 0.68)] };
}

// ---------------------------------------------------------------------
// Metric depth from the phone (ARCore depth API via WebXR "depth-sensing")
// ---------------------------------------------------------------------

// (same as flipImage in markerless.js, which imports this file)
function flipped(a, w, h, flip) {
    if (flip === 'none') return a;
    const fx = flip === 'x' || flip === 'xy', fy = flip === 'y' || flip === 'xy';
    const out = new a.constructor(a.length);
    for (let y = 0; y < h; y++) {
        const sy = fy ? h - 1 - y : y;
        for (let x = 0; x < w; x++) out[y * w + x] = a[sy * w + (fx ? w - 1 - x : x)];
    }
    return out;
}

/**
 * Drop depth pixels on a depth edge (a cup's rim against its inside): the
 * phone's map is smooth there, a mix of near and far that is neither, and
 * would cut into the rim. Edges are found on a lightly smoothed copy (the
 * raw map is noisy) and widened by r pixels. Returns a copy.
 */
function dropDepthEdges(depth, w, h, rel = 0.02, r = 1) {
    const sm = new Float32Array(depth.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const v = depth[yy * w + xx];
            if (v > 0) { s += v; n++; }
        }
        sm[y * w + x] = depth[y * w + x] > 0 && n >= 3 ? s / n : 0;
    }
    const edge = new Uint8Array(depth.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, q = sm[i];
        if (!(q > 0)) continue;
        // (inverse depth: a relative step is the same as for depth)
        if ((x > 0 && sm[i - 1] > 0 && Math.abs(sm[i - 1] - q) > rel * q) || (y > 0 && sm[i - w] > 0 && Math.abs(sm[i - w] - q) > rel * q)) {
            edge[i] = 1; if (x > 0) edge[i - 1] = 1; if (y > 0) edge[i - w] = 1;
        }
    }
    const out = new Float32Array(depth.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!(depth[i] > 0)) continue;
        let near = false;
        for (let dy = -r; dy <= r && !near; dy++) for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && edge[yy * w + xx]) { near = true; break; }
        }
        if (!near) out[i] = depth[i];
    }
    return out;
}

/**
 * Check one phone depth map against the carved shape. The map is metric
 * and shares its scale with the phone's own tracking (the poses), so it is
 * not re-fitted — a fit would be pulled by the very hollows we are after.
 * The shape's front surface can only be nearer than (or on) the true
 * surface, so where the phone says "nearer than the shape" that is noise:
 * its size gives the margin. A map that is mostly "nearer" is misaligned
 * or wrong and is not used. Returns { a: 1, b: 0, spread, bad, ok } or null
 * (too little of the object in the map to tell).
 */
function checkMetricView(grid, v, surf, opts = {}) {
    const { depth, dW, dH, width, height, mask } = v;
    const zb = zBuffers(grid, surf, [{ ...v, zw: dW, zh: dH }])[0];
    const res = [];
    for (let py = 1; py < dH - 1; py++) for (let px = 1; px < dW - 1; px++) {
        const z = zb[py * dW + px], q = depth[py * dW + px];
        if (!isFinite(z) || !(q > 0)) continue;
        const mx = Math.min(width - 1, Math.floor((px + 0.5) * width / dW)), my = Math.min(height - 1, Math.floor((py + 0.5) * height / dH));
        if (mask[my * width + mx] !== FOREGROUND) continue;
        res.push(q * z - 1);        // > 0: the phone sees the surface nearer than the shape
    }
    if (res.length < 30) return null;
    const pos = res.filter(e => e > 0).sort((p, q) => p - q);
    const spread = pos.length >= 10 ? pos[Math.floor(pos.length * 0.68)] : 0.004;
    const bad = res.filter(e => e > 0.08).length / res.length;
    return { a: 1, b: 0, spread, bad, ok: spread <= (opts.maxSpread ?? 0.05) && bad <= (opts.maxBad ?? 0.15) };
}

/**
 * How well a depth map fits the floor (object frame z = 0) where the mask
 * says background: median relative error, or null (too little floor seen).
 * Unlike the object, the floor is never symmetric in the picture — its
 * distance grows towards the top of the view — so a map read upside down
 * fails this clearly.
 */
function floorError(v) {
    const { depth, dW, dH, R, t, f, width, height, label } = v;
    if (!label) return null;
    const C = cam(v), errs = [];
    for (let py = 0; py < dH; py += 2) for (let px = 0; px < dW; px += 2) {
        const q = depth[py * dW + px];
        if (!(q > 0)) continue;
        const u = (px + 0.5) * width / dW, w = (py + 0.5) * height / dH;
        if (label[Math.min(height - 1, w | 0) * width + Math.min(width - 1, u | 0)] !== BACKGROUND) continue;
        // ray (camera z = 1) in the object frame; where it meets z = 0
        const dx = (u - width / 2) / f, dy = (w - height / 2) / f;
        const rz = R[2] * dx + R[5] * dy + R[8];
        if (rz >= -1e-3) continue;
        const lam = -C[2] / rz;
        if (!(lam > 0 && lam < 2500)) continue;
        errs.push(Math.abs(q * lam - 1));
    }
    if (errs.length < 40) return null;
    errs.sort((a, b) => a - b);
    return errs[errs.length >> 1];
}

/**
 * Get the phone's depth maps ready for depthCarve.
 *   items: [{ frame, depth (Float32 1/mm, 0 = none), dW, dH, R, t, f, width, height,
 *             mask (eroded object), label (mask labels, for the floor check) }]
 * The map orientation is checked on a few views rather than assumed (the
 * spec says top-left origin; a browser that disagrees must not ruin the
 * model). Returns { views, flip, rejected, spread }.
 */
export function prepareMetricDepth(grid, items, opts = {}) {
    const surf = surfaceVoxels(grid);
    items = items.map(v => ({ ...v, depth: dropDepthEdges(v.depth, v.dW, v.dH) }));
    const step = Math.max(1, Math.floor(items.length / 8));
    const sample = items.filter((_, k) => k % step === 0).slice(0, 8);
    // score: the floor around the object (clear-cut), else noise + share of
    // impossible ("nearer than the shape") pixels on the object
    const score = {};
    for (const flip of ['none', 'y', 'x', 'xy']) {
        const sc = sample.map(v => {
            const fv = { ...v, depth: flipped(v.depth, v.dW, v.dH, flip) };
            const fe = floorError(fv);
            if (fe != null) return fe;
            const q = checkMetricView(grid, fv, surf, opts);
            return q ? q.spread + q.bad : 1;
        }).sort((p, q) => p - q);
        score[flip] = sc.length ? sc[sc.length >> 1] : 1;
    }
    // stay with the documented reading unless another one is clearly better
    let flip = 'none';
    for (const k of ['y', 'x', 'xy']) if (score[k] < 0.6 * score[flip]) flip = k;
    const views = [];
    let rejected = 0;
    for (const v of items) {
        const depth = flipped(v.depth, v.dW, v.dH, flip);
        const fit = checkMetricView(grid, { ...v, depth }, surf, opts);
        if (fit && fit.ok) views.push({ ...v, depth, fit }); else rejected++;
    }
    const sp = views.map(v => v.fit.spread).sort((p, q) => p - q);
    if (opts.log) opts.log(`phone depth: orientation ${flip} (${Object.entries(score).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ')}), ${views.length} maps used, ${rejected} rejected`);
    return { views, flip, rejected, spread: sp.length ? sp[sp.length >> 1] : null };
}

function solve4(A, b) {
    const M = Array.from({ length: 4 }, (_, i) => [A[i * 4], A[i * 4 + 1], A[i * 4 + 2], A[i * 4 + 3], b[i]]);
    for (let c = 0; c < 4; c++) {
        let piv = c;
        for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        if (Math.abs(M[piv][c]) < 1e-30) return null;
        [M[c], M[piv]] = [M[piv], M[c]];
        for (let r = 0; r < 4; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let j = c; j < 5; j++) M[r][j] -= k * M[c][j]; }
    }
    return M.map((row, i) => row[4] / row[i]);
}

/** Mask pixels well inside the object (eroded by r). */
export function erodeForeground(label, w, h, r) {
    let m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = label[i] === FOREGROUND ? 1 : 0;
    for (let it = 0; it < r; it++) {
        const o = m.slice();
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (m[i] && (!m[i - 1] || !m[i + 1] || !m[i - w] || !m[i + w])) o[i] = 0;
        }
        m = o;
    }
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = m[i] ? FOREGROUND : 0;
    return out;
}

// ---------------------------------------------------------------------
// Colour (space carving)
// ---------------------------------------------------------------------

/**
 * Photo-consistency carving of the surface, layer by layer.
 *   views: [{ R, t, f, width, height, rgb (Uint8 3/px, lightly blurred), gain [r,g,b] }]
 * Returns { removed, passes, stopped }.
 */
export function colourCarve(grid, views, opts = {}) {
    const { occ } = grid;
    const T = opts.threshold ?? 24, maxPasses = opts.passes ?? 8;
    const total0 = occ.reduce((s, v) => s + v, 0);
    const Cs = views.map(cam);
    let removed = 0, passes = 0, stopped = '';
    const zs = views.map(v => ({ ...v, zw: Math.min(v.width, 200), zh: Math.round(Math.min(v.width, 200) * v.height / v.width) }));
    for (; passes < maxPasses; passes++) {
        const surf = surfaceVoxels(grid);
        if (!surf.idx.length) break;
        const zb = zBuffers(grid, surf, zs);
        const kill = [];
        const col = new Float32Array(views.length * 3), wt = new Float32Array(views.length);
        for (let q = 0; q < surf.idx.length; q++) {
            const n = surf.idx[q];
            const X = voxelCentre(grid, n);
            if (X[2] < grid.origin[2] + 2.5 * grid.voxel) continue; // contact with the ground: shadows
            const nX = surf.nrm[3 * q], nY = surf.nrm[3 * q + 1], nZ = surf.nrm[3 * q + 2];
            let m = 0;
            for (let k = 0; k < views.length; k++) {
                const v = views[k], C = Cs[k];
                let dx = C[0] - X[0], dy = C[1] - X[1], dz = C[2] - X[2];
                const d = Math.hypot(dx, dy, dz); dx /= d; dy /= d; dz /= d;
                const facing = dx * nX + dy * nY + dz * nZ;
                if (facing < 0.3) continue;
                const R = v.R, t = v.t;
                const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
                if (z <= 1) continue;
                const u = v.f * (R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0]) / z + v.width / 2, w = v.f * (R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1]) / z + v.height / 2;
                if (u < 1 || w < 1 || u >= v.width - 2 || w >= v.height - 2) continue;
                // visible? (nothing of the current surface clearly in front)
                const zv = zs[k], s = zv.zw / v.width;
                const zbv = zb[k][Math.min(zv.zh - 1, (w * s) | 0) * zv.zw + Math.min(zv.zw - 1, (u * s) | 0)];
                if (z > zbv + 1.8 * grid.voxel) continue;
                const x0 = Math.floor(u - 0.5), y0 = Math.floor(w - 0.5), fx = u - 0.5 - x0, fy = w - 0.5 - y0, i = (y0 * v.width + x0) * 3, W3 = v.width * 3;
                for (let c = 0; c < 3; c++) {
                    const val = (v.rgb[i + c] * (1 - fx) + v.rgb[i + 3 + c] * fx) * (1 - fy) + (v.rgb[i + W3 + c] * (1 - fx) + v.rgb[i + W3 + 3 + c] * fx) * fy;
                    col[m * 3 + c] = val * v.gain[c];
                }
                wt[m] = facing;
                m++;
            }
            if (m < 3) continue;
            // mean and spread, dropping the single most different view
            const spread = (skip) => {
                let sw = 0, r = 0, g = 0, b = 0;
                for (let a = 0; a < m; a++) if (a !== skip) { sw += wt[a]; r += col[a * 3] * wt[a]; g += col[a * 3 + 1] * wt[a]; b += col[a * 3 + 2] * wt[a]; }
                r /= sw; g /= sw; b /= sw;
                let e = 0, worst = -1, we = -1;
                for (let a = 0; a < m; a++) {
                    if (a === skip) continue;
                    const d2 = (col[a * 3] - r) ** 2 + (col[a * 3 + 1] - g) ** 2 + (col[a * 3 + 2] - b) ** 2;
                    e += d2 * wt[a];
                    if (d2 > we) { we = d2; worst = a; }
                }
                return [Math.sqrt(e / sw / 3), worst];
            };
            let [sd, worst] = spread(-1);
            if (m >= 4) sd = spread(worst)[0];
            if (sd > T) kill.push(n);
        }
        // safety: a pass that wants to strip a big part of the whole surface
        // means the colours can't be trusted (lighting, reflections)
        if (kill.length > surf.idx.length * (opts.maxPassFrac ?? 0.25)) { stopped = 'too much in one pass'; break; }
        if (removed + kill.length > total0 * (opts.maxTotalFrac ?? 0.35)) { stopped = 'total limit'; break; }
        for (const n of kill) occ[n] = 0;
        removed += kill.length;
        if (kill.length < surf.idx.length * 0.002) { passes++; break; }
    }
    return { removed, passes, stopped, total0 };
}

/** Downscale + light blur to RGB, and per-view colour gains (auto exposure / white balance). */
export function prepColourViews(frames, labels) {
    const med = (a) => { const s = Float32Array.from(a).sort(); return s.length ? s[s.length >> 1] : 1; };
    const meds = frames.map((fr, k) => {
        const { rgba, width: w, height: h } = fr, lab = labels[k];
        const r = [], g = [], b = [];
        for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
            const li = Math.min(lab.height - 1, Math.floor(y * lab.height / h)) * lab.width + Math.min(lab.width - 1, Math.floor(x * lab.width / w));
            if (lab.mask[li] !== FOREGROUND) continue;
            const i = (y * w + x) * 4; r.push(rgba[i]); g.push(rgba[i + 1]); b.push(rgba[i + 2]);
        }
        return [med(r), med(g), med(b)];
    });
    const all = [0, 1, 2].map(c => med(meds.map(m => m[c])));
    return frames.map((fr, k) => {
        const { rgba, width: w, height: h } = fr;
        const rgb = new Uint8Array(w * h * 3);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            // 3×3 box blur: less aliasing and sensor noise
            let r = 0, g = 0, b = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = Math.min(h - 1, Math.max(0, y + dy));
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = Math.min(w - 1, Math.max(0, x + dx)), i = (yy * w + xx) * 4;
                    r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
                }
            }
            const o = (y * w + x) * 3;
            rgb[o] = r / n; rgb[o + 1] = g / n; rgb[o + 2] = b / n;
        }
        const gain = [0, 1, 2].map(c => Math.min(1.6, Math.max(0.6, all[c] / Math.max(1, meds[k][c]))));
        return { rgb, gain, width: w, height: h };
    });
}
