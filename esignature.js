// src/modules/tools/esignature.js
// Kivu Super App - Mobile-First Offline E-Signature & Stamp Tool
// Optimized for Low-End Android Devices (2-3GB RAM), Touchscreens & Offline Micro-Business Workflows

let _PDFDocument = null;
let _pdfjsLib = null;

async function ensurePdfLib() {
    if (_PDFDocument) return _PDFDocument;
    const pdfLib = await import('pdf-lib');
    _PDFDocument = pdfLib.PDFDocument || pdfLib.default?.PDFDocument || pdfLib;
    return _PDFDocument;
}

async function ensurePdfJs() {
    if (_pdfjsLib) return _pdfjsLib;
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
    _pdfjsLib = pdfjsLib;
    return _pdfjsLib;
}

// --- IndexedDB Storage for Heavy PDF Blobs (Zero LocalStorage Quota Limit) ---
const DB_NAME = 'kivu_esign_db';
const STORE_NAME = 'esign_docs';

function openEsignDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function savePdfToIDB(id, blob) {
    try {
        const db = await openEsignDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.put(blob, id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.error('[E-Sign] Failed to save PDF to IndexedDB:', e);
    }
}

async function getPdfFromIDB(id) {
    try {
        const db = await openEsignDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        console.error('[E-Sign] Failed to load PDF from IndexedDB:', e);
        return null;
    }
}

export async function deletePdfFromIDB(id) {
    try {
        const db = await openEsignDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.error('[E-Sign] Failed to delete PDF from IndexedDB:', e);
    }
}

// Safe PDF Blob Downloader with delayed URL revocation
function downloadPdfSafely(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
        if (link.parentNode) document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }, 20000);
}

// Background Cloudflare R2 Upload for Sharing to Chat
async function uploadPdfBlobToR2(blob, filename) {
    try {
        if (!window.sb || !window.sb.auth) return null;
        const { data: { session } } = await window.sb.auth.getSession();
        const token = session?.access_token;
        if (!token) return null;

        const safeName = `doc_${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const response = await fetch('https://upload.kivu.site', {
            method: 'POST',
            headers: {
                'x-filename': safeName,
                'Authorization': `Bearer ${token}`
            },
            body: blob
        });
        if (response.ok) {
            const res = await response.json();
            return res.publicUrl || res.url || null;
        }
    } catch (e) {
        console.warn('[E-Sign] R2 upload skipped/failed:', e);
    }
    return null;
}

// Optimized fast canvas cropping with Uint32Array for budget CPUs
function getCroppedCanvasDataUrl(canvas, ctx) {
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return null;

    const imgData = ctx.getImageData(0, 0, w, h);
    const data32 = new Uint32Array(imgData.data.buffer);
    
    let minX = w, minY = h, maxX = 0, maxY = 0;
    let hasDrawn = false;

    // Scan with step optimization for weak CPUs
    for (let y = 0; y < h; y++) {
        const rowOffset = y * w;
        for (let x = 0; x < w; x++) {
            // Check alpha byte in 32-bit pixel (0xAABBGGRR)
            if ((data32[rowOffset + x] & 0xFF000000) !== 0) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                hasDrawn = true;
            }
        }
    }

    if (!hasDrawn) return null;

    const padding = 8;
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(w, maxX + padding);
    maxY = Math.min(h, maxY + padding);

    const cropW = Math.max(1, maxX - minX);
    const cropH = Math.max(1, maxY - minY);

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = cropW;
    tempCanvas.height = cropH;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

    return { 
        dataUrl: tempCanvas.toDataURL('image/png'), 
        width: cropW, 
        height: cropH 
    };
}

// Convert image (JPEG/PNG/WebP/HEIC/etc.) to a clean 1-page PDF using pdf-lib & canvas
async function convertImageToPdfBuffer(imageFile) {
    const PDFLib = await ensurePdfLib();
    const pdfDoc = await PDFLib.create();

    const img = new Image();
    const imgUrl = URL.createObjectURL(imageFile);
    try {
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = imgUrl;
        });

        let srcW = img.naturalWidth || img.width || 800;
        let srcH = img.naturalHeight || img.height || 600;
        const maxDimension = 1600;
        let targetW = srcW;
        let targetH = srcH;
        if (targetW > maxDimension || targetH > maxDimension) {
            if (targetW > targetH) {
                targetH = Math.round((targetH * maxDimension) / targetW);
                targetW = maxDimension;
            } else {
                targetW = Math.round((targetW * maxDimension) / targetH);
                targetH = maxDimension;
            }
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.drawImage(img, 0, 0, targetW, targetH);

        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
        const embeddedImg = await pdfDoc.embedJpg(jpegDataUrl);

        const page = pdfDoc.addPage([targetW, targetH]);
        page.drawImage(embeddedImg, {
            x: 0,
            y: 0,
            width: targetW,
            height: targetH,
        });

        const bytes = await pdfDoc.save();
        return new Uint8Array(bytes);
    } finally {
        URL.revokeObjectURL(imgUrl);
    }
}

// Legacy fallback for base64
function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

// Local storage key for persistent signature
const SAVED_SIGNATURE_KEY = 'kivu_saved_signature';
const SAVED_SIGNATURE_INFO_KEY = 'kivu_saved_signature_info';

export async function init(docId = null) {
    console.log("Init E-Signature Tool, docId:", docId);
    
    const modalId = 'esignature-modal';
    let modal = document.getElementById(modalId);
    
    // State variables
    let currentDocId = docId;
    let selectedFileName = 'document.pdf';
    let originalPdfBytes = null; // Stored as Uint8Array to prevent worker transfer detach
    let pdfDocPreview = null;
    let currentRenderTask = null;
    let currentPageNum = 1;
    let totalPages = 1;
    let isProcessing = false;
    
    let stampDataUrl = null;
    let stampOriginalWidth = 160;
    let stampOriginalHeight = 60;
    
    // Drawing tool state
    let strokeColor = '#00257A'; // Standard African banking/legal dark blue ink
    let strokeWidth = 3;
    let isDrawing = false;
    let lastPoint = null;
    
    // Active stamp mode: 'draw' | 'type' | 'saved' | 'upload'
    let activeStampTab = 'draw';

    if (!modal) {
        modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'fixed inset-0 bg-white z-[60] flex flex-col pt-safe select-none';
        modal.innerHTML = `
            <!-- Top App Bar -->
            <div class="h-14 flex-shrink-0 flex items-center justify-between px-4 bg-white border-b border-gray-200 shadow-sm z-30">
                <button id="esign-close-btn" class="w-10 h-10 flex items-center justify-center text-gray-700 active:bg-gray-100 rounded-full transition-transform active:scale-95" aria-label="Back">
                    <i class="fas fa-arrow-left text-lg"></i>
                </button>
                <div class="flex flex-col items-center">
                    <h1 class="text-base font-bold text-gray-900 leading-tight">E-Sign & Stamp</h1>
                    <span id="esign-doc-subtitle" class="text-[11px] text-gray-500 font-medium truncate max-w-[200px]">Contracts, Invoices & Receipts</span>
                </div>
                <div class="w-10 flex items-center justify-end">
                    <button id="esign-help-btn" class="text-gray-400 hover:text-gray-600 p-2 text-sm">
                        <i class="fas fa-question-circle"></i>
                    </button>
                </div>
            </div>
            
            <!-- Main Content Flow -->
            <div class="flex-1 overflow-y-auto p-4 flex flex-col items-center bg-gray-50 relative" id="esign-content-area">
                
                <!-- STEP 1: Upload PDF or Photo -->
                <div id="esign-step-1" class="w-full max-w-sm flex flex-col items-center my-auto py-6">
                    <div class="w-20 h-20 bg-blue-50 rounded-2xl flex items-center justify-center mb-4 text-blue-600 shadow-inner">
                        <i class="fas fa-file-signature text-4xl"></i>
                    </div>
                    
                    <h2 class="text-xl font-black text-gray-800 text-center mb-1">Select Document</h2>
                    <p class="text-xs text-gray-500 text-center mb-6 px-4">
                        Upload a PDF contract or take a photo of any receipt, invoice or promissory note.
                    </p>

                    <!-- Hidden Inputs for File and Camera -->
                    <input type="file" id="esign-doc-input" accept="application/pdf,image/jpeg,image/png,image/webp" class="hidden" />
                    <input type="file" id="esign-camera-input" accept="image/*" capture="environment" class="hidden" />

                    <div class="w-full space-y-3">
                        <button id="esign-upload-file-btn" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 px-4 rounded-xl shadow-md flex items-center justify-center gap-3 active:scale-[0.98] transition-all">
                            <i class="fas fa-folder-open text-lg"></i>
                            <span>Choose PDF or Image</span>
                        </button>

                        <button id="esign-camera-btn" class="w-full bg-white hover:bg-gray-50 text-gray-800 font-bold py-3.5 px-4 rounded-xl border border-gray-300 shadow-sm flex items-center justify-center gap-3 active:scale-[0.98] transition-all">
                            <i class="fas fa-camera text-lg text-gray-600"></i>
                            <span>Take Photo of Paper</span>
                        </button>
                    </div>

                    <!-- Quick info badge -->
                    <div class="mt-8 flex items-center gap-2 text-gray-500 text-[11px] bg-gray-200/60 px-3 py-1.5 rounded-full">
                        <i class="fas fa-shield-alt text-green-600"></i>
                        <span>100% Offline & Private on device</span>
                    </div>
                </div>
                
                <!-- STEP 2: Create Signature or Stamp -->
                <div id="esign-step-2" class="w-full max-w-sm flex-col items-center hidden py-2">
                    <h2 class="text-base font-bold text-gray-800 mb-3 text-center">Create Signature or Stamp</h2>
                    
                    <!-- Segmented Tabs -->
                    <div class="w-full grid grid-cols-4 gap-1 mb-3 bg-gray-200/80 p-1 rounded-xl text-xs font-bold text-gray-600">
                        <button id="tab-draw" class="py-2 rounded-lg bg-white text-blue-700 shadow-sm transition-all flex flex-col items-center gap-0.5">
                            <i class="fas fa-pen text-[10px]"></i>
                            <span>Draw</span>
                        </button>
                        <button id="tab-type" class="py-2 rounded-lg text-gray-600 transition-all flex flex-col items-center gap-0.5">
                            <i class="fas fa-font text-[10px]"></i>
                            <span>Type</span>
                        </button>
                        <button id="tab-saved" class="py-2 rounded-lg text-gray-600 transition-all flex flex-col items-center gap-0.5">
                            <i class="fas fa-bookmark text-[10px]"></i>
                            <span>Saved</span>
                        </button>
                        <button id="tab-upload" class="py-2 rounded-lg text-gray-600 transition-all flex flex-col items-center gap-0.5">
                            <i class="fas fa-stamp text-[10px]"></i>
                            <span>Stamp</span>
                        </button>
                    </div>
                    
                    <!-- 1. DRAW AREA -->
                    <div id="area-draw" class="w-full flex flex-col items-center">
                        <div class="w-full flex items-center justify-between mb-1.5 px-1">
                            <span class="text-[11px] text-gray-500 font-medium">Draw with your finger</span>
                            
                            <!-- Ink Color Selector -->
                            <div class="flex items-center gap-2">
                                <button id="ink-blue-btn" class="w-6 h-6 rounded-full bg-[#00257A] ring-2 ring-blue-500 ring-offset-1 transition-all" title="Dark Blue Ink"></button>
                                <button id="ink-black-btn" class="w-6 h-6 rounded-full bg-[#111827] ring-0 transition-all" title="Black Ink"></button>
                            </div>
                        </div>

                        <div class="w-full bg-white border-2 border-dashed border-gray-300 rounded-2xl overflow-hidden shadow-inner relative" style="height: 180px;">
                            <canvas id="esign-canvas" class="w-full h-full touch-none cursor-crosshair"></canvas>
                            <span class="absolute bottom-2 right-3 text-[10px] text-gray-300 pointer-events-none font-medium">Sign above</span>
                        </div>

                        <div class="w-full flex items-center justify-between mt-2 mb-3">
                            <button id="esign-clear-btn" class="text-xs text-red-600 font-bold px-3 py-1.5 rounded-lg active:bg-red-50 transition-colors">
                                <i class="fas fa-trash-alt mr-1"></i> Clear
                            </button>
                            <label class="flex items-center gap-1.5 text-xs text-gray-600 font-medium cursor-pointer">
                                <input type="checkbox" id="save-signature-checkbox" checked class="rounded text-blue-600 focus:ring-0 w-4 h-4" />
                                <span>Save for next time</span>
                            </label>
                        </div>
                    </div>

                    <!-- 2. TYPE SIGNATURE AREA -->
                    <div id="area-type" class="w-full flex flex-col items-center hidden">
                        <span class="text-[11px] text-gray-500 mb-2 text-center">Type your name to generate a clean signature</span>
                        <input type="text" id="type-sig-input" placeholder="e.g. Jean Damascene" class="w-full px-4 py-3 bg-white border border-gray-300 rounded-xl text-base font-semibold focus:outline-none focus:border-blue-500 mb-3 shadow-sm" />
                        
                        <!-- Font Style Selector -->
                        <div class="w-full grid grid-cols-2 gap-2 mb-3">
                            <button class="type-style-btn p-3 bg-white border-2 border-blue-600 rounded-xl text-center shadow-sm active:scale-95 transition-all text-blue-900 text-lg" style="font-family: 'Brush Script MT', 'Dancing Script', cursive;" data-style="cursive1">
                                Formal Script
                            </button>
                            <button class="type-style-btn p-3 bg-white border border-gray-200 rounded-xl text-center shadow-sm active:scale-95 transition-all text-gray-800 text-lg font-serif italic" data-style="italic">
                                Elegant Italic
                            </button>
                        </div>
                    </div>

                    <!-- 3. SAVED SIGNATURE AREA -->
                    <div id="area-saved" class="w-full flex flex-col items-center hidden">
                        <div id="no-saved-sig-box" class="w-full py-8 px-4 text-center bg-gray-100 rounded-xl border border-dashed border-gray-300 text-gray-500 mb-3">
                            <i class="fas fa-info-circle text-2xl mb-1 text-gray-400"></i>
                            <p class="text-xs">No saved signature yet. Draw one and check "Save for next time".</p>
                        </div>

                        <div id="saved-sig-preview-box" class="w-full hidden flex-col items-center bg-white p-4 rounded-xl border border-gray-200 shadow-sm mb-3">
                            <div class="w-full h-24 bg-gray-50 rounded-lg flex items-center justify-center p-2 border border-gray-100 mb-3">
                                <img id="saved-sig-img" class="max-h-full max-w-full object-contain" />
                            </div>
                            <div class="w-full flex justify-between items-center">
                                <span class="text-[11px] text-green-700 font-bold flex items-center gap-1">
                                     <i class="fas fa-check-circle"></i> Ready to apply
                                </span>
                                <button id="delete-saved-sig-btn" class="text-xs text-red-500 font-bold hover:underline">
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- 4. UPLOAD STAMP / LOGO AREA -->
                    <div id="area-upload" class="w-full flex flex-col items-center hidden">
                        <p class="text-[11px] text-gray-500 text-center mb-2">Upload official rubber stamp, seal or logo (PNG / JPG)</p>
                        <input type="file" id="esign-stamp-input" accept="image/png, image/jpeg, image/webp" class="hidden" />
                        
                        <button id="esign-upload-stamp-btn" class="w-full bg-white text-gray-800 font-bold py-6 border-2 border-dashed border-gray-300 rounded-2xl active:scale-98 transition-transform mb-3 flex flex-col items-center justify-center shadow-sm">
                            <i class="fas fa-cloud-upload-alt text-2xl text-blue-500 mb-1"></i>
                            <span class="text-xs">Select Stamp Image</span>
                        </button>
                        
                        <div id="stamp-preview-wrapper" class="hidden w-full bg-white p-2 rounded-xl border border-gray-200 mb-3 flex items-center justify-center">
                            <img id="esign-stamp-preview" class="max-h-24 object-contain" />
                        </div>
                    </div>

                    <!-- Quick Date Stamp Toggle -->
                    <div class="w-full bg-blue-50/70 border border-blue-100 p-2.5 rounded-xl flex items-center justify-between mb-4">
                        <div class="flex items-center gap-2">
                            <i class="fas fa-calendar-alt text-blue-600 text-xs"></i>
                            <span class="text-xs font-bold text-gray-800">Add Date Stamp</span>
                        </div>
                        <span id="current-date-badge" class="text-[11px] bg-white border border-blue-200 text-blue-900 font-mono font-bold px-2 py-0.5 rounded">
                            ${new Date().toLocaleDateString('en-GB')}
                        </span>
                    </div>

                    <!-- Next Button -->
                    <button id="esign-next-step3-btn" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 rounded-xl shadow-md active:scale-95 transition-transform flex items-center justify-center gap-2">
                        <span>Place on Document</span>
                        <i class="fas fa-chevron-right text-xs"></i>
                    </button>
                </div>

                <!-- STEP 3: Position, Scale & Finalize -->
                <div id="esign-step-3" class="w-full flex-col items-center hidden h-full max-w-lg">
                    <!-- Instruction bar -->
                    <div class="w-full flex items-center justify-between bg-blue-50 border border-blue-200 px-3 py-1.5 rounded-xl mb-2 shrink-0">
                        <span class="text-[11px] text-blue-900 font-medium flex items-center gap-1.5">
                            <i class="fas fa-hand-pointer text-blue-600"></i> Drag stamp to position
                        </span>
                        <button id="esign-back-to-step2" class="text-xs text-blue-700 font-bold active:underline">
                            Change Stamp
                        </button>
                    </div>
                    
                    <!-- Page & Scale Controls -->
                    <div class="flex items-center justify-between gap-2 mb-2 w-full bg-white p-2 rounded-xl border border-gray-200 shadow-sm shrink-0">
                        <!-- Pagination -->
                        <div class="flex items-center gap-1">
                            <button id="esign-prev-page" class="w-8 h-8 flex items-center justify-center bg-gray-100 hover:bg-gray-200 rounded-lg active:scale-90 disabled:opacity-30 disabled:pointer-events-none text-xs font-bold text-gray-700">
                                <i class="fas fa-chevron-left"></i>
                            </button>
                            <span id="esign-page-info" class="text-xs font-bold text-gray-700 px-1 min-w-[45px] text-center">1 / 1</span>
                            <button id="esign-next-page" class="w-8 h-8 flex items-center justify-center bg-gray-100 hover:bg-gray-200 rounded-lg active:scale-90 disabled:opacity-30 disabled:pointer-events-none text-xs font-bold text-gray-700">
                                <i class="fas fa-chevron-right"></i>
                            </button>
                        </div>
                        
                        <!-- Size Slider -->
                        <div class="flex items-center gap-2">
                            <i class="fas fa-compress-alt text-gray-400 text-xs"></i>
                            <input type="range" id="esign-stamp-scale" min="0.3" max="2.5" step="0.05" value="1" class="w-24 sm:w-32 accent-blue-600 cursor-pointer" />
                            <i class="fas fa-expand-alt text-gray-400 text-xs"></i>
                        </div>
                    </div>
                    
                    <!-- Document Preview Viewport -->
                    <div class="relative overflow-auto border-2 border-gray-300 rounded-xl bg-gray-300 w-full flex-1 min-h-[300px] flex items-center justify-center shadow-inner" id="esign-preview-container">
                        <!-- Canvas and Overlay Container with exact matching coordinates -->
                        <div id="esign-canvas-wrapper" class="relative inline-block m-auto max-w-full">
                            <canvas id="esign-pdf-preview" class="block max-w-full h-auto shadow-md"></canvas>
                            
                            <!-- Draggable Stamp Overlay -->
                            <div id="esign-stamp-overlay" class="absolute border-2 border-blue-600 border-dashed cursor-move bg-blue-500/10 backdrop-blur-[0.5px] p-0.5 rounded shadow-lg touch-none" style="display: none; left: 20px; top: 20px;">
                                <img id="esign-stamp-img" class="pointer-events-none w-full h-full object-contain" />
                                <div class="absolute -top-2 -right-2 w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center text-[9px] shadow pointer-events-none">
                                    <i class="fas fa-arrows-alt"></i>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Export Actions (Native Share + Chat Share + Download) -->
                    <div class="w-full grid grid-cols-3 gap-2 mt-3 shrink-0">
                        <button id="esign-share-btn" class="bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold py-3 px-2 rounded-xl shadow-md transition-all flex items-center justify-center gap-1.5 text-xs sm:text-sm" title="Share via device menu">
                            <i class="fas fa-share-alt text-sm"></i>
                            <span>Share</span>
                        </button>

                        <button id="esign-chat-btn" class="bg-teal-600 hover:bg-teal-700 active:scale-95 text-white font-bold py-3 px-2 rounded-xl shadow-md transition-all flex items-center justify-center gap-1.5 text-xs sm:text-sm" title="Send document to Kivu Chat">
                            <i class="fas fa-comments text-sm"></i>
                            <span>Chat</span>
                        </button>

                        <button id="esign-apply-btn" class="bg-blue-600 hover:bg-blue-700 active:scale-95 text-white font-bold py-3 px-2 rounded-xl shadow-md transition-all flex items-center justify-center gap-1.5 text-xs sm:text-sm" title="Save signed PDF">
                            <i class="fas fa-download text-sm"></i>
                            <span>Save PDF</span>
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        bindAllEvents();
    }

    // Bind all interactive elements
    function bindAllEvents() {
        const step1 = document.getElementById('esign-step-1');
        const step2 = document.getElementById('esign-step-2');
        const step3 = document.getElementById('esign-step-3');
        
        const canvas = document.getElementById('esign-canvas');
        const ctx = canvas.getContext('2d');
        const overlay = document.getElementById('esign-stamp-overlay');
        const canvasWrapper = document.getElementById('esign-canvas-wrapper');
        const previewCanvas = document.getElementById('esign-pdf-preview');
        
        // Close modal
        document.getElementById('esign-close-btn').addEventListener('click', () => {
            closeTool();
        });

        // Step 1: File selection & camera triggers
        const docInput = document.getElementById('esign-doc-input');
        const cameraInput = document.getElementById('esign-camera-input');

        document.getElementById('esign-upload-file-btn').addEventListener('click', () => {
            docInput.click();
        });

        document.getElementById('esign-camera-btn').addEventListener('click', () => {
            cameraInput.click();
        });

        async function handleIncomingFile(file) {
            if (!file) return;
            if (window.showToast) window.showToast('Preparing document...', false);

            try {
                selectedFileName = file.name || 'signed_doc.pdf';
                if (file.type === 'application/pdf' || selectedFileName.toLowerCase().endsWith('.pdf')) {
                    const buffer = await file.arrayBuffer();
                    originalPdfBytes = new Uint8Array(buffer);
                } else if (file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|bmp|gif)$/i.test(selectedFileName)) {
                    // Convert image / photo directly into a standard PDF page
                    originalPdfBytes = await convertImageToPdfBuffer(file);
                    selectedFileName = selectedFileName.replace(/\.[^/.]+$/, "") + ".pdf";
                } else {
                    try {
                        const buffer = await file.arrayBuffer();
                        originalPdfBytes = new Uint8Array(buffer);
                    } catch (e) {
                        if (window.showToast) window.showToast('Please upload a PDF or Image', true);
                        return;
                    }
                }

                const pdfjs = await ensurePdfJs();
                // Clone buffer (.slice()) so worker transfer doesn't detach originalPdfBytes
                const loadingTask = pdfjs.getDocument({ data: originalPdfBytes.slice() });
                pdfDocPreview = await loadingTask.promise;
                totalPages = pdfDocPreview.numPages;
                currentPageNum = 1;

                document.getElementById('esign-doc-subtitle').textContent = selectedFileName;

                step1.classList.add('hidden');
                step2.classList.remove('hidden');
                step2.classList.add('flex');

                checkSavedSignature();
                setTimeout(() => resizeCanvas(), 100);
            } catch (err) {
                console.error("Document read error:", err);
                if (window.showToast) window.showToast('Error loading document', true);
            }
        }

        docInput.addEventListener('change', (e) => handleIncomingFile(e.target.files[0]));
        cameraInput.addEventListener('change', (e) => handleIncomingFile(e.target.files[0]));

        // Step 2: Tabs Switcher
        const tabDraw = document.getElementById('tab-draw');
        const tabType = document.getElementById('tab-type');
        const tabSaved = document.getElementById('tab-saved');
        const tabUpload = document.getElementById('tab-upload');

        const areaDraw = document.getElementById('area-draw');
        const areaType = document.getElementById('area-type');
        const areaSaved = document.getElementById('area-saved');
        const areaUpload = document.getElementById('area-upload');

        function switchTab(tab) {
            activeStampTab = tab;
            [tabDraw, tabType, tabSaved, tabUpload].forEach(t => {
                t.className = "py-2 rounded-lg text-gray-600 transition-all flex flex-col items-center gap-0.5";
            });
            [areaDraw, areaType, areaSaved, areaUpload].forEach(a => a.classList.add('hidden'));

            if (tab === 'draw') {
                tabDraw.className = "py-2 rounded-lg bg-white text-blue-700 shadow-sm transition-all flex flex-col items-center gap-0.5";
                areaDraw.classList.remove('hidden');
                setTimeout(() => resizeCanvas(), 50);
            } else if (tab === 'type') {
                tabType.className = "py-2 rounded-lg bg-white text-blue-700 shadow-sm transition-all flex flex-col items-center gap-0.5";
                areaType.classList.remove('hidden');
                document.getElementById('type-sig-input').focus();
            } else if (tab === 'saved') {
                tabSaved.className = "py-2 rounded-lg bg-white text-blue-700 shadow-sm transition-all flex flex-col items-center gap-0.5";
                areaSaved.classList.remove('hidden');
                checkSavedSignature();
            } else if (tab === 'upload') {
                tabUpload.className = "py-2 rounded-lg bg-white text-blue-700 shadow-sm transition-all flex flex-col items-center gap-0.5";
                areaUpload.classList.remove('hidden');
            }
        }

        tabDraw.addEventListener('click', () => switchTab('draw'));
        tabType.addEventListener('click', () => switchTab('type'));
        tabSaved.addEventListener('click', () => switchTab('saved'));
        tabUpload.addEventListener('click', () => switchTab('upload'));

        // Ink Color selection
        const inkBlueBtn = document.getElementById('ink-blue-btn');
        const inkBlackBtn = document.getElementById('ink-black-btn');

        inkBlueBtn.addEventListener('click', () => {
            strokeColor = '#00257A';
            inkBlueBtn.className = 'w-6 h-6 rounded-full bg-[#00257A] ring-2 ring-blue-500 ring-offset-1 transition-all';
            inkBlackBtn.className = 'w-6 h-6 rounded-full bg-[#111827] ring-0 transition-all';
            ctx.strokeStyle = strokeColor;
        });

        inkBlackBtn.addEventListener('click', () => {
            strokeColor = '#111827';
            inkBlackBtn.className = 'w-6 h-6 rounded-full bg-[#111827] ring-2 ring-gray-900 ring-offset-1 transition-all';
            inkBlueBtn.className = 'w-6 h-6 rounded-full bg-[#00257A] ring-0 transition-all';
            ctx.strokeStyle = strokeColor;
        });

        // Canvas High-DPI & Smooth Curve Drawing
        function resizeCanvas() {
            if (step2.classList.contains('hidden') || areaDraw.classList.contains('hidden')) return;
            const rect = canvas.parentElement.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            
            // Set internal buffer size for sharp rendering
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            
            ctx.scale(dpr, dpr);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.lineWidth = strokeWidth;
            ctx.strokeStyle = strokeColor;
        }
        window.addEventListener('resize', resizeCanvas);

        function getTouchPos(e) {
            const rect = canvas.getBoundingClientRect();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            return {
                x: clientX - rect.left,
                y: clientY - rect.top
            };
        }

        function onStartDraw(e) {
            isDrawing = true;
            lastPoint = getTouchPos(e);
            ctx.beginPath();
            ctx.moveTo(lastPoint.x, lastPoint.y);
            e.preventDefault();
        }

        function onMoveDraw(e) {
            if (!isDrawing) return;
            const currentPoint = getTouchPos(e);
            
            // Quadratic curve smoothing for natural fluid strokes on budget touchscreens
            const midPoint = {
                x: (lastPoint.x + currentPoint.x) / 2,
                y: (lastPoint.y + currentPoint.y) / 2
            };
            ctx.quadraticCurveTo(lastPoint.x, lastPoint.y, midPoint.x, midPoint.y);
            ctx.stroke();
            lastPoint = currentPoint;
            e.preventDefault();
        }

        function onEndDraw() {
            if (isDrawing) {
                isDrawing = false;
                ctx.closePath();
            }
        }

        canvas.addEventListener('mousedown', onStartDraw);
        canvas.addEventListener('mousemove', onMoveDraw);
        window.addEventListener('mouseup', onEndDraw);
        canvas.addEventListener('touchstart', onStartDraw, { passive: false });
        canvas.addEventListener('touchmove', onMoveDraw, { passive: false });
        window.addEventListener('touchend', onEndDraw);

        document.getElementById('esign-clear-btn').addEventListener('click', () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        });

        // Type to Sign Generator
        let activeTypeStyle = 'cursive1';
        document.querySelectorAll('.type-style-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.type-style-btn').forEach(b => {
                    b.className = 'type-style-btn p-3 bg-white border border-gray-200 rounded-xl text-center shadow-sm active:scale-95 transition-all text-gray-800 text-lg';
                });
                const target = e.currentTarget;
                target.className = 'type-style-btn p-3 bg-white border-2 border-blue-600 rounded-xl text-center shadow-sm active:scale-95 transition-all text-blue-900 text-lg';
                activeTypeStyle = target.dataset.style;
            });
        });

        function generateTypedSignatureDataUrl(nameText) {
            const text = nameText.trim();
            if (!text) return null;
            
            const tCanvas = document.createElement('canvas');
            tCanvas.width = 600;
            tCanvas.height = 200;
            const tCtx = tCanvas.getContext('2d');
            
            tCtx.font = activeTypeStyle === 'cursive1' 
                ? "italic bold 52px 'Brush Script MT', 'Dancing Script', 'Segoe Script', cursive"
                : "italic bold 44px Georgia, serif";
            tCtx.fillStyle = strokeColor;
            tCtx.textBaseline = 'middle';
            tCtx.textAlign = 'center';
            tCtx.fillText(text, 300, 100);

            return getCroppedCanvasDataUrl(tCanvas, tCtx);
        }

        // Saved Signature Helpers
        function checkSavedSignature() {
            const savedDataUrl = localStorage.getItem(SAVED_SIGNATURE_KEY);
            const noBox = document.getElementById('no-saved-sig-box');
            const previewBox = document.getElementById('saved-sig-preview-box');
            const img = document.getElementById('saved-sig-img');

            if (savedDataUrl) {
                img.src = savedDataUrl;
                noBox.classList.add('hidden');
                previewBox.classList.remove('hidden');
                previewBox.classList.add('flex');
            } else {
                noBox.classList.remove('hidden');
                previewBox.classList.add('hidden');
                previewBox.classList.remove('flex');
            }
        }

        document.getElementById('delete-saved-sig-btn').addEventListener('click', () => {
            localStorage.removeItem(SAVED_SIGNATURE_KEY);
            localStorage.removeItem(SAVED_SIGNATURE_INFO_KEY);
            checkSavedSignature();
            if (window.showToast) window.showToast('Saved signature deleted', false);
        });

        // Stamp / Image Upload Logic
        const stampInput = document.getElementById('esign-stamp-input');
        const stampPreview = document.getElementById('esign-stamp-preview');
        const stampPreviewWrapper = document.getElementById('stamp-preview-wrapper');

        document.getElementById('esign-upload-stamp-btn').addEventListener('click', () => {
            stampInput.click();
        });

        stampInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    const dataUrl = event.target.result;
                    const img = new Image();
                    img.onload = () => {
                        stampOriginalWidth = img.width;
                        stampOriginalHeight = img.height;
                        stampDataUrl = dataUrl;
                        stampPreview.src = dataUrl;
                        stampPreviewWrapper.classList.remove('hidden');
                    };
                    img.src = dataUrl;
                };
                reader.readAsDataURL(file);
            }
        });

        // Back from Step 3 to Step 2
        document.getElementById('esign-back-to-step2').addEventListener('click', () => {
            step3.classList.add('hidden');
            step3.classList.remove('flex');
            step2.classList.remove('hidden');
            step2.classList.add('flex');
        });

        // STEP 3: Transition & Placement setup
        document.getElementById('esign-next-step3-btn').addEventListener('click', async () => {
            if (activeStampTab === 'draw') {
                const cropped = getCroppedCanvasDataUrl(canvas, ctx);
                if (!cropped) {
                    if (window.showToast) window.showToast('Please draw your signature first', true);
                    return;
                }
                stampDataUrl = cropped.dataUrl;
                stampOriginalWidth = cropped.width;
                stampOriginalHeight = cropped.height;

                // Save signature if checked
                if (document.getElementById('save-signature-checkbox').checked) {
                    localStorage.setItem(SAVED_SIGNATURE_KEY, stampDataUrl);
                    localStorage.setItem(SAVED_SIGNATURE_INFO_KEY, JSON.stringify({
                        width: stampOriginalWidth,
                        height: stampOriginalHeight,
                        savedAt: Date.now()
                    }));
                }
            } else if (activeStampTab === 'type') {
                const nameVal = document.getElementById('type-sig-input').value;
                const typedResult = generateTypedSignatureDataUrl(nameVal);
                if (!typedResult) {
                    if (window.showToast) window.showToast('Please type your name', true);
                    return;
                }
                stampDataUrl = typedResult.dataUrl;
                stampOriginalWidth = typedResult.width;
                stampOriginalHeight = typedResult.height;
            } else if (activeStampTab === 'saved') {
                const savedData = localStorage.getItem(SAVED_SIGNATURE_KEY);
                if (!savedData) {
                    if (window.showToast) window.showToast('No saved signature found', true);
                    return;
                }
                stampDataUrl = savedData;
                const infoStr = localStorage.getItem(SAVED_SIGNATURE_INFO_KEY);
                if (infoStr) {
                    try {
                        const info = JSON.parse(infoStr);
                        stampOriginalWidth = info.width || 160;
                        stampOriginalHeight = info.height || 60;
                    } catch (e) {
                        stampOriginalWidth = 160;
                        stampOriginalHeight = 60;
                    }
                }
            } else if (activeStampTab === 'upload') {
                if (!stampDataUrl) {
                    if (window.showToast) window.showToast('Please select a stamp image', true);
                    return;
                }
            }

            document.getElementById('esign-stamp-img').src = stampDataUrl;

            step2.classList.add('hidden');
            step2.classList.remove('flex');
            step3.classList.remove('hidden');
            step3.classList.add('flex');

            document.getElementById('esign-stamp-scale').value = 1;
            await renderPage(currentPageNum);

            overlay.style.display = 'block';
            updateStampSize();

            // Default position: bottom-right area (typical signature zone)
            setTimeout(() => {
                const dispW = previewCanvas.clientWidth || 300;
                const dispH = previewCanvas.clientHeight || 400;
                const overlayW = overlay.offsetWidth || 120;
                const overlayH = overlay.offsetHeight || 50;
                overlay.style.left = Math.max(10, dispW - overlayW - 25) + 'px';
                overlay.style.top = Math.max(10, dispH - overlayH - 40) + 'px';
            }, 100);
        });

        // Scale Logic with strict container bounding
        function updateStampSize() {
            const scale = parseFloat(document.getElementById('esign-stamp-scale').value) || 1;
            const baseW = Math.min(180, Math.max(90, stampOriginalWidth));
            const aspect = stampOriginalHeight / stampOriginalWidth;
            const baseH = baseW * aspect;

            const finalW = Math.round(baseW * scale);
            const finalH = Math.round(baseH * scale);

            overlay.style.width = finalW + 'px';
            overlay.style.height = finalH + 'px';

            const dispW = previewCanvas.clientWidth || 300;
            const dispH = previewCanvas.clientHeight || 400;
            let currentLeft = parseFloat(overlay.style.left) || 0;
            let currentTop = parseFloat(overlay.style.top) || 0;

            const maxLeft = Math.max(0, dispW - finalW);
            const maxTop = Math.max(0, dispH - finalH);

            if (currentLeft > maxLeft) overlay.style.left = maxLeft + 'px';
            if (currentTop > maxTop) overlay.style.top = maxTop + 'px';
        }

        document.getElementById('esign-stamp-scale').addEventListener('input', updateStampSize);

        // PDF Page Rendering with Cancellation support (Memory Leak Prevention)
        async function renderPage(pageNum) {
            if (!pdfDocPreview) return;
            
            // Cancel active render task if user rapidly clicks pagination
            if (currentRenderTask) {
                try {
                    currentRenderTask.cancel();
                } catch (e) {}
            }

            try {
                const page = await pdfDocPreview.getPage(pageNum);
                const viewport = page.getViewport({ scale: 1.0 });

                previewCanvas.width = viewport.width;
                previewCanvas.height = viewport.height;
                const previewCtx = previewCanvas.getContext('2d');

                currentRenderTask = page.render({
                    canvasContext: previewCtx,
                    viewport: viewport
                });

                await currentRenderTask.promise;
            } catch (err) {
                if (err?.name !== 'RenderingCancelledException') {
                    console.error("PDF render error:", err);
                }
            } finally {
                currentRenderTask = null;
            }

            document.getElementById('esign-page-info').textContent = `${pageNum} / ${totalPages}`;
            document.getElementById('esign-prev-page').disabled = pageNum <= 1;
            document.getElementById('esign-next-page').disabled = pageNum >= totalPages;
        }

        document.getElementById('esign-prev-page').addEventListener('click', () => {
            if (currentPageNum > 1) {
                currentPageNum--;
                renderPage(currentPageNum);
            }
        });

        document.getElementById('esign-next-page').addEventListener('click', () => {
            if (currentPageNum < totalPages) {
                currentPageNum++;
                renderPage(currentPageNum);
            }
        });

        // Touch & Mouse Drag Logic (Zero-offset jump bug fix)
        let isDragging = false;
        let startClientX = 0;
        let startClientY = 0;
        let initialOverlayLeft = 0;
        let initialOverlayTop = 0;

        function startOverlayDrag(e) {
            isDragging = true;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            startClientX = clientX;
            startClientY = clientY;
            initialOverlayLeft = parseFloat(overlay.style.left) || 0;
            initialOverlayTop = parseFloat(overlay.style.top) || 0;
            e.preventDefault();
        }

        function moveOverlayDrag(e) {
            if (!isDragging) return;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            
            const dx = clientX - startClientX;
            const dy = clientY - startClientY;

            let newLeft = initialOverlayLeft + dx;
            let newTop = initialOverlayTop + dy;

            const dispW = previewCanvas.clientWidth;
            const dispH = previewCanvas.clientHeight;
            const overlayW = overlay.offsetWidth;
            const overlayH = overlay.offsetHeight;

            const maxLeft = Math.max(0, dispW - overlayW);
            const maxTop = Math.max(0, dispH - overlayH);

            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));

            overlay.style.left = newLeft + 'px';
            overlay.style.top = newTop + 'px';
            e.preventDefault();
        }

        function endOverlayDrag() {
            isDragging = false;
        }

        overlay.addEventListener('mousedown', startOverlayDrag);
        document.addEventListener('mousemove', moveOverlayDrag);
        document.addEventListener('mouseup', endOverlayDrag);

        overlay.addEventListener('touchstart', startOverlayDrag, { passive: false });
        document.addEventListener('touchmove', moveOverlayDrag, { passive: false });
        document.addEventListener('touchend', endOverlayDrag);

        // Finalize: Generate Signed PDF Blob
        async function buildSignedPdfBlob() {
            if (!originalPdfBytes || originalPdfBytes.length === 0) {
                throw new Error('No PDF document loaded');
            }
            if (!stampDataUrl) {
                throw new Error('No signature or stamp provided');
            }

            const PDFLib = await ensurePdfLib();
            // Load cloned copy of originalPdfBytes
            const pdfDoc = await PDFLib.load(originalPdfBytes.slice(), { ignoreEncryption: true });

            let embeddedStamp;
            try {
                if (stampDataUrl.startsWith('data:image/png')) {
                    embeddedStamp = await pdfDoc.embedPng(stampDataUrl);
                } else if (stampDataUrl.startsWith('data:image/jpeg') || stampDataUrl.startsWith('data:image/jpg')) {
                    embeddedStamp = await pdfDoc.embedJpg(stampDataUrl);
                } else {
                    const img = new Image();
                    await new Promise((res, rej) => {
                        img.onload = res;
                        img.onerror = rej;
                        img.src = stampDataUrl;
                    });
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth || img.width;
                    c.height = img.naturalHeight || img.height;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    embeddedStamp = await pdfDoc.embedPng(c.toDataURL('image/png'));
                }
            } catch (embedErr) {
                console.warn('[E-Sign] Direct embed failed, converting stamp via canvas:', embedErr);
                const img = new Image();
                await new Promise((res, rej) => {
                    img.onload = res;
                    img.onerror = rej;
                    img.src = stampDataUrl;
                });
                const c = document.createElement('canvas');
                c.width = img.naturalWidth || img.width;
                c.height = img.naturalHeight || img.height;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0);
                embeddedStamp = await pdfDoc.embedPng(c.toDataURL('image/png'));
            }

            const pages = pdfDoc.getPages();
            const targetPage = pages[currentPageNum - 1];
            if (!targetPage) {
                throw new Error(`Target page ${currentPageNum} not found in PDF`);
            }

            // Calculate normalized coordinate ratios (independent of display screen DPI or resize)
            const dispW = previewCanvas.clientWidth || previewCanvas.width || 1;
            const dispH = previewCanvas.clientHeight || previewCanvas.height || 1;

            const stampW = parseFloat(overlay.style.width) || overlay.offsetWidth || 120;
            const stampH = parseFloat(overlay.style.height) || overlay.offsetHeight || 50;
            const stampLeft = parseFloat(overlay.style.left) || 0;
            const stampTop = parseFloat(overlay.style.top) || 0;

            const normX = Math.max(0, Math.min(1, stampLeft / dispW));
            const normY = Math.max(0, Math.min(1, stampTop / dispH));
            const normW = Math.max(0, Math.min(1, stampW / dispW));
            const normH = Math.max(0, Math.min(1, stampH / dispH));

            const { width: pdfW, height: pdfH } = targetPage.getSize();

            const pdfStampX = normX * pdfW;
            const pdfStampW = normW * pdfW;
            const pdfStampH = normH * pdfH;
            // PDF origin (0,0) is bottom-left
            const pdfStampY = pdfH - ((normY + normH) * pdfH);

            targetPage.drawImage(embeddedStamp, {
                x: Math.max(0, pdfStampX),
                y: Math.max(0, pdfStampY),
                width: Math.max(1, pdfStampW),
                height: Math.max(1, pdfStampH),
            });

            const pdfBytes = await pdfDoc.save();
            return new Blob([pdfBytes], { type: 'application/pdf' });
        }

        // Save & Register in Kivu Documents Index with IndexedDB Heavy Blob Storage
        async function saveDocumentToKivuStorage(blob, filename) {
            try {
                const newDocId = currentDocId || ('doc_' + Date.now());
                
                // 1. Save raw PDF Blob into IndexedDB (zero base64 overhead, no 5MB quota limit)
                await savePdfToIDB(newDocId, blob);

                // 2. Save only lightweight metadata to localStorage
                const docObj = {
                    id: newDocId,
                    title: filename,
                    type: 'esignature',
                    updatedAt: Date.now(),
                    size: blob.size
                };
                localStorage.setItem('kivu_doc_' + newDocId, JSON.stringify(docObj));

                // 3. Save index entry for fast list rendering
                const idxStr = localStorage.getItem('kivu_docs_index');
                let docs = idxStr ? JSON.parse(idxStr) : [];
                const existingIdx = docs.findIndex(d => d.id === newDocId);
                if (existingIdx !== -1) {
                    docs[existingIdx].title = filename;
                    docs[existingIdx].updatedAt = Date.now();
                } else {
                    docs.push({ id: newDocId, title: filename, type: 'esignature', updatedAt: Date.now() });
                }
                localStorage.setItem('kivu_docs_index', JSON.stringify(docs));

                if (window.renderMyDocuments) window.renderMyDocuments();
                return newDocId;
            } catch (err) {
                console.warn("[E-Sign] Storage error:", err);
            }
        }

        // Apply & Download Button
        document.getElementById('esign-apply-btn').addEventListener('click', async () => {
            if (isProcessing) return;
            isProcessing = true;
            try {
                if (window.showToast) window.showToast('Saving signed document...', false);
                const signedBlob = await buildSignedPdfBlob();
                const outFilename = selectedFileName.replace(/\.pdf$/i, '') + '_signed.pdf';

                downloadPdfSafely(signedBlob, outFilename);
                await saveDocumentToKivuStorage(signedBlob, outFilename);

                if (window.showToast) window.showToast('Document saved successfully! 📄', false);
                closeTool();
            } catch (err) {
                console.error("Error saving PDF:", err);
                if (window.showToast) window.showToast('Failed to save signed document', true);
            } finally {
                isProcessing = false;
            }
        });

        // Native Share Button
        document.getElementById('esign-share-btn').addEventListener('click', async () => {
            if (isProcessing) return;
            isProcessing = true;
            try {
                if (window.showToast) window.showToast('Preparing document to share...', false);
                const signedBlob = await buildSignedPdfBlob();
                const outFilename = selectedFileName.replace(/\.pdf$/i, '') + '_signed.pdf';
                const file = new File([signedBlob], outFilename, { type: 'application/pdf' });

                await saveDocumentToKivuStorage(signedBlob, outFilename);

                let shared = false;
                if (navigator.canShare && navigator.canShare({ files: [file] })) {
                    try {
                        await navigator.share({
                            files: [file],
                            title: outFilename,
                            text: 'Signed document via Kivu App'
                        });
                        shared = true;
                        if (window.showToast) window.showToast('Document shared! 🚀', false);
                        closeTool();
                    } catch (shareErr) {
                        if (shareErr?.name === 'AbortError') {
                            shared = true;
                        }
                    }
                }

                if (!shared && typeof navigator !== 'undefined' && navigator.share) {
                    try {
                        await navigator.share({
                            title: outFilename,
                            text: 'Signed document: ' + outFilename
                        });
                        shared = true;
                        if (window.showToast) window.showToast('Document shared! 🚀', false);
                        closeTool();
                    } catch (shareErr) {
                        if (shareErr?.name === 'AbortError') {
                            shared = true;
                        }
                    }
                }

                if (!shared) {
                    // Fallback to direct download
                    downloadPdfSafely(signedBlob, outFilename);
                    if (window.showToast) window.showToast('Document downloaded and ready to share!', false);
                    closeTool();
                }
            } catch (err) {
                if (err?.name !== 'AbortError') {
                    console.error("Share error:", err);
                    if (window.showToast) window.showToast('Error sharing document', true);
                }
            } finally {
                isProcessing = false;
            }
        });

        // Send to Kivu Chat Button
        document.getElementById('esign-chat-btn').addEventListener('click', async () => {
            if (isProcessing) return;
            isProcessing = true;
            try {
                if (window.showToast) window.showToast('Preparing document for Chat...', false);
                const signedBlob = await buildSignedPdfBlob();
                const outFilename = selectedFileName.replace(/\.pdf$/i, '') + '_signed.pdf';

                await saveDocumentToKivuStorage(signedBlob, outFilename);

                // Try uploading to R2 for a direct URL
                let publicUrl = null;
                try {
                    publicUrl = await uploadPdfBlobToR2(signedBlob, outFilename);
                } catch (uErr) {
                    console.warn('[E-Sign] Could not upload to R2:', uErr);
                }

                let messageText = `📄 Signed Document: ${outFilename}`;
                if (publicUrl) {
                    messageText += `\n${publicUrl}`;
                } else {
                    messageText += `\n(Saved in Tools > My Documents)`;
                }

                window.pendingShareMessage = messageText;
                if (window.showToast) window.showToast('Select a friend or chat to share! 💬', false);

                closeTool();

                if (typeof window.openSuperModule === 'function') {
                    await window.openSuperModule('chat');
                } else if (typeof ensureModuleAssets === 'function') {
                    await ensureModuleAssets('chat');
                    if (typeof window.openSuperModule === 'function') window.openSuperModule('chat');
                }
            } catch (err) {
                console.error("Chat share error:", err);
                if (window.showToast) window.showToast('Error preparing chat share', true);
            } finally {
                isProcessing = false;
            }
        });
    }

    function closeTool() {
        if (pdfDocPreview) {
            try { pdfDocPreview.destroy(); } catch (e) {}
            pdfDocPreview = null;
        }
        originalPdfBytes = null;
        modal.classList.add('hidden');
    }

    // Reset UI state for fresh open
    modal.classList.remove('hidden');
    document.getElementById('esign-step-3').classList.add('hidden');
    document.getElementById('esign-step-3').classList.remove('flex');
    document.getElementById('esign-step-2').classList.add('hidden');
    document.getElementById('esign-step-2').classList.remove('flex');
    document.getElementById('esign-step-1').classList.remove('hidden');

    document.getElementById('esign-doc-input').value = '';
    document.getElementById('esign-camera-input').value = '';
    document.getElementById('esign-stamp-input').value = '';
    document.getElementById('type-sig-input').value = '';

    // If existing document is passed from My Documents
    if (docId) {
        try {
            const dataStr = localStorage.getItem('kivu_doc_' + docId);
            if (dataStr) {
                const docObj = JSON.parse(dataStr);
                selectedFileName = docObj?.title || 'document.pdf';
                
                // 1. Fetch raw PDF Blob from IndexedDB
                let pdfBlob = await getPdfFromIDB(docId);
                
                // 2. Legacy fallback for old records with Base64 in localStorage
                if (!pdfBlob && docObj?.pdfData) {
                    pdfBlob = new Blob([base64ToArrayBuffer(docObj.pdfData)], { type: 'application/pdf' });
                }

                if (pdfBlob) {
                    const buffer = await pdfBlob.arrayBuffer();
                    originalPdfBytes = new Uint8Array(buffer);
                    
                    const pdfjs = await ensurePdfJs();
                    const loadingTask = pdfjs.getDocument({ data: originalPdfBytes.slice() });
                    pdfDocPreview = await loadingTask.promise;
                    totalPages = pdfDocPreview.numPages;
                    currentPageNum = 1;

                    document.getElementById('esign-doc-subtitle').textContent = selectedFileName;
                    document.getElementById('esign-step-1').classList.add('hidden');
                    document.getElementById('esign-step-2').classList.remove('hidden');
                    document.getElementById('esign-step-2').classList.add('flex');
                }
            }
        } catch (e) {
            console.error("[E-Sign] Failed to load existing document:", e);
        }
    }
}
