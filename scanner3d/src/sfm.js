// Structure from motion for the no-sheet scan.
//
// Input: per-frame features (features.js) found only on the object (inside
// the AI mask). Output: a camera pose for every frame it could place, a
// shared focal length and a sparse point cloud — all in an arbitrary
// similarity frame (unknown scale), which markerless.js turns into an
// object-centred frame.
//
// Pipeline: pairwise matching of nearby frames → essential-matrix RANSAC
// (8-point, normalised coordinates) → tracks → initial pair → incremental
// registration (pose from the best registered neighbour, robust
// Gauss-Newton on 2D-3D matches) → triangulation → sparse bundle adjustment
// (Levenberg–Marquardt, Schur complement, shared focal with a weak prior)
// → loop closure (match frames that look at the same side) → final BA.
//
// Camera convention as everywhere in the app: Xc = R·Xw + t (R row-major),
// u = f·Xc/Zc + cx, v = f·Yc/Zc + cy.

import { rodriguesToMat } from './geometry.js';
import { matchFeatures } from './features.js';
import { fivePoint } from './fivepoint.js';
import { pnpRansac } from './p3p.js';

// ---------------------------------------------------------------------
// Small dense linear algebra
// ---------------------------------------------------------------------

/** Symmetric eigen-decomposition (cyclic Jacobi). Columns of `vectors` are eigenvectors, ascending values. */
export function eigenSym(Ain, n) {
    const A = Float64Array.from(Ain);
    const V = new Float64Array(n * n);
    for (let i = 0; i < n; i++) V[i * n + i] = 1;
    for (let sweep = 0; sweep < 60; sweep++) {
        let off = 0, tot = 0;
        for (let p = 0; p < n; p++) for (let q = 0; q < n; q++) { const a = A[p * n + q] * A[p * n + q]; tot += a; if (p !== q) off += a; }
        if (off <= 1e-24 * tot || off < 1e-300) break;
        for (let p = 0; p < n - 1; p++) {
            for (let q = p + 1; q < n; q++) {
                const apq = A[p * n + q];
                if (Math.abs(apq) < 1e-300) continue;
                const theta = (A[q * n + q] - A[p * n + p]) / (2 * apq);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1), s = t * c;
                for (let k = 0; k < n; k++) {
                    const akp = A[k * n + p], akq = A[k * n + q];
                    A[k * n + p] = c * akp - s * akq; A[k * n + q] = s * akp + c * akq;
                }
                for (let k = 0; k < n; k++) {
                    const apk = A[p * n + k], aqk = A[q * n + k];
                    A[p * n + k] = c * apk - s * aqk; A[q * n + k] = s * apk + c * aqk;
                }
                for (let k = 0; k < n; k++) {
                    const vkp = V[k * n + p], vkq = V[k * n + q];
                    V[k * n + p] = c * vkp - s * vkq; V[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => A[a * n + a] - A[b * n + b]);
    const values = new Float64Array(n), vectors = new Float64Array(n * n);
    order.forEach((src, dst) => {
        values[dst] = A[src * n + src];
        for (let k = 0; k < n; k++) vectors[k * n + dst] = V[k * n + src];
    });
    return { values, vectors };
}

/** Smallest-eigenvalue eigenvector of a symmetric n×n matrix. */
function nullVector(AtA, n) {
    const { vectors } = eigenSym(AtA, n);
    const v = new Float64Array(n);
    for (let k = 0; k < n; k++) v[k] = vectors[k * n];
    return v;
}

const mul3 = (A, B) => {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return C;
};
const tr3 = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const mv3 = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrm = (a) => Math.hypot(a[0], a[1], a[2]);

/** SVD of a 3×3 matrix: M = U·diag(S)·Vᵀ, S descending. */
export function svd3(M) {
    const MtM = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) MtM[i * 3 + j] = M[i] * M[j] + M[3 + i] * M[3 + j] + M[6 + i] * M[6 + j];
    const { values, vectors } = eigenSym(MtM, 3);
    const v = [2, 1, 0].map(k => [vectors[k], vectors[3 + k], vectors[6 + k]]);
    const S = [2, 1, 0].map(k => Math.sqrt(Math.max(0, values[k])));
    const u = [];
    for (let k = 0; k < 2; k++) {
        let x = mv3(M, v[k]);
        if (k === 1) { const d = dot(x, u[0]); x = [x[0] - d * u[0][0], x[1] - d * u[0][1], x[2] - d * u[0][2]]; }
        const l = nrm(x);
        u.push(l > 1e-15 ? x.map(a => a / l) : (k === 0 ? [1, 0, 0] : anyPerp(u[0])));
    }
    u.push(cross(u[0], u[1]));
    const U = [u[0][0], u[1][0], u[2][0], u[0][1], u[1][1], u[2][1], u[0][2], u[1][2], u[2][2]];
    const V = [v[0][0], v[1][0], v[2][0], v[0][1], v[1][1], v[2][1], v[0][2], v[1][2], v[2][2]];
    // third singular value keeps its sign relation: M v3 = s3 u3 (s3 may need a sign)
    const mv = mv3(M, v[2]);
    if (dot(mv, u[2]) < 0) S[2] = -S[2];
    return { U, S, V };
}

function anyPerp(a) {
    const b = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const c = cross(a, b), l = nrm(c);
    return c.map(x => x / l);
}

/** In-place Cholesky solve of dense SPD system A x = b (A n×n Float64Array). Returns null if not PD. */
function choleskySolve(A, b, n) {
    const L = A; // overwrite
    for (let j = 0; j < n; j++) {
        let s = L[j * n + j];
        for (let k = 0; k < j; k++) s -= L[j * n + k] * L[j * n + k];
        if (!(s > 0)) return null;
        const d = Math.sqrt(s);
        L[j * n + j] = d;
        for (let i = j + 1; i < n; i++) {
            let t = L[i * n + j];
            for (let k = 0; k < j; k++) t -= L[i * n + k] * L[j * n + k];
            L[i * n + j] = t / d;
        }
    }
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
        y[i] = s / L[i * n + i];
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = y[i];
        for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
        x[i] = s / L[i * n + i];
    }
    return x;
}

function inv3sym(a, b, c, d, e, f) {
    // [[a b c][b d e][c e f]]
    const A = d * f - e * e, B = c * e - b * f, C = b * e - c * d;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-30) return null;
    const D = a * f - c * c, E = b * c - a * e, F = a * d - b * b;
    return [A / det, B / det, C / det, D / det, E / det, F / det]; // same packing
}

// ---------------------------------------------------------------------
// Two-view geometry
// ---------------------------------------------------------------------

/** Essential matrix from ≥ 8 normalised correspondences (least squares, Hartley-conditioned). */
function eightPoint(p1, p2, idx) {
    // condition each point set: centroid to 0, mean distance √2
    const cond = (p) => {
        let mx = 0, my = 0;
        for (const k of idx) { mx += p[2 * k]; my += p[2 * k + 1]; }
        mx /= idx.length; my /= idx.length;
        let d = 0;
        for (const k of idx) d += Math.hypot(p[2 * k] - mx, p[2 * k + 1] - my);
        const s = d > 0 ? Math.SQRT2 * idx.length / d : 1;
        return [s, mx, my];
    };
    const [s1, m1x, m1y] = cond(p1), [s2, m2x, m2y] = cond(p2);
    const AtA = new Float64Array(81);
    const row = new Float64Array(9);
    for (const k of idx) {
        const x1 = (p1[2 * k] - m1x) * s1, y1 = (p1[2 * k + 1] - m1y) * s1, x2 = (p2[2 * k] - m2x) * s2, y2 = (p2[2 * k + 1] - m2y) * s2;
        row[0] = x2 * x1; row[1] = x2 * y1; row[2] = x2; row[3] = y2 * x1; row[4] = y2 * y1; row[5] = y2; row[6] = x1; row[7] = y1; row[8] = 1;
        for (let i = 0; i < 9; i++) { const ri = row[i]; for (let j = i; j < 9; j++) AtA[i * 9 + j] += ri * row[j]; }
    }
    for (let i = 0; i < 9; i++) for (let j = 0; j < i; j++) AtA[i * 9 + j] = AtA[j * 9 + i];
    const e = nullVector(AtA, 9);
    // undo conditioning: E = T2ᵀ · Fn · T1
    const T1 = [s1, 0, -s1 * m1x, 0, s1, -s1 * m1y, 0, 0, 1], T2 = [s2, 0, -s2 * m2x, 0, s2, -s2 * m2y, 0, 0, 1];
    const E0 = mul3(mul3(tr3(T2), Array.from(e)), T1);
    // project onto the essential manifold: singular values (1, 1, 0)
    const { U, V } = svd3(E0);
    return mul3(mul3(U, [1, 0, 0, 0, 1, 0, 0, 0, 0]), tr3(V));
}

function sampson(E, x1, y1, x2, y2) {
    const a0 = E[0] * x1 + E[1] * y1 + E[2], a1 = E[3] * x1 + E[4] * y1 + E[5], a2 = E[6] * x1 + E[7] * y1 + E[8];
    const b0 = E[0] * x2 + E[3] * y2 + E[6], b1 = E[1] * x2 + E[4] * y2 + E[7];
    const num = x2 * a0 + y2 * a1 + a2;
    return num * num / (a0 * a0 + a1 * a1 + b0 * b0 + b1 * b1 + 1e-30);
}

/** Linear triangulation of one point seen by n cameras; P[k] = 3×4 row-major (normalised coords). */
function triangulateDLT(Ps, xs) {
    const AtA = new Float64Array(16);
    const add = (r) => { for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) AtA[i * 4 + j] += r[i] * r[j]; };
    for (let k = 0; k < Ps.length; k++) {
        const P = Ps[k], x = xs[2 * k], y = xs[2 * k + 1];
        add([x * P[8] - P[0], x * P[9] - P[1], x * P[10] - P[2], x * P[11] - P[3]]);
        add([y * P[8] - P[4], y * P[9] - P[5], y * P[10] - P[6], y * P[11] - P[7]]);
    }
    const X = nullVector(AtA, 4);
    if (Math.abs(X[3]) < 1e-12) return null;
    return [X[0] / X[3], X[1] / X[3], X[2] / X[3]];
}

const Pmat = (R, t) => [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2]];

/** Pick the (R, t) of an essential matrix that puts the most points in front of both cameras. */
function poseFromE(E, p1, p2, idx) {
    let { U, V } = svd3(E);
    if (det3(U) < 0) U = U.map((x, i) => (i % 3 === 2 ? -x : x));
    if (det3(V) < 0) V = V.map((x, i) => (i % 3 === 2 ? -x : x));
    const W = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    const Vt = tr3(V);
    const Ra = mul3(mul3(U, W), Vt), Rb = mul3(mul3(U, tr3(W)), Vt);
    const u3 = [U[2], U[5], U[8]];
    const sample = idx.length > 120 ? idx.filter((_, i) => i % Math.ceil(idx.length / 120) === 0) : idx;
    let best = null;
    const P1 = Pmat([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]);
    for (const R of [Ra, Rb]) for (const s of [1, -1]) {
        const t = u3.map(x => x * s);
        const P2 = Pmat(R, t);
        let good = 0;
        for (const k of sample) {
            const X = triangulateDLT([P1, P2], [p1[2 * k], p1[2 * k + 1], p2[2 * k], p2[2 * k + 1]]);
            if (!X) continue;
            const z2 = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
            if (X[2] > 0 && z2 > 0) good++;
        }
        if (!best || good > best.good) best = { R, t, good };
    }
    return best;
}

/** Signed Sampson distance residuals for (R, t). */
function sampsonResiduals(R, t, p1, p2, idx, out) {
    const E = mul3([0, -t[2], t[1], t[2], 0, -t[0], -t[1], t[0], 0], R);
    for (let q = 0; q < idx.length; q++) {
        const k = idx[q], x1 = p1[2 * k], y1 = p1[2 * k + 1], x2 = p2[2 * k], y2 = p2[2 * k + 1];
        const a0 = E[0] * x1 + E[1] * y1 + E[2], a1 = E[3] * x1 + E[4] * y1 + E[5], a2 = E[6] * x1 + E[7] * y1 + E[8];
        const b0 = E[0] * x2 + E[3] * y2 + E[6], b1 = E[1] * x2 + E[4] * y2 + E[7];
        out[q] = (x2 * a0 + y2 * a1 + a2) / Math.sqrt(a0 * a0 + a1 * a1 + b0 * b0 + b1 * b1 + 1e-30);
    }
    return out;
}

/** Levenberg–Marquardt on the essential manifold (rotation + unit translation), Cauchy loss. */
function refineRelative(R0, t0, p1, p2, idx, sigma, iters = 10) {
    let R = R0.slice(), t = t0.slice();
    const n = idx.length, r = new Float64Array(n), r2 = new Float64Array(n);
    const cost = (res) => { let c = 0; for (let q = 0; q < n; q++) c += Math.log1p(res[q] * res[q] / (sigma * sigma)); return c; };
    const apply = (Rc, tc, d) => {
        const b1 = anyPerp(tc), b2 = cross(tc, b1);
        const tn = [tc[0] + d[3] * b1[0] + d[4] * b2[0], tc[1] + d[3] * b1[1] + d[4] * b2[1], tc[2] + d[3] * b1[2] + d[4] * b2[2]];
        const l = nrm(tn);
        return [mul3(rodriguesToMat([d[0], d[1], d[2]]), Rc), tn.map(x => x / l)];
    };
    sampsonResiduals(R, t, p1, p2, idx, r);
    let c0 = cost(r), lambda = 1e-3;
    for (let it = 0; it < iters; it++) {
        const w = new Float64Array(n);
        for (let q = 0; q < n; q++) w[q] = 1 / (1 + r[q] * r[q] / (sigma * sigma));
        const J = [];
        for (let k = 0; k < 5; k++) {
            const d = [0, 0, 0, 0, 0]; d[k] = 1e-6;
            const [Rk, tk] = apply(R, t, d);
            sampsonResiduals(Rk, tk, p1, p2, idx, r2);
            J.push(Float64Array.from(r2, (v, q) => (v - r[q]) / 1e-6));
        }
        const H = new Float64Array(25), g = new Float64Array(5);
        for (let a = 0; a < 5; a++) {
            for (let q = 0; q < n; q++) g[a] += w[q] * J[a][q] * r[q];
            for (let b = a; b < 5; b++) { let s = 0; for (let q = 0; q < n; q++) s += w[q] * J[a][q] * J[b][q]; H[a * 5 + b] = H[b * 5 + a] = s; }
        }
        let improved = false;
        for (let tries = 0; tries < 6; tries++) {
            const A = Float64Array.from(H);
            for (let i = 0; i < 5; i++) A[i * 5 + i] = A[i * 5 + i] * (1 + lambda) + 1e-15;
            const d = choleskySolve(A, g.map(x => -x), 5);
            if (!d) { lambda *= 10; continue; }
            const [Rn, tn] = apply(R, t, d);
            sampsonResiduals(Rn, tn, p1, p2, idx, r2);
            const c1 = cost(r2);
            if (c1 < c0) { R = Rn; t = tn; r.set(r2); const gain = c0 - c1; c0 = c1; lambda = Math.max(1e-9, lambda / 5); improved = true; if (gain < 1e-8 * c0) it = iters; break; }
            lambda *= 10;
        }
        if (!improved) break;
    }
    return { R, t };
}

/**
 * Robust relative pose between two frames: 5-point RANSAC (MSAC scoring),
 * cheirality, then nonlinear refinement on the inliers.
 * p1, p2: Float64Array of normalised coords (x, y) per match.
 * thr: inlier threshold in normalised units (pixels / f).
 */
export function relativePose(p1, p2, thr, opts = {}) {
    const n = p1.length / 2;
    if (n < 12) return null;
    const thr2 = thr * thr;
    const maxIter = opts.maxIter || 400, minIter = opts.minIter || 60;
    let rng = opts.seed || 12345;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    let best = null, bestScore = Infinity, bestCount = 0;
    let N = maxIter;
    const x1 = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], x2 = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
    const sample = [];
    for (let it = 0; it < Math.max(N, minIter) && it < maxIter; it++) {
        sample.length = 0;
        while (sample.length < 5) { const k = Math.floor(rand() * n); if (!sample.includes(k)) sample.push(k); }
        for (let s = 0; s < 5; s++) { const k = sample[s]; x1[s][0] = p1[2 * k]; x1[s][1] = p1[2 * k + 1]; x2[s][0] = p2[2 * k]; x2[s][1] = p2[2 * k + 1]; }
        for (const E of fivePoint(x1, x2)) {
            let score = 0, count = 0;
            for (let k = 0; k < n; k++) {
                const e = sampson(E, p1[2 * k], p1[2 * k + 1], p2[2 * k], p2[2 * k + 1]);
                if (e < thr2) { score += e; count++; } else score += thr2;
                if (score >= bestScore) break;
            }
            if (score < bestScore) {
                bestScore = score; best = E; bestCount = count;
                const w = count / n;
                N = Math.ceil(Math.log(0.001) / Math.log(Math.max(1e-9, 1 - Math.pow(w, 5))));
            }
        }
    }
    if (!best || bestCount < 12) return null;
    let inl = [];
    for (let k = 0; k < n; k++) if (sampson(best, p1[2 * k], p1[2 * k + 1], p2[2 * k], p2[2 * k + 1]) < thr2) inl.push(k);
    const pose = poseFromE(best, p1, p2, inl);
    if (!pose) return null;
    // refine on a generous inlier set, then re-select inliers
    const loose = [];
    for (let k = 0; k < n; k++) if (sampson(best, p1[2 * k], p1[2 * k + 1], p2[2 * k], p2[2 * k + 1]) < 4 * thr2) loose.push(k);
    const ref = refineRelative(pose.R, pose.t, p1, p2, loose, thr);
    const res = new Float64Array(n);
    sampsonResiduals(ref.R, ref.t, p1, p2, Array.from({ length: n }, (_, k) => k), res);
    inl = [];
    for (let k = 0; k < n; k++) if (res[k] * res[k] < thr2) inl.push(k);
    if (inl.length < 8) return null;
    // Parallax: median angle between the rotation-compensated rays.
    const angles = [];
    for (const k of inl) {
        const a = mv3(ref.R, [p1[2 * k], p1[2 * k + 1], 1]), b = [p2[2 * k], p2[2 * k + 1], 1];
        angles.push(Math.acos(Math.min(1, dot(a, b) / (nrm(a) * nrm(b)))));
    }
    angles.sort((a, b) => a - b);
    const E = mul3([0, -ref.t[2], ref.t[1], ref.t[2], 0, -ref.t[0], -ref.t[1], ref.t[0], 0], ref.R);
    return { E, R: ref.R, t: ref.t, inliers: inl, cheirality: pose.good, parallax: angles[angles.length >> 1] || 0 };
}

/**
 * Up to `k` distinct relative-pose hypotheses for a pair (best first).
 * Near-planar views admit two poses that fit equally well; a third view
 * decides (see the initial-pair search in runSfM).
 */
export function poseHypotheses(p1, p2, thr, k = 3, seed = 99) {
    const n = p1.length / 2;
    if (n < 12) return [];
    const thr2 = thr * thr;
    let rng = seed;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    const pool = [];
    const x1 = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], x2 = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
    for (let it = 0; it < 250; it++) {
        const smp = [];
        while (smp.length < 5) { const q = Math.floor(rand() * n); if (!smp.includes(q)) smp.push(q); }
        for (let s = 0; s < 5; s++) { const q = smp[s]; x1[s][0] = p1[2 * q]; x1[s][1] = p1[2 * q + 1]; x2[s][0] = p2[2 * q]; x2[s][1] = p2[2 * q + 1]; }
        for (const E of fivePoint(x1, x2)) {
            let score = 0;
            for (let q = 0; q < n; q++) score += Math.min(thr2, sampson(E, p1[2 * q], p1[2 * q + 1], p2[2 * q], p2[2 * q + 1]));
            pool.push({ E, score });
        }
    }
    pool.sort((a, b) => a.score - b.score);
    const out = [];
    for (const h of pool.slice(0, 60)) {
        const inl = [];
        for (let q = 0; q < n; q++) if (sampson(h.E, p1[2 * q], p1[2 * q + 1], p2[2 * q], p2[2 * q + 1]) < thr2) inl.push(q);
        if (inl.length < 12) continue;
        const pose = poseFromE(h.E, p1, p2, inl);
        if (!pose) continue;
        const ref = refineRelative(pose.R, pose.t, p1, p2, inl, thr);
        const dup = out.some(o => {
            const D = mul3(tr3(o.R), ref.R);
            const ang = Math.acos(Math.max(-1, Math.min(1, (D[0] + D[4] + D[8] - 1) / 2)));
            return ang < 3 * Math.PI / 180 && dot(o.t, ref.t) > 0.97;
        });
        if (dup) continue;
        out.push({ R: ref.R, t: ref.t, n: inl.length });
        if (out.length >= k) break;
    }
    return out;
}

/** Homography inlier count (to spot near-planar or pure-rotation pairs). */
function homographyInliers(p1, p2, thr, iters = 200) {
    const n = p1.length / 2;
    if (n < 8) return 0;
    let rng = 777, best = 0;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    for (let it = 0; it < iters; it++) {
        const s = [];
        while (s.length < 4) { const k = Math.floor(rand() * n); if (!s.includes(k)) s.push(k); }
        const H = homography4(s.map(k => [p1[2 * k], p1[2 * k + 1]]), s.map(k => [p2[2 * k], p2[2 * k + 1]]));
        if (!H) continue;
        let c = 0;
        for (let k = 0; k < n; k++) {
            const x = p1[2 * k], y = p1[2 * k + 1];
            const w = H[6] * x + H[7] * y + H[8];
            const u = (H[0] * x + H[1] * y + H[2]) / w - p2[2 * k], v = (H[3] * x + H[4] * y + H[5]) / w - p2[2 * k + 1];
            if (u * u + v * v < thr * thr * 4) c++;
        }
        if (c > best) best = c;
    }
    return best;
}

function homography4(src, dst) {
    const AtA = new Float64Array(81);
    const add = (r) => { for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) AtA[i * 9 + j] += r[i] * r[j]; };
    for (let k = 0; k < 4; k++) {
        const [x, y] = src[k], [u, v] = dst[k];
        add([x, y, 1, 0, 0, 0, -u * x, -u * y, -u]);
        add([0, 0, 0, x, y, 1, -v * x, -v * y, -v]);
    }
    const h = nullVector(AtA, 9);
    return Math.abs(h[8]) < 1e-12 ? null : Array.from(h, x => x / h[8]);
}

// ---------------------------------------------------------------------
// Robust pose of one camera from 2D-3D matches (Gauss-Newton + Cauchy)
// ---------------------------------------------------------------------

function refineCameraPose(R, t, f, pts3, obs, sigma, iters = 12) {
    // obs: pixel offsets from the principal point (u, v), pts3: [x,y,z,...]
    const n = pts3.length / 3;
    let cur = { R: R.slice(), t: t.slice() };
    const cost = (P) => {
        let c = 0;
        for (let k = 0; k < n; k++) {
            const X = pts3[3 * k], Y = pts3[3 * k + 1], Z = pts3[3 * k + 2];
            const xc = P.R[0] * X + P.R[1] * Y + P.R[2] * Z + P.t[0], yc = P.R[3] * X + P.R[4] * Y + P.R[5] * Z + P.t[1], zc = P.R[6] * X + P.R[7] * Y + P.R[8] * Z + P.t[2];
            if (zc <= 1e-9) { c += 25; continue; }
            const du = f * xc / zc - obs[2 * k], dv = f * yc / zc - obs[2 * k + 1];
            c += Math.log1p((du * du + dv * dv) / (sigma * sigma));
        }
        return c;
    };
    let c0 = cost(cur), lambda = 1e-3;
    for (let it = 0; it < iters; it++) {
        const H = new Float64Array(36), g = new Float64Array(6);
        for (let k = 0; k < n; k++) {
            const X = pts3[3 * k], Y = pts3[3 * k + 1], Z = pts3[3 * k + 2];
            const ax = cur.R[0] * X + cur.R[1] * Y + cur.R[2] * Z, ay = cur.R[3] * X + cur.R[4] * Y + cur.R[5] * Z, az = cur.R[6] * X + cur.R[7] * Y + cur.R[8] * Z;
            const xc = ax + cur.t[0], yc = ay + cur.t[1], zc = az + cur.t[2];
            if (zc <= 1e-9) continue;
            const iz = 1 / zc;
            const du = f * xc * iz - obs[2 * k], dv = f * yc * iz - obs[2 * k + 1];
            const w = 1 / (1 + (du * du + dv * dv) / (sigma * sigma)); // Cauchy IRLS weight
            // d(u,v)/dXc
            const ux = f * iz, uz = -f * xc * iz * iz, vy = f * iz, vz = -f * yc * iz * iz;
            // dXc/dδ = -[a]×, a = R X ; dXc/dt = I
            const Ju = [ux * 0 + uz * ay, ux * az + uz * (-ax), ux * (-ay) + 0, ux, 0, uz];
            const Jv = [vy * (-az) + vz * ay, vz * (-ax), vy * ax, 0, vy, vz];
            // (derivation: -[a]× = [[0, az, -ay], [-az, 0, ax], [ay, -ax, 0]])
            for (let i = 0; i < 6; i++) {
                g[i] += w * (Ju[i] * du + Jv[i] * dv);
                for (let j = i; j < 6; j++) H[i * 6 + j] += w * (Ju[i] * Ju[j] + Jv[i] * Jv[j]);
            }
        }
        for (let i = 0; i < 6; i++) for (let j = 0; j < i; j++) H[i * 6 + j] = H[j * 6 + i];
        let improved = false;
        for (let tries = 0; tries < 6; tries++) {
            const A = Float64Array.from(H);
            for (let i = 0; i < 6; i++) A[i * 6 + i] *= 1 + lambda, A[i * 6 + i] += 1e-12;
            const d = choleskySolve(A, g.map(x => -x), 6);
            if (!d) { lambda *= 10; continue; }
            const next = { R: mul3(rodriguesToMat([d[0], d[1], d[2]]), cur.R), t: [cur.t[0] + d[3], cur.t[1] + d[4], cur.t[2] + d[5]] };
            const c1 = cost(next);
            if (c1 < c0) { cur = next; const gain = c0 - c1; c0 = c1; lambda = Math.max(1e-7, lambda / 4); improved = true; if (gain < 1e-6 * c0) it = iters; break; }
            lambda *= 8;
        }
        if (!improved) break;
    }
    return cur;
}

// ---------------------------------------------------------------------
// Bundle adjustment
// ---------------------------------------------------------------------

/**
 * Sparse LM bundle adjustment over all registered cameras and triangulated
 * points (in place). Huber loss (delta px). Optional shared focal with a
 * Gaussian prior (fPrior = { f0, sigma }).
 */
export function bundleAdjust(S, opts = {}) {
    const { cams, points } = S;
    const iters = opts.iters || 12, delta = opts.huber || 2.0;
    const optF = !!opts.optimizeF;
    const fixed = opts.fixed ?? S.fixedCam;
    // parameter layout
    const camSlot = new Int32Array(cams.length).fill(-1);
    let nc = 0;
    cams.forEach((c, i) => { if (c && i !== fixed) camSlot[i] = nc++; });
    const fSlot = optF ? nc * 6 : -1;
    const ny = nc * 6 + (optF ? 1 : 0);
    // observations
    const oCam = [], oPt = [], oU = [], oV = [];
    const ptList = [];
    for (let p = 0; p < points.length; p++) {
        const P = points[p];
        if (!P.X) continue;
        let cnt = 0;
        for (let k = 0; k < P.obs.length; k += 2) if (cams[P.obs[k]]) cnt++;
        if (cnt < 2) continue;
        const pi = ptList.length;
        ptList.push(p);
        for (let k = 0; k < P.obs.length; k += 2) {
            const c = P.obs[k];
            if (!cams[c]) continue;
            const F = S.frames[c].feat, j = P.obs[k + 1];
            oCam.push(c); oPt.push(pi); oU.push(F.x[j] - S.cx); oV.push(F.y[j] - S.cy);
        }
    }
    const nobs = oCam.length, np = ptList.length;
    if (!np || ny === 0) return { rms: 0 };
    const X = new Float64Array(np * 3);
    ptList.forEach((p, i) => { X[3 * i] = points[p].X[0]; X[3 * i + 1] = points[p].X[1]; X[3 * i + 2] = points[p].X[2]; });
    let camR = cams.map(c => c && c.R.slice()), camT = cams.map(c => c && c.t.slice()), f = S.f;
    const fPrior = opts.fPrior;

    const residualCost = (cR, cT, XX, ff) => {
        let c = 0;
        for (let o = 0; o < nobs; o++) {
            const R = cR[oCam[o]], t = cT[oCam[o]], p = oPt[o] * 3;
            const xc = R[0] * XX[p] + R[1] * XX[p + 1] + R[2] * XX[p + 2] + t[0];
            const yc = R[3] * XX[p] + R[4] * XX[p + 1] + R[5] * XX[p + 2] + t[1];
            const zc = R[6] * XX[p] + R[7] * XX[p + 1] + R[8] * XX[p + 2] + t[2];
            let e2;
            if (zc <= 1e-9) e2 = 1e4; else { const du = ff * xc / zc - oU[o], dv = ff * yc / zc - oV[o]; e2 = du * du + dv * dv; }
            const e = Math.sqrt(e2);
            c += e <= delta ? e2 : 2 * delta * e - delta * delta;
        }
        if (optF && fPrior) c += ((ff - fPrior.f0) / fPrior.sigma) ** 2;
        return c;
    };

    let cost = residualCost(camR, camT, X, f);
    let lambda = opts.lambda || 1e-4;
    // per-observation blocks
    const Jy = new Float64Array(nobs * 14);  // 2 rows × 7 (6 cam + f)
    const Jp = new Float64Array(nobs * 6);   // 2 rows × 3
    const Res = new Float64Array(nobs * 2), Wt = new Float64Array(nobs);
    for (let it = 0; it < iters; it++) {
        // --- linearise
        for (let o = 0; o < nobs; o++) {
            const R = camR[oCam[o]], t = camT[oCam[o]], p = oPt[o] * 3;
            const ax = R[0] * X[p] + R[1] * X[p + 1] + R[2] * X[p + 2], ay = R[3] * X[p] + R[4] * X[p + 1] + R[5] * X[p + 2], az = R[6] * X[p] + R[7] * X[p + 1] + R[8] * X[p + 2];
            const xc = ax + t[0], yc = ay + t[1], zc = az + t[2];
            if (zc <= 1e-9) { Wt[o] = 0; continue; }
            const iz = 1 / zc;
            const du = f * xc * iz - oU[o], dv = f * yc * iz - oV[o];
            const e = Math.hypot(du, dv);
            Wt[o] = e <= delta ? 1 : delta / e;
            Res[2 * o] = du; Res[2 * o + 1] = dv;
            const ux = f * iz, uz = -f * xc * iz * iz, vy = f * iz, vz = -f * yc * iz * iz;
            const b = o * 14;
            // rotation (left perturbation): dXc/dδ = [[0, az, -ay], [-az, 0, ax], [ay, -ax, 0]]
            Jy[b] = uz * ay; Jy[b + 1] = ux * az - uz * ax; Jy[b + 2] = -ux * ay; Jy[b + 3] = ux; Jy[b + 4] = 0; Jy[b + 5] = uz; Jy[b + 6] = xc * iz;
            Jy[b + 7] = -vy * az + vz * ay; Jy[b + 8] = -vz * ax; Jy[b + 9] = vy * ax; Jy[b + 10] = 0; Jy[b + 11] = vy; Jy[b + 12] = vz; Jy[b + 13] = yc * iz;
            // point: d/dX = d/dXc · R
            const q = o * 6;
            Jp[q] = ux * R[0] + uz * R[6]; Jp[q + 1] = ux * R[1] + uz * R[7]; Jp[q + 2] = ux * R[2] + uz * R[8];
            Jp[q + 3] = vy * R[3] + vz * R[6]; Jp[q + 4] = vy * R[4] + vz * R[7]; Jp[q + 5] = vy * R[5] + vz * R[8];
        }
        // group observations by point
        const byPt = Array.from({ length: np }, () => []);
        for (let o = 0; o < nobs; o++) if (Wt[o] > 0) byPt[oPt[o]].push(o);
        // point blocks
        const Hpp = new Float64Array(np * 6), bp = new Float64Array(np * 3);
        const Hyy = new Float64Array(ny * ny), by = new Float64Array(ny);
        const slots = (o) => {
            const s = camSlot[oCam[o]];
            const out = [];
            if (s >= 0) for (let k = 0; k < 6; k++) out.push([s * 6 + k, k]);
            if (optF) out.push([fSlot, 6]);
            return out;
        };
        const obsSlots = new Array(nobs);
        for (let o = 0; o < nobs; o++) {
            const w = Wt[o];
            if (!w) continue;
            const b = o * 14, q = o * 6, r0 = Res[2 * o], r1 = Res[2 * o + 1];
            const sl = obsSlots[o] = slots(o);
            for (const [gi, li] of sl) {
                by[gi] += w * (Jy[b + li] * r0 + Jy[b + 7 + li] * r1);
                for (const [gj, lj] of sl) Hyy[gi * ny + gj] += w * (Jy[b + li] * Jy[b + lj] + Jy[b + 7 + li] * Jy[b + 7 + lj]);
            }
            const p = oPt[o];
            const a0 = Jp[q], a1 = Jp[q + 1], a2 = Jp[q + 2], c0 = Jp[q + 3], c1 = Jp[q + 4], c2 = Jp[q + 5];
            Hpp[p * 6] += w * (a0 * a0 + c0 * c0); Hpp[p * 6 + 1] += w * (a0 * a1 + c0 * c1); Hpp[p * 6 + 2] += w * (a0 * a2 + c0 * c2);
            Hpp[p * 6 + 3] += w * (a1 * a1 + c1 * c1); Hpp[p * 6 + 4] += w * (a1 * a2 + c1 * c2); Hpp[p * 6 + 5] += w * (a2 * a2 + c2 * c2);
            bp[p * 3] += w * (a0 * r0 + c0 * r1); bp[p * 3 + 1] += w * (a1 * r0 + c1 * r1); bp[p * 3 + 2] += w * (a2 * r0 + c2 * r1);
        }
        if (optF && fPrior) { Hyy[fSlot * ny + fSlot] += 1 / fPrior.sigma ** 2; by[fSlot] += (f - fPrior.f0) / fPrior.sigma ** 2; }
        // Hyp per observation: (slots) × 3
        const Hyp = new Float64Array(nobs * 21);
        for (let o = 0; o < nobs; o++) {
            const w = Wt[o];
            if (!w) continue;
            const b = o * 14, q = o * 6;
            for (let li = 0; li < 7; li++) for (let k = 0; k < 3; k++) Hyp[o * 21 + li * 3 + k] = w * (Jy[b + li] * Jp[q + k] + Jy[b + 7 + li] * Jp[q + 3 + k]);
        }
        let improved = false;
        for (let tries = 0; tries < 8 && !improved; tries++) {
            // Schur complement with damping
            const Sm = Float64Array.from(Hyy), rhs = Float64Array.from(by);
            for (let i = 0; i < ny; i++) Sm[i * ny + i] = Hyy[i * ny + i] * (1 + lambda) + 1e-9;
            const Pinv = new Float64Array(np * 6);
            let bad = false;
            for (let p = 0; p < np; p++) {
                const h = Hpp.subarray(p * 6, p * 6 + 6);
                const inv = inv3sym(h[0] * (1 + lambda) + 1e-12, h[1], h[2], h[3] * (1 + lambda) + 1e-12, h[4], h[5] * (1 + lambda) + 1e-12);
                if (!inv) { bad = true; continue; }
                Pinv.set(inv, p * 6);
                const ob = byPt[p];
                // T_o = Hyp[o] · Pinv  (slots × 3)
                const T = ob.map(o => {
                    const m = new Float64Array(21);
                    for (let li = 0; li < 7; li++) {
                        const h0 = Hyp[o * 21 + li * 3], h1 = Hyp[o * 21 + li * 3 + 1], h2 = Hyp[o * 21 + li * 3 + 2];
                        m[li * 3] = h0 * inv[0] + h1 * inv[1] + h2 * inv[2];
                        m[li * 3 + 1] = h0 * inv[1] + h1 * inv[3] + h2 * inv[4];
                        m[li * 3 + 2] = h0 * inv[2] + h1 * inv[4] + h2 * inv[5];
                    }
                    return m;
                });
                const b0 = bp[p * 3], b1 = bp[p * 3 + 1], b2 = bp[p * 3 + 2];
                for (let a = 0; a < ob.length; a++) {
                    const oa = ob[a], Ta = T[a], sa = obsSlots[oa];
                    for (const [gi, li] of sa) {
                        rhs[gi] -= Ta[li * 3] * b0 + Ta[li * 3 + 1] * b1 + Ta[li * 3 + 2] * b2;
                        for (let c = 0; c < ob.length; c++) {
                            const oc = ob[c];
                            for (const [gj, lj] of obsSlots[oc]) {
                                Sm[gi * ny + gj] -= Ta[li * 3] * Hyp[oc * 21 + lj * 3] + Ta[li * 3 + 1] * Hyp[oc * 21 + lj * 3 + 1] + Ta[li * 3 + 2] * Hyp[oc * 21 + lj * 3 + 2];
                            }
                        }
                    }
                }
            }
            void bad;
            const dy = choleskySolve(Sm, rhs.map(x => -x), ny);
            if (!dy) { lambda *= 10; continue; }
            // back-substitute points: dp = -Pinv (bp + Σ Hypᵀ dy)
            const nX = Float64Array.from(X);
            for (let p = 0; p < np; p++) {
                let g0 = bp[p * 3], g1 = bp[p * 3 + 1], g2 = bp[p * 3 + 2];
                for (const o of byPt[p]) for (const [gi, li] of obsSlots[o]) {
                    g0 += Hyp[o * 21 + li * 3] * dy[gi]; g1 += Hyp[o * 21 + li * 3 + 1] * dy[gi]; g2 += Hyp[o * 21 + li * 3 + 2] * dy[gi];
                }
                const iv = Pinv.subarray(p * 6, p * 6 + 6);
                nX[p * 3] -= iv[0] * g0 + iv[1] * g1 + iv[2] * g2;
                nX[p * 3 + 1] -= iv[1] * g0 + iv[3] * g1 + iv[4] * g2;
                nX[p * 3 + 2] -= iv[2] * g0 + iv[4] * g1 + iv[5] * g2;
            }
            const nR = camR.slice(), nT = camT.slice();
            cams.forEach((c, i) => {
                const s = camSlot[i];
                if (s < 0) return;
                nR[i] = mul3(rodriguesToMat([dy[s * 6], dy[s * 6 + 1], dy[s * 6 + 2]]), camR[i]);
                nT[i] = [camT[i][0] + dy[s * 6 + 3], camT[i][1] + dy[s * 6 + 4], camT[i][2] + dy[s * 6 + 5]];
            });
            const nf = optF ? f + dy[fSlot] : f;
            const c1 = nf > 0 ? residualCost(nR, nT, nX, nf) : Infinity;
            if (c1 < cost) {
                const gain = cost - c1;
                camR = nR; camT = nT; X.set(nX); f = nf; cost = c1;
                lambda = Math.max(1e-9, lambda / 5);
                improved = true;
                if (gain < 1e-7 * cost) it = iters;
            } else lambda *= 6;
        }
        if (!improved) break;
    }
    cams.forEach((c, i) => { if (c) { c.R = camR[i]; c.t = camT[i]; } });
    ptList.forEach((p, i) => { points[p].X = [X[3 * i], X[3 * i + 1], X[3 * i + 2]]; });
    S.f = f;
    return { rms: Math.sqrt(cost / Math.max(1, nobs)), nobs, np };
}

// ---------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------

function buildTracks(frames, pairMatches) {
    const offs = [0];
    for (const fr of frames) offs.push(offs[offs.length - 1] + fr.feat.n);
    const parent = new Int32Array(offs[offs.length - 1]).map((_, i) => i);
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (const [key, m] of pairMatches) {
        const [i, j] = key.split(',').map(Number);
        for (let k = 0; k < m.length; k += 2) {
            const a = find(offs[i] + m[k]), b = find(offs[j] + m[k + 1]);
            if (a !== b) parent[a] = b;
        }
    }
    const groups = new Map();
    const touched = new Set();
    for (const [key, m] of pairMatches) {
        const [i, j] = key.split(',').map(Number);
        for (let k = 0; k < m.length; k += 2) { touched.add(offs[i] + m[k]); touched.add(offs[j] + m[k + 1]); }
    }
    for (const node of touched) {
        const r = find(node);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(node);
    }
    const frameOf = (node) => { let lo = 0, hi = frames.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= node) lo = mid; else hi = mid - 1; } return lo; };
    const points = [];
    for (const nodes of groups.values()) {
        if (nodes.length < 2) continue;
        const byFrame = new Map();
        for (const nd of nodes) {
            const fi = frameOf(nd);
            if (byFrame.has(fi)) byFrame.set(fi, -1); // conflicting: two features of one frame
            else byFrame.set(fi, nd - offs[fi]);
        }
        const obs = [];
        for (const [fi, j] of byFrame) if (j >= 0) obs.push(fi, j);
        if (obs.length >= 4) points.push({ X: null, obs: Int32Array.from(obs) });
    }
    return points;
}

// ---------------------------------------------------------------------
// Incremental reconstruction
// ---------------------------------------------------------------------

function normPts(S, i, j, m) {
    const Fi = S.frames[i].feat, Fj = S.frames[j].feat, n = m.length / 2;
    const p1 = new Float64Array(n * 2), p2 = new Float64Array(n * 2);
    for (let k = 0; k < n; k++) {
        p1[2 * k] = (Fi.x[m[2 * k]] - S.cx) / S.f; p1[2 * k + 1] = (Fi.y[m[2 * k]] - S.cy) / S.f;
        p2[2 * k] = (Fj.x[m[2 * k + 1]] - S.cx) / S.f; p2[2 * k + 1] = (Fj.y[m[2 * k + 1]] - S.cy) / S.f;
    }
    return [p1, p2];
}

function reprojErr(cam, f, cx, cy, X, u, v) {
    const R = cam.R, t = cam.t;
    const xc = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0], yc = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1], zc = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
    if (zc <= 1e-9) return Infinity;
    return Math.hypot(f * xc / zc + cx - u, f * yc / zc + cy - v);
}

const camCenter = (c) => { const R = c.R, t = c.t; return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])]; };
export { camCenter };

/** (Re)triangulate one track from all registered cameras; drops bad observations. */
function triangulateTrack(S, P, thrPx, minAngleDeg = 1.5) {
    let obs = [];
    for (let k = 0; k < P.obs.length; k += 2) if (S.cams[P.obs[k]]) obs.push([P.obs[k], P.obs[k + 1]]);
    for (let round = 0; round < 3; round++) {
        if (obs.length < 2) { P.X = null; return false; }
        const Ps = [], xs = [];
        for (const [c, j] of obs) {
            const F = S.frames[c].feat, cam = S.cams[c];
            Ps.push(Pmat(cam.R, cam.t)); xs.push((F.x[j] - S.cx) / S.f, (F.y[j] - S.cy) / S.f);
        }
        const X = triangulateDLT(Ps, xs);
        if (!X) { P.X = null; return false; }
        const errs = obs.map(([c, j]) => reprojErr(S.cams[c], S.f, S.cx, S.cy, X, S.frames[c].feat.x[j], S.frames[c].feat.y[j]));
        const worst = errs.indexOf(Math.max(...errs));
        if (errs[worst] > thrPx) {
            if (obs.length <= 2) { P.X = null; return false; }
            obs.splice(worst, 1);
            continue;
        }
        // enough triangulation angle between some pair of rays
        let maxAng = 0;
        const centers = obs.map(([c]) => camCenter(S.cams[c]));
        for (let a = 0; a < centers.length; a++) for (let b = a + 1; b < centers.length; b++) {
            const r1 = [centers[a][0] - X[0], centers[a][1] - X[1], centers[a][2] - X[2]], r2 = [centers[b][0] - X[0], centers[b][1] - X[1], centers[b][2] - X[2]];
            maxAng = Math.max(maxAng, Math.acos(Math.min(1, dot(r1, r2) / (nrm(r1) * nrm(r2) + 1e-30))));
        }
        if (maxAng * 180 / Math.PI < minAngleDeg) { P.X = null; return false; }
        P.X = X;
        return true;
    }
    P.X = null;
    return false;
}

function registeredCount(S) { return S.cams.filter(Boolean).length; }

/** 2D-3D correspondences of an unregistered frame. */
function correspondences(S, c) {
    const pts = [], obs = [], ids = [];
    for (const pi of S.pointsOfFrame[c]) {
        const P = S.points[pi];
        if (!P.X) continue;
        for (let k = 0; k < P.obs.length; k += 2) if (P.obs[k] === c) {
            const F = S.frames[c].feat, j = P.obs[k + 1];
            pts.push(...P.X); obs.push(F.x[j] - S.cx, F.y[j] - S.cy); ids.push(pi);
            break;
        }
    }
    return { pts: Float64Array.from(pts), obs: Float64Array.from(obs), ids };
}

function countInliers(cam, f, pts, obs, thr) {
    let n = 0;
    for (let k = 0; k < pts.length / 3; k++) {
        const e = reprojErr(cam, f, 0, 0, [pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]], obs[2 * k], obs[2 * k + 1]);
        if (e < thr) n++;
    }
    return n;
}

/** Try to register frame c. Returns true on success. */
function registerFrame(S, c, opts) {
    const cor = correspondences(S, c);
    const n = cor.ids.length;
    if (n < opts.minRegister) return false;
    const thr = opts.inlierPx;
    const inits = [];
    // Minimal-solver RANSAC (P3P): robust to the "flipped" pose of flat parts
    const pr = pnpRansac(cor.pts, cor.obs, S.f, thr, svd3, { seed: c * 7 + 1 });
    if (pr) inits.push({ R: pr.R, t: pr.t });
    // Neighbours: registered frames sharing the most matches.
    const shared = new Map();
    for (const pi of S.pointsOfFrame[c]) {
        const P = S.points[pi];
        for (let k = 0; k < P.obs.length; k += 2) { const o = P.obs[k]; if (o !== c && S.cams[o]) shared.set(o, (shared.get(o) || 0) + 1); }
    }
    const nbrs = [...shared.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
    for (const nb of nbrs) {
        const cam = S.cams[nb];
        inits.push({ R: cam.R.slice(), t: cam.t.slice() });
        // essential-matrix prediction relative to the neighbour, scaled by the 3D points
        const key = nb < c ? nb + ',' + c : c + ',' + nb;
        const rel = S.relPose.get(key);
        if (rel) {
            // rel maps frame a → b (a < b). We need neighbour → c.
            let Rr = rel.R, tr = rel.t;
            if (nb > c) { Rr = tr3(rel.R); tr = mv3(Rr, rel.t).map(x => -x); }
            const R = mul3(Rr, cam.R);
            // centre of c in neighbour coords: -Rrᵀ tr (unit length); scale from points
            const cN = mv3(tr3(Rr), tr).map(x => -x);
            const depthsRatio = [];
            const Cn = camCenter(cam);
            const dist = [];
            for (let k = 0; k < n; k++) {
                const X = [cor.pts[3 * k], cor.pts[3 * k + 1], cor.pts[3 * k + 2]];
                dist.push(Math.hypot(X[0] - Cn[0], X[1] - Cn[1], X[2] - Cn[2]));
            }
            dist.sort((a, b) => a - b);
            const d = dist[dist.length >> 1] || 1;
            // baseline guess from the pair's parallax: baseline ≈ depth · parallax angle
            for (const scale of [Math.max(1e-3, rel.parallax) * d, 0.5 * Math.max(1e-3, rel.parallax) * d, 2 * Math.max(1e-3, rel.parallax) * d]) {
                const Cw = [...Cn];
                const dirW = mv3(tr3(cam.R), cN);
                for (let a = 0; a < 3; a++) Cw[a] += dirW[a] * scale;
                inits.push({ R, t: mv3(R, Cw).map(x => -x) });
            }
            void depthsRatio;
        }
    }
    if (!inits.length) return false;
    let best = null, bestIn = -1;
    for (const init of inits) {
        let pose = refineCameraPose(init.R, init.t, S.f, cor.pts, cor.obs, thr * 3, 10);
        pose = refineCameraPose(pose.R, pose.t, S.f, cor.pts, cor.obs, thr, 8);
        const nin = countInliers(pose, S.f, cor.pts, cor.obs, thr);
        if (nin > bestIn) { bestIn = nin; best = pose; }
    }
    S.lastInliers = `${bestIn}/${n}`; S.lastInlierFrac = bestIn / Math.max(1, n);
    if (bestIn < Math.max(opts.minRegister, 0.3 * n)) return false;
    S.cams[c] = best;
    return true;
}

/**
 * Weak registration when a frame shares too few 3D points with the model
 * (big steps between photos): rotation and direction from the pair's
 * relative pose, distance from whatever 3D points it does see or else from
 * the typical step between cameras. Bundle adjustment fixes it later.
 */
function registerFromPair(S, c, r, opts) {
    const key = r < c ? r + ',' + c : c + ',' + r;
    const rel = S.relPose.get(key);
    if (!rel) return false;
    let Rr = rel.R, tr = rel.t;
    if (r > c) { Rr = tr3(rel.R); tr = mv3(Rr, rel.t).map(x => -x); }
    const cam = S.cams[r];
    const R = mul3(Rr, cam.R);
    const Cr = camCenter(cam);
    const dirW = mv3(tr3(cam.R), mv3(tr3(Rr), tr).map(x => -x)); // unit, world
    const Rt = tr3(R);
    // scale from 2D-3D: X = C + s·d + λ·ray
    const cor = correspondences(S, c);
    const ss = [];
    for (let k = 0; k < cor.ids.length; k++) {
        const ray = mv3(Rt, [cor.obs[2 * k] / S.f, cor.obs[2 * k + 1] / S.f, 1]);
        const q = [cor.pts[3 * k] - Cr[0], cor.pts[3 * k + 1] - Cr[1], cor.pts[3 * k + 2] - Cr[2]];
        // least squares for [s, λ] in s·d + λ·ray = q
        const a = dot(dirW, dirW), b = dot(dirW, ray), cc = dot(ray, ray), d1 = dot(dirW, q), d2 = dot(ray, q);
        const det = a * cc - b * b;
        if (Math.abs(det) < 1e-9) continue;
        const sv = (d1 * cc - b * d2) / det, lam = (a * d2 - b * d1) / det;
        if (lam > 0 && sv > 0) ss.push(sv);
    }
    let scale;
    if (ss.length >= 3) scale = ss.sort((x, y) => x - y)[ss.length >> 1];
    else {
        // typical distance between cameras that are neighbours in the chain
        const steps = [];
        for (const [k2, rp] of S.relPose) {
            const [a, b] = k2.split(',').map(Number);
            if (S.cams[a] && S.cams[b] && rp.n >= opts.minMatches) { const A = camCenter(S.cams[a]), B = camCenter(S.cams[b]); steps.push(Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) / Math.max(1e-6, S.relPose.get(k2).parallax)); }
        }
        if (!steps.length) return false;
        scale = steps.sort((x, y) => x - y)[steps.length >> 1] * rel.parallax;
    }
    const C = [Cr[0] + dirW[0] * scale, Cr[1] + dirW[1] * scale, Cr[2] + dirW[2] * scale];
    S.cams[c] = { R, t: mv3(R, C).map(x => -x), weak: true };
    // make 3D points from this pair right away
    const m = S.pairMatches.get(key);
    const Fc = S.frames[c].feat, Fr = S.frames[r].feat;
    const Pc = Pmat(R, S.cams[c].t), Pr = Pmat(cam.R, cam.t);
    let made = 0;
    const madeIds = [];
    const pairOf = new Map();
    for (let k = 0; k < m.length; k += 2) { const ir = r < c ? m[k] : m[k + 1], ic = r < c ? m[k + 1] : m[k]; pairOf.set(ic, ir); }
    for (const pi of S.pointsOfFrame[c]) {
        const P = S.points[pi];
        if (P.X) continue;
        let jc = -1, jr = -1;
        for (let k = 0; k < P.obs.length; k += 2) { if (P.obs[k] === c) jc = P.obs[k + 1]; if (P.obs[k] === r) jr = P.obs[k + 1]; }
        if (jc < 0 || jr < 0 || pairOf.get(jc) !== jr) continue;
        const X = triangulateDLT([Pr, Pc], [(Fr.x[jr] - S.cx) / S.f, (Fr.y[jr] - S.cy) / S.f, (Fc.x[jc] - S.cx) / S.f, (Fc.y[jc] - S.cy) / S.f]);
        if (!X) continue;
        if (reprojErr(S.cams[c], S.f, S.cx, S.cy, X, Fc.x[jc], Fc.y[jc]) > opts.inlierPx || reprojErr(cam, S.f, S.cx, S.cy, X, Fr.x[jr], Fr.y[jr]) > opts.inlierPx) continue;
        P.X = X; made++; madeIds.push(pi);
    }
    if (made >= 8) return true;
    for (const pi of madeIds) S.points[pi].X = null;
    S.cams[c] = null;
    return false;
}

function triangulateNew(S, c, opts) {
    for (const pi of S.pointsOfFrame[c]) {
        const P = S.points[pi];
        if (P.X) continue;
        triangulateTrack(S, P, opts.inlierPx);
    }
}

function filterObservations(S, thrPx) {
    let removed = 0;
    for (const P of S.points) {
        if (!P.X) continue;
        let good = 0;
        for (let k = 0; k < P.obs.length; k += 2) {
            const c = P.obs[k];
            if (!S.cams[c]) continue;
            const F = S.frames[c].feat, j = P.obs[k + 1];
            if (reprojErr(S.cams[c], S.f, S.cx, S.cy, P.X, F.x[j], F.y[j]) > thrPx) {
                P.obs[k] = -1 - P.obs[k]; // disable (keep index for bookkeeping)
                removed++;
            } else good++;
        }
        if (removed) P.obs = compactObs(P.obs);
        if (good < 2) P.X = null;
    }
    return removed;
}

function compactObs(obs) {
    const out = [];
    for (let k = 0; k < obs.length; k += 2) if (obs[k] >= 0) out.push(obs[k], obs[k + 1]);
    return Int32Array.from(out);
}

function indexPoints(S) {
    S.pointsOfFrame = S.frames.map(() => []);
    S.points.forEach((P, pi) => { for (let k = 0; k < P.obs.length; k += 2) S.pointsOfFrame[P.obs[k]].push(pi); });
}

/**
 * Match and verify one frame pair; stores inlier matches and relative pose.
 */
function verifyPair(S, i, j, opts) {
    const key = i + ',' + j;
    if (S.pairMatches.has(key) || S.triedPairs.has(key)) return S.pairMatches.get(key) || null;
    S.triedPairs.add(key);
    const A = S.frames[i].feat, B = S.frames[j].feat;
    let tm = Date.now();
    let m = matchFeatures(A, B, { radius: opts.matchRadius, maxDist: opts.maxHamming, ratio: opts.ratio });
    S.tMatch = (S.tMatch || 0) + Date.now() - tm; tm = Date.now();
    if (opts.debug) opts.log(`pair ${i},${j}: ${m.length / 2} matches`);
    if (m.length / 2 < opts.minMatches) return null;
    let [p1, p2] = normPts(S, i, j, m);
    // Drop matches that did not move while most others did: things that
    // stayed still behind the object's edge (a stool top in a turntable
    // video). Any "no rotation" model explains them perfectly, which can
    // fool RANSAC.
    {
        const nm = m.length / 2, disp = new Float64Array(nm);
        for (let k = 0; k < nm; k++) disp[k] = Math.hypot(p2[2 * k] - p1[2 * k], p2[2 * k + 1] - p1[2 * k + 1]) * S.f;
        const med = Float64Array.from(disp).sort()[nm >> 1];
        const minD = Math.max(1.0, 0.12 * med);
        const keep = [];
        for (let k = 0; k < nm; k++) if (disp[k] >= minD) keep.push(k);
        if (keep.length < nm) {
            const m2 = new Int32Array(keep.length * 2);
            keep.forEach((k, q) => { m2[2 * q] = m[2 * k]; m2[2 * q + 1] = m[2 * k + 1]; });
            m = m2;
            if (m.length / 2 < opts.minMatches) return null;
            [p1, p2] = normPts(S, i, j, m);
        }
    }
    const rel = relativePose(p1, p2, opts.ransacPx / S.f, { seed: i * 7919 + j });
    S.tRansac = (S.tRansac || 0) + Date.now() - tm;
    if (opts.debug) opts.log(`   → ${rel ? rel.inliers.length : 0} inliers, parallax ${rel ? (rel.parallax * 57.3).toFixed(1) : '-'}°`);
    if (!rel || rel.inliers.length < opts.minMatches) return null;
    // Almost no parallax = the views are (nearly) identical or it is a false
    // match between look-alike sides of a symmetric object: useless and risky.
    if (rel.parallax < (opts.minParallaxDeg ?? 1) * Math.PI / 180) return null;
    // Once cameras are known, a new pair must agree with them.
    if (opts.checkPoses && S.cams[i] && S.cams[j]) {
        const Rij = mul3(S.cams[j].R, tr3(S.cams[i].R));
        const D = mul3(tr3(Rij), rel.R);
        const ang = Math.acos(Math.max(-1, Math.min(1, (D[0] + D[4] + D[8] - 1) / 2))) * 180 / Math.PI;
        if (ang > (opts.maxRotDisagreeDeg ?? 12)) { if (opts.debug) opts.log(`   ✗ disagrees with poses by ${ang.toFixed(1)}°`); return null; }
    }
    const inl = new Int32Array(rel.inliers.length * 2);
    rel.inliers.forEach((k, q) => { inl[2 * q] = m[2 * k]; inl[2 * q + 1] = m[2 * k + 1]; });
    S.pairMatches.set(key, inl);
    const hIn = opts.checkPlanar ? homographyInliers(p1, p2, opts.ransacPx / S.f) : 0;
    S.relPose.set(key, { R: rel.R, t: rel.t, parallax: rel.parallax, n: rel.inliers.length, hRatio: hIn / rel.inliers.length });
    if (opts.debug) opts.log(`   planar ${(hIn / rel.inliers.length).toFixed(2)}`);
    return inl;
}

export const DEFAULTS = {
    window: 3,            // match each frame with the next `window` frames
    matchRadius: 0,       // px; 0 = anywhere in the image
    maxHamming: 64,
    ratio: 0.85,
    minMatches: 20,
    ransacPx: 2.5,
    inlierPx: 4,
    minRegister: 15,
    loopAngleDeg: 40,
    fPriorSigma: 0.06,   // phone cameras: f ≈ 0.8 × long side ± a few %; one ring of views barely constrains f
};

/**
 * Full incremental SfM.
 * frames: [{ feat, extraNeighbours?: [j...] }] all the same size (w, h).
 * Returns { cams: [{R,t}|null], f, cx, cy, points: [{X, obs}], stats }.
 */
export function runSfM(frames, width, height, userOpts = {}) {
    const opts = { ...DEFAULTS, ...userOpts };
    const log = opts.log || (() => {});
    const progress = opts.onProgress || (() => {});
    const t0 = Date.now();
    const f0 = opts.f0 || 0.8 * Math.max(width, height);
    const S = {
        frames, cams: frames.map(() => null), f: f0, cx: width / 2 - 0.5, cy: height / 2 - 0.5,
        pairMatches: new Map(), relPose: new Map(), triedPairs: new Set(), points: [], fixedCam: -1,
    };
    const N = frames.length;
    // 1. pairwise matching of neighbours in capture order (+ extra candidates)
    const pairs = [];
    for (let i = 0; i < N; i++) {
        for (let d = 1; d <= opts.window; d++) if (i + d < N) pairs.push([i, i + d]);
        if (opts.closed && N > opts.window + 2) for (let d = 1; d <= opts.window; d++) if (i + d >= N && (i + d) % N < i) pairs.push([(i + d) % N, i]);
        for (const j of frames[i].extraNeighbours || []) if (j !== i) pairs.push(i < j ? [i, j, 'similar'] : [j, i, 'similar']);
    }
    const seen = new Set();
    let done = 0;
    // sequential pairs first, then the look-alike ones
    pairs.sort((a, b) => (a[2] ? 1 : 0) - (b[2] ? 1 : 0));
    for (const [i, j, kind] of pairs) {
        const key = i + ',' + j;
        if (seen.has(key)) continue;
        seen.add(key);
        // a look-alike pair must show real parallax: symmetric sides of an
        // object "match" with almost none
        verifyPair(S, i, j, { ...opts, checkPlanar: true, minParallaxDeg: kind === 'similar' && Math.abs(i - j) > opts.window ? 4 : 1 });
        progress('match', ++done / pairs.length);
    }
    log(`matching: ${S.pairMatches.size} good pairs of ${seen.size} (${Date.now() - t0} ms: descriptors ${S.tMatch} ms, RANSAC ${S.tRansac} ms)`);

    // 2. tracks
    S.points = buildTracks(frames, S.pairMatches);
    indexPoints(S);
    log(`tracks: ${S.points.length}`);

    // 3. initial pair. Two-view poses of near-planar views are ambiguous, so
    //    try a few pairs × pose hypotheses and keep the one that two more
    //    views agree with best.
    // (trials must not keep what the outlier filter removed from the tracks)
    const obsBackup = S.points.map(P => P.obs.slice());
    const resetState = () => { S.cams = frames.map(() => null); S.points.forEach((P, i) => { P.X = null; P.obs = obsBackup[i].slice(); }); S.fixedCam = -1; };
    const setupInit = (a, b, hyp) => {
        resetState();
        S.cams[a] = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
        S.cams[b] = { R: hyp.R.slice(), t: hyp.t.slice() };
        S.fixedCam = a;
        for (const pi of S.pointsOfFrame[a]) triangulateTrack(S, S.points[pi], opts.inlierPx, 1);
        bundleAdjust(S, { iters: 8 });
        filterObservations(S, opts.inlierPx);
    };
    const trial = (a, b, hyp) => {
        setupInit(a, b, hyp);
        let got = 0, tot = 0, views = 0;
        for (let k = 0; k < 2; k++) {
            let cand = -1, candN = 0;
            for (let c = 0; c < N; c++) {
                if (S.cams[c]) continue;
                let q = 0;
                for (const pi of S.pointsOfFrame[c]) if (S.points[pi].X) q++;
                if (q > candN) { candN = q; cand = c; }
            }
            if (cand < 0 || candN < opts.minRegister) break;
            tot += candN;
            if (registerFrame(S, cand, opts)) { got += S.lastInlierFrac * candN; views++; triangulateNew(S, cand, opts); }
        }
        const ba = views ? bundleAdjust(S, { iters: 6 }) : { rms: 9 };
        return { score: tot ? got / tot : 0, views, rms: ba.rms };
    };
    const cands = [...S.relPose.entries()]
        .filter(([, r]) => r.parallax * 180 / Math.PI >= 3 && r.parallax * 180 / Math.PI <= 60)
        .sort((x, y) => y[1].n * Math.min(1, y[1].parallax * 180 / Math.PI / 10) - x[1].n * Math.min(1, x[1].parallax * 180 / Math.PI / 10))
        .slice(0, opts.initCandidates ?? 5);
    if (!cands.length) throw new Error('SFM_NO_INIT');
    let bestInit = null;
    for (const [key] of cands) {
        const [a, b] = key.split(',').map(Number);
        const m = S.pairMatches.get(key);
        const [p1, p2] = normPts(S, a, b, m);
        const hyps = poseHypotheses(p1, p2, opts.ransacPx / S.f, 3, a * 31 + b);
        for (const h of hyps) {
            const r = trial(a, b, h);
            if (opts.debug) log(`  init try ${key}: views ${r.views}, agree ${(r.score * 100).toFixed(0)} %, rms ${r.rms.toFixed(2)}`);
            if (r.views >= 1 && (!bestInit || r.score > bestInit.score)) bestInit = { a, b, h, ...r };
        }
        if (bestInit && bestInit.score > 0.9 && bestInit.views === 2) break;
    }
    if (!bestInit) throw new Error('SFM_NO_INIT');
    const { a, b } = bestInit;
    setupInit(a, b, bestInit.h);
    const rel = S.relPose.get(a + ',' + b);
    log(`init pair ${a},${b}: parallax ${(rel.parallax * 180 / Math.PI).toFixed(1)}°, ${rel.n} inliers, planar ${rel.hRatio.toFixed(2)}, third-view agreement ${(bestInit.score * 100).toFixed(0)} %`);

    // 4. incremental registration
    let lastBA = 2;
    const tryRegisterAll = () => {
        let added = 0;
        for (;;) {
            // candidate: unregistered frame with the most 2D-3D correspondences
            let cand = -1, candN = 0;
            for (let c = 0; c < N; c++) {
                if (S.cams[c] || S.failed?.has(c)) continue;
                let k = 0;
                for (const pi of S.pointsOfFrame[c]) if (S.points[pi].X) k++;
                if (k > candN) { candN = k; cand = c; }
            }
            if (cand < 0 || candN < opts.minRegister) {
                // fall back to the strongest verified pair with a registered frame
                let best = null;
                for (const [k2, rp] of S.relPose) {
                    const [a, b] = k2.split(',').map(Number);
                    const [c2, r2] = S.cams[a] && !S.cams[b] ? [b, a] : S.cams[b] && !S.cams[a] ? [a, b] : [-1, -1];
                    if (c2 < 0 || S.pairFailed?.has(k2) || rp.parallax < 2 * Math.PI / 180) continue;
                    if (!best || rp.n > best.n) best = { c: c2, r: r2, n: rp.n, key: k2 };
                }
                if (!best || best.n < opts.minMatches * 1.5) break;
                if (opts.debug) log(`  reg ${best.c} from pair with ${best.r} (${best.n} matches)`);
                if (!registerFromPair(S, best.c, best.r, opts)) { S.cams[best.c] = null; (S.pairFailed ||= new Set()).add(best.key); continue; }
                added++;
                triangulateNew(S, best.c, opts);
                bundleAdjust(S, { iters: 6 });
                filterObservations(S, opts.inlierPx);
                progress('pose', registeredCount(S) / N);
                continue;
            }
            if (!registerFrame(S, cand, opts)) { (S.failed ||= new Set()).add(cand); if (opts.debug) log(`  reg ${cand}: failed (${candN} 2D-3D)`); continue; }
            if (opts.debug) log(`  reg ${cand}: ${candN} 2D-3D, f=${S.f.toFixed(0)} inl=${S.lastInliers}`);
            added++;
            triangulateNew(S, cand, opts);
            const nreg = registeredCount(S);
            progress('pose', nreg / N);
            if (nreg >= Math.max(4, Math.ceil(lastBA * 1.3))) {
                // focal stays at the phone-lens prior while the path is built
                // (see focalCheck at the end)
                bundleAdjust(S, { iters: 8 });
                filterObservations(S, opts.inlierPx);
                lastBA = nreg;
            }
        }
        return added;
    };
    tryRegisterAll();
    log(`registered ${registeredCount(S)}/${N} (${Date.now() - t0} ms), f=${S.f.toFixed(1)}`);

    // 5. loop closure: match registered frames that look at the object from
    //    similar directions but were not matched yet; then retry failures.
    for (let round = 0; round < 2; round++) {
        const extra = loopClosureCandidates(S, opts);
        let added = 0;
        for (const [i, j] of extra) if (verifyPair(S, i, j, { ...opts, checkPoses: true })) added++;
        if (!added && !S.failed?.size) break;
        if (added) {
            // rebuild tracks from all matches, keep cameras, re-triangulate
            S.points = buildTracks(frames, S.pairMatches);
            indexPoints(S);
            for (const P of S.points) triangulateTrack(S, P, opts.inlierPx * 3);
            bundleAdjust(S, { iters: 12, huber: 3 });
            filterObservations(S, opts.inlierPx);
            for (const P of S.points) if (!P.X) triangulateTrack(S, P, opts.inlierPx);
        }
        S.failed = new Set();
        tryRegisterAll();
        log(`loop closure round ${round}: +${added} pairs, registered ${registeredCount(S)}/${N}`);
    }

    // 6. final BA (focal fixed), then see whether the views really determine
    //    the focal length before trusting a different one
    let ba = bundleAdjust(S, { iters: 20 });
    filterObservations(S, opts.inlierPx * 0.75);
    ba = bundleAdjust(S, { iters: 15 });
    if (opts.optimizeF !== false && registeredCount(S) >= 8) ba = focalCheck(S, f0, ba, opts, log);
    const npts = S.points.filter(p => p.X).length;
    log(`final: ${registeredCount(S)}/${N} cams, ${npts} points, rms ${ba.rms.toFixed(2)} px, f=${S.f.toFixed(1)} (${Date.now() - t0} ms)`);
    return {
        cams: S.cams, f: S.f, cx: S.cx, cy: S.cy,
        points: S.points.filter(p => p.X),
        stats: { registered: registeredCount(S), total: N, points: npts, rms: ba.rms, pairs: S.pairMatches.size, ms: Date.now() - t0 },
    };
}

function snapshot(S) {
    return { f: S.f, cams: S.cams.map(c => c && { R: c.R.slice(), t: c.t.slice() }), X: S.points.map(p => p.X && p.X.slice()) };
}
function restore(S, snap) {
    S.f = snap.f;
    S.cams = snap.cams.map(c => c && { R: c.R.slice(), t: c.t.slice() });
    S.points.forEach((p, i) => { p.X = snap.X[i] && snap.X[i].slice(); });
}

/**
 * A compact object seen from one ring of views hardly constrains the focal
 * length, and small biases (lighting that turns with a turntable, edges of
 * overlapping parts) can pull it far off. Adopt the data's focal only if
 * the reprojection cost has a clear minimum there (±5 % profile) and it is
 * a plausible phone lens.
 */
function focalCheck(S, f0, ba0, opts, log) {
    const base = snapshot(S);
    const free = bundleAdjust(S, { iters: 20, optimizeF: true });
    const f1 = S.f;
    if (!(f1 > 0.7 * f0 && f1 < 1.35 * f0)) {
        log(`focal ${f1.toFixed(0)} from the views is implausible (lens prior ${f0.toFixed(0)}): keeping the prior`);
        restore(S, base);
        return ba0;
    }
    const atFree = snapshot(S);
    const C1 = free.rms * free.rms * free.nobs;
    const cost = (k) => { restore(S, atFree); S.f = f1 * k; const r = bundleAdjust(S, { iters: 8 }); return r.rms * r.rms * r.nobs; };
    const cp = cost(1.05), cm = cost(0.95);
    const curv = (cp + cm - 2 * C1) / (2 * (0.05 * f1) ** 2);
    const sigma2 = C1 / Math.max(1, free.nobs);
    const sd = curv > 0 ? Math.sqrt(sigma2 / curv) / f1 : Infinity;
    if (sd < (opts.focalMaxSd ?? 0.01)) {
        restore(S, atFree);
        log(`focal ${f1.toFixed(0)} (±${(sd * 100).toFixed(2)} %) determined by the views (prior ${f0.toFixed(0)})`);
        return free;
    }
    log(`focal not determined by the views (${f1.toFixed(0)} ±${(sd * 100).toFixed(1)} %): keeping the lens prior ${f0.toFixed(0)}`);
    restore(S, base);
    return ba0;
}

/** Frame pairs that see the object from similar directions (for loop closure). */
function loopClosureCandidates(S, opts) {
    const pts = S.points.filter(p => p.X).map(p => p.X);
    if (!pts.length) return [];
    const med = [0, 1, 2].map(k => { const v = pts.map(p => p[k]).sort((a, b) => a - b); return v[v.length >> 1]; });
    const dirs = S.cams.map(c => {
        if (!c) return null;
        const C = camCenter(c), d = [C[0] - med[0], C[1] - med[1], C[2] - med[2]], l = nrm(d);
        return d.map(x => x / l);
    });
    const cosT = Math.cos(opts.loopAngleDeg * Math.PI / 180);
    const out = [];
    for (let i = 0; i < S.cams.length; i++) for (let j = i + 1; j < S.cams.length; j++) {
        if (S.pairMatches.has(i + ',' + j) || S.triedPairs.has(i + ',' + j)) continue;
        const di = dirs[i], dj = dirs[j];
        if (!di && !dj) continue;
        if (di && dj) { if (dot(di, dj) > cosT) out.push([i, j]); }
        else if (Math.abs(i - j) <= opts.window + 3) out.push([i, j]); // unregistered: try near neighbours
    }
    return out;
}
