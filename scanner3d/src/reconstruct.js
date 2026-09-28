// 360° reconstruction from posed keyframes: silhouette segmentation against
// the known marker sheet, voxel carving (shape-from-silhouette), surface
// extraction (naive surface nets), smoothing and per-vertex colouring.
//
// Pure functions over typed arrays so it runs in a Web Worker on any phone.

import { MARKERS, MARKER_MM, SHEET_W, SHEET_H, OBJECT_AREA, pageToWorld } from './board.js';

export const UNKNOWN = 1, BACKGROUND = 0, FOREGROUND = 2;

// ---------- camera helpers ----------

function projectionMatrix(R, t, f, cx, cy) {
    // P = K [R | t], row-major 3×4
    return [
        f * R[0] + cx * R[6], f * R[1] + cx * R[7], f * R[2] + cx * R[8], f * t[0] + cx * t[2],
        f * R[3] + cy * R[6], f * R[4] + cy * R[7], f * R[5] + cy * R[8], f * t[1] + cy * t[2],
        R[6], R[7], R[8], t[2],
    ];
}

function cameraCentre(R, t) {
    return [
        -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
        -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
        -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
    ];
}

// ---------- segmentation ----------

// Page regions whose appearance is not plain paper: markers (+ print bleed)
// and the thin printed guides. Pixels there are UNKNOWN, never evidence.
function buildPageMask(pxPerMm) {
    const W = Math.ceil(SHEET_W * pxPerMm), H = Math.ceil(SHEET_H * pxPerMm);
    const m = new Uint8Array(W * H); // 1 = not plain paper
    const fill = (x0, y0, x1, y1) => {
        const a = Math.max(0, Math.floor(x0 * pxPerMm)), b = Math.min(W, Math.ceil(x1 * pxPerMm));
        const c = Math.max(0, Math.floor(y0 * pxPerMm)), d = Math.min(H, Math.ceil(y1 * pxPerMm));
        for (let y = c; y < d; y++) m.fill(1, y * W + a, y * W + b);
    };
    const pad = 2.5;
    for (const mk of MARKERS) fill(mk.x - pad, mk.y - pad, mk.x + MARKER_MM + pad, mk.y + MARKER_MM + pad);
    const A = OBJECT_AREA, g = 1.8;
    fill(A.x0 - g, A.y0 - g, A.x1 + g, A.y0 + g);
    fill(A.x0 - g, A.y1 - g, A.x1 + g, A.y1 + g);
    fill(A.x0 - g, A.y0 - g, A.x0 + g, A.y1 + g);
    fill(A.x1 - g, A.y0 - g, A.x1 + g, A.y1 + g);
    fill(SHEET_W / 2 - 60, A.y0 + 1, SHEET_W / 2 + 60, A.y0 + 8);     // title text
    fill(SHEET_W / 2 - 52, A.y1 - 11, SHEET_W / 2 + 52, A.y1 - 1);    // 10 cm bar + label
    fill(SHEET_W / 2 - 8, SHEET_H / 2 - 8, SHEET_W / 2 + 8, SHEET_H / 2 + 8); // centre cross
    return { m, W, H, pxPerMm };
}
let pageMaskCache = null;

/**
 * Classify each pixel of a frame as BACKGROUND (plain paper visible),
 * FOREGROUND (something covers the paper) or UNKNOWN (off the sheet, over a
 * marker, or ambiguous such as a soft shadow).
 */
export function segmentFrame(rgba, width, height, pose, f) {
    if (!pageMaskCache) pageMaskCache = buildPageMask(2);
    const pm = pageMaskCache;
    const { R, t } = pose;
    const cx = width / 2, cy = height / 2;
    // Homography world-plane (z=0) → image, then invert: image → plane.
    const Hm = [
        f * R[0] + cx * R[6], f * R[1] + cx * R[7], f * t[0] + cx * t[2],
        f * R[3] + cy * R[6], f * R[4] + cy * R[7], f * t[1] + cy * t[2],
        R[6], R[7], t[2],
    ];
    const Hi = inv3(Hm);
    const out = new Uint8Array(width * height).fill(UNKNOWN);
    const offSheet = new Uint8Array(width * height);
    const pageX = new Float32Array(width * height), pageY = new Float32Array(width * height);

    // Pass 1: map pixels to page coordinates, collect paper samples per cell.
    const GX = 12, GY = 17;
    const cellL = Array.from({ length: GX * GY }, () => []);
    const onPaper = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const w = Hi[6] * x + Hi[7] * y + Hi[8];
            const X = (Hi[0] * x + Hi[1] * y + Hi[2]) / w;
            const Y = (Hi[3] * x + Hi[4] * y + Hi[5]) / w;
            const px = X + SHEET_W / 2, py = SHEET_H / 2 - Y;
            pageX[i] = px; pageY[i] = py;
            if (w <= 0 || px < 3 || py < 3 || px > SHEET_W - 3 || py > SHEET_H - 3) { offSheet[i] = 1; continue; }
            const mi = Math.floor(py * pm.pxPerMm) * pm.W + Math.floor(px * pm.pxPerMm);
            if (pm.m[mi]) continue;
            onPaper[i] = 1;
            if ((x & 3) === 0 && (y & 3) === 0) {
                const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
                const cxI = Math.min(GX - 1, Math.floor(px / SHEET_W * GX));
                const cyI = Math.min(GY - 1, Math.floor(py / SHEET_H * GY));
                cellL[cyI * GX + cxI].push(0.299 * r + 0.587 * g + 0.114 * b);
            }
        }
    }
    // Paper white level per cell: a high percentile ignores the object and
    // darker marks. Empty cells borrow the global level.
    const all = [];
    for (const c of cellL) for (const v of c) all.push(v);
    all.sort((a, b) => a - b);
    const globalWhite = all.length ? all[Math.floor(all.length * 0.9)] : 200;
    const white = new Float32Array(GX * GY);
    for (let k = 0; k < GX * GY; k++) {
        const c = cellL[k];
        if (c.length < 8) { white[k] = globalWhite; continue; }
        c.sort((a, b) => a - b);
        white[k] = Math.max(globalWhite * 0.35, c[Math.floor(c.length * 0.8)]);
    }
    // Average paper chroma (white balance of this frame)
    let cr = 0, cg = 0, cb = 0, cn = 0;
    for (let i = 0; i < width * height; i += 7) {
        if (!onPaper[i]) continue;
        const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
        const L = 0.299 * r + 0.587 * g + 0.114 * b;
        if (L < globalWhite * 0.8) continue;
        const s = r + g + b + 1;
        cr += r / s; cg += g / s; cb += b / s; cn++;
    }
    if (cn) { cr /= cn; cg /= cn; cb /= cn; } else { cr = cg = cb = 1 / 3; }

    // Pass 2: classify.
    for (let i = 0; i < width * height; i++) {
        if (!onPaper[i]) continue;
        const px = pageX[i], py = pageY[i];
        // bilinear white level
        const gx = Math.min(GX - 1.001, Math.max(0, px / SHEET_W * GX - 0.5));
        const gy = Math.min(GY - 1.001, Math.max(0, py / SHEET_H * GY - 0.5));
        const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
        const Lw = white[y0 * GX + x0] * (1 - fx) * (1 - fy) + white[y0 * GX + x0 + 1] * fx * (1 - fy)
            + white[(y0 + 1) * GX + x0] * (1 - fx) * fy + white[(y0 + 1) * GX + x0 + 1] * fx * fy;
        const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
        const L = 0.299 * r + 0.587 * g + 0.114 * b;
        const ratio = L / Math.max(1, Lw);
        const s = r + g + b + 1;
        const chroma = Math.hypot(r / s - cr, g / s - cg, b / s - cb);
        if (chroma > 0.055 || ratio < 0.42) out[i] = FOREGROUND;
        else if (ratio > 0.78 && chroma < 0.035) out[i] = BACKGROUND;
        // otherwise (e.g. soft shadow): UNKNOWN
    }
    // Clean isolated foreground specks (sensor noise, dust): 3×3 majority.
    return { mask: despeckle(out, width, height), offSheet };
}

function despeckle(m, w, h) {
    const o = m.slice();
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (m[i] !== FOREGROUND) continue;
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (m[i + dy * w + dx] === FOREGROUND) n++;
            if (n <= 2) o[i] = UNKNOWN;
        }
    }
    return o;
}

function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [
        A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
        B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
        C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
    ];
}

// ---------- colour model for pixels off the sheet ----------

// Off the sheet the paper test can't help (table, room behind the object).
// Learn what the object looks like from pixels the paper test marked as
// foreground, learn the background from image areas the object can never
// reach (outside the projected scan volume), then mark off-sheet pixels that
// clearly look like background as BACKGROUND. This is what carves the tops
// of objects when the phone looks at them from low angles.

const CB = 16, LB = 4; // chroma bins per axis, luma bins
function colorBin(r, g, b) {
    const s = r + g + b + 1;
    const cr = Math.min(CB - 1, Math.floor(r / s * CB * 1.5));
    const cg = Math.min(CB - 1, Math.floor(g / s * CB * 1.5));
    const l = Math.min(LB - 1, Math.floor((r + g + b) / 3 / 256 * LB));
    return (l * CB + cg) * CB + cr;
}

function scanVolume(voxelOpts = {}) {
    // No-sheet scans pass their own box (object frame, mm).
    if (voxelOpts.bounds) return voxelOpts.bounds;
    const margin = 12;
    const [x0, y1] = pageToWorld(OBJECT_AREA.x0 - margin, OBJECT_AREA.y0 - margin);
    const [x1, y0] = pageToWorld(OBJECT_AREA.x1 + margin, OBJECT_AREA.y1 + margin);
    return { x0, x1, y0, y1, z0: voxelOpts.zMin ?? 2.5, z1: voxelOpts.zMax ?? 220 };
}

function projectedBox(view, vol) {
    const p = projectionMatrix(view.R, view.t, view.f, view.width / 2, view.height / 2);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const X of [vol.x0, vol.x1]) for (const Y of [vol.y0, vol.y1]) for (const Z of [0, vol.z1]) {
        const w = p[8] * X + p[9] * Y + p[10] * Z + p[11];
        if (w <= 1) return null; // volume partly behind camera: box undefined
        const u = (p[0] * X + p[1] * Y + p[2] * Z + p[3]) / w, v = (p[4] * X + p[5] * Y + p[6] * Z + p[7]) / w;
        minX = Math.min(minX, u); maxX = Math.max(maxX, u); minY = Math.min(minY, v); maxY = Math.max(maxY, v);
    }
    return { minX, minY, maxX, maxY };
}

/** Accumulates object/background colour statistics across frames. */
export function createColorModel(vol) {
    const nb = CB * CB * LB;
    const objH = new Float32Array(nb), bgH = new Float32Array(nb);
    let objN = 0, bgN = 0, ready = false;
    return {
        add(view) {
            const { rgba, mask, offSheet, width, height } = view;
            const box = projectedBox(view, vol);
            for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
                const i = y * width + x;
                const bin = colorBin(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
                if (mask[i] === FOREGROUND) { objH[bin]++; objN++; }
                else if (box && offSheet[i] && (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY)) { bgH[bin]++; bgN++; }
            }
        },
        finish() {
            if (objN < 200 || bgN < 200) return false;
            for (let k = 0; k < nb; k++) { objH[k] = (objH[k] + 0.5) / objN; bgH[k] = (bgH[k] + 0.5) / bgN; }
            ready = true;
            return true;
        },
        /** Mark off-sheet pixels that clearly look like background. */
        apply(view) {
            if (!ready) return;
            const { rgba, mask, offSheet, width, height } = view;
            const box = projectedBox(view, vol);
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (!offSheet[i]) continue;
                if (box && (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY)) { mask[i] = BACKGROUND; continue; }
                const bin = colorBin(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
                if (bgH[bin] > 6 * objH[bin]) mask[i] = BACKGROUND;
            }
        },
    };
}

export { scanVolume };

// ---------- voxel carving ----------

/**
 * Incremental voxel carving. addView() takes one segmented view
 * ({ mask, width, height, R, t, f }) at a time so frames never need to be in
 * memory together; finish() returns { occ, nx, ny, nz, origin, voxel }.
 */
export function createCarver(opts = {}) {
    const voxel = opts.voxel || 2.0; // mm
    const { x0, x1, y0, y1, z0, z1 } = scanVolume(opts);
    const nx = Math.ceil((x1 - x0) / voxel), ny = Math.ceil((y1 - y0) / voxel), nz = Math.ceil((z1 - z0) / voxel);
    const origin = [x0, y0, z0];
    const N = nx * ny * nz;
    const fg = new Uint8Array(N), bg = new Uint8Array(N);
    const skipBg = opts.skipBg ?? 3;
    let viewCount = 0;
    return {
        addView(v) {
            viewCount++;
            const p = projectionMatrix(v.R, v.t, v.f, v.width / 2, v.height / 2);
            const mask = v.mask, W = v.width, H = v.height;
            for (let k = 0; k < nz; k++) {
                const Z = z0 + (k + 0.5) * voxel;
                for (let j = 0; j < ny; j++) {
                    const Y = y0 + (j + 0.5) * voxel;
                    // Terms constant along the row
                    const a0 = p[1] * Y + p[2] * Z + p[3], a1 = p[5] * Y + p[6] * Z + p[7], a2 = p[9] * Y + p[10] * Z + p[11];
                    let idx = (k * ny + j) * nx;
                    for (let i = 0; i < nx; i++, idx++) {
                        if (bg[idx] > skipBg) continue; // already clearly empty
                        const X = x0 + (i + 0.5) * voxel;
                        const w = p[8] * X + a2;
                        if (w <= 1) continue;
                        const u = (p[0] * X + a0) / w, vv = (p[4] * X + a1) / w;
                        if (u < 0 || vv < 0 || u >= W || vv >= H) continue;
                        const c = mask[(vv | 0) * W + (u | 0)];
                        if (c === FOREGROUND) { if (fg[idx] < 255) fg[idx]++; }
                        else if (c === BACKGROUND) { if (bg[idx] < 255) bg[idx]++; }
                    }
                }
            }
        },
        finish() {
            // Keep a voxel when paper/background was (almost) never seen
            // through it and it was seen as "covered" from enough directions.
            const minFg = opts.minFg ?? Math.max(2, Math.round(viewCount * 0.15));
            const bgFrac = opts.bgFrac ?? 0.06;
            const occ = new Uint8Array(N);
            for (let n = 0; n < N; n++) {
                const f = fg[n], b = bg[n];
                if (f >= minFg && b <= Math.max(0, Math.floor((f + b) * bgFrac))) occ[n] = 1;
            }
            // Opening (erode, then dilate) removes one-voxel spikes and
            // threads left by segmentation noise without eating real thin
            // parts like handles.
            const opened = dilate(erode(occ, nx, ny, nz), nx, ny, nz);
            for (let n = 0; n < N; n++) occ[n] = occ[n] & opened[n];
            keepMainComponents(occ, nx, ny, nz, opts.keepFrac ?? 0.02);
            return { occ, nx, ny, nz, origin, voxel };
        },
    };
}

/** Convenience: carve a list of in-memory views. */
export function carve(views, opts = {}) {
    const c = createCarver(opts);
    views.forEach((v, i) => { c.addView(v); if (opts.onProgress) opts.onProgress((i + 1) / views.length); });
    return c.finish();
}

function erode(occ, nx, ny, nz) {
    const out = new Uint8Array(occ.length);
    const sxy = nx * ny;
    for (let k = 0; k < nz; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
        const n = k * sxy + j * nx + i;
        if (!occ[n]) continue;
        // the bottom layer rests on the sheet: don't erode it from below
        const below = k === 0 ? 1 : occ[n - sxy], above = k === nz - 1 ? 0 : occ[n + sxy];
        out[n] = occ[n - 1] & occ[n + 1] & occ[n - nx] & occ[n + nx] & below & above;
    }
    return out;
}

function dilate(occ, nx, ny, nz) {
    const out = occ.slice();
    const sxy = nx * ny;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const n = k * sxy + j * nx + i;
        if (!occ[n]) continue;
        if (i > 0) out[n - 1] = 1; if (i < nx - 1) out[n + 1] = 1;
        if (j > 0) out[n - nx] = 1; if (j < ny - 1) out[n + nx] = 1;
        if (k > 0) out[n - sxy] = 1; if (k < nz - 1) out[n + sxy] = 1;
    }
    return out;
}

// Remove floating noise: drop small 6-connected components.
function keepMainComponents(occ, nx, ny, nz, keepFrac) {
    const label = new Int32Array(occ.length).fill(-1);
    const sizes = [];
    const stack = new Int32Array(occ.length);
    for (let s = 0; s < occ.length; s++) {
        if (!occ[s] || label[s] >= 0) continue;
        const id = sizes.length;
        let sp = 0, size = 0;
        stack[sp++] = s; label[s] = id;
        while (sp) {
            const n = stack[--sp]; size++;
            const i = n % nx, j = ((n / nx) | 0) % ny, k = (n / (nx * ny)) | 0;
            const nb = [i > 0 ? n - 1 : -1, i < nx - 1 ? n + 1 : -1, j > 0 ? n - nx : -1, j < ny - 1 ? n + nx : -1,
                k > 0 ? n - nx * ny : -1, k < nz - 1 ? n + nx * ny : -1];
            for (const q of nb) if (q >= 0 && occ[q] && label[q] < 0) { label[q] = id; stack[sp++] = q; }
        }
        sizes.push(size);
    }
    if (!sizes.length) return;
    // Several separate objects may be scanned together, so only drop parts
    // that are tiny both in absolute terms and next to the largest one.
    const maxSize = Math.max(...sizes);
    const minSize = Math.max(60, maxSize * keepFrac);
    for (let n = 0; n < occ.length; n++) if (occ[n] && sizes[label[n]] < minSize) occ[n] = 0;
}

// ---------- surface extraction ----------

/**
 * Naive surface nets on a smoothed occupancy field. Produces a watertight,
 * smooth-ish quad mesh (returned as triangles) in world millimetres.
 */
export function surfaceNets(grid) {
    const { occ, nx, ny, nz, origin, voxel } = grid;
    // Pad by 1 so the surface closes at the volume borders, and blur 3×3×3
    // to get a scalar field whose 0.5 iso-surface is smooth.
    const X = nx + 2, Y = ny + 2, Z = nz + 2;
    const field = new Float32Array(X * Y * Z);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (occ[(k * ny + j) * nx + i]) field[((k + 1) * Y + j + 1) * X + i + 1] = 1;
    }
    const blurred = blur3(field, X, Y, Z);
    const iso = 0.5;
    const vIndex = new Int32Array(X * Y * Z).fill(-1);
    const verts = [];
    const cornerOffs = [];
    for (let c = 0; c < 8; c++) cornerOffs.push([(c & 1), (c >> 1) & 1, (c >> 2) & 1]);
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const val = new Float32Array(8);
    for (let k = 0; k < Z - 1; k++) for (let j = 0; j < Y - 1; j++) for (let i = 0; i < X - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
            const o = cornerOffs[c];
            val[c] = blurred[((k + o[2]) * Y + j + o[1]) * X + i + o[0]];
            if (val[c] > iso) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of edges) {
            const ia = val[a] > iso, ib = val[b] > iso;
            if (ia === ib) continue;
            const tt = (iso - val[a]) / (val[b] - val[a]);
            const oa = cornerOffs[a], ob = cornerOffs[b];
            sx += oa[0] + (ob[0] - oa[0]) * tt; sy += oa[1] + (ob[1] - oa[1]) * tt; sz += oa[2] + (ob[2] - oa[2]) * tt; n++;
        }
        vIndex[(k * Y + j) * X + i] = verts.length / 3;
        // grid coords (padded) → world: cell (i,j,k) sample points are voxel centres of (i-1, j-1, k-1)
        verts.push(
            origin[0] + (i - 1 + sx / n + 0.5) * voxel,
            origin[1] + (j - 1 + sy / n + 0.5) * voxel,
            origin[2] + (k - 1 + sz / n + 0.5) * voxel,
        );
    }
    const tris = [];
    const at = (i, j, k) => vIndex[(k * Y + j) * X + i];
    for (let k = 1; k < Z - 1; k++) for (let j = 1; j < Y - 1; j++) for (let i = 1; i < X - 1; i++) {
        const s0 = blurred[(k * Y + j) * X + i] > iso;
        // edge along +x
        if (i < X - 1) {
            const s1 = blurred[(k * Y + j) * X + i + 1] > iso;
            if (s0 !== s1) quad(tris, at(i, j - 1, k - 1), at(i, j, k - 1), at(i, j, k), at(i, j - 1, k), s0);
        }
        if (j < Y - 1) {
            const s1 = blurred[(k * Y + j + 1) * X + i] > iso;
            if (s0 !== s1) quad(tris, at(i - 1, j, k - 1), at(i - 1, j, k), at(i, j, k), at(i, j, k - 1), s0);
        }
        if (k < Z - 1) {
            const s1 = blurred[((k + 1) * Y + j) * X + i] > iso;
            if (s0 !== s1) quad(tris, at(i - 1, j - 1, k), at(i, j - 1, k), at(i, j, k), at(i - 1, j, k), s0);
        }
    }
    const positions = new Float32Array(verts);
    // Flatten the base onto the sheet plane (z = 0).
    const minZ = origin[2] + 0.5 * voxel;
    for (let v = 2; v < positions.length; v += 3) if (positions[v] < minZ + voxel * 0.6) positions[v] = 0;
    return { positions, indices: new Uint32Array(tris) };
}

function quad(tris, a, b, c, d, flip) {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) tris.push(a, b, c, a, c, d);
    else tris.push(a, c, b, a, d, c);
}

function blur3(f, X, Y, Z) {
    const tmp = new Float32Array(f.length), out = new Float32Array(f.length);
    const pass = (src, dst, stride, len) => {
        for (let n = 0; n < src.length; n++) {
            const p = Math.floor(n / stride) % len;
            let s = src[n] * 2, w = 2;
            if (p > 0) { s += src[n - stride]; w++; }
            if (p < len - 1) { s += src[n + stride]; w++; }
            dst[n] = s / w;
        }
    };
    pass(f, tmp, 1, X);
    pass(tmp, out, X, Y);
    pass(out, tmp, X * Y, Z);
    return tmp;
}

/** Taubin smoothing (λ/μ) — smooths without shrinking the model. */
export function smoothMesh(mesh, iterations = 4) {
    const { positions, indices } = mesh;
    const nv = positions.length / 3;
    const nbr = Array.from({ length: nv }, () => new Set());
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        nbr[a].add(b).add(c); nbr[b].add(a).add(c); nbr[c].add(a).add(b);
    }
    const adj = nbr.map(s => Int32Array.from(s));
    const tmp = new Float32Array(positions.length);
    const step = (lambda) => {
        for (let v = 0; v < nv; v++) {
            const n = adj[v];
            if (!n.length) { tmp[v * 3] = positions[v * 3]; tmp[v * 3 + 1] = positions[v * 3 + 1]; tmp[v * 3 + 2] = positions[v * 3 + 2]; continue; }
            let sx = 0, sy = 0, sz = 0;
            for (const q of n) { sx += positions[q * 3]; sy += positions[q * 3 + 1]; sz += positions[q * 3 + 2]; }
            sx /= n.length; sy /= n.length; sz /= n.length;
            tmp[v * 3] = positions[v * 3] + lambda * (sx - positions[v * 3]);
            tmp[v * 3 + 1] = positions[v * 3 + 1] + lambda * (sy - positions[v * 3 + 1]);
            // keep the flat base on the sheet
            tmp[v * 3 + 2] = positions[v * 3 + 2] === 0 ? 0 : positions[v * 3 + 2] + lambda * (sz - positions[v * 3 + 2]);
        }
        positions.set(tmp);
    };
    for (let it = 0; it < iterations; it++) { step(0.5); step(-0.53); }
    return mesh;
}

export function computeNormals(positions, indices) {
    const n = new Float32Array(positions.length);
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const p of [a, b, c]) { n[p] += nx; n[p + 1] += ny; n[p + 2] += nz; }
    }
    for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
        n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    return n;
}

// ---------- colouring ----------

/**
 * Colour each vertex from the frames that see it best: facing the camera,
 * not hidden behind another part of the object (ray-marched through the
 * voxel grid), blending the three best views. Frames are fed one at a time
 * (any resolution) and only the three best samples per vertex are kept.
 */
export function createColorer(mesh, normals, grid) {
    const { positions } = mesh;
    const nv = positions.length / 3;
    const TOP = 3;
    const bestW = new Float32Array(nv * TOP);           // weights, descending
    const bestC = new Float32Array(nv * TOP * 3);       // colours
    const { occ, nx, ny, nz, origin, voxel } = grid;
    const solid = (x, y, z) => {
        const i = Math.floor((x - origin[0]) / voxel), j = Math.floor((y - origin[1]) / voxel), k = Math.floor((z - origin[2]) / voxel);
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return false;
        return occ[(k * ny + j) * nx + i] === 1;
    };
    return {
        addFrame(fr) {
            const P = projectionMatrix(fr.R, fr.t, fr.f, fr.width / 2, fr.height / 2), C = cameraCentre(fr.R, fr.t);
            for (let v = 0; v < nv; v++) {
                const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
                // The rim touching the sheet mixes in paper and shadow; it
                // takes the colour of the surface just above instead.
                if (pz < 3.5) continue;
                const nX = normals[v * 3], nY = normals[v * 3 + 1], nZ = normals[v * 3 + 2];
                let dx = C[0] - px, dy = C[1] - py, dz = C[2] - pz;
                const d = Math.hypot(dx, dy, dz); dx /= d; dy /= d; dz /= d;
                const facing = dx * nX + dy * nY + dz * nZ;
                if (facing < 0.15) continue;
                const w = facing * facing;
                if (w <= bestW[v * TOP + TOP - 1]) continue;
                const pw = P[8] * px + P[9] * py + P[10] * pz + P[11];
                const u = (P[0] * px + P[1] * py + P[2] * pz + P[3]) / pw;
                const q = (P[4] * px + P[5] * py + P[6] * pz + P[7]) / pw;
                if (u < 1 || q < 1 || u >= fr.width - 1 || q >= fr.height - 1) continue;
                // occlusion: march towards the camera, starting just outside the surface
                let hidden = false;
                for (let s = 2.2; s < 90; s += 1.0) {
                    const sx = px + (dx * s + nX * 1.2) * voxel, sy = py + (dy * s + nY * 1.2) * voxel, sz = pz + (dz * s + nZ * 1.2) * voxel;
                    if (sz < 0) break;
                    if (solid(sx, sy, sz)) { hidden = true; break; }
                }
                if (hidden) continue;
                const col = sampleBilinear(fr.rgba, fr.width, u, q);
                // insert into the sorted top-3
                let slot = TOP - 1;
                while (slot > 0 && bestW[v * TOP + slot - 1] < w) {
                    bestW[v * TOP + slot] = bestW[v * TOP + slot - 1];
                    for (let c = 0; c < 3; c++) bestC[(v * TOP + slot) * 3 + c] = bestC[(v * TOP + slot - 1) * 3 + c];
                    slot--;
                }
                bestW[v * TOP + slot] = w;
                for (let c = 0; c < 3; c++) bestC[(v * TOP + slot) * 3 + c] = col[c];
            }
        },
        finish() {
            const colors = new Float32Array(nv * 3);
            for (let v = 0; v < nv; v++) {
                let r = 0, g = 0, b = 0, ws = 0;
                for (let s = 0; s < TOP; s++) {
                    const w = bestW[v * TOP + s];
                    if (!w) break;
                    r += bestC[(v * TOP + s) * 3] * w; g += bestC[(v * TOP + s) * 3 + 1] * w; b += bestC[(v * TOP + s) * 3 + 2] * w; ws += w;
                }
                if (ws > 0) { colors[v * 3] = r / ws / 255; colors[v * 3 + 1] = g / ws / 255; colors[v * 3 + 2] = b / ws / 255; }
                else colors[v * 3] = colors[v * 3 + 1] = colors[v * 3 + 2] = -1;
            }
            // Vertices no frame saw (e.g. underside): average of coloured neighbours.
            fillUncolored(colors, mesh.indices, nv);
            return colors;
        },
    };
}

function fillUncolored(colors, indices, nv) {
    const nbr = Array.from({ length: nv }, () => []);
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        nbr[a].push(b, c); nbr[b].push(a, c); nbr[c].push(a, b);
    }
    for (let pass = 0; pass < 40; pass++) {
        let changed = 0;
        for (let v = 0; v < nv; v++) {
            if (colors[v * 3] >= 0) continue;
            let r = 0, g = 0, b = 0, n = 0;
            for (const q of nbr[v]) if (colors[q * 3] >= 0) { r += colors[q * 3]; g += colors[q * 3 + 1]; b += colors[q * 3 + 2]; n++; }
            if (n) { colors[v * 3] = r / n; colors[v * 3 + 1] = g / n; colors[v * 3 + 2] = b / n; changed++; }
        }
        if (!changed) break;
    }
    for (let i = 0; i < colors.length; i++) if (colors[i] < 0) colors[i] = 0.6;
}

function sampleBilinear(rgba, width, u, v) {
    const x0 = Math.floor(u - 0.5), y0 = Math.floor(v - 0.5);
    const fx = u - 0.5 - x0, fy = v - 0.5 - y0;
    const i00 = (y0 * width + x0) * 4, i10 = i00 + 4, i01 = i00 + width * 4, i11 = i01 + 4;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        out[c] = rgba[i00 + c] * (1 - fx) * (1 - fy) + rgba[i10 + c] * fx * (1 - fy) + rgba[i01 + c] * (1 - fx) * fy + rgba[i11 + c] * fx * fy;
    }
    return out;
}

/**
 * Whole pipeline, streaming: frames are fetched on demand so only one is in
 * memory at a time (important on 2 GB phones).
 *   getFrame(i, longSide) → Promise<{ rgba, width, height }>
 *   poses[i] = { R, t }, f in pixels at fullWidth × fullHeight.
 */
export async function reconstructStreaming({ count, getFrame, poses, f, fullWidth, fullHeight }, opts = {}) {
    const report = opts.onProgress || (() => {});
    const maskSide = opts.maskSide || 640, colorSide = opts.colorSide || 960;
    const vol = scanVolume(opts);
    const scaleF = (w, h) => f * Math.max(w, h) / Math.max(fullWidth, fullHeight);

    // Pass 1: segment each frame; learn object/background colours.
    const masks = [];
    const model = createColorModel(vol);
    for (let i = 0; i < count; i++) {
        report('segment', i / count);
        const fr = await getFrame(i, maskSide);
        const fi = scaleF(fr.width, fr.height);
        const seg = segmentFrame(fr.rgba, fr.width, fr.height, poses[i], fi);
        const view = { mask: seg.mask, offSheet: seg.offSheet, rgba: fr.rgba, width: fr.width, height: fr.height, R: poses[i].R, t: poses[i].t, f: fi };
        if (opts.colorModel !== false) model.add(view);
        masks.push({ mask: seg.mask, offSheet: seg.offSheet, width: fr.width, height: fr.height, f: fi });
    }
    const useModel = opts.colorModel !== false && model.finish();

    // Pass 2: refine off-sheet pixels, carve.
    const carver = createCarver(opts);
    for (let i = 0; i < count; i++) {
        report('carve', i / count);
        const m = masks[i];
        const view = { ...m, R: poses[i].R, t: poses[i].t };
        if (useModel) view.rgba = (await getFrame(i, maskSide)).rgba, model.apply(view);
        carver.addView(view);
        if (!opts.keepMasks) masks[i].offSheet = null;
    }
    const grid = carver.finish();
    let solidCount = 0;
    for (let i = 0; i < grid.occ.length; i++) solidCount += grid.occ[i];
    if (solidCount < 20) throw new Error('No object found on the sheet. Make sure it stands in the middle and is not white.');

    const out = await meshAndColor(grid, { count, getFrame, poses, scaleF }, colorSide, opts, report);
    return { ...out, masks: opts.keepMasks ? masks.map(m => m.mask) : undefined };
}

async function meshAndColor(grid, { count, getFrame, poses, scaleF }, colorSide, opts, report) {
    report('mesh', 0);
    const mesh = smoothMesh(surfaceNets(grid), opts.smooth ?? 4);
    const normals = computeNormals(mesh.positions, mesh.indices);

    const colorer = createColorer(mesh, normals, grid);
    for (let i = 0; i < count; i++) {
        report('color', i / count);
        const fr = await getFrame(i, colorSide);
        colorer.addFrame({ rgba: fr.rgba, width: fr.width, height: fr.height, R: poses[i].R, t: poses[i].t, f: scaleF(fr.width, fr.height) });
    }
    const colors = colorer.finish();
    report('done', 1);
    return { positions: mesh.positions, indices: mesh.indices, normals, colors, grid };
}

/**
 * No-sheet pipeline: the object masks come from the AI (getMask(i) →
 * { mask: FOREGROUND/BACKGROUND/UNKNOWN per pixel, width, height }) and the
 * carving box from the caller (opts.bounds, object frame in mm, z = 0 on the
 * ground). Frames are streamed one at a time like reconstructStreaming.
 */
export async function reconstructWithMasks({ count, getFrame, getMask, poses, f, fullWidth, fullHeight }, opts = {}) {
    const report = opts.onProgress || (() => {});
    const colorSide = opts.colorSide || 960;
    const scaleF = (w, h) => f * Math.max(w, h) / Math.max(fullWidth, fullHeight);
    const carver = createCarver(opts);
    for (let i = 0; i < count; i++) {
        report('carve', i / count);
        const m = await getMask(i);
        carver.addView({ mask: m.mask, width: m.width, height: m.height, R: poses[i].R, t: poses[i].t, f: scaleF(m.width, m.height) });
    }
    const grid = carver.finish();
    let solidCount = 0;
    for (let i = 0; i < grid.occ.length; i++) solidCount += grid.occ[i];
    if (solidCount < 20) throw new Error('EMPTY_HULL');
    // optional extra carving (depth maps, colour consistency) before meshing
    if (opts.refineGrid) { report('refine', 0); await opts.refineGrid(grid); keepMainComponents(grid.occ, grid.nx, grid.ny, grid.nz, 0.15); }
    return meshAndColor(grid, { count, getFrame, poses, scaleF }, colorSide, opts, report);
}
