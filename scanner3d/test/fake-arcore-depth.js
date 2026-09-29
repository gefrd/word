// Imitate a phone's depth sensor (ARCore depth API as WebXR "depth-sensing"
// gives it) from the true depth of a synthetic frame: coarse (160 px on the
// long side), each depth pixel an average over its area (so a cup's rim and
// its inside get mixed), smoothed, a per-frame scale error, a slow warp,
// per-pixel noise, a small misalignment with the camera picture and holes.
// Rather pessimistic on purpose.
//   rgba: the packed 24-bit depth render (synth-free.js depthURL), fw×fh
// Returns { m: Float32Array (metres, 0 = none), w, h } in view orientation.
export function fakeARCoreDepth(rgba, fw, fh, seed = 1, opts = {}) {
    const k = opts.noise ?? 1;
    const long = opts.long ?? 160;
    const w = fw >= fh ? long : Math.round(long * fw / fh), h = fw >= fh ? Math.round(long * fh / fw) : long;
    let rng = 4242 + seed * 131;
    const rnd = () => { rng = (rng * 16807) % 2147483647; return rng / 2147483647; };
    const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / Math.SQRT1_2; }; // ≈ N(0, 1)
    // misalignment with the picture: up to one depth pixel
    const ox = (rnd() - 0.5) * 2 * k, oy = (rnd() - 0.5) * 2 * k;
    const z = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, Math.floor((x + ox) * fw / w)), x1 = Math.min(fw, Math.ceil((x + 1 + ox) * fw / w));
        const y0 = Math.max(0, Math.floor((y + oy) * fh / h)), y1 = Math.min(fh, Math.ceil((y + 1 + oy) * fh / h));
        let s = 0, n = 0;
        for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) {
            const i = (yy * fw + xx) * 4;
            const d = (rgba[i] * 65536 + rgba[i + 1] * 256 + rgba[i + 2]) / 16777215 * 4000;
            if (d > 1 && d < 3990) { s += d; n++; }
        }
        z[y * w + x] = n ? s / n : 0;
    }
    // smoothing (two 3×3 box passes over valid pixels)
    let cur = z;
    for (let pass = 0; pass < 2; pass++) {
        const out = new Float32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            let s = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx, yy = y + dy;
                if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
                const v = cur[yy * w + xx];
                if (v > 0) { s += v; n++; }
            }
            out[y * w + x] = cur[y * w + x] > 0 && n ? s / n : 0;
        }
        cur = out;
    }
    const scale = 1 + (rnd() - 0.5) * 0.03 * k, ph = rnd() * 6;
    const m = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = cur[y * w + x];
        if (!(v > 0) || rnd() < 0.03 * k) continue;             // holes
        const warp = 1 + 0.015 * k * Math.sin(x / w * 4 + ph) * Math.cos(y / h * 3 + ph);
        m[y * w + x] = v * scale * warp * (1 + 0.015 * k * gauss()) / 1000;
    }
    return { m, w, h };
}
