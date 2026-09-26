// src/modules/tools/pdfmerge.js
// Kivu Super App — Ultra-Reliable PDF & Image Merge / Split Tool
// Optimized for Low-End Android (2GB RAM, Offline-First, Touch-Optimized)

let PDFDocument = null;
let PageSizes = null;

/**
 * Ленивая загрузка pdf-lib для экономии стартовой памяти
 */
async function ensurePdfLib() {
    if (PDFDocument && PageSizes) return;
    try {
        const pdfLib = await import('pdf-lib');
        PDFDocument = pdfLib.PDFDocument;
        PageSizes = pdfLib.PageSizes || { A4: [595.28, 841.89] };
    } catch (err) {
        console.error("Failed to load pdf-lib", err);
        throw new Error("Could not initialize PDF engine. Check connection or offline cache.");
    }
}

/**
 * Безопасное скачивание Blob без срыва загрузки на мобильных браузерах
 */
function downloadBlobSafely(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    
    // Удаляем из DOM сразу, но URL отзываем с задержкой 20 секунд,
    // чтобы мобильный Download Manager успел захватить поток
    setTimeout(() => {
        if (link.parentNode) document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }, 20000);
}

/**
 * Шеринг напрямую в WhatsApp / системный диалог (Web Share API Level 2)
 */
async function sharePdfFile(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const file = new File([blob], filename, { type: 'application/pdf' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({
                files: [file],
                title: filename,
                text: 'Here is your merged document.'
            });
            return true;
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.warn('Share API failed, falling back to download', err);
            } else {
                return true; // Пользователь сам отменил диалог
            }
        }
    }
    
    // Фоллбек на обычное скачивание
    downloadBlobSafely(blob, filename);
    return false;
}

/**
 * Парсер диапазонов страниц (поддерживает 1-indexed входные данные)
 */
function parsePageRanges(rangesStr, maxPages) {
    const pages = new Set();
    const parts = rangesStr.split(/[\s,]+/); // Разделение запятыми или пробелами
    
    for (const part of parts) {
        const range = part.trim();
        if (!range) continue;
        
        if (range.includes('-')) {
            const [startStr, endStr] = range.split('-');
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            if (!isNaN(start) && !isNaN(end) && start <= end) {
                for (let i = start; i <= end; i++) {
                    if (i >= 1 && i <= maxPages) pages.add(i - 1); // 0-indexed
                }
            }
        } else {
            const num = parseInt(range, 10);
            if (!isNaN(num) && num >= 1 && num <= maxPages) {
                pages.add(num - 1); // 0-indexed
            }
        }
    }
    return Array.from(pages).sort((a, b) => a - b);
}

/**
 * Форматирование байт в понятный вид (KB/MB)
 */
function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Конвертация изображения (JPG, PNG, WebP) в страницу PDF (A4)
 */
async function embedImageToPdf(pdfDoc, file) {
    const arrayBuffer = await file.arrayBuffer();
    let image = null;

    if (file.type === 'image/jpeg' || file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg')) {
        image = await pdfDoc.embedJpg(arrayBuffer);
    } else if (file.type === 'image/png' || file.name.toLowerCase().endsWith('.png')) {
        image = await pdfDoc.embedPng(arrayBuffer);
    } else {
        // Для WebP и прочих форматов конвертируем через временный Canvas
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    resolve(canvas.toDataURL('image/jpeg', 0.9));
                };
                img.onerror = reject;
                img.src = e.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        
        const jpgBytes = await fetch(dataUrl).then(res => res.arrayBuffer());
        image = await pdfDoc.embedJpg(jpgBytes);
    }

    // Добавляем страницу формата A4 (595.28 x 841.89 pt) и центрируем картинку
    const a4Size = PageSizes?.A4 || [595.28, 841.89];
    const page = pdfDoc.addPage(a4Size);
    const { width: pageWidth, height: pageHeight } = page.getSize();
    
    const imgDims = image.scaleToFit(pageWidth - 40, pageHeight - 40);
    
    page.drawImage(image, {
        x: (pageWidth - imgDims.width) / 2,
        y: (pageHeight - imgDims.height) / 2,
        width: imgDims.width,
        height: imgDims.height
    });
}

export async function init(docId) {
    console.log("Init PDF & Image Merge Tool", docId);
    
    const modalId = 'pdfmerge-modal';
    let modal = document.getElementById(modalId);
    
    if (!modal) {
        modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'fixed inset-0 bg-white z-[60] flex flex-col pt-safe select-none';
        modal.innerHTML = `
            <!-- Top App Bar -->
            <div class="h-14 flex-shrink-0 flex items-center justify-between px-4 bg-white border-b border-gray-200 shadow-sm">
                <button id="pdfmerge-close-btn" class="w-10 h-10 flex items-center justify-center text-gray-700 active:bg-gray-100 rounded-full transition-transform active:scale-95">
                    <i class="fas fa-arrow-left text-lg"></i>
                </button>
                <div class="flex flex-col items-center">
                    <h1 class="text-base font-bold text-gray-900 leading-tight">PDF & Receipts Tool</h1>
                    <span class="text-[10px] font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">100% Offline & Private</span>
                </div>
                <div class="w-10"></div>
            </div>
            
            <!-- Main Content Area -->
            <div class="flex-1 overflow-y-auto p-4 flex flex-col items-center bg-gray-50">
                
                <!-- Segmented Tabs -->
                <div class="flex w-full max-w-md bg-gray-200/80 p-1 rounded-xl mb-4 flex-shrink-0">
                    <button id="tab-merge" class="flex-1 py-2.5 rounded-lg bg-white font-bold shadow-sm text-xs sm:text-sm transition-all text-orange-600 flex items-center justify-center gap-1.5">
                        <i class="fas fa-object-group"></i> Merge (PDF + Photos)
                    </button>
                    <button id="tab-split" class="flex-1 py-2.5 rounded-lg text-gray-600 font-semibold text-xs sm:text-sm transition-all flex items-center justify-center gap-1.5 active:bg-gray-300">
                        <i class="fas fa-cut"></i> Split / Extract
                    </button>
                </div>
                
                <!-- MERGE TAB CONTENT -->
                <div id="area-merge" class="w-full max-w-md flex flex-col gap-3">
                    <!-- Upload Dropzone / Touch Box -->
                    <div id="merge-upload-box" class="p-5 border-2 border-dashed border-orange-300 rounded-2xl bg-orange-50/40 text-center cursor-pointer active:bg-orange-100/50 transition-colors flex flex-col items-center justify-center min-h-[130px]">
                        <div class="w-12 h-12 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center text-xl mb-2 shadow-inner">
                            <i class="fas fa-plus"></i>
                        </div>
                        <p class="text-sm font-bold text-gray-800 mb-0.5">Tap to Add Files</p>
                        <p class="text-xs text-gray-500 font-medium">Select multiple PDFs or Photos (M-Pesa, ID, Receipts)</p>
                        <input type="file" id="merge-input" multiple accept="application/pdf,image/jpeg,image/png,image/webp" class="hidden" />
                    </div>
                    
                    <!-- File Count & Total Size -->
                    <div id="merge-stats-bar" class="hidden flex items-center justify-between px-1 text-xs text-gray-500 font-medium">
                        <span id="merge-file-count">0 files added</span>
                        <span id="merge-total-size">Total: 0 KB</span>
                    </div>

                    <!-- Draggable / Orderable List -->
                    <div id="merge-file-list" class="flex flex-col gap-2 empty:hidden max-h-[42vh] overflow-y-auto pr-1"></div>
                    
                    <!-- Action Buttons Bar -->
                    <div class="flex flex-col gap-2 mt-2">
                        <div class="grid grid-cols-2 gap-2">
                            <button id="merge-share-btn" class="w-full bg-green-600 text-white font-bold py-3.5 px-3 rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center gap-2 text-sm" disabled>
                                <i class="fas fa-share-alt"></i> Share PDF
                            </button>
                            <button id="merge-download-btn" class="w-full bg-orange-600 text-white font-bold py-3.5 px-3 rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center gap-2 text-sm" disabled>
                                <i class="fas fa-download"></i> Save PDF
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- SPLIT / EXTRACT TAB CONTENT -->
                <div id="area-split" class="w-full max-w-md flex flex-col gap-3 hidden">
                    <!-- Upload Single PDF Box -->
                    <div id="split-upload-box" class="p-5 border-2 border-dashed border-gray-300 rounded-2xl bg-white text-center cursor-pointer active:bg-gray-100 transition-colors flex flex-col items-center justify-center min-h-[130px]">
                        <div class="w-12 h-12 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center text-xl mb-2">
                            <i class="fas fa-file-pdf"></i>
                        </div>
                        <p class="text-sm font-bold text-gray-800 mb-0.5">Select PDF to Split</p>
                        <p class="text-xs text-gray-500">Extract specific pages or delete unwanted ones</p>
                        <input type="file" id="split-input" accept="application/pdf" class="hidden" />
                    </div>
                    
                    <!-- Active File Info -->
                    <div id="split-file-info" class="p-3.5 bg-white border border-gray-200 rounded-xl flex items-center justify-between shadow-sm hidden">
                        <div class="flex items-center gap-3 overflow-hidden">
                            <div class="w-8 h-8 rounded-lg bg-red-100 text-red-600 flex items-center justify-center flex-shrink-0 text-sm">
                                <i class="fas fa-file-pdf"></i>
                            </div>
                            <div class="flex flex-col overflow-hidden">
                                <span class="text-xs font-bold text-gray-800 truncate" id="split-filename">doc.pdf</span>
                                <span class="text-[11px] text-gray-500 font-medium" id="split-pages-count">Total: 0 pages</span>
                            </div>
                        </div>
                        <button id="split-change-file-btn" class="text-xs font-semibold text-orange-600 px-2 py-1 bg-orange-50 rounded-lg active:bg-orange-100">
                            Change
                        </button>
                    </div>
                    
                    <!-- Mode Selector: Extract vs Delete -->
                    <div id="split-controls" class="flex flex-col gap-3 hidden bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
                        <div class="flex items-center justify-between border-b border-gray-100 pb-2.5">
                            <label class="text-xs font-bold text-gray-700">Action Mode:</label>
                            <div class="flex gap-1 bg-gray-100 p-0.5 rounded-lg text-xs">
                                <button id="mode-extract" class="px-2.5 py-1 rounded-md bg-white font-bold text-orange-600 shadow-xs">Extract</button>
                                <button id="mode-delete" class="px-2.5 py-1 rounded-md text-gray-600 font-medium">Remove</button>
                            </div>
                        </div>

                        <!-- Quick Presets -->
                        <div class="flex flex-col gap-1.5">
                            <span class="text-[11px] font-semibold text-gray-500">Quick 1-Tap Presets:</span>
                            <div class="flex flex-wrap gap-1.5" id="split-presets-container">
                                <button type="button" class="preset-pill text-xs px-2.5 py-1 bg-gray-100 rounded-lg font-medium text-gray-700 active:bg-orange-100 active:text-orange-700" data-val="1">Page 1 Only</button>
                                <button type="button" class="preset-pill text-xs px-2.5 py-1 bg-gray-100 rounded-lg font-medium text-gray-700 active:bg-orange-100 active:text-orange-700" data-val="1-2">Pages 1–2</button>
                                <button type="button" class="preset-pill text-xs px-2.5 py-1 bg-gray-100 rounded-lg font-medium text-gray-700 active:bg-orange-100 active:text-orange-700" data-val="first-half">First Half</button>
                            </div>
                        </div>
                        
                        <!-- Manual Range Input -->
                        <div class="flex flex-col gap-1 mt-1">
                            <label id="split-input-label" class="text-xs font-bold text-gray-700">Pages to extract:</label>
                            <input type="text" id="split-pages" placeholder="e.g. 1, 3-5, 8" class="w-full p-3 border border-gray-300 rounded-xl text-sm outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500" />
                            <p class="text-[11px] text-gray-400">Separate page numbers or ranges with commas.</p>
                        </div>
                    </div>
                    
                    <!-- Split Action Button -->
                    <button id="split-btn" class="w-full bg-orange-600 text-white font-bold py-3.5 rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-40 disabled:pointer-events-none mt-1 flex items-center justify-center gap-2 text-sm" disabled>
                        <i class="fas fa-file-export"></i> Process & Save
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // --- DOM Elements ---
        const tabMerge = document.getElementById('tab-merge');
        const tabSplit = document.getElementById('tab-split');
        const areaMerge = document.getElementById('area-merge');
        const areaSplit = document.getElementById('area-split');
        const closeBtn = document.getElementById('pdfmerge-close-btn');

        // Tab Switching
        tabMerge.addEventListener('click', () => {
            tabMerge.className = "flex-1 py-2.5 rounded-lg bg-white font-bold shadow-sm text-xs sm:text-sm transition-all text-orange-600 flex items-center justify-center gap-1.5";
            tabSplit.className = "flex-1 py-2.5 rounded-lg text-gray-600 font-semibold text-xs sm:text-sm transition-all flex items-center justify-center gap-1.5 active:bg-gray-300";
            areaMerge.classList.remove('hidden');
            areaSplit.classList.add('hidden');
        });
        
        tabSplit.addEventListener('click', () => {
            tabSplit.className = "flex-1 py-2.5 rounded-lg bg-white font-bold shadow-sm text-xs sm:text-sm transition-all text-orange-600 flex items-center justify-center gap-1.5";
            tabMerge.className = "flex-1 py-2.5 rounded-lg text-gray-600 font-semibold text-xs sm:text-sm transition-all flex items-center justify-center gap-1.5 active:bg-gray-300";
            areaSplit.classList.remove('hidden');
            areaMerge.classList.add('hidden');
        });

        closeBtn.addEventListener('click', () => {
            modal.classList.add('hidden');
        });

        // ==========================================
        // MERGE LOGIC (PDF + Images + Reordering)
        // ==========================================
        let mergeFiles = []; // Array of File objects
        const mergeUploadBox = document.getElementById('merge-upload-box');
        const mergeInput = document.getElementById('merge-input');
        const mergeFileList = document.getElementById('merge-file-list');
        const mergeStatsBar = document.getElementById('merge-stats-bar');
        const mergeFileCount = document.getElementById('merge-file-count');
        const mergeTotalSize = document.getElementById('merge-total-size');
        const mergeDownloadBtn = document.getElementById('merge-download-btn');
        const mergeShareBtn = document.getElementById('merge-share-btn');

        mergeUploadBox.addEventListener('click', () => mergeInput.click());
        
        mergeInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files.length > 0) {
                const newFiles = Array.from(e.target.files).filter(f => 
                    f.type === 'application/pdf' || f.type.startsWith('image/')
                );
                mergeFiles = mergeFiles.concat(newFiles);
                renderMergeList();
                mergeInput.value = ''; // Reset input to allow re-selecting same files
            }
        });

        function renderMergeList() {
            mergeFileList.innerHTML = '';
            
            if (mergeFiles.length === 0) {
                mergeStatsBar.classList.add('hidden');
                mergeDownloadBtn.disabled = true;
                mergeShareBtn.disabled = true;
                return;
            }

            mergeStatsBar.classList.remove('hidden');
            mergeFileCount.innerText = `${mergeFiles.length} item${mergeFiles.length > 1 ? 's' : ''}`;
            const totalBytes = mergeFiles.reduce((sum, f) => sum + f.size, 0);
            mergeTotalSize.innerText = `Total: ${formatFileSize(totalBytes)}`;
            
            mergeFiles.forEach((file, index) => {
                const isImage = file.type.startsWith('image/');
                const iconClass = isImage ? 'fa-image text-blue-500' : 'fa-file-pdf text-orange-500';
                
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-2.5 bg-white border border-gray-200 rounded-xl shadow-xs';
                item.innerHTML = `
                    <div class="flex items-center gap-2.5 overflow-hidden flex-1 min-w-0 pr-2">
                        <div class="flex-shrink-0 w-7 h-7 bg-gray-100 text-gray-700 rounded-lg flex items-center justify-center font-bold text-xs">
                            ${index + 1}
                        </div>
                        <div class="flex items-center gap-2 overflow-hidden min-w-0">
                            <i class="fas ${iconClass} text-base flex-shrink-0"></i>
                            <div class="flex flex-col min-w-0">
                                <span class="text-xs font-semibold text-gray-800 truncate">${file.name}</span>
                                <span class="text-[10px] text-gray-400">${formatFileSize(file.size)}</span>
                            </div>
                        </div>
                    </div>

                    <!-- Action Controls: Reorder & Remove -->
                    <div class="flex items-center gap-1 flex-shrink-0">
                        <button class="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-gray-900 active:bg-gray-100 rounded-lg ${index === 0 ? 'opacity-30 pointer-events-none' : ''}" data-action="up" data-idx="${index}">
                            <i class="fas fa-chevron-up text-xs"></i>
                        </button>
                        <button class="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-gray-900 active:bg-gray-100 rounded-lg ${index === mergeFiles.length - 1 ? 'opacity-30 pointer-events-none' : ''}" data-action="down" data-idx="${index}">
                            <i class="fas fa-chevron-down text-xs"></i>
                        </button>
                        <button class="w-8 h-8 flex items-center justify-center text-red-500 active:bg-red-50 rounded-lg" data-action="delete" data-idx="${index}">
                            <i class="fas fa-trash-alt text-xs"></i>
                        </button>
                    </div>
                `;
                mergeFileList.appendChild(item);
            });

            // Делегирование событий на список для оптимизации памяти
            mergeFileList.onclick = (e) => {
                const btn = e.target.closest('button[data-action]');
                if (!btn) return;
                const idx = parseInt(btn.dataset.idx, 10);
                const action = btn.dataset.action;

                if (action === 'up' && idx > 0) {
                    const temp = mergeFiles[idx];
                    mergeFiles[idx] = mergeFiles[idx - 1];
                    mergeFiles[idx - 1] = temp;
                    renderMergeList();
                } else if (action === 'down' && idx < mergeFiles.length - 1) {
                    const temp = mergeFiles[idx];
                    mergeFiles[idx] = mergeFiles[idx + 1];
                    mergeFiles[idx + 1] = temp;
                    renderMergeList();
                } else if (action === 'delete') {
                    mergeFiles.splice(idx, 1);
                    renderMergeList();
                }
            };
            
            // Кнопка активна, если есть хотя бы 1 файл (даже 1 фото можно сконвертировать в PDF)
            const canProcess = mergeFiles.length >= 1;
            mergeDownloadBtn.disabled = !canProcess;
            mergeShareBtn.disabled = !canProcess;
        }

        async function processAndMerge() {
            if (mergeFiles.length === 0) return null;
            await ensurePdfLib();
            
            const mergedPdf = await PDFDocument.create();
            
            for (let i = 0; i < mergeFiles.length; i++) {
                const file = mergeFiles[i];
                try {
                    if (file.type.startsWith('image/')) {
                        await embedImageToPdf(mergedPdf, file);
                    } else {
                        let arrayBuffer = await file.arrayBuffer();
                        const sourcePdf = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
                        const pageIndices = sourcePdf.getPageIndices();
                        const copiedPages = await mergedPdf.copyPages(sourcePdf, pageIndices);
                        
                        copiedPages.forEach((page) => mergedPdf.addPage(page));
                        
                        // Ручное освобождение ссылок для сборщика мусора
                        arrayBuffer = null;
                    }
                } catch (err) {
                    console.error(`Error processing file ${file.name}:`, err);
                    throw new Error(`Failed to process "${file.name}". It may be password protected.`);
                }
            }
            
            const pdfBytes = await mergedPdf.save();
            return pdfBytes;
        }

        // Кнопка "Сохранить PDF"
        mergeDownloadBtn.addEventListener('click', async () => {
            mergeDownloadBtn.disabled = true;
            mergeShareBtn.disabled = true;
            const originalText = mergeDownloadBtn.innerHTML;
            mergeDownloadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Merging...';
            
            try {
                if (window.showToast) window.showToast('Generating PDF...', false);
                const bytes = await processAndMerge();
                if (!bytes) return;

                const filename = `Merged_${new Date().toISOString().slice(0, 10)}.pdf`;
                downloadBlobSafely(new Blob([bytes], { type: 'application/pdf' }), filename);
                
                if (window.showToast) window.showToast('PDF downloaded successfully!', false);
                saveToRecent(filename);
            } catch (err) {
                console.error("Merge error", err);
                if (window.showToast) window.showToast(err.message || 'Failed to merge files.', true);
            } finally {
                mergeDownloadBtn.disabled = false;
                mergeShareBtn.disabled = false;
                mergeDownloadBtn.innerHTML = originalText;
            }
        });

        // Кнопка "Поделиться в WhatsApp"
        mergeShareBtn.addEventListener('click', async () => {
            mergeDownloadBtn.disabled = true;
            mergeShareBtn.disabled = true;
            const originalText = mergeShareBtn.innerHTML;
            mergeShareBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Readying...';
            
            try {
                const bytes = await processAndMerge();
                if (!bytes) return;

                const filename = `Doc_${new Date().toISOString().slice(0, 10)}.pdf`;
                await sharePdfFile(bytes, filename);
                saveToRecent(filename);
            } catch (err) {
                console.error("Share error", err);
                if (window.showToast) window.showToast('Failed to share PDF.', true);
            } finally {
                mergeDownloadBtn.disabled = false;
                mergeShareBtn.disabled = false;
                mergeShareBtn.innerHTML = originalText;
            }
        });

        // ==========================================
        // SPLIT / EXTRACT LOGIC
        // ==========================================
        let splitFile = null;
        let splitTotalPages = 0;
        let splitMode = 'extract'; // 'extract' | 'delete'

        const splitUploadBox = document.getElementById('split-upload-box');
        const splitInput = document.getElementById('split-input');
        const splitFileInfo = document.getElementById('split-file-info');
        const splitFilename = document.getElementById('split-filename');
        const splitPagesCount = document.getElementById('split-pages-count');
        const splitControls = document.getElementById('split-controls');
        const splitPages = document.getElementById('split-pages');
        const splitInputLabel = document.getElementById('split-input-label');
        const splitBtn = document.getElementById('split-btn');
        const splitChangeFileBtn = document.getElementById('split-change-file-btn');
        const modeExtractBtn = document.getElementById('mode-extract');
        const modeDeleteBtn = document.getElementById('mode-delete');
        const presetsContainer = document.getElementById('split-presets-container');

        splitUploadBox.addEventListener('click', () => splitInput.click());
        splitChangeFileBtn.addEventListener('click', () => splitInput.click());

        // Переключение режимов Extract / Delete
        modeExtractBtn.addEventListener('click', () => {
            splitMode = 'extract';
            modeExtractBtn.className = "px-2.5 py-1 rounded-md bg-white font-bold text-orange-600 shadow-xs";
            modeDeleteBtn.className = "px-2.5 py-1 rounded-md text-gray-600 font-medium";
            splitInputLabel.innerText = "Pages to keep / extract:";
            splitBtn.innerHTML = '<i class="fas fa-file-export"></i> Extract & Save';
        });

        modeDeleteBtn.addEventListener('click', () => {
            splitMode = 'delete';
            modeDeleteBtn.className = "px-2.5 py-1 rounded-md bg-white font-bold text-orange-600 shadow-xs";
            modeExtractBtn.className = "px-2.5 py-1 rounded-md text-gray-600 font-medium";
            splitInputLabel.innerText = "Pages to remove / delete:";
            splitBtn.innerHTML = '<i class="fas fa-trash-alt"></i> Remove & Save';
        });

        // 1-Tap Presets
        presetsContainer.addEventListener('click', (e) => {
            const pill = e.target.closest('.preset-pill');
            if (!pill || !splitTotalPages) return;
            const val = pill.dataset.val;

            if (val === '1') {
                splitPages.value = '1';
            } else if (val === '1-2') {
                splitPages.value = splitTotalPages >= 2 ? '1-2' : '1';
            } else if (val === 'first-half') {
                const half = Math.max(1, Math.floor(splitTotalPages / 2));
                splitPages.value = `1-${half}`;
            }
            splitBtn.disabled = false;
        });

        splitInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file && file.type === 'application/pdf') {
                splitFile = file;
                splitFilename.innerText = file.name;
                splitFileInfo.classList.remove('hidden');
                splitUploadBox.classList.add('hidden');
                splitControls.classList.remove('hidden');
                
                try {
                    await ensurePdfLib();
                    const arrayBuffer = await file.arrayBuffer();
                    const pdf = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
                    splitTotalPages = pdf.getPageCount();
                    splitPagesCount.innerText = `Total: ${splitTotalPages} page${splitTotalPages > 1 ? 's' : ''} (${formatFileSize(file.size)})`;
                    splitPages.placeholder = `e.g. 1, 3-${Math.min(splitTotalPages, 5)}`;
                    splitPages.value = '1'; // По умолчанию выделяем 1-ю страницу
                    splitBtn.disabled = false;
                } catch (err) {
                    console.error("Failed to read PDF page count", err);
                    splitTotalPages = 999;
                    splitPagesCount.innerText = `File loaded (${formatFileSize(file.size)})`;
                    splitBtn.disabled = false;
                }
            }
        });
        
        splitPages.addEventListener('input', () => {
            splitBtn.disabled = splitPages.value.trim().length === 0;
        });

        splitBtn.addEventListener('click', async () => {
            if (!splitFile) return;
            const rangesStr = splitPages.value.trim();
            if (!rangesStr) return;
            
            splitBtn.disabled = true;
            const originalHtml = splitBtn.innerHTML;
            splitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
            
            try {
                if (window.showToast) window.showToast('Processing PDF...', false);
                await ensurePdfLib();
                
                let arrayBuffer = await splitFile.arrayBuffer();
                const sourcePdf = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
                const actualTotalPages = sourcePdf.getPageCount();
                
                const specifiedIndices = parsePageRanges(rangesStr, actualTotalPages);
                
                if (specifiedIndices.length === 0) {
                    throw new Error("Invalid page numbers specified.");
                }

                let finalIndicesToCopy = [];
                if (splitMode === 'extract') {
                    finalIndicesToCopy = specifiedIndices;
                } else {
                    // Режим удаления: берем все страницы, кроме указанных
                    finalIndicesToCopy = Array.from({ length: actualTotalPages }, (_, i) => i)
                        .filter(i => !specifiedIndices.includes(i));
                }
                
                if (finalIndicesToCopy.length === 0) {
                    throw new Error("No pages left after removal.");
                }
                
                const newPdf = await PDFDocument.create();
                const copiedPages = await newPdf.copyPages(sourcePdf, finalIndicesToCopy);
                copiedPages.forEach((page) => newPdf.addPage(page));
                
                const splitPdfBytes = await newPdf.save();
                const filename = `Extracted_${splitFile.name.replace('.pdf', '')}.pdf`;
                
                downloadBlobSafely(new Blob([splitPdfBytes], { type: 'application/pdf' }), filename);
                
                if (window.showToast) window.showToast('Document saved successfully!', false);
                saveToRecent(filename);
                
                // Очистка памяти
                arrayBuffer = null;
            } catch (err) {
                console.error("Split error", err);
                if (window.showToast) window.showToast(err.message || 'Failed to split PDF.', true);
            } finally {
                splitBtn.disabled = false;
                splitBtn.innerHTML = originalHtml;
            }
        });

        function saveToRecent(title) {
            try {
                const idxStr = localStorage.getItem('kivu_docs_index');
                let docs = idxStr ? JSON.parse(idxStr) : [];
                const newDocId = 'pdfm_' + Date.now();
                docs.unshift({
                    id: newDocId,
                    title: title,
                    type: 'pdfmerge',
                    updatedAt: Date.now()
                });
                // Ограничиваем список последних файлов до 30 записей во избежание переполнения localStorage
                if (docs.length > 30) docs = docs.slice(0, 30);
                localStorage.setItem('kivu_docs_index', JSON.stringify(docs));
                if (window.renderMyDocuments) {
                    window.renderMyDocuments();
                }
            } catch (e) {
                console.warn('Could not save to recent index', e);
            }
        }
    }
    
    modal.classList.remove('hidden');
}