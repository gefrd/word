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
                // Camera speed in mm/s: independent of how often slow phones
                // manage to run the tracker. Blur is checked separately.
                const now = performance.now();
                const dt = this.lastTime ? (now - this.lastTime) / 1000 : 1;
                const moved = this.last ? Math.hypot(ang.C[0] - this.last.C[0], ang.C[1] - this.last.C[1], ang.C[2] - this.last.C[2]) : 0;
                const speed = this.last ? moved / Math.max(0.03, dt) : 0;
                this.last = ang; this.lastTime = now;
                const cellKey = this.coverage.key(ang.az, ang.el);
                if (cellKey == null) state.hint = ang.el < BANDS[0].min ? 'raise' : 'lower';
                else if (speed > 260) state.hint = 'slow';
                else if (det.ids.length < 3) state.hint = 'moreMarkers';
                else if (!this.coverage.has(ang.az, ang.el)) {
                    const sharp = sharpness(img);
                    if (sharp < 25) state.hint = 'blurry';
                    else await this.addKeyframe(ang, sharp);
                }
            }
        } else {
            state.hint = 'noMarkers';
            this.last = null; this.lastTime = 0;
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

// Some Android WebViews never decode frames for a <video> that is not in
// the page, so the sampler keeps a tiny invisible one attached.
function hiddenVideo(url) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(v);
    v.src = url;
    return v;
}

function dropVideo(v) {
    v.pause(); v.removeAttribute('src'); v.load(); v.remove();
}

async function seekTo(video, time, timeout) {
    video.currentTime = time;
    try { await waitEvent(video, 'seeked', timeout); return true; } catch (_) { return false; }
}

const VIDEO_UNREADABLE = 'This phone cannot read this video. Try "Scan with camera", or record the video in 1080p.';

/**
 * Plan B for phones where seeking hangs: play the video once and take a
 * frame every `step` seconds while it runs.
 */
function sampleByPlayback(video, step, onFrame, onProgress) {
    return new Promise((resolve, reject) => {
        let next = 0, lastT = -1, lastMove = performance.now();
        const finish = (err) => { clearInterval(timer); video.onended = null; video.pause(); err ? reject(err) : resolve(); };
        const timer = setInterval(() => {
            const tNow = video.currentTime;
            if (tNow !== lastT) { lastT = tNow; lastMove = performance.now(); }
            else if (performance.now() - lastMove > 10000) { finish(next > 0 ? null : new Error(VIDEO_UNREADABLE)); return; }
            if (tNow >= next && video.readyState >= 2) { next = tNow + step; onFrame(tNow); onProgress(tNow / video.duration); }
        }, 80);
        video.onended = () => finish();
        video.play().catch(() => finish(new Error(VIDEO_UNREADABLE)));
    });
}

/**
 * Sample a recorded walk-around video, keep the sharpest frames per coverage
 * cell. onProgress(p, state).
 */
export async function keyframesFromVideo(file, opts = {}) {
    const longSide = opts.longSide || 1280;
    const url = URL.createObjectURL(file);
    let video = hiddenVideo(url);
    try {
        await waitEvent(video, 'loadedmetadata', 15000).catch(() => { throw new Error(VIDEO_UNREADABLE); });
        if (video.duration === Infinity) {
            // Browser-recorded WebM often has no duration until you seek to the end.
            video.currentTime = 1e7;
            await waitEvent(video, 'seeked', 15000).catch(() => {});
        }
        if (!video.duration || !isFinite(video.duration) || !video.videoWidth) throw new Error(VIDEO_UNREADABLE);
        // Some mobile browsers only decode frames after a play() attempt.
        try { await video.play(); video.pause(); } catch (_) {}
        const duration = video.duration;
        const vw = video.videoWidth, vh = video.videoHeight;
        const s = Math.min(1, longSide / Math.max(vw, vh));
        const w = Math.round(vw * s), h = Math.round(vh * s);
        const ds = Math.min(1, 640 / Math.max(vw, vh));
        const [dc, dctx] = canvas2d(Math.round(vw * ds), Math.round(vh * ds));
        const [fc, fctx] = canvas2d(w, h);
        const samples = Math.min(160, Math.max(40, Math.round(duration * 4)));
        const f0 = 0.8 * Math.max(w, h);
        // Keep up to two frames per coverage cell (the sharpest, at least
        // 0.4 s apart): more views carve a tighter shape. A candidate's
        // full-size frame is encoded right away, so no second pass of seeks.
        const best = new Map(); // cell → [candidates], sharpest first
        const coverage = new Coverage();
        const onFrame = (time) => {
            dctx.drawImage(video, 0, 0, dc.width, dc.height);
            const small = dctx.getImageData(0, 0, dc.width, dc.height);
            const det = detectMarkers(small, w / dc.width);
            if (det.ids.length < 3) return;
            const pose = poseFromDetections(det, f0, w, h);
            if (!pose) return;
            const ang = viewAngles(pose);
            const key = coverage.key(ang.az, ang.el);
            if (!key) return;
            const sharp = sharpness(small);
            const list = best.get(key) || [];
            const near = list.findIndex(c => Math.abs(c.time - time) < 0.4);
            if (near >= 0 ? list[near].sharp >= sharp : list.length >= 2 && list[1].sharp >= sharp) return;
            fctx.drawImage(video, 0, 0, w, h);
            const cand = { time, sharp, blob: toBlob(fc, 0.9) };
            if (near >= 0) list[near] = cand; else list.push(cand);
            list.sort((a, b) => b.sharp - a.sharp);
            best.set(key, list.slice(0, 2));
        };
        const progress = (p) => opts.onProgress && opts.onProgress(Math.min(1, p) * 0.7, { cells: best.size });

        let seeks = 0;
        for (let i = 0; i < samples; i++) {
            // Allow a slow first seek (big file, cold decoder); after that skip
            // a frame that hangs instead of failing the whole scan.
            if (await seekTo(video, Math.min(duration - 0.05, (i + 0.5) * duration / samples), seeks ? 6000 : 12000)) {
                seeks++;
                onFrame(video.currentTime);
            } else if (!seeks && i >= 1) break;
            progress((i + 1) / samples);
        }
        if (!seeks) {
            // Seeking does not work in this browser — play the video through instead.
            dropVideo(video);
            video = hiddenVideo(url);
            await waitEvent(video, 'loadedmetadata', 15000).catch(() => { throw new Error(VIDEO_UNREADABLE); });
            await sampleByPlayback(video, duration / samples, onFrame, progress);
        }

        // Full-resolution detection on the chosen frames.
        const keyframes = [];
        const chosen = [...best.values()].flat().sort((a, b) => a.time - b.time);
        let n = 0;
        for (const c of chosen) {
            const blob = await c.blob;
            if (blob) {
                const bmp = await createImageBitmap(blob);
                fctx.drawImage(bmp, 0, 0, w, h);
                bmp.close && bmp.close();
                const det = detectMarkers(fctx.getImageData(0, 0, w, h), 1);
                if (det.ids.length >= 2) keyframes.push({ blob, width: w, height: h, det, sharpness: c.sharp });
            }
            opts.onProgress && opts.onProgress(0.7 + 0.3 * (++n) / chosen.length, { cells: best.size });
        }
        return keyframes;
    } finally {
        dropVideo(video);
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

// ---------------------------------------------------------------------
// No-sheet scan: plain frames (no markers needed)
// ---------------------------------------------------------------------

/** Sharpness on a small grey copy (variance of the Laplacian over the whole frame). */
function smallStats(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    return { sharp: sharpness(img), grey: grey(img) };
}
function grey(img) {
    const { data, width, height } = img, g = new Uint8Array(width * height);
    for (let i = 0; i < g.length; i++) g[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
    return g;
}
function meanAbsDiff(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
}

/**
 * Pick `count` sharp frames spread evenly over a walk-around or turntable
 * video. Same decoding strategy as keyframesFromVideo: a hidden <video> kept
 * in the page, seeking first and playing it through where seeking hangs
 * (Android WebView "timeout seeked").
 */
export async function framesFromVideo(file, opts = {}) {
    const longSide = opts.longSide || 1280, count = opts.count || 36;
    const url = URL.createObjectURL(file);
    let video = hiddenVideo(url);
    try {
        await waitEvent(video, 'loadedmetadata', 15000).catch(() => { throw new Error(VIDEO_UNREADABLE); });
        if (video.duration === Infinity) {
            video.currentTime = 1e7;
            await waitEvent(video, 'seeked', 15000).catch(() => {});
        }
        if (!video.duration || !isFinite(video.duration) || !video.videoWidth) throw new Error(VIDEO_UNREADABLE);
        try { await video.play(); video.pause(); } catch (_) {}
        const duration = video.duration;
        const vw = video.videoWidth, vh = video.videoHeight;
        const s = Math.min(1, longSide / Math.max(vw, vh));
        const w = Math.round(vw * s), h = Math.round(vh * s);
        const ss = Math.min(1, 200 / Math.max(vw, vh));
        const [sc, sctx] = canvas2d(Math.round(vw * ss), Math.round(vh * ss));
        const [fc, fctx] = canvas2d(w, h);
        // 3 candidates per output frame; keep the sharpest in each time bin
        const samples = Math.min(150, count * 3);
        const bins = new Array(count).fill(null);
        const onFrame = (time) => {
            const b = Math.min(count - 1, Math.floor(time / duration * count));
            sctx.drawImage(video, 0, 0, sc.width, sc.height);
            const { sharp } = smallStats(sctx, sc.width, sc.height);
            if (bins[b] && bins[b].sharp >= sharp) return;
            fctx.drawImage(video, 0, 0, w, h);
            bins[b] = { time, sharp, blob: toBlob(fc, 0.9) };
        };
        const progress = (p) => opts.onProgress && opts.onProgress(Math.min(1, p), { frames: bins.filter(Boolean).length });
        let seeks = 0;
        for (let i = 0; i < samples; i++) {
            if (await seekTo(video, Math.min(duration - 0.05, (i + 0.5) * duration / samples), seeks ? 6000 : 12000)) {
                seeks++;
                onFrame(video.currentTime);
            } else if (!seeks && i >= 1) break;
            progress((i + 1) / samples);
        }
        if (!seeks) {
            dropVideo(video);
            video = hiddenVideo(url);
            await waitEvent(video, 'loadedmetadata', 15000).catch(() => { throw new Error(VIDEO_UNREADABLE); });
            await sampleByPlayback(video, duration / samples, onFrame, progress);
        }
        const out = [];
        for (const b of bins) if (b) { const blob = await b.blob; if (blob) out.push({ blob, width: w, height: h, time: b.time }); }
        return out;
    } finally {
        dropVideo(video);
        URL.revokeObjectURL(url);
    }
}

/** 35 mm-equivalent focal length from a JPEG's EXIF (0 if absent). */
export async function exifFocal35(file) {
    try {
        const buf = new DataView(await file.slice(0, 131072).arrayBuffer());
        if (buf.getUint16(0) !== 0xffd8) return 0;
        let o = 2;
        while (o + 4 < buf.byteLength) {
            const marker = buf.getUint16(o), len = buf.getUint16(o + 2);
            if (marker === 0xffe1 && buf.getUint32(o + 4) === 0x45786966) { // "Exif"
                const t = o + 10, le = buf.getUint16(t) === 0x4949;
                const u16 = (p) => buf.getUint16(t + p, le), u32 = (p) => buf.getUint32(t + p, le);
                const findTag = (ifd, tag) => {
                    const n = u16(ifd);
                    for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === tag) return e; }
                    return -1;
                };
                const ifd0 = u32(4);
                const ex = findTag(ifd0, 0x8769);
                if (ex < 0) return 0;
                const e = findTag(u32(ex + 8), 0xa405);
                return e < 0 ? 0 : u16(e + 8);
            }
            o += 2 + len;
        }
    } catch (_) { /* not a JPEG / no EXIF */ }
    return 0;
}

/**
 * Photos for the no-sheet scan: sorted by capture time, orientation fixed,
 * re-encoded at longSide. Also returns f/longSide from EXIF when present.
 */
export async function framesFromPhotos(files, opts = {}) {
    const longSide = opts.longSide || 1280;
    const list = [...files].sort((a, b) => (a.lastModified - b.lastModified) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const out = [];
    let size = null, fRatio = 0;
    for (let i = 0; i < list.length; i++) {
        const bmp = await createImageBitmap(list[i], { imageOrientation: 'from-image' }).catch(() => createImageBitmap(list[i]));
        const s = Math.min(1, longSide / Math.max(bmp.width, bmp.height));
        let w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
        if (!size) {
            size = { w, h };
            const f35 = await exifFocal35(list[i]);
            // 35 mm film diagonal is 43.27 mm
            if (f35 > 10 && f35 < 200) fRatio = f35 * Math.hypot(w, h) / 43.27 / Math.max(w, h);
        }
        if (Math.abs(w / h - size.w / size.h) > 0.02) { bmp.close && bmp.close(); continue; } // other orientation/camera
        w = size.w; h = size.h;
        const [c, ctx] = canvas2d(w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close && bmp.close();
        out.push({ blob: await toBlob(c, 0.9), width: w, height: h });
        opts.onProgress && opts.onProgress((i + 1) / list.length, { frames: out.length });
    }
    return { frames: out, fRatio };
}

/**
 * Live camera for the no-sheet scan: takes a frame automatically whenever
 * the view has changed enough and the picture is sharp. onFrame(blob) is
 * called for each one (the page sends it to the worker right away).
 */
export class LiveFreeCapture {
    constructor(video, opts = {}) {
        this.video = video;
        this.opts = { longSide: 1280, target: 32, max: 40, minGap: 700, ...opts };
        this.count = 0;
        this.running = false;
        this.lastGrey = null;
        this.lastShot = 0;
        this.prevGrey = null;
    }

    async start() {
        const long = this.opts.longSide >= 1600 ? 1920 : 1280;
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: 'environment' }, width: { ideal: long }, height: { ideal: Math.round(long * 9 / 16) } },
        });
        this.video.srcObject = this.stream;
        this.video.playsInline = true; this.video.muted = true;
        await this.video.play();
        const track = this.stream.getVideoTracks()[0];
        try {
            const caps = track.getCapabilities ? track.getCapabilities() : {};
            if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        } catch (_) {}
        this.running = true;
        this.timer = setInterval(() => this.tick(), 150);
    }

    stop() {
        this.running = false;
        clearInterval(this.timer);
        if (this.stream) this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
    }

    async toggleTorch(on) {
        const track = this.stream && this.stream.getVideoTracks()[0];
        if (!track) return false;
        try { await track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch (_) { return false; }
    }

    tick() {
        const v = this.video;
        if (!this.running || v.readyState < 2 || !v.videoWidth || this.busy) return;
        const s = 160 / Math.max(v.videoWidth, v.videoHeight);
        const w = Math.round(v.videoWidth * s), h = Math.round(v.videoHeight * s);
        if (!this.sctx) [this.sc, this.sctx] = canvas2d(w, h);
        this.sctx.drawImage(v, 0, 0, w, h);
        const { sharp, grey: g } = smallStats(this.sctx, w, h);
        // motion since the previous tick (too fast = blur) and change since the last shot
        const motion = this.prevGrey ? meanAbsDiff(g, this.prevGrey) : 0;
        this.prevGrey = g;
        const change = this.lastGrey ? meanAbsDiff(g, this.lastGrey) : Infinity;
        const now = performance.now();
        let hint = 'move';
        if (motion > 22) hint = 'slow';
        else if (sharp < 12) hint = 'blurry';
        else if (this.count >= this.opts.max) hint = 'enough';
        // a big change (walking around) shoots quickly; a small one (object
        // turning on a stool in a fixed view) after a longer pause
        else if (now - this.lastShot > this.opts.minGap && (change > 7 || (now - this.lastShot > 1400 && change > 2.5))) { this.shoot(g); hint = 'shot'; }
        else if (this.count >= this.opts.target) hint = 'enough';
        this.opts.onUpdate && this.opts.onUpdate({ count: this.count, hint, motion, change });
    }

    async shoot(g) {
        this.busy = true;
        try {
            const v = this.video;
            const s = Math.min(1, this.opts.longSide / Math.max(v.videoWidth, v.videoHeight));
            const [c, ctx] = canvas2d(Math.round(v.videoWidth * s), Math.round(v.videoHeight * s));
            ctx.drawImage(v, 0, 0, c.width, c.height);
            const blob = await toBlob(c, 0.9);
            if (!blob) return;
            this.lastGrey = g || this.prevGrey;
            this.lastShot = performance.now();
            this.count++;
            this.opts.onFrame && this.opts.onFrame(blob, this.count);
        } finally { this.busy = false; }
    }

    manualShot() { return this.shoot(this.prevGrey); }
}
