// Image features for the no-sheet scan: FAST corners, Harris ranking,
// binary BRIEF descriptors (256 bit) on a small image pyramid, and Hamming
// matching. Own implementation (no OpenCV) so it is small, runs in a worker
// and needs no extra download.
//
// Descriptors are "upright" (no orientation): when you walk around an object
// or turn it on a stool, the phone stays roughly level, and upright BRIEF is
// both faster and more distinctive than the rotated version.

const PATCH = 15;          // descriptor patch radius (31×31)
const BORDER = PATCH + 3;
const NBITS = 256, NWORDS = NBITS / 32;

// Sampling pattern: 256 point pairs from an isotropic Gaussian (BRIEF "G II"),
// fixed seed so every run and every device uses the same pattern.
const PATTERN = (() => {
    let s = 0x9e3779b9;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e6) / 1e6; };
    const gauss = () => {
        const u = Math.max(1e-9, rnd()), v = rnd();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const p = new Int8Array(NBITS * 4);
    const sigma = (2 * PATCH + 1) / 5;
    for (let i = 0; i < NBITS * 4; i++) {
        let v;
        do { v = Math.round(gauss() * sigma); } while (Math.abs(v) > PATCH - 1);
        p[i] = v;
    }
    return p;
})();

// Bresenham circle of radius 3 used by FAST.
const CIRCLE = [[0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3], [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3]];

export function rgbaToGray(rgba, n) {
    const g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return g;
}

/** Area-average downscale by an arbitrary factor (≥ 1). */
export function downscale(src, w, h, W, H) {
    const out = new Uint8Array(W * H);
    const sx = w / W, sy = h / H;
    for (let y = 0; y < H; y++) {
        const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) * sy)));
        for (let x = 0; x < W; x++) {
            const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) * sx)));
            let s = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += src[yy * w + xx];
            out[y * W + x] = s / ((y1 - y0) * (x1 - x0));
        }
    }
    return out;
}

function downscaleMask(m, w, h, W, H) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        const yy = Math.min(h - 1, Math.floor((y + 0.5) * h / H));
        for (let x = 0; x < W; x++) out[y * W + x] = m[yy * w + Math.min(w - 1, Math.floor((x + 0.5) * w / W))];
    }
    return out;
}

/** Separable [1 4 6 4 1]/16 blur, twice (σ ≈ 1.4) — BRIEF needs a smoothed image. */
function blur(src, w, h) {
    let a = src, b = new Uint8Array(w * h);
    for (let pass = 0; pass < 2; pass++) {
        const tmp = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            const r = y * w;
            for (let x = 0; x < w; x++) {
                const x0 = x > 1 ? x - 2 : 0, x1 = x > 0 ? x - 1 : 0, x3 = x < w - 1 ? x + 1 : w - 1, x4 = x < w - 2 ? x + 2 : w - 1;
                tmp[r + x] = (a[r + x0] + 4 * a[r + x1] + 6 * a[r + x] + 4 * a[r + x3] + a[r + x4] + 8) >> 4;
            }
        }
        for (let y = 0; y < h; y++) {
            const y0 = (y > 1 ? y - 2 : 0) * w, y1 = (y > 0 ? y - 1 : 0) * w, y3 = (y < h - 1 ? y + 1 : h - 1) * w, y4 = (y < h - 2 ? y + 2 : h - 1) * w, r = y * w;
            for (let x = 0; x < w; x++) b[r + x] = (tmp[y0 + x] + 4 * tmp[y1 + x] + 6 * tmp[r + x] + 4 * tmp[y3 + x] + tmp[y4 + x] + 8) >> 4;
        }
        a = b; b = new Uint8Array(w * h);
    }
    return a;
}

/** FAST-9 corners with 3×3 non-maximum suppression on the FAST score. */
function fast9(img, w, h, thr, mask) {
    const off = CIRCLE.map(([dx, dy]) => dy * w + dx);
    const score = new Float32Array(w * h);
    const cand = [];
    for (let y = BORDER; y < h - BORDER; y++) {
        for (let x = BORDER; x < w - BORDER; x++) {
            const i = y * w + x;
            if (mask && mask[i] < 128) continue;
            const p = img[i], hi = p + thr, lo = p - thr;
            // quick test: any 9-arc covers at least 2 of the 4 compass points
            const a = img[i + off[0]], b = img[i + off[4]], c = img[i + off[8]], d = img[i + off[12]];
            const nb = (a > hi) + (b > hi) + (c > hi) + (d > hi), nd = (a < lo) + (b < lo) + (c < lo) + (d < lo);
            if (nb < 2 && nd < 2) continue;
            let bm = 0, dm = 0;
            for (let k = 0; k < 16; k++) {
                const v = img[i + off[k]];
                if (v > hi) bm |= 1 << k; else if (v < lo) dm |= 1 << k;
            }
            if (!arc9(bm) && !arc9(dm)) continue;
            let sb = 0, sd = 0;
            for (let k = 0; k < 16; k++) {
                const v = img[i + off[k]];
                if (v > hi) sb += v - hi; else if (v < lo) sd += lo - v;
            }
            score[i] = Math.max(sb, sd);
            cand.push(i);
        }
    }
    const out = [];
    for (const i of cand) {
        const s = score[i];
        if (s < score[i - 1] || s < score[i + 1] || s < score[i - w] || s < score[i + w] ||
            s < score[i - w - 1] || s < score[i - w + 1] || s < score[i + w - 1] || s < score[i + w + 1]) continue;
        out.push(i);
    }
    return out;
}

function arc9(m) {
    if (!m) return false;
    let x = m | (m << 16);
    // 9 consecutive set bits
    x &= x >>> 1; x &= x >>> 2; x &= x >>> 4; x &= x >>> 1;
    return x !== 0;
}

/** Harris corner response over a 7×7 window (Sobel gradients). */
function harris(img, w, i) {
    let a = 0, b = 0, c = 0;
    for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
            const j = i + dy * w + dx;
            const gx = (img[j + 1 - w] + 2 * img[j + 1] + img[j + 1 + w]) - (img[j - 1 - w] + 2 * img[j - 1] + img[j - 1 + w]);
            const gy = (img[j + w - 1] + 2 * img[j + w] + img[j + w + 1]) - (img[j - w - 1] + 2 * img[j - w] + img[j - w + 1]);
            a += gx * gx; b += gy * gy; c += gx * gy;
        }
    }
    return a * b - c * c - 0.04 * (a + b) * (a + b);
}

function describe(sm, w, x, y, out, o) {
    const base = y * w + x;
    for (let k = 0; k < NWORDS; k++) {
        let word = 0;
        for (let bit = 0; bit < 32; bit++) {
            const q = (k * 32 + bit) * 4;
            const p1 = sm[base + PATTERN[q + 1] * w + PATTERN[q]], p2 = sm[base + PATTERN[q + 3] * w + PATTERN[q + 2]];
            if (p1 < p2) word |= 1 << bit;
        }
        out[o + k] = word;
    }
}

/**
 * Detect and describe features.
 * @param gray  Uint8Array w×h
 * @param mask  optional Uint8Array w×h (≥128 = features allowed)
 * @returns { n, x, y, level, score, desc (Uint32Array n×8), width, height }
 */
export function detectFeatures(gray, w, h, mask = null, opts = {}) {
    const maxN = opts.maxFeatures || 800;
    const levels = opts.levels || 3, scale = opts.scaleFactor || 1.35;
    const cell = opts.cell || 24;
    // Features per level proportional to the level's area.
    const quotas = [];
    let tot = 0;
    for (let l = 0; l < levels; l++) { quotas.push(Math.pow(scale, -2 * l)); tot += quotas[l]; }
    const xs = [], ys = [], lv = [], sc = [], descs = [];
    let img = gray, msk = mask, lw = w, lh = h;
    for (let l = 0; l < levels; l++) {
        if (l > 0) {
            const W = Math.round(w / Math.pow(scale, l)), H = Math.round(h / Math.pow(scale, l));
            if (W < 2 * BORDER + 8 || H < 2 * BORDER + 8) break;
            img = downscale(img, lw, lh, W, H);
            if (msk) msk = downscaleMask(msk, lw, lh, W, H);
            lw = W; lh = H;
        }
        const quota = Math.round(maxN * quotas[l] / tot);
        // Adaptive threshold: lower it on low-contrast images.
        let corners = [];
        for (const thr of [opts.fastThreshold || 18, 10, 6]) {
            corners = fast9(img, lw, lh, thr, msk);
            if (corners.length >= quota * 1.5) break;
        }
        if (!corners.length) continue;
        // Rank by Harris inside grid cells so features spread over the object.
        const gx = Math.ceil(lw / cell);
        const buckets = new Map();
        for (const i of corners) {
            const x = i % lw, y = (i / lw) | 0;
            const key = ((y / cell) | 0) * gx + ((x / cell) | 0);
            const s = harris(img, lw, i);
            if (s <= 0) continue;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push([s, i]);
        }
        const lists = [...buckets.values()].map(b => b.sort((p, q) => q[0] - p[0]));
        const picked = [];
        for (let round = 0; picked.length < quota; round++) {
            let any = false;
            for (const b of lists) if (round < b.length) { picked.push(b[round]); any = true; if (picked.length >= quota) break; }
            if (!any) break;
        }
        if (!picked.length) continue;
        const sm = blur(img, lw, lh);
        const f = Math.pow(scale, l);
        for (const [s, i] of picked) {
            const x = i % lw, y = (i / lw) | 0;
            const d = new Uint32Array(NWORDS);
            describe(sm, lw, x, y, d, 0);
            // sub-pixel-ish centre of the level pixel mapped back to level 0
            xs.push((x + 0.5) * f - 0.5); ys.push((y + 0.5) * f - 0.5); lv.push(l); sc.push(s); descs.push(d);
        }
    }
    const n = xs.length;
    const desc = new Uint32Array(n * NWORDS);
    descs.forEach((d, k) => desc.set(d, k * NWORDS));
    return { n, x: Float32Array.from(xs), y: Float32Array.from(ys), level: Uint8Array.from(lv), score: Float32Array.from(sc), desc, width: w, height: h };
}

function popcnt(v) {
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function hamming(da, ia, db, ib) {
    let d = 0;
    for (let k = 0; k < NWORDS; k++) d += popcnt(da[ia + k] ^ db[ib + k]);
    return d;
}

/**
 * Match features A→B: nearest neighbour in Hamming distance with Lowe's
 * ratio test and a mutual (cross) check.
 *   opts.maxDist   reject matches with more differing bits (default 70/256)
 *   opts.ratio     best / second-best distance ratio (default 0.85)
 *   opts.radius    only consider B features within this many pixels of the
 *                  A feature (or of opts.predict(i) → [x, y] if given)
 * Returns Int32Array of pairs [ia0, ib0, ia1, ib1, …].
 */
export function matchFeatures(A, B, opts = {}) {
    const maxDist = opts.maxDist ?? 70, ratio = opts.ratio ?? 0.85;
    const radius = opts.radius || 0, predict = opts.predict || null;
    // Spatial grid over B for windowed search.
    let grid = null, gcell = 0, gw = 0, gh = 0;
    if (radius) {
        gcell = Math.max(16, radius / 2);
        gw = Math.ceil(B.width / gcell) + 1; gh = Math.ceil(B.height / gcell) + 1;
        grid = Array.from({ length: gw * gh }, () => []);
        for (let j = 0; j < B.n; j++) {
            const cx = Math.min(gw - 1, Math.max(0, (B.x[j] / gcell) | 0)), cy = Math.min(gh - 1, Math.max(0, (B.y[j] / gcell) | 0));
            grid[cy * gw + cx].push(j);
        }
    }
    const bestAB = new Int32Array(A.n).fill(-1), distAB = new Int32Array(A.n);
    const bestBA = new Int32Array(B.n).fill(-1), distBA = new Int32Array(B.n).fill(1e9);
    const dA = A.desc, dB = B.desc;
    const consider = (i, j) => {
        const d = hamming(dA, i * NWORDS, dB, j * NWORDS);
        if (d < distBA[j]) { distBA[j] = d; bestBA[j] = i; }
        return d;
    };
    for (let i = 0; i < A.n; i++) {
        let b1 = 1e9, b2 = 1e9, bj = -1;
        const visit = (j) => {
            const d = consider(i, j);
            if (d < b1) { b2 = b1; b1 = d; bj = j; } else if (d < b2) b2 = d;
        };
        if (grid) {
            const [px, py] = predict ? predict(i) : [A.x[i], A.y[i]];
            if (!isFinite(px)) continue;
            const x0 = Math.max(0, Math.floor((px - radius) / gcell)), x1 = Math.min(gw - 1, Math.floor((px + radius) / gcell));
            const y0 = Math.max(0, Math.floor((py - radius) / gcell)), y1 = Math.min(gh - 1, Math.floor((py + radius) / gcell));
            for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) for (const j of grid[cy * gw + cx]) visit(j);
        } else {
            for (let j = 0; j < B.n; j++) visit(j);
        }
        if (bj >= 0 && b1 <= maxDist && b1 < ratio * b2) { bestAB[i] = bj; distAB[i] = b1; }
    }
    const out = [];
    for (let i = 0; i < A.n; i++) {
        const j = bestAB[i];
        if (j >= 0 && bestBA[j] === i) out.push(i, j);
    }
    return Int32Array.from(out);
}

export const DESC_WORDS = NWORDS;
