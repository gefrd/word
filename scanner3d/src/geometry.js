// Camera geometry for a planar calibration target.
//
// Convention (OpenCV style): camera looks down +Z, image x right, y down.
//   u = f * Xc / Zc + cx,  v = f * Yc / Zc + cy,  Xc = R * Xw + t
// Principal point is assumed at the image centre and pixels square — true
// enough for phone cameras and it leaves a single intrinsic (f) to recover.

// ---------- small linear algebra ----------

export function solveLinear(A, b) {
    // Gaussian elimination with partial pivoting. A: n×n (array of rows), b: n.
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-14) return null;
        [M[c], M[p]] = [M[p], M[c]];
        for (let r = c + 1; r < n; r++) {
            const k = M[r][c] / M[c][c];
            if (k === 0) continue;
            for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
        }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
        let s = M[r][n];
        for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
        x[r] = s / M[r][r];
    }
    return x;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

function mat3Inverse(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-18) return null;
    return [
        A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
        B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
        C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
    ];
}

// Nearest rotation matrix (polar decomposition by Higham iteration).
function orthonormalize(R) {
    let X = R.slice();
    for (let it = 0; it < 30; it++) {
        const inv = mat3Inverse(X);
        if (!inv) break;
        // X ← (X + X^-T) / 2
        const next = [
            (X[0] + inv[0]) / 2, (X[1] + inv[3]) / 2, (X[2] + inv[6]) / 2,
            (X[3] + inv[1]) / 2, (X[4] + inv[4]) / 2, (X[5] + inv[7]) / 2,
            (X[6] + inv[2]) / 2, (X[7] + inv[5]) / 2, (X[8] + inv[8]) / 2,
        ];
        let d = 0;
        for (let k = 0; k < 9; k++) d += Math.abs(next[k] - X[k]);
        X = next;
        if (d < 1e-12) break;
    }
    return X;
}

export function rodriguesToMat(rv) {
    const th = norm(rv);
    if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const [x, y, z] = [rv[0] / th, rv[1] / th, rv[2] / th];
    const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
    return [
        c + x * x * C, x * y * C - z * s, x * z * C + y * s,
        y * x * C + z * s, c + y * y * C, y * z * C - x * s,
        z * x * C - y * s, z * y * C + x * s, c + z * z * C,
    ];
}

export function matToRodrigues(R) {
    const tr = R[0] + R[4] + R[8];
    const cos = Math.min(1, Math.max(-1, (tr - 1) / 2));
    const th = Math.acos(cos);
    if (th < 1e-9) return [0, 0, 0];
    if (Math.PI - th < 1e-6) {
        // 180°: axis from the diagonal
        const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2));
        const y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)) * (R[1] >= 0 ? 1 : -1);
        const z = Math.sqrt(Math.max(0, (R[8] + 1) / 2)) * (R[2] >= 0 ? 1 : -1);
        return [x * th, y * th, z * th];
    }
    const k = th / (2 * Math.sin(th));
    return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

// ---------- homography ----------

function normalizePoints(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let d = 0;
    for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
    d /= pts.length;
    const s = d > 0 ? Math.SQRT2 / d : 1;
    return { pts: pts.map(p => [(p[0] - mx) * s, (p[1] - my) * s]), T: [s, 0, -mx * s, 0, s, -my * s, 0, 0, 1] };
}

function mul3(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
    return C;
}

/** Homography H (row-major 3×3) mapping plane points src[i]=[X,Y] to image dst[i]=[u,v]. */
export function homographyDLT(src, dst) {
    if (src.length < 4) return null;
    const ns = normalizePoints(src), nd = normalizePoints(dst);
    // Least squares with h33 = 1 via normal equations (8 unknowns).
    const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const Atb = new Array(8).fill(0);
    const addRow = (row, b) => {
        for (let i = 0; i < 8; i++) {
            if (row[i] === 0) continue;
            Atb[i] += row[i] * b;
            for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
        }
    };
    for (let i = 0; i < src.length; i++) {
        const [X, Y] = ns.pts[i], [u, v] = nd.pts[i];
        addRow([X, Y, 1, 0, 0, 0, -u * X, -u * Y], u);
        addRow([0, 0, 0, X, Y, 1, -v * X, -v * Y], v);
    }
    const h = solveLinear(AtA, Atb);
    if (!h) return null;
    const Hn = [...h, 1];
    const TdInv = mat3Inverse(nd.T);
    const H = mul3(mul3(TdInv, Hn), ns.T);
    const s = H[8];
    return H.map(x => x / s);
}

export function applyHomography(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export { mat3Inverse as invert3 };

// ---------- intrinsics & pose ----------

/**
 * Focal-length candidates (px) from one plane homography, using the two
 * constraints that the plane's X and Y axes are orthogonal and equally long.
 * Returns [] when the view is too frontal to tell.
 */
export function focalFromHomography(H, cx, cy) {
    // Shift principal point to the origin: H' = T * H
    const T = [1, 0, -cx, 0, 1, -cy, 0, 0, 1];
    const h = mul3(T, H);
    const h1 = [h[0], h[3], h[6]], h2 = [h[1], h[4], h[7]];
    const out = [];
    const d1 = h1[2] * h2[2];
    if (Math.abs(d1) > 1e-12) {
        const f2 = -(h1[0] * h2[0] + h1[1] * h2[1]) / d1;
        if (f2 > 0) out.push(Math.sqrt(f2));
    }
    const d2 = h1[2] * h1[2] - h2[2] * h2[2];
    if (Math.abs(d2) > 1e-12) {
        const f2 = -(h1[0] * h1[0] + h1[1] * h1[1] - h2[0] * h2[0] - h2[1] * h2[1]) / d2;
        if (f2 > 0) out.push(Math.sqrt(f2));
    }
    return out;
}

/** Initial pose [R (row-major 9), t] from a plane homography and intrinsics. */
export function poseFromHomography(H, f, cx, cy) {
    const Kinv = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
    const M = mul3(Kinv, H);
    let m1 = [M[0], M[3], M[6]], m2 = [M[1], M[4], M[7]], m3 = [M[2], M[5], M[8]];
    let lambda = 2 / (norm(m1) + norm(m2));
    if (m3[2] * lambda < 0) lambda = -lambda; // plane must be in front of the camera
    const r1 = m1.map(x => x * lambda), r2 = m2.map(x => x * lambda);
    const t = m3.map(x => x * lambda);
    const r3 = cross(r1, r2);
    const R = orthonormalize([r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]]);
    return { R, t };
}

export function projectPoint(R, t, f, cx, cy, X) {
    const xc = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
    const yc = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
    const zc = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
    return [f * xc / zc + cx, f * yc / zc + cy, zc];
}

function reprojError(rv, t, f, cx, cy, world, image) {
    const R = rodriguesToMat(rv);
    let e = 0;
    for (let i = 0; i < world.length; i++) {
        const p = projectPoint(R, t, f, cx, cy, world[i]);
        e += (p[0] - image[i][0]) ** 2 + (p[1] - image[i][1]) ** 2;
    }
    return e;
}

/**
 * Levenberg–Marquardt refinement of a pose (rotation vector + translation)
 * minimising reprojection error. Numeric Jacobian: 6 params × ~40 points is
 * trivially cheap even on low-end phones.
 */
export function refinePose(pose, f, cx, cy, world, image, iters = 15) {
    let rv = matToRodrigues(pose.R), t = pose.t.slice();
    let params = [...rv, ...t];
    const residuals = (p) => {
        const R = rodriguesToMat(p.slice(0, 3));
        const r = [];
        for (let i = 0; i < world.length; i++) {
            const q = projectPoint(R, p.slice(3), f, cx, cy, world[i]);
            r.push(q[0] - image[i][0], q[1] - image[i][1]);
        }
        return r;
    };
    let r = residuals(params);
    let err = r.reduce((a, x) => a + x * x, 0);
    let mu = 1e-3;
    for (let it = 0; it < iters; it++) {
        const J = [];
        for (let k = 0; k < 6; k++) {
            const step = k < 3 ? 1e-6 : Math.max(1e-4, Math.abs(params[k]) * 1e-6);
            const p2 = params.slice(); p2[k] += step;
            const r2 = residuals(p2);
            J.push(r2.map((x, i) => (x - r[i]) / step));
        }
        const JtJ = Array.from({ length: 6 }, (_, a) => Array.from({ length: 6 }, (_, b) => {
            let s = 0; for (let i = 0; i < r.length; i++) s += J[a][i] * J[b][i]; return s;
        }));
        const Jtr = Array.from({ length: 6 }, (_, a) => { let s = 0; for (let i = 0; i < r.length; i++) s += J[a][i] * r[i]; return s; });
        let improved = false;
        for (let tries = 0; tries < 8; tries++) {
            const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + mu) + 1e-12 : v)));
            const d = solveLinear(A, Jtr.map(x => -x));
            if (!d) { mu *= 10; continue; }
            const p2 = params.map((v, k) => v + d[k]);
            const r2 = residuals(p2);
            const e2 = r2.reduce((a, x) => a + x * x, 0);
            if (e2 < err) {
                params = p2; r = r2;
                const gain = err - e2;
                err = e2; mu = Math.max(1e-9, mu / 5); improved = true;
                if (gain < 1e-10 * err) it = iters;
                break;
            }
            mu *= 10;
        }
        if (!improved) break;
    }
    return { R: rodriguesToMat(params.slice(0, 3)), t: params.slice(3), rms: Math.sqrt(err / world.length) };
}

/** Pose of one view: homography → initial pose → LM refinement. */
export function solvePose(world, image, f, cx, cy) {
    const H = homographyDLT(world.map(p => [p[0], p[1]]), image);
    if (!H) return null;
    const init = poseFromHomography(H, f, cx, cy);
    const pose = refinePose(init, f, cx, cy, world, image);
    if (pose.t[2] <= 0 || !isFinite(pose.rms)) return null;
    return pose;
}

/**
 * Recover the focal length shared by all views: start from the closed-form
 * homography estimates, then do a 1-D golden-section search minimising the
 * total reprojection error of per-view refined poses.
 */
export function estimateFocal(views, width, height) {
    const cx = width / 2, cy = height / 2;
    const cands = [];
    for (const v of views) {
        const H = homographyDLT(v.world.map(p => [p[0], p[1]]), v.image);
        if (H) for (const f of focalFromHomography(H, cx, cy)) cands.push(f);
    }
    const longSide = Math.max(width, height);
    const plausible = cands.filter(f => f > 0.4 * longSide && f < 2.5 * longSide).sort((a, b) => a - b);
    let f0 = plausible.length ? plausible[Math.floor(plausible.length / 2)] : 0.8 * longSide;

    // Use at most ~20 views for the search (evenly spread) to bound cost.
    const step = Math.max(1, Math.floor(views.length / 20));
    const sample = views.filter((_, i) => i % step === 0);
    const cost = (f) => {
        let e = 0;
        for (const v of sample) {
            const p = solvePose(v.world, v.image, f, cx, cy);
            e += p ? p.rms * p.rms : 1e6;
        }
        return e;
    };
    let lo = Math.max(0.4 * longSide, f0 * 0.6), hi = Math.min(2.5 * longSide, f0 * 1.6);
    const gr = (Math.sqrt(5) - 1) / 2;
    let a = hi - gr * (hi - lo), b = lo + gr * (hi - lo);
    let fa = cost(a), fb = cost(b);
    for (let i = 0; i < 24; i++) {
        if (fa < fb) { hi = b; b = a; fb = fa; a = hi - gr * (hi - lo); fa = cost(a); }
        else { lo = a; a = b; fa = fb; b = lo + gr * (hi - lo); fb = cost(b); }
    }
    return (lo + hi) / 2;
}

/** Camera centre in world coordinates: C = -Rᵀ t */
export function cameraCenter(R, t) {
    return [
        -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
        -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
        -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
    ];
}
