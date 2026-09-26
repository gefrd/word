// src/modules/tools/bgremover.js
// Kivu Super App — Background Removal & Photo Editor Tool
// Features: AI Neural Cutout (@imgly/background-removal) + Manual Tools (Brush, Eraser, Lasso, Wand, Box)

// ═══════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════
const MAX_DIM = 1200;
const THUMB_DIM = 320;
const MAX_UNDO = 20;

// ═══════════════════════════════════════════════════════════════
//  MODULE STATE
// ═══════════════════════════════════════════════════════════════
let docId = null;
let originalImage = null;
let originalFileName = 'image.png';

// Canvas buffers
let W = 0, H = 0;
let imgCanvas = null, imgCtx = null;       // Original RGB image
let maskCanvas = null, maskCtx = null;     // Alpha mask (alpha 255=keep, 0=remove)
let compCanvas = null, compCtx = null;     // Persistent compositing buffer
let overlayCanvas = null, overlayCtx = null; // Persistent mask overlay buffer
let dispCanvas = null, dispCtx = null;     // Display (DOM visible) canvas

// Viewport
let zoom = 1, minZoom = 0.1, maxZoom = 5;
let panX = 0, panY = 0;
let isPanning = false, panStartX = 0, panStartY = 0;
let lastPinchDist = 0;

// Tools: 'auto' | 'brush' | 'eraser' | 'lasso' | 'wand' | 'box'
let activeTool = 'auto';
let brushSize = 24;
let showMaskOverlay = false;
let wandTolerance = 30;
let wandContiguous = true;

// Drawing state
let isDrawing = false;
let lastPt = null;
let lassoPoints = [];
let boxStart = null, boxCur = null;

// BG preset: 'transparent' | '#ffffff' | '#0077c8' | '#f3f4f6' | '#111827' | 'blur' | custom hex
let bgMode = 'transparent';

let isComparing = false;
let isAIBusy = false;

// History
let undoStack = [];
let redoStack = [];

// Event cleanup
let abortCtrl = null;

// AI module cache
let _aiModule = null;

// Render scheduling
let renderPending = false;

// ═══════════════════════════════════════════════════════════════
//  ENTRY POINT
// ═══════════════════════════════════════════════════════════════
export async function init(id = null) {
    cleanup();
    docId = id;
    abortCtrl = new AbortController();
    renderUI();
    if (id) {
        loadDocument(id);
    }
}

function cleanup() {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = null;
    originalImage = null;
    imgCanvas = imgCtx = null;
    maskCanvas = maskCtx = null;
    compCanvas = compCtx = null;
    overlayCanvas = overlayCtx = null;
    dispCanvas = dispCtx = null;
    undoStack = [];
    redoStack = [];
    lassoPoints = [];
    isDrawing = false;
    isPanning = false;
    isComparing = false;
    isAIBusy = false;
    renderPending = false;
    docId = null;
    activeTool = 'auto';
    bgMode = 'transparent';
    showMaskOverlay = false;
    zoom = 1;
    panX = panY = 0;
}

// ═══════════════════════════════════════════════════════════════
//  UI RENDERING
// ═══════════════════════════════════════════════════════════════
function renderUI() {
    let c = document.getElementById('bgremover-container') || document.getElementById('bgrem-root');
    if (!c) {
        c = document.createElement('div');
        c.id = 'bgremover-container';
        document.body.appendChild(c);
    }
    c.className = 'bgrem-root';
    c.style.cssText = `position:fixed;inset:0;width:100vw;height:100vh;z-index:99999;display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#fff;touch-action:none;overscroll-behavior:none;`;

    c.innerHTML = `
        <!-- HEADER -->
        <header id="bgrem-header" style="height:52px;min-height:52px;background:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 10px;border-bottom:1px solid #e5e7eb;box-sizing:border-box;gap:6px;width:100%;">
            <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;overflow:hidden;">
                <button id="bgrem-back" style="width:34px;height:34px;min-width:34px;border:none;background:none;cursor:pointer;font-size:16px;color:#374151;display:flex;align-items:center;justify-content:center;border-radius:50%;flex-shrink:0;" title="Back">
                    <i class="fas fa-arrow-left"></i>
                </button>
                <div style="min-width:0;flex:1;overflow:hidden;">
                    <div style="font-size:14px;font-weight:700;color:#111827;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Photo Editor</div>
                    <div id="bgrem-filename" style="font-size:10px;color:#9ca3af;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${originalFileName}</div>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
                <button id="bgrem-undo-btn" disabled style="width:32px;height:32px;min-width:32px;border:none;background:none;cursor:pointer;font-size:14px;color:#9ca3af;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;" title="Undo"><i class="fas fa-undo"></i></button>
                <button id="bgrem-redo-btn" disabled style="width:32px;height:32px;min-width:32px;border:none;background:none;cursor:pointer;font-size:14px;color:#9ca3af;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;" title="Redo"><i class="fas fa-redo"></i></button>
                <button id="bgrem-compare" style="display:none;width:32px;height:32px;min-width:32px;border:1px solid #d1d5db;background:#f3f4f6;border-radius:8px;font-size:13px;font-weight:600;color:#4b5563;cursor:pointer;align-items:center;justify-content:center;flex-shrink:0;user-select:none;-webkit-user-select:none;" title="Hold to see original"><i class="fas fa-eye"></i></button>
                <button id="bgrem-save" style="display:none;padding:5px 12px;border:none;background:#10b981;color:#fff;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;align-items:center;justify-content:center;gap:4px;flex-shrink:0;" title="Save"><i class="fas fa-save"></i><span>Save</span></button>
            </div>
        </header>

        <!-- MAIN AREA -->
        <div style="flex:1;display:flex;flex-direction:column;min-height:0;position:relative;background:#f8fafc;">

            <!-- PICKER VIEW -->
            <div id="bgrem-picker" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:16px;">
                <div style="width:72px;height:72px;border-radius:20px;display:flex;align-items:center;justify-content:center;font-size:28px;background:linear-gradient(135deg,#ede9fe,#ddd6fe);color:#7c3aed;box-shadow:0 4px 12px rgba(124,58,237,0.15);">
                    <i class="fas fa-wand-magic-sparkles"></i>
                </div>
                <div style="text-align:center;max-width:280px;">
                    <h2 style="margin:0;font-size:20px;font-weight:700;color:#111827;">Remove Background</h2>
                    <p style="margin:6px 0 0;font-size:13px;color:#6b7280;line-height:1.4;">Upload a photo and AI will remove the background. Refine with manual tools.</p>
                </div>
                <div style="display:flex;flex-direction:column;width:100%;max-width:300px;gap:10px;margin-top:8px;">
                    <button id="bgrem-camera-btn" style="width:100%;padding:14px;border:none;border-radius:14px;font-size:15px;font-weight:700;color:#fff;background:linear-gradient(135deg,#7c3aed,#6d28d9);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 12px rgba(124,58,237,0.3);">
                        <i class="fas fa-camera"></i> Take Photo
                    </button>
                    <button id="bgrem-gallery-btn" style="width:100%;padding:14px;border:1px solid #d1d5db;border-radius:14px;font-size:15px;font-weight:700;color:#374151;background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">
                        <i class="fas fa-images" style="color:#7c3aed;"></i> Choose from Gallery
                    </button>
                    <button id="bgrem-demo-btn" style="width:100%;padding:12px;border:1px dashed #a855f7;border-radius:14px;font-size:13px;font-weight:600;color:#7c3aed;background:rgba(147,51,234,0.06);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
                        <i class="fas fa-flask"></i> Try Demo Photo
                    </button>
                </div>
                <input type="file" id="bgrem-cam-input" accept="image/*" capture="environment" style="display:none;">
                <input type="file" id="bgrem-file-input" accept="image/*" style="display:none;">
            </div>

            <!-- STUDIO WORKSPACE -->
            <div id="bgrem-studio" style="display:none;flex:1;flex-direction:column;min-height:0;">

                <!-- CANVAS AREA -->
                <div id="bgrem-canvas-wrap" style="flex:1;position:relative;overflow:hidden;touch-action:none;min-height:0;background:#0f1118;background-image:linear-gradient(45deg,#1a1e2e 25%,transparent 25%,transparent 75%,#1a1e2e 75%),linear-gradient(45deg,#1a1e2e 25%,transparent 25%,transparent 75%,#1a1e2e 75%);background-size:20px 20px;background-position:0 0,10px 10px;">
                    <canvas id="bgrem-canvas" style="position:absolute;display:block;transform-origin:0 0;"></canvas>
                    <svg id="bgrem-svg" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;">
                        <polyline id="bgrem-poly" points="" fill="rgba(168,85,247,0.2)" stroke="#a855f7" stroke-width="2" stroke-dasharray="5,3"/>
                    </svg>
                    <div id="bgrem-cursor" style="position:absolute;pointer-events:none;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.4);display:none;z-index:3;transform:translate(-50%,-50%);"></div>

                    <!-- ZOOM HUD -->
                    <div style="position:absolute;bottom:12px;right:12px;display:flex;align-items:center;gap:2px;padding:3px;border-radius:10px;background:rgba(15,23,42,0.85);backdrop-filter:blur(8px);border:1px solid rgba(51,65,85,0.7);z-index:5;">
                        <button id="bgrem-zoom-out" style="width:28px;height:28px;border:none;background:none;color:#cbd5e1;cursor:pointer;font-size:11px;border-radius:6px;display:flex;align-items:center;justify-content:center;" title="Zoom out"><i class="fas fa-minus"></i></button>
                        <button id="bgrem-zoom-reset" style="min-width:42px;height:28px;border:none;background:none;color:#e2e8f0;cursor:pointer;font-size:11px;font-weight:700;border-radius:6px;" title="Fit"><span id="bgrem-zlabel">100%</span></button>
                        <button id="bgrem-zoom-in" style="width:28px;height:28px;border:none;background:none;color:#cbd5e1;cursor:pointer;font-size:11px;border-radius:6px;display:flex;align-items:center;justify-content:center;" title="Zoom in"><i class="fas fa-plus"></i></button>
                    </div>

                    <!-- LOADING OVERLAY -->
                    <div id="bgrem-loading" style="display:none;position:absolute;inset:0;background:rgba(11,15,25,0.88);backdrop-filter:blur(8px);flex-direction:column;align-items:center;justify-content:center;z-index:10;padding:24px;text-align:center;">
                        <div style="width:48px;height:48px;border:4px solid rgba(168,85,247,0.2);border-top-color:#a855f7;border-radius:50%;animation:bgrem-spin 0.8s linear infinite;margin-bottom:12px;"></div>
                        <div id="bgrem-load-text" style="font-size:14px;font-weight:700;color:#f1f5f9;">Processing...</div>
                        <div id="bgrem-load-sub" style="font-size:12px;color:#94a3b8;margin-top:4px;"></div>
                        <div style="width:200px;height:6px;background:#1e293b;border-radius:3px;margin-top:12px;overflow:hidden;">
                            <div id="bgrem-load-bar" style="width:0%;height:100%;background:linear-gradient(90deg,#7c3aed,#a855f7);border-radius:3px;transition:width 0.3s ease;"></div>
                        </div>
                    </div>
                </div>

                <!-- SUBBAR (tool options) -->
                <div id="bgrem-subbar" style="min-height:44px;padding:0 12px;display:flex;align-items:center;background:#111827;border-top:1px solid #1e293b;overflow-x:auto;gap:8px;box-sizing:border-box;"></div>

                <!-- BACKGROUND PRESETS -->
                <div id="bgrem-bgstrip" style="padding:6px 12px;display:flex;align-items:center;gap:6px;background:#0f172a;border-top:1px solid rgba(30,41,59,0.6);overflow-x:auto;box-sizing:border-box;">
                    <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;white-space:nowrap;padding-right:4px;">BG:</span>
                </div>

                <!-- TOOL TABS -->
                <div id="bgrem-tools" style="display:grid;grid-template-columns:repeat(6,1fr);gap:4px;padding:6px 8px;background:#0b0f19;border-top:1px solid #1e293b;box-sizing:border-box;"></div>

                <!-- EXPORT BAR -->
                <div id="bgrem-export" style="padding:10px 12px;display:flex;gap:8px;background:#0b0f19;border-top:1px solid #1e293b;box-sizing:border-box;padding-bottom:max(10px,env(safe-area-inset-bottom));">
                    <button id="bgrem-new-btn" style="width:46px;padding:12px 0;border-radius:14px;border:1px solid #334155;background:#1e293b;color:#94a3b8;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:15px;" title="New photo"><i class="fas fa-arrow-rotate-left"></i></button>
                    <button id="bgrem-share-btn" style="flex:1;padding:12px;border-radius:14px;border:none;background:#0d9488;color:#fff;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;box-shadow:0 3px 10px rgba(13,148,136,0.3);"><i class="fas fa-share-nodes"></i> Share</button>
                    <button id="bgrem-download-btn" style="flex:1;padding:12px;border-radius:14px;border:none;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;box-shadow:0 3px 10px rgba(124,58,237,0.35);"><i class="fas fa-download"></i> Download</button>
                </div>
            </div>
        </div>

        <style>
            @keyframes bgrem-spin { to { transform: rotate(360deg); } }
            #bgremover-container *, #bgrem-root * { -webkit-tap-highlight-color: transparent; }
            #bgremover-container button:active, #bgrem-root button:active { opacity: 0.8; transform: scale(0.96); }
            #bgremover-container input[type=range], #bgrem-root input[type=range] { height: 4px; }
        </style>
    `;

    buildBgPresets();
    buildToolTabs();
    bindEvents();
}

// ═══════════════════════════════════════════════════════════════
//  BUILD DYNAMIC UI SECTIONS
// ═══════════════════════════════════════════════════════════════
const BG_PRESETS = [
    { key: 'transparent', label: 'Clear', css: 'none', dot: 'background-image:linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%);background-size:8px 8px;background-position:0 0,4px 4px;background-color:#fff;' },
    { key: '#ffffff', label: 'White', css: '#fff', dot: 'background:#fff;' },
    { key: '#0077c8', label: 'ID Blue', css: '#0077c8', dot: 'background:#0077c8;' },
    { key: '#f3f4f6', label: 'Studio', css: '#f3f4f6', dot: 'background:#f3f4f6;' },
    { key: '#111827', label: 'Black', css: '#111827', dot: 'background:#111827;border:1px solid #4b5563;' },
    { key: 'blur', label: 'Blur', css: 'none', dot: 'background:#6b7280;' },
];

function buildBgPresets() {
    const strip = document.getElementById('bgrem-bgstrip');
    if (!strip) return;
    // Keep the "BG:" label, add presets
    BG_PRESETS.forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'bgrem-bg-btn bg-preset-btn';
        btn.dataset.bg = p.key;
        btn.style.cssText = `flex-shrink:0;display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:10px;border:${bgMode === p.key ? '2px solid #a855f7' : '1px solid #334155'};background:#1e293b;color:#e2e8f0;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;`;
        btn.innerHTML = `<div style="width:14px;height:14px;border-radius:50%;${p.dot}"></div><span>${p.label}</span>`;
        strip.appendChild(btn);
    });

    // Custom color picker
    const lbl = document.createElement('label');
    lbl.className = 'bgrem-bg-btn bg-preset-btn';
    lbl.style.cssText = `flex-shrink:0;display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;`;
    lbl.innerHTML = `<div style="width:14px;height:14px;border-radius:50%;background:linear-gradient(135deg,#ec4899,#eab308,#06b6d4);"></div><span>Custom</span><input type="color" id="bgrem-custom-color" value="#a855f7" style="display:none;">`;
    strip.appendChild(lbl);
}

const TOOLS = [
    { id: 'auto', icon: 'fa-wand-magic-sparkles', label: 'Auto AI' },
    { id: 'brush', icon: 'fa-paintbrush', label: 'Restore' },
    { id: 'eraser', icon: 'fa-eraser', label: 'Erase' },
    { id: 'lasso', icon: 'fa-draw-polygon', label: 'Lasso' },
    { id: 'wand', icon: 'fa-wand-magic', label: 'Wand' },
    { id: 'rect', icon: 'fa-crop-simple', label: 'Box' },
];

function buildToolTabs() {
    const bar = document.getElementById('bgrem-tools');
    if (!bar) return;
    TOOLS.forEach(t => {
        const btn = document.createElement('button');
        btn.className = 'bgrem-tool-tab';
        btn.dataset.tool = t.id;
        const isActive = activeTool === t.id || (activeTool === 'box' && t.id === 'rect');
        btn.style.cssText = `display:flex;flex-direction:column;align-items:center;justify-content:center;padding:6px 2px;border-radius:10px;border:${isActive ? '1px solid rgba(168,85,247,0.5)' : '1px solid transparent'};background:${isActive ? 'rgba(147,51,234,0.2)' : 'transparent'};color:${isActive ? '#c084fc' : '#94a3b8'};cursor:pointer;`;
        btn.innerHTML = `<i class="fas ${t.icon}" style="font-size:14px;margin-bottom:2px;"></i><span style="font-size:10px;font-weight:700;line-height:1;">${t.label}</span>`;
        bar.appendChild(btn);
    });
}

// ═══════════════════════════════════════════════════════════════
//  EVENT BINDING
// ═══════════════════════════════════════════════════════════════
function bindEvents() {
    const sig = { signal: abortCtrl.signal };

    // Header
    const backBtn = el('bgrem-back');
    if (backBtn) {
        backBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeTool();
        }, sig);
    }
    (el('bgrem-undo-btn') || el('bgrem-undo'))?.addEventListener('click', doUndo, sig);
    (el('bgrem-redo-btn') || el('bgrem-redo'))?.addEventListener('click', doRedo, sig);
    el('bgrem-save')?.addEventListener('click', saveDocument, sig);

    // Picker
    el('bgrem-camera-btn')?.addEventListener('click', () => el('bgrem-cam-input')?.click(), sig);
    el('bgrem-gallery-btn')?.addEventListener('click', () => el('bgrem-file-input')?.click(), sig);
    el('bgrem-demo-btn')?.addEventListener('click', loadDemoPhoto, sig);

    el('bgrem-cam-input')?.addEventListener('change', handleFile, sig);
    el('bgrem-file-input')?.addEventListener('change', handleFile, sig);

    // Compare (hold)
    const cmp = el('bgrem-compare');
    if (cmp) {
        const startCmp = (e) => {
            e?.preventDefault();
            isComparing = true;
            cmp.style.background = '#ede9fe';
            cmp.style.color = '#7c3aed';
            cmp.style.borderColor = '#a855f7';
            scheduleRender();
        };
        const endCmp = (e) => {
            e?.preventDefault();
            isComparing = false;
            cmp.style.background = '#f3f4f6';
            cmp.style.color = '#4b5563';
            cmp.style.borderColor = '#d1d5db';
            scheduleRender();
        };
        cmp.addEventListener('mousedown', startCmp, sig);
        cmp.addEventListener('mouseup', endCmp, sig);
        cmp.addEventListener('mouseleave', endCmp, sig);
        cmp.addEventListener('touchstart', startCmp, { ...sig, passive: false });
        cmp.addEventListener('touchend', endCmp, sig);
        cmp.addEventListener('touchcancel', endCmp, sig);
    }

    // Zoom HUD
    (el('bgrem-zoom-in') || el('bgrem-zin'))?.addEventListener('click', () => adjustZoom(1.25), sig);
    (el('bgrem-zoom-out') || el('bgrem-zout'))?.addEventListener('click', () => adjustZoom(0.8), sig);
    (el('bgrem-zoom-reset') || el('bgrem-zreset'))?.addEventListener('click', fitView, sig);

    // Export bar
    el('bgrem-new-btn')?.addEventListener('click', resetToStart, sig);
    el('bgrem-share-btn')?.addEventListener('click', handleShare, sig);
    (el('bgrem-download-btn') || el('bgrem-dl-btn'))?.addEventListener('click', handleDownload, sig);

    // Tool tabs
    document.querySelectorAll('.bgrem-tool-tab').forEach(tab => {
        tab.addEventListener('click', () => switchTool(tab.dataset.tool), sig);
    });

    // BG presets
    document.querySelectorAll('.bgrem-bg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!btn.dataset.bg) return;
            bgMode = btn.dataset.bg;
            updateBgHighlight();
            scheduleRender();
        }, sig);
    });

    el('bgrem-custom-color')?.addEventListener('input', (e) => {
        bgMode = e.target.value;
        updateBgHighlight();
        scheduleRender();
    }, sig);

    // Canvas interactions
    const wrap = el('bgrem-canvas-wrap');
    if (wrap) {
        wrap.addEventListener('mousedown', onPointerDown, sig);
        window.addEventListener('mousemove', onPointerMove, sig);
        window.addEventListener('mouseup', onPointerUp, sig);

        wrap.addEventListener('touchstart', onTouchStart, { ...sig, passive: false });
        window.addEventListener('touchmove', onTouchMove, { ...sig, passive: false });
        window.addEventListener('touchend', onTouchEnd, sig);
        window.addEventListener('touchcancel', onTouchEnd, sig);

        wrap.addEventListener('wheel', onWheel, { ...sig, passive: false });
    }
}

function el(id) { return document.getElementById(id); }

function updateBgHighlight() {
    document.querySelectorAll('.bgrem-bg-btn').forEach(b => {
        const k = b.dataset.bg;
        b.style.border = k === bgMode ? '2px solid #a855f7' : '1px solid #334155';
    });
}

// ═══════════════════════════════════════════════════════════════
//  TOOL SWITCHING
// ═══════════════════════════════════════════════════════════════
function switchTool(tool) {
    activeTool = tool;
    if (navigator.vibrate) navigator.vibrate(8);

    // Update tab styles
    document.querySelectorAll('.bgrem-tool-tab').forEach(tab => {
        const t = tab.dataset.tool;
        const isActive = t === tool;
        tab.style.background = isActive ? 'rgba(147,51,234,0.2)' : 'transparent';
        tab.style.border = isActive ? '1px solid rgba(168,85,247,0.5)' : '1px solid transparent';
        tab.style.color = isActive ? '#c084fc' : '#94a3b8';
    });

    // Update subbar
    buildSubbar();

    // Show/hide brush cursor
    const cursor = el('bgrem-cursor');
    if (cursor) cursor.style.display = (tool === 'brush' || tool === 'eraser') ? 'none' : 'none';

    scheduleRender();
}

function buildSubbar() {
    const sub = el('bgrem-subbar');
    if (!sub) return;
    sub.innerHTML = '';

    if (activeTool === 'auto') {
        sub.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;width:100%;">
                <button id="bgrem-run-ai" style="padding:5px 12px;border-radius:8px;border:none;background:#7c3aed;color:#fff;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:4px;">
                    <i class="fas fa-wand-magic-sparkles"></i> Run AI
                </button>
                <button id="bgrem-reset-mask" style="padding:5px 10px;border-radius:8px;border:1px solid #334155;background:transparent;color:#cbd5e1;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">Reset</button>
                <button id="bgrem-invert-mask" style="padding:5px 10px;border-radius:8px;border:1px solid #334155;background:transparent;color:#cbd5e1;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">Invert</button>
            </div>`;
        el('bgrem-run-ai')?.addEventListener('click', runAI);
        el('bgrem-reset-mask')?.addEventListener('click', resetMask);
        el('bgrem-invert-mask')?.addEventListener('click', invertMask);

    } else if (activeTool === 'brush' || activeTool === 'eraser') {
        const col = activeTool === 'brush' ? '#10b981' : '#ef4444';
        sub.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;width:100%;">
                <i class="fas fa-circle" style="font-size:6px;color:#64748b;"></i>
                <input type="range" id="bgrem-bsize" min="2" max="80" value="${brushSize}" style="flex:1;accent-color:${col};cursor:pointer;height:4px;">
                <i class="fas fa-circle" style="font-size:16px;color:#64748b;"></i>
                <span id="bgrem-bsize-val" style="font-size:11px;font-weight:700;color:#cbd5e1;width:30px;text-align:right;">${brushSize}px</span>
                <div style="width:1px;height:20px;background:#334155;margin:0 2px;"></div>
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:#cbd5e1;cursor:pointer;white-space:nowrap;">
                    <input type="checkbox" id="bgrem-mask-toggle" ${showMaskOverlay ? 'checked' : ''} style="accent-color:#a855f7;"> Mask
                </label>
            </div>`;
        el('bgrem-bsize')?.addEventListener('input', (e) => {
            brushSize = parseInt(e.target.value);
            const v = el('bgrem-bsize-val');
            if (v) v.textContent = brushSize + 'px';
        });
        el('bgrem-mask-toggle')?.addEventListener('change', (e) => {
            showMaskOverlay = e.target.checked;
            scheduleRender();
        });

    } else if (activeTool === 'lasso') {
        sub.innerHTML = `<div style="display:flex;align-items:center;gap:8px;width:100%;color:#cbd5e1;font-size:12px;font-weight:600;">
            <i class="fas fa-draw-polygon" style="color:#a855f7;"></i> Draw outline around object to erase outside. Release to apply.
        </div>`;

    } else if (activeTool === 'wand') {
        sub.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;width:100%;">
                <span style="font-size:11px;font-weight:600;color:#94a3b8;white-space:nowrap;">Tolerance:</span>
                <input type="range" id="bgrem-wtol" min="5" max="90" value="${wandTolerance}" style="flex:1;accent-color:#a855f7;cursor:pointer;height:4px;">
                <span id="bgrem-wtol-val" style="font-size:11px;font-weight:700;color:#cbd5e1;width:24px;text-align:right;">${wandTolerance}</span>
                <label style="display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:#cbd5e1;cursor:pointer;white-space:nowrap;">
                    <input type="checkbox" id="bgrem-wcontig" ${wandContiguous ? 'checked' : ''} style="accent-color:#a855f7;"> Flood
                </label>
            </div>`;
        el('bgrem-wtol')?.addEventListener('input', (e) => {
            wandTolerance = parseInt(e.target.value);
            const v = el('bgrem-wtol-val');
            if (v) v.textContent = wandTolerance;
        });
        el('bgrem-wcontig')?.addEventListener('change', (e) => { wandContiguous = e.target.checked; });

    } else if (activeTool === 'box') {
        sub.innerHTML = `<div style="display:flex;align-items:center;gap:8px;width:100%;color:#cbd5e1;font-size:12px;font-weight:600;">
            <i class="fas fa-crop-simple" style="color:#a855f7;"></i> Drag rectangle around subject. Everything outside is removed.
        </div>`;
    }
}

// ═══════════════════════════════════════════════════════════════
//  FILE HANDLING
// ═══════════════════════════════════════════════════════════════
function handleFile(e) {
    const file = e.target?.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    originalFileName = file.name || 'image.png';
    loadImageFromFile(file);
    e.target.value = '';
}

function loadImageFromFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => initImageCanvas(img);
        img.onerror = () => { if (window.showToast) window.showToast('Failed to load image.', true); };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function loadDemoPhoto() {
    originalFileName = 'demo_product.png';
    const cv = document.createElement('canvas');
    cv.width = 640; cv.height = 640;
    const ctx = cv.getContext('2d');

    // Background gradient
    const bg = ctx.createLinearGradient(0, 0, 640, 640);
    bg.addColorStop(0, '#0284c7');
    bg.addColorStop(1, '#0369a1');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 640, 640);

    // Floor shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(320, 490, 180, 40, 0, 0, Math.PI * 2);
    ctx.fill();

    // Sole
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(190, 430, 260, 50, 20);
    ctx.fill();
    ctx.fillStyle = '#e11d48';
    ctx.fillRect(200, 465, 240, 15);

    // Upper
    ctx.fillStyle = '#1e1b4b';
    ctx.beginPath();
    ctx.moveTo(200, 430);
    ctx.lineTo(220, 310);
    ctx.lineTo(310, 310);
    ctx.lineTo(380, 370);
    ctx.lineTo(440, 430);
    ctx.closePath();
    ctx.fill();

    // Swoosh
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(240, 380);
    ctx.quadraticCurveTo(320, 420, 410, 360);
    ctx.quadraticCurveTo(320, 390, 240, 380);
    ctx.fill();

    // Collar
    ctx.fillStyle = '#fb7185';
    ctx.beginPath();
    ctx.ellipse(265, 310, 45, 20, -0.2, 0, Math.PI * 2);
    ctx.fill();

    const img = new Image();
    img.onload = () => initImageCanvas(img);
    img.src = cv.toDataURL('image/png');
}

// ═══════════════════════════════════════════════════════════════
//  IMAGE & CANVAS INITIALIZATION
// ═══════════════════════════════════════════════════════════════
function initImageCanvas(img) {
    originalImage = img;

    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (w > MAX_DIM || h > MAX_DIM) {
        if (w > h) { h = Math.round((h * MAX_DIM) / w); w = MAX_DIM; }
        else { w = Math.round((w * MAX_DIM) / h); h = MAX_DIM; }
    }
    W = w; H = h;

    // Original image canvas
    imgCanvas = document.createElement('canvas');
    imgCanvas.width = W; imgCanvas.height = H;
    imgCtx = imgCanvas.getContext('2d', { willReadFrequently: true });
    imgCtx.drawImage(img, 0, 0, W, H);

    // Mask canvas (white = keep all)
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = W; maskCanvas.height = H;
    maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    maskCtx.fillStyle = '#ffffff';
    maskCtx.fillRect(0, 0, W, H);

    // Pre-allocated compositing canvas
    compCanvas = document.createElement('canvas');
    compCanvas.width = W; compCanvas.height = H;
    compCtx = compCanvas.getContext('2d');

    // Pre-allocated mask overlay canvas
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = W; overlayCanvas.height = H;
    overlayCtx = overlayCanvas.getContext('2d');

    // Display canvas (DOM element)
    dispCanvas = el('bgrem-canvas');
    dispCanvas.width = W; dispCanvas.height = H;
    dispCtx = dispCanvas.getContext('2d');

    // Clear history
    undoStack = [];
    redoStack = [];

    // Show studio, hide picker
    el('bgrem-picker').style.display = 'none';
    const studio = el('bgrem-studio');
    studio.style.display = 'flex';

    // Show header actions
    el('bgrem-save').style.display = 'inline-flex';
    el('bgrem-compare').style.display = 'inline-flex';

    // Update filename display
    const fnEl = el('bgrem-filename');
    if (fnEl) fnEl.textContent = originalFileName;

    fitView();
    switchTool('auto');

    // Auto-run AI
    runAI();
}

// ═══════════════════════════════════════════════════════════════
//  VIEWPORT (ZOOM / PAN)
// ═══════════════════════════════════════════════════════════════
function fitView() {
    const wrap = el('bgrem-canvas-wrap');
    if (!wrap || !W || !H) return;
    const ww = wrap.clientWidth - 24;
    const wh = wrap.clientHeight - 24;
    if (ww <= 0 || wh <= 0) return;

    zoom = Math.min(ww / W, wh / H, 1);
    minZoom = Math.min(zoom * 0.3, 0.1);

    // Center the image
    panX = (wrap.clientWidth - W * zoom) / 2;
    panY = (wrap.clientHeight - H * zoom) / 2;

    applyTransform();
}

function adjustZoom(factor) {
    const wrap = el('bgrem-canvas-wrap');
    if (!wrap) return;
    const cx = wrap.clientWidth / 2;
    const cy = wrap.clientHeight / 2;
    zoomAt(factor, cx, cy);
}

function zoomAt(factor, cx, cy) {
    const oldZoom = zoom;
    zoom = Math.max(minZoom, Math.min(maxZoom, zoom * factor));
    const ratio = zoom / oldZoom;
    panX = cx - (cx - panX) * ratio;
    panY = cy - (cy - panY) * ratio;
    applyTransform();
}

function applyTransform() {
    if (!dispCanvas) return;
    dispCanvas.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
    const lbl = el('bgrem-zlabel');
    if (lbl) lbl.textContent = Math.round(zoom * 100) + '%';
}

// ═══════════════════════════════════════════════════════════════
//  RENDER ENGINE (requestAnimationFrame scheduled)
// ═══════════════════════════════════════════════════════════════
function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(doRender);
}

function doRender() {
    renderPending = false;
    if (!dispCtx || !imgCanvas || !maskCanvas || !compCanvas) return;

    compCtx.clearRect(0, 0, W, H);

    if (isComparing) {
        // Show original image
        compCtx.drawImage(imgCanvas, 0, 0);
    } else {
        // 1. Draw background
        if (bgMode === 'transparent') {
            // Transparent - leave clear (checkerboard shows through)
        } else if (bgMode === 'blur') {
            compCtx.save();
            compCtx.filter = 'blur(18px)';
            compCtx.drawImage(imgCanvas, -20, -20, W + 40, H + 40);
            compCtx.restore();
        } else {
            compCtx.fillStyle = bgMode;
            compCtx.fillRect(0, 0, W, H);
        }

        // 2. Composite: image masked by mask
        // Use the pre-allocated overlay canvas as scratch for compositing
        overlayCtx.clearRect(0, 0, W, H);
        overlayCtx.globalCompositeOperation = 'source-over';
        overlayCtx.drawImage(imgCanvas, 0, 0);
        overlayCtx.globalCompositeOperation = 'destination-in';
        overlayCtx.drawImage(maskCanvas, 0, 0);

        compCtx.drawImage(overlayCanvas, 0, 0);

        // 3. Mask overlay (red tint on removed areas) when brush/eraser active
        if (showMaskOverlay && (activeTool === 'brush' || activeTool === 'eraser')) {
            overlayCtx.clearRect(0, 0, W, H);
            overlayCtx.globalCompositeOperation = 'source-over';
            overlayCtx.fillStyle = 'rgba(239, 68, 68, 0.35)';
            overlayCtx.fillRect(0, 0, W, H);
            overlayCtx.globalCompositeOperation = 'destination-out';
            overlayCtx.drawImage(maskCanvas, 0, 0);

            compCtx.drawImage(overlayCanvas, 0, 0);
        }
    }

    // Copy composite to display
    dispCtx.clearRect(0, 0, W, H);
    dispCtx.drawImage(compCanvas, 0, 0);

    // Update undo/redo buttons
    updateUndoRedoBtns();
}

// ═══════════════════════════════════════════════════════════════
//  UNDO / REDO
// ═══════════════════════════════════════════════════════════════
function saveUndoSnap() {
    if (!maskCtx) return;
    undoStack.push(maskCtx.getImageData(0, 0, W, H));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
    updateUndoRedoBtns();
}

function doUndo() {
    if (!undoStack.length || !maskCtx) return;
    redoStack.push(maskCtx.getImageData(0, 0, W, H));
    maskCtx.putImageData(undoStack.pop(), 0, 0);
    updateUndoRedoBtns();
    scheduleRender();
}

function doRedo() {
    if (!redoStack.length || !maskCtx) return;
    undoStack.push(maskCtx.getImageData(0, 0, W, H));
    maskCtx.putImageData(redoStack.pop(), 0, 0);
    updateUndoRedoBtns();
    scheduleRender();
}

function updateUndoRedoBtns() {
    const u = el('bgrem-undo-btn') || el('bgrem-undo');
    const r = el('bgrem-redo-btn') || el('bgrem-redo');
    if (u) { u.disabled = !undoStack.length; u.style.color = undoStack.length ? '#374151' : '#9ca3af'; }
    if (r) { r.disabled = !redoStack.length; r.style.color = redoStack.length ? '#374151' : '#9ca3af'; }
}

// ═══════════════════════════════════════════════════════════════
//  AI NEURAL BACKGROUND REMOVAL
// ═══════════════════════════════════════════════════════════════
async function runAI() {
    if (!imgCanvas || isAIBusy) return;
    isAIBusy = true;

    showLoading('Loading AI model...', 'First download requires internet (~18MB)');
    saveUndoSnap();

    try {
        // Lazy-load the module
        if (!_aiModule) {
            _aiModule = await import('@imgly/background-removal');
        }

        const removeFn = _aiModule.removeBackground || _aiModule.default?.removeBackground || _aiModule.default;

        if (typeof removeFn !== 'function') {
            throw new Error('AI module loaded but removeBackground function not found');
        }

        updateLoading(10, 'Preparing image for AI...');

        // Scale to tensor-friendly size
        const maxTensor = 768;
        let tw = W, th = H;
        if (tw > maxTensor || th > maxTensor) {
            if (tw > th) { th = Math.round((th * maxTensor) / tw); tw = maxTensor; }
            else { tw = Math.round((tw * maxTensor) / th); th = maxTensor; }
        }
        const tensorCv = document.createElement('canvas');
        tensorCv.width = tw; tensorCv.height = th;
        tensorCv.getContext('2d').drawImage(imgCanvas, 0, 0, tw, th);

        const blob = await new Promise(r => tensorCv.toBlob(r, 'image/jpeg', 0.9));

        const config = {
            model: 'isnet_quint8',
            device: 'gpu',
            rescale: true,
            debug: false,
            progress: (key, current, total) => {
                if (total > 0) {
                    const pct = Math.round((current / total) * 100);
                    if (key && (key.includes('fetch') || key.includes('download'))) {
                        updateLoading(pct * 0.7, `Downloading model: ${pct}%`);
                    } else {
                        updateLoading(70 + pct * 0.3, `Processing: ${pct}%`);
                    }
                }
            },
            output: { format: 'image/png', quality: 1.0 }
        };

        updateLoading(15, 'AI Neural Network processing...');
        const resultBlob = await removeFn(blob, config);

        if (resultBlob) {
            updateLoading(95, 'Applying cutout...');
            await applyAIResult(resultBlob);
        }

        if (window.showToast) window.showToast('Background removed!', false);

    } catch (err) {
        console.warn('[AI Cutout] Error:', err);
        if (window.showToast) {
            window.showToast('AI requires first-time internet. Manual tools available.', true);
        }
    } finally {
        isAIBusy = false;
        hideLoading();
        scheduleRender();
    }
}

async function applyAIResult(blob) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            // Draw result to extract alpha
            const tc = document.createElement('canvas');
            tc.width = W; tc.height = H;
            const tctx = tc.getContext('2d');
            tctx.drawImage(img, 0, 0, W, H);

            const cutoutData = tctx.getImageData(0, 0, W, H);
            const maskData = maskCtx.createImageData(W, H);
            const src = cutoutData.data;
            const dst = maskData.data;

            for (let i = 0; i < src.length; i += 4) {
                const a = src[i + 3]; // Alpha from AI cutout
                dst[i] = 255;     // R
                dst[i + 1] = 255; // G
                dst[i + 2] = 255; // B
                dst[i + 3] = a;   // A = keep/remove
            }

            maskCtx.putImageData(maskData, 0, 0);
            URL.revokeObjectURL(url);
            scheduleRender();
            resolve();
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
        img.src = url;
    });
}

// Mask operations
function resetMask() {
    if (!maskCtx) return;
    saveUndoSnap();
    maskCtx.globalCompositeOperation = 'source-over';
    maskCtx.fillStyle = '#ffffff';
    maskCtx.fillRect(0, 0, W, H);
    scheduleRender();
    if (window.showToast) window.showToast('Mask reset (all kept)', false);
}

function invertMask() {
    if (!maskCtx) return;
    saveUndoSnap();
    const data = maskCtx.getImageData(0, 0, W, H);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
        px[i + 3] = 255 - px[i + 3]; // Invert alpha
    }
    maskCtx.putImageData(data, 0, 0);
    scheduleRender();
    if (window.showToast) window.showToast('Mask inverted', false);
}

// ═══════════════════════════════════════════════════════════════
//  CANVAS INTERACTIONS
// ═══════════════════════════════════════════════════════════════

// Convert screen coords to canvas coords
function screenToCanvas(clientX, clientY) {
    const wrap = el('bgrem-canvas-wrap');
    if (!wrap) return { x: 0, y: 0 };
    const rect = wrap.getBoundingClientRect();
    const x = (clientX - rect.left - panX) / zoom;
    const y = (clientY - rect.top - panY) / zoom;
    return {
        x: Math.max(0, Math.min(W, Math.round(x))),
        y: Math.max(0, Math.min(H, Math.round(y)))
    };
}

// Convert canvas coords to screen coords (relative to wrapper)
function canvasToScreen(cx, cy) {
    const wrap = el('bgrem-canvas-wrap');
    if (!wrap) return { x: 0, y: 0 };
    return {
        x: cx * zoom + panX,
        y: cy * zoom + panY
    };
}

function getTouch(e) {
    if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
}

// --- MOUSE ---
function onPointerDown(e) {
    if (!imgCanvas || isComparing || isAIBusy) return;
    const pt = screenToCanvas(e.clientX, e.clientY);
    handleDown(pt, e.clientX, e.clientY);
}

function onPointerMove(e) {
    if (!imgCanvas) return;
    const pt = screenToCanvas(e.clientX, e.clientY);
    handleMove(pt, e.clientX, e.clientY);
}

function onPointerUp(e) {
    handleUp();
}

// --- TOUCH ---
function onTouchStart(e) {
    if (!imgCanvas || isComparing || isAIBusy) return;
    e.preventDefault();

    if (e.touches.length >= 2) {
        // Pinch/pan start
        isPanning = true;
        isDrawing = false;
        lastPinchDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        panStartX = midX - panX;
        panStartY = midY - panY;
        return;
    }

    const t = getTouch(e);
    const pt = screenToCanvas(t.x, t.y);
    handleDown(pt, t.x, t.y);
}

function onTouchMove(e) {
    if (!imgCanvas) return;
    e.preventDefault();

    if (e.touches.length >= 2) {
        // Pinch zoom + pan
        const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        if (lastPinchDist > 0) {
            const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            const wrap = el('bgrem-canvas-wrap');
            const rect = wrap?.getBoundingClientRect();
            if (rect) {
                const cx = midX - rect.left;
                const cy = midY - rect.top;
                zoomAt(dist / lastPinchDist, cx, cy);
            }
            panX = midX - panStartX;
            panY = midY - panStartY;
            applyTransform();
        }
        lastPinchDist = dist;
        return;
    }

    const t = getTouch(e);
    const pt = screenToCanvas(t.x, t.y);
    handleMove(pt, t.x, t.y);
}

function onTouchEnd(e) {
    if (e.touches && e.touches.length === 0) {
        isPanning = false;
        lastPinchDist = 0;
    }
    handleUp();
}

function onWheel(e) {
    e.preventDefault();
    const wrap = el('bgrem-canvas-wrap');
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.88;
    zoomAt(factor, cx, cy);
}

// --- UNIFIED HANDLERS ---
function handleDown(pt, clientX, clientY) {
    if (activeTool === 'brush' || activeTool === 'eraser') {
        saveUndoSnap();
        isDrawing = true;
        lastPt = pt;
        paintStamp(pt.x, pt.y);
        updateCursor(clientX, clientY);
        scheduleRender();

    } else if (activeTool === 'lasso') {
        saveUndoSnap();
        isDrawing = true;
        lassoPoints = [pt];
        showSVG();

    } else if (activeTool === 'wand') {
        saveUndoSnap();
        applyWand(pt.x, pt.y);

    } else if (activeTool === 'box') {
        saveUndoSnap();
        isDrawing = true;
        boxStart = pt;
        boxCur = pt;
        showSVG();
    }
}

function handleMove(pt, clientX, clientY) {
    if (activeTool === 'brush' || activeTool === 'eraser') {
        updateCursor(clientX, clientY);
        if (isDrawing && lastPt) {
            paintLine(lastPt.x, lastPt.y, pt.x, pt.y);
            lastPt = pt;
            scheduleRender();
        }

    } else if (activeTool === 'lasso' && isDrawing) {
        lassoPoints.push(pt);
        updateSVGLasso();

    } else if (activeTool === 'box' && isDrawing) {
        boxCur = pt;
        updateSVGBox();
    }
}

function handleUp() {
    if (activeTool === 'brush' || activeTool === 'eraser') {
        isDrawing = false;
        lastPt = null;
        hideCursor();

    } else if (activeTool === 'lasso' && isDrawing) {
        isDrawing = false;
        hideSVG();
        if (lassoPoints.length >= 3) {
            applyLasso();
        }
        lassoPoints = [];

    } else if (activeTool === 'box' && isDrawing) {
        isDrawing = false;
        hideSVG();
        if (boxStart && boxCur) {
            applyBox();
        }
        boxStart = boxCur = null;
    }

    isPanning = false;
    lastPinchDist = 0;
}

// ═══════════════════════════════════════════════════════════════
//  BRUSH / ERASER ENGINE
// ═══════════════════════════════════════════════════════════════
function paintStamp(x, y) {
    if (!maskCtx) return;
    maskCtx.save();
    maskCtx.globalCompositeOperation = activeTool === 'eraser' ? 'destination-out' : 'source-over';
    maskCtx.fillStyle = '#ffffff';
    maskCtx.beginPath();
    maskCtx.arc(x, y, brushSize, 0, Math.PI * 2);
    maskCtx.fill();
    maskCtx.restore();
}

function paintLine(x1, y1, x2, y2) {
    if (!maskCtx) return;
    maskCtx.save();
    maskCtx.globalCompositeOperation = activeTool === 'eraser' ? 'destination-out' : 'source-over';
    maskCtx.strokeStyle = '#ffffff';
    maskCtx.fillStyle = '#ffffff';
    maskCtx.lineWidth = brushSize * 2;
    maskCtx.lineCap = 'round';
    maskCtx.lineJoin = 'round';

    maskCtx.beginPath();
    maskCtx.moveTo(x1, y1);
    maskCtx.lineTo(x2, y2);
    maskCtx.stroke();

    maskCtx.beginPath();
    maskCtx.arc(x2, y2, brushSize, 0, Math.PI * 2);
    maskCtx.fill();
    maskCtx.restore();
}

function updateCursor(clientX, clientY) {
    const cursor = el('bgrem-cursor');
    if (!cursor) return;
    const wrap = el('bgrem-canvas-wrap');
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();

    const sz = brushSize * 2 * zoom;
    cursor.style.display = 'block';
    cursor.style.width = sz + 'px';
    cursor.style.height = sz + 'px';
    cursor.style.left = (clientX - rect.left) + 'px';
    cursor.style.top = (clientY - rect.top) + 'px';
    cursor.style.borderColor = activeTool === 'eraser' ? '#ef4444' : '#10b981';
    cursor.style.backgroundColor = activeTool === 'eraser' ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)';
}

function hideCursor() {
    const cursor = el('bgrem-cursor');
    if (cursor) cursor.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════
//  LASSO ENGINE
// ═══════════════════════════════════════════════════════════════
function applyLasso() {
    if (!maskCtx || lassoPoints.length < 3) return;

    // Keep inside lasso, remove everything outside
    const tempCv = document.createElement('canvas');
    tempCv.width = W; tempCv.height = H;
    const tCtx = tempCv.getContext('2d');

    tCtx.fillStyle = '#ffffff';
    tCtx.beginPath();
    tCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) {
        tCtx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    }
    tCtx.closePath();
    tCtx.fill();

    maskCtx.save();
    maskCtx.globalCompositeOperation = 'destination-in';
    maskCtx.drawImage(tempCv, 0, 0);
    maskCtx.restore();

    scheduleRender();
    if (window.showToast) window.showToast('Kept area inside lasso', false);
}

// ═══════════════════════════════════════════════════════════════
//  BOX CROP ENGINE
// ═══════════════════════════════════════════════════════════════
function applyBox() {
    if (!maskCtx || !boxStart || !boxCur) return;

    const x = Math.min(boxStart.x, boxCur.x);
    const y = Math.min(boxStart.y, boxCur.y);
    const w = Math.abs(boxStart.x - boxCur.x);
    const h = Math.abs(boxStart.y - boxCur.y);
    if (w < 5 || h < 5) return;

    const tempCv = document.createElement('canvas');
    tempCv.width = W; tempCv.height = H;
    const tCtx = tempCv.getContext('2d');
    tCtx.fillStyle = '#ffffff';
    tCtx.fillRect(x, y, w, h);

    maskCtx.save();
    maskCtx.globalCompositeOperation = 'destination-in';
    maskCtx.drawImage(tempCv, 0, 0);
    maskCtx.restore();

    scheduleRender();
    if (window.showToast) window.showToast('Box crop applied', false);
}

// ═══════════════════════════════════════════════════════════════
//  MAGIC WAND ENGINE
// ═══════════════════════════════════════════════════════════════
function applyWand(startX, startY) {
    if (!imgCtx || !maskCtx) return;

    const imgData = imgCtx.getImageData(0, 0, W, H);
    const maskData = maskCtx.getImageData(0, 0, W, H);
    const src = imgData.data;
    const mask = maskData.data;

    const idx = (startY * W + startX) * 4;
    const tR = src[idx], tG = src[idx + 1], tB = src[idx + 2];
    const tolSq = wandTolerance * wandTolerance * 3;
    const total = W * H;

    if (wandContiguous) {
        const visited = new Uint8Array(total);
        const queue = new Int32Array(total);
        let head = 0, tail = 0;
        const start = startY * W + startX;
        queue[tail++] = start;
        visited[start] = 1;

        while (head < tail) {
            const cur = queue[head++];
            mask[cur * 4 + 3] = 0; // Remove pixel

            const cx = cur % W;
            const cy = (cur - cx) / W;
            const neighbors = [
                cx > 0 ? cur - 1 : -1,
                cx < W - 1 ? cur + 1 : -1,
                cy > 0 ? cur - W : -1,
                cy < H - 1 ? cur + W : -1,
            ];

            for (const n of neighbors) {
                if (n >= 0 && !visited[n]) {
                    const ni = n * 4;
                    const dr = src[ni] - tR, dg = src[ni + 1] - tG, db = src[ni + 2] - tB;
                    if (dr * dr + dg * dg + db * db <= tolSq) {
                        visited[n] = 1;
                        queue[tail++] = n;
                    }
                }
            }
        }
    } else {
        for (let i = 0; i < total; i++) {
            const pi = i * 4;
            const dr = src[pi] - tR, dg = src[pi + 1] - tG, db = src[pi + 2] - tB;
            if (dr * dr + dg * dg + db * db <= tolSq) {
                mask[pi + 3] = 0;
            }
        }
    }

    maskCtx.putImageData(maskData, 0, 0);
    scheduleRender();
    if (window.showToast) window.showToast('Color removed with Wand', false);
}

// ═══════════════════════════════════════════════════════════════
//  SVG OVERLAY HELPERS
// ═══════════════════════════════════════════════════════════════
function showSVG() {
    const svg = el('bgrem-svg');
    if (svg) svg.style.display = 'block';
}
function hideSVG() {
    const svg = el('bgrem-svg');
    if (svg) svg.style.display = 'block'; // always visible
    const poly = el('bgrem-poly');
    if (poly) poly.setAttribute('points', '');
}

function updateSVGLasso() {
    const poly = el('bgrem-poly');
    if (!poly || !lassoPoints.length) return;
    const pts = lassoPoints.map(p => {
        const s = canvasToScreen(p.x, p.y);
        return `${s.x},${s.y}`;
    }).join(' ');
    poly.setAttribute('points', pts);
}

function updateSVGBox() {
    const poly = el('bgrem-poly');
    if (!poly || !boxStart || !boxCur) return;
    const p1 = canvasToScreen(boxStart.x, boxStart.y);
    const p2 = canvasToScreen(boxCur.x, boxCur.y);
    const pts = `${p1.x},${p1.y} ${p2.x},${p1.y} ${p2.x},${p2.y} ${p1.x},${p2.y} ${p1.x},${p1.y}`;
    poly.setAttribute('points', pts);
}

// ═══════════════════════════════════════════════════════════════
//  LOADING OVERLAY
// ═══════════════════════════════════════════════════════════════
function showLoading(text, sub = '') {
    const ld = el('bgrem-loading');
    if (ld) ld.style.display = 'flex';
    const t = el('bgrem-load-text');
    if (t) t.textContent = text;
    const s = el('bgrem-load-sub');
    if (s) s.textContent = sub;
    const b = el('bgrem-load-bar');
    if (b) b.style.width = '0%';
}

function updateLoading(pct, text) {
    const b = el('bgrem-load-bar');
    if (b) b.style.width = Math.min(100, Math.max(0, pct)) + '%';
    if (text) {
        const t = el('bgrem-load-text');
        if (t) t.textContent = text;
    }
}

function hideLoading() {
    const ld = el('bgrem-loading');
    if (ld) ld.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════
//  EXPORT: DOWNLOAD, SHARE, SAVE
// ═══════════════════════════════════════════════════════════════
async function getExportBlob() {
    if (!imgCanvas || !maskCanvas) return null;

    const exportCv = document.createElement('canvas');
    exportCv.width = W; exportCv.height = H;
    const ctx = exportCv.getContext('2d');

    // Background
    if (bgMode !== 'transparent') {
        if (bgMode === 'blur') {
            ctx.save();
            ctx.filter = 'blur(18px)';
            ctx.drawImage(imgCanvas, -20, -20, W + 40, H + 40);
            ctx.restore();
        } else {
            ctx.fillStyle = bgMode;
            ctx.fillRect(0, 0, W, H);
        }
    }

    // Masked foreground
    const tempCv = document.createElement('canvas');
    tempCv.width = W; tempCv.height = H;
    const tCtx = tempCv.getContext('2d');
    tCtx.drawImage(imgCanvas, 0, 0);
    tCtx.globalCompositeOperation = 'destination-in';
    tCtx.drawImage(maskCanvas, 0, 0);
    ctx.drawImage(tempCv, 0, 0);

    const isSolid = bgMode !== 'transparent' && bgMode !== 'blur';
    return new Promise(r => exportCv.toBlob(r, isSolid ? 'image/jpeg' : 'image/png', isSolid ? 0.92 : 1.0));
}

async function handleDownload() {
    const blob = await getExportBlob();
    if (!blob) return;
    const isSolid = bgMode !== 'transparent' && bgMode !== 'blur';
    const ext = isSolid ? 'jpg' : 'png';
    const name = originalFileName.replace(/\.[^/.]+$/, '') + '_cutout.' + ext;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    if (window.showToast) window.showToast('Image downloaded!', false);
}

async function handleShare() {
    const blob = await getExportBlob();
    if (!blob) return;
    const isSolid = bgMode !== 'transparent' && bgMode !== 'blur';
    const ext = isSolid ? 'jpg' : 'png';
    const mime = isSolid ? 'image/jpeg' : 'image/png';
    const file = new File([blob], `kivu_${Date.now()}.${ext}`, { type: mime });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title: 'Photo Cutout', text: 'Created with Kivu' });
        } catch (err) {
            if (err.name !== 'AbortError') handleDownload();
        }
    } else {
        handleDownload();
    }
}

async function saveDocument() {
    if (!imgCanvas || !maskCanvas) return;

    try {
        const finalBlob = await getExportBlob();
        if (!finalBlob) return;

        // Thumbnail
        const thumbCv = document.createElement('canvas');
        const aspect = W / H;
        let tw = THUMB_DIM, th = Math.round(tw / aspect);
        if (th > THUMB_DIM) { th = THUMB_DIM; tw = Math.round(th * aspect); }
        thumbCv.width = tw; thumbCv.height = th;
        thumbCv.getContext('2d').drawImage(dispCanvas, 0, 0, tw, th);
        const thumbUrl = thumbCv.toDataURL('image/jpeg', 0.8);

        const id = docId || ('bgrem_' + Date.now() + '_' + Math.floor(Math.random() * 1000));

        const docData = {
            id: id,
            type: 'bgremover',
            title: originalFileName || 'Processed Image',
            data: thumbUrl,
            selectedBg: bgMode,
            updatedAt: Date.now()
        };

        localStorage.setItem('kivu_doc_' + id, JSON.stringify(docData));

        // Update docs index
        const idx = localStorage.getItem('kivu_docs_index');
        let docs = idx ? JSON.parse(idx) : [];
        const existing = docs.find(d => d.id === id);
        if (existing) {
            existing.updatedAt = docData.updatedAt;
            existing.title = docData.title;
        } else {
            docs.push({ id: id, type: 'bgremover', title: docData.title, updatedAt: docData.updatedAt });
        }
        localStorage.setItem('kivu_docs_index', JSON.stringify(docs));

        docId = id;
        if (window.showToast) window.showToast('Saved to My Documents', false);

    } catch (err) {
        console.error('Save error:', err);
        if (window.showToast) window.showToast('Failed to save. Try downloading instead.', true);
    }
}

// ═══════════════════════════════════════════════════════════════
//  LOAD DOCUMENT
// ═══════════════════════════════════════════════════════════════
function loadDocument(id) {
    const dataStr = localStorage.getItem('kivu_doc_' + id);
    if (!dataStr) return;

    try {
        const doc = JSON.parse(dataStr);
        originalFileName = doc.title || 'Saved_Image';
        bgMode = doc.selectedBg || 'transparent';

        const img = new Image();
        img.onload = () => initImageCanvas(img);
        img.src = doc.data;
    } catch (e) {
        console.error('Failed to load doc:', e);
    }
}

// ═══════════════════════════════════════════════════════════════
//  NAVIGATION HELPERS
// ═══════════════════════════════════════════════════════════════
function resetToStart() {
    cleanup();
    abortCtrl = new AbortController();
    originalFileName = 'image.png';
    renderUI();
}

export function closeTool() {
    cleanup();
    const root = document.getElementById('bgremover-container') || document.getElementById('bgrem-root');
    if (root) root.remove();
    if (typeof window.renderMyDocuments === 'function') {
        try {
            window.renderMyDocuments();
        } catch (e) {
            console.warn('renderMyDocuments error:', e);
        }
    }
}