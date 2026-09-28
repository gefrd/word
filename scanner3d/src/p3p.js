// Camera pose from 3 point correspondences (Grunert's P3P, in the form of
// Haralick et al. 1994) and a RANSAC wrapper. Robust where starting from the
// neighbouring camera is not: flat, far-away surfaces have a "flipped" pose
// that fits almost as well, and local refinement can get stuck in it.

import { realRoots } from './fivepoint.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Rotation + translation with Q ≈ R·P + t from ≥ 3 point pairs (Kabsch). */
export function absoluteOrientation(P, Q, svd3) {
    const n = P.length;
    const mp = [0, 1, 2].map(k => P.reduce((s, p) => s + p[k], 0) / n);
    const mq = [0, 1, 2].map(k => Q.reduce((s, q) => s + q[k], 0) / n);
    const H = new Array(9).fill(0);
    for (let i = 0; i < n; i++) {
        const a = sub(P[i], mp), b = sub(Q[i], mq);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) H[r * 3 + c] += b[r] * a[c];
    }
    const { U, S, V } = svd3(H);
    // svd3 keeps U a proper rotation (the sign goes into S[2]); the Kabsch
    // reflection fix then reduces to making V proper as well
    void S;
    const d = [1, 1, det(V) < 0 ? -1 : 1];
    const R = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        let s = 0; for (let k = 0; k < 3; k++) s += U[r * 3 + k] * d[k] * V[c * 3 + k]; R[r * 3 + c] = s;
    }
    const Rm = [R[0] * mp[0] + R[1] * mp[1] + R[2] * mp[2], R[3] * mp[0] + R[4] * mp[1] + R[5] * mp[2], R[6] * mp[0] + R[7] * mp[1] + R[8] * mp[2]];
    return { R, t: [mq[0] - Rm[0], mq[1] - Rm[1], mq[2] - Rm[2]] };
}
const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/**
 * P3P. f: three unit bearing vectors (camera frame), X: three world points.
 * Returns up to 4 poses { R, t } with f_i ∝ R·X_i + t.
 */
export function p3p(f, X, svd3) {
    const a2 = dot(sub(X[1], X[2]), sub(X[1], X[2])), b2 = dot(sub(X[0], X[2]), sub(X[0], X[2])), c2 = dot(sub(X[0], X[1]), sub(X[0], X[1]));
    if (a2 < 1e-12 || b2 < 1e-12 || c2 < 1e-12) return [];
    const ca = dot(f[1], f[2]), cb = dot(f[0], f[2]), cg = dot(f[0], f[1]);
    // With s2 = u·s1, s3 = v·s1 the law of cosines gives two conics in
    // (u, v); eliminating u: u = N(v) / D(v) and
    //   N² − 2·cosγ·N·D + (1 − r·(1 + v² − 2v·cosβ))·D² = 0   (quartic in v)
    const q = (a2 - c2) / b2, r = c2 / b2;
    const Np = [1 + q, -2 * q * cb, q - 1];            // N(v), coefficients by power
    const Dp = [2 * cg, -2 * ca];                       // D(v)
    const mul = (x, y) => { const o = new Array(x.length + y.length - 1).fill(0); x.forEach((xi, i) => y.forEach((yj, j) => { o[i + j] += xi * yj; })); return o; };
    const add = (...ps) => { const o = new Array(Math.max(...ps.map(p => p.length))).fill(0); ps.forEach(p => p.forEach((v, i) => { o[i] += v; })); return o; };
    const quartic = add(mul(Np, Np), mul([-2 * cg], mul(Np, Dp)), mul([1 - r, 2 * r * cb, -r], mul(Dp, Dp)));
    const out = [];
    for (const v of realRoots(quartic)) {
        if (v <= 0) continue;
        const den = 2 * (cg - v * ca);
        if (Math.abs(den) < 1e-12) continue;
        const u = (Np[0] + Np[1] * v + Np[2] * v * v) / den;
        if (u <= 0) continue;
        const s1sq = c2 / (1 + u * u - 2 * u * cg);
        if (!(s1sq > 0)) continue;
        const s1 = Math.sqrt(s1sq), s2 = u * s1, s3 = v * s1;
        const Q = [f[0].map(x => x * s1), f[1].map(x => x * s2), f[2].map(x => x * s3)];
        out.push(absoluteOrientation(X, Q, svd3));
    }
    return out;
}

/**
 * RANSAC over P3P. pts: Float64Array xyz…, obs: pixel offsets from the
 * principal point (u, v)…, f: focal (px). Returns { R, t, inliers } or null.
 */
export function pnpRansac(pts, obs, f, thrPx, svd3, opts = {}) {
    const n = pts.length / 3;
    if (n < 6) return null;
    const bear = new Array(n);
    for (let k = 0; k < n; k++) {
        const x = obs[2 * k] / f, y = obs[2 * k + 1] / f, l = Math.hypot(x, y, 1);
        bear[k] = [x / l, y / l, 1 / l];
    }
    const X = (k) => [pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]];
    const thr2 = thrPx * thrPx;
    const count = (R, t) => {
        let c = 0;
        for (let k = 0; k < n; k++) {
            const px = pts[3 * k], py = pts[3 * k + 1], pz = pts[3 * k + 2];
            const z = R[6] * px + R[7] * py + R[8] * pz + t[2];
            if (z <= 0) continue;
            const du = f * (R[0] * px + R[1] * py + R[2] * pz + t[0]) / z - obs[2 * k], dv = f * (R[3] * px + R[4] * py + R[5] * pz + t[1]) / z - obs[2 * k + 1];
            if (du * du + dv * dv < thr2) c++;
        }
        return c;
    };
    let rng = opts.seed || 4242, best = null, bestN = 0;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    let N = opts.maxIter || 300;
    for (let it = 0; it < N; it++) {
        const s = [];
        while (s.length < 3) { const k = Math.floor(rand() * n); if (!s.includes(k)) s.push(k); }
        for (const pose of p3p(s.map(k => bear[k]), s.map(X), svd3)) {
            const c = count(pose.R, pose.t);
            if (c > bestN) {
                bestN = c; best = pose;
                const w = c / n;
                N = Math.min(opts.maxIter || 300, Math.max(30, Math.ceil(Math.log(0.001) / Math.log(Math.max(1e-9, 1 - w * w * w)))));
            }
        }
    }
    return best ? { ...best, inliers: bestN } : null;
}
