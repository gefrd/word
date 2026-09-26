// Runs the 360° reconstruction off the main thread.
// Frames arrive as JPEG Blobs and are decoded one at a time at the size each
// stage needs, so memory stays low even with 40 keyframes on a 2 GB phone.

import { reconstructStreaming } from './reconstruct.js';

let canvas = null, ctx = null;

async function decode(blob, longSide) {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, longSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    if (!canvas) { canvas = new OffscreenCanvas(w, h); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return { rgba: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
}

self.onmessage = async (e) => {
    const { frames, poses, f, fullWidth, fullHeight, opts } = e.data;
    try {
        const out = await reconstructStreaming({
            count: frames.length,
            getFrame: (i, side) => decode(frames[i], side),
            poses, f, fullWidth, fullHeight,
        }, {
            ...opts,
            onProgress: (stage, p) => self.postMessage({ type: 'progress', stage, p }),
        });
        const { positions, indices, normals, colors } = out;
        self.postMessage({ type: 'done', positions, indices, normals, colors },
            [positions.buffer, indices.buffer, normals.buffer, colors.buffer]);
    } catch (err) {
        self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
    }
};
