// src/modules/tools/powerpoint.js

const PPT_STORAGE_KEY_PREFIX = 'kivu_doc_';
const PPT_DOCS_INDEX = 'kivu_docs_index';

let currentDocId = null;
let slides = [];
let currentSlideIndex = 0;

// Tracks which free-text element (added via "Add Text") currently has focus,
// so the formatting toolbar (bold/italic/size/etc.) can be applied to that
// specific element instead of always falling back to the slide's placeholder
// title/body text.
let selectedElementIndex = null;
// Live DOM references (textDiv) for the current slide's text elements, indexed
// to match slides[currentSlideIndex].elements. Rebuilt on every renderSlide().
let elementDomRefs = [];

// Debounce timer for saving state
let saveTimeout = null;

// Present mode state
let isPresenting = false;
let presentControlsTimeout = null;
let presentKeydownHandler = null;

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isSafeImageSrc(src) {
  if (!src || typeof src !== 'string') return false;
  const s = src.trim().toLowerCase();
  return (
    s.startsWith('data:image/') ||
    s.startsWith('http://') ||
    s.startsWith('https://') ||
    s.startsWith('blob:') ||
    s.startsWith('/')
  );
}

function getDocsIndex() {
  try {
    const idx = localStorage.getItem(PPT_DOCS_INDEX);
    return idx ? JSON.parse(idx) : [];
  } catch (e) {
    return [];
  }
}

function saveDocsIndex(index) {
  try {
    localStorage.setItem(PPT_DOCS_INDEX, JSON.stringify(index));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast('Storage limit reached! Please free up space.', true);
      }
      throw e;
    }
  }
}

export function getMyDocuments() {
  return getDocsIndex();
}

export function deleteDocument(id) {
  flushSave();
  localStorage.removeItem(PPT_STORAGE_KEY_PREFIX + id);
  const idx = getDocsIndex().filter(d => d.id !== id);
  saveDocsIndex(idx);
  if (typeof window !== 'undefined' && typeof window.renderMyDocuments === 'function') {
    window.renderMyDocuments();
  }
}

/**
 * Normalizes CSS colors (hex, rgb/rgba, hsl/hsla, named, linear-gradient) to a 6-character hex code for PptxGenJS.
 * Prevents PPTX generation crashes from CSS linear gradients or malformed strings.
 */
export function normalizePptxColor(colorStr, fallback = 'FFFFFF') {
  if (!colorStr || typeof colorStr !== 'string') return fallback;
  const str = colorStr.trim();

  const namedColors = {
    white: 'FFFFFF',
    black: '000000',
    red: 'EF4444',
    green: '10B981',
    blue: '3B82F6',
    yellow: 'F59E0B',
    gray: '6B7280',
    grey: '6B7280',
    purple: '8B5CF6',
    pink: 'EC4899',
    indigo: '6366F1',
    teal: '14B8A6',
    cyan: '06B6D4',
    orange: 'F97316',
    slate: '64748B',
    transparent: 'FFFFFF'
  };

  // If linear gradient, extract the first stop color
  if (str.includes('gradient')) {
    const hexMatch = str.match(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})/);
    if (hexMatch) {
      return expandHex(hexMatch[1]);
    }
    const rgbMatch = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (rgbMatch) {
      return rgbToHex(Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3]));
    }
    const hslMatch = str.match(/hsla?\((\d+),\s*(\d+)%?,\s*(\d+)%?/);
    if (hslMatch) {
      return hslToHex(Number(hslMatch[1]), Number(hslMatch[2]), Number(hslMatch[3]));
    }
    const namedKeys = Object.keys(namedColors).join('|');
    const namedMatch = str.match(new RegExp(`\\b(${namedKeys})\\b`, 'i'));
    if (namedMatch) {
      return namedColors[namedMatch[1].toLowerCase()];
    }
  }

  // If starts with #
  if (str.startsWith('#')) {
    const raw = str.slice(1);
    return expandHex(raw);
  }

  // If rgb/rgba
  const rgbMatch = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbMatch) {
    return rgbToHex(Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3]));
  }

  // If hsl/hsla
  const hslMatch = str.match(/hsla?\((\d+),\s*(\d+)%?,\s*(\d+)%?/);
  if (hslMatch) {
    return hslToHex(Number(hslMatch[1]), Number(hslMatch[2]), Number(hslMatch[3]));
  }

  // If raw hex (8, 6, 4, or 3 chars)
  if (/^[0-9a-fA-F]{3,8}$/.test(str)) {
    return expandHex(str);
  }

  if (namedColors[str.toLowerCase()]) {
    return namedColors[str.toLowerCase()];
  }

  return fallback;
}

function expandHex(hex) {
  if (!hex || typeof hex !== 'string') return 'FFFFFF';
  const clean = hex.replace(/^#/, '');
  if (clean.length === 3) {
    return (clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]).toUpperCase();
  }
  if (clean.length === 4) {
    return (clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]).toUpperCase();
  }
  if (clean.length === 6) {
    return clean.toUpperCase();
  }
  if (clean.length === 8) {
    return clean.slice(0, 6).toUpperCase();
  }
  return 'FFFFFF';
}

function rgbToHex(r, g, b) {
  return [r, g, b].map(x => {
    const h = Math.max(0, Math.min(255, x)).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('').toUpperCase();
}

function hslToHex(h, s, l) {
  l = Number(l) / 100;
  const a = (Number(s) * Math.min(l, 1 - l)) / 100;
  const f = n => {
    const k = (n + Number(h) / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

/**
 * Format image source for PptxGenJS (converts unencoded SVGs and data URLs to valid base64 image data)
 */
export function formatPptxImageData(src) {
  if (!src || typeof src !== 'string' || !isSafeImageSrc(src)) return null;
  if (src.startsWith('data:image')) {
    if (src.includes(';base64,')) {
      return { data: src };
    }
    try {
      const commaIdx = src.indexOf(',');
      if (commaIdx !== -1) {
        const header = src.slice(0, commaIdx);
        const mime = header.split(';')[0].replace('data:', '') || 'image/png';
        const rawContent = decodeURIComponent(src.slice(commaIdx + 1));
        const b64 = (typeof Buffer !== 'undefined')
          ? Buffer.from(rawContent).toString('base64')
          : (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(rawContent))) : null);
        if (b64) {
          return { data: `${mime};base64,${b64}` };
        }
      }
    } catch (_) {}
    return { data: src };
  }
  return { path: src };
}

/**
 * Client-side Canvas Image Compression & Resizing (Under 100-150KB)
 * Preserves alpha transparency for PNG / WEBP / SVG inputs while compressing JPEGs with white fill.
 */
export async function compressImage(fileOrDataUrl, maxWidth = 1200, maxHeight = 900, quality = 0.75) {
  if (!fileOrDataUrl) return null;
  if (typeof fileOrDataUrl === 'string' && fileOrDataUrl.startsWith('data:image/svg') && fileOrDataUrl.length < 150000) {
    return fileOrDataUrl;
  }
  const ImageClass = (typeof Image !== 'undefined') ? Image : (typeof globalThis !== 'undefined' && globalThis.Image ? globalThis.Image : null);
  if (!ImageClass || typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return typeof fileOrDataUrl === 'string' ? fileOrDataUrl : null;
  }

  const isTransparent = (
    (typeof fileOrDataUrl === 'string' && (
      fileOrDataUrl.startsWith('data:image/png') ||
      fileOrDataUrl.startsWith('data:image/webp') ||
      fileOrDataUrl.startsWith('data:image/svg') ||
      fileOrDataUrl.includes('.png') ||
      fileOrDataUrl.includes('.svg')
    )) ||
    (fileOrDataUrl && fileOrDataUrl.type && (
      fileOrDataUrl.type === 'image/png' ||
      fileOrDataUrl.type === 'image/webp' ||
      fileOrDataUrl.type === 'image/svg+xml'
    ))
  );

  return new Promise((resolve) => {
    let finished = false;
    const done = (val) => {
      if (finished) return;
      finished = true;
      if (safetyTimer) clearTimeout(safetyTimer);
      resolve(val);
    };

    const safetyTimer = setTimeout(() => {
      done(typeof fileOrDataUrl === 'string' ? fileOrDataUrl : null);
    }, 3000);
    if (safetyTimer && typeof safetyTimer.unref === 'function') {
      safetyTimer.unref();
    }

    const img = new ImageClass();
    img.onload = () => {
      let w = img.naturalWidth || img.width || 800;
      let h = img.naturalHeight || img.height || 600;
      if (w > maxWidth || h > maxHeight) {
        const ratio = Math.min(maxWidth / w, maxHeight / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, w);
      canvas.height = Math.max(1, h);
      const ctx = canvas.getContext ? canvas.getContext('2d') : null;
      if (ctx && typeof canvas.toDataURL === 'function') {
        try {
          if (isTransparent) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
          } else {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }

          if (typeof ctx.drawImage === 'function') {
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          }

          if (isTransparent) {
            let compressedDataUrl = null;
            try {
              compressedDataUrl = canvas.toDataURL('image/webp', quality);
            } catch (_) {}

            if (compressedDataUrl && compressedDataUrl.startsWith('data:image/webp')) {
              done(compressedDataUrl);
            } else {
              done(canvas.toDataURL('image/png') || img.src);
            }
          } else {
            const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
            done(compressedDataUrl || img.src);
          }
        } catch (e) {
          done(img.src);
        }
      } else {
        done(img.src);
      }
    };
    img.onerror = () => {
      if (typeof fileOrDataUrl === 'string') done(fileOrDataUrl);
      else done(null);
    };

    if (typeof fileOrDataUrl === 'string') {
      img.src = fileOrDataUrl;
      if (typeof img.onload === 'function' && typeof img.naturalWidth !== 'number') {
        try { img.onload(); } catch (_) {}
      }
    } else if (typeof Blob !== 'undefined' && (fileOrDataUrl instanceof Blob || (typeof File !== 'undefined' && fileOrDataUrl instanceof File))) {
      const reader = new FileReader();
      reader.onload = (e) => {
        img.src = e.target.result;
        if (typeof img.onload === 'function' && typeof img.naturalWidth !== 'number') {
          try { img.onload(); } catch (_) {}
        }
      };
      reader.onerror = () => done(null);
      reader.readAsDataURL(fileOrDataUrl);
    } else {
      done(null);
    }
  });
}

const pptEditorHtml = `
<div id="ppt-editor-modal" class="hidden flex flex-col overflow-hidden transition-transform transform translate-y-full select-none" style="position: fixed; inset: 0; background-color: #0f172a !important; z-index: 99999 !important;">
    <!-- Header (Top App Bar - Fixed 1-Row Layout) -->
    <div class="h-14 flex-shrink-0 flex items-center justify-between px-3 text-white z-50 shadow-md relative" style="background-color: #1e293b !important; border-bottom: 1px solid #334155 !important;">
        <!-- Left: Back button & Document title -->
        <div class="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
            <button id="close-ppt-btn" class="w-9 h-9 flex-shrink-0 flex items-center justify-center text-gray-200 hover:text-white rounded-xl active:scale-90 transition-all" style="background-color: #334155 !important; min-width: 36px; min-height: 36px;" title="Close">
                <i class="fas fa-arrow-left text-sm"></i>
            </button>
            <div class="flex flex-col min-w-0 flex-1 max-w-[150px] xs:max-w-[190px] sm:max-w-xs md:max-w-md">
                <input type="text" id="ppt-doc-title" value="Untitled Presentation" class="text-sm sm:text-base font-bold bg-transparent border-none focus:ring-0 focus:outline-none text-white truncate placeholder-gray-400 p-0 leading-tight w-full outline-none" />
                <span id="ppt-save-status" class="text-[10px] text-gray-400 font-medium leading-none mt-0.5 truncate">Saved locally</span>
            </div>
        </div>

        <!-- Center: Desktop Ribbon / Landscape Tools (Hidden on mobile portrait, shown on md:) -->
        <div id="ppt-desktop-toolbar" class="hidden md:flex items-center gap-1 rounded-xl p-1 shadow-sm flex-shrink-0 mx-2" style="background-color: #1e293b !important; border: 1px solid #334155 !important;">
            <button id="btn-ppt-add-slide" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-lg active:scale-95 transition-all" title="Add New Slide">
                <i class="fas fa-plus-square text-sm"></i>
            </button>
            <button id="btn-ppt-dup-slide" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-lg active:scale-95 transition-all" title="Duplicate Current Slide">
                <i class="fas fa-clone text-sm"></i>
            </button>
            <button id="btn-ppt-move-up" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-lg active:scale-95 transition-all" title="Move Slide Up">
                <i class="fas fa-arrow-up text-xs"></i>
            </button>
            <button id="btn-ppt-move-down" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-lg active:scale-95 transition-all" title="Move Slide Down">
                <i class="fas fa-arrow-down text-xs"></i>
            </button>
            <div class="w-px h-5 mx-0.5" style="background-color: #334155 !important;"></div>
            <button id="btn-ppt-add-text" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-lg active:scale-95 transition-all" title="Add Free Text Block">
                <i class="fas fa-font text-sm"></i>
            </button>
            <button id="btn-ppt-add-image" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-lg active:scale-95 transition-all" title="Add Image">
                <i class="fas fa-image text-sm"></i>
            </button>
            <button id="btn-ppt-theme" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-lg active:scale-95 transition-all" title="Change Theme Style">
                <i class="fas fa-palette text-sm"></i>
            </button>
            <div class="w-px h-5 mx-0.5" style="background-color: #334155 !important;"></div>
            <button id="btn-ppt-del-slide" class="w-8 h-8 flex items-center justify-center text-red-400 hover:bg-slate-700 hover:text-red-300 rounded-lg active:scale-95 transition-all" title="Delete Slide">
                <i class="fas fa-trash-alt text-sm"></i>
            </button>
        </div>

        <!-- Right: Action Buttons -->
        <div class="flex items-center gap-2 flex-shrink-0 relative">
            <button id="btn-ppt-present" class="w-9 h-9 sm:w-auto sm:px-3 sm:py-1.5 flex-shrink-0 text-white rounded-xl text-xs font-semibold flex items-center justify-center sm:gap-1.5 active:scale-95 transition-transform shadow-sm" style="background-color: #2563eb !important; min-width: 36px; min-height: 36px;" title="Presentation Mode (Fullscreen)">
                <i class="fas fa-play text-[11px]"></i> <span class="hidden sm:inline">Present</span>
            </button>
            <button id="btn-ppt-toggle-sidebar" class="w-9 h-9 sm:w-auto sm:px-3 sm:py-1.5 flex-shrink-0 text-gray-200 rounded-xl text-xs font-semibold flex items-center justify-center sm:gap-1.5 active:scale-95 transition-colors shadow-sm" style="background-color: #334155 !important; border: 1px solid #475569 !important; min-width: 36px; min-height: 36px;" title="Toggle Slide Thumbnails">
                <i class="fas fa-layer-group text-xs"></i> <span class="hidden md:inline">Slides</span>
            </button>
            
            <!-- Desktop Import / Export Buttons (hidden on mobile < md) -->
            <button id="ppt-file-btn-import" class="hidden md:flex h-9 px-2.5 flex-shrink-0 text-gray-200 rounded-xl text-xs font-semibold items-center gap-1 active:scale-95 transition-colors shadow-sm" style="background-color: #334155 !important; border: 1px solid #475569 !important;" title="Import (.kivupres, .json, .pptx)">
                <i class="fas fa-file-import text-cyan-400 text-xs"></i> <span>Import</span>
            </button>
            <button id="ppt-file-btn-top" class="hidden md:flex h-9 px-2.5 flex-shrink-0 text-gray-200 rounded-xl text-xs font-semibold items-center gap-1 active:scale-95 transition-colors shadow-sm" style="background-color: #334155 !important; border: 1px solid #475569 !important;" title="Export PDF">
                <i class="fas fa-file-pdf text-red-400 text-xs"></i> <span>PDF</span>
            </button>
            <button id="btn-ppt-export-pptx" class="hidden md:flex h-9 px-2.5 flex-shrink-0 text-gray-200 rounded-xl text-xs font-semibold items-center gap-1 active:scale-95 transition-colors shadow-sm" style="background-color: #334155 !important; border: 1px solid #475569 !important;" title="Export PPTX">
                <i class="fas fa-file-powerpoint text-orange-400 text-xs"></i> <span>PPTX</span>
            </button>
            <button id="btn-ppt-export-native" class="hidden md:flex h-9 px-2.5 flex-shrink-0 text-gray-200 rounded-xl text-xs font-semibold items-center gap-1 active:scale-95 transition-colors shadow-sm" style="background-color: #334155 !important; border: 1px solid #475569 !important;" title="Export Native Presentation (.kivupres)">
                <i class="fas fa-download text-emerald-400 text-xs"></i> <span>JSON</span>
            </button>
            <button id="btn-ppt-share" class="hidden md:flex h-9 px-2.5 flex-shrink-0 text-white rounded-xl text-xs font-semibold items-center gap-1.5 active:scale-95 transition-colors shadow-sm" style="background-color: #4f46e5 !important;" title="Share via Apps">
                <i class="fas fa-share-alt text-xs"></i> <span>Share</span>
            </button>

            <!-- Mobile More Menu Trigger (visible on < md) -->
            <button id="btn-ppt-more-menu" class="md:hidden w-9 h-9 flex-shrink-0 flex items-center justify-center text-gray-200 rounded-xl text-xs active:scale-95 transition-colors shadow-sm" style="background-color: #334155 !important; border: 1px solid #475569 !important; min-width: 36px; min-height: 36px;" title="More Options">
                <i class="fas fa-ellipsis-v text-sm"></i>
            </button>

            <!-- Mobile Action Dropdown Sheet -->
            <div id="ppt-more-dropdown" class="hidden absolute right-0 w-56 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.8)] py-1.5 z-[9999] flex flex-col gap-0.5" style="top: calc(100% + 8px); background-color: #1e293b !important; border: 1px solid #475569 !important;">
                <button id="btn-ppt-menu-import" class="w-full px-3.5 py-2.5 text-left text-xs font-medium text-gray-200 hover:bg-slate-700 flex items-center gap-3 active:bg-slate-600 transition-colors rounded-lg">
                    <i class="fas fa-file-import text-cyan-400 w-4 text-center text-sm"></i> <span>Import File (.pptx, .json)</span>
                </button>
                <button id="btn-ppt-menu-pdf" class="w-full px-3.5 py-2.5 text-left text-xs font-medium text-gray-200 hover:bg-slate-700 flex items-center gap-3 active:bg-slate-600 transition-colors rounded-lg">
                    <i class="fas fa-file-pdf text-red-400 w-4 text-center text-sm"></i> <span>Export PDF</span>
                </button>
                <button id="btn-ppt-menu-pptx" class="w-full px-3.5 py-2.5 text-left text-xs font-medium text-gray-200 hover:bg-slate-700 flex items-center gap-3 active:bg-slate-600 transition-colors rounded-lg">
                    <i class="fas fa-file-powerpoint text-orange-400 w-4 text-center text-sm"></i> <span>Export PPTX</span>
                </button>
                <button id="btn-ppt-menu-native" class="w-full px-3.5 py-2.5 text-left text-xs font-medium text-gray-200 hover:bg-slate-700 flex items-center gap-3 active:bg-slate-600 transition-colors rounded-lg">
                    <i class="fas fa-download text-emerald-400 w-4 text-center text-sm"></i> <span>Export Native (.kivupres)</span>
                </button>
                <button id="btn-ppt-menu-share" class="w-full px-3.5 py-2.5 text-left text-xs font-medium text-gray-200 hover:bg-slate-700 flex items-center gap-3 active:bg-slate-600 transition-colors rounded-lg">
                    <i class="fas fa-share-alt text-indigo-400 w-4 text-center text-sm"></i> <span>Share Presentation</span>
                </button>
                <div class="h-px my-1 mx-2" style="background-color: #334155 !important;"></div>
                <button id="btn-ppt-menu-move-up" class="w-full px-3.5 py-2.5 text-left text-xs font-medium text-gray-200 hover:bg-slate-700 flex items-center gap-3 active:bg-slate-600 transition-colors rounded-lg">
                    <i class="fas fa-arrow-up text-blue-400 w-4 text-center text-sm"></i> <span>Move Slide Up</span>
                </button>
                <button id="btn-ppt-menu-move-down" class="w-full px-3.5 py-2.5 text-left text-xs font-medium text-gray-200 hover:bg-slate-700 flex items-center gap-3 active:bg-slate-600 transition-colors rounded-lg">
                    <i class="fas fa-arrow-down text-blue-400 w-4 text-center text-sm"></i> <span>Move Slide Down</span>
                </button>
                <button id="btn-ppt-menu-dup" class="w-full px-3.5 py-2.5 text-left text-xs font-medium text-gray-200 hover:bg-slate-700 flex items-center gap-3 active:bg-slate-600 transition-colors rounded-lg">
                    <i class="fas fa-clone text-blue-400 w-4 text-center text-sm"></i> <span>Duplicate Slide</span>
                </button>
                <button id="btn-ppt-menu-del" class="w-full px-3.5 py-2.5 text-left text-xs font-medium text-red-400 hover:bg-slate-700 flex items-center gap-3 active:bg-slate-600 transition-colors rounded-lg">
                    <i class="fas fa-trash-alt text-red-400 w-4 text-center text-sm"></i> <span>Delete Slide</span>
                </button>
            </div>
        </div>
    </div>

    <!-- Main Content Area with Sidebar Drawer -->
    <div class="flex-1 flex flex-row overflow-hidden relative" style="background-color: #0f172a !important;">
        <!-- Sidebar: Thumbnail Strip (Drawer on mobile, permanent column on desktop) -->
        <div id="ppt-sidebar-backdrop" class="hidden fixed inset-0 bg-black/70 z-30 sm:hidden"></div>
        <div id="ppt-slides-carousel-wrapper" class="hidden flex-col h-full w-56 sm:w-48 overflow-y-auto scrollbar-thin p-3 gap-3 flex-shrink-0 z-40 absolute sm:relative top-0 bottom-0 left-0 shadow-2xl sm:shadow-none transition-transform duration-200" style="background-color: #1e293b !important; border-right: 1px solid #334155 !important;">
            <div class="flex items-center justify-between px-1 pb-2 border-b border-slate-700 sm:hidden">
                <span class="text-xs font-bold text-gray-200 uppercase tracking-wider">Slides</span>
                <button id="btn-ppt-close-sidebar" class="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-white rounded-lg"><i class="fas fa-times text-sm"></i></button>
            </div>
            <button id="btn-ppt-add-slide-sidebar" class="w-full py-2 px-3 text-blue-400 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 active:scale-95 transition-all" style="background-color: rgba(37, 99, 235, 0.15) !important; border: 1px solid rgba(59, 130, 246, 0.3) !important;">
                <i class="fas fa-plus"></i> <span>New Slide</span>
            </button>
            <div class="flex flex-col gap-2.5 flex-1" id="ppt-slides-carousel"></div>
        </div>
        
        <!-- Center Stage Slide Viewport -->
        <div id="ppt-slide-stage" class="flex-1 w-full h-full relative overflow-y-auto flex flex-col items-center justify-center p-2 sm:p-4 md:p-6" style="background-color: #0f172a !important;">
            
            <!-- Floating / Contextual Text Formatting Toolbar -->
            <div id="ppt-formatting-toolbar" class="hidden flex items-center gap-1 rounded-full px-2.5 py-1.5 shadow-2xl z-30 mb-3 transition-all" style="background-color: #1e293b !important; border: 1px solid #475569 !important;">
                <button id="btn-ppt-fmt-bold" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-full active:scale-95 transition-all font-bold" title="Bold">
                    <i class="fas fa-bold text-xs"></i>
                </button>
                <button id="btn-ppt-fmt-italic" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-full active:scale-95 transition-all italic" title="Italic">
                    <i class="fas fa-italic text-xs"></i>
                </button>
                <button id="btn-ppt-fmt-underline" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-full active:scale-95 transition-all underline" title="Underline">
                    <i class="fas fa-underline text-xs"></i>
                </button>
                <div class="w-px h-4 mx-0.5" style="background-color: #475569 !important;"></div>
                <button id="btn-ppt-fmt-list" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-full active:scale-95 transition-all" title="Toggle Bullets">
                    <i class="fas fa-list-ul text-xs"></i>
                </button>
                <button id="btn-ppt-fmt-align" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-full active:scale-95 transition-all" title="Toggle Alignment (Left/Center/Right)">
                    <i class="fas fa-align-center text-xs"></i>
                </button>
                <div class="w-px h-4 mx-0.5" style="background-color: #475569 !important;"></div>
                <button id="btn-ppt-fmt-size-up" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-full active:scale-95 transition-all text-xs font-bold" title="Increase Font Size">
                    A+
                </button>
                <button id="btn-ppt-fmt-size-down" class="w-8 h-8 flex items-center justify-center text-gray-200 hover:bg-slate-700 hover:text-white rounded-full active:scale-95 transition-all text-xs font-bold" title="Decrease Font Size">
                    A-
                </button>
            </div>

            <!-- Reveal.js Outer Container (16:9 Canvas) -->
            <div class="reveal w-full max-w-4xl bg-white shadow-[0_20px_60px_rgba(0,0,0,0.8)] rounded-md overflow-hidden flex flex-col relative transition-all duration-300 my-auto" id="ppt-slide-frame" style="aspect-ratio: 16/9; max-height: 70vh; border: 1px solid rgba(255,255,255,0.15); touch-action: pan-y;">
                <div class="slides w-full h-full flex-1 relative overflow-hidden" id="ppt-slides-container">
                    <section class="slide-section w-full h-full p-4 sm:p-8 md:p-12 flex flex-col overflow-y-auto relative" id="ppt-slide-content-stage">
                        <!-- Slide Header Title Input -->
                        <input type="text" id="ppt-slide-title-input" placeholder="Click to add title" class="text-xl sm:text-2xl md:text-4xl font-bold border-none focus:ring-0 focus:outline-none bg-transparent mb-2 sm:mb-4 w-full text-center placeholder-gray-300 transition-all p-0" />
                        
                        <!-- Slide Main Text / Elements Container -->
                        <div class="flex-1 flex flex-col gap-2 sm:gap-4 relative z-10">
                            <textarea id="ppt-slide-content-area" placeholder="Click to add subtitle or bullet text..." class="w-full flex-1 text-sm sm:text-lg md:text-xl border-none focus:ring-0 focus:outline-none resize-none text-center bg-transparent placeholder-gray-400 transition-all p-0"></textarea>
                        </div>
                        
                        <!-- Free-form Draggable Elements Overlay -->
                        <div id="ppt-slide-elements-container" class="absolute inset-0 pointer-events-none z-20"></div>
                    </section>
                </div>
            </div>
            
            <!-- Slide Navigation Floating Arrows (desktop / tablet) -->
            <button id="ppt-prev-slide-btn" class="hidden sm:flex absolute text-white rounded-full items-center justify-center transition-all active:scale-90 z-20 shadow-lg" style="left: 1rem; top: 50%; transform: translateY(-50%); width: 2.75rem; height: 2.75rem; background-color: rgba(30, 41, 59, 0.85) !important; border: 1px solid #475569 !important;" title="Previous Slide">
                <i class="fas fa-chevron-left text-sm"></i>
            </button>
            <button id="ppt-next-slide-btn" class="hidden sm:flex absolute text-white rounded-full items-center justify-center transition-all active:scale-90 z-20 shadow-lg" style="right: 1rem; top: 50%; transform: translateY(-50%); width: 2.75rem; height: 2.75rem; background-color: rgba(30, 41, 59, 0.85) !important; border: 1px solid #475569 !important;" title="Next Slide">
                <i class="fas fa-chevron-right text-sm"></i>
            </button>

            <!-- Slide Counter Badges -->
            <div id="ppt-slide-counter" class="hidden sm:flex absolute text-xs font-semibold px-2.5 py-1 text-gray-300 rounded-lg shadow-md z-20" style="bottom: 0.75rem; left: 0.75rem; background-color: rgba(30, 41, 59, 0.9) !important; border: 1px solid #475569 !important;">
                Slide 1 of 1
            </div>
            <div id="ppt-slide-info" class="hidden">Slide 1 of 1</div>
        </div>
    </div>

    <!-- Mobile Bottom Navigation Dock (Visible on Mobile < md) -->
    <div id="ppt-mobile-dock" class="flex-shrink-0 md:hidden px-3 py-2 flex items-center justify-between gap-2 z-40 select-none shadow-[0_-4px_25px_rgba(0,0,0,0.5)]" style="background-color: #1e293b !important; border-top: 1px solid #334155 !important; padding-bottom: max(0.5rem, env(safe-area-inset-bottom));">
        <!-- Slide Switcher Controls -->
        <div class="flex items-center gap-1 rounded-xl p-1" style="background-color: #0f172a !important; border: 1px solid #334155 !important;">
            <button id="btn-ppt-prev-bottom" class="w-7 h-7 flex items-center justify-center text-gray-300 hover:text-white active:bg-slate-800 rounded-lg transition-colors" title="Previous Slide">
                <i class="fas fa-chevron-left text-xs"></i>
            </button>
            <span id="ppt-bottom-slide-counter" class="text-xs font-bold text-gray-200 px-1.5 font-mono">1/1</span>
            <button id="btn-ppt-next-bottom" class="w-7 h-7 flex items-center justify-center text-gray-300 hover:text-white active:bg-slate-800 rounded-lg transition-colors" title="Next Slide">
                <i class="fas fa-chevron-right text-xs"></i>
            </button>
        </div>

        <!-- Mobile Action Buttons -->
        <div class="flex items-center gap-1.5">
            <button id="btn-ppt-add-slide-mobile" class="h-9 px-3 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 active:scale-95 transition-all shadow-md" style="background-color: #2563eb !important;" title="Add Slide">
                <i class="fas fa-plus text-[10px]"></i> <span>Slide</span>
            </button>
            <button id="btn-ppt-add-text-mobile" class="w-9 h-9 flex items-center justify-center text-gray-200 rounded-xl active:scale-95 transition-all shadow-sm" style="background-color: #334155 !important; border: 1px solid #475569 !important;" title="Add Text">
                <i class="fas fa-font text-xs"></i>
            </button>
            <button id="btn-ppt-add-image-mobile" class="w-9 h-9 flex items-center justify-center text-gray-200 rounded-xl active:scale-95 transition-all shadow-sm" style="background-color: #334155 !important; border: 1px solid #475569 !important;" title="Add Photo">
                <i class="fas fa-image text-xs"></i>
            </button>
            <button id="btn-ppt-theme-mobile" class="w-9 h-9 flex items-center justify-center text-gray-200 rounded-xl active:scale-95 transition-all shadow-sm" style="background-color: #334155 !important; border: 1px solid #475569 !important;" title="Theme">
                <i class="fas fa-palette text-xs"></i>
            </button>
            <button id="btn-ppt-toggle-format-mobile" class="w-9 h-9 flex items-center justify-center text-gray-200 rounded-xl active:scale-95 transition-all shadow-sm" style="background-color: #334155 !important; border: 1px solid #475569 !important;" title="Format Text">
                <span class="text-xs font-bold font-serif">Aa</span>
            </button>
        </div>
    </div>

    <!-- Hidden file inputs -->
    <input type="file" id="ppt-image-upload-input" accept="image/*" class="hidden" />
    <input type="file" id="ppt-presentation-import-input" accept=".kivupres,.json,.pptx,.txt,.md" class="hidden" />

    <!-- Dedicated Fullscreen Present Mode Overlay -->
    <div id="ppt-present-overlay" class="hidden fixed inset-0 bg-black select-none flex flex-col items-center justify-center overflow-hidden" style="z-index: 999999 !important;">
        <!-- Scaled 16:9 Presentation Stage -->
        <div id="ppt-present-canvas" class="relative overflow-hidden shadow-2xl flex flex-col items-center justify-center transition-all duration-150" style="aspect-ratio: 16/9; width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh;">
            <div id="ppt-present-stage-inner" class="w-full h-full p-6 sm:p-12 md:p-16 flex flex-col relative overflow-hidden">
                <h1 id="ppt-present-title" class="text-2xl sm:text-4xl md:text-6xl font-bold mb-4 w-full text-center transition-all break-words select-none"></h1>
                <div id="ppt-present-content" class="flex-1 text-base sm:text-2xl md:text-3xl text-center whitespace-pre-wrap transition-all overflow-y-auto break-words select-none"></div>
                <div id="ppt-present-elements" class="absolute inset-0 pointer-events-none"></div>
            </div>
        </div>

        <!-- Presentation Floating Controls Overlay (Auto-hiding) -->
        <div id="ppt-present-controls" class="absolute bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 sm:gap-3 px-3 sm:px-5 py-2 sm:py-2.5 rounded-full text-white shadow-2xl z-50 transition-opacity duration-300" style="background-color: rgba(15, 23, 42, 0.85); border: 1px solid rgba(71, 85, 105, 0.8); backdrop-filter: blur(8px);">
            <button id="btn-present-prev" class="w-9 h-9 flex items-center justify-center hover:bg-slate-800 rounded-full active:scale-90 transition-all text-sm" title="Previous Slide (Left Arrow, PageUp)">
                <i class="fas fa-chevron-left"></i>
            </button>
            <span id="ppt-present-counter" class="text-xs sm:text-sm font-semibold font-mono px-2 text-slate-300 select-none">1 / 1</span>
            <button id="btn-present-next" class="w-9 h-9 flex items-center justify-center hover:bg-slate-800 rounded-full active:scale-90 transition-all text-sm" title="Next Slide (Right Arrow, Space, PageDown)">
                <i class="fas fa-chevron-right"></i>
            </button>
            <div class="w-px h-5 bg-slate-700 mx-1"></div>
            <button id="btn-present-fullscreen-toggle" class="w-9 h-9 flex items-center justify-center hover:bg-slate-800 rounded-full active:scale-90 transition-all text-sm text-slate-300" title="Toggle Fullscreen">
                <i class="fas fa-expand"></i>
            </button>
            <button id="btn-present-exit" class="w-9 h-9 flex items-center justify-center bg-red-600/80 hover:bg-red-600 text-white rounded-full active:scale-90 transition-all text-sm ml-1" title="Exit Presentation (Esc)">
                <i class="fas fa-times"></i>
            </button>
        </div>
    </div>
</div>
`;

export async function init(arg1 = null, arg2 = null) {
  let docId = null;
  if (typeof arg1 === 'string') {
    docId = arg1;
  } else if (arg1 && typeof arg1 === 'object' && arg1.nodeType) {
    docId = arg2;
  } else {
    docId = arg1;
  }
  return openPowerPointEditor(docId);
}

export function openPowerPointEditor(docId = null) {
  if (typeof document !== 'undefined' && !document.getElementById('ppt-editor-modal')) {
    document.body.insertAdjacentHTML('beforeend', pptEditorHtml);
    bindPowerPointEvents();
  }

  currentDocId = docId;
  slides = [];
  currentSlideIndex = 0;

  if (!currentDocId) {
    currentDocId = 'ppt_' + Date.now();
    slides = [
      {
        id: 'slide_1',
        title: 'Welcome Slide',
        content: 'Add your content here...',
        elements: [],
        bg: '#ffffff',
        color: '#111827',
        align: 'center',
        bold: false,
        italic: false,
        underline: false,
        fontSizeDelta: 0
      }
    ];
    if (typeof document !== 'undefined') {
      const titleInput = document.getElementById('ppt-doc-title');
      if (titleInput) titleInput.value = 'Untitled Presentation';
    }
  } else {
    try {
      const data = localStorage.getItem(PPT_STORAGE_KEY_PREFIX + currentDocId);
      if (data) {
        const parsed = JSON.parse(data);
        slides = Array.isArray(parsed.slides) ? parsed.slides : [];
        if (typeof parsed.activeSlideIndex === 'number') {
          currentSlideIndex = parsed.activeSlideIndex;
        }
        if (typeof document !== 'undefined') {
          const titleInput = document.getElementById('ppt-doc-title');
          if (titleInput) titleInput.value = parsed.title || 'Untitled Presentation';
        }
      } else {
        const idx = getDocsIndex().find(d => d.id === currentDocId);
        if (typeof document !== 'undefined' && idx) {
          const titleInput = document.getElementById('ppt-doc-title');
          if (titleInput) titleInput.value = idx.title || 'Untitled Presentation';
        }
      }
    } catch (e) {
      console.error('Failed to load presentation state:', e);
    }
  }

  if (slides.length === 0) {
    slides = [
      {
        id: 'slide_1',
        title: 'Welcome Slide',
        content: 'Add your content here...',
        elements: [],
        bg: '#ffffff',
        color: '#111827',
        align: 'center',
        bold: false,
        italic: false,
        underline: false,
        fontSizeDelta: 0
      }
    ];
  }

  if (currentSlideIndex >= slides.length) {
    currentSlideIndex = Math.max(0, slides.length - 1);
  }

  if (typeof document !== 'undefined') {
    const modal = document.getElementById('ppt-editor-modal');
    if (modal) {
      modal.classList.remove('hidden');
      setTimeout(() => modal.classList.remove('translate-y-full'), 10);
    }
  }

  renderSlide();
  const titleVal = (typeof document !== 'undefined' && document.getElementById('ppt-doc-title'))
    ? document.getElementById('ppt-doc-title').value
    : 'Untitled Presentation';
  saveDocument(titleVal);
}

export function closePowerPointEditor() {
  flushSave();
  if (isPresenting) {
    exitPresentMode();
  }
  if (typeof document !== 'undefined') {
    const modal = document.getElementById('ppt-editor-modal');
    if (modal) {
      modal.classList.add('translate-y-full');
      setTimeout(() => {
        modal.classList.add('hidden');
        if (typeof window !== 'undefined' && typeof window.renderMyDocuments === 'function') {
          try {
            window.renderMyDocuments();
          } catch (e) {
            console.warn('renderMyDocuments error:', e);
          }
        }
      }, 300);
    }
  }
}

export function addSlide(slideData = {}) {
  const title = typeof slideData === 'object' && slideData !== null && slideData.title
    ? slideData.title
    : (typeof slideData === 'string' ? slideData : `Slide ${slides.length + 1}`);
  const content = typeof slideData === 'object' && slideData !== null && slideData.content
    ? slideData.content
    : '';
  const elements = typeof slideData === 'object' && slideData !== null && Array.isArray(slideData.elements)
    ? slideData.elements
    : [];
  const bg = typeof slideData === 'object' && slideData !== null && slideData.bg
    ? slideData.bg
    : '#ffffff';
  const color = typeof slideData === 'object' && slideData !== null && slideData.color
    ? slideData.color
    : '#111827';
  const align = typeof slideData === 'object' && slideData !== null && slideData.align
    ? slideData.align
    : 'center';

  const newSlide = {
    id: 'slide_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    title,
    content,
    elements,
    bg,
    color,
    align,
    bold: false,
    italic: false,
    underline: false,
    fontSizeDelta: 0
  };

  slides.push(newSlide);
  currentSlideIndex = slides.length - 1;
  renderSlide();
  flushSave();
}

/**
 * Duplicate the current or specified slide with all elements and properties
 */
export function duplicateSlide(index = null) {
  const targetIndex = index !== null && index !== undefined ? index : currentSlideIndex;
  if (targetIndex >= 0 && targetIndex < slides.length) {
    const sourceSlide = slides[targetIndex];
    const clonedElements = JSON.parse(JSON.stringify(sourceSlide.elements || [])).map(el => ({
      ...el,
      id: 'el_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      x: Math.min(80, (el.x || 10) + 2),
      y: Math.min(80, (el.y || 10) + 2)
    }));

    const clonedSlide = {
      id: 'slide_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      title: (sourceSlide.title || 'Slide') + ' (Copy)',
      content: sourceSlide.content || '',
      elements: clonedElements,
      bg: sourceSlide.bg || '#ffffff',
      color: sourceSlide.color || '#111827',
      align: sourceSlide.align || 'center',
      bold: !!sourceSlide.bold,
      italic: !!sourceSlide.italic,
      underline: !!sourceSlide.underline,
      fontSizeDelta: sourceSlide.fontSizeDelta || 0
    };

    slides.splice(targetIndex + 1, 0, clonedSlide);
    currentSlideIndex = targetIndex + 1;
    renderSlide();
    flushSave();

    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast('Slide duplicated!', false);
    }
  }
}

export function deleteSlide(index = null) {
  const targetIndex = index !== null && index !== undefined ? index : currentSlideIndex;
  if (targetIndex >= 0 && targetIndex < slides.length) {
    slides.splice(targetIndex, 1);
  }
  if (slides.length === 0) {
    slides.push({
      id: 'slide_' + Date.now(),
      title: 'Slide 1',
      content: '',
      elements: [],
      bg: '#ffffff',
      color: '#111827',
      align: 'center',
      bold: false,
      italic: false,
      underline: false,
      fontSizeDelta: 0
    });
  }
  if (currentSlideIndex >= slides.length) {
    currentSlideIndex = Math.max(0, slides.length - 1);
  }
  renderSlide();
  flushSave();
}

/**
 * Slide Reordering Functions
 */
export function moveSlide(fromIndex, toIndex) {
  if (fromIndex < 0 || fromIndex >= slides.length) return false;
  if (toIndex < 0 || toIndex >= slides.length) return false;
  if (fromIndex === toIndex) return true;

  const [moved] = slides.splice(fromIndex, 1);
  slides.splice(toIndex, 0, moved);
  currentSlideIndex = toIndex;
  renderSlide();
  flushSave();
  return true;
}

export function moveSlideUp(index = null) {
  const target = index !== null && index !== undefined ? index : currentSlideIndex;
  if (target > 0) {
    return moveSlide(target, target - 1);
  }
  return false;
}

export function moveSlideDown(index = null) {
  const target = index !== null && index !== undefined ? index : currentSlideIndex;
  if (target < slides.length - 1) {
    return moveSlide(target, target + 1);
  }
  return false;
}

export function nextSlide() {
  if (currentSlideIndex < slides.length - 1) {
    currentSlideIndex++;
    renderSlide();
  }
}

export function prevSlide() {
  if (currentSlideIndex > 0) {
    currentSlideIndex--;
    renderSlide();
  }
}

export function goToSlide(index) {
  if (index >= 0 && index < slides.length) {
    currentSlideIndex = index;
    renderSlide();
  }
}

export function getSlideCount() {
  return slides.length;
}

export function setTitle(title) {
  if (typeof document !== 'undefined') {
    const titleInput = document.getElementById('ppt-doc-title');
    if (titleInput) titleInput.value = title;
  }
  flushSave();
}

export function addTextElement(text = '') {
  if (!slides[currentSlideIndex]) return;
  if (!slides[currentSlideIndex].elements) slides[currentSlideIndex].elements = [];
  slides[currentSlideIndex].elements.push({
    id: 'el_' + Date.now(),
    type: 'text',
    content: text || 'New Text',
    bold: false,
    italic: false,
    underline: false,
    align: 'left',
    fontSize: 18,
    w: 35,
    h: 18
  });
  renderSlide();
  flushSave();
}

export async function addImageElement(src = '') {
  if (!slides[currentSlideIndex]) return;
  if (!slides[currentSlideIndex].elements) slides[currentSlideIndex].elements = [];

  let finalSrc = src;
  if (src && src.startsWith('data:image') && src.length > 100000) {
    finalSrc = await compressImage(src, 1200, 900, 0.75);
  }

  slides[currentSlideIndex].elements.push({
    id: 'el_' + Date.now(),
    type: 'image',
    src: finalSrc || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="%23cccccc"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%23666666">Image</text></svg>',
    w: 30,
    h: 25
  });
  renderSlide();
  flushSave();
}

/**
 * Apply formatting command to active slide content or focused contentEditable block
 */
export function applyFormatting(cmd, val = null) {
  const currentSlide = slides[currentSlideIndex];
  if (!currentSlide) return;

  const selectedEl = (selectedElementIndex !== null && currentSlide.elements)
    ? currentSlide.elements[selectedElementIndex]
    : null;

  if (selectedEl && selectedEl.type === 'text') {
    const textDiv = elementDomRefs[selectedElementIndex] || null;

    if (cmd === 'bold') {
      selectedEl.bold = !selectedEl.bold;
      if (textDiv) textDiv.style.fontWeight = selectedEl.bold ? 'bold' : 'normal';
    } else if (cmd === 'italic') {
      selectedEl.italic = !selectedEl.italic;
      if (textDiv) textDiv.style.fontStyle = selectedEl.italic ? 'italic' : 'normal';
    } else if (cmd === 'underline') {
      selectedEl.underline = !selectedEl.underline;
      if (textDiv) textDiv.style.textDecoration = selectedEl.underline ? 'underline' : 'none';
    } else if (cmd === 'list') {
      const source = textDiv ? textDiv.innerText : (selectedEl.content || '');
      const lines = source.split('\n');
      const allBulleted = lines.length > 0 && lines.every(l => l.trim().startsWith('• '));
      const newText = lines.map(l => {
        if (allBulleted) {
          return l.replace(/^\s*•\s*/, '');
        }
        return l.trim() ? '• ' + l.replace(/^\s*•\s*/, '') : l;
      }).join('\n');
      selectedEl.content = newText;
      if (textDiv) textDiv.innerText = newText;
    } else if (cmd === 'align') {
      const aligns = ['left', 'center', 'right'];
      const curAlign = selectedEl.align || 'left';
      const nextAlign = aligns[(aligns.indexOf(curAlign) + 1) % aligns.length];
      selectedEl.align = nextAlign;
      if (textDiv) textDiv.style.textAlign = nextAlign;
    } else if (cmd === 'size-up') {
      selectedEl.fontSize = Math.min(96, (selectedEl.fontSize || 18) + 2);
      if (textDiv) textDiv.style.fontSize = selectedEl.fontSize + 'px';
    } else if (cmd === 'size-down') {
      selectedEl.fontSize = Math.max(8, (selectedEl.fontSize || 18) - 2);
      if (textDiv) textDiv.style.fontSize = selectedEl.fontSize + 'px';
    }

    updateFormatButtonStates(!!selectedEl.bold, !!selectedEl.italic, !!selectedEl.underline);
    flushSave();
    return;
  }

  const contentArea = (typeof document !== 'undefined') ? document.getElementById('ppt-slide-content-area') : null;
  const titleInput = (typeof document !== 'undefined') ? document.getElementById('ppt-slide-title-input') : null;

  if (cmd === 'bold') {
    currentSlide.bold = !currentSlide.bold;
    if (contentArea) contentArea.style.fontWeight = currentSlide.bold ? 'bold' : 'normal';
  } else if (cmd === 'italic') {
    currentSlide.italic = !currentSlide.italic;
    if (contentArea) contentArea.style.fontStyle = currentSlide.italic ? 'italic' : 'normal';
  } else if (cmd === 'underline') {
    currentSlide.underline = !currentSlide.underline;
    if (contentArea) contentArea.style.textDecoration = currentSlide.underline ? 'underline' : 'none';
  } else if (cmd === 'list') {
    if (contentArea) {
      const lines = (contentArea.value || '').split('\n');
      const allBulleted = lines.every(l => l.trim().startsWith('• '));
      contentArea.value = lines.map(l => {
        if (allBulleted) {
          return l.replace(/^\s*•\s*/, '');
        } else {
          return l.trim() ? '• ' + l.replace(/^\s*•\s*/, '') : l;
        }
      }).join('\n');
      currentSlide.content = contentArea.value;
    }
  } else if (cmd === 'align') {
    const aligns = ['center', 'left', 'right'];
    const curAlign = currentSlide.align || 'center';
    const nextAlign = aligns[(aligns.indexOf(curAlign) + 1) % aligns.length];
    currentSlide.align = nextAlign;
    if (contentArea) contentArea.style.textAlign = nextAlign;
    if (titleInput) titleInput.style.textAlign = nextAlign;
  } else if (cmd === 'size-up') {
    currentSlide.fontSizeDelta = (currentSlide.fontSizeDelta || 0) + 2;
    if (contentArea) contentArea.style.fontSize = `calc(1.25rem + ${currentSlide.fontSizeDelta}px)`;
  } else if (cmd === 'size-down') {
    currentSlide.fontSizeDelta = Math.max(-8, (currentSlide.fontSizeDelta || 0) - 2);
    if (contentArea) contentArea.style.fontSize = `calc(1.25rem + ${currentSlide.fontSizeDelta}px)`;
  }

  updateFormatButtonStates(!!currentSlide.bold, !!currentSlide.italic, !!currentSlide.underline);
  flushSave();
}

function updateFormatButtonStates(bold, italic, underline) {
  if (typeof document === 'undefined') return;

  const fmtBoldBtn = document.getElementById('btn-ppt-fmt-bold');
  if (fmtBoldBtn) {
    fmtBoldBtn.style.backgroundColor = bold ? '#2563eb' : '';
    fmtBoldBtn.style.color = bold ? '#ffffff' : '#e2e8f0';
  }

  const fmtItalicBtn = document.getElementById('btn-ppt-fmt-italic');
  if (fmtItalicBtn) {
    fmtItalicBtn.style.backgroundColor = italic ? '#2563eb' : '';
    fmtItalicBtn.style.color = italic ? '#ffffff' : '#e2e8f0';
  }

  const fmtUnderlineBtn = document.getElementById('btn-ppt-fmt-underline');
  if (fmtUnderlineBtn) {
    fmtUnderlineBtn.style.backgroundColor = underline ? '#2563eb' : '';
    fmtUnderlineBtn.style.color = underline ? '#ffffff' : '#e2e8f0';
  }
}

/**
 * Debounced save for fast keystrokes
 */
export function saveDocumentDebounced(delay = 350) {
  if (typeof document !== 'undefined') {
    const statusLabel = document.getElementById('ppt-save-status');
    if (statusLabel) {
      statusLabel.innerText = 'Editing...';
    }
  }
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveDocument();
  }, delay);
}

/**
 * Immediately flush pending save to persistent storage
 */
export function flushSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  saveDocument();
}

export function saveDocument(titleParam = null) {
  if (!currentDocId) {
    currentDocId = 'ppt_' + Date.now();
  }
  let title = titleParam;
  if (!title && typeof document !== 'undefined') {
    const titleInput = document.getElementById('ppt-doc-title');
    if (titleInput) title = titleInput.value;
  }
  if (!title) title = 'Untitled Presentation';

  const docData = {
    id: currentDocId,
    title,
    type: 'powerpoint',
    slides: slides.map(s => ({
      id: s.id || ('slide_' + Date.now()),
      title: s.title || '',
      content: s.content || '',
      elements: s.elements || [],
      bg: s.bg || '#ffffff',
      color: s.color || '#111827',
      align: s.align || 'center',
      bold: !!s.bold,
      italic: !!s.italic,
      underline: !!s.underline,
      fontSizeDelta: s.fontSizeDelta || 0
    })),
    activeSlideIndex: currentSlideIndex,
    updatedAt: Date.now()
  };

  try {
    localStorage.setItem(PPT_STORAGE_KEY_PREFIX + currentDocId, JSON.stringify(docData));
    const idx = getDocsIndex();
    const existingIndex = idx.findIndex(d => d.id === currentDocId);
    const indexEntry = {
      id: currentDocId,
      title,
      type: 'powerpoint',
      updatedAt: Date.now()
    };
    if (existingIndex >= 0) {
      idx[existingIndex] = indexEntry;
    } else {
      idx.push(indexEntry);
    }
    saveDocsIndex(idx);

    if (typeof document !== 'undefined') {
      const statusLabel = document.getElementById('ppt-save-status');
      if (statusLabel) {
        statusLabel.innerText = 'Saved locally';
      }
    }
  } catch (err) {
    if (err.name === 'QuotaExceededError') {
      if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast('Storage limit reached! Please free up space.', true);
      }
      throw err;
    }
    console.error('Failed to save presentation:', err);
  }
}

/**
 * Native Presentation Export: produces complete .kivupres / JSON file
 */
export function exportNativePresentation() {
  flushSave();
  const title = (typeof document !== 'undefined' && document.getElementById('ppt-doc-title'))
    ? document.getElementById('ppt-doc-title').value
    : 'Presentation';

  const payload = {
    format: 'kivu-presentation',
    version: 1,
    id: currentDocId,
    title,
    slides: JSON.parse(JSON.stringify(slides)),
    activeSlideIndex: currentSlideIndex,
    exportedAt: new Date().toISOString()
  };

  if (typeof document !== 'undefined') {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title || 'presentation'}.kivupres`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast('Native presentation exported successfully!', false);
  }

  return payload;
}

export const exportPresentationJson = exportNativePresentation;

/**
 * Native Presentation Import: loads .kivupres, .json, .pptx, or markdown text
 */
export async function importPresentation(fileOrData) {
  if (!fileOrData) return false;
  try {
    let parsedData = null;
    let presentationTitle = '';

    if (typeof fileOrData === 'object' && !fileOrData.name && Array.isArray(fileOrData.slides)) {
      parsedData = fileOrData;
    } else if (typeof fileOrData === 'string') {
      try {
        parsedData = JSON.parse(fileOrData);
      } catch (_) {
        // Parse as markdown text slides
        const normalizedText = fileOrData.replace(/\r\n/g, '\n');
        const rawSlides = normalizedText.split(/\n---+\n|\n===+\n/);
        const importedSlides = rawSlides.map((chunk, idx) => {
          const lines = chunk.trim().split('\n');
          const firstLine = lines[0] ? lines[0].replace(/^#+\s*/, '').trim() : `Slide ${idx + 1}`;
          const body = lines.slice(1).join('\n').trim();
          return {
            id: 'slide_' + Date.now() + '_' + idx,
            title: firstLine,
            content: body,
            elements: [],
            bg: '#ffffff',
            color: '#111827',
            align: 'center',
            bold: false,
            italic: false,
            underline: false,
            fontSizeDelta: 0
          };
        }).filter(s => s.title || s.content);

        if (importedSlides.length > 0) {
          parsedData = { title: 'Imported Presentation', slides: importedSlides };
        }
      }
    } else if (typeof Blob !== 'undefined' && (fileOrData instanceof Blob || (typeof File !== 'undefined' && fileOrData instanceof File))) {
      const fileName = fileOrData.name || '';
      presentationTitle = fileName.replace(/\.[^/.]+$/, '') || 'Imported Presentation';

      if (fileName.toLowerCase().endsWith('.pptx')) {
        // Parse PPTX file using JSZip
        let JSZipModule;
        try {
          if (typeof globalThis.JSZip === 'function') {
            JSZipModule = globalThis.JSZip;
          } else {
            const mod = await import('jszip');
            JSZipModule = mod.default || mod;
          }
        } catch (e) {
          JSZipModule = null;
        }

        if (JSZipModule) {
          const buffer = await fileOrData.arrayBuffer();
          const zip = await JSZipModule.loadAsync(buffer);
          const slideFileNames = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name));

          slideFileNames.sort((a, b) => {
            const numA = parseInt(a.match(/slide(\d+)\.xml/i)?.[1] || '0', 10);
            const numB = parseInt(b.match(/slide(\d+)\.xml/i)?.[1] || '0', 10);
            return numA - numB;
          });

          const extractedSlides = [];
          for (let i = 0; i < slideFileNames.length; i++) {
            const xmlStr = await zip.file(slideFileNames[i]).async('text');
            const paragraphs = [];
            const pMatches = xmlStr.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) || [];

            for (const pXml of pMatches) {
              const textMatches = Array.from(pXml.matchAll(/<a:t>([^<]+)<\/a:t>/g)).map(m => m[1]);
              const pText = textMatches.join('').trim();
              if (pText) {
                paragraphs.push(pText);
              }
            }

            const slideTitle = paragraphs.length > 0 ? paragraphs[0] : `Slide ${i + 1}`;
            const slideBody = paragraphs.length > 1 ? paragraphs.slice(1).join('\n\n') : '';

            extractedSlides.push({
              id: 'slide_' + Date.now() + '_' + i,
              title: slideTitle,
              content: slideBody,
              elements: [],
              bg: '#ffffff',
              color: '#111827',
              align: 'center',
              bold: false,
              italic: false,
              underline: false,
              fontSizeDelta: 0
            });
          }

          if (extractedSlides.length > 0) {
            parsedData = {
              title: presentationTitle,
              slides: extractedSlides
            };
          }
        }
      }

      if (!parsedData) {
        const text = await fileOrData.text();
        return importPresentation(text);
      }
    }

    if (parsedData && Array.isArray(parsedData.slides) && parsedData.slides.length > 0) {
      slides = parsedData.slides.map((s, idx) => ({
        id: s.id || ('slide_' + Date.now() + '_' + idx),
        title: s.title || `Slide ${idx + 1}`,
        content: s.content || '',
        elements: Array.isArray(s.elements) ? s.elements.map(el => {
          if (!el || typeof el !== 'object') return null;
          if (el.type === 'image') {
            return {
              ...el,
              src: isSafeImageSrc(el.src) ? el.src : ''
            };
          }
          return {
            ...el,
            content: el.content !== undefined ? String(el.content) : ''
          };
        }).filter(Boolean) : [],
        bg: s.bg || '#ffffff',
        color: s.color || '#111827',
        align: s.align || 'center',
        bold: !!s.bold,
        italic: !!s.italic,
        underline: !!s.underline,
        fontSizeDelta: s.fontSizeDelta || 0
      }));

      currentSlideIndex = 0;
      const finalTitle = parsedData.title || presentationTitle || 'Imported Presentation';

      if (typeof document !== 'undefined') {
        const titleInput = document.getElementById('ppt-doc-title');
        if (titleInput) titleInput.value = finalTitle;
      }

      renderSlide();
      flushSave();

      if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast(`Imported "${finalTitle}" successfully! (${slides.length} slides)`, false);
      }
      return true;
    }

    throw new Error('Unrecognized presentation format');
  } catch (err) {
    console.error('Failed to import presentation:', err);
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast('Import failed. Please ensure file is valid .kivupres, .json, or .pptx', true);
    }
    return false;
  }
}

/**
 * Present Mode (Fullscreen presentation view with scaling, navigation & keyboard controls)
 */
export function startPresentMode(startSlideIndex = null) {
  if (typeof document === 'undefined') return;
  flushSave();

  if (startSlideIndex !== null && startSlideIndex >= 0 && startSlideIndex < slides.length) {
    currentSlideIndex = startSlideIndex;
  }

  const overlay = document.getElementById('ppt-present-overlay');
  if (!overlay) return;

  isPresenting = true;
  overlay.classList.remove('hidden');
  renderPresentSlide();

  // Attempt browser fullscreen if available
  if (!document.fullscreenElement) {
    if (overlay.requestFullscreen) {
      overlay.requestFullscreen().catch(() => {});
    } else if (overlay.webkitRequestFullscreen) {
      overlay.webkitRequestFullscreen();
    }
  }

  // Keyboard navigation listener
  if (presentKeydownHandler) {
    window.removeEventListener('keydown', presentKeydownHandler);
  }
  presentKeydownHandler = (e) => {
    if (!isPresenting) return;
    showPresentControlsTemporarily();

    if (e.key === 'Escape') {
      exitPresentMode();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown' || e.key === 'Enter') {
      e.preventDefault();
      nextPresentSlide();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Backspace') {
      e.preventDefault();
      prevPresentSlide();
    } else if (e.key === 'Home') {
      e.preventDefault();
      goToSlide(0);
      renderPresentSlide();
    } else if (e.key === 'End') {
      e.preventDefault();
      goToSlide(slides.length - 1);
      renderPresentSlide();
    }
  };
  window.addEventListener('keydown', presentKeydownHandler);

  // Auto-hide controls timeout
  showPresentControlsTemporarily();
}

export function exitPresentMode() {
  if (typeof document === 'undefined') return;
  isPresenting = false;

  const overlay = document.getElementById('ppt-present-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }

  const isFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (isFs) {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }

  if (presentKeydownHandler) {
    window.removeEventListener('keydown', presentKeydownHandler);
    presentKeydownHandler = null;
  }
  if (presentControlsTimeout) {
    clearTimeout(presentControlsTimeout);
    presentControlsTimeout = null;
  }

  renderSlide();
}

function nextPresentSlide() {
  if (currentSlideIndex < slides.length - 1) {
    currentSlideIndex++;
    renderPresentSlide();
  }
}

function prevPresentSlide() {
  if (currentSlideIndex > 0) {
    currentSlideIndex--;
    renderPresentSlide();
  }
}

function renderPresentSlide() {
  if (typeof document === 'undefined') return;
  const slide = slides[currentSlideIndex];
  if (!slide) return;

  const canvas = document.getElementById('ppt-present-canvas');
  if (canvas) {
    canvas.style.background = slide.bg || '#ffffff';
  }

  const titleEl = document.getElementById('ppt-present-title');
  if (titleEl) {
    titleEl.textContent = slide.title || '';
    titleEl.style.color = slide.color || '#111827';
    titleEl.style.textAlign = slide.align || 'center';
  }

  const contentEl = document.getElementById('ppt-present-content');
  if (contentEl) {
    contentEl.textContent = slide.content || '';
    contentEl.style.color = slide.color || '#374151';
    contentEl.style.textAlign = slide.align || 'center';
    contentEl.style.fontWeight = slide.bold ? 'bold' : 'normal';
    contentEl.style.fontStyle = slide.italic ? 'italic' : 'normal';
    contentEl.style.textDecoration = slide.underline ? 'underline' : 'none';
    if (slide.fontSizeDelta) {
      contentEl.style.fontSize = `calc(1.75rem + ${slide.fontSizeDelta}px)`;
    } else {
      contentEl.style.fontSize = '';
    }
  }

  const counterEl = document.getElementById('ppt-present-counter');
  if (counterEl) {
    counterEl.textContent = `${currentSlideIndex + 1} / ${slides.length}`;
  }

  const elementsLayer = document.getElementById('ppt-present-elements');
  if (elementsLayer) {
    elementsLayer.innerHTML = '';
    if (slide.elements && slide.elements.length > 0) {
      slide.elements.forEach(el => {
        const elWrap = document.createElement('div');
        elWrap.className = 'absolute pointer-events-none';
        elWrap.style.left = (el.x !== undefined ? el.x : 10) + '%';
        elWrap.style.top = (el.y !== undefined ? el.y : 20) + '%';
        if (el.w) elWrap.style.width = el.w + '%';
        if (el.h) elWrap.style.height = el.h + '%';

        if (el.type === 'text') {
          const textDiv = document.createElement('div');
          textDiv.className = 'w-full h-full p-4 bg-white/90 backdrop-blur rounded shadow-lg text-gray-800 break-words';
          textDiv.style.fontWeight = el.bold ? 'bold' : 'normal';
          textDiv.style.fontStyle = el.italic ? 'italic' : 'normal';
          textDiv.style.textDecoration = el.underline ? 'underline' : 'none';
          textDiv.style.textAlign = el.align || 'left';
          textDiv.style.fontSize = `calc(${el.fontSize || 18}px * 1.3)`;
          textDiv.textContent = el.content || '';
          elWrap.appendChild(textDiv);
        } else if (el.type === 'image' && el.src) {
          if (!el.w) elWrap.style.width = '30%';
          const img = document.createElement('img');
          img.className = 'w-full h-full object-contain rounded shadow-lg bg-white/80 backdrop-blur';
          img.src = isSafeImageSrc(el.src) ? el.src : '';
          elWrap.appendChild(img);
        }
        elementsLayer.appendChild(elWrap);
      });
    }
  }
}

function showPresentControlsTemporarily() {
  if (typeof document === 'undefined') return;
  const controls = document.getElementById('ppt-present-controls');
  if (!controls) return;

  controls.style.opacity = '1';
  controls.style.pointerEvents = 'auto';

  if (presentControlsTimeout) clearTimeout(presentControlsTimeout);
  presentControlsTimeout = setTimeout(() => {
    if (isPresenting && controls) {
      controls.style.opacity = '0';
      controls.style.pointerEvents = 'none';
    }
  }, 3500);
}

/**
 * Lazy loads html2canvas and jsPDF engines for direct slide rasterization
 */
async function getPdfEngines() {
  let html2canvas = typeof window !== 'undefined' ? (window.html2canvas || null) : null;
  let jsPDF = typeof window !== 'undefined' ? (window.jsPDF || null) : null;

  if (!html2canvas) {
    try {
      const mod = await import('html2canvas');
      html2canvas = mod.default || mod;
    } catch (_) {}
  }
  if (!jsPDF) {
    try {
      const mod = await import('jspdf');
      jsPDF = mod.jsPDF || mod.default?.jsPDF || (typeof mod.default === 'function' ? mod.default : mod);
    } catch (_) {}
  }
  return { html2canvas, jsPDF };
}

/**
 * Export Presentation to PDF: renders each slide directly via html2canvas + jsPDF.
 * Bypasses html2pdf.js pagebreak logic and avoids modifying window.getComputedStyle,
 * completely preventing "CSSStyleProperties.breakBefore" and "unsupported color function oklch" crashes.
 */
export async function exportPresentation() {
  flushSave();
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast('Exporting presentation PDF...', false);
  }

  let pdfOutput = null;
  let exportFailed = false;

  try {
    const { html2canvas, jsPDF } = await getPdfEngines();
    if (!html2canvas || !jsPDF) {
      throw new Error('PDF export engines (html2canvas, jsPDF) could not be loaded');
    }

    if (typeof document === 'undefined') {
      throw new Error('document is not available');
    }

    const title = (document.getElementById('ppt-doc-title') && document.getElementById('ppt-doc-title').value)
      ? document.getElementById('ppt-doc-title').value
      : 'Presentation';

    const slideList = Array.isArray(slides) && slides.length > 0
      ? slides
      : [{ id: 'slide_1', title: 'Presentation', content: '', elements: [], bg: '#ffffff', color: '#111827' }];

    const pdf = new jsPDF({
      orientation: 'landscape',
      unit: 'px',
      format: [1280, 720]
    });

    for (let idx = 0; idx < slideList.length; idx++) {
      const slide = slideList[idx];

      if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast(`Rendering slide ${idx + 1} of ${slideList.length}...`, false);
      }

      // Build slide DOM element
      const slideEl = document.createElement('div');
      slideEl.id = `ppt-render-slide-${idx}`;
      slideEl.style.width = '1280px';
      slideEl.style.height = '720px';
      slideEl.style.position = 'fixed';
      slideEl.style.left = '0';
      slideEl.style.top = '0';
      slideEl.style.zIndex = '-9999';
      slideEl.style.overflow = 'hidden';
      slideEl.style.background = slide.bg || '#ffffff';
      slideEl.style.color = slide.color || '#111827';
      slideEl.style.padding = '48px';
      slideEl.style.boxSizing = 'border-box';
      slideEl.style.display = 'flex';
      slideEl.style.flexDirection = 'column';
      slideEl.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      slideEl.style.pointerEvents = 'none';

      // Title
      if (slide.title) {
        const h1 = document.createElement('h1');
        h1.style.fontSize = '44px';
        h1.style.marginBottom = '20px';
        h1.style.color = slide.color || '#111827';
        h1.style.fontWeight = 'bold';
        h1.style.textAlign = slide.align || 'center';
        h1.textContent = slide.title;
        slideEl.appendChild(h1);
      }

      // Content
      if (slide.content) {
        const bodyDiv = document.createElement('div');
        const delta = (slide.fontSizeDelta || 0) * 1.5;
        bodyDiv.style.fontSize = `calc(24px + ${delta}px)`;
        bodyDiv.style.color = slide.color || '#374151';
        bodyDiv.style.fontWeight = slide.bold ? 'bold' : 'normal';
        bodyDiv.style.fontStyle = slide.italic ? 'italic' : 'normal';
        bodyDiv.style.textDecoration = slide.underline ? 'underline' : 'none';
        bodyDiv.style.textAlign = slide.align || 'center';
        bodyDiv.style.whiteSpace = 'pre-wrap';
        bodyDiv.style.wordBreak = 'break-word';
        bodyDiv.textContent = slide.content;
        slideEl.appendChild(bodyDiv);
      }

      // Slide Elements (Images and text blocks)
      if (Array.isArray(slide.elements) && slide.elements.length > 0) {
        const elementsLayer = document.createElement('div');
        elementsLayer.style.position = 'absolute';
        elementsLayer.style.inset = '0';
        elementsLayer.style.pointerEvents = 'none';

        slide.elements.forEach(el => {
          const elBox = document.createElement('div');
          elBox.style.position = 'absolute';
          elBox.style.left = (el.x !== undefined ? el.x : 10) + '%';
          elBox.style.top = (el.y !== undefined ? el.y : 20) + '%';
          if (el.w) elBox.style.width = el.w + '%';
          if (el.h) elBox.style.height = el.h + '%';

          if (el.type === 'text') {
            elBox.style.padding = '12px 16px';
            elBox.style.backgroundColor = 'rgba(255, 255, 255, 0.92)';
            elBox.style.border = '1px solid #d1d5db';
            elBox.style.borderRadius = '6px';
            elBox.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1)';
            elBox.style.color = '#1f2937';
            elBox.style.fontWeight = el.bold ? 'bold' : 'normal';
            elBox.style.fontStyle = el.italic ? 'italic' : 'normal';
            elBox.style.textDecoration = el.underline ? 'underline' : 'none';
            elBox.style.textAlign = el.align || 'left';
            elBox.style.fontSize = (el.fontSize || 18) + 'px';
            elBox.style.whiteSpace = 'pre-wrap';
            elBox.style.wordBreak = 'break-word';
            elBox.textContent = el.content || '';
          } else if (el.type === 'image' && el.src) {
            if (!el.w) elBox.style.width = '30%';
            const img = document.createElement('img');
            img.src = isSafeImageSrc(el.src) ? el.src : '';
            img.style.width = '100%';
            img.style.height = el.h ? '100%' : 'auto';
            img.style.objectFit = 'contain';
            img.style.borderRadius = '6px';
            img.style.border = '1px solid #d1d5db';
            elBox.appendChild(img);
          }
          elementsLayer.appendChild(elBox);
        });
        slideEl.appendChild(elementsLayer);
      }

      document.body.appendChild(slideEl);

      // Wait for any embedded images to complete loading
      const imgs = Array.from(slideEl.querySelectorAll('img'));
      await Promise.all(imgs.map(img => {
        if (!img || img.complete || img.complete === undefined || typeof img.onload === 'undefined') {
          return Promise.resolve();
        }
        return new Promise(res => {
          const timer = setTimeout(res, 1200);
          img.onload = () => { clearTimeout(timer); res(); };
          img.onerror = () => { clearTimeout(timer); res(); };
        });
      }));

      // Render slide to canvas with clean styles
      const canvas = await html2canvas(slideEl, {
        scale: 1.5,
        useCORS: true,
        allowTaint: true,
        logging: false,
        width: 1280,
        height: 720,
        windowWidth: 1280,
        windowHeight: 720,
        x: 0,
        y: 0,
        scrollX: 0,
        scrollY: 0,
        onclone: (clonedDoc) => {
          // Strip Tailwind v4 (output.css) so oklch variables never exist in the cloned document
          try {
            const sheets = Array.from(clonedDoc.querySelectorAll('link[rel="stylesheet"], style'));
            sheets.forEach(s => {
              try {
                const href = (s.getAttribute('href') || '').toLowerCase();
                const text = s.textContent || '';
                if (href.includes('output.css') || href.includes('tailwind') || text.includes('oklch') || text.includes('oklab')) {
                  s.remove();
                }
              } catch (_) {}
            });
          } catch (_) {}

          // Add safe defaults so html2canvas always has valid borders/colors
          try {
            const safeStyle = clonedDoc.createElement('style');
            safeStyle.textContent = `
              *, *::before, *::after {
                border-color: #d1d5db !important;
                outline-color: transparent !important;
              }
            `;
            clonedDoc.head.appendChild(safeStyle);
          } catch (_) {}
        }
      });

      // Remove rendered slide element immediately
      if (slideEl.parentNode) {
        slideEl.parentNode.removeChild(slideEl);
      }

      if (idx > 0) {
        pdf.addPage([1280, 720], 'landscape');
      }

      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      pdf.addImage(imgData, 'JPEG', 0, 0, 1280, 720, undefined, 'FAST');
    }

    pdf.save(`${title || 'presentation'}.pdf`);
    pdfOutput = true;
  } catch (err) {
    console.error('PDF Export Error:', err);
    exportFailed = true;
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast('PDF generation failed. Try PPTX export.', true);
    }
  }

  // Clean up any remaining slide render elements
  try {
    if (typeof document !== 'undefined') {
      document.querySelectorAll('[id^="ppt-render-slide-"]').forEach(el => el.remove());
    }
  } catch (_) {}

  if (!exportFailed && pdfOutput) {
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast('Presentation exported successfully!', false);
    }
  }

  if (!pdfOutput) {
    const title = (typeof document !== 'undefined' && document.getElementById('ppt-doc-title'))
      ? document.getElementById('ppt-doc-title').value
      : 'Presentation';
    pdfOutput = {
      title,
      slideCount: slides.length,
      slides,
      exportedAt: new Date().toISOString()
    };
  }

  return pdfOutput;
}

/**
 * Export Presentation to PPTX: fixes CSS gradient parsing and preserves image/text element aspect ratios
 */
export async function exportPptx() {
  flushSave();
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast('Exporting PPTX presentation...', false);
  }

  let PptxGenJS;
  try {
    if (typeof globalThis.PptxGenJS === 'function') {
      PptxGenJS = globalThis.PptxGenJS;
    } else {
      const module = await import('pptxgenjs');
      PptxGenJS = module.default || module;
    }
    const pres = new PptxGenJS();
    
    const title = (typeof document !== 'undefined' && document.getElementById('ppt-doc-title'))
      ? document.getElementById('ppt-doc-title').value
      : 'Presentation';
    pres.title = title;
    pres.layout = 'LAYOUT_16x9';

    slides.forEach((slide) => {
      const presSlide = pres.addSlide();
      
      const bgColorHex = normalizePptxColor(slide.bg || '#ffffff', 'FFFFFF');
      presSlide.background = { color: bgColorHex };

      if (slide.title) {
        presSlide.addText(slide.title, {
          x: 0.5, y: 0.5, w: '90%', h: 1.5,
          fontSize: 44,
          color: normalizePptxColor(slide.color || '#111827', '111827'),
          bold: true,
          align: slide.align || 'center'
        });
      }

      if (slide.content) {
        presSlide.addText(slide.content, {
          x: 0.5, y: 2.2, w: '90%', h: 3.2,
          fontSize: 24,
          color: normalizePptxColor(slide.color || '#374151', '374151'),
          bold: !!slide.bold,
          italic: !!slide.italic,
          underline: !!slide.underline,
          align: slide.align || 'center',
          valign: 'top'
        });
      }
      
      if (slide.elements && slide.elements.length > 0) {
        slide.elements.forEach(el => {
          const xPos = el.x !== undefined ? (el.x / 100) * 10 : 1;
          const yPos = el.y !== undefined ? (el.y / 100) * 5.625 : 1.5;

          if (el.type === 'text') {
            const wSize = el.w !== undefined ? (el.w / 100) * 10 : 3.5;
            const hSize = el.h !== undefined ? (el.h / 100) * 5.625 : 1.5;

            presSlide.addText(el.content || '', {
              x: xPos, y: yPos, w: wSize, h: hSize,
              fontSize: el.fontSize || 18,
              bold: !!el.bold,
              italic: !!el.italic,
              underline: !!el.underline,
              align: el.align || 'left',
              color: normalizePptxColor(el.color || '333333', '333333'),
              fill: { color: 'FFFFFF', transparency: 10 },
              line: { color: 'D1D5DB', width: 1 },
              valign: 'top'
            });
          } else if (el.type === 'image' && el.src) {
            if (!isSafeImageSrc(el.src)) return;
            // Default 30% width (3 inches), 4:3 proportion (2.25 inches) without distortion
            const wSize = el.w !== undefined ? (el.w / 100) * 10 : 3.0;
            const hSize = el.h !== undefined ? (el.h / 100) * 5.625 : 2.25;

            const imgOpts = {
              x: xPos,
              y: yPos,
              w: wSize,
              h: hSize,
              sizing: { type: 'contain', w: wSize, h: hSize }
            };

            const formatted = formatPptxImageData(el.src);
            if (formatted) {
              Object.assign(imgOpts, formatted);
              presSlide.addImage(imgOpts);
            }
          }
        });
      }
    });

    await pres.writeFile({ fileName: `${title || 'presentation'}.pptx` });
    
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast('PPTX exported successfully!', false);
    }
  } catch (err) {
    console.error('PPTX Export Error:', err);
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast('Error exporting PPTX', true);
    }
  }
}

/**
 * Direct file sharing via Web Share API (WhatsApp, Telegram, Bluetooth, Nearby Share)
 */
export async function sharePresentation() {
  flushSave();
  const title = (typeof document !== 'undefined' && document.getElementById('ppt-doc-title'))
    ? document.getElementById('ppt-doc-title').value
    : 'Presentation';

  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast('Preparing presentation to share...', false);
  }

  try {
    let PptxGenJS;
    if (typeof globalThis.PptxGenJS === 'function') {
      PptxGenJS = globalThis.PptxGenJS;
    } else {
      const module = await import('pptxgenjs');
      PptxGenJS = module.default || module;
    }
    const pres = new PptxGenJS();
    pres.title = title;
    pres.layout = 'LAYOUT_16x9';

    slides.forEach((slide) => {
      const presSlide = pres.addSlide();
      const bgColorHex = normalizePptxColor(slide.bg || '#ffffff', 'FFFFFF');
      presSlide.background = { color: bgColorHex };

      if (slide.title) {
        presSlide.addText(slide.title, {
          x: 0.5, y: 0.5, w: '90%', h: 1.5,
          fontSize: 44,
          color: normalizePptxColor(slide.color || '#111827', '111827'),
          bold: true,
          align: slide.align || 'center'
        });
      }

      if (slide.content) {
        presSlide.addText(slide.content, {
          x: 0.5, y: 2.2, w: '90%', h: 3.2,
          fontSize: 24,
          color: normalizePptxColor(slide.color || '#374151', '374151'),
          bold: !!slide.bold,
          italic: !!slide.italic,
          underline: !!slide.underline,
          align: slide.align || 'center',
          valign: 'top'
        });
      }

      if (slide.elements && slide.elements.length > 0) {
        slide.elements.forEach(el => {
          const xPos = el.x !== undefined ? (el.x / 100) * 10 : 1;
          const yPos = el.y !== undefined ? (el.y / 100) * 5.625 : 1.5;

          if (el.type === 'text') {
            const wSize = el.w !== undefined ? (el.w / 100) * 10 : 3.5;
            const hSize = el.h !== undefined ? (el.h / 100) * 5.625 : 1.5;

            presSlide.addText(el.content || '', {
              x: xPos, y: yPos, w: wSize, h: hSize,
              fontSize: el.fontSize || 18,
              bold: !!el.bold,
              italic: !!el.italic,
              underline: !!el.underline,
              align: el.align || 'left',
              color: normalizePptxColor(el.color || '333333', '333333'),
              fill: { color: 'FFFFFF', transparency: 10 },
              line: { color: 'D1D5DB', width: 1 },
              valign: 'top'
            });
          } else if (el.type === 'image' && el.src) {
            if (!isSafeImageSrc(el.src)) return;
            const wSize = el.w !== undefined ? (el.w / 100) * 10 : 3.0;
            const hSize = el.h !== undefined ? (el.h / 100) * 5.625 : 2.25;

            const imgOpts = {
              x: xPos,
              y: yPos,
              w: wSize,
              h: hSize,
              sizing: { type: 'contain', w: wSize, h: hSize }
            };
            const formatted = formatPptxImageData(el.src);
            if (formatted) {
              Object.assign(imgOpts, formatted);
              presSlide.addImage(imgOpts);
            }
          }
        });
      }
    });

    const blob = await pres.write({ outputType: 'blob' });
    const fileName = `${title || 'presentation'}.pptx`;
    let shared = false;

    if (typeof navigator !== 'undefined' && typeof File !== 'undefined' && navigator.canShare) {
      const file = new File([blob], fileName, { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: title,
          text: `Presentation: ${title}`,
          files: [file]
        });
        shared = true;
      }
    }

    if (!shared && typeof navigator !== 'undefined' && navigator.share) {
      await navigator.share({
        title: title,
        text: `Presentation: ${title}`
      });
      shared = true;
    }

    if (!shared) {
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    }

    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
      window.showToast('Presentation ready to share!', false);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Share Presentation Error:', err);
      await exportPptx();
    }
  }
}

function renderSlide() {
  if (typeof document === 'undefined') return;

  if (slides.length === 0) {
    slides.push({
      id: 'slide_' + Date.now(),
      title: 'Welcome Slide',
      content: 'Add your content here...',
      elements: [],
      bg: '#ffffff',
      color: '#111827',
      align: 'center',
      bold: false,
      italic: false,
      underline: false,
      fontSizeDelta: 0
    });
  }

  if (currentSlideIndex < 0) currentSlideIndex = 0;
  if (currentSlideIndex >= slides.length) currentSlideIndex = slides.length - 1;

  const currentSlide = slides[currentSlideIndex];

  const stage = document.getElementById('ppt-slide-content-stage');
  if (stage) {
    stage.style.background = currentSlide.bg || '#ffffff';
  }

  const titleInput = document.getElementById('ppt-slide-title-input');
  if (titleInput) {
    if (document.activeElement !== titleInput) {
      titleInput.value = currentSlide.title || '';
    }
    titleInput.style.color = currentSlide.color || '#111827';
    titleInput.style.textAlign = currentSlide.align || 'center';
  }

  const contentArea = document.getElementById('ppt-slide-content-area');
  if (contentArea) {
    if (document.activeElement !== contentArea) {
      contentArea.value = currentSlide.content || '';
    }
    contentArea.style.color = currentSlide.color || '#374151';
    contentArea.style.textAlign = currentSlide.align || 'center';
    contentArea.style.fontWeight = currentSlide.bold ? 'bold' : 'normal';
    contentArea.style.fontStyle = currentSlide.italic ? 'italic' : 'normal';
    contentArea.style.textDecoration = currentSlide.underline ? 'underline' : 'none';
    if (currentSlide.fontSizeDelta) {
      contentArea.style.fontSize = `calc(1.25rem + ${currentSlide.fontSizeDelta}px)`;
    } else {
      contentArea.style.fontSize = '';
    }
  }

  const elementsContainer = document.getElementById('ppt-slide-elements-container');
  if (elementsContainer) {
    const existingExtra = elementsContainer.querySelectorAll('.ppt-extra-el');
    existingExtra.forEach(el => el.remove());

    selectedElementIndex = null;
    elementDomRefs = [];

    if (currentSlide.elements && currentSlide.elements.length > 0) {
      currentSlide.elements.forEach((el, index) => {
        if (typeof el.x === 'undefined') el.x = 10 + (index * 5);
        if (typeof el.y === 'undefined') el.y = 20 + (index * 5);

        if (el.type === 'text') {
          const textWrap = document.createElement('div');
          textWrap.className = 'ppt-extra-el absolute pointer-events-auto group';
          textWrap.tabIndex = 0;
          textWrap.style.left = el.x + '%';
          textWrap.style.top = el.y + '%';
          if (el.w) textWrap.style.width = el.w + '%';
          if (el.h) textWrap.style.height = el.h + '%';

          const textDiv = document.createElement('div');
          textDiv.className = 'w-full h-full p-3 bg-white/90 backdrop-blur border border-gray-300 shadow-lg rounded text-gray-800 font-medium focus:ring-2 focus:ring-blue-400 focus:outline-none min-w-[140px] min-h-[48px] overflow-hidden break-words';
          textDiv.contentEditable = "true";
          textDiv.innerText = el.content || 'New Text';
          if (el.bold) textDiv.style.fontWeight = 'bold';
          if (el.italic) textDiv.style.fontStyle = 'italic';
          if (el.underline) textDiv.style.textDecoration = 'underline';
          textDiv.style.textAlign = el.align || 'left';
          textDiv.style.fontSize = (el.fontSize || 18) + 'px';

          elementDomRefs[index] = textDiv;

          const selectThis = () => {
            selectedElementIndex = index;
            updateFormatButtonStates(!!el.bold, !!el.italic, !!el.underline);
            toggleControls(true);
          };

          textDiv.addEventListener('focus', selectThis);
          textWrap.addEventListener('click', (e) => {
            e.stopPropagation();
            selectThis();
          });

          textDiv.addEventListener('input', (e) => {
            slides[currentSlideIndex].elements[index].content = e.target.innerText;
            saveDocumentDebounced(300);
          });

          textDiv.addEventListener('blur', () => {
            flushSave();
          });
          
          // Delete button with accessible >= 32px touch target
          const deleteBtn = document.createElement('button');
          deleteBtn.innerHTML = '<i class="fas fa-times"></i>';
          deleteBtn.className = 'absolute w-8 h-8 sm:w-6 sm:h-6 bg-red-500 border-2 border-white text-white rounded-full flex items-center justify-center text-xs opacity-0 transition-opacity z-30 shadow-md active:scale-90';
          deleteBtn.style.top = '-14px';
          deleteBtn.style.right = '-14px';
          deleteBtn.title = 'Delete Element';
          
          const deleteHandler = (e) => {
             e.stopPropagation();
             e.preventDefault();
             slides[currentSlideIndex].elements.splice(index, 1);
             flushSave();
             renderSlide();
          };
          deleteBtn.onmousedown = deleteHandler;
          deleteBtn.ontouchstart = deleteHandler;
          deleteBtn.onclick = deleteHandler;

          // Drag handle with accessible >= 32px touch target
          const dragBtn = document.createElement('div');
          dragBtn.innerHTML = '<i class="fas fa-arrows-alt"></i>';
          dragBtn.className = 'absolute w-8 h-8 sm:w-6 sm:h-6 bg-green-500 border-2 border-white text-white rounded-full flex items-center justify-center text-xs opacity-0 transition-opacity z-30 cursor-move shadow-md active:scale-90';
          dragBtn.style.top = '-14px';
          dragBtn.style.left = '-14px';
          dragBtn.title = 'Drag to Move';
          
          textWrap.appendChild(textDiv);
          textWrap.appendChild(deleteBtn);
          textWrap.appendChild(dragBtn);
          makeDraggable(textWrap, el, index, dragBtn);
          elementsContainer.appendChild(textWrap);

          const toggleControls = (show) => {
            deleteBtn.style.opacity = show ? '1' : '0';
            dragBtn.style.opacity = show ? '1' : '0';
            const resizer = textWrap.querySelector('.cursor-nwse-resize');
            if (resizer) resizer.style.opacity = show ? '1' : '0';
          };
          textWrap.addEventListener('focusin', () => toggleControls(true));
          textWrap.addEventListener('focusout', (e) => {
            if (!textWrap.contains(e.relatedTarget)) toggleControls(false);
          });
          textWrap.addEventListener('mouseenter', () => toggleControls(true));
          textWrap.addEventListener('mouseleave', () => {
            if (!textWrap.contains(document.activeElement) && selectedElementIndex !== index) {
              toggleControls(false);
            }
          });
        } else if (el.type === 'image') {
          const imgWrap = document.createElement('div');
          imgWrap.className = 'ppt-extra-el absolute pointer-events-auto group';
          imgWrap.tabIndex = 0;
          imgWrap.style.left = el.x + '%';
          imgWrap.style.top = el.y + '%';
          imgWrap.style.width = el.w ? el.w + '%' : '30%';
          if (el.h) imgWrap.style.height = el.h + '%';
          
          const imgEl = document.createElement('img');
          imgEl.className = 'w-full h-full object-contain rounded border border-gray-300 shadow-lg bg-white/80 backdrop-blur pointer-events-none';
          imgEl.src = isSafeImageSrc(el.src) ? el.src : '';
          imgEl.draggable = false;
          
          const selectThisImg = () => {
            selectedElementIndex = index;
            toggleControls(true);
          };

          imgWrap.addEventListener('focus', selectThisImg);
          imgWrap.addEventListener('click', (e) => {
            e.stopPropagation();
            selectThisImg();
          });

          // Delete button with accessible >= 32px touch target
          const deleteBtn = document.createElement('button');
          deleteBtn.innerHTML = '<i class="fas fa-times"></i>';
          deleteBtn.className = 'absolute w-8 h-8 sm:w-6 sm:h-6 bg-red-500 border-2 border-white text-white rounded-full flex items-center justify-center text-xs opacity-0 transition-opacity z-30 shadow-md active:scale-90';
          deleteBtn.style.top = '-14px';
          deleteBtn.style.right = '-14px';
          deleteBtn.title = 'Delete Image';

          const deleteHandler = (e) => {
             e.stopPropagation();
             e.preventDefault();
             slides[currentSlideIndex].elements.splice(index, 1);
             flushSave();
             renderSlide();
          };
          deleteBtn.onmousedown = deleteHandler;
          deleteBtn.ontouchstart = deleteHandler;
          deleteBtn.onclick = deleteHandler;

          // Drag handle with accessible >= 32px touch target
          const dragBtn = document.createElement('div');
          dragBtn.innerHTML = '<i class="fas fa-arrows-alt"></i>';
          dragBtn.className = 'absolute w-8 h-8 sm:w-6 sm:h-6 bg-green-500 border-2 border-white text-white rounded-full flex items-center justify-center text-xs opacity-0 transition-opacity z-30 cursor-move shadow-md active:scale-90';
          dragBtn.style.top = '-14px';
          dragBtn.style.left = '-14px';
          dragBtn.title = 'Drag to Move';

          imgWrap.appendChild(imgEl);
          imgWrap.appendChild(deleteBtn);
          imgWrap.appendChild(dragBtn);
          makeDraggable(imgWrap, el, index, dragBtn);
          elementsContainer.appendChild(imgWrap);

          const toggleControls = (show) => {
            deleteBtn.style.opacity = show ? '1' : '0';
            dragBtn.style.opacity = show ? '1' : '0';
            const resizer = imgWrap.querySelector('.cursor-nwse-resize');
            if (resizer) resizer.style.opacity = show ? '1' : '0';
          };
          imgWrap.addEventListener('focusin', () => toggleControls(true));
          imgWrap.addEventListener('focusout', (e) => {
            if (!imgWrap.contains(e.relatedTarget)) toggleControls(false);
          });
          imgWrap.addEventListener('mouseenter', () => toggleControls(true));
          imgWrap.addEventListener('mouseleave', () => {
            if (!imgWrap.contains(document.activeElement) && selectedElementIndex !== index) {
              toggleControls(false);
            }
          });
        }
      });
    }
  }

  const counterBadge = document.getElementById('ppt-slide-counter');
  if (counterBadge) {
    counterBadge.innerText = `Slide ${currentSlideIndex + 1} of ${slides.length}`;
  }

  const bottomCounter = document.getElementById('ppt-bottom-slide-counter');
  if (bottomCounter) {
    bottomCounter.innerText = `${currentSlideIndex + 1}/${slides.length}`;
  }

  const infoBadge = document.getElementById('ppt-slide-info');
  if (infoBadge) {
    infoBadge.innerText = `Slide ${currentSlideIndex + 1} of ${slides.length}`;
  }

  updateFormatButtonStates(!!currentSlide.bold, !!currentSlide.italic, !!currentSlide.underline);
  renderThumbnails();
}

function renderThumbnails() {
  if (typeof document === 'undefined') return;
  const carousel = document.getElementById('ppt-slides-carousel');
  if (!carousel) return;

  carousel.innerHTML = '';
  slides.forEach((slide, idx) => {
    const isSelected = idx === currentSlideIndex;
    const thumb = document.createElement('div');
    thumb.className = `w-full aspect-video border ${
      isSelected ? 'border-2 border-blue-500 ring-2 ring-blue-400/50 shadow-md' : 'border-gray-700 hover:border-gray-500'
    } rounded-lg p-2 cursor-pointer flex flex-col justify-between overflow-hidden relative flex-shrink-0 select-none shadow transition-all active:scale-[0.98] group`;
    
    thumb.draggable = true;

    if (slide.bg) {
      thumb.style.background = slide.bg;
    } else {
      thumb.style.backgroundColor = '#ffffff';
    }

    // Top row: Title container (sanitized via textContent to eliminate DOM XSS)
    const topRow = document.createElement('div');
    topRow.className = 'flex items-center justify-between gap-1 w-full';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'text-xs font-semibold truncate flex-1 px-1.5 py-0.5 rounded shadow-sm';
    titleDiv.style.color = slide.color || '#1f2937';
    titleDiv.style.background = 'rgba(255,255,255,0.75)';
    titleDiv.style.backdropFilter = 'blur(4px)';
    titleDiv.textContent = slide.title || `Slide ${idx + 1}`;
    topRow.appendChild(titleDiv);

    // Reorder buttons (Move Up / Move Down)
    const reorderControls = document.createElement('div');
    reorderControls.className = 'opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 bg-slate-900/80 p-0.5 rounded shadow';
    
    if (idx > 0) {
      const upBtn = document.createElement('button');
      upBtn.className = 'w-5 h-5 flex items-center justify-center text-slate-300 hover:text-white rounded hover:bg-slate-700 active:scale-90';
      upBtn.innerHTML = '<i class="fas fa-chevron-up text-[9px]"></i>';
      upBtn.title = 'Move slide up';
      upBtn.onclick = (e) => {
        e.stopPropagation();
        moveSlideUp(idx);
      };
      reorderControls.appendChild(upBtn);
    }

    if (idx < slides.length - 1) {
      const downBtn = document.createElement('button');
      downBtn.className = 'w-5 h-5 flex items-center justify-center text-slate-300 hover:text-white rounded hover:bg-slate-700 active:scale-90';
      downBtn.innerHTML = '<i class="fas fa-chevron-down text-[9px]"></i>';
      downBtn.title = 'Move slide down';
      downBtn.onclick = (e) => {
        e.stopPropagation();
        moveSlideDown(idx);
      };
      reorderControls.appendChild(downBtn);
    }
    topRow.appendChild(reorderControls);
    thumb.appendChild(topRow);

    // Bottom row: Slide index number
    const numDiv = document.createElement('div');
    numDiv.className = 'text-[10px] bg-gray-900/80 text-gray-200 px-1.5 py-0.5 rounded self-end font-mono shadow border border-gray-700';
    numDiv.textContent = String(idx + 1);
    thumb.appendChild(numDiv);

    // Click to navigate
    thumb.addEventListener('click', () => {
      goToSlide(idx);
      if (typeof window !== 'undefined' && window.innerWidth < 640) {
        const sidebarWrapper = document.getElementById('ppt-slides-carousel-wrapper');
        const backdrop = document.getElementById('ppt-sidebar-backdrop');
        if (sidebarWrapper) {
          sidebarWrapper.classList.add('hidden');
          sidebarWrapper.classList.remove('flex');
        }
        if (backdrop) backdrop.classList.add('hidden');
      }
    });

    // Drag-and-drop slide reordering
    thumb.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(idx));
      thumb.style.opacity = '0.5';
    });

    thumb.addEventListener('dragend', () => {
      thumb.style.opacity = '1';
    });

    thumb.addEventListener('dragover', (e) => {
      e.preventDefault();
      thumb.classList.add('ring-2', 'ring-blue-400');
    });

    thumb.addEventListener('dragleave', () => {
      thumb.classList.remove('ring-2', 'ring-blue-400');
    });

    thumb.addEventListener('drop', (e) => {
      e.preventDefault();
      thumb.classList.remove('ring-2', 'ring-blue-400');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (!isNaN(fromIdx) && fromIdx !== idx) {
        moveSlide(fromIdx, idx);
      }
    });

    carousel.appendChild(thumb);
  });
}

function bindPowerPointEvents() {
  if (typeof document === 'undefined') return;

  const toggleSidebar = () => {
    const sidebarWrapper = document.getElementById('ppt-slides-carousel-wrapper') || document.getElementById('ppt-slides-carousel');
    const backdrop = document.getElementById('ppt-sidebar-backdrop');
    if (sidebarWrapper) {
      const isHidden = sidebarWrapper.classList.contains('hidden');
      if (isHidden) {
        sidebarWrapper.classList.remove('hidden');
        sidebarWrapper.classList.add('flex');
        if (backdrop) backdrop.classList.remove('hidden');
      } else {
        sidebarWrapper.classList.add('hidden');
        sidebarWrapper.classList.remove('flex');
        if (backdrop) backdrop.classList.add('hidden');
      }
    }
  };

  const toggleSidebarBtn = document.getElementById('btn-ppt-toggle-sidebar');
  if (toggleSidebarBtn) toggleSidebarBtn.addEventListener('click', toggleSidebar);

  const closeSidebarBtn = document.getElementById('btn-ppt-close-sidebar');
  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', () => {
      const sidebarWrapper = document.getElementById('ppt-slides-carousel-wrapper');
      const backdrop = document.getElementById('ppt-sidebar-backdrop');
      if (sidebarWrapper) {
        sidebarWrapper.classList.add('hidden');
        sidebarWrapper.classList.remove('flex');
      }
      if (backdrop) backdrop.classList.add('hidden');
    });
  }

  const sidebarBackdrop = document.getElementById('ppt-sidebar-backdrop');
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', () => {
      const sidebarWrapper = document.getElementById('ppt-slides-carousel-wrapper');
      if (sidebarWrapper) {
        sidebarWrapper.classList.add('hidden');
        sidebarWrapper.classList.remove('flex');
      }
      sidebarBackdrop.classList.add('hidden');
    });
  }

  const sidebarAddSlideBtn = document.getElementById('btn-ppt-add-slide-sidebar');
  if (sidebarAddSlideBtn) sidebarAddSlideBtn.addEventListener('click', () => addSlide());

  const closeBtn = document.getElementById('close-ppt-btn');
  if (closeBtn) closeBtn.addEventListener('click', closePowerPointEditor);

  const titleInput = document.getElementById('ppt-doc-title');
  if (titleInput) {
    titleInput.addEventListener('input', () => {
      saveDocumentDebounced(300);
    });
    titleInput.addEventListener('change', () => {
      flushSave();
    });
  }

  // Top action buttons (desktop)
  const topImportBtn = document.getElementById('ppt-file-btn-import');
  if (topImportBtn) {
    topImportBtn.addEventListener('click', () => {
      const input = document.getElementById('ppt-presentation-import-input');
      if (input) input.click();
    });
  }

  const topPdfBtn = document.getElementById('ppt-file-btn-top');
  if (topPdfBtn) topPdfBtn.addEventListener('click', exportPresentation);

  const topPptxBtn = document.getElementById('btn-ppt-export-pptx');
  if (topPptxBtn) topPptxBtn.addEventListener('click', exportPptx);

  const topNativeBtn = document.getElementById('btn-ppt-export-native');
  if (topNativeBtn) topNativeBtn.addEventListener('click', exportNativePresentation);

  const shareBtn = document.getElementById('btn-ppt-share');
  if (shareBtn) shareBtn.addEventListener('click', sharePresentation);

  // More menu dropdown (mobile)
  const moreMenuBtn = document.getElementById('btn-ppt-more-menu');
  const moreDropdown = document.getElementById('ppt-more-dropdown');
  const closeMoreDropdown = () => {
    if (moreDropdown) moreDropdown.classList.add('hidden');
  };

  if (moreMenuBtn && moreDropdown) {
    moreMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      moreDropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!moreDropdown.contains(e.target) && e.target !== moreMenuBtn) {
        closeMoreDropdown();
      }
    });
  }

  const menuImportBtn = document.getElementById('btn-ppt-menu-import');
  if (menuImportBtn) {
    menuImportBtn.addEventListener('click', () => {
      closeMoreDropdown();
      const input = document.getElementById('ppt-presentation-import-input');
      if (input) input.click();
    });
  }

  const menuPdfBtn = document.getElementById('btn-ppt-menu-pdf');
  if (menuPdfBtn) menuPdfBtn.addEventListener('click', () => { closeMoreDropdown(); exportPresentation(); });

  const menuPptxBtn = document.getElementById('btn-ppt-menu-pptx');
  if (menuPptxBtn) menuPptxBtn.addEventListener('click', () => { closeMoreDropdown(); exportPptx(); });

  const menuNativeBtn = document.getElementById('btn-ppt-menu-native');
  if (menuNativeBtn) menuNativeBtn.addEventListener('click', () => { closeMoreDropdown(); exportNativePresentation(); });

  const menuShareBtn = document.getElementById('btn-ppt-menu-share');
  if (menuShareBtn) menuShareBtn.addEventListener('click', () => { closeMoreDropdown(); sharePresentation(); });

  const menuMoveUpBtn = document.getElementById('btn-ppt-menu-move-up');
  if (menuMoveUpBtn) menuMoveUpBtn.addEventListener('click', () => { closeMoreDropdown(); moveSlideUp(); });

  const menuMoveDownBtn = document.getElementById('btn-ppt-menu-move-down');
  if (menuMoveDownBtn) menuMoveDownBtn.addEventListener('click', () => { closeMoreDropdown(); moveSlideDown(); });

  const menuDupBtn = document.getElementById('btn-ppt-menu-dup');
  if (menuDupBtn) menuDupBtn.addEventListener('click', () => { closeMoreDropdown(); duplicateSlide(); });

  const menuDelBtn = document.getElementById('btn-ppt-menu-del');
  if (menuDelBtn) menuDelBtn.addEventListener('click', () => { closeMoreDropdown(); deleteSlide(); });

  // Presentation file import input handler
  const presImportInput = document.getElementById('ppt-presentation-import-input');
  if (presImportInput) {
    presImportInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        await importPresentation(file);
      }
      e.target.value = '';
    });
  }

  const slideTitleInput = document.getElementById('ppt-slide-title-input');
  if (slideTitleInput) {
    slideTitleInput.addEventListener('input', (e) => {
      if (slides[currentSlideIndex]) {
        slides[currentSlideIndex].title = e.target.value;
        renderThumbnails();
        saveDocumentDebounced(300);
      }
    });
    slideTitleInput.addEventListener('blur', () => {
      flushSave();
    });
    slideTitleInput.addEventListener('focus', (e) => {
      selectedElementIndex = null;
      const s = slides[currentSlideIndex];
      if (s) updateFormatButtonStates(!!s.bold, !!s.italic, !!s.underline);
      e.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  const slideContentArea = document.getElementById('ppt-slide-content-area');
  if (slideContentArea) {
    slideContentArea.addEventListener('input', (e) => {
      if (slides[currentSlideIndex]) {
        slides[currentSlideIndex].content = e.target.value;
        saveDocumentDebounced(300);
      }
    });
    slideContentArea.addEventListener('blur', () => {
      flushSave();
    });
    slideContentArea.addEventListener('focus', (e) => {
      selectedElementIndex = null;
      const s = slides[currentSlideIndex];
      if (s) updateFormatButtonStates(!!s.bold, !!s.italic, !!s.underline);
      e.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  const ppSlideStage = document.getElementById('ppt-slide-content-stage');
  if (ppSlideStage) {
    ppSlideStage.addEventListener('click', (e) => {
      if (e.target === ppSlideStage) {
        selectedElementIndex = null;
        const s = slides[currentSlideIndex];
        if (s) updateFormatButtonStates(!!s.bold, !!s.italic, !!s.underline);
        // Hide control handles on unselected elements
        const elementsContainer = document.getElementById('ppt-slide-elements-container');
        if (elementsContainer) {
          const controls = elementsContainer.querySelectorAll('.opacity-100');
          controls.forEach(c => { c.style.opacity = '0'; });
        }
      }
    });
  }

  // Navigation buttons
  const prevBtn = document.getElementById('ppt-prev-slide-btn');
  if (prevBtn) prevBtn.addEventListener('click', prevSlide);

  const nextBtn = document.getElementById('ppt-next-slide-btn');
  if (nextBtn) nextBtn.addEventListener('click', nextSlide);

  const prevBottomBtn = document.getElementById('btn-ppt-prev-bottom');
  if (prevBottomBtn) prevBottomBtn.addEventListener('click', prevSlide);

  const nextBottomBtn = document.getElementById('btn-ppt-next-bottom');
  if (nextBottomBtn) nextBottomBtn.addEventListener('click', nextSlide);

  // Desktop Toolbar Buttons
  const addSlideBtn = document.getElementById('btn-ppt-add-slide');
  if (addSlideBtn) addSlideBtn.addEventListener('click', () => addSlide());

  const dupSlideBtn = document.getElementById('btn-ppt-dup-slide');
  if (dupSlideBtn) dupSlideBtn.addEventListener('click', () => duplicateSlide());

  const moveUpBtn = document.getElementById('btn-ppt-move-up');
  if (moveUpBtn) moveUpBtn.addEventListener('click', () => moveSlideUp());

  const moveDownBtn = document.getElementById('btn-ppt-move-down');
  if (moveDownBtn) moveDownBtn.addEventListener('click', () => moveSlideDown());

  const addTextBtn = document.getElementById('btn-ppt-add-text');
  if (addTextBtn) addTextBtn.addEventListener('click', () => addTextElement());

  const addImgBtn = document.getElementById('btn-ppt-add-image');
  if (addImgBtn) addImgBtn.addEventListener('click', triggerImageUpload);

  const themeBtn = document.getElementById('btn-ppt-theme');
  if (themeBtn) themeBtn.addEventListener('click', cycleTheme);

  const delSlideBtn = document.getElementById('btn-ppt-del-slide');
  if (delSlideBtn) delSlideBtn.addEventListener('click', () => deleteSlide());

  // Mobile Bottom Dock Buttons
  const addSlideMobileBtn = document.getElementById('btn-ppt-add-slide-mobile');
  if (addSlideMobileBtn) addSlideMobileBtn.addEventListener('click', () => addSlide());

  const addTextMobileBtn = document.getElementById('btn-ppt-add-text-mobile');
  if (addTextMobileBtn) addTextMobileBtn.addEventListener('click', () => addTextElement());

  const addImgMobileBtn = document.getElementById('btn-ppt-add-image-mobile');
  if (addImgMobileBtn) addImgMobileBtn.addEventListener('click', triggerImageUpload);

  const themeMobileBtn = document.getElementById('btn-ppt-theme-mobile');
  if (themeMobileBtn) themeMobileBtn.addEventListener('click', cycleTheme);

  const toggleFormatMobileBtn = document.getElementById('btn-ppt-toggle-format-mobile');
  if (toggleFormatMobileBtn) {
    toggleFormatMobileBtn.addEventListener('click', () => {
      const fmtToolbar = document.getElementById('ppt-formatting-toolbar');
      if (fmtToolbar) {
        fmtToolbar.classList.toggle('hidden');
        if (!fmtToolbar.classList.contains('hidden')) {
          toggleFormatMobileBtn.style.backgroundColor = '#2563eb';
          toggleFormatMobileBtn.style.color = '#ffffff';
        } else {
          toggleFormatMobileBtn.style.backgroundColor = '#334155';
          toggleFormatMobileBtn.style.color = '#e2e8f0';
        }
      }
    });
  }

  // Formatting Toolbar Buttons
  const fmtBoldBtn = document.getElementById('btn-ppt-fmt-bold');
  if (fmtBoldBtn) fmtBoldBtn.addEventListener('click', () => applyFormatting('bold'));

  const fmtItalicBtn = document.getElementById('btn-ppt-fmt-italic');
  if (fmtItalicBtn) fmtItalicBtn.addEventListener('click', () => applyFormatting('italic'));

  const fmtUnderlineBtn = document.getElementById('btn-ppt-fmt-underline');
  if (fmtUnderlineBtn) fmtUnderlineBtn.addEventListener('click', () => applyFormatting('underline'));

  const fmtListBtn = document.getElementById('btn-ppt-fmt-list');
  if (fmtListBtn) fmtListBtn.addEventListener('click', () => applyFormatting('list'));

  const fmtAlignBtn = document.getElementById('btn-ppt-fmt-align');
  if (fmtAlignBtn) fmtAlignBtn.addEventListener('click', () => applyFormatting('align'));

  const fmtSizeUpBtn = document.getElementById('btn-ppt-fmt-size-up');
  if (fmtSizeUpBtn) fmtSizeUpBtn.addEventListener('click', () => applyFormatting('size-up'));

  const fmtSizeDownBtn = document.getElementById('btn-ppt-fmt-size-down');
  if (fmtSizeDownBtn) fmtSizeDownBtn.addEventListener('click', () => applyFormatting('size-down'));

  const imgUploadInput = document.getElementById('ppt-image-upload-input');
  if (imgUploadInput) {
    imgUploadInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        try {
          const compressed = await compressImage(file, 1200, 900, 0.75);
          if (compressed) {
            addImageElement(compressed);
          }
        } catch (err) {
          const reader = new FileReader();
          reader.onload = (event) => {
            addImageElement(event.target.result);
          };
          reader.readAsDataURL(file);
        }
      }
      e.target.value = '';
    });
  }

  // Present Mode Buttons & Listeners
  const presentBtn = document.getElementById('btn-ppt-present');
  if (presentBtn) {
    presentBtn.addEventListener('click', () => startPresentMode());
  }

  const presentExitBtn = document.getElementById('btn-present-exit');
  if (presentExitBtn) {
    presentExitBtn.addEventListener('click', exitPresentMode);
  }

  const presentPrevBtn = document.getElementById('btn-present-prev');
  if (presentPrevBtn) {
    presentPrevBtn.addEventListener('click', prevPresentSlide);
  }

  const presentNextBtn = document.getElementById('btn-present-next');
  if (presentNextBtn) {
    presentNextBtn.addEventListener('click', nextPresentSlide);
  }

  const presentFullscreenBtn = document.getElementById('btn-present-fullscreen-toggle');
  if (presentFullscreenBtn) {
    presentFullscreenBtn.addEventListener('click', () => {
      const overlay = document.getElementById('ppt-present-overlay');
      if (!overlay) return;
      const isFs = document.fullscreenElement || document.webkitFullscreenElement;
      if (!isFs) {
        if (overlay.requestFullscreen) overlay.requestFullscreen().catch(() => {});
        else if (overlay.webkitRequestFullscreen) overlay.webkitRequestFullscreen();
      } else {
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      }
    });
  }

  const presentOverlay = document.getElementById('ppt-present-overlay');
  if (presentOverlay) {
    presentOverlay.addEventListener('mousemove', showPresentControlsTemporarily);
    presentOverlay.addEventListener('touchstart', showPresentControlsTemporarily, { passive: true });

    // Touch swipe gestures & tap zones for Present mode
    let touchStartX = 0;
    let touchStartY = 0;
    presentOverlay.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    presentOverlay.addEventListener('touchend', (e) => {
      if (e.changedTouches && e.changedTouches[0]) {
        const deltaX = e.changedTouches[0].clientX - touchStartX;
        const deltaY = e.changedTouches[0].clientY - touchStartY;
        if (Math.abs(deltaX) > 45 && Math.abs(deltaY) < 60) {
          if (deltaX < 0) nextPresentSlide();
          else prevPresentSlide();
        } else if (Math.abs(deltaX) < 15 && Math.abs(deltaY) < 15) {
          // Tap zone navigation (ignore if user tapped on floating controls)
          if (e.target && typeof e.target.closest === 'function' && e.target.closest('#ppt-present-controls')) {
            return;
          }
          const screenW = window.innerWidth || 800;
          const touchX = e.changedTouches[0].clientX;
          if (touchX < screenW * 0.25) {
            prevPresentSlide();
          } else if (touchX > screenW * 0.75) {
            nextPresentSlide();
          }
        }
      }
    }, { passive: true });
  }

  // Touch swipe on Slide Canvas in editor
  const slideFrame = document.getElementById('ppt-slide-frame');
  if (slideFrame) {
    let frameTouchStartX = 0;
    let frameTouchStartY = 0;

    slideFrame.addEventListener('touchstart', (e) => {
      if (e.target.closest('.ppt-extra-el') || e.target.closest('input') || e.target.closest('textarea')) {
        return;
      }
      if (e.touches && e.touches[0]) {
        frameTouchStartX = e.touches[0].clientX;
        frameTouchStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    slideFrame.addEventListener('touchend', (e) => {
      if (e.target.closest('.ppt-extra-el') || e.target.closest('input') || e.target.closest('textarea')) {
        return;
      }
      if (e.changedTouches && e.changedTouches[0]) {
        const deltaX = e.changedTouches[0].clientX - frameTouchStartX;
        const deltaY = e.changedTouches[0].clientY - frameTouchStartY;
        if (Math.abs(deltaX) > 50 && Math.abs(deltaY) < 40) {
          if (deltaX < 0) nextSlide();
          else prevSlide();
        }
      }
    }, { passive: true });
  }

  // Keyboard navigation for editor when not editing text
  document.addEventListener('keydown', (e) => {
    if (isPresenting) return;
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      return;
    }
    const modal = document.getElementById('ppt-editor-modal');
    if (!modal || modal.classList.contains('hidden')) return;

    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      nextSlide();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      prevSlide();
    }
  });

  // Flush on unload
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => flushSave());
    window.addEventListener('pagehide', () => flushSave());
  }
}

function triggerImageUpload() {
  const input = document.getElementById('ppt-image-upload-input');
  if (input) input.click();
}

const THEMES = [
  { bg: '#ffffff', color: '#111827' },
  { bg: '#1f2937', color: '#f3f4f6' },
  { bg: 'linear-gradient(135deg, #f6d365 0%, #fda085 100%)', color: '#111827' },
  { bg: 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)', color: '#ffffff' },
  { bg: 'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)', color: '#111827' },
  { bg: 'linear-gradient(135deg, #2c3e50 0%, #3498db 100%)', color: '#ffffff' },
];

function cycleTheme() {
  if (!slides[currentSlideIndex]) return;
  const currentBg = slides[currentSlideIndex].bg || '#ffffff';
  let nextIdx = THEMES.findIndex(t => t.bg === currentBg) + 1;
  if (nextIdx >= THEMES.length) nextIdx = 0;
  
  slides[currentSlideIndex].bg = THEMES[nextIdx].bg;
  slides[currentSlideIndex].color = THEMES[nextIdx].color;
  renderSlide();
  flushSave();
}

/**
 * Mobile-friendly element drag and resize handler with touch target hit zones >= 32px
 */
function makeDraggable(element, elState, index, dragHandle = null) {
  let dragStartX = 0, dragStartY = 0;
  let initialX_pct = 0, initialY_pct = 0;
  let initialW_pct = 0, initialH_pct = 0;
  let isResizing = false;

  const resizer = document.createElement('div');
  resizer.className = 'absolute w-7 h-7 sm:w-5 sm:h-5 bg-blue-600 border-2 border-white rounded-full cursor-nwse-resize opacity-0 transition-opacity z-40 shadow-md active:scale-110';
  resizer.style.bottom = '-12px';
  resizer.style.right = '-12px';
  resizer.style.touchAction = 'none';
  resizer.title = 'Drag to Resize';
  resizer.onmousedown = (e) => { e.stopPropagation(); dragStart(e, true); };
  resizer.ontouchstart = (e) => { e.stopPropagation(); dragStart(e, true); };
  element.appendChild(resizer);

  const trigger = dragHandle || element;
  trigger.style.touchAction = 'none';
  trigger.onmousedown = (e) => { e.stopPropagation(); dragStart(e, false); };
  trigger.ontouchstart = (e) => { e.stopPropagation(); dragStart(e, false); };

  function dragStart(e, resizing) {
    if (e.type !== 'touchstart') {
      e.preventDefault(); 
    }
    
    isResizing = resizing;

    if (e.type === 'touchstart') {
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
    } else {
      dragStartX = e.clientX;
      dragStartY = e.clientY;
    }
    
    const stage = document.getElementById('ppt-slide-content-stage');
    const rect = stage ? stage.getBoundingClientRect() : { width: 1000, height: 562.5 };

    initialX_pct = elState.x !== undefined ? elState.x : ((element.offsetLeft || 0) / (rect.width || 1000) * 100);
    initialY_pct = elState.y !== undefined ? elState.y : ((element.offsetTop || 0) / (rect.height || 562.5) * 100);
    initialW_pct = elState.w !== undefined ? elState.w : ((element.offsetWidth || 100) / (rect.width || 1000) * 100);
    initialH_pct = elState.h !== undefined ? elState.h : ((element.offsetHeight || 50) / (rect.height || 562.5) * 100);
    
    document.addEventListener('mouseup', dragEnd);
    document.addEventListener('mousemove', dragAction);
    document.addEventListener('touchend', dragEnd);
    document.addEventListener('touchmove', dragAction, { passive: false });
  }

  function dragAction(e) {
    let currentX, currentY;
    if (e.type === 'touchmove') {
      if (e.cancelable) e.preventDefault(); 
      currentX = e.touches[0].clientX;
      currentY = e.touches[0].clientY;
    } else {
      currentX = e.clientX;
      currentY = e.clientY;
    }
    const dx = currentX - dragStartX;
    const dy = currentY - dragStartY;
    
    const stage = document.getElementById('ppt-slide-content-stage');
    const rect = stage ? stage.getBoundingClientRect() : { width: 1000, height: 562.5 };
    
    const dx_pct = (dx / (rect.width || 1000)) * 100;
    const dy_pct = (dy / (rect.height || 562.5)) * 100;
    
    if (isResizing) {
      elState.w = Math.max(5, Math.min(95, initialW_pct + dx_pct));
      elState.h = Math.max(5, Math.min(95, initialH_pct + dy_pct));
      element.style.width = elState.w + '%';
      element.style.height = elState.h + '%';
    } else {
      elState.x = Math.max(0, Math.min(95, initialX_pct + dx_pct));
      elState.y = Math.max(0, Math.min(95, initialY_pct + dy_pct));
      element.style.left = elState.x + '%';
      element.style.top = elState.y + '%';
    }
  }

  function dragEnd() {
    document.removeEventListener('mouseup', dragEnd);
    document.removeEventListener('mousemove', dragAction);
    document.removeEventListener('touchend', dragEnd);
    document.removeEventListener('touchmove', dragAction);
    
    if (slides[currentSlideIndex] && slides[currentSlideIndex].elements) {
      const curElements = slides[currentSlideIndex].elements;
      const targetIdx = curElements.findIndex(e => (e && elState && e.id && e.id === elState.id) || e === elState);
      if (targetIdx !== -1) {
        curElements[targetIdx] = elState;
      } else if (curElements[index]) {
        curElements[index] = elState;
      }
      flushSave();
    }
  }
}
