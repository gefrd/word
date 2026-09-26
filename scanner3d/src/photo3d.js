// Photo → 3D: runs the AI worker, then turns mask + depth into a closed,
// textured "volumetric relief" mesh (front from depth, rounded silhouette
// edges, smooth back) that can be viewed, exported and placed in AR.

import * as THREE from 'three';

let worker = null, workerDevice = null;

function getWorker(config) {
    if (!worker) {
        worker = new Worker(new URL('./photo3d.worker.js', import.meta.url), { type: 'module' });
        worker.postMessage({ cmd: 'config', ...config });
    }
    return worker;
}

/** Decode a photo (EXIF orientation respected) to RGBA at ≤ maxSide. */
export async function loadPhoto(file, maxSide = 1024) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (_) { bmp = await createImageBitmap(file); }
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    return { canvas: c, rgba: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
}

/** Run mask + depth in the worker. onProgress(stage, p). */
export function analyzePhoto(photo, opts = {}, onProgress = () => {}) {
    const w = getWorker(opts.workerConfig || {});
    return new Promise((resolve, reject) => {
        const onMsg = (e) => {
            const m = e.data;
            if (m.type === 'ready') { workerDevice = m.device; return; }
            if (m.type === 'progress') { onProgress(m.stage, m.p, m); return; }
            w.removeEventListener('message', onMsg);
            if (m.type === 'done') resolve(m);
            else reject(new Error(m.message || 'AI failed'));
        };
        w.addEventListener('message', onMsg);
        const rgba = new Uint8ClampedArray(photo.rgba); // copy; the original stays for the texture
        w.postMessage({ cmd: 'run', rgba: rgba.buffer, width: photo.width, height: photo.height, segSize: opts.segSize || 1024, skipDepth: !!opts.skipDepth }, [rgba.buffer]);
    });
}

export function aiDevice() { return workerDevice; }

// ---------- mesh from mask + depth ----------

/**
 * @param photo   { canvas, width, height }
 * @param ai      { mask (Uint8 0..255, width×height), depth (Float32 dW×dH) | null }
 * @param opts    { grid: vertices on the long side, thickness: 0..1 of width, heightMm }
 */
export function reliefMesh(photo, ai, opts = {}) {
    const { width, height } = photo;
    const mask = ai.mask;
    const G = opts.grid || 160;
    const thickness = opts.thickness ?? 0.35;
    const heightMm = opts.heightMm || 150;

    // Bounding box of the object, found on a coarse grid after dropping
    // specks, so stray mask noise near the frame edge can't inflate it.
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    {
        const cs = Math.max(1, Math.max(width, height) / 96);
        const cw = Math.ceil(width / cs), ch = Math.ceil(height / cs);
        const coarse = new Uint8Array(cw * ch);
        for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
            const x = Math.min(width - 1, Math.round(i * cs)), y = Math.min(height - 1, Math.round(j * cs));
            coarse[j * cw + i] = mask[y * width + x] > 127 ? 1 : 0;
        }
        keepMainParts(coarse, cw, ch);
        for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
            if (!coarse[j * cw + i]) continue;
            x0 = Math.min(x0, Math.floor((i - 1) * cs)); x1 = Math.max(x1, Math.ceil((i + 1) * cs));
            y0 = Math.min(y0, Math.floor((j - 1) * cs)); y1 = Math.max(y1, Math.ceil((j + 1) * cs));
        }
        x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(width - 1, x1); y1 = Math.min(height - 1, y1);
    }
    if (x1 < 0 || (x1 - x0) * (y1 - y0) < 64) throw new Error('No object found in the photo.');
    const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.03) + 2;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const step = Math.max(bw, bh) / G;
    const nx = Math.max(2, Math.round(bw / step) + 1), ny = Math.max(2, Math.round(bh / step) + 1);

    const sampleMask = (x, y) => {
        const xi = Math.min(width - 1, Math.max(0, Math.round(x))), yi = Math.min(height - 1, Math.max(0, Math.round(y)));
        return mask[yi * width + xi];
    };
    const inside = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        inside[j * nx + i] = sampleMask(x0 + i * step, y0 + j * step) > 127 ? 1 : 0;
    }
    keepMainParts(inside, nx, ny);
    fillHoles(inside, nx, ny);

    // Distance to the silhouette (chamfer 3-4), for rounded edges.
    // Blurred distance field: rounds the ridge a pure distance transform
    // leaves along the middle of wide parts.
    const dt = blurInside(distanceTransform(inside, nx, ny), inside, nx, ny, 3);
    let dmax = 0;
    for (let k = 0; k < dt.length; k++) if (dt[k] > dmax) dmax = dt[k];
    const edgeBand = Math.max(2, dmax * 0.6);

    // Depth sampled on the grid, normalised to 0..1 inside the object.
    const dvals = new Float32Array(nx * ny);
    let dNorm = null;
    if (ai.depth) {
        const vals = [];
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            const u = (x0 + i * step) / width * (ai.dW - 1), v = (y0 + j * step) / height * (ai.dH - 1);
            dvals[k] = bilinear(ai.depth, ai.dW, ai.dH, u, v);
            if (inside[k]) vals.push(dvals[k]);
        }
        vals.sort((a, b) => a - b);
        const lo = vals[Math.floor(vals.length * 0.03)], hi = vals[Math.floor(vals.length * 0.97)];
        dNorm = (d) => Math.min(1, Math.max(0, (d - lo) / Math.max(1e-6, hi - lo)));
    }

    const s = heightMm / bh; // mm per pixel
    const T = thickness * bw * s;
    const index = new Int32Array(nx * ny * 2).fill(-1);
    const pos = [], uv = [];
    const isBoundary = (i, j) => {
        if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) return true;
        return !inside[j * nx + i - 1] || !inside[j * nx + i + 1] || !inside[(j - 1) * nx + i] || !inside[(j + 1) * nx + i];
    };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!inside[k]) continue;
        const px = x0 + i * step, py = y0 + j * step;
        const X = (px - (x0 + bw / 2)) * s;
        const Z = (y0 + bh - py) * s; // up
        const u = (px - x0) / bw, v = 1 - (py - y0) / bh;
        if (isBoundary(i, j)) {
            index[k * 2] = index[k * 2 + 1] = pos.length / 3;
            pos.push(X, 0, Z); uv.push(u, v);
            continue;
        }
        const e = Math.min(1, dt[k] / edgeBand);
        const bulge = Math.sqrt(1 - (1 - e) * (1 - e)); // circular edge profile
        const dn = dNorm ? dNorm(dvals[k]) : 0.5;
        // Cap by the local half-width so narrow parts (arms, handles) get a
        // round cross-section instead of becoming thick slabs.
        const localR = dt[k] * step * s * 1.1;
        const front = softMin(T * bulge * (0.3 + 0.7 * dn), localR * (0.6 + 0.6 * dn), T * 0.12);
        const back = softMin(T * 0.45 * bulge, localR * 0.7, T * 0.12);
        index[k * 2] = pos.length / 3; pos.push(X, -front, Z); uv.push(u, v);
        index[k * 2 + 1] = pos.length / 3; pos.push(X, back, Z); uv.push(u, v);
    }
    const tris = [];
    const addCell = (a, b, c, d) => {
        // a=(i,j) b=(i+1,j) c=(i+1,j+1) d=(i,j+1); front side faces -Y
        const pick = (side) => [a, b, c, d].map(k => (k < 0 ? -1 : index[k * 2 + side]));
        for (const side of [0, 1]) {
            const [A, B, C, D] = pick(side);
            const tri = (p, q, r) => { if (p < 0 || q < 0 || r < 0) return; if (side === 0) tris.push(p, q, r); else tris.push(p, r, q); };
            if (A >= 0 && B >= 0 && C >= 0 && D >= 0) { tri(A, C, B); tri(A, D, C); }
            else if (A < 0) tri(B, D, C);
            else if (B < 0) tri(A, D, C);
            else if (C < 0) tri(A, D, B);
            else if (D < 0) tri(A, C, B);
        }
    };
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, d = a + nx, c = d + 1;
        const n = inside[a] + inside[b] + inside[c] + inside[d];
        if (n < 3) continue;
        addCell(inside[a] ? a : -1, inside[b] ? b : -1, inside[c] ? c : -1, inside[d] ? d : -1);
    }
    let positions = new Float32Array(pos);
    const indices = new Uint32Array(tris);
    // Light smoothing of the depth relief to hide network noise.
    smoothRelief(positions, indices, 2);
    // Make sure faces point outwards regardless of winding choices above.
    if (signedVolume(positions, indices) < 0) {
        for (let t = 0; t < indices.length; t += 3) { const tmp = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = tmp; }
    }

    // Texture: the cropped photo.
    const tex = document.createElement('canvas');
    tex.width = bw; tex.height = bh;
    tex.getContext('2d').drawImage(photo.canvas, x0, y0, bw, bh, 0, 0, bw, bh);
    const texture = new THREE.CanvasTexture(tex);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = true;
    return { positions, indices, uvs: new Float32Array(uv), texture, textureCanvas: tex, size: { w: bw * s, h: heightMm, d: T * 1.45 } };
}

function keepMainParts(inside, nx, ny) {
    const label = new Int32Array(inside.length).fill(-1);
    const sizes = [];
    const stack = [];
    for (let s = 0; s < inside.length; s++) {
        if (!inside[s] || label[s] >= 0) continue;
        const id = sizes.length; let size = 0;
        stack.push(s); label[s] = id;
        while (stack.length) {
            const n = stack.pop(); size++;
            const i = n % nx, j = (n / nx) | 0;
            for (const q of [i > 0 ? n - 1 : -1, i < nx - 1 ? n + 1 : -1, j > 0 ? n - nx : -1, j < ny - 1 ? n + nx : -1]) {
                if (q >= 0 && inside[q] && label[q] < 0) { label[q] = id; stack.push(q); }
            }
        }
        sizes.push(size);
    }
    if (!sizes.length) return;
    // Keep separate parts of the object (e.g. an arm with a gap to the body),
    // drop specks.
    const minSize = Math.max(12, Math.max(...sizes) * 0.05);
    for (let n = 0; n < inside.length; n++) if (inside[n] && sizes[label[n]] < minSize) inside[n] = 0;
}

// Background regions not connected to the image border are holes in the
// mask (noise inside the object) — fill them.
function fillHoles(inside, nx, ny) {
    const outside = new Uint8Array(inside.length);
    const stack = [];
    for (let i = 0; i < nx; i++) { stack.push(i, (ny - 1) * nx + i); }
    for (let j = 0; j < ny; j++) { stack.push(j * nx, j * nx + nx - 1); }
    while (stack.length) {
        const n = stack.pop();
        if (inside[n] || outside[n]) continue;
        outside[n] = 1;
        const i = n % nx, j = (n / nx) | 0;
        if (i > 0) stack.push(n - 1); if (i < nx - 1) stack.push(n + 1);
        if (j > 0) stack.push(n - nx); if (j < ny - 1) stack.push(n + nx);
    }
    for (let n = 0; n < inside.length; n++) if (!outside[n]) inside[n] = 1;
}

function blurInside(d, inside, nx, ny, passes) {
    let src = d, dst = new Float32Array(d.length);
    for (let p = 0; p < passes; p++) {
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            if (!inside[k]) { dst[k] = 0; continue; }
            let s = src[k] * 4, w = 4;
            if (i > 0 && inside[k - 1]) { s += src[k - 1]; w++; }
            if (i < nx - 1 && inside[k + 1]) { s += src[k + 1]; w++; }
            if (j > 0 && inside[k - nx]) { s += src[k - nx]; w++; }
            if (j < ny - 1 && inside[k + nx]) { s += src[k + nx]; w++; }
            dst[k] = Math.min(s / w, src[k] + 0.5); // never grow past the edge
        }
        [src, dst] = [dst, src];
    }
    return src;
}

function softMin(a, b, k) {
    // smooth minimum (log-sum-exp): no crease where a and b cross
    // (never below 0, so thin edges can't fold through the seam)
    const m = Math.min(a, b);
    return Math.max(0, m - k * Math.log(Math.exp((m - a) / k) + Math.exp((m - b) / k)));
}

function distanceTransform(inside, nx, ny) {
    const INF = 1e9;
    const d = new Float32Array(nx * ny);
    for (let k = 0; k < d.length; k++) d[k] = inside[k] ? INF : 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i; if (!d[k]) continue;
        if (i > 0) d[k] = Math.min(d[k], d[k - 1] + 1);
        if (j > 0) d[k] = Math.min(d[k], d[k - nx] + 1);
        if (i > 0 && j > 0) d[k] = Math.min(d[k], d[k - nx - 1] + 1.4142);
        if (i < nx - 1 && j > 0) d[k] = Math.min(d[k], d[k - nx + 1] + 1.4142);
        if (i === 0 || j === 0) d[k] = Math.min(d[k], 1);
    }
    for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i; if (!d[k]) continue;
        if (i < nx - 1) d[k] = Math.min(d[k], d[k + 1] + 1);
        if (j < ny - 1) d[k] = Math.min(d[k], d[k + nx] + 1);
        if (i < nx - 1 && j < ny - 1) d[k] = Math.min(d[k], d[k + nx + 1] + 1.4142);
        if (i > 0 && j < ny - 1) d[k] = Math.min(d[k], d[k + nx - 1] + 1.4142);
        if (i === nx - 1 || j === ny - 1) d[k] = Math.min(d[k], 1);
    }
    return d;
}

function bilinear(a, w, h, u, v) {
    const x0 = Math.max(0, Math.min(w - 2, Math.floor(u))), y0 = Math.max(0, Math.min(h - 2, Math.floor(v)));
    const fx = Math.min(1, Math.max(0, u - x0)), fy = Math.min(1, Math.max(0, v - y0));
    return a[y0 * w + x0] * (1 - fx) * (1 - fy) + a[y0 * w + x0 + 1] * fx * (1 - fy) + a[(y0 + 1) * w + x0] * (1 - fx) * fy + a[(y0 + 1) * w + x0 + 1] * fx * fy;
}

function smoothRelief(p, idx, iters) {
    const nv = p.length / 3;
    const acc = new Float32Array(nv), cnt = new Uint16Array(nv);
    for (let it = 0; it < iters; it++) {
        acc.fill(0); cnt.fill(0);
        for (let t = 0; t < idx.length; t += 3) for (let e = 0; e < 3; e++) {
            const a = idx[t + e], b = idx[t + (e + 1) % 3];
            acc[a] += p[b * 3 + 1]; cnt[a]++;
            acc[b] += p[a * 3 + 1]; cnt[b]++;
        }
        for (let v = 0; v < nv; v++) {
            if (!cnt[v] || p[v * 3 + 1] === 0) continue; // seam stays on the silhouette plane
            p[v * 3 + 1] = p[v * 3 + 1] * 0.5 + (acc[v] / cnt[v]) * 0.5;
        }
    }
}

function signedVolume(p, idx) {
    let V = 0;
    for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
        V += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return V;
}
