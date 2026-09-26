// src/modules/tools/scanner.js
// Kivu Pro Scanner — camera, perspective editor, page manager, export.
//
// Public contract (unchanged from the previous version):
//   export async function init(docId)
//   localStorage key `kivu_docs_index`
//   host hooks window.renderMyDocuments(), window.showToast(msg, isError)
//
// Everything image-shaped now lives in IndexedDB (see scanner-store.js); the
// index in localStorage holds only title/type/updatedAt/pageCount.

import * as store from './scanner-store.js';
import {
    toGray,
    detectDocument,
    sharpnessScore,
    warpPerspective,
    applyFilterToPixels,
    rotatePixels,
    estimateOutputSize,
    sortCorners
} from './scanner-cv.js';
import { buildPdf, shareOrDownload, downloadBlob, safeFileName, preloadPdfEngine, PAGE_SIZES } from './scanner-pdf.js';
import * as ocr from './scanner-ocr.js';

/* ================================================================== */
/* Constants                                                           */
/* ================================================================== */

const MAX_PAGES = 30;
// ~200 DPI across an A4 short side. Above this the gain is invisible on screen
// and the memory cost on a 2 GB phone is not. This is the cap for the FINAL,
// cropped page — see CAPTURE_HEADROOM below for why the raw capture is kept
// larger than this.
const TARGET_MAX_DIM = 2400;
const LOW_END_MAX_DIM = 1800;
const JPEG_QUALITY = 0.85;
const THUMB_MAX_DIM = 220;

// The document rarely fills the whole frame edge-to-edge — there is normally
// margin around it (see any real capture screenshot). If the raw capture is
// downscaled to TARGET_MAX_DIM *before* the four corners are cropped out, the
// crop then throws away exactly that margin fraction of resolution too, and a
// page framed at, say, 65% of the frame height ends up scanned at ~65% of the
// intended DPI — which reads as "the scan looks soft" with no error anywhere.
// Keeping extra headroom on the stored original (and letting renderPage's
// existing estimateOutputSize()/maxDim clamp do the final downscale AFTER the
// crop) means a normally-framed page still lands at the full TARGET_MAX_DIM.
const CAPTURE_HEADROOM = 1.5;
const CAPTURE_CEILING = 3600; // absolute ceiling so memory/storage stay bounded regardless of device

const DETECT_WIDTH = 240;          // live-detection frame size
const DETECT_INTERVAL_MS = 120;    // ~8 detections per second
const AUTO_STABLE_FRAMES = 6;      // ~0.75 s of holding still
const AUTO_MOVE_TOLERANCE = 0.022; // fraction of the frame diagonal

const PREF_AUTO = 'kivu_scanner_autocapture';
const PREF_MODE = 'kivu_scanner_mode';
const PREF_PAGESIZE = 'kivu_scanner_pagesize';

const MODES = {
    document: { label: 'Document', warp: true,  filter: 'magic',    multi: true,  hint: 'Fit the whole page in the frame' },
    'id-card': { label: 'ID card', warp: true,  filter: 'magic',    multi: true,  hint: 'Scan the front, then the back' },
    photo:     { label: 'Photo',   warp: false, filter: 'original', multi: true,  hint: 'No cropping, no filters' }
};

const FILTERS = [
    { id: 'magic',     label: 'Magic',    icon: 'fa-wand-magic-sparkles' },
    { id: 'bw',        label: 'B&W',      icon: 'fa-circle-half-stroke' },
    { id: 'grayscale', label: 'Gray',     icon: 'fa-droplet-slash' },
    { id: 'original',  label: 'Original', icon: 'fa-image' }
];

/* ================================================================== */
/* Module state                                                        */
/* ================================================================== */

const S = {
    docId: null,
    doc: null,
    mode: 'document',
    screen: 'camera',

    // camera
    stream: null,
    videoTrack: null,
    imageCapture: null,
    torchOn: false,
    autoCapture: true,
    capturing: false,

    // live detection
    detectCanvas: null,
    detectCtx: null,
    detectBusy: false,
    lastDetectAt: 0,
    liveCorners: null,
    stableCount: 0,
    maxSharpness: 0,
    rafId: null,

    // editor
    editingPageId: null,
    editorImage: null,      // ImageData of the ORIGINAL page capture
    editorBitmap: null,     // ImageBitmap for fast redraws
    editorCorners: null,    // in original pixel coords
    activeCorner: -1,
    pointerId: null,
    previewCache: null,     // {filter, brightness, contrast, bitmap}
    previewToken: 0,

    // object URLs handed to <img> elements; revoked on teardown
    urls: new Set(),
    maxDim: TARGET_MAX_DIM,
    workerFailed: false
};

function el(id) { return document.getElementById(id); }

function toast(message, isError = false) {
    if (typeof window.showToast === 'function') window.showToast(message, isError);
    else if (isError) console.error('[Scanner]', message);
    else console.info('[Scanner]', message);
}

function buzz(ms = 18) {
    // Absent on iOS Safari. Not worth faking — silence is better than a hack.
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {}
}

function trackUrl(url) { S.urls.add(url); return url; }

function releaseUrls() {
    S.urls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) {} });
    S.urls.clear();
}

function prefBool(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v === '1';
    } catch (_) { return fallback; }
}

function setPref(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
}

// Rough device capability check. deviceMemory is Chrome-only, so absence is
// treated as "probably fine" rather than "probably slow".
function pickMaxDim() {
    const mem = navigator.deviceMemory;
    const cores = navigator.hardwareConcurrency || 4;
    if ((mem && mem <= 2) || cores <= 2) return LOW_END_MAX_DIM;
    return TARGET_MAX_DIM;
}

// Resolution the RAW capture is stored at, before the document is cropped out
// of it. Always >= S.maxDim so cropping has headroom to spend (see
// CAPTURE_HEADROOM above). renderPage() still clamps the final, cropped page
// to S.maxDim, so this does not change final export size on a tightly-framed
// shot — it only stops resolution being lost on normally-framed ones.
function captureMaxDim() {
    return Math.min(CAPTURE_CEILING, Math.round(S.maxDim * CAPTURE_HEADROOM));
}

/* ================================================================== */
/* Worker client (with an honest main-thread fallback)                 */
/* ================================================================== */

let worker = null;
let workerMsgId = 0;
const workerPending = new Map();

function getWorker() {
    if (S.workerFailed) return null;
    if (worker) return worker;
    try {
        worker = new Worker(new URL('./scanner-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = (e) => {
            const { id } = e.data || {};
            const entry = workerPending.get(id);
            if (!entry) return;
            workerPending.delete(id);
            if (e.data.ok) entry.resolve(e.data);
            else entry.reject(new Error(e.data.error || 'Worker error'));
        };
        worker.onerror = (e) => {
            // Module workers are unavailable on a few older WebViews. Rather than
            // leave the user with a dead scanner, drop to the main thread.
            console.warn('[Scanner] worker unavailable, falling back to main thread', e.message || e);
            S.workerFailed = true;
            workerPending.forEach((entry) => entry.reject(new Error('Worker failed')));
            workerPending.clear();
            try { worker.terminate(); } catch (_) {}
            worker = null;
        };
    } catch (err) {
        console.warn('[Scanner] worker could not be created:', err);
        S.workerFailed = true;
        worker = null;
    }
    return worker;
}

function callWorker(payload, transfer = []) {
    const w = getWorker();
    if (!w) return Promise.reject(new Error('No worker'));
    const id = ++workerMsgId;
    return new Promise((resolve, reject) => {
        workerPending.set(id, { resolve, reject });
        try {
            w.postMessage({ id, ...payload }, transfer);
        } catch (err) {
            workerPending.delete(id);
            reject(err);
        }
        // A hung worker must not hang the UI forever.
        setTimeout(() => {
            if (workerPending.has(id)) {
                workerPending.delete(id);
                reject(new Error('Worker timed out'));
            }
        }, 30000);
    });
}

function disposeWorker() {
    if (worker) { try { worker.terminate(); } catch (_) {} }
    worker = null;
    workerPending.clear();
}

/* ================================================================== */
/* Canvas helpers                                                      */
/* ================================================================== */

function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = JPEG_QUALITY) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), type, quality);
    });
}

// Decodes a blob, honouring the EXIF orientation tag. Without the second
// argument every photo taken with an iPhone in portrait arrives on its side —
// that was one of the visible bugs in the old version.
async function decodeBlob(blob) {
    try {
        return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (_) {
        try {
            return await createImageBitmap(blob);
        } catch (err) {
            throw new Error('This image could not be opened.');
        }
    }
}

function bitmapToImageData(bitmap, maxDim) {
    let w = bitmap.width;
    let h = bitmap.height;
    const scale = maxDim ? Math.min(1, maxDim / Math.max(w, h)) : 1;
    if (scale < 1) { w = Math.round(w * scale); h = Math.round(h * scale); }
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    canvas.width = canvas.height = 0;
    return data;
}

/* ================================================================== */
/* Markup                                                              */
/* ================================================================== */

function modalHtml() {
    const modeButtons = Object.entries(MODES).map(([key, m]) =>
        `<button type="button" data-mode="${key}" class="scanner-mode-btn shrink-0 px-4 py-1.5 rounded-full text-xs font-semibold tracking-wide uppercase transition-colors">${m.label}</button>`
    ).join('');

    const filterButtons = FILTERS.map((f) =>
        `<button type="button" class="filter-btn flex flex-col items-center gap-1 px-3 py-2 rounded-xl text-[11px] font-medium transition-colors" data-filter="${f.id}">
            <i class="fa-solid ${f.icon} text-base"></i><span>${f.label}</span>
        </button>`
    ).join('');

    const langOptions = ocr.OCR_LANGUAGES.map((l) =>
        `<option value="${l.code}">${l.label}</option>`
    ).join('');

    const sizeOptions = ['a4', 'letter', 'fit'].map((k) =>
        `<label class="flex items-center gap-3 p-3 rounded-xl bg-gray-800 cursor-pointer">
            <input type="radio" name="scanner-pagesize" value="${k}" class="accent-indigo-500">
            <span class="text-sm text-gray-200">${PAGE_SIZES[k].label}</span>
        </label>`
    ).join('');

    return `
<div id="scanner-modal" class="fixed inset-0 z-[60] bg-black text-white flex flex-col" style="display:none">
    <style>
        #scanner-modal .scanner-mode-btn { background: rgba(255,255,255,.08); color: #cbd5e1; }
        #scanner-modal .scanner-mode-btn.active { background: #fff; color: #111827; }
        #scanner-modal .filter-btn { background: rgba(255,255,255,.08); color: #cbd5e1; }
        #scanner-modal .filter-btn.active { background: #6366f1; color: #fff; }
        #scanner-modal .scanner-tab-btn { color: #94a3b8; }
        #scanner-modal .scanner-tab-btn.active { background: #fff; color: #111827; }
        #scanner-modal input[type=range] { -webkit-appearance: none; appearance: none; height: 26px; background: transparent; }
        #scanner-modal input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: #374151; }
        #scanner-modal input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 22px; height: 22px; margin-top: -9px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.5); }
        #scanner-modal input[type=range]::-moz-range-track { height: 4px; border-radius: 2px; background: #374151; }
        #scanner-modal input[type=range]::-moz-range-thumb { width: 22px; height: 22px; border: none; border-radius: 50%; background: #fff; }
        #scanner-modal .scanner-screen { display: none; }
        #scanner-modal .scanner-screen.active { display: flex; }
        #scanner-modal .no-scrollbar::-webkit-scrollbar { display: none; }
        #scanner-modal .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        #scanner-modal .sheet { animation: scanner-sheet-up .18s ease-out; }
        @keyframes scanner-sheet-up { from { transform: translateY(16px); opacity: 0 } to { transform: none; opacity: 1 } }
    </style>

    <!-- Header -->
    <header class="flex items-center gap-3 px-3 h-14 shrink-0 bg-black/90">
        <button type="button" id="close-scanner-btn" class="w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10" aria-label="Close scanner">
            <i class="fa-solid fa-xmark text-xl"></i>
        </button>
        <input id="scanner-doc-title" class="flex-1 min-w-0 bg-transparent text-base font-medium outline-none focus:bg-white/10 rounded px-2 py-1" value="Scanned Document" aria-label="Document title">
        <span id="scanner-save-status" class="text-[11px] text-gray-400 shrink-0"></span>
        <button type="button" id="scanner-pages-btn" class="h-10 px-3 flex items-center gap-2 rounded-full hover:bg-white/10 text-sm" aria-label="Manage pages">
            <i class="fa-regular fa-copy"></i><span id="scanner-page-count">0</span>
        </button>
    </header>

    <div class="flex-1 min-h-0 relative">

        <!-- ===== Camera ===== -->
        <section id="scanner-screen-camera" class="scanner-screen active absolute inset-0 flex-col bg-black">
            <div id="scanner-viewport" class="relative flex-1 min-h-0 overflow-hidden bg-black">
                <video id="scanner-video" class="absolute inset-0 w-full h-full object-contain" playsinline autoplay muted></video>
                <canvas id="scanner-overlay" class="absolute inset-0 w-full h-full pointer-events-none"></canvas>
                <div id="scanner-camera-error" class="absolute inset-0 hidden flex-col items-center justify-center gap-4 p-6 text-center bg-black">
                    <i class="fa-solid fa-camera-slash text-4xl text-gray-500"></i>
                    <p id="scanner-camera-error-text" class="text-sm text-gray-300 max-w-xs">Camera unavailable.</p>
                    <button type="button" id="scanner-retry-camera" class="px-4 py-2 rounded-full bg-white/10 text-sm">Try again</button>
                    <label class="px-4 py-2 rounded-full bg-indigo-600 text-sm cursor-pointer">
                        Choose from gallery
                        <input type="file" id="scanner-fallback-file-input" accept="image/*" class="hidden">
                    </label>
                </div>
                <div class="absolute top-3 left-3 right-3 flex items-start justify-between gap-2 pointer-events-none">
                    <span id="scanner-hint" class="px-3 py-1.5 rounded-full bg-black/55 text-[11px] text-gray-200"></span>
                    <div class="flex flex-col gap-2 pointer-events-auto">
                        <button type="button" id="scanner-torch-btn" class="w-10 h-10 rounded-full bg-black/55 hidden items-center justify-center" aria-label="Toggle flashlight">
                            <i class="fa-solid fa-bolt"></i>
                        </button>
                        <button type="button" id="scanner-auto-btn" class="w-10 h-10 rounded-full bg-black/55 flex items-center justify-center text-[10px] font-bold" aria-label="Toggle automatic capture">AUTO</button>
                    </div>
                </div>
            </div>

            <div class="shrink-0 bg-black px-3 pb-4 pt-2 space-y-3">
                <div id="scanner-page-strip" class="hidden gap-2 overflow-x-auto no-scrollbar pb-1"></div>
                <div class="flex gap-2 overflow-x-auto no-scrollbar justify-center">${modeButtons}</div>
                <div class="flex items-center justify-between px-2">
                    <label class="w-12 h-12 rounded-2xl bg-white/10 flex items-center justify-center cursor-pointer" aria-label="Import from gallery">
                        <i class="fa-regular fa-images text-lg"></i>
                        <input type="file" id="scanner-file-input" accept="image/*" multiple class="hidden">
                    </label>
                    <button type="button" id="scanner-shutter-btn" class="w-[72px] h-[72px] rounded-full bg-white ring-4 ring-white/25 active:scale-95 transition-transform" aria-label="Capture"></button>
                    <button type="button" id="scanner-done-btn" class="w-12 h-12 rounded-2xl bg-indigo-600 flex items-center justify-center disabled:opacity-40" aria-label="Finish scanning">
                        <i class="fa-solid fa-check text-lg"></i>
                    </button>
                </div>
            </div>
        </section>

        <!-- ===== Corner / filter editor ===== -->
        <section id="scanner-screen-editor" class="scanner-screen absolute inset-0 flex-col bg-neutral-900">
            <div id="scanner-editor-viewport" class="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden touch-none">
                <canvas id="scanner-crop-canvas" class="max-w-full max-h-full"></canvas>
                <div id="scanner-editor-busy" class="absolute inset-0 hidden items-center justify-center bg-black/40">
                    <i class="fa-solid fa-spinner fa-spin text-2xl"></i>
                </div>
            </div>
            <div class="shrink-0 bg-black px-3 pb-4 pt-3 space-y-3">
                <div class="flex justify-center">
                    <div class="inline-flex p-1 rounded-full bg-white/10">
                        <button type="button" class="scanner-tab-btn px-5 py-1.5 rounded-full text-xs font-semibold" data-tab="crop">Crop</button>
                        <button type="button" class="scanner-tab-btn px-5 py-1.5 rounded-full text-xs font-semibold" data-tab="adjust">Adjust</button>
                    </div>
                </div>
                <div id="scanner-adjust-row" class="space-y-1">
                    <div class="flex items-center gap-3">
                        <i class="fa-solid fa-sun text-xs text-gray-400 w-4 text-center"></i>
                        <input type="range" id="scanner-brightness" min="-100" max="100" value="0" step="5" class="flex-1">
                        <button type="button" id="scanner-reset-adjust" class="text-[11px] text-gray-400 px-2">Reset</button>
                    </div>
                    <div class="flex items-center gap-3">
                        <i class="fa-solid fa-circle-half-stroke text-xs text-gray-400 w-4 text-center"></i>
                        <input type="range" id="scanner-contrast" min="-100" max="100" value="0" step="5" class="flex-1">
                        <span class="w-[42px]"></span>
                    </div>
                </div>
                <div id="scanner-toolbar" class="flex gap-2 justify-center overflow-x-auto no-scrollbar">${filterButtons}</div>
                <div class="flex items-center justify-between gap-2">
                    <button type="button" id="scanner-editor-cancel" class="px-4 py-2.5 rounded-xl bg-white/10 text-sm">Cancel</button>
                    <div class="flex gap-2">
                        <button type="button" id="scanner-reset-corners" class="w-11 h-11 rounded-xl bg-white/10 flex items-center justify-center" aria-label="Select whole image">
                            <i class="fa-solid fa-expand"></i>
                        </button>
                        <button type="button" id="scanner-rotate-btn" class="w-11 h-11 rounded-xl bg-white/10 flex items-center justify-center" aria-label="Rotate">
                            <i class="fa-solid fa-rotate-right"></i>
                        </button>
                    </div>
                    <button type="button" id="scanner-editor-apply" class="px-5 py-2.5 rounded-xl bg-indigo-600 text-sm font-semibold">Done</button>
                </div>
            </div>
        </section>

        <!-- ===== Page manager ===== -->
        <section id="scanner-screen-pages" class="scanner-screen absolute inset-0 flex-col bg-neutral-900">
            <div id="scanner-pages-grid" class="flex-1 min-h-0 overflow-y-auto p-3 grid grid-cols-2 sm:grid-cols-3 gap-3 content-start"></div>
            <div class="shrink-0 bg-black p-3 flex gap-2">
                <button type="button" id="scanner-add-page-btn" class="flex-1 py-3 rounded-xl bg-white/10 text-sm font-medium">
                    <i class="fa-solid fa-plus mr-2"></i>Add page
                </button>
                <button type="button" id="scanner-ocr-btn" class="px-4 py-3 rounded-xl bg-white/10 text-sm font-medium">
                    <i class="fa-solid fa-font mr-2"></i>Text
                </button>
                <button type="button" id="scanner-export-pdf-btn" class="px-4 py-3 rounded-xl bg-indigo-600 text-sm font-semibold">
                    <i class="fa-regular fa-file-pdf mr-2"></i>Export
                </button>
            </div>
        </section>

        <!-- ===== Export sheet ===== -->
        <section id="scanner-screen-export" class="scanner-screen absolute inset-0 flex-col justify-end bg-black/70">
            <div class="sheet bg-neutral-900 rounded-t-3xl p-4 space-y-4 max-h-full overflow-y-auto">
                <div class="flex items-center justify-between">
                    <h3 class="text-base font-semibold">Export</h3>
                    <button type="button" id="scanner-export-close" class="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="space-y-2">
                    <p class="text-xs uppercase tracking-wide text-gray-400">Page size</p>
                    ${sizeOptions}
                </div>
                <label class="flex items-center justify-between gap-3 p-3 rounded-xl bg-gray-800">
                    <span class="text-sm text-gray-200">Add margins</span>
                    <input type="checkbox" id="scanner-margin-toggle" class="accent-indigo-500 w-5 h-5" checked>
                </label>
                <p id="scanner-export-note" class="text-[11px] text-gray-500"></p>
                <div class="grid grid-cols-2 gap-2">
                    <button type="button" id="scanner-save-pdf" class="py-3 rounded-xl bg-indigo-600 text-sm font-semibold">Save PDF</button>
                    <button type="button" id="scanner-share-btn" class="py-3 rounded-xl bg-white/10 text-sm font-semibold">Share</button>
                    <button type="button" id="scanner-save-jpg" class="col-span-2 py-3 rounded-xl bg-white/10 text-sm font-medium">Save images (JPG)</button>
                </div>
            </div>
        </section>

        <!-- ===== OCR sheet ===== -->
        <section id="scanner-screen-ocr" class="scanner-screen absolute inset-0 flex-col justify-end bg-black/70">
            <div class="sheet bg-neutral-900 rounded-t-3xl p-4 space-y-3 max-h-full overflow-y-auto">
                <div class="flex items-center justify-between">
                    <h3 class="text-base font-semibold">Recognise text</h3>
                    <button type="button" id="scanner-ocr-close" class="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <select id="scanner-ocr-lang" class="w-full p-3 rounded-xl bg-gray-800 text-sm">${langOptions}</select>
                <p id="scanner-ocr-note" class="text-[11px] text-gray-400"></p>
                <div id="scanner-ocr-progress" class="hidden space-y-1">
                    <div class="h-1.5 rounded-full bg-gray-700 overflow-hidden">
                        <div id="scanner-ocr-bar" class="h-full bg-indigo-500 transition-all" style="width:0%"></div>
                    </div>
                    <p id="scanner-ocr-progress-label" class="text-[11px] text-gray-400"></p>
                </div>
                <textarea id="scanner-ocr-result" class="hidden w-full h-48 p-3 rounded-xl bg-gray-800 text-sm font-mono leading-relaxed" spellcheck="false"></textarea>
                <div class="grid grid-cols-2 gap-2">
                    <button type="button" id="scanner-ocr-start" class="col-span-2 py-3 rounded-xl bg-indigo-600 text-sm font-semibold">Start</button>
                    <button type="button" id="scanner-ocr-to-word" class="hidden py-3 rounded-xl bg-indigo-600 text-sm font-semibold">Open in Word</button>
                    <button type="button" id="scanner-ocr-copy" class="hidden py-3 rounded-xl bg-white/10 text-sm font-medium">Copy</button>
                    <button type="button" id="scanner-ocr-download" class="hidden col-span-2 py-3 rounded-xl bg-white/10 text-sm font-medium">Save as .txt</button>
                </div>
            </div>
        </section>
    </div>
</div>`;
}

/* ================================================================== */
/* Lifecycle                                                           */
/* ================================================================== */

let saveTimer = null;

function scheduleSave() {
    setSaveStatus('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        try {
            await store.safeWrite(() => store.saveDoc(S.doc), S.docId);
            setSaveStatus('Saved');
        } catch (err) {
            setSaveStatus('Not saved', true);
            // "Storage may be full" was previously shown unconditionally, which
            // hides the real cause (e.g. IndexedDB blocked entirely, or a write
            // genuinely too large) behind a guess. Log + surface what actually
            // happened, plus the quota snapshot at the moment of failure, so a
            // failure on a brand-new document (nothing to reclaim from yet) is
            // diagnosable instead of just repeating the same generic message.
            const quota = await store.getQuota().catch(() => null);
            console.error('[Scanner] save failed:', err && err.name, err && err.message, err, 'quota:', quota);
            const name = err && err.name ? `${err.name}: ` : '';
            const msg = (err && err.message) || 'unknown error';
            const quotaNote = quota && quota.quota
                ? ` [using ${(quota.usage / 1048576).toFixed(1)}MB / ${(quota.quota / 1048576).toFixed(1)}MB]`
                : '';
            toast(`Could not save — ${name}${msg}${quotaNote}`, true);
        }
    }, 400);
}

function setSaveStatus(text, isError = false) {
    const node = el('scanner-save-status');
    if (!node) return;
    node.textContent = text;
    node.className = `text-[11px] shrink-0 ${isError ? 'text-red-400' : 'text-gray-400'}`;
    if (!isError && text === 'Saved') setTimeout(() => { if (node.textContent === 'Saved') node.textContent = ''; }, 1500);
}

/**
 * Entry point. Opens the scanner for an existing document or creates a new one.
 */
export async function init(docId) {
    stopCamera();
    S.docId = docId;
    S.maxDim = pickMaxDim();
    S.autoCapture = prefBool(PREF_AUTO, true);
    try {
        const savedMode = localStorage.getItem(PREF_MODE);
        if (savedMode && MODES[savedMode]) S.mode = savedMode;
    } catch (_) {}

    mountModal();

    try {
        await store.initStore();
    } catch (err) {
        console.error('[Scanner] storage unavailable:', err);
        toast('Storage is unavailable in this browser. Scans cannot be saved.', true);
    }

    S.doc = await store.loadDoc(docId);
    if (!S.doc) {
        S.doc = store.createEmptyDoc(docId, S.mode);
        await store.saveDoc(S.doc).catch(() => {});
    } else {
        if (MODES[S.doc.mode]) S.mode = S.doc.mode;
    }
    if (!Array.isArray(S.doc.pages)) S.doc.pages = [];

    el('scanner-doc-title').value = S.doc.title || 'Scanned Document';
    applyModeToUI();
    await refreshPageViews();

    // Warn early rather than at export time, when the work is already done.
    const quota = await store.getQuota();
    if (quota.quota && quota.ratio > 0.9) {
        toast('Device storage is almost full — old originals may be cleaned up.', true);
    }

    if (S.doc.pages.length) showScreen('pages');
    else await openCamera();

    // Prefetch the PDF engine while the user is scanning, so export is instant
    // and available offline afterwards.
    setTimeout(() => preloadPdfEngine(), 3000);
}

function mountModal() {
    let modal = el('scanner-modal');
    if (modal) modal.remove();
    document.body.insertAdjacentHTML('beforeend', modalHtml());
    modal = el('scanner-modal');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    bindEvents();
}

function showScreen(name) {
    S.screen = name;
    ['camera', 'editor', 'pages', 'export', 'ocr'].forEach((s) => {
        const node = el('scanner-screen-' + s);
        if (node) node.classList.toggle('active', s === name);
    });
    // The camera must not keep running behind another screen: it drains the
    // battery and holds the torch on.
    if (name !== 'camera') stopCamera();
}

async function closeScanner() {
    clearTimeout(saveTimer);
    stopCamera();
    disposeWorker();
    ocr.terminateOcr();
    releaseUrls();
    if (S.editorBitmap && S.editorBitmap.close) S.editorBitmap.close();
    if (S.previewCache && S.previewCache.bitmap && S.previewCache.bitmap.close) S.previewCache.bitmap.close();

    if (S.doc) {
        // A document with no pages is clutter in the user's list.
        if (!S.doc.pages.length) await store.deleteDoc(S.docId).catch(() => {});
        else await store.saveDoc(S.doc).catch(() => {});
    }

    S.doc = null; S.editorImage = null; S.editorBitmap = null; S.previewCache = null;
    const modal = el('scanner-modal');
    if (modal) modal.remove();
    document.body.style.overflow = '';
    if (typeof window.renderMyDocuments === 'function') { try { window.renderMyDocuments(); } catch (_) {} }
}

/* ================================================================== */
/* Modes                                                               */
/* ================================================================== */

function applyModeToUI() {
    document.querySelectorAll('#scanner-modal .scanner-mode-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === S.mode);
    });
    const hint = el('scanner-hint');
    if (hint) hint.textContent = MODES[S.mode].hint;
}

function setMode(mode) {
    if (!MODES[mode] || mode === S.mode) return;
    S.mode = mode;
    setPref(PREF_MODE, mode);
    if (S.doc) { S.doc.mode = mode; scheduleSave(); }
    S.liveCorners = null;
    S.stableCount = 0;
    applyModeToUI();
}

/* ================================================================== */
/* Camera                                                              */
/* ================================================================== */

async function openCamera() {
    showScreen('camera');
    await startCamera();
}

async function startCamera() {
    const video = el('scanner-video');
    const errorBox = el('scanner-camera-error');
    if (!video) return;
    if (S.stream) { startDetectionLoop(); return; }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showCameraError('This browser cannot access the camera. Import a photo from your gallery instead.');
        return;
    }

    // Ask for a high-resolution stream. `ideal` rather than `exact` so a phone
    // that cannot do 2560 gives us its best instead of refusing outright — the
    // old version asked for nothing and got a 640x480 preview.
    const constraints = {
        audio: false,
        video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 2560 },
            height: { ideal: 1440 },
            // Continuous focus matters more than resolution for readable text.
            focusMode: { ideal: 'continuous' }
        }
    };

    try {
        S.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
        if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
            try {
                S.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } });
            } catch (err2) {
                showCameraError(cameraErrorText(err2));
                return;
            }
        } else {
            showCameraError(cameraErrorText(err));
            return;
        }
    }

    errorBox.classList.add('hidden');
    errorBox.classList.remove('flex');
    video.srcObject = S.stream;
    try { await video.play(); } catch (_) {}

    S.videoTrack = (S.stream && typeof S.stream.getVideoTracks === 'function') ? (S.stream.getVideoTracks()[0] || null) : null;
    setupTorch();
    setupImageCapture();
    S.maxSharpness = 0;
    S.stableCount = 0;
    startDetectionLoop();
}

function cameraErrorText(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
        return 'Camera access was blocked. Allow it in your browser settings, or import a photo from your gallery.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return 'No camera was found on this device.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
        return 'The camera is busy in another app. Close it and try again.';
    }
    return 'Camera could not be started. ' + ((err && err.message) || '');
}

function showCameraError(text) {
    toast(text, true);
    const box = el('scanner-camera-error');
    if (!box) return;
    el('scanner-camera-error-text').textContent = text;
    box.classList.remove('hidden');
    box.classList.add('flex');
}

function setupTorch() {
    const btn = el('scanner-torch-btn');
    if (!btn || !S.videoTrack) return;
    let supported = false;
    try {
        const caps = S.videoTrack.getCapabilities ? S.videoTrack.getCapabilities() : {};
        supported = !!(caps && caps.torch);
    } catch (_) {}
    // No torch on iOS Safari at all. Hiding the button beats showing one that
    // silently does nothing.
    btn.classList.toggle('hidden', !supported);
    btn.classList.toggle('flex', supported);
}

async function toggleTorch() {
    if (!S.videoTrack) return;
    try {
        S.torchOn = !S.torchOn;
        await S.videoTrack.applyConstraints({ advanced: [{ torch: S.torchOn }] });
        el('scanner-torch-btn').classList.toggle('bg-yellow-400', S.torchOn);
        el('scanner-torch-btn').classList.toggle('text-black', S.torchOn);
    } catch (err) {
        S.torchOn = false;
        toast('Flashlight is not available on this device.', true);
    }
}

function setupImageCapture() {
    S.imageCapture = null;
    if (typeof ImageCapture === 'undefined' || !S.videoTrack) return;
    try {
        S.imageCapture = new ImageCapture(S.videoTrack);
    } catch (_) {
        S.imageCapture = null;
    }
}

function stopCamera() {
    if (S.rafId) { cancelAnimationFrame(S.rafId); S.rafId = null; }
    if (S.torchOn && S.videoTrack) {
        try { S.videoTrack.applyConstraints({ advanced: [{ torch: false }] }); } catch (_) {}
        S.torchOn = false;
    }
    if (S.stream) {
        S.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        S.stream = null;
    }
    S.videoTrack = null;
    S.imageCapture = null;
    const video = el('scanner-video');
    if (video) video.srcObject = null;
    S.liveCorners = null;
    S.stableCount = 0;
}

/* ================================================================== */
/* Live edge detection + auto capture                                  */
/* ================================================================== */

// Where the letterboxed video content actually sits inside the overlay canvas.
function videoContentRect(video, canvasW, canvasH) {
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const scale = Math.min(canvasW / vw, canvasH / vh);
    const w = vw * scale;
    const h = vh * scale;
    return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h, vw, vh };
}

function startDetectionLoop() {
    if (S.rafId) cancelAnimationFrame(S.rafId);
    const step = () => {
        S.rafId = requestAnimationFrame(step);
        if (S.screen !== 'camera' || !S.stream) return;
        const now = performance.now();
        if (MODES[S.mode].warp && !S.detectBusy && now - S.lastDetectAt >= DETECT_INTERVAL_MS) {
            S.lastDetectAt = now;
            runDetection();
        }
        drawOverlay();
    };
    S.rafId = requestAnimationFrame(step);
}

async function runDetection() {
    const video = el('scanner-video');
    if (!video || !video.videoWidth) return;
    S.detectBusy = true;
    try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const w = DETECT_WIDTH;
        const h = Math.max(8, Math.round((vh / vw) * DETECT_WIDTH));

        if (!S.detectCanvas) {
            S.detectCanvas = makeCanvas(w, h);
            S.detectCtx = S.detectCanvas.getContext('2d', { willReadFrequently: true });
        } else if (S.detectCanvas.width !== w || S.detectCanvas.height !== h) {
            S.detectCanvas.width = w;
            S.detectCanvas.height = h;
        }
        S.detectCtx.drawImage(video, 0, 0, w, h);
        const frame = S.detectCtx.getImageData(0, 0, w, h);

        let corners = null;
        let sharpness = 0;
        if (!S.workerFailed) {
            try {
                const res = await callWorker({ cmd: 'detect', width: w, height: h, buffer: frame.data.buffer }, [frame.data.buffer]);
                corners = res.corners;
                sharpness = res.sharpness;
            } catch (_) {
                // Worker unusable — the next line handles it on this thread.
            }
        }
        if (corners === null && sharpness === 0) {
            const fresh = S.detectCtx.getImageData(0, 0, w, h);
            const gray = toGray(fresh.data, w, h);
            corners = detectDocument(gray, w, h);
            sharpness = sharpnessScore(gray, w, h);
        }

        // Normalise to 0..1 of the frame so the overlay and the stored corners do
        // not depend on the detection resolution.
        const norm = corners ? corners.map((p) => ({ x: p.x / w, y: p.y / h })) : null;
        updateStability(norm, sharpness);
    } catch (err) {
        console.warn('[Scanner] detection error:', err);
    } finally {
        S.detectBusy = false;
    }
}

function updateStability(norm, sharpness) {
    const previous = S.liveCorners;
    S.liveCorners = norm;

    if (sharpness > S.maxSharpness) S.maxSharpness = sharpness;

    if (!norm) { S.stableCount = 0; return; }
    if (!previous) { S.stableCount = 1; return; }

    let maxMove = 0;
    for (let i = 0; i < 4; i++) {
        maxMove = Math.max(maxMove, Math.hypot(norm[i].x - previous[i].x, norm[i].y - previous[i].y));
    }

    // The focus gate is relative to the sharpest frame seen since the camera
    // opened. An absolute threshold would be wrong for every different scene.
    const focused = S.maxSharpness === 0 || sharpness >= S.maxSharpness * 0.5;

    if (maxMove < AUTO_MOVE_TOLERANCE && focused) S.stableCount++;
    else S.stableCount = 0;

    if (S.autoCapture && S.stableCount >= AUTO_STABLE_FRAMES && !S.capturing) {
        S.stableCount = 0;
        capturePhoto();
    }
}

function drawOverlay() {
    const canvas = el('scanner-overlay');
    const video = el('scanner-video');
    if (!canvas || !video) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(canvas.clientWidth * dpr);
    const ch = Math.round(canvas.clientHeight * dpr);
    if (!cw || !ch) return;
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    if (!S.liveCorners) return;

    const rect = videoContentRect(video, cw, ch);
    const pts = S.liveCorners.map((p) => ({ x: rect.x + p.x * rect.w, y: rect.y + p.y * rect.h }));

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(99,102,241,0.18)';
    ctx.fill();
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(129,140,248,0.95)';
    ctx.stroke();

    for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
    }

    // Countdown ring: shows the user the shot is coming instead of surprising them.
    if (S.autoCapture && S.stableCount > 0) {
        const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
        const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
        const radius = 26 * dpr;
        const progress = Math.min(1, S.stableCount / AUTO_STABLE_FRAMES);
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.lineWidth = 4 * dpr;
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
        ctx.strokeStyle = '#fff';
        ctx.stroke();
    }
    ctx.restore();
}

/* ================================================================== */
/* Capture                                                             */
/* ================================================================== */

async function grabFullResolutionBlob() {
    // Android Chrome: takePhoto() gives the sensor's still resolution, which is
    // several times what the preview stream carries.
    if (S.imageCapture && S.imageCapture.takePhoto) {
        try {
            const blob = await S.imageCapture.takePhoto();
            if (blob && blob.size > 0) return blob;
        } catch (_) {
            // iOS implements ImageCapture partially or not at all; fall through.
        }
    }
    const video = el('scanner-video');
    if (!video || !video.videoWidth) throw new Error('Camera is not ready yet.');
    const canvas = makeCanvas(video.videoWidth, video.videoHeight);
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    canvas.width = canvas.height = 0;
    return blob;
}

async function capturePhoto() {
    if (S.capturing) return;
    if (S.doc.pages.length >= MAX_PAGES) {
        toast(`A document can hold ${MAX_PAGES} pages. Export this one first.`, true);
        return;
    }
    S.capturing = true;
    buzz(20);
    flashShutter();
    try {
        const raw = await grabFullResolutionBlob();
        // Detected corners are reused so the first result is already cropped,
        // but they came from the preview frame — proportions match, so the
        // normalised values transfer directly to the still image.
        const hintCorners = MODES[S.mode].warp ? S.liveCorners : null;
        await addPageFromBlob(raw, hintCorners);
    } catch (err) {
        console.error('[Scanner] capture failed:', err);
        toast((err && err.message) || 'Capture failed.', true);
    } finally {
        S.capturing = false;
        S.stableCount = 0;
    }
}

function flashShutter() {
    const viewport = el('scanner-viewport');
    if (!viewport) return;
    const flash = document.createElement('div');
    flash.className = 'absolute inset-0 bg-white pointer-events-none';
    flash.style.transition = 'opacity .25s ease-out';
    viewport.appendChild(flash);
    requestAnimationFrame(() => { flash.style.opacity = '0'; });
    setTimeout(() => flash.remove(), 320);
}

/* ================================================================== */
/* Gallery import                                                      */
/* ================================================================== */

async function importFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    const room = MAX_PAGES - S.doc.pages.length;
    if (room <= 0) { toast(`A document can hold ${MAX_PAGES} pages.`, true); return; }
    const batch = files.slice(0, room);
    if (batch.length < files.length) toast(`Only ${batch.length} of ${files.length} images were added — the document is full.`, true);

    setSaveStatus('Importing…');
    for (const file of batch) {
        try {
            await addPageFromBlob(file, null);
        } catch (err) {
            console.error('[Scanner] import failed:', err);
            toast(`"${file.name}" could not be imported.`, true);
        }
    }
    if (S.screen === 'camera' && S.doc.pages.length) showScreen('pages');
}

/* ================================================================== */
/* Page creation and rendering                                         */
/* ================================================================== */

function nextPageId() {
    let n = 1;
    const used = new Set(S.doc.pages.map((p) => p.id));
    while (used.has('p' + n)) n++;
    return 'p' + n;
}

// A sensible starting quad when detection finds nothing: a small inset, so the
// user drags four visible handles instead of hunting for them at the edges.
function fallbackCorners(w, h) {
    const ix = w * 0.06;
    const iy = h * 0.06;
    return [
        { x: ix, y: iy },
        { x: w - ix, y: iy },
        { x: w - ix, y: h - iy },
        { x: ix, y: h - iy }
    ];
}

function detectCornersInImageData(imageData) {
    const { width: w, height: h } = imageData;
    const dw = DETECT_WIDTH;
    const dh = Math.max(8, Math.round((h / w) * dw));
    const src = makeCanvas(w, h);
    src.getContext('2d').putImageData(imageData, 0, 0);
    const small = makeCanvas(dw, dh);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(src, 0, 0, dw, dh);
    const frame = sctx.getImageData(0, 0, dw, dh);
    src.width = src.height = 0;
    small.width = small.height = 0;

    const found = detectDocument(toGray(frame.data, dw, dh), dw, dh);
    if (!found) return null;
    return found.map((p) => ({ x: (p.x / dw) * w, y: (p.y / dh) * h }));
}

/**
 * Turns a captured or imported image into a page: stores the original, works out
 * the corners, renders the result, then opens the editor for confirmation.
 */
async function addPageFromBlob(blob, normalisedCornerHint) {
    const bitmap = await decodeBlob(blob);
    // The stored original is bounded to captureMaxDim(), not the smaller final
    // export size — see CAPTURE_HEADROOM. It is still far below the raw sensor
    // resolution, which is what keeps 30 pages fitting comfortably.
    const imageData = bitmapToImageData(bitmap, captureMaxDim());
    if (bitmap.close) bitmap.close();

    const canvas = makeCanvas(imageData.width, imageData.height);
    canvas.getContext('2d').putImageData(imageData, 0, 0);
    const origBlob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    canvas.width = canvas.height = 0;

    const mode = MODES[S.mode];
    let corners = null;
    if (mode.warp) {
        if (normalisedCornerHint) {
            corners = normalisedCornerHint.map((p) => ({ x: p.x * imageData.width, y: p.y * imageData.height }));
        } else {
            corners = detectCornersInImageData(imageData);
        }
        if (!corners) corners = fallbackCorners(imageData.width, imageData.height);
        corners = sortCorners(corners);
    }

    const pageId = nextPageId();
    const page = store.createPage(pageId, imageData.width, imageData.height, corners, mode.filter);
    S.doc.pages.push(page);

    try {
        await store.safeWrite(() => store.putBlob(S.docId, pageId, 'orig', origBlob), S.docId);
    } catch (err) {
        S.doc.pages = S.doc.pages.filter((p) => p.id !== pageId);
        const quota = await store.getQuota().catch(() => null);
        console.error('[Scanner] page blob save failed:', err && err.name, err && err.message, err, 'quota:', quota, 'blob size:', origBlob.size);
        const name = err && err.name ? `${err.name}: ` : '';
        throw new Error(`Could not store this page — ${name}${(err && err.message) || 'unknown error'}`);
    }

    await renderPage(page, imageData);
    scheduleSave();
    await refreshPageViews();
    // Straight into the editor: the crop is a guess, and confirming it once is
    // faster than discovering later that a corner was off.
    if (mode.warp) openEditor(pageId, imageData);
}

// Runs warp + filter + rotation. Uses the worker when possible; the main thread
// is a real fallback, not a stub, because module workers are missing in a few
// old WebViews.
async function renderPage(page, knownImageData = null) {
    let imageData = knownImageData;
    if (!imageData) {
        const orig = await store.getBlob(S.docId, page.id, 'orig');
        if (!orig) {
            // Original was reclaimed to free space; the processed page still exists.
            page.dirty = false;
            return null;
        }
        const bitmap = await decodeBlob(orig);
        imageData = bitmapToImageData(bitmap, null);
        if (bitmap.close) bitmap.close();
    }

    const size = page.corners
        ? estimateOutputSize(page.corners, S.maxDim, imageData.width, imageData.height)
        : { width: imageData.width, height: imageData.height };
    const params = {
        cmd: 'render',
        width: imageData.width,
        height: imageData.height,
        corners: page.corners,
        outWidth: size.width,
        outHeight: size.height,
        filter: page.filter,
        rotation: page.rotation,
        brightness: page.brightness,
        contrast: page.contrast,
        maxDim: S.maxDim,
        encode: { type: 'image/jpeg', quality: JPEG_QUALITY }
    };

    let outBlob = null;
    let outW = size.width;
    let outH = size.height;

    if (!S.workerFailed) {
        try {
            // The buffer is transferred, so hand over a copy and keep ours intact
            // for the editor preview.
            const copy = new Uint8ClampedArray(imageData.data);
            const res = await callWorker({ ...params, buffer: copy.buffer }, [copy.buffer]);
            outW = res.width;
            outH = res.height;
            if (res.blob) {
                outBlob = res.blob;
            } else if (res.buffer) {
                const pixels = new Uint8ClampedArray(res.buffer);
                outBlob = await encodePixels(pixels, outW, outH);
            }
        } catch (err) {
            console.warn('[Scanner] worker render failed, using main thread:', err.message);
        }
    }

    if (!outBlob) {
        const result = renderOnMainThread(imageData, page, size);
        outW = result.width;
        outH = result.height;
        outBlob = await encodePixels(result.data, outW, outH);
    }

    page.outWidth = outW;
    page.outHeight = outH;
    page.dirty = false;

    const thumbBlob = await makeThumb(outBlob);
    await store.safeWrite(async () => {
        await store.putBlob(S.docId, page.id, 'out', outBlob);
        if (thumbBlob) await store.putBlob(S.docId, page.id, 'thumb', thumbBlob);
    }, S.docId);

    return outBlob;
}

function renderOnMainThread(imageData, page, size) {
    let rgba = new Uint8ClampedArray(imageData.data);
    let w = imageData.width;
    let h = imageData.height;

    if (page.corners) {
        const warped = warpPerspective(rgba, w, h, page.corners, size.width, size.height);
        if (warped) { rgba = warped.data; w = warped.width; h = warped.height; }
    }
    applyFilterToPixels(rgba, w, h, page.filter, { brightness: page.brightness, contrast: page.contrast });
    if (page.rotation) {
        const rotated = rotatePixels(rgba, w, h, page.rotation);
        rgba = rotated.data; w = rotated.width; h = rotated.height;
    }
    return { data: rgba, width: w, height: h };
}

async function encodePixels(pixels, w, h, quality = JPEG_QUALITY) {
    const canvas = makeCanvas(w, h);
    canvas.getContext('2d').putImageData(new ImageData(pixels, w, h), 0, 0);
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    canvas.width = canvas.height = 0;
    return blob;
}

async function makeThumb(blob) {
    try {
        const bitmap = await decodeBlob(blob);
        const scale = Math.min(1, THUMB_MAX_DIM / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = makeCanvas(w, h);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        if (bitmap.close) bitmap.close();
        const out = await canvasToBlob(canvas, 'image/jpeg', 0.72);
        canvas.width = canvas.height = 0;
        return out;
    } catch (_) {
        return null;
    }
}

/* ================================================================== */
/* Page views (strip + manager grid)                                   */
/* ================================================================== */

const thumbUrls = new Map();

async function thumbUrl(pageId) {
    if (thumbUrls.has(pageId)) return thumbUrls.get(pageId);
    const blob = (await store.getBlob(S.docId, pageId, 'thumb')) || (await store.getBlob(S.docId, pageId, 'out'));
    if (!blob) return null;
    const url = trackUrl(URL.createObjectURL(blob));
    thumbUrls.set(pageId, url);
    return url;
}

function invalidateThumb(pageId) {
    const url = thumbUrls.get(pageId);
    if (url) { try { URL.revokeObjectURL(url); } catch (_) {} S.urls.delete(url); }
    thumbUrls.delete(pageId);
}

async function refreshPageViews() {
    const count = S.doc ? S.doc.pages.length : 0;
    const countNode = el('scanner-page-count');
    if (countNode) countNode.textContent = String(count);
    const done = el('scanner-done-btn');
    if (done) done.disabled = count === 0;

    const strip = el('scanner-page-strip');
    if (strip) {
        strip.classList.toggle('hidden', count === 0);
        strip.classList.toggle('flex', count > 0);
        strip.innerHTML = '';
        for (const page of S.doc.pages) {
            const url = await thumbUrl(page.id);
            const item = document.createElement('button');
            item.type = 'button';
            item.dataset.pageId = page.id;
            item.className = 'scanner-strip-item shrink-0 w-12 h-16 rounded-lg overflow-hidden bg-white/10 border border-white/20';
            item.innerHTML = url
                ? `<img src="${url}" alt="" class="w-full h-full object-cover">`
                : '<i class="fa-solid fa-image text-gray-500"></i>';
            strip.appendChild(item);
        }
    }

    const grid = el('scanner-pages-grid');
    if (grid) {
        grid.innerHTML = '';
        if (!count) {
            grid.innerHTML = '<p class="col-span-full text-center text-sm text-gray-500 py-10">No pages yet.</p>';
        }
        for (let i = 0; i < S.doc.pages.length; i++) {
            const page = S.doc.pages[i];
            const url = await thumbUrl(page.id);
            const card = document.createElement('div');
            card.className = 'rounded-xl overflow-hidden bg-neutral-800';
            card.innerHTML = `
                <button type="button" class="block w-full aspect-[3/4] bg-neutral-700" data-action="edit" data-page-id="${page.id}">
                    ${url ? `<img src="${url}" alt="Page ${i + 1}" class="w-full h-full object-contain">` : '<i class="fa-solid fa-image text-gray-500"></i>'}
                </button>
                <div class="flex items-center justify-between px-1.5 py-1.5">
                    <span class="text-[11px] text-gray-400 pl-1">${i + 1}</span>
                    <div class="flex gap-0.5">
                        <button type="button" class="w-7 h-7 rounded-md hover:bg-white/10 disabled:opacity-30" data-action="up" data-page-id="${page.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move earlier"><i class="fa-solid fa-arrow-left text-[11px]"></i></button>
                        <button type="button" class="w-7 h-7 rounded-md hover:bg-white/10 disabled:opacity-30" data-action="down" data-page-id="${page.id}" ${i === S.doc.pages.length - 1 ? 'disabled' : ''} aria-label="Move later"><i class="fa-solid fa-arrow-right text-[11px]"></i></button>
                        <button type="button" class="w-7 h-7 rounded-md hover:bg-white/10" data-action="rotate" data-page-id="${page.id}" aria-label="Rotate"><i class="fa-solid fa-rotate-right text-[11px]"></i></button>
                        <button type="button" class="w-7 h-7 rounded-md hover:bg-white/10 text-red-400" data-action="delete" data-page-id="${page.id}" aria-label="Delete"><i class="fa-solid fa-trash text-[11px]"></i></button>
                    </div>
                </div>`;
            grid.appendChild(card);
        }
    }
}

function findPage(pageId) {
    return S.doc.pages.find((p) => p.id === pageId) || null;
}

async function movePage(pageId, delta) {
    const i = S.doc.pages.findIndex((p) => p.id === pageId);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= S.doc.pages.length) return;
    const [page] = S.doc.pages.splice(i, 1);
    S.doc.pages.splice(j, 0, page);
    scheduleSave();
    await refreshPageViews();
}

async function rotatePage(pageId) {
    const page = findPage(pageId);
    if (!page) return;
    page.rotation = (page.rotation + 90) % 360;
    page.dirty = true;
    setSaveStatus('Working…');
    await renderPage(page);
    invalidateThumb(pageId);
    scheduleSave();
    await refreshPageViews();
}

async function deletePage(pageId) {
    const page = findPage(pageId);
    if (!page) return;
    if (!window.confirm('Delete this page?')) return;
    S.doc.pages = S.doc.pages.filter((p) => p.id !== pageId);
    invalidateThumb(pageId);
    await store.deletePageBlobs(S.docId, pageId);
    scheduleSave();
    await refreshPageViews();
    if (!S.doc.pages.length) await openCamera();
}

/* ================================================================== */
/* Editor: corners, loupe, filters                                     */
/* ================================================================== */

let editorTab = 'crop';

async function openEditor(pageId, knownImageData = null) {
    const page = findPage(pageId);
    if (!page) return;

    S.editingPageId = pageId;
    showScreen('editor');
    setEditorBusy(true);

    try {
        if (knownImageData) {
            S.editorImage = knownImageData;
        } else {
            const orig = await store.getBlob(S.docId, pageId, 'orig');
            if (!orig) {
                // Reclaimed original: corners can no longer be adjusted, but the
                // filter and rotation still can, so open in adjust mode.
                S.editorImage = null;
                toast('The original of this page was cleaned up to free space — only adjustments are available.', true);
            } else {
                const bitmap = await decodeBlob(orig);
                S.editorImage = bitmapToImageData(bitmap, null);
                if (bitmap.close) bitmap.close();
            }
        }

        S.editorCorners = page.corners
            ? page.corners.map((p) => ({ x: p.x, y: p.y }))
            : null;

        // Cache a bitmap so dragging a corner repaints without re-uploading the
        // whole image every frame.
        if (S.editorBitmap && S.editorBitmap.close) S.editorBitmap.close();
        S.editorBitmap = S.editorImage ? await createImageBitmap(S.editorImage) : null;

        syncEditorControls(page);
        setEditorTab(S.editorCorners ? 'crop' : 'adjust');
    } catch (err) {
        console.error('[Scanner] editor failed to open:', err);
        toast('This page could not be opened for editing.', true);
        showScreen('pages');
    } finally {
        setEditorBusy(false);
    }
}

function setEditorBusy(busy) {
    const node = el('scanner-editor-busy');
    if (!node) return;
    node.classList.toggle('hidden', !busy);
    node.classList.toggle('flex', busy);
}

function syncEditorControls(page) {
    document.querySelectorAll('#scanner-toolbar .filter-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.filter === page.filter);
    });
    el('scanner-brightness').value = String(page.brightness || 0);
    el('scanner-contrast').value = String(page.contrast || 0);
    const resetCorners = el('scanner-reset-corners');
    if (resetCorners) resetCorners.disabled = !S.editorCorners;
}

function setEditorTab(tab) {
    editorTab = tab;
    document.querySelectorAll('#scanner-modal .scanner-tab-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    const cropOnly = el('scanner-reset-corners');
    if (cropOnly) cropOnly.classList.toggle('hidden', tab !== 'crop');
    el('scanner-adjust-row').classList.toggle('hidden', tab !== 'adjust');
    el('scanner-toolbar').classList.toggle('hidden', tab !== 'adjust');
    if (tab === 'crop') drawEditorCrop();
    else schedulePreview(0);
}

// Fits the original into the available area and remembers the scale, so pointer
// coordinates can be converted back to original pixels.
function layoutEditorCanvas(imgW, imgH) {
    const canvas = el('scanner-crop-canvas');
    const viewport = el('scanner-editor-viewport');
    const availW = Math.max(80, viewport.clientWidth - 24);
    const availH = Math.max(80, viewport.clientHeight - 24);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssScale = Math.min(availW / imgW, availH / imgH);
    const cssW = Math.round(imgW * cssScale);
    const cssH = Math.round(imgH * cssScale);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    return { scale: (cssW * dpr) / imgW, dpr, cssW, cssH };
}

function drawEditorCrop() {
    if (!S.editorBitmap || !S.editorCorners) return;
    const canvas = el('scanner-crop-canvas');
    const imgW = S.editorImage.width;
    const imgH = S.editorImage.height;
    const { scale, dpr } = layoutEditorCanvas(imgW, imgH);
    S.editorScale = scale;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(S.editorBitmap, 0, 0, canvas.width, canvas.height);

    const pts = S.editorCorners.map((p) => ({ x: p.x * scale, y: p.y * scale }));

    // Dim everything outside the quad so the selection reads instantly.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 3; i >= 1; i--) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill('evenodd');
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = '#818cf8';
    ctx.stroke();

    pts.forEach((p, i) => {
        const active = i === S.activeCorner;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (active ? 13 : 10) * dpr, 0, Math.PI * 2);
        ctx.fillStyle = active ? '#6366f1' : 'rgba(255,255,255,0.95)';
        ctx.fill();
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = active ? '#fff' : '#6366f1';
        ctx.stroke();
    });

    if (S.activeCorner >= 0) drawLoupe(ctx, canvas, pts[S.activeCorner], dpr);
}

// The magnifier sits in a fixed corner of the canvas and jumps to another corner
// when the finger gets close. A loupe that follows the finger is always partly
// under it, which is exactly when you need to see.
function drawLoupe(ctx, canvas, point, dpr) {
    const size = Math.min(112 * dpr, canvas.width * 0.42);
    const pad = 10 * dpr;
    const candidates = [
        { x: pad, y: pad },
        { x: canvas.width - size - pad, y: pad },
        { x: pad, y: canvas.height - size - pad },
        { x: canvas.width - size - pad, y: canvas.height - size - pad }
    ];
    let best = candidates[0];
    let bestDist = -1;
    for (const c of candidates) {
        const cx = c.x + size / 2;
        const cy = c.y + size / 2;
        const d = Math.hypot(cx - point.x, cy - point.y);
        if (d > bestDist) { bestDist = d; best = c; }
    }

    const zoom = 2.5;
    const srcSize = size / zoom;
    const sx = (point.x / S.editorScale) - srcSize / (2 * S.editorScale);
    const sy = (point.y / S.editorScale) - srcSize / (2 * S.editorScale);
    const srcW = srcSize / S.editorScale;

    ctx.save();
    ctx.beginPath();
    ctx.rect(best.x, best.y, size, size);
    ctx.clip();
    ctx.fillStyle = '#111';
    ctx.fillRect(best.x, best.y, size, size);
    ctx.drawImage(S.editorBitmap, sx, sy, srcW, srcW, best.x, best.y, size, size);
    // Crosshair marking the exact pixel under the corner.
    ctx.strokeStyle = 'rgba(99,102,241,0.95)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(best.x + size / 2, best.y);
    ctx.lineTo(best.x + size / 2, best.y + size);
    ctx.moveTo(best.x, best.y + size / 2);
    ctx.lineTo(best.x + size, best.y + size / 2);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(best.x, best.y, size, size);
}

function canvasPointFromEvent(event) {
    const canvas = el('scanner-crop-canvas');
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    return { x: (event.clientX - rect.left) * dpr, y: (event.clientY - rect.top) * dpr };
}

function onEditorPointerDown(event) {
    if (editorTab !== 'crop' || !S.editorCorners) return;
    const p = canvasPointFromEvent(event);
    const canvas = el('scanner-crop-canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Generous hit radius: a fingertip is about 9 mm across.
    const hitRadius = 34 * dpr;
    let nearest = -1;
    let nearestDist = Infinity;
    S.editorCorners.forEach((c, i) => {
        const d = Math.hypot(c.x * S.editorScale - p.x, c.y * S.editorScale - p.y);
        if (d < nearestDist) { nearestDist = d; nearest = i; }
    });
    if (nearestDist > hitRadius) return;
    S.activeCorner = nearest;
    S.pointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    drawEditorCrop();
}

function onEditorPointerMove(event) {
    if (S.activeCorner < 0 || event.pointerId !== S.pointerId) return;
    const p = canvasPointFromEvent(event);
    const imgW = S.editorImage.width;
    const imgH = S.editorImage.height;
    S.editorCorners[S.activeCorner] = {
        x: Math.max(0, Math.min(imgW, p.x / S.editorScale)),
        y: Math.max(0, Math.min(imgH, p.y / S.editorScale))
    };
    event.preventDefault();
    drawEditorCrop();
}

function onEditorPointerUp(event) {
    if (S.activeCorner < 0) return;
    const canvas = el('scanner-crop-canvas');
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
    S.activeCorner = -1;
    S.pointerId = null;
    // Re-sorting keeps the quad from turning inside out after a big drag.
    S.editorCorners = sortCorners(S.editorCorners);
    drawEditorCrop();
}

/* ---- Adjust tab: live preview of warp + filter ---- */

const PREVIEW_MAX_DIM = 900;
let previewTimer = null;

function schedulePreview(delay = 140) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, delay);
}

async function renderPreview() {
    const page = findPage(S.editingPageId);
    if (!page || editorTab !== 'adjust') return;
    const token = ++S.previewToken;
    setEditorBusy(true);

    try {
        // Preview at reduced size: the maths is identical, it is simply cheaper,
        // so the sliders stay responsive on a slow phone.
        const source = S.editorImage ? downscaleImageData(S.editorImage, PREVIEW_MAX_DIM) : await loadProcessedImageData(page);
        if (!source) return;

        const brightness = Number(el('scanner-brightness').value) || 0;
        const contrast = Number(el('scanner-contrast').value) || 0;
        const scaleFactor = S.editorImage ? source.width / S.editorImage.width : 1;
        const corners = (S.editorCorners && S.editorImage)
            ? S.editorCorners.map((p) => ({ x: p.x * scaleFactor, y: p.y * scaleFactor }))
            : null;
        const size = corners
            ? estimateOutputSize(corners, PREVIEW_MAX_DIM, source.width, source.height)
            : { width: source.width, height: source.height };

        const previewPage = {
            corners,
            filter: currentFilterId(),
            rotation: page.rotation,
            brightness,
            contrast
        };
        const result = renderOnMainThread(source, previewPage, size);
        if (token !== S.previewToken) return;

        const canvas = el('scanner-crop-canvas');
        layoutEditorCanvas(result.width, result.height);
        const ctx = canvas.getContext('2d');
        const bitmap = await createImageBitmap(new ImageData(result.data, result.width, result.height));
        if (token !== S.previewToken) { if (bitmap.close) bitmap.close(); return; }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (bitmap.close) bitmap.close();
    } catch (err) {
        console.warn('[Scanner] preview failed:', err);
    } finally {
        if (token === S.previewToken) setEditorBusy(false);
    }
}

function downscaleImageData(imageData, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(imageData.width, imageData.height));
    if (scale === 1) return imageData;
    const w = Math.max(1, Math.round(imageData.width * scale));
    const h = Math.max(1, Math.round(imageData.height * scale));
    const src = makeCanvas(imageData.width, imageData.height);
    src.getContext('2d').putImageData(imageData, 0, 0);
    const dst = makeCanvas(w, h);
    const dctx = dst.getContext('2d', { willReadFrequently: true });
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(src, 0, 0, w, h);
    const out = dctx.getImageData(0, 0, w, h);
    src.width = src.height = 0;
    dst.width = dst.height = 0;
    return out;
}

// For pages whose original was reclaimed: adjust on top of the processed result.
async function loadProcessedImageData(page) {
    const out = await store.getBlob(S.docId, page.id, 'out');
    if (!out) return null;
    const bitmap = await decodeBlob(out);
    const data = bitmapToImageData(bitmap, PREVIEW_MAX_DIM);
    if (bitmap.close) bitmap.close();
    return data;
}

function currentFilterId() {
    const active = document.querySelector('#scanner-toolbar .filter-btn.active');
    return active ? active.dataset.filter : 'magic';
}

async function applyEditor() {
    const page = findPage(S.editingPageId);
    if (!page) { showScreen('pages'); return; }

    page.filter = currentFilterId();
    page.brightness = Number(el('scanner-brightness').value) || 0;
    page.contrast = Number(el('scanner-contrast').value) || 0;
    if (S.editorCorners) page.corners = S.editorCorners.map((p) => ({ x: p.x, y: p.y }));
    page.dirty = true;

    setEditorBusy(true);
    try {
        await renderPage(page, S.editorImage || null);
        invalidateThumb(page.id);
        scheduleSave();
        await refreshPageViews();
        showScreen('pages');
    } catch (err) {
        console.error('[Scanner] apply failed:', err);
        toast('Could not process this page.', true);
    } finally {
        setEditorBusy(false);
    }
}

/* ================================================================== */
/* Export                                                              */
/* ================================================================== */

async function collectPages() {
    const out = [];
    for (const page of S.doc.pages) {
        if (page.dirty) await renderPage(page);
        const blob = await store.getBlob(S.docId, page.id, 'out');
        if (blob) out.push({ id: page.id, blob, width: page.outWidth, height: page.outHeight });
    }
    if (!out.length) throw new Error('There are no finished pages to export.');
    return out;
}

function openExportSheet() {
    if (!S.doc.pages.length) { toast('Add a page first.', true); return; }
    let saved = 'a4';
    try { saved = localStorage.getItem(PREF_PAGESIZE) || 'a4'; } catch (_) {}
    const radio = document.querySelector(`#scanner-modal input[name="scanner-pagesize"][value="${saved}"]`);
    if (radio) radio.checked = true;
    else document.querySelector('#scanner-modal input[name="scanner-pagesize"][value="a4"]').checked = true;

    const note = el('scanner-export-note');
    if (note) {
        note.textContent = S.mode === 'id-card'
            ? 'ID card mode prints both sides at their real size (85.6 x 54 mm), which is what banks and offices ask for.'
            : `${S.doc.pages.length} page(s) will be exported in the order shown.`;
    }
    showScreen('export');
}

function selectedPageSize() {
    const checked = document.querySelector('#scanner-modal input[name="scanner-pagesize"]:checked');
    return checked ? checked.value : 'a4';
}

async function exportPdf(share) {
    const btn = share ? el('scanner-share-btn') : el('scanner-save-pdf');
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    try {
        const pages = await collectPages();
        const pageSize = selectedPageSize();
        setPref(PREF_PAGESIZE, pageSize);
        const title = el('scanner-doc-title').value.trim() || 'Scanned Document';
        const pdf = await buildPdf(pages, {
            pageSize,
            marginMm: el('scanner-margin-toggle').checked ? 6 : 0,
            layout: S.mode === 'id-card' ? 'id-card' : 'standard',
            title
        });
        const filename = safeFileName(title, 'pdf');
        if (share) {
            const result = await shareOrDownload(pdf, filename, title);
            if (result === 'downloaded') toast('Sharing is not available here — the PDF was saved instead.');
        } else {
            downloadBlob(pdf, filename);
            toast('PDF saved.');
        }
    } catch (err) {
        console.error('[Scanner] export failed:', err);
        toast((err && err.message) || 'Export failed.', true);
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
}

async function exportImages() {
    try {
        const pages = await collectPages();
        const title = el('scanner-doc-title').value.trim() || 'scan';
        if (pages.length === 1) {
            downloadBlob(pages[0].blob, safeFileName(title, 'jpg'));
            toast('Image saved.');
            return;
        }
        // No ZIP: adding a compression library for this would cost more than it
        // is worth. The files are saved one after another instead.
        for (let i = 0; i < pages.length; i++) {
            downloadBlob(pages[i].blob, safeFileName(`${title} ${i + 1}`, 'jpg'));
            await new Promise((r) => setTimeout(r, 350));
        }
        toast(`${pages.length} images saved.`);
    } catch (err) {
        toast((err && err.message) || 'Could not save the images.', true);
    }
}

/* ================================================================== */
/* OCR                                                                 */
/* ================================================================== */

function openOcrSheet() {
    if (!S.doc.pages.length) { toast('Add a page first.', true); return; }
    const select = el('scanner-ocr-lang');
    select.value = ocr.getPreferredLanguage();
    updateOcrNote();
    el('scanner-ocr-result').classList.add('hidden');
    el('scanner-ocr-progress').classList.add('hidden');
    ['scanner-ocr-to-word', 'scanner-ocr-copy', 'scanner-ocr-download'].forEach((id) => el(id).classList.add('hidden'));
    el('scanner-ocr-start').classList.remove('hidden');
    showScreen('ocr');
}

function updateOcrNote() {
    const code = el('scanner-ocr-lang').value;
    el('scanner-ocr-note').textContent = ocr.describeDownload(code).text;
}

async function runOcr() {
    const lang = el('scanner-ocr-lang').value;
    ocr.setPreferredLanguage(lang);
    const startBtn = el('scanner-ocr-start');
    startBtn.disabled = true;
    el('scanner-ocr-progress').classList.remove('hidden');

    const onProgress = (info) => {
        const bar = el('scanner-ocr-bar');
        const label = el('scanner-ocr-progress-label');
        if (bar) bar.style.width = Math.round((info.progress || 0) * 100) + '%';
        if (label) label.textContent = info.label || '';
    };

    try {
        const pages = await collectPages();
        const results = await ocr.recognizePages(pages, lang, onProgress);
        const text = results.map((r) => r.text).filter(Boolean).join('\n\n');
        const failed = results.filter((r) => r.error).length;

        if (!text) {
            toast('No text was found on these pages.', true);
        } else {
            const area = el('scanner-ocr-result');
            area.value = text;
            area.classList.remove('hidden');
            ['scanner-ocr-to-word', 'scanner-ocr-copy', 'scanner-ocr-download'].forEach((id) => el(id).classList.remove('hidden'));
            startBtn.classList.add('hidden');
            const avg = Math.round(results.reduce((a, r) => a + (r.confidence || 0), 0) / results.length);
            el('scanner-ocr-note').textContent = `Recognised with about ${avg}% confidence. Check the text before using it.`;
            if (failed) toast(`${failed} page(s) could not be read.`, true);
        }
    } catch (err) {
        console.error('[Scanner] OCR failed:', err);
        toast((err && err.message) || 'Text recognition failed.', true);
    } finally {
        startBtn.disabled = false;
        el('scanner-ocr-progress').classList.add('hidden');
    }
}

async function sendOcrToWord() {
    const text = el('scanner-ocr-result').value;
    if (!text.trim()) return;
    try {
        const title = el('scanner-doc-title').value.trim() || 'Scanned text';
        const newId = ocr.createWordDocumentFromText(title, text);
        await closeScanner();
        // The Word module owns its own opener; if it is not wired up, the user at
        // least has the document in their list.
        if (typeof window.openWordEditor === 'function') window.openWordEditor(newId);
        else toast('Text saved as a document — open it from your documents list.');
    } catch (err) {
        toast((err && err.message) || 'Could not create the text document.', true);
    }
}

/* ================================================================== */
/* Events                                                              */
/* ================================================================== */

function bindEvents() {
    const modal = el('scanner-modal');

    el('close-scanner-btn').addEventListener('click', () => { closeScanner(); });

    el('scanner-doc-title').addEventListener('input', (e) => {
        if (!S.doc) return;
        S.doc.title = e.target.value.trim() || 'Scanned Document';
        scheduleSave();
    });

    el('scanner-pages-btn').addEventListener('click', () => {
        if (!S.doc.pages.length) { toast('No pages yet — take a photo first.'); return; }
        showScreen('pages');
    });

    // --- camera ---
    el('scanner-shutter-btn').addEventListener('click', () => capturePhoto());
    el('scanner-torch-btn').addEventListener('click', toggleTorch);
    el('scanner-retry-camera').addEventListener('click', () => { stopCamera(); startCamera(); });
    el('scanner-done-btn').addEventListener('click', () => showScreen('pages'));

    el('scanner-auto-btn').addEventListener('click', () => {
        S.autoCapture = !S.autoCapture;
        setPref(PREF_AUTO, S.autoCapture ? '1' : '0');
        updateAutoButton();
        toast(S.autoCapture ? 'Automatic capture on' : 'Automatic capture off');
    });
    updateAutoButton();

    modal.querySelectorAll('.scanner-mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    el('scanner-file-input').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
    el('scanner-fallback-file-input').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });

    el('scanner-page-strip').addEventListener('click', (e) => {
        const item = e.target.closest('.scanner-strip-item');
        if (item) openEditor(item.dataset.pageId);
    });

    // --- editor ---
    const canvas = el('scanner-crop-canvas');
    canvas.addEventListener('pointerdown', onEditorPointerDown);
    canvas.addEventListener('pointermove', onEditorPointerMove);
    canvas.addEventListener('pointerup', onEditorPointerUp);
    canvas.addEventListener('pointercancel', onEditorPointerUp);

    modal.querySelectorAll('.scanner-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (btn.dataset.tab === 'crop' && !S.editorCorners) {
                toast('This page has no adjustable crop.');
                return;
            }
            setEditorTab(btn.dataset.tab);
        });
    });

    modal.querySelectorAll('#scanner-toolbar .filter-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            modal.querySelectorAll('#scanner-toolbar .filter-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            schedulePreview(0);
        });
    });

    el('scanner-brightness').addEventListener('input', () => schedulePreview());
    el('scanner-contrast').addEventListener('input', () => schedulePreview());
    el('scanner-reset-adjust').addEventListener('click', () => {
        el('scanner-brightness').value = '0';
        el('scanner-contrast').value = '0';
        schedulePreview(0);
    });

    el('scanner-reset-corners').addEventListener('click', () => {
        if (!S.editorImage) return;
        S.editorCorners = [
            { x: 0, y: 0 },
            { x: S.editorImage.width, y: 0 },
            { x: S.editorImage.width, y: S.editorImage.height },
            { x: 0, y: S.editorImage.height }
        ];
        drawEditorCrop();
    });

    el('scanner-rotate-btn').addEventListener('click', async () => {
        const page = findPage(S.editingPageId);
        if (!page) return;
        page.rotation = (page.rotation + 90) % 360;
        if (editorTab === 'adjust') schedulePreview(0);
        else toast('Rotation applied — see it in the Adjust tab.');
    });

    el('scanner-editor-cancel').addEventListener('click', () => {
        S.previewToken++;
        showScreen(S.doc.pages.length ? 'pages' : 'camera');
        if (!S.doc.pages.length) startCamera();
    });
    el('scanner-editor-apply').addEventListener('click', applyEditor);

    // --- page manager ---
    el('scanner-pages-grid').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const { action, pageId } = btn.dataset;
        if (action === 'edit') openEditor(pageId);
        else if (action === 'up') movePage(pageId, -1);
        else if (action === 'down') movePage(pageId, 1);
        else if (action === 'rotate') rotatePage(pageId);
        else if (action === 'delete') deletePage(pageId);
    });

    el('scanner-add-page-btn').addEventListener('click', () => openCamera());
    el('scanner-export-pdf-btn').addEventListener('click', openExportSheet);
    el('scanner-ocr-btn').addEventListener('click', openOcrSheet);

    // --- export sheet ---
    el('scanner-export-close').addEventListener('click', () => showScreen('pages'));
    el('scanner-save-pdf').addEventListener('click', () => exportPdf(false));
    el('scanner-share-btn').addEventListener('click', () => exportPdf(true));
    el('scanner-save-jpg').addEventListener('click', exportImages);

    // --- OCR sheet ---
    el('scanner-ocr-close').addEventListener('click', () => showScreen('pages'));
    el('scanner-ocr-lang').addEventListener('change', updateOcrNote);
    el('scanner-ocr-start').addEventListener('click', runOcr);
    el('scanner-ocr-to-word').addEventListener('click', sendOcrToWord);
    el('scanner-ocr-copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(el('scanner-ocr-result').value);
            toast('Text copied.');
        } catch (_) {
            // Clipboard API needs a secure context and a user gesture; selecting
            // the text is the reliable fallback.
            el('scanner-ocr-result').select();
            toast('Press and hold to copy the selected text.');
        }
    });
    el('scanner-ocr-download').addEventListener('click', () => {
        const title = el('scanner-doc-title').value.trim() || 'scan';
        ocr.downloadText(el('scanner-ocr-result').value, safeFileName(title, 'txt'));
    });

    // Escape and the Android back gesture should step back one screen, not throw
    // the whole document away.
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
}

function updateAutoButton() {
    const btn = el('scanner-auto-btn');
    if (!btn) return;
    btn.classList.toggle('bg-indigo-600', S.autoCapture);
    btn.classList.toggle('bg-black/55', !S.autoCapture);
    btn.classList.toggle('text-gray-400', !S.autoCapture);
}

function onKeyDown(e) {
    if (e.key !== 'Escape' || !el('scanner-modal')) return;
    if (S.screen === 'export' || S.screen === 'ocr') showScreen('pages');
    else if (S.screen === 'editor') el('scanner-editor-cancel').click();
    else closeScanner();
}

function onPageHide() {
    // Releasing the camera here prevents a stuck green indicator when the user
    // switches apps on Android.
    stopCamera();
    if (S.doc) store.saveDoc(S.doc).catch(() => {});
}

function onVisibilityChange() {
    if (document.hidden) stopCamera();
    else if (S.screen === 'camera' && el('scanner-modal')) startCamera();
}

/* ================================================================== */
/* Compatibility exports                                               */
/* ================================================================== */

// The previous module exposed these directly and other parts of the app may
// still call them. They now delegate to the current implementation.
export function capturePhotoLegacy() { return capturePhoto(); }
export function shareDocument() { openExportSheet(); return { success: true }; }
export function exportPDF() { openExportSheet(); return { success: true }; }
export function closeScannerEditor() { return closeScanner(); }

export default { init };


