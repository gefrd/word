// Object masks with BRIA RMBG-1.4 (the same model file "Photo → 3D" uses,
// so it is downloaded once and shared through the browser cache).
//
// The published ONNX file declares a fixed 1024×1024 input, but every
// resize inside the network follows the input shape. We relax the two
// input dimensions in memory (same byte length, nothing else changes) and
// run it at ~384 px: ~15× faster than 1024 px with nearly the same mask —
// the difference between "3 minutes" and "20 minutes" for a 30-frame scan
// on a mid-range phone.

import * as ort from 'onnxruntime-web';

/* global __TRANSFORMERS_VERSION__ */
const TF_VER = typeof __TRANSFORMERS_VERSION__ !== 'undefined' ? __TRANSFORMERS_VERSION__ : '3.8.1';
export const RMBG_URL = 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx';
// Same runtime files (and so the same cache entries) as transformers.js uses.
const DEFAULT_WASM = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TF_VER}/dist/`;
const CACHE = 'transformers-cache';

let session = null, inputName = 'input';

/**
 * Make the input's height/width symbolic. Encoded dims are
 *   0A 03 08 80 08   (dim { dim_value: 1024 })
 * and become
 *   0A 03 12 01 68   (dim { dim_param: "h" })  — same length.
 */
export function patchInputDims(bytes) {
    const pat = [0x08, 0x03, 0x0a, 0x03, 0x08, 0x80, 0x08, 0x0a, 0x03, 0x08, 0x80, 0x08];
    // graph inputs are serialised after the weights: search from the end
    outer: for (let i = bytes.length - pat.length; i >= 0; i--) {
        for (let k = 0; k < pat.length; k++) if (bytes[i + k] !== pat[k]) continue outer;
        bytes.set([0x12, 0x01, 0x68], i + 4);
        bytes.set([0x12, 0x01, 0x77], i + 9);
        return true;
    }
    return false;
}

async function readWithProgress(res, onProgress) {
    const total = +res.headers.get('content-length') || 44403226;
    if (!res.body || !res.body.getReader) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    let buf = new Uint8Array(total), n = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (n + value.length > buf.length) { const b2 = new Uint8Array(Math.max(buf.length * 1.5, n + value.length)); b2.set(buf.subarray(0, n)); buf = b2; }
        buf.set(value, n); n += value.length;
        onProgress && onProgress(Math.min(1, n / total));
    }
    return n === buf.length ? buf : buf.slice(0, n);
}

async function modelBytes(url, onProgress) {
    let cache = null;
    try { cache = await caches.open(CACHE); } catch (_) { /* no Cache API (http, old WebView) */ }
    if (cache) {
        const hit = await cache.match(url).catch(() => null);
        if (hit) return new Uint8Array(await hit.arrayBuffer());
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`model download failed (${res.status})`);
    if (cache) {
        // keep a copy for next time (and for Photo → 3D, which reads the same cache)
        cache.put(url, res.clone()).catch(() => {});
    }
    return readWithProgress(res, onProgress);
}

/** Load the model once. opts: { url, wasmPaths, onProgress(p) } */
export async function loadRMBG(opts = {}) {
    if (session) return session;
    ort.env.wasm.wasmPaths = opts.wasmPaths || DEFAULT_WASM;
    if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;
    const bytes = await modelBytes(opts.url || RMBG_URL, opts.onProgress);
    if (!patchInputDims(bytes)) console.warn('RMBG: input shape not patched, running at 1024 px');
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    inputName = session.inputNames[0] || 'input';
    return session;
}

export function rmbgLoaded() { return !!session; }

export async function releaseRMBG() {
    if (session) { try { await session.release(); } catch (_) {} session = null; }
}

/**
 * Soft object mask (0..255) for an RGBA image, returned at the image's
 * own size. `side` = long side of the network input (multiple of 32).
 */
export async function segmentObject(rgba, w, h, side = 384) {
    const s = side / Math.max(w, h);
    const mw = Math.max(64, Math.round(w * s / 32) * 32), mh = Math.max(64, Math.round(h * s / 32) * 32);
    const n = mw * mh;
    const data = new Float32Array(3 * n);
    // bilinear resize + normalise (mean 0.5, std 1)
    for (let y = 0; y < mh; y++) {
        const fy = Math.min(h - 1.001, Math.max(0, (y + 0.5) * h / mh - 0.5)), y0 = fy | 0, ty = fy - y0;
        for (let x = 0; x < mw; x++) {
            const fx = Math.min(w - 1.001, Math.max(0, (x + 0.5) * w / mw - 0.5)), x0 = fx | 0, tx = fx - x0;
            const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
            const o = y * mw + x;
            for (let c = 0; c < 3; c++) {
                const v = (rgba[i00 + c] * (1 - tx) + rgba[i10 + c] * tx) * (1 - ty) + (rgba[i01 + c] * (1 - tx) + rgba[i11 + c] * tx) * ty;
                data[c * n + o] = v / 255 - 0.5;
            }
        }
    }
    const feeds = { [inputName]: new ort.Tensor('float32', data, [1, 3, mh, mw]) };
    const out = await session.run(feeds);
    const t = out[session.outputNames[0]];
    const p = t.data; // [1,1,mh,mw] probabilities
    // upsample to w×h
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const fy = Math.min(mh - 1.001, Math.max(0, (y + 0.5) * mh / h - 0.5)), y0 = fy | 0, ty = fy - y0;
        for (let x = 0; x < w; x++) {
            const fx = Math.min(mw - 1.001, Math.max(0, (x + 0.5) * mw / w - 0.5)), x0 = fx | 0, tx = fx - x0;
            const i = y0 * mw + x0;
            const v = (p[i] * (1 - tx) + p[i + 1] * tx) * (1 - ty) + (p[i + mw] * (1 - tx) + p[i + mw + 1] * tx) * ty;
            mask[y * w + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
        }
    }
    if (t.dispose) t.dispose();
    return mask;
}
