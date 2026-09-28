// Evaluation helpers for the markerless tests.
import { svd3 } from '/src/sfm.js';

const camCenter = (p) => [
    -(p.R[0] * p.t[0] + p.R[3] * p.t[1] + p.R[6] * p.t[2]),
    -(p.R[1] * p.t[0] + p.R[4] * p.t[1] + p.R[7] * p.t[2]),
    -(p.R[2] * p.t[0] + p.R[5] * p.t[1] + p.R[8] * p.t[2]),
];
export { camCenter };

/** Similarity (s, R, t) with dst ≈ s·R·src + t (Umeyama 1991). */
export function umeyama(src, dst) {
    const n = src.length;
    const ms = [0, 1, 2].map(k => src.reduce((a, p) => a + p[k], 0) / n);
    const md = [0, 1, 2].map(k => dst.reduce((a, p) => a + p[k], 0) / n);
    const S = new Array(9).fill(0);
    let vs = 0;
    for (let i = 0; i < n; i++) {
        const a = [src[i][0] - ms[0], src[i][1] - ms[1], src[i][2] - ms[2]], b = [dst[i][0] - md[0], dst[i][1] - md[1], dst[i][2] - md[2]];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r * 3 + c] += b[r] * a[c] / n;
        vs += (a[0] ** 2 + a[1] ** 2 + a[2] ** 2) / n;
    }
    const r = svd3(S);
    // svd3 keeps U a rotation and puts the sign in the third singular value
    const sg = r.S[2] < 0 ? -1 : 1;
    const U = r.U.map((x, i) => (i % 3 === 2 ? x * sg : x)), sv = r.S.map(Math.abs), V = r.V;
    const detU = det(U), detV = det(V);
    const D = [1, 1, detU * detV < 0 ? -1 : 1];
    const R = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        let s = 0; for (let k = 0; k < 3; k++) s += U[r * 3 + k] * D[k] * V[c * 3 + k]; R[r * 3 + c] = s;
    }
    const s = (sv[0] * D[0] + sv[1] * D[1] + sv[2] * D[2]) / vs;
    const Rm = mv(R, ms);
    const t = [md[0] - s * Rm[0], md[1] - s * Rm[1], md[2] - s * Rm[2]];
    return { s, R, t };
}
const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
const mv = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
const mm = (A, B) => { const C = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; return C; };
const rotAngle = (R) => Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2))) * 180 / Math.PI;

/**
 * Compare estimated poses (any similarity frame) with ground truth.
 * Returns alignment (est ≈ s·R·gt + t) and errors.
 */
export function poseErrors(est, gt) {
    const idx = [];
    est.forEach((p, i) => { if (p && gt[i]) idx.push(i); });
    const Ce = idx.map(i => camCenter(est[i])), Cg = idx.map(i => camCenter(gt[i]));
    const A = umeyama(Cg, Ce);
    const dists = Cg.map(c => Math.hypot(...c));
    const dMed = dists.sort((a, b) => a - b)[dists.length >> 1];
    const posErr = idx.map((i, k) => {
        const p = mv(A.R, Cg[k]); const q = [A.s * p[0] + A.t[0], A.s * p[1] + A.t[1], A.s * p[2] + A.t[2]];
        return Math.hypot(q[0] - Ce[k][0], q[1] - Ce[k][1], q[2] - Ce[k][2]) / A.s; // in GT units (mm)
    });
    // rotation: R_gt ≈ R_est · A.R
    const rotErr = idx.map(i => {
        const Rt = mm(est[i].R, A.R);
        const G = gt[i].R;
        const Gt = [G[0], G[3], G[6], G[1], G[4], G[7], G[2], G[5], G[8]];
        return rotAngle(mm(Gt, Rt));
    });
    const med = (v) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
    return { align: A, n: idx.length, perFrame: idx.map((i, k) => [i, +posErr[k].toFixed(1), +rotErr[k].toFixed(2)]), posErrMedMm: med(posErr), posErrMaxMm: Math.max(...posErr), rotErrMedDeg: med(rotErr), rotErrMaxDeg: Math.max(...rotErr), camDistMm: dMed };
}

/** IoU between the carved grid (est frame) and the ground-truth object (gt frame). */
export function gridIoU(grid, align, gtInside, gtBox, step = 3) {
    const { occ, nx, ny, nz, origin, voxel } = grid;
    const pad = 0.3;
    const lo = gtBox[0].map((v, k) => v - (gtBox[1][k] - gtBox[0][k]) * pad), hi = gtBox[1].map((v, k) => v + (gtBox[1][k] - gtBox[0][k]) * pad);
    lo[2] = Math.max(lo[2], -40);
    const pts = [];
    for (let z = lo[2] + step / 2; z < hi[2]; z += step) for (let y = lo[1] + step / 2; y < hi[1]; y += step) for (let x = lo[0] + step / 2; x < hi[0]; x += step) pts.push([x, y, z]);
    const inGT = gtInside(pts);
    const toEst = (p) => { const q = mv(align.R, p); return [align.s * q[0] + align.t[0], align.s * q[1] + align.t[1], align.s * q[2] + align.t[2]]; };
    const occAt = (q) => {
        const i = Math.floor((q[0] - origin[0]) / voxel), j = Math.floor((q[1] - origin[1]) / voxel), k = Math.floor((q[2] - origin[2]) / voxel);
        return i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && occ[(k * ny + j) * nx + i] === 1;
    };
    let inter = 0, uni = 0, extra = 0, missing = 0, gtN = 0;
    pts.forEach((p, n) => {
        const a = occAt(toEst(p)), b = inGT[n];
        if (b) gtN++;
        if (a && b) inter++;
        if (a || b) uni++;
        if (a && !b) extra++;
        if (!a && b) missing++;
    });
    // estimated volume outside the sampled region (junk far away)
    const Rt = [align.R[0], align.R[3], align.R[6], align.R[1], align.R[4], align.R[7], align.R[2], align.R[5], align.R[8]];
    let outside = 0;
    const cellVol = (voxel / align.s) ** 3 / step ** 3;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (!occ[(k * ny + j) * nx + i]) continue;
        const q = [origin[0] + (i + 0.5) * voxel - align.t[0], origin[1] + (j + 0.5) * voxel - align.t[1], origin[2] + (k + 0.5) * voxel - align.t[2]];
        const g = mv(Rt, q).map(v => v / align.s);
        if (g[0] < lo[0] || g[1] < lo[1] || g[2] < lo[2] || g[0] > hi[0] || g[1] > hi[1] || g[2] > hi[2]) outside += cellVol;
    }
    uni += outside; extra += outside;
    return { iou: inter / uni, extraFrac: extra / gtN, missingFrac: missing / gtN, gtSamples: gtN };
}

/**
 * IoU after also fitting the model's size (scale about the GT object's
 * centre): the absolute size of a no-sheet scan is unknown anyway (the user
 * types the real length), so this measures the shape alone.
 */
export function gridIoUScaleFit(grid, align, gtInside, gtBox, step = 3) {
    const c = [(gtBox[0][0] + gtBox[1][0]) / 2, (gtBox[0][1] + gtBox[1][1]) / 2, 0];
    let best = null;
    for (const k of [0.84, 0.88, 0.92, 0.96, 1, 1.04, 1.08, 1.12, 1.16]) {
        // gt point p → est: align(c + (p - c) / k)
        const A2 = { s: align.s / k, R: align.R, t: null };
        const Rc = mv(align.R, c);
        A2.t = [0, 1, 2].map(i => align.t[i] + align.s * Rc[i] * (1 - 1 / k));
        const r = gridIoU(grid, A2, gtInside, gtBox, step);
        if (!best || r.iou > best.iou) best = { ...r, scale: k };
    }
    return best;
}

/** Fraction of a hollow (GT-frame test points) that the model left empty. */
export function hollowEmpty(grid, align, pts) {
    const { occ, nx, ny, nz, origin, voxel } = grid;
    let empty = 0;
    for (const p of pts) {
        const q = mv(align.R, p).map((v, k) => align.s * v + align.t[k]);
        const i = Math.floor((q[0] - origin[0]) / voxel), j = Math.floor((q[1] - origin[1]) / voxel), k = Math.floor((q[2] - origin[2]) / voxel);
        const inside = i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && occ[(k * ny + j) * nx + i] === 1;
        if (!inside) empty++;
    }
    return empty / pts.length;
}
