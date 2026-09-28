// Main-thread side of the no-sheet scan: owns the worker, feeds it frames
// (it starts masking/feature extraction immediately, so a live scan is
// mostly processed by the time you tap "Done") and resolves with the model.

export class MarkerlessJob {
    /**
     * @param opts { profile: 'low'|'mid'|'high', modelUrl?, wasmPaths?,
     *               onProgress(stage, p), onAdded(index, info), onLog(msg) }
     */
    constructor(opts = {}) {
        this.opts = opts;
        this.count = 0;
        this.processed = 0;
        this.blobs = [];
        this.worker = new Worker(new URL('./markerless.worker.js', import.meta.url), { type: 'module' });
        this.pending = null;
        this.fatal = null;
        this.worker.onmessage = (e) => this.onMessage(e.data);
        this.worker.onerror = (e) => this.fail(new Error(e.message || 'Worker failed'));
        this.worker.postMessage({ cmd: 'config', profile: opts.profile || 'mid', modelUrl: opts.modelUrl, wasmPaths: opts.wasmPaths });
    }

    onMessage(m) {
        const o = this.opts;
        if (m.type === 'progress') o.onProgress && o.onProgress(m.stage, m.p);
        else if (m.type === 'added') { this.processed++; o.onAdded && o.onAdded(m.index, m); }
        else if (m.type === 'log') o.onLog && o.onLog(m.message);
        else if (m.type === 'need') this.sendFrame(m);
        else if (m.type === 'done') { if (this.pending) this.pending.resolve(m); this.pending = null; }
        else if (m.type === 'error') {
            const err = Object.assign(new Error(m.message), { code: m.code });
            if (m.code === 'FRAME') { o.onLog && o.onLog('frame skipped: ' + m.message); this.processed++; return; }
            this.fail(err);
        }
    }

    fail(err) {
        this.fatal = err;
        if (this.pending) { this.pending.reject(err); this.pending = null; }
    }

    // Workers without OffscreenCanvas (iOS < 16.4) ask us to decode frames.
    async sendFrame({ id, index, side, w, h }) {
        try {
            const bmp = await createImageBitmap(this.blobs[index]);
            let W = w, H = h;
            if (!W) { const s = Math.min(1, side / Math.max(bmp.width, bmp.height)); W = Math.round(bmp.width * s); H = Math.round(bmp.height * s); }
            const c = document.createElement('canvas'); c.width = W; c.height = H;
            const x = c.getContext('2d', { willReadFrequently: true });
            x.drawImage(bmp, 0, 0, W, H);
            const ar = bmp.width / bmp.height;
            bmp.close && bmp.close();
            const rgba = x.getImageData(0, 0, W, H).data;
            this.worker.postMessage({ cmd: 'frame', id, rgba, width: W, height: H, ar }, [rgba.buffer]);
        } catch (e) {
            this.worker.postMessage({ cmd: 'frame', id, error: e.message });
        }
    }

    add(blob) {
        if (this.fatal) return -1;
        const index = this.count++;
        this.blobs[index] = blob;
        this.worker.postMessage({ cmd: 'add', index, blob });
        return index;
    }

    /** opts: { unordered, lowMemory, f0 } → Promise<{ positions, indices, normals, colors, info }> */
    solve(opts = {}) {
        if (this.fatal) return Promise.reject(this.fatal);
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject };
            this.worker.postMessage({ cmd: 'solve', opts });
        });
    }

    terminate() {
        this.worker.terminate();
        this.blobs = [];
    }
}
