// No-sheet 360° scan: from AI object masks + features to a coloured mesh.
//
//   1. structure from motion on features inside the masks (sfm.js)
//   2. object frame: "up" from the camera ring / how the phone was held,
//      centre from the sparse points, scale from a typical arm's-length
//      camera distance (or the real size the user types in later)
//   3. coarse voxel carving to find the object's box and the ground height
//   4. fine carving + surface + colouring, reusing reconstruct.js
//
// Pure functions + one async driver; runs inside markerless.worker.js and
// in the tests.

import { reconstructWithMasks, createCarver, FOREGROUND, BACKGROUND, UNKNOWN } from './reconstruct.js';
import { runSfM, camCenter, eigenSym } from './sfm.js';
import { detectFeatures, rgbaToGray, matchFeatures } from './features.js';
import { maskStats, planMaskFixes, isStillCamera, staticPixels, smallGrey } from './maskfix.js';
import { bakeTexture, viewGains } from './texture.js';
import { gpuAvailable, planeSweep, pickNeighbours, consistencyFilter } from './mvs.js';
import { fitDepth, fitDepthToShape, depthCarve, erodeForeground, colourCarve, prepColourViews } from './refine.js';

const mul3 = (A, B) => {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return C;
};
const tr3 = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const mv3 = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const median = (v) => { const s = Float64Array.from(v).sort(); return s.length ? s[s.length >> 1] : 0; };
const pct = (v, q) => { const s = Float64Array.from(v).sort(); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] : 0; };

export const PROFILES = {
    // featSide: long side of the images used for features and carving masks
    // depthViews: frames that get an AI depth map (0 = off, saves memory/time)
    low: { featSide: 560, segSide: 320, maxFeatures: 700, gridRes: 96, colorSide: 720, depthViews: 0, refineSide: 360, atlasSize: 1024, textureSide: 960, mvsSide: 240, mvsPlanes: 56 },
    mid: { featSide: 640, segSide: 384, maxFeatures: 900, gridRes: 128, colorSide: 960, depthViews: 8, refineSide: 480, atlasSize: 2048, textureSide: 1280, mvsSide: 320, mvsPlanes: 72 },
    high: { featSide: 800, segSide: 448, maxFeatures: 1100, gridRes: 150, colorSide: 1280, depthViews: 10, refineSide: 560, atlasSize: 2048, textureSide: 1280, mvsSide: 400, mvsPlanes: 88 },
};

/** Features of one frame, only where the object mask says "object". */
export function frameFeatures(rgba, w, h, prob, opts = {}) {
    const gray = rgbaToGray(rgba, w * h);
    // Allow features slightly outside the mask edge: dilate by a few pixels.
    const allow = dilateBinary(prob, w, h, opts.maskGrow ?? 3, opts.fgThreshold ?? 110);
    return detectFeatures(gray, w, h, allow, { maxFeatures: opts.maxFeatures || 900 });
}

function dilateBinary(prob, w, h, r, thr) {
    let m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = prob[i] >= thr ? 255 : 0;
    for (let it = 0; it < r; it++) {
        const o = m.slice();
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (!m[i] && (m[i - 1] || m[i + 1] || m[i - w] || m[i + w])) o[i] = 255;
        }
        m = o;
    }
    return m;
}

/** 12×12 grey thumbnail of the object's bounding box (to find similar views among photos). */
export function objectThumb(rgba, w, h, prob) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (prob[y * w + x] >= 110) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    const T = 12, out = new Float32Array(T * T);
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
        const x = Math.min(w - 1, Math.round(x0 + (i + 0.5) * (x1 - x0) / T)), y = Math.min(h - 1, Math.round(y0 + (j + 0.5) * (y1 - y0) / T));
        const k = (y * w + x) * 4;
        out[j * T + i] = prob[y * w + x] >= 110 ? (rgba[k] + rgba[k + 1] + rgba[k + 2]) / 3 : -1;
    }
    // zero-mean, unit-norm over object pixels
    let m = 0, n = 0;
    for (const v of out) if (v >= 0) { m += v; n++; }
    m /= Math.max(1, n);
    let s = 0;
    for (let i = 0; i < out.length; i++) { out[i] = out[i] >= 0 ? out[i] - m : 0; s += out[i] * out[i]; }
    s = Math.sqrt(s) || 1;
    for (let i = 0; i < out.length; i++) out[i] /= s;
    return out;
}

/** For unordered photos: each frame also gets matched with its most similar-looking frames. */
export function similarNeighbours(list, k) {
    return list.map((a, i) => {
        if (!a.thumb) return [];
        const sc = [];
        list.forEach((b, j) => {
            if (j === i || !b.thumb) return;
            let d = 0;
            for (let q = 0; q < a.thumb.length; q++) d += a.thumb[q] * b.thumb[q];
            sc.push([d, j]);
        });
        return sc.sort((p, q) => q[0] - p[0]).slice(0, k).map(e => e[1]);
    });
}

/**
 * Soft AI mask (0..255) → carving labels. Pixels just outside the object
 * edge become UNKNOWN (no vote) so small pose errors don't shave off thin
 * parts; confident background carves.
 */
export function labelMask(prob, w, h, opts = {}, noVote = null) {
    const fgT = opts.fgThreshold ?? 110, bgT = opts.bgThreshold ?? 40, grow = opts.edgeGuard ?? 2;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = prob[i] >= fgT ? FOREGROUND : prob[i] < bgT ? BACKGROUND : UNKNOWN;
    if (grow > 0) {
        const fg = dilateBinary(prob, w, h, grow, fgT);
        for (let i = 0; i < w * h; i++) if (out[i] === BACKGROUND && fg[i]) out[i] = UNKNOWN;
    }
    if (noVote) for (let i = 0; i < w * h; i++) if (noVote[i]) out[i] = UNKNOWN;
    return out;
}

/**
 * Check and repair the AI masks of all frames (see maskfix.js).
 *   frames[i] = { prob, feat, ... }; getRGBA(i) → rgba at w×h;
 *   segmentCrop(rgba, w, h, box) → new soft mask.
 * Sets frames[i].noVote (pixels that must not vote) and recomputes the
 * features of frames whose mask changed. Returns a short report.
 */
export async function fixMasks(frames, w, h, { getRGBA, segmentCrop, maxFeatures, log = () => {} }) {
    const stats = frames.map(fr => maskStats(fr.prob, w, h));
    const plan = planMaskFixes(stats);
    let redone = 0, dropped = 0;
    for (const i of plan.bad) {
        const rgba = await getRGBA(i);
        const prob = await segmentCrop(rgba, w, h, plan.box);
        const st = maskStats(prob, w, h);
        const cropArea = (plan.box[2] - plan.box[0]) * (plan.box[3] - plan.box[1]);
        // outside the crop we know nothing: no votes there
        const noVote = new Uint8Array(w * h).fill(1);
        const bx0 = Math.floor(plan.box[0] * w), by0 = Math.floor(plan.box[1] * h), bx1 = Math.ceil(plan.box[2] * w), by1 = Math.ceil(plan.box[3] * h);
        for (let y = by0; y < by1; y++) noVote.fill(0, y * w + bx0, y * w + bx1);
        frames[i].maskQuality = 'crop';
        if (st.area / cropArea > 0.7 || st.area < 0.003) { noVote.fill(1); dropped++; frames[i].maskQuality = 'bad'; }
        frames[i].prob = prob;
        frames[i].noVote = noVote;
        if (!frames[i].pose) frames[i].feat = frameFeatures(rgba, w, h, prob, { maxFeatures }); // (AR frames need none)
        redone++;
    }
    // still camera (turntable): what never changes can't be the turning object
    if (frames.every(f => f.pose)) return { redone, dropped, still: false, good: plan.good }; // AR: the phone reports its own movement
    const sw = 96, sh = Math.max(8, Math.round(96 * h / w));
    const greys = [];
    for (let i = 0; i < frames.length; i++) greys.push(smallGrey(await getRGBA(i), w, h, sw, sh));
    const still = isStillCamera(greys, frames.map(f => f.prob), w, h, sw, sh);
    if (still) {
        const flags = staticPixels(greys, frames.map(f => f.prob), w, h, sw, sh);
        frames.forEach((fr, i) => {
            if (fr.noVote) for (let k = 0; k < flags[i].length; k++) fr.noVote[k] |= flags[i][k];
            else fr.noVote = flags[i];
        });
    }
    log(`masks: ${plan.good} good, ${redone} redone on a crop (${dropped} unusable), still camera: ${still ? 'yes (turntable)' : 'no'}`);
    return { redone, dropped, still, good: plan.good };
}

/**
 * Put the SfM result into an object-centred frame: z up, origin under the
 * object's centre, millimetres (assuming the phone was ~camDistMm away).
 */
export function toObjectFrame(sfm, opts = {}) {
    const camDist = opts.camDistMm || 400;
    const reg = [];
    sfm.cams.forEach((c, i) => { if (c) reg.push(i); });
    const C = reg.map(i => camCenter(sfm.cams[i]));
    const P = sfm.points.map(p => p.X);
    if (reg.length < 3 || P.length < 10) throw new Error('SFM_TOO_FEW');
    // centre: median of the sparse points (they are all on the object)
    const O = [0, 1, 2].map(k => median(P.map(p => p[k])));
    // how the phone was held: image "up" is -Y of the camera
    let uAvg = [0, 0, 0];
    for (const i of reg) { const R = sfm.cams[i].R; uAvg[0] -= R[3]; uAvg[1] -= R[4]; uAvg[2] -= R[5]; }
    uAvg = norm(uAvg);
    // normal of the plane through the camera centres (the walk-around ring)
    const mc = [0, 1, 2].map(k => C.reduce((s, c) => s + c[k], 0) / C.length);
    const cov = new Float64Array(9);
    for (const c of C) { const d = [c[0] - mc[0], c[1] - mc[1], c[2] - mc[2]]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a * 3 + b] += d[a] * d[b]; }
    const { values, vectors } = eigenSym(cov, 3);
    let n = [vectors[0], vectors[3], vectors[6]];
    if (dot(n, uAvg) < 0) n = n.map(x => -x);
    const planar = values[0] / Math.max(1e-12, values[1]);
    // azimuth coverage around the ring normal
    const coverage = (axis) => {
        const e1 = norm(Math.abs(axis[0]) < 0.9 ? cross(axis, [1, 0, 0]) : cross(axis, [0, 1, 0])), e2 = cross(axis, e1);
        const az = C.map(c => { const d = [c[0] - O[0], c[1] - O[1], c[2] - O[2]]; return Math.atan2(dot(d, e2), dot(d, e1)); }).sort((a, b) => a - b);
        let gap = az[0] + 2 * Math.PI - az[az.length - 1];
        for (let k = 1; k < az.length; k++) gap = Math.max(gap, az[k] - az[k - 1]);
        return 360 - gap * 180 / Math.PI;
    };
    // Trust the ring normal when the cameras go most of the way round and
    // the phone was held roughly level; otherwise use the phone's "up".
    let up = uAvg;
    const covN = coverage(n);
    if (covN > 150 && planar < 0.5 && dot(n, uAvg) > 0.5) up = norm([n[0] * 2 + uAvg[0], n[1] * 2 + uAvg[1], n[2] * 2 + uAvg[2]]);
    // Horizontal axes along the object itself: X = its long side (principal
    // axis of the sparse points seen from above), so the model — and the
    // box around it — sit straight. The first camera decides the sign.
    const b1 = norm(Math.abs(up[0]) < 0.9 ? cross(up, [1, 0, 0]) : cross(up, [0, 1, 0])), b2 = cross(up, b1);
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of P) {
        const d = [p[0] - O[0], p[1] - O[1], p[2] - O[2]];
        const a = dot(d, b1), b = dot(d, b2);
        sxx += a * a; syy += b * b; sxy += a * b;
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let ex = norm([b1[0] * Math.cos(ang) + b2[0] * Math.sin(ang), b1[1] * Math.cos(ang) + b2[1] * Math.sin(ang), b1[2] * Math.cos(ang) + b2[2] * Math.sin(ang)]);
    let ey = cross(up, ex);
    const d0 = [C[0][0] - O[0], C[0][1] - O[1], C[0][2] - O[2]];
    if (dot(d0, ey) > 0) { ex = ex.map(x => -x); ey = ey.map(x => -x); } // first camera sits in front (−Y)
    // rows of Rw: object axes in SfM coordinates
    const Rw = [ex[0], ex[1], ex[2], ey[0], ey[1], ey[2], up[0], up[1], up[2]];
    const dMed = median(C.map(c => Math.hypot(c[0] - O[0], c[1] - O[1], c[2] - O[2])));
    const s = camDist / dMed;
    const toObj = (X) => mv3(Rw, [X[0] - O[0], X[1] - O[1], X[2] - O[2]]).map(x => x * s);
    const poses = sfm.cams.map(c => {
        if (!c) return null;
        const R = mul3(c.R, tr3(Rw));
        const RO = mv3(c.R, O);
        return { R, t: [(RO[0] + c.t[0]) * s, (RO[1] + c.t[1]) * s, (RO[2] + c.t[2]) * s] };
    });
    const pts = P.map(toObj);
    // how far the camera turned around the object, in capture order: a
    // path that folds back and forth (sum ≫ coverage) is a wrong solution
    let turn = 0, signed = 0;
    {
        let prevAz = null;
        for (const i of reg) {
            const c = camCenter(poses[i]);
            const az = Math.atan2(c[1], c[0]);
            if (prevAz !== null) { let d = az - prevAz; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; turn += Math.abs(d); signed += d; }
            prevAz = az;
        }
        turn *= 180 / Math.PI; signed *= 180 / Math.PI;
    }
    const elev = reg.map(i => { const c = camCenter(poses[i]); return Math.atan2(c[2], Math.hypot(c[0], c[1])) * 180 / Math.PI; });
    return {
        poses, points: pts, scale: s, Rw, O,
        info: { coverageDeg: coverage(up), turnDeg: turn, turnSignedDeg: signed, planarity: planar, elevMin: Math.min(...elev), elevMax: Math.max(...elev), camDist },
    };
}

/** Per-pixel depth range (near, far) of the carved shape in a view, where the mask says "object". */
function depthRange(grid, v, maskW, maskH) {
    const { occ, nx, ny, nz, origin, voxel } = grid, W = v.width, H = v.height;
    const near = new Float32Array(W * H).fill(Infinity), far = new Float32Array(W * H);
    const { R, t, f } = v;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (!occ[(k * ny + j) * nx + i]) continue;
        const X = origin[0] + (i + 0.5) * voxel, Y = origin[1] + (j + 0.5) * voxel, Z = origin[2] + (k + 0.5) * voxel;
        const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
        if (z <= 1) continue;
        const u = Math.round(f * (R[0] * X + R[1] * Y + R[2] * Z + t[0]) / z + W / 2), w = Math.round(f * (R[3] * X + R[4] * Y + R[5] * Z + t[1]) / z + H / 2);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const uu = u + dx, ww = w + dy;
            if (uu < 0 || ww < 0 || uu >= W || ww >= H) continue;
            const q = ww * W + uu;
            if (z < near[q]) near[q] = z;
            if (z > far[q]) far[q] = z;
        }
    }
    const out = new Float32Array(W * H * 2);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const q = y * W + x;
        if (!isFinite(near[q])) continue;
        const mq = Math.min(maskH - 1, Math.floor((y + 0.5) * maskH / H)) * maskW + Math.min(maskW - 1, Math.floor((x + 0.5) * maskW / W));
        if (v.label[mq] !== FOREGROUND) continue;
        out[2 * q] = Math.max(1, near[q] - 2 * voxel);
        out[2 * q + 1] = far[q] + voxel;
    }
    return out;
}

/** Box hugging the carved object (model frame), floor kept at 0. */
function fitBox(grid, voxel) {
    const b = occupiedBox(grid);
    if (!b) return null;
    const m = 1.5 * voxel;
    return { x0: b.min[0] - m, x1: b.max[0] + m, y0: b.min[1] - m, y1: b.max[1] + m, z0: 0, z1: b.max[2] + m };
}

/** Shift the object frame by `d` (new = old − d). */
function shiftPoses(poses, d) {
    return poses.map(p => p && { R: p.R, t: [p.t[0] + p.R[0] * d[0] + p.R[1] * d[1] + p.R[2] * d[2], p.t[1] + p.R[3] * d[0] + p.R[4] * d[1] + p.R[5] * d[2], p.t[2] + p.R[6] * d[0] + p.R[7] * d[1] + p.R[8] * d[2]] });
}

function occupiedBox(grid) {
    const { occ, nx, ny, nz, origin, voxel } = grid;
    let a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity], n = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (!occ[(k * ny + j) * nx + i]) continue;
        n++;
        a = [Math.min(a[0], i), Math.min(a[1], j), Math.min(a[2], k)]; b = [Math.max(b[0], i), Math.max(b[1], j), Math.max(b[2], k)];
    }
    if (!n) return null;
    return {
        min: [origin[0] + a[0] * voxel, origin[1] + a[1] * voxel, origin[2] + a[2] * voxel],
        max: [origin[0] + (b[0] + 1) * voxel, origin[1] + (b[1] + 1) * voxel, origin[2] + (b[2] + 1) * voxel],
        idxMin: a, idxMax: b, count: n,
    };
}

/**
 * Ground height: rays through the lowest silhouette pixels of each view
 * first touch the object where it stands on the ground (below that the
 * hull only has the un-carvable "keel" nobody could see).
 */
export function estimateGround(grid, views) {
    const { occ, nx, ny, nz, origin, voxel } = grid;
    const solid = (x, y, z) => {
        const i = Math.floor((x - origin[0]) / voxel), j = Math.floor((y - origin[1]) / voxel), k = Math.floor((z - origin[2]) / voxel);
        return i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && occ[(k * ny + j) * nx + i] === 1;
    };
    const box = occupiedBox(grid);
    if (!box) return null;
    const ctr = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    const heights = [];
    for (const v of views) {
        const { R, t, f, width: w, height: h, mask } = v;
        const cx = w / 2, cy = h / 2;
        const proj = (X) => { const xc = mv3(R, X); const z = xc[2] + t[2]; return [f * (xc[0] + t[0]) / z + cx, f * (xc[1] + t[1]) / z + cy]; };
        const p0 = proj(ctr), p1 = proj([ctr[0], ctr[1], ctr[2] - voxel * 4]);
        let dx = p1[0] - p0[0], dy = p1[1] - p0[1];
        const l = Math.hypot(dx, dy);
        if (!(l > 0)) continue;
        dx /= l; dy /= l;
        // silhouette boundary pixels, ranked by how far "down" they are
        const cand = [];
        for (let y = 3; y < h - 3; y += 1) for (let x = 3; x < w - 3; x += 1) {
            const i = y * w + x;
            if (mask[i] !== FOREGROUND) continue;
            if (mask[i + w] === FOREGROUND && mask[i - w] === FOREGROUND && mask[i + 1] === FOREGROUND && mask[i - 1] === FOREGROUND) continue;
            cand.push([(x - p0[0]) * dx + (y - p0[1]) * dy, x, y]);
        }
        if (cand.length < 10) continue;
        cand.sort((a, b) => b[0] - a[0]);
        const C = camCenter({ R, t });
        const Rt = tr3(R);
        for (const [, x, y] of cand.slice(0, Math.max(5, Math.round(cand.length * 0.02)))) {
            const d = norm(mv3(Rt, [(x + 0.5 - cx) / f, (y + 0.5 - cy) / f, 1]));
            const dist = Math.hypot(C[0] - ctr[0], C[1] - ctr[1], C[2] - ctr[2]);
            for (let s = dist * 0.3; s < dist * 1.7; s += voxel * 0.5) {
                const X = C[0] + d[0] * s, Y = C[1] + d[1] * s, Z = C[2] + d[2] * s;
                if (solid(X, Y, Z)) { heights.push(Z); break; }
            }
        }
    }
    if (heights.length < 5) return null;
    return { q: pct(heights, 0.3), median: median(heights), n: heights.length, pcts: [0.05, 0.1, 0.25, 0.5, 0.75].map(q => +pct(heights, q).toFixed(1)) };
}

/**
 * "The field": a box around the object found from the sparse 3D points
 * (features on the object itself), not from silhouettes — so a table or
 * stool the AI wrongly kept in the mask can't make it grow. Points of a
 * table are recognisable: a dense, flat, horizontal layer at the bottom that
 * spreads wider than the object. That layer is also the floor.
 *   P: points in the object frame (z up), camD: typical camera distance.
 */
export function objectField(P0, camD) {
    if (P0.length < 20) return null;
    // dense cluster seen from above: a textured object gives many feature
    // points per square centimetre, a table around it only a scattering
    const P = denseCluster(P0, camD);
    if (P.length < 20) return null;
    const zs = P.map(p => p[2]);
    const zLo = pct(zs, 0.0), zMid = pct(zs, 0.6);
    const bin = Math.max(1, camD * 0.005);
    const nb = Math.max(1, Math.ceil((zMid - zLo) / bin) + 1), hist = new Int32Array(nb);
    for (const z of zs) if (z <= zMid) hist[Math.min(nb - 1, Math.floor((z - zLo) / bin))]++;
    let bi = 0;
    for (let i = 1; i < nb; i++) if (hist[i] + (hist[i - 1] || 0) > hist[bi] + (hist[bi - 1] || 0)) bi = i;
    const zt = zLo + (bi + 0.5) * bin, tol = 1.5 * bin;
    const onPlane = P.filter(p => Math.abs(p[2] - zt) < tol), above = P.filter(p => p[2] > zt + 2 * tol);
    const spread = (Q) => pct(Q.map(p => Math.hypot(p[0], p[1])), 0.9);
    // a floor has (almost) nothing under it — a flat top of the object does
    const below = P.filter(p => p[2] < zt - 2 * tol).length;
    const isTable = onPlane.length >= Math.max(15, 0.06 * P.length) && above.length >= 20 && below <= Math.max(3, 0.02 * P.length) && spread(onPlane) > 1.3 * spread(above);
    const Q = isTable ? above : P;
    const xs = Q.map(p => p[0]), ys = Q.map(p => p[1]), qz = Q.map(p => p[2]);
    const x0 = pct(xs, 0.01), x1 = pct(xs, 0.99), y0 = pct(ys, 0.01), y1 = pct(ys, 0.99), z0 = pct(qz, 0.01), z1 = pct(qz, 0.995);
    // generous margins: plain parts of the object have no feature points
    const m = 0.35 * Math.max(x1 - x0, y1 - y0) + 0.05 * camD, mz = 0.3 * (z1 - z0) + 0.05 * camD;
    return {
        box: { x0: x0 - m, x1: x1 + m, y0: y0 - m, y1: y1 + m, z0: isTable ? zt : z0 - 0.35 * (z1 - z0) - mz, z1: z1 + mz },
        floor: isTable ? zt : null, tablePoints: isTable ? onPlane.length : 0, objectPoints: Q.length,
    };
}

/** Image rectangle [u0, v0, u1, v1] covered by a 3D box, or null if it is behind the camera. */
function projectedBox(view, box) {
    const { R, t, f, width: w, height: h } = view;
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const X of [box.x0, box.x1]) for (const Y of [box.y0, box.y1]) for (const Z of [box.z0, box.z1]) {
        const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
        if (z <= 1) return null;
        const u = f * (R[0] * X + R[1] * Y + R[2] * Z + t[0]) / z + w / 2, v = f * (R[3] * X + R[4] * Y + R[5] * Z + t[1]) / z + h / 2;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    return [u0, v0, u1, v1];
}

function denseCluster(P, camD) {
    const cell = Math.max(2, camD * 0.02);
    const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const W = Math.min(400, Math.ceil((Math.max(...xs) - x0) / cell) + 3), H = Math.min(400, Math.ceil((Math.max(...ys) - y0) / cell) + 3);
    const ci = (p) => [Math.min(W - 2, Math.max(1, Math.floor((p[0] - x0) / cell) + 1)), Math.min(H - 2, Math.max(1, Math.floor((p[1] - y0) / cell) + 1))];
    const cnt = new Float32Array(W * H);
    for (const p of P) { const [i, j] = ci(p); cnt[j * W + i]++; }
    const sm = new Float32Array(W * H);
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
        let s = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += cnt[(j + dj) * W + i + di];
        sm[j * W + i] = s;
    }
    let best = 0;
    for (let k = 1; k < sm.length; k++) if (sm[k] > sm[best]) best = k;
    const thr = Math.max(3, 0.12 * sm[best]);
    const inR = new Uint8Array(W * H), stack = [best];
    inR[best] = 1;
    while (stack.length) {
        const k = stack.pop(), i = k % W, j = (k / W) | 0;
        for (const q of [k - 1, k + 1, k - W, k + W]) {
            const qi = q % W, qj = (q / W) | 0;
            if (qi < 1 || qj < 1 || qi >= W - 1 || qj >= H - 1 || inR[q] || sm[q] < thr) continue;
            inR[q] = 1; stack.push(q);
        }
        void i; void j;
    }
    return P.filter(p => { const [i, j] = ci(p); return inR[j * W + i]; });
}

/** Pixels outside the image of the box can't be the object: mark them background. */
function clipToBox(label, view, box) {
    const { width: w, height: h } = view;
    const bb = projectedBox(view, box);
    if (!bb) return; // box partly behind the camera: leave as is
    const [u0, v0, u1, v1] = bb;
    const a = Math.max(0, Math.floor(u0)), b = Math.min(w, Math.ceil(u1)), c = Math.max(0, Math.floor(v0)), d = Math.min(h, Math.ceil(v1));
    for (let y = 0; y < h; y++) {
        const row = y * w;
        if (y < c || y >= d) { label.fill(BACKGROUND, row, row + w); continue; }
        if (a > 0) label.fill(BACKGROUND, row, row + a);
        if (b < w) label.fill(BACKGROUND, row + b, row + w);
    }
}

/**
 * The whole no-sheet reconstruction.
 *   frames: [{ feat, prob (Uint8 0..255, width×height) }] (feature/mask images)
 *   getFrame(i, longSide) → { rgba, width, height } (for colouring)
 */
export async function buildMarkerlessModel({ frames, width, height, getFrame }, opts = {}) {
    const report = opts.onProgress || (() => {});
    const log = opts.log || (() => {});
    const t0 = Date.now();
    // --- 1. camera poses. Besides neighbours in time, match each frame with
    //     the frames that look most alike (the same side seen from another
    //     height, or photos taken out of order).
    // (look-alike sides of a symmetric object can fool this; sfm.js only
    //  accepts such a pair when it shows real parallax)
    const similar = opts.similarK && frames.every(fr => fr.thumb) ? similarNeighbours(frames, opts.similarK) : frames.map(() => []);
    const sfm = runSfM(frames.map((fr, i) => ({ feat: fr.feat, extraNeighbours: [...(fr.extraNeighbours || []), ...similar[i]] })), width, height, {
        closed: true, ...opts.sfm, log, onProgress: (stage, p) => report(stage, p),
    });
    const reg = [];
    sfm.cams.forEach((c, i) => { if (c) reg.push(i); });
    log(`sfm ${Date.now() - t0} ms`);
    log(`path: ${sfm.stats.jumps} jumps`);
    if (reg.length < Math.max(6, Math.ceil(frames.length * (opts.minRegisteredFrac ?? 0.5))) || sfm.stats.jumps > (opts.maxJumps ?? 1)) {
        const e = new Error('POSES_FAILED'); e.stats = sfm.stats; throw e;
    }
    // --- 2. object frame
    const obj = toObjectFrame(sfm, opts);
    // walking around (or turning the object) goes one way; a solution whose
    // path keeps reversing is wrong
    const fold = Math.abs(obj.info.turnSignedDeg) / Math.max(1, obj.info.turnDeg);
    if (obj.info.turnDeg > 90 && fold < (opts.minOneWay ?? 0.75)) { const e = new Error('POSES_FAILED'); e.stats = { ...sfm.stats, fold }; throw e; }
    log(`object frame: coverage ${obj.info.coverageDeg.toFixed(0)}°, path turns ${obj.info.turnDeg.toFixed(0)}° (${(100 * Math.abs(obj.info.turnSignedDeg) / Math.max(1, obj.info.turnDeg)).toFixed(0)} % one way), elevation ${obj.info.elevMin.toFixed(0)}…${obj.info.elevMax.toFixed(0)}°, planarity ${obj.info.planarity.toFixed(2)}`);
    const labels = frames.map(fr => labelMask(fr.prob, width, height, opts, fr.noVote));
    const views = reg.map(i => ({ R: obj.poses[i].R, t: obj.poses[i].t, f: sfm.f, width, height, mask: labels[i] }));
    // the field around the object: everything outside it is background
    // object points: inside the cleaned object mask in ≥ 2 of the frames that
    // saw them (points on a table the AI once took for the object drop out)
    const objPts = [];
    sfm.points.forEach((P, q) => {
        let yes = 0, votes = 0;
        for (let k = 0; k < P.obs.length; k += 2) {
            const fi = P.obs[k], F = frames[fi].feat, j = P.obs[k + 1];
            const px = Math.min(width - 1, Math.max(0, Math.round(F.x[j]))), py = Math.min(height - 1, Math.max(0, Math.round(F.y[j])));
            const lab = labels[fi][py * width + px];
            if (lab === UNKNOWN) continue;
            votes++;
            if (lab === FOREGROUND) yes++;
        }
        if (yes >= 2 && yes >= 0.5 * votes) objPts.push(obj.points[q]);
    });
    const field = opts.field === false ? null : objectField(objPts, obj.info.camDist);
    // Now the cameras and the field are known: redo the masks that were bad
    // on a tight crop around where the field is in that picture — the mask
    // AI does much better when the object fills its input.
    if (field && opts.recrop) {
        let redone = 0;
        for (let k = 0; k < reg.length; k++) {
            const i = reg[k], fr = frames[i];
            if (fr.maskQuality !== 'bad') continue; // (crop masks from fixMasks are usually fine)
            const bb = projectedBox(views[k], field.box);
            if (!bb) continue;
            const pad = 0.06;
            const crop = [Math.max(0, bb[0] / width - pad), Math.max(0, bb[1] / height - pad), Math.min(1, bb[2] / width + pad), Math.min(1, bb[3] / height + pad)];
            if (crop[2] - crop[0] < 0.05 || crop[3] - crop[1] < 0.05) continue;
            fr.prob = await opts.recrop(i, crop);
            fr.noVote = null;
            labels[i] = labelMask(fr.prob, width, height, opts, null);
            views[k].mask = labels[i];
            redone++;
        }
        log(`field: ${redone} masks redone on a crop around the field (${reg.filter(i => frames[i].maskQuality).length} flagged)`);
    }
    if (opts.afterMasks) await opts.afterMasks();
    if (field) {
        for (const v of views) clipToBox(v.mask, v, field.box);
        log(`field: ${field.objectPoints} object points, table/floor ${field.floor != null ? `at z=${field.floor.toFixed(1)} (${field.tablePoints} points)` : 'not seen'}`);
    }

    // --- 3. coarse carving: box around the sparse points, grown if needed
    const P = obj.points;
    const rad = pct(P.map(p => Math.hypot(p[0], p[1])), 0.97);
    const camD = obj.info.camDist;
    let half = Math.min(0.75 * camD, Math.max(rad * 1.8, 0.12 * camD));
    let zLo = Math.max(-0.9 * camD, pct(P.map(p => p[2]), 0.02) - half * 0.8), zHi = Math.min(0.9 * camD, pct(P.map(p => p[2]), 0.98) + half * 0.6);
    if (field) {
        const fb = field.box;
        half = Math.max(Math.abs(fb.x0), Math.abs(fb.x1), Math.abs(fb.y0), Math.abs(fb.y1));
        zLo = fb.z0 - (field.floor != null ? 0.02 * camD : 0); zHi = fb.z1;
    }
    let coarse = null, cbox = null;
    for (let round = 0; round < 3; round++) {
        const bounds = { x0: -half, x1: half, y0: -half, y1: half, z0: zLo, z1: zHi };
        const vox = Math.max(2 * half, zHi - zLo) / 56;
        const carver = createCarver({ bounds, voxel: vox, bgFrac: 0.1, keepFrac: 0.2 });
        for (const v of views) carver.addView(v);
        coarse = carver.finish();
        cbox = occupiedBox(coarse);
        if (!cbox) break;
        // grow the box if the object touches its sides
        const touch = cbox.idxMin[0] <= 0 || cbox.idxMin[1] <= 0 || cbox.idxMax[0] >= coarse.nx - 1 || cbox.idxMax[1] >= coarse.ny - 1 || cbox.idxMax[2] >= coarse.nz - 1;
        if (!touch || half >= 0.75 * camD || field) break;
        half = Math.min(0.75 * camD, half * 1.5); zHi = Math.min(0.9 * camD, zHi + half * 0.5);
    }
    if (!cbox) throw new Error('EMPTY_HULL');
    report('carve', 0.1);
    // --- ground: rough from the coarse grid, then refined on a finer grid
    //     inside the tight box (coarse voxels bias it downwards)
    const g0 = estimateGround(coarse, views);
    let ground = Math.max(g0 ? g0.median - 2 * coarse.voxel : cbox.min[2], cbox.min[2]);
    {
        const cvx = coarse.voxel;
        const mb = { x0: cbox.min[0] - 2 * cvx, x1: cbox.max[0] + 2 * cvx, y0: cbox.min[1] - 2 * cvx, y1: cbox.max[1] + 2 * cvx, z0: ground - cvx, z1: cbox.max[2] + 2 * cvx };
        const mv = Math.max(mb.x1 - mb.x0, mb.y1 - mb.y0, mb.z1 - mb.z0) / 90;
        const carver = createCarver({ bounds: mb, voxel: mv, bgFrac: 0.08, keepFrac: 0.2 });
        for (const v of views) carver.addView(v);
        const mid = carver.finish();
        const g1 = estimateGround(mid, views);
        if (g1) ground = Math.max(mb.z0, g1.q);
        log(`medium box z ${occupiedBox(mid).min[2].toFixed(1)} (grid z0 ${mb.z0.toFixed(1)}, voxel ${mv.toFixed(2)})`);
        log(`ground coarse ${g0 && g0.pcts} → medium ${g1 && g1.pcts} (${g1 ? g1.n : 0} rays) → ${ground.toFixed(1)}`);
    }
    log(`coarse box ${cbox.min.map(v => v.toFixed(0))} … ${cbox.max.map(v => v.toFixed(0))}, lowest sparse point ${pct(P.map(p => p[2]), 0.02).toFixed(1)}`);
    const cv = coarse.voxel;
    // a table seen in the points gives the floor directly
    if (field && field.floor != null) ground = field.floor;
    let box = { x0: cbox.min[0] - 2 * cv, x1: cbox.max[0] + 2 * cv, y0: cbox.min[1] - 2 * cv, y1: cbox.max[1] + 2 * cv, z0: ground, z1: cbox.max[2] + 2 * cv };
    if (field) {
        const fb = field.box;
        box = { x0: Math.max(box.x0, fb.x0), x1: Math.min(box.x1, fb.x1), y0: Math.max(box.y0, fb.y0), y1: Math.min(box.y1, fb.y1), z0: box.z0, z1: Math.min(box.z1, fb.z1) };
    }
    const scene = { frames, width, height, getFrame, opts, report, log, reg, labels, sfm, obj, t0 };
    return carveInBox(scene, box);
}

/**
 * AR capture (Android Chrome + ARCore): the phone tracked its own position,
 * in real millimetres, and the user placed a box on the floor around the
 * object. No camera solving, no size guessing: masks → carve in the box.
 *   frames[i] = { prob, noVote?, maskQuality?, pose: { R, t } } (object frame
 *   mm: box floor at z = 0), f in pixels at width×height, box { x0..z1 }.
 */
export async function buildKnownPoseModel({ frames, width, height, getFrame }, opts = {}) {
    const report = opts.onProgress || (() => {});
    const log = opts.log || (() => {});
    const t0 = Date.now();
    const box = opts.box, f = opts.f;
    const reg = [];
    frames.forEach((fr, i) => { if (fr.pose) reg.push(i); });
    if (reg.length < 8) throw Object.assign(new Error('TOO_FEW_FRAMES'), { code: 'TOO_FEW_FRAMES' });
    const poses = frames.map(fr => fr.pose || null);
    const labels = frames.map(fr => labelMask(fr.prob, width, height, opts, fr.noVote));
    const views = reg.map(i => ({ R: poses[i].R, t: poses[i].t, f, width, height, mask: labels[i] }));
    // bad masks: redo on a crop around the box in that picture
    if (opts.recrop) {
        let redone = 0;
        for (let k = 0; k < reg.length; k++) {
            const i = reg[k], fr = frames[i];
            if (fr.maskQuality !== 'bad' && fr.maskQuality !== 'crop') continue;
            const bb = projectedBox(views[k], box);
            if (!bb) continue;
            const crop = [Math.max(0, bb[0] / width - 0.04), Math.max(0, bb[1] / height - 0.04), Math.min(1, bb[2] / width + 0.04), Math.min(1, bb[3] / height + 0.04)];
            if (crop[2] - crop[0] < 0.05 || crop[3] - crop[1] < 0.05) continue;
            fr.prob = await opts.recrop(i, crop);
            labels[i] = labelMask(fr.prob, width, height, opts, null);
            views[k].mask = labels[i];
            redone++;
        }
        log(`AR: ${redone} masks redone on a crop around the box`);
    }
    if (opts.afterMasks) await opts.afterMasks();
    for (const v of views) clipToBox(v.mask, v, box);
    // camera ring for info
    const C = reg.map(i => camCenter(poses[i]));
    const camDist = median(C.map(c => Math.hypot(c[0], c[1], c[2] - (box.z1 - box.z0) / 2)));
    const az = C.map(c => Math.atan2(c[1], c[0])).sort((a, b) => a - b);
    let gap = az[0] + 2 * Math.PI - az[az.length - 1];
    for (let k = 1; k < az.length; k++) gap = Math.max(gap, az[k] - az[k - 1]);
    // coarse carve in the user's box to find the object, then fine carve around it
    const vox = Math.max(box.x1 - box.x0, box.y1 - box.y0, box.z1 - box.z0) / 64;
    const carver = createCarver({ bounds: box, voxel: vox, bgFrac: 0.1, keepFrac: 0.2 });
    for (const v of views) carver.addView(v);
    const coarse = carver.finish();
    const cb = occupiedBox(coarse);
    if (!cb) throw new Error('EMPTY_HULL');
    report('carve', 0.1);
    const tight = {
        x0: Math.max(box.x0, cb.min[0] - 2 * vox), x1: Math.min(box.x1, cb.max[0] + 2 * vox),
        y0: Math.max(box.y0, cb.min[1] - 2 * vox), y1: Math.min(box.y1, cb.max[1] + 2 * vox),
        z0: box.z0, z1: Math.min(box.z1, cb.max[2] + 2 * vox),
    };
    const obj = { poses, points: [], scale: 1, info: { coverageDeg: 360 - gap * 180 / Math.PI, camDist, turnDeg: 0, turnSignedDeg: 0, planarity: 0, elevMin: 0, elevMax: 0 } };
    const sfm = { cams: poses, f, points: [], stats: { registered: reg.length, total: frames.length, points: 0, rms: 0, jumps: 0 } };
    log(`AR: ${reg.length} posed frames, ${obj.info.coverageDeg.toFixed(0)}° around, object ${Math.round(cb.max[0] - cb.min[0])}×${Math.round(cb.max[1] - cb.min[1])}×${Math.round(cb.max[2] - box.z0)} mm (${Date.now() - t0} ms)`);
    const scene = { frames, width, height, getFrame, opts, report, log, reg, labels, sfm, obj, t0 };
    return carveInBox(scene, tight);
}

/**
 * Which way is the AR camera picture stored? Browsers differ (GL textures
 * start at the bottom row, some may be mirrored), and a wrong guess silently
 * ruins the model. With the phone's own poses this can be checked: points
 * matched between two nearby pictures must lie on the epipolar lines given
 * by the known motion — and only when the picture is read the right way.
 *   pairs: [{ A, B, poseA, poseB }] with A, B = features ({ n, x, y, desc })
 * Returns { flip: 'none' | 'y' | 'x' | 'xy', scores } (inlier fractions).
 */
export function detectImageFlip(pairs, width, height, f, opts = {}) {
    const tol = opts.tol ?? 2.0;                 // px
    const scores = {}, counts = {};
    for (const flip of ['none', 'y', 'x', 'xy']) {
        const sx = flip === 'x' || flip === 'xy' ? -1 : 1, sy = flip === 'y' || flip === 'xy' ? -1 : 1;
        let inl = 0, tot = 0;
        for (const { A, B, poseA, poseB } of pairs) {
            const m = matchFeatures(A, B);
            // relative motion A → B and its essential matrix E = [t]× R
            const Ra = poseA.R, Rb = poseB.R;
            const R = mul3(Rb, [Ra[0], Ra[3], Ra[6], Ra[1], Ra[4], Ra[7], Ra[2], Ra[5], Ra[8]]);
            const Rta = mv3(R, poseA.t);
            const t = [poseB.t[0] - Rta[0], poseB.t[1] - Rta[1], poseB.t[2] - Rta[2]];
            const tn = Math.hypot(...t);
            if (tn < 20) continue;                  // < 2 cm apart: says nothing
            const T = [0, -t[2], t[1], t[2], 0, -t[0], -t[1], t[0], 0].map(v => v / tn);
            const E = mul3(T, R);
            for (let k = 0; k < m.length; k += 2) {
                const i = m[k], j = m[k + 1];
                // (the flip mirrors the picture about its centre)
                const x1 = [sx * (A.x[i] - width / 2) / f, sy * (A.y[i] - height / 2) / f, 1];
                const x2 = [sx * (B.x[j] - width / 2) / f, sy * (B.y[j] - height / 2) / f, 1];
                const Ex1 = mv3(E, x1), Etx2 = [E[0] * x2[0] + E[3] * x2[1] + E[6], E[1] * x2[0] + E[4] * x2[1] + E[7], E[2] * x2[0] + E[5] * x2[1] + E[8]];
                const r = x2[0] * Ex1[0] + x2[1] * Ex1[1] + Ex1[2];
                const d2 = r * r / (Ex1[0] ** 2 + Ex1[1] ** 2 + Etx2[0] ** 2 + Etx2[1] ** 2 + 1e-12); // Sampson
                tot++;
                if (Math.sqrt(d2) * f < tol) inl++;
            }
        }
        scores[flip] = tot ? inl / tot : 0;
        counts[flip] = tot;
    }
    // stay with the plain reading unless another one is clearly better
    let best = 'none';
    for (const k of ['y', 'x', 'xy']) if (scores[k] > 1.5 * scores[best] + 0.05) best = k;
    if (counts.none < 30) best = 'none';        // too little to decide
    return { flip: best, scores, matches: counts.none };
}

/** Mirror a w×h single-channel image in place. */
export function flipImage(a, w, h, flip) {
    if (flip === 'none') return a;
    const fx = flip === 'x' || flip === 'xy', fy = flip === 'y' || flip === 'xy';
    const out = new a.constructor(a.length);
    for (let y = 0; y < h; y++) {
        const sy = fy ? h - 1 - y : y;
        for (let x = 0; x < w; x++) out[y * w + x] = a[sy * w + (fx ? w - 1 - x : x)];
    }
    a.set(out);
    return a;
}

/**
 * Convert a WebXR camera (view.transform = camera → AR world, metres, y up,
 * camera looking down −z) into this app's convention: object frame in mm with
 * z up, origin on the floor at the box centre (floorPoint), camera
 * Xc = R·X + t with x right, y down, z forward.
 *   viewMatrix: 16 numbers, column-major (XRRigidTransform.matrix)
 */
export function xrPoseToObject(viewMatrix, floorPoint) {
    const m = viewMatrix;
    // camera → world rotation (columns) and position
    const Rcw = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]; // row-major of the 3×3 block
    const pos = [m[12], m[13], m[14]];
    // world → camera
    const Rwc = [Rcw[0], Rcw[3], Rcw[6], Rcw[1], Rcw[4], Rcw[7], Rcw[2], Rcw[5], Rcw[8]];
    // AR world (x, y up, z) → object (x, −z, y up): M; object → AR = Mᵀ
    const Mt = [1, 0, 0, 0, 0, 1, 0, -1, 0];
    const Cflip = [1, 0, 0, 0, -1, 0, 0, 0, -1]; // WebXR camera (y up, −z forward) → OpenCV (y down, z forward)
    const R = mul3(mul3(Cflip, Rwc), Mt);
    const d = [floorPoint[0] - pos[0], floorPoint[1] - pos[1], floorPoint[2] - pos[2]];
    const t = mv3(Cflip, mv3(Rwc, d)).map(x => x * 1000);
    return { R, t };
}

/** Focal length (px) and principal-point offset of a WebXR projection for a W×H image. */
export function xrIntrinsics(proj, W, H) {
    const fx = proj[0] * W / 2, fy = proj[5] * H / 2;
    return { f: (fx + fy) / 2, fx, fy, cx: W / 2 * (1 - proj[8]), cy: H / 2 * (1 + proj[9]) };
}

/**
 * Fine carving + surface + colours + texture inside a box (object frame, mm;
 * z0 is the floor). Called once automatically and again whenever the user
 * adjusts the box ("the field" around the object): cameras and masks are
 * reused, so this is quick.
 */
export async function carveInBox(scene, box) {
    const { frames, width, height, getFrame, opts, report, log, reg, labels, sfm, obj } = scene;
    const t0 = Date.now();
    // --- 4. fine carving in the box, floor at z = 0
    const shift = [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, box.z0];
    const poses = shiftPoses(obj.poses, shift);
    const hx = (box.x1 - box.x0) / 2, hy = (box.y1 - box.y0) / 2, top = box.z1 - box.z0;
    const bounds = { x0: -hx, x1: hx, y0: -hy, y1: hy, z0: 0, z1: top };
    const voxel = Math.max(2 * hx, 2 * hy, top) / (opts.gridRes || 128);
    const ground = box.z0;
    const regPoses = reg.map(i => poses[i]);
    // sparse points in the final frame, with the frames that saw them
    const ptsFinal = obj.points.map(p => [p[0] - shift[0], p[1] - shift[1], p[2] - shift[2]]);
    const refineInfo = {};
    const refineGrid = async (grid) => {
        const tR = Date.now();
        const before = grid.occ.reduce((a, v) => a + v, 0);
        // depth maps (only some frames have one)
        const dviews = [];
        for (const i of opts.refine ? reg : []) {
            const d = frames[i].depth;
            if (!d) continue;
            const seen = [];
            sfm.points.forEach((P, q) => { for (let k = 0; k < P.obs.length; k += 2) if (P.obs[k] === i) { seen.push(ptsFinal[q]); break; } });
            const v = { depth: d.depth, dW: d.dW, dH: d.dH, R: poses[i].R, t: poses[i].t, f: sfm.f, width, height, mask: erodeForeground(labels[i], width, height, 4) };
            // two independent scale estimates must agree: from the sparse 3D
            // points (unbiased, noisy) and from the carved shape (precise,
            // but pulled by hollows); otherwise this depth map is not used
            const fp = fitDepth(v, seen), fs = fitDepthToShape(grid, v, seen);
            if (!fp || !fs) continue;
            const ratio = fs.a / fp.a;
            (refineInfo.depthAgree ||= []).push(+ratio.toFixed(2));
            if (ratio < 0.8 || ratio > 1.25 || fs.spread > 0.05) continue;
            v.fit = fs;
            dviews.push(v);
        }
        if (dviews.length >= 3) {
            refineInfo.depthViews = dviews.length;
            refineInfo.depthSpread = +(dviews.reduce((a, v) => a + v.fit.spread, 0) / dviews.length).toFixed(4);
            refineInfo.depthRemoved = depthCarve(grid, dviews, { minViews: 2, log });
        }
        // dense depth on the GPU (plane sweep) → carve what lies in front of it
        if (opts.mvs && scene.mvsCache) {
            // box rebuild: the depth maps don't depend on the box — reuse them
            const dv = scene.mvsCache.map(d => ({ ...d, R: poses[d.frame].R, t: poses[d.frame].t }));
            refineInfo.mvsViews = dv.length;
            refineInfo.mvsRemoved = dv.length >= 2 ? depthCarve(grid, dv, { minViews: opts.mvsMinViews ?? 2 }) : 0;
        } else if (opts.mvs && await gpuAvailable()) {
            const tm = Date.now();
            const side = opts.mvsSide || 320;
            const mv = [], useReg = reg;
            for (const i of useReg) {
                const fr = await getFrame(i, side);
                const grey = new Float32Array(fr.width * fr.height);
                for (let q = 0; q < grey.length; q++) grey[q] = (fr.rgba[4 * q] * 0.299 + fr.rgba[4 * q + 1] * 0.587 + fr.rgba[4 * q + 2] * 0.114) / 255;
                mv.push({ R: poses[i].R, t: poses[i].t, f: sfm.f * fr.width / width, width: fr.width, height: fr.height, grey, label: labels[i] });
            }
            const nbrs = pickNeighbours(mv, [0, 0, top / 2], 4);
            const ranges = mv.map(v => depthRange(grid, v, width, height));
            const maps = [];
            const step = Math.max(1, Math.ceil(mv.length / (opts.mvsViews || mv.length)));
            // time budget: a slow GPU must not make the scan take forever
            const budget = opts.mvsBudgetMs ?? 45000, t1 = Date.now();
            for (let k = 0; k < mv.length; k++) {
                if (k % step || nbrs[k].length < 2 || Date.now() - t1 > budget) { maps.push(null); continue; }
                const m = await planeSweep(mv[k], nbrs[k].map(j => mv[j]), ranges[k], { planes: opts.mvsPlanes || 80 });
                maps.push(m);
                if (opts.debugMvs) {
                    let nr = 0, nd = 0, cs = [];
                    for (let q = 0; q < m.depth.length; q++) { if (ranges[k][2 * q] > 0) nr++; if (m.depth[q] > 0) { nd++; cs.push(m.cost[q]); } }
                    cs.sort((a, b) => a - b);
                    log(`mvs view ${k}: nbrs ${nbrs[k].length}, in range ${nr}, depth ${nd}, cost median ${cs[cs.length >> 1]?.toFixed(3)}`);
                }
                report('refine', (k + 1) / mv.length * 0.8);
            }
            // views without their own map still help check the others
            const good = consistencyFilter(maps.map((m, k) => m || null), mv, nbrs, { minAgree: 1 });
            const dv = [];
            good.forEach((d, k) => {
                if (!d) return;
                const inv = new Float32Array(d.length);
                let n = 0;
                for (let q = 0; q < d.length; q++) if (d[q] > 0) { inv[q] = 1 / d[q]; n++; }
                if (n < 50) return;
                const i = useReg[k];
                dv.push({ frame: i, depth: inv, dW: mv[k].width, dH: mv[k].height, R: mv[k].R, t: mv[k].t, f: sfm.f, width, height, mask: erodeForeground(labels[i], width, height, 3), fit: { a: 1, b: 0, spread: 0.004 } });
            });
            refineInfo.mvsViews = dv.length;
            scene.mvsCache = dv;
            refineInfo.mvsRemoved = dv.length >= 2 ? depthCarve(grid, dv, { minViews: opts.mvsMinViews ?? 2, log: opts.debugMvs ? log : null }) : 0;
            refineInfo.mvsMs = Date.now() - tm;
        }
        // colour consistency
        if (opts.refine && opts.colourRefine !== false) {
            const side = opts.refineSide || 480;
            const imgs = [];
            for (const i of reg) imgs.push(await getFrame(i, side));
            const col = prepColourViews(imgs, reg.map(i => ({ mask: labels[i], width, height })));
            const views = reg.map((i, k) => ({ R: poses[i].R, t: poses[i].t, f: sfm.f * col[k].width / width, width: col[k].width, height: col[k].height, rgb: col[k].rgb, gain: col[k].gain }));
            const r = colourCarve(grid, views, { threshold: opts.colourThreshold ?? 30, passes: opts.colourPasses ?? 8, maxTotalFrac: opts.colourMaxFrac ?? 0.1 });
            Object.assign(refineInfo, { colourRemoved: r.removed, colourPasses: r.passes, colourStopped: r.stopped });
        }
        const after = grid.occ.reduce((a, v) => a + v, 0);
        refineInfo.removedFrac = +(1 - after / Math.max(1, before)).toFixed(3);
        refineInfo.ms = Date.now() - tR;
        log(`refine: ${JSON.stringify(refineInfo)}`);
    };
    const out = await reconstructWithMasks({
        count: reg.length,
        getFrame: (k, side) => getFrame(reg[k], side),
        getMask: async (k) => ({ mask: labels[reg[k]], width, height }),
        poses: regPoses, f: sfm.f, fullWidth: width, fullHeight: height,
    }, {
        bounds, voxel, bgFrac: opts.bgFrac ?? 0.08, keepFrac: 0.15, skipBg: 5, colorSide: opts.colorSide || 960,
        smooth: opts.smooth ?? 4, onProgress: report, refineGrid: opts.refine || opts.mvs ? refineGrid : null,
    });
    // photo texture (sharp colours instead of one colour per vertex)
    let textured = null;
    if (opts.texture !== false) {
        const tt = Date.now();
        const small = [];
        for (const i of reg) small.push(await getFrame(i, 200));
        const gains = viewGains(small, reg.map(i => ({ mask: labels[i], width, height })));
        textured = await bakeTexture(out, reg.map(i => ({ R: poses[i].R, t: poses[i].t, f: sfm.f, width, height })), (k, side) => getFrame(reg[k], side), {
            atlasSize: opts.atlasSize || 2048, srcSide: opts.textureSide || 1280, gains, onProgress: report,
        });
        log(`texture: ${textured.charts} charts, ${(textured.textured * 100).toFixed(1)} % of the surface from photos, ${Date.now() - tt} ms`);
    }
    log(`fine grid voxel ${voxel.toFixed(2)} mm, total ${Date.now() - t0} ms`);
    return {
        ...out, textured,
        poses, registered: reg, f: sfm.f,
        info: { ...obj.info, ...sfm.stats, refine: refineInfo, ground, voxel, size: [2 * hx, 2 * hy, top], scale: obj.scale, shift, box: { ...box }, fitBox: fitBox(out.grid, voxel) },
        sfm, obj, scene,
    };
}
