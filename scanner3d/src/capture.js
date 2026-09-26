// Keyframe collection for the 360° scan: live camera, a recorded video, or
// a batch of photos. Everything ends up as the same list of keyframes:
//   { blob (JPEG), width, height, det (marker correspondences), sharpness }
// Poses are solved afterwards, once the focal length is known from all views.

import { detectMarkers, poseFromDetections, viewAngles } from './tracker.js';
import { estimateFocal } from './geometry.js';

// Coverage targets: 3 height bands × 12 directions around the object.
export const BANDS = [
    { name: 'low', min: 8, max: 30 },
    { name: 'mid', min: 30, max: 52 },
    { name: 'high', min: 52, max: 85 },
];
export const SECTORS = 12;

export class Coverage {
    constructor() { this.cells = new Map(); }
    key(az, el) {
        const b = BANDS.findIndex(x => el >= x.min && el < x.max);
        if (b < 0) return null;
        return `${b}:${Math.floor(az / (360 / SECTORS)) % SECTORS}`;
    }
    has(az, el) { const k = this.key(az, el); return k != null && this.cells.has(k); }
    add(az, el, idx) { const k = this.key(az, el); if (k != null) this.cells.set(k, idx); return k; }
    count() { return this.cells.size; }
    bandCount(b) { let n = 0; for (const k of this.cells.keys()) if (k.startsWith(b + ':')) n++; return n; }
    filled(b, s) { return this.cells.has(`${b}:${s}`); }
}

/** Variance of a Laplacian over the central area — higher is sharper. */
export function sharpness(imageData) {
    const { data, width, height } = imageData;
    const x0 = Math.floor(width * 0.25), x1 = Math.floor(width * 0.75), y0 = Math.floor(height * 0.25), y1 = Math.floor(height * 0.75);
    let sum = 0, sum2 = 0, n = 0;
    const L = (x, y) => { const i = (y * width + x) * 4; return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; };
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const v = 4 * L(x, y) - L(x - 1, y) - L(x + 1, y) - L(x, y - 1) - L(x, y + 1);
        sum += v; sum2 += v * v; n++;
    }
    const m = sum / n;
    return sum2 / n - m * m;
}

function canvas2d(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return [c, c.getContext('2d', { willReadFrequently: true })];
}

function toBlob(canvas, quality = 0.9) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * Turn keyframes into posed views: estimate the shared focal length, then
 * solve each pose. Frames whose pose fails or looks wrong are dropped.
 */
export function solveKeyframes(keyframes) {
    // Frames must share one camera model; if the phone was rotated mid-scan,
    // keep the orientation used for most frames.
    const groups = new Map();
    for (const k of keyframes) {
        if (k.det.ids.length < 2) continue;
        const key = k.width + 'x' + k.height;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(k);
    }
    const usable = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
    if (usable.length < 6) throw new Error('Too few frames with the marker sheet visible.');
    const { width, height } = usable[0];
    const f = estimateFocal(usable.map(k => k.det), width, height);
    const posed = [];
    for (const k of usable) {
        const pose = poseFromDetections(k.det, f, width, height);
        if (!pose || pose.rms > Math.max(3, 0.004 * Math.max(width, height))) continue;
        posed.push({ ...k, R: pose.R, t: pose.t });
    }
    return { f, posed, width, height };
}

// ---------------------------------------------------------------------
// Live camera
// ---------------------------------------------------------------------

export class LiveCapture {
    /**
     * @param video   <video> element to show the camera in
     * @param opts    { longSide: keyframe size, detectSide: tracking size, onUpdate(state) }
     */
    constructor(video, opts = {}) {
        this.video = video;
        this.opts = { longSide: 1280, detectSide: 640, ...opts };
        this.keyframes = [];
        this.coverage = new Coverage();
        this.f = null;           // provisional focal for guidance
        this.fCands = [];
        this.last = null;
        this.running = false;
        this.busy = false;
    }

    async start() {
        const long = this.opts.longSide >= 1600 ? 1920 : 1280;
        const constraints = {
            audio: false,
            video: { facingMode: { ideal: 'environment' }, width: { ideal: long }, height: { ideal: Math.round(long * 9 / 16) } },
        };
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.video.srcObject = this.stream;
        this.video.playsInline = true; this.video.muted = true;
        await this.video.play();
        // Ask for continuous autofocus when the browser supports it.
        const track = this.stream.getVideoTracks()[0];
        try {
            const caps = track.getCapabilities ? track.getCapabilities() : {};
            if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        } catch (_) { /* optional */ }
        this.running = true;
        this.loop();
    }

    stop() {
        this.running = false;
        if (this.stream) this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
    }

    async toggleTorch(on) {
        const track = this.stream && this.stream.getVideoTracks()[0];
        if (!track) return false;
        try { await track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch (_) { return false; }
    }

    frameSize() {
        const vw = this.video.videoWidth, vh = this.video.videoHeight;
        const s = Math.min(1, this.opts.longSide / Math.max(vw, vh));
        return { w: Math.round(vw * s), h: Math.round(vh * s) };
    }

    loop() {
        if (!this.running) return;
        const tick = () => {
            if (!this.running) return;
            if (!this.busy && this.video.readyState >= 2 && this.video.videoWidth) {
                this.busy = true;
                this.track().catch(() => {}).finally(() => { this.busy = false; });
            }
            this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
    }

    async track() {
        const vw = this.video.videoWidth, vh = this.video.videoHeight;
        const ds = Math.min(1, this.opts.detectSide / Math.max(vw, vh));
        const dw = Math.round(vw * ds), dh = Math.round(vh * ds);
        if (!this.dctx) [this.dcanvas, this.dctx] = canvas2d(dw, dh);
        if (this.dcanvas.width !== dw) { this.dcanvas.width = dw; this.dcanvas.height = dh; }
        this.dctx.drawImage(this.video, 0, 0, dw, dh);
        const img = this.dctx.getImageData(0, 0, dw, dh);
        const det = detectMarkers(img, 1 / ds); // corners in full video pixels
        const state = { markers: det.ids.length, det, videoW: vw, videoH: vh, hint: null, pose: null, angles: null };

        if (det.ids.length >= 2) {
            // Provisional focal: refine as we see tilted views.
            if (!this.f) this.f = 0.8 * Math.max(vw, vh);
            const pose = poseFromDetections(det, this.f, vw, vh);
            if (pose) {
                const ang = viewAngles(pose);
                state.pose = pose; state.angles = ang;
                const moved = this.last ? Math.hypot(ang.C[0] - this.last.C[0], ang.C[1] - this.last.C[1], ang.C[2] - this.last.C[2]) : 999;
                this.last = ang;
                const cellKey = this.coverage.key(ang.az, ang.el);
                if (cellKey == null) state.hint = ang.el < BANDS[0].min ? 'raise' : 'lower';
                else if (moved > 25) state.hint = 'slow';
                else if (det.ids.length < 3) state.hint = 'moreMarkers';
                else if (!this.coverage.has(ang.az, ang.el)) {
                    const sharp = sharpness(img);
                    if (sharp < 25) state.hint = 'blurry';
                    else await this.addKeyframe(ang, sharp);
                }
            }
        } else {
            state.hint = 'noMarkers';
            this.last = null;
        }
        state.count = this.keyframes.length;
        state.coverage = this.coverage;
        this.opts.onUpdate && this.opts.onUpdate(state);
    }

    /** Grab the current frame at keyframe resolution and store it. */
    async addKeyframe(ang, sharp, manual = false) {
        const { w, h } = this.frameSize();
        const [c, ctx] = canvas2d(w, h);
        ctx.drawImage(this.video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        // Re-detect at keyframe resolution for accurate corners.
        const det = detectMarkers(img, 1);
        if (det.ids.length < 2) return false;
        const blob = await toBlob(c, 0.9);
        const idx = this.keyframes.length;
        this.keyframes.push({ blob, width: w, height: h, det, sharpness: sharp, manual });
        if (ang) this.coverage.add(ang.az, ang.el, idx);
        this.opts.onKeyframe && this.opts.onKeyframe(idx, ang);
        return true;
    }

    async manualShot() {
        return this.addKeyframe(this.last, 100, true);
    }
}

// ---------------------------------------------------------------------
// Recorded video
// ---------------------------------------------------------------------

function waitEvent(el, name, timeout = 8000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { el.removeEventListener(name, on); reject(new Error('timeout ' + name)); }, timeout);
        const on = () => { clearTimeout(t); el.removeEventListener(name, on); resolve(); };
        el.addEventListener(name, on);
    });
}

/**
 * Sample a recorded walk-around video, keep the sharpest frame per coverage
 * cell. onProgress(p, state).
 */
export async function keyframesFromVideo(file, opts = {}) {
    const longSide = opts.longSide || 1280;
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    const url = URL.createObjectURL(file);
    video.src = url;
    try {
        await waitEvent(video, 'loadedmetadata', 15000);
        if (!video.duration || !isFinite(video.duration)) throw new Error('Could not read this video.');
        // Some mobile browsers only decode frames after a play() attempt.
        try { await video.play(); video.pause(); } catch (_) {}
        const vw = video.videoWidth, vh = video.videoHeight;
        const s = Math.min(1, longSide / Math.max(vw, vh));
        const w = Math.round(vw * s), h = Math.round(vh * s);
        const ds = Math.min(1, 640 / Math.max(vw, vh));
        const [dc, dctx] = canvas2d(Math.round(vw * ds), Math.round(vh * ds));
        const [fc, fctx] = canvas2d(w, h);
        const samples = Math.min(160, Math.max(40, Math.round(video.duration * 4)));
        const f0 = 0.8 * Math.max(w, h);
        const best = new Map(); // cell → candidate
        const coverage = new Coverage();
        for (let i = 0; i < samples; i++) {
            video.currentTime = Math.min(video.duration - 0.05, (i + 0.5) * video.duration / samples);
            await waitEvent(video, 'seeked');
            dctx.drawImage(video, 0, 0, dc.width, dc.height);
            const small = dctx.getImageData(0, 0, dc.width, dc.height);
            const det = detectMarkers(small, w / dc.width);
            if (det.ids.length >= 3) {
                const pose = poseFromDetections(det, f0, w, h);
                if (pose) {
                    const ang = viewAngles(pose);
                    const key = coverage.key(ang.az, ang.el);
                    const sharp = sharpness(small);
                    if (key && (!best.has(key) || best.get(key).sharp < sharp)) best.set(key, { time: video.currentTime, sharp, ang });
                    if (key) coverage.add(ang.az, ang.el, 0);
                }
            }
            opts.onProgress && opts.onProgress((i + 1) / samples * 0.7, { cells: best.size });
        }
        // Grab the chosen frames at full keyframe resolution.
        const keyframes = [];
        let n = 0;
        for (const c of best.values()) {
            video.currentTime = c.time;
            await waitEvent(video, 'seeked');
            fctx.drawImage(video, 0, 0, w, h);
            const img = fctx.getImageData(0, 0, w, h);
            const det = detectMarkers(img, 1);
            if (det.ids.length >= 2) keyframes.push({ blob: await toBlob(fc, 0.9), width: w, height: h, det, sharpness: c.sharp });
            opts.onProgress && opts.onProgress(0.7 + 0.3 * (++n) / best.size, { cells: best.size });
        }
        return keyframes;
    } finally {
        video.removeAttribute('src'); video.load();
        URL.revokeObjectURL(url);
    }
}

// ---------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------

export async function keyframesFromPhotos(files, opts = {}) {
    const longSide = opts.longSide || 1280;
    const keyframes = [];
    let size = null;
    for (let i = 0; i < files.length; i++) {
        const bmp = await createImageBitmap(files[i], { imageOrientation: 'from-image' }).catch(() => createImageBitmap(files[i]));
        // All frames must share one camera model: use the first photo's size.
        const s = Math.min(1, longSide / Math.max(bmp.width, bmp.height));
        let w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
        if (!size) size = { w, h };
        if (Math.abs(w / h - size.w / size.h) > 0.02) { bmp.close && bmp.close(); continue; } // different orientation/camera
        w = size.w; h = size.h;
        const [c, ctx] = canvas2d(w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close && bmp.close();
        const img = ctx.getImageData(0, 0, w, h);
        const det = detectMarkers(img, 1);
        if (det.ids.length >= 2) keyframes.push({ blob: await toBlob(c, 0.9), width: w, height: h, det, sharpness: sharpness(img) });
        opts.onProgress && opts.onProgress((i + 1) / files.length, { found: keyframes.length });
    }
    return keyframes;
}
