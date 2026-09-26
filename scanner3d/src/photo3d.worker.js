// Single-photo AI: background removal (BRIA RMBG-1.4) + monocular depth
// (Depth Anything V2 Small), both running on-device through transformers.js
// (ONNX Runtime Web). Models download once from the Hugging Face CDN and are
// cached by the browser, after which everything works offline.

import { env, AutoModel, AutoProcessor, RawImage, pipeline } from '@huggingface/transformers';

const RMBG_ID = 'briaai/RMBG-1.4';
const DEPTH_ID = 'onnx-community/depth-anything-v2-small';

let segModel = null, segProc = null, depthPipe = null, device = 'wasm';

function progress(stage) {
    return (e) => {
        if (e.status === 'progress' && e.total) {
            self.postMessage({ type: 'progress', stage: 'download', p: e.loaded / e.total, file: e.file, model: stage });
        }
    };
}

async function pickDevice() {
    // WebGPU is much faster where available (e.g. Pixel 6 on recent Chrome).
    try {
        if (self.navigator && navigator.gpu) {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) return 'webgpu';
        }
    } catch (_) { /* fall back */ }
    return 'wasm';
}

async function loadSeg(size) {
    if (segModel) return;
    const load = (dev) => AutoModel.from_pretrained(RMBG_ID, {
        config: { model_type: 'custom' },
        device: dev,
        dtype: dev === 'webgpu' ? 'fp16' : 'q8',
        progress_callback: progress('segment'),
    });
    try { segModel = await load(device); }
    catch (e) { if (device === 'wasm') throw e; device = 'wasm'; segModel = await load('wasm'); }
    segProc = await AutoProcessor.from_pretrained(RMBG_ID, {
        config: {
            do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
            image_mean: [0.5, 0.5, 0.5], image_std: [1, 1, 1],
            feature_extractor_type: 'ImageFeatureExtractor', resample: 2,
            rescale_factor: 1 / 255, size: { width: size, height: size },
        },
    });
}

async function loadDepth() {
    if (depthPipe) return;
    const load = (dev) => pipeline('depth-estimation', DEPTH_ID, {
        device: dev,
        dtype: dev === 'webgpu' ? 'fp16' : 'q8',
        progress_callback: progress('depth'),
    });
    try { depthPipe = await load(device); }
    catch (e) { if (device === 'wasm') throw e; depthPipe = await load('wasm'); }
}

self.onmessage = async (e) => {
    const msg = e.data;
    try {
        if (msg.cmd === 'config') {
            // Tests point at locally served models / runtime files.
            if (msg.localModelPath) { env.localModelPath = msg.localModelPath; env.allowRemoteModels = false; env.allowLocalModels = true; }
            else { env.allowLocalModels = false; }
            if (msg.wasmPaths) env.backends.onnx.wasm.wasmPaths = msg.wasmPaths;
            device = msg.forceWasm ? 'wasm' : await pickDevice();
            self.postMessage({ type: 'ready', device });
            return;
        }
        if (msg.cmd === 'run') {
            const { rgba, width, height, segSize = 1024, skipDepth = false } = msg;
            const image = new RawImage(new Uint8ClampedArray(rgba), width, height, 4).rgb();

            // 1. Object mask
            self.postMessage({ type: 'progress', stage: 'mask', p: 0 });
            await loadSeg(segSize);
            self.postMessage({ type: 'progress', stage: 'mask', p: 0.5 });
            const { pixel_values } = await segProc(image);
            const { output } = await segModel({ input: pixel_values });
            const maskImg = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(width, height);
            const mask = new Uint8Array(maskImg.data); // 1 channel
            self.postMessage({ type: 'progress', stage: 'mask', p: 1 });

            // 2. Depth
            let depth = null, dW = 0, dH = 0;
            if (!skipDepth) {
                self.postMessage({ type: 'progress', stage: 'depth', p: 0 });
                await loadDepth();
                self.postMessage({ type: 'progress', stage: 'depth', p: 0.5 });
                const out = await depthPipe(image);
                const pd = out.predicted_depth; // Tensor [h, w] (relative inverse depth: larger = nearer)
                dH = pd.dims[pd.dims.length - 2]; dW = pd.dims[pd.dims.length - 1];
                depth = Float32Array.from(pd.data);
                self.postMessage({ type: 'progress', stage: 'depth', p: 1 });
            }
            self.postMessage({ type: 'done', mask, width, height, depth, dW, dH, device },
                depth ? [mask.buffer, depth.buffer] : [mask.buffer]);
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
    }
};
