// Five-point relative pose (Nistér 2004): essential matrices from 5
// calibrated correspondences. Robust where the 8-point algorithm fails —
// narrow views of an object in the middle of the frame, near-planar parts.
//
// E = x·X + y·Y + z·Z + W spans the null space of the 5×9 epipolar system;
// the cubic constraints det(E) = 0 and 2·E·Eᵀ·E − tr(E·Eᵀ)·E = 0 give ten
// equations in 20 monomials; Gauss-Jordan elimination and a 3×3 polynomial
// determinant give a degree-10 polynomial in z whose real roots are the
// solutions.

import { eigenSym } from './sfm.js';

// Monomials of degree ≤ 3 in (x, y, z), Nistér's order.
const MONO = [
    [3, 0, 0], [0, 3, 0], [2, 1, 0], [1, 2, 0], [2, 0, 1], [2, 0, 0], [0, 2, 1], [0, 2, 0], [1, 1, 1], [1, 1, 0],
    [1, 0, 2], [1, 0, 1], [1, 0, 0], [0, 1, 2], [0, 1, 1], [0, 1, 0], [0, 0, 3], [0, 0, 2], [0, 0, 1], [0, 0, 0],
];
const key = (a, b, c) => a * 16 + b * 4 + c;
const COL = new Int8Array(64).fill(-1);
MONO.forEach(([a, b, c], i) => { COL[key(a, b, c)] = i; });

// Dense polynomials over exponents (a, b, c) ≤ 3 stored as Float64Array(64).
function pmul(p, q) {
    const r = new Float64Array(64);
    for (let i = 0; i < 64; i++) {
        const pi = p[i];
        if (!pi) continue;
        const a = i >> 4, b = (i >> 2) & 3, c = i & 3;
        for (let j = 0; j < 64; j++) {
            const qj = q[j];
            if (!qj) continue;
            const A = a + (j >> 4), B = b + ((j >> 2) & 3), C = c + (j & 3);
            if (A > 3 || B > 3 || C > 3) continue; // never happens for total degree ≤ 3
            r[key(A, B, C)] += pi * qj;
        }
    }
    return r;
}
const padd = (p, q, s = 1) => { const r = new Float64Array(64); for (let i = 0; i < 64; i++) r[i] = p[i] + s * q[i]; return r; };
const pscale = (p, s) => p.map(v => v * s);

// 1-D polynomials in z (coefficient index = power)
function zmul(p, q) {
    const r = new Float64Array(p.length + q.length - 1);
    for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) r[i + j] += p[i] * q[j];
    return r;
}
function zadd(p, q, s = 1) {
    const r = new Float64Array(Math.max(p.length, q.length));
    for (let i = 0; i < p.length; i++) r[i] += p[i];
    for (let i = 0; i < q.length; i++) r[i] += s * q[i];
    return r;
}
function zeval(p, z) { let v = 0; for (let i = p.length - 1; i >= 0; i--) v = v * z + p[i]; return v; }

/** Real roots of a polynomial (coefficients by power) via Aberth–Ehrlich iteration. */
export function realRoots(coef) {
    let n = coef.length - 1;
    while (n > 0 && Math.abs(coef[n]) < 1e-14 * Math.max(...coef.map(Math.abs))) n--;
    if (n < 1) return [];
    const a = Array.from({ length: n + 1 }, (_, i) => coef[i] / coef[n]);
    // Cauchy bound for the initial circle
    let bound = 0;
    for (let i = 0; i < n; i++) bound = Math.max(bound, Math.abs(a[i]));
    const R = 1 + bound;
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let k = 0; k < n; k++) { const th = 2 * Math.PI * k / n + 0.4; re[k] = 0.5 * R * Math.cos(th); im[k] = 0.5 * R * Math.sin(th); }
    const evalC = (xr, xi) => {
        // p and p' at complex x (Horner)
        let pr = 1, pi = 0, dr = 0, di = 0;
        for (let i = n - 1; i >= 0; i--) {
            const ndr = dr * xr - di * xi + pr, ndi = dr * xi + di * xr + pi;
            dr = ndr; di = ndi;
            const npr = pr * xr - pi * xi + a[i], npi = pr * xi + pi * xr;
            pr = npr; pi = npi;
        }
        return [pr, pi, dr, di];
    };
    for (let it = 0; it < 200; it++) {
        let maxStep = 0;
        for (let k = 0; k < n; k++) {
            const [pr, pi, dr, di] = evalC(re[k], im[k]);
            // ratio = p / p'
            const dd = dr * dr + di * di || 1e-300;
            const rr = (pr * dr + pi * di) / dd, ri = (pi * dr - pr * di) / dd;
            // sum 1/(z_k - z_j)
            let sr = 0, si = 0;
            for (let j = 0; j < n; j++) {
                if (j === k) continue;
                const xr = re[k] - re[j], xi = im[k] - im[j], m = xr * xr + xi * xi || 1e-300;
                sr += xr / m; si -= xi / m;
            }
            // w = ratio / (1 - ratio * sum)
            const denr = 1 - (rr * sr - ri * si), deni = -(rr * si + ri * sr), dm = denr * denr + deni * deni || 1e-300;
            const wr = (rr * denr + ri * deni) / dm, wi = (ri * denr - rr * deni) / dm;
            re[k] -= wr; im[k] -= wi;
            maxStep = Math.max(maxStep, Math.hypot(wr, wi) / (1 + Math.hypot(re[k], im[k])));
        }
        if (maxStep < 1e-14) break;
    }
    const out = [];
    for (let k = 0; k < n; k++) {
        if (Math.abs(im[k]) > 1e-6 * (1 + Math.abs(re[k]))) continue;
        // polish on the real line with Newton
        let x = re[k];
        for (let s = 0; s < 3; s++) {
            let p = 1, d = 0;
            for (let i = n - 1; i >= 0; i--) { d = d * x + p; p = p * x + a[i]; }
            if (!d) break;
            x -= p / d;
        }
        out.push(x);
    }
    return out;
}

/**
 * Essential matrices (row-major, up to 10) from 5 correspondences.
 * x1, x2: arrays of [x, y] normalised image coordinates; x2ᵀ·E·x1 = 0.
 */
export function fivePoint(x1, x2) {
    const Q = new Float64Array(81);
    for (let k = 0; k < 5; k++) {
        const [a, b] = x1[k], [c, d] = x2[k];
        const row = [c * a, c * b, c, d * a, d * b, d, a, b, 1];
        for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) Q[i * 9 + j] += row[i] * row[j];
    }
    const { vectors } = eigenSym(Q, 9);
    // null space basis: the 4 smallest eigenvectors
    const basis = [0, 1, 2, 3].map(c => Array.from({ length: 9 }, (_, r) => vectors[r * 9 + c]));
    const [X, Y, Z, W] = basis;
    // E entries as linear polynomials in x, y, z
    const Ep = [];
    for (let e = 0; e < 9; e++) {
        const p = new Float64Array(64);
        p[key(1, 0, 0)] = X[e]; p[key(0, 1, 0)] = Y[e]; p[key(0, 0, 1)] = Z[e]; p[key(0, 0, 0)] = W[e];
        Ep.push(p);
    }
    const at = (r, c) => Ep[r * 3 + c];
    // det(E)
    let det = pmul(at(0, 0), padd(pmul(at(1, 1), at(2, 2)), pmul(at(1, 2), at(2, 1)), -1));
    det = padd(det, pmul(at(0, 1), padd(pmul(at(1, 2), at(2, 0)), pmul(at(1, 0), at(2, 2)), -1)));
    det = padd(det, pmul(at(0, 2), padd(pmul(at(1, 0), at(2, 1)), pmul(at(1, 1), at(2, 0)), -1)));
    // EEt (quadratic)
    const EEt = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let s = new Float64Array(64);
        for (let k = 0; k < 3; k++) s = padd(s, pmul(at(i, k), at(j, k)));
        EEt.push(s);
    }
    const trace = padd(padd(EEt[0], EEt[4]), EEt[8]);
    const rows = [det];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let s = new Float64Array(64);
        for (let k = 0; k < 3; k++) s = padd(s, pmul(EEt[i * 3 + k], at(k, j)));
        rows.push(padd(pscale(s, 2), pmul(trace, at(i, j)), -1));
    }
    // 10×20 coefficient matrix
    const A = rows.map(p => { const r = new Float64Array(20); for (let i = 0; i < 64; i++) if (p[i]) r[COL[i]] = p[i]; return r; });
    // Gauss-Jordan on the first 10 columns
    for (let c = 0; c < 10; c++) {
        let piv = c;
        for (let r = c + 1; r < 10; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
        if (Math.abs(A[piv][c]) < 1e-12) return [];
        [A[c], A[piv]] = [A[piv], A[c]];
        const inv = 1 / A[c][c];
        for (let j = c; j < 20; j++) A[c][j] *= inv;
        for (let r = 0; r < 10; r++) {
            if (r === c) continue;
            const f = A[r][c];
            if (!f) continue;
            for (let j = c; j < 20; j++) A[r][j] -= f * A[c][j];
        }
    }
    // remaining monomials: xz², xz, x, yz², yz, y, z³, z², z, 1
    // → (variable, power of z): 0 = x, 1 = y, 2 = constant
    const REST = [[0, 2], [0, 1], [0, 0], [1, 2], [1, 1], [1, 0], [2, 3], [2, 2], [2, 1], [2, 0]];
    const combo = (e, f) => {
        // ⟨e⟩ − z⟨f⟩ → polynomials in z for x, y, 1 (rows are in reduced form: lead + Σ B·rest)
        const out = [new Float64Array(5), new Float64Array(5), new Float64Array(5)];
        for (let c = 0; c < 10; c++) {
            const [v, pw] = REST[c];
            out[v][pw] += A[e][10 + c];
            out[v][pw + 1] -= A[f][10 + c];
        }
        return out;
    };
    const K = combo(4, 5), L = combo(6, 7), M = combo(8, 9);
    // det of [[Kx, Ky, K1], [Lx, Ly, L1], [Mx, My, M1]]
    const d1 = zadd(zmul(L[1], M[2]), zmul(L[2], M[1]), -1);
    const d2 = zadd(zmul(L[2], M[0]), zmul(L[0], M[2]), -1);
    const d3 = zadd(zmul(L[0], M[1]), zmul(L[1], M[0]), -1);
    const poly = zadd(zadd(zmul(K[0], d1), zmul(K[1], d2)), zmul(K[2], d3));
    const out = [];
    for (const z of realRoots(Array.from(poly))) {
        const r0 = [zeval(K[0], z), zeval(K[1], z), zeval(K[2], z)];
        const r1 = [zeval(L[0], z), zeval(L[1], z), zeval(L[2], z)];
        const r2 = [zeval(M[0], z), zeval(M[1], z), zeval(M[2], z)];
        // null vector (x, y, 1): the largest cross product of two rows
        const cands = [cross(r0, r1), cross(r0, r2), cross(r1, r2)];
        const v = cands.reduce((a, b) => (Math.hypot(...b) > Math.hypot(...a) ? b : a));
        if (Math.abs(v[2]) < 1e-12) continue;
        const x = v[0] / v[2], y = v[1] / v[2];
        const E = new Array(9);
        for (let e = 0; e < 9; e++) E[e] = x * X[e] + y * Y[e] + z * Z[e] + W[e];
        const n = Math.hypot(...E);
        out.push(E.map(v => v / n));
    }
    return out;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
