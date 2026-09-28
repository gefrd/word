// Monocular depth (Depth Anything V2 Small, Apache-2.0) for the no-sheet
// scan — the same model file "Photo → 3D" downloads, read from the same
// cache, run with onnxruntime-web directly. Output is relative inverse
// depth ("bigger = nearer"); refine.js fits its scale to the 3D points.

import * as ort from 'onnxruntime-web';

/* global __TRANSFORMERS_VERSION__ */
const TF_VER = typeof __TRANSFORMERS_VERSION__ !== 'undefined' ? __TRANSFORMERS_VERSION__ : '3.8.1';
export const DEPTH_URL = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx';
const CACHE = 'transformers-cache';
let session = null;

async function modelBytes(url, onProgress) {
    let cache = null;
    try { cache = await caches.open(CACHE); } catch (_) { /* no Cache API */ }
    if (cache) { const hit = await cache.match(url).catch(() => null); if (hit) return new Uint8Array(await hit.arrayBuffer()); }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`depth model download failed (${res.status})`);
    if (cache) cache.put(url, res.clone()).catch(() => {});
    const total = +res.headers.get('content-length') || 27e6;
    if (!res.body || !res.body.getReader) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader(), parts = [];
    let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; onProgress && onProgress(Math.min(1, n / total)); }
    const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

export async function loadDepth(opts = {}) {
    if (session) return session;
    ort.env.wasm.wasmPaths = opts.wasmPaths || `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TF_VER}/dist/`;
    if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(await modelBytes(opts.url || DEPTH_URL, opts.onProgress), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return session;
}

export async function releaseDepth() { if (session) { try { await session.release(); } catch (_) {} session = null; } }

/** Relative inverse depth of an RGBA image; long side ≈ `side` (multiple of 14). */
export async function estimateDepth(rgba, w, h, side = 364) {
    const s = side / Math.max(w, h);
    const dw = Math.max(56, Math.round(w * s / 14) * 14), dh = Math.max(56, Math.round(h * s / 14) * 14), n = dw * dh;
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    const data = new Float32Array(3 * n);
    for (let y = 0; y < dh; y++) {
        const fy = Math.min(h - 1.001, Math.max(0, (y + 0.5) * h / dh - 0.5)), y0 = fy | 0, ty = fy - y0;
        for (let x = 0; x < dw; x++) {
            const fx = Math.min(w - 1.001, Math.max(0, (x + 0.5) * w / dw - 0.5)), x0 = fx | 0, tx = fx - x0;
            const i00 = (y0 * w + x0) * 4, i01 = i00 + w * 4;
            for (let c = 0; c < 3; c++) {
                const v = (rgba[i00 + c] * (1 - tx) + rgba[i00 + 4 + c] * tx) * (1 - ty) + (rgba[i01 + c] * (1 - tx) + rgba[i01 + 4 + c] * tx) * ty;
                data[c * n + y * dw + x] = (v / 255 - mean[c]) / std[c];
            }
        }
    }
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, dh, dw]) });
    const t = out[session.outputNames[0]];
    const dims = t.dims, oh = dims[dims.length - 2], ow = dims[dims.length - 1];
    const depth = Float32Array.from(t.data);
    if (t.dispose) t.dispose();
    return { depth, dW: ow, dH: oh };
}
