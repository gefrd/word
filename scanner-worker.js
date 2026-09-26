// src/modules/tools/scanner-worker.js
// Heavy pixel work off the main thread.
//
// Why this file exists: warping and filtering a 2400x3200 page touches ~7.7
// million pixels several times over. On the main thread that is a 1-2 second
// freeze on a Tecno/Infinix — no spinner, no scrolling, taps ignored. Here the
// UI stays at 60fps and only the preview updates late.
//
// Protocol (request -> response, matched by `id`):
//   { id, cmd: 'ping' }
//     -> { id, ok: true, canEncode }            capability probe
//   { id, cmd: 'detect', width, height, buffer }
//     -> { id, ok: true, corners, sharpness }   corners in the frame's own coords
//   { id, cmd: 'render', width, height, buffer, corners, outWidth, outHeight,
//     filter, rotation, brightness, contrast, encode }
//     -> { id, ok: true, blob | buffer, width, height }
//
// Pixel buffers travel as transferable ArrayBuffers, so nothing is copied in
// either direction. The caller loses its reference — that is intentional.

import {
    toGray,
    detectDocument,
    sharpnessScore,
    warpPerspective,
    applyFilterToPixels,
    rotatePixels,
    estimateOutputSize
} from './scanner-cv.js';

// OffscreenCanvas.convertToBlob lands in Safari 16.4; on anything older we hand
// the raw pixels back and let the main thread encode them on a normal canvas.
const CAN_ENCODE = typeof OffscreenCanvas !== 'undefined' &&
    typeof OffscreenCanvas.prototype.convertToBlob === 'function';

let scratchCanvas = null;
let scratchCtx = null;

async function encodePixels(rgba, width, height, encode) {
    const type = (encode && encode.type) || 'image/jpeg';
    const quality = (encode && encode.quality) || 0.82;

    if (!scratchCanvas || scratchCanvas.width !== width || scratchCanvas.height !== height) {
        scratchCanvas = new OffscreenCanvas(width, height);
        scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: false });
    }
    scratchCtx.putImageData(new ImageData(rgba, width, height), 0, 0);
    return scratchCanvas.convertToBlob({ type, quality });
}

function handleDetect(msg) {
    const { width, height, buffer } = msg;
    const rgba = new Uint8ClampedArray(buffer);
    const gray = toGray(rgba, width, height);
    return {
        corners: detectDocument(gray, width, height),
        sharpness: sharpnessScore(gray, width, height)
    };
}

async function handleRender(msg) {
    const {
        width, height, buffer, corners,
        filter = 'magic', rotation = 0,
        brightness = 0, contrast = 0,
        maxDim = 2400, encode
    } = msg;

    let rgba = new Uint8ClampedArray(buffer);
    let w = width;
    let h = height;

    // 1. Perspective correction. Skipped when there are no corners (Photo mode,
    //    or a legacy page that was already flattened destructively).
    if (Array.isArray(corners) && corners.length === 4) {
        const size = (msg.outWidth && msg.outHeight)
            ? { width: msg.outWidth, height: msg.outHeight }
            : estimateOutputSize(corners, maxDim, w, h);
        const warped = warpPerspective(rgba, w, h, corners, size.width, size.height);
        if (warped) {
            rgba = warped.data;
            w = warped.width;
            h = warped.height;
        }
        // A null result means the four points were collinear/degenerate. Falling
        // through with the untouched image beats returning an error to the user.
    }

    // 2. Filter. Runs after the warp so the background estimate is computed on
    //    the page alone, not on the desk around it — that matters a lot for the
    //    black/white threshold.
    applyFilterToPixels(rgba, w, h, filter, { brightness, contrast });

    // 3. Rotation last, so the stored corners stay in original-image space.
    if (rotation) {
        const rotated = rotatePixels(rgba, w, h, rotation);
        rgba = rotated.data;
        w = rotated.width;
        h = rotated.height;
    }

    if (CAN_ENCODE && encode !== false) {
        const blob = await encodePixels(rgba, w, h, encode);
        return { blob, width: w, height: h };
    }
    // Transfer the pixels back instead; the caller encodes them.
    return { buffer: rgba.buffer, width: w, height: h, __transfer: [rgba.buffer] };
}

self.onmessage = async (event) => {
    const msg = event.data || {};
    const { id, cmd } = msg;

    try {
        if (cmd === 'ping') {
            self.postMessage({ id, ok: true, canEncode: CAN_ENCODE });
            return;
        }
        if (cmd === 'detect') {
            const result = handleDetect(msg);
            self.postMessage({ id, ok: true, ...result });
            return;
        }
        if (cmd === 'render') {
            const result = await handleRender(msg);
            const transfer = result.__transfer || [];
            delete result.__transfer;
            self.postMessage({ id, ok: true, ...result }, transfer);
            return;
        }
        self.postMessage({ id, ok: false, error: `Unknown command: ${cmd}` });
    } catch (err) {
        // Never let the worker die silently — the UI has a timeout, but a real
        // message lets it fall back to main-thread rendering immediately.
        self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
    }
};
