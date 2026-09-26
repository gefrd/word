/**
 * word.js — Mobile-first Word-style editor (Tiptap / contenteditable)
 * ------------------------------------------------------------------
 * Design goals:
 *   1. PHONE FIRST: Uses native contenteditable so on-screen keyboard,
 *      text selection handles and IME behave natively on Android + iPhone,
 *      Chrome + Safari, without any jumping or broken layouts.
 *   2. Text REFLOWS to the screen width: A single continuous, comfortable
 *      editing surface.
 *   3. PAGE BREAKS: Explicit page break node ("📄 Page Break / Разрыв страницы")
 *      insertable via the INSERT tab, translated to CSS page breaks in PDF and DOCX.
 *   4. 100% CLIENT-SIDE PDF & DOCX EXPORT:
 *      - PDF: Direct Blob generation via html2canvas + jsPDF with automatic
 *        multi-page slicing and direct download (never uses window.print).
 *      - DOCX: Native client-side docx conversion and direct download.
 *   5. HIGHLIGHTS ARE PAINTED ON THE CANVAS, NOT BY html2canvas
 *      (fix 2026-08-26): html2canvas gets inline backgrounds wrong twice over.
 *      It derives the background box from a single getBoundingClientRect(), so
 *      a highlight wrapping onto a second line became one full-width block
 *      painted over already-rendered text (box-decoration-break is ignored),
 *      and the band is drawn about half an em above the glyphs it belongs to
 *      (measured on real output: 21.7px against a 46px em).
 *      Therefore every inline background is stripped before rasterizing
 *      (collectInlineHighlights), its per-line rectangles are kept, and after
 *      the page is rasterized the bands are filled straight onto the canvas
 *      with the 'multiply' blend mode and snapped onto the glyph ink actually
 *      present in the bitmap (paintHighlightBands). Multiply means text can
 *      never be hidden by a band, whatever the renderer does. The one text that
 *      cannot survive on the white raster is light text that relied on a dark
 *      highlight for contrast, so such a run is darkened, keeping its hue
 *      (darkenLightTextInRun) — the characters matter more than their colour.
 *      Editor-only decorations (find & replace highlights, resize handles) are
 *      also stripped from exported HTML (sanitizeExportHtml).
 */

import { Editor, Extension, Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extension-placeholder';
import { TextAlign } from '@tiptap/extension-text-align';
import { Image } from '@tiptap/extension-image';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { Color } from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import FontFamily from '@tiptap/extension-font-family';

/* ============================================================
 * Small helpers
 * ========================================================== */
function toast(msg, isError = false) {
    if (typeof window.showToast === 'function') window.showToast(msg, isError);
    else if (isError) console.error(msg); else console.log(msg);
}
const $ = (id) => document.getElementById(id);

/* ============================================================
 * Geometry constants (used for export)
 * ========================================================== */
const PX_PER_CM = 37.795; // 96 DPI

const PAPER_SIZES = {
    A4:     { cssW: '21cm',    cssH: '29.7cm',  pxW: 794,  pxH: 1123 },
    Letter: { cssW: '21.59cm', cssH: '27.94cm', pxW: 816,  pxH: 1056 },
    A5:     { cssW: '14.8cm',  cssH: '21cm',    pxW: 559,  pxH: 794 },
};

const DEFAULT_MARGINS = { top: 96, bottom: 96, left: 96, right: 96 }; // 2.54cm each

/* ============================================================
 * Custom Tiptap Extensions
 * ========================================================== */

// Page Break Node Extension
const PageBreak = Node.create({
    name: 'pageBreak',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    parseHTML() {
        return [
            { tag: 'div[data-type="page-break"]' },
            { tag: 'hr[data-type="page-break"]' },
            { tag: 'hr.page-break' }
        ];
    },
    renderHTML({ HTMLAttributes }) {
        return [
            'div',
            mergeAttributes(HTMLAttributes, { 'data-type': 'page-break', class: 'word-page-break-node' }),
            ['span', { class: 'word-page-break-label' }, '📄 Page Break']
        ];
    },
    addCommands() {
        return {
            setPageBreak: () => ({ chain }) => {
                return chain()
                    .insertContent({ type: this.name })
                    .createParagraphNear()
                    .run();
            },
        };
    },
});

// Find & Replace highlight plugin (decoration-based).
const SearchPluginKey = new PluginKey('search');
const SearchExtension = Extension.create({
    name: 'search',
    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: SearchPluginKey,
                state: {
                    init() { return DecorationSet.empty; },
                    apply(tr, oldState) {
                        const meta = tr.getMeta(SearchPluginKey);
                        if (meta !== undefined) return meta.decorations || DecorationSet.empty;
                        return oldState.map(tr.mapping, tr.doc);
                    },
                },
                props: { decorations(state) { return this.getState(state); } },
            }),
        ];
    },
});

const FontSize = Extension.create({
    name: 'fontSize',
    addOptions() { return { types: ['textStyle'] }; },
    addGlobalAttributes() {
        return [{
            types: this.options.types,
            attributes: {
                fontSize: {
                    default: null,
                    parseHTML: element => element.style.fontSize?.replace(/['"]+/g, ''),
                    renderHTML: attributes => {
                        if (!attributes.fontSize) return {};
                        return { style: `font-size: ${attributes.fontSize}` };
                    },
                },
            },
        }];
    },
    addCommands() {
        return {
            setFontSize: fontSize => ({ chain }) => chain().setMark('textStyle', { fontSize }).run(),
            unsetFontSize: () => ({ chain }) => chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
        };
    },
});

const Indent = Extension.create({
    name: 'indent',
    addOptions() { return { types: ['paragraph', 'heading', 'listItem'], minIndent: 0, maxIndent: 200, indentStep: 20 }; },
    addGlobalAttributes() {
        return [{
            types: this.options.types,
            attributes: {
                indent: {
                    default: 0,
                    parseHTML: element => parseInt(element.style.paddingLeft || '0', 10),
                    renderHTML: attributes => {
                        if (!attributes.indent || attributes.indent === 0) return {};
                        return { style: `padding-left: ${attributes.indent}px` };
                    },
                },
            },
        }];
    },
    addCommands() {
        return {
            indent: () => ({ tr, state, dispatch }) => {
                const { selection } = state;
                tr = tr.setSelection(selection);
                let updated = false;
                const indentedListItems = new Set();
                state.doc.nodesBetween(selection.from, selection.to, (node, pos, parent) => {
                    if (this.options.types.includes(node.type.name)) {
                        // Skip paragraph/heading inside listItem to avoid double indent
                        if (node.type.name !== 'listItem' && parent && parent.type.name === 'listItem') return;
                        const indent = (node.attrs.indent || 0) + this.options.indentStep;
                        if (indent <= this.options.maxIndent) {
                            tr = tr.setNodeMarkup(pos, node.type, { ...node.attrs, indent });
                            updated = true;
                        }
                    }
                });
                if (updated && dispatch) dispatch(tr);
                return true;
            },
            outdent: () => ({ tr, state, dispatch }) => {
                const { selection } = state;
                tr = tr.setSelection(selection);
                let updated = false;
                state.doc.nodesBetween(selection.from, selection.to, (node, pos, parent) => {
                    if (this.options.types.includes(node.type.name)) {
                        // Skip paragraph/heading inside listItem to avoid double outdent
                        if (node.type.name !== 'listItem' && parent && parent.type.name === 'listItem') return;
                        const indent = (node.attrs.indent || 0) - this.options.indentStep;
                        if (indent >= this.options.minIndent) {
                            tr = tr.setNodeMarkup(pos, node.type, { ...node.attrs, indent });
                            updated = true;
                        }
                    }
                });
                if (updated && dispatch) dispatch(tr);
                return true;
            },
        };
    },
});

const LineHeight = Extension.create({
    name: 'lineHeight',
    addOptions() { return { types: ['paragraph', 'heading', 'listItem'] }; },
    addGlobalAttributes() {
        return [{
            types: this.options.types,
            attributes: {
                lineHeight: {
                    default: 'normal',
                    parseHTML: element => element.style.lineHeight || 'normal',
                    renderHTML: attributes => {
                        if (!attributes.lineHeight || attributes.lineHeight === 'normal') return {};
                        return { style: `line-height: ${attributes.lineHeight}` };
                    },
                },
            },
        }];
    },
    addCommands() {
        return {
            setLineHeight: lineHeight => ({ commands }) => {
                let applied = false;
                this.options.types.forEach(type => { if (commands.updateAttributes(type, { lineHeight })) applied = true; });
                return applied;
            },
            unsetLineHeight: () => ({ commands }) => {
                let applied = false;
                this.options.types.forEach(type => { if (commands.resetAttributes(type, 'lineHeight')) applied = true; });
                return applied;
            },
        };
    },
});

/* ============================================================
 * Module state
 * ========================================================== */
let wordEditor = null;
let currentDocId = null;
let currentPaperSize = 'A4';
let docMargins = { ...DEFAULT_MARGINS };
let isLandscape = false;
let eventsBound = false;
let saveStatusTimer = null;

// Text color & selection state tracking
let lastEditorSelection = null;
let activeTextColor = '#000000';

const NAMED_COLORS = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
    yellow: '#ffff00', purple: '#800080', gray: '#808080', grey: '#808080', orange: '#ffa500'
};

export function toHexColor(color) {
    if (!color) return '#000000';
    const c = String(color).trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(c)) return c;
    if (/^#[0-9a-f]{3}$/.test(c)) {
        return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    }
    if (NAMED_COLORS[c]) return NAMED_COLORS[c];
    const rgb = parseRgb(c);
    if (rgb) {
        return '#' + rgb.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
    }
    return '#000000';
}

export function applyTextColor(colorVal) {
    if (!wordEditor) return;
    const hex = toHexColor(colorVal || activeTextColor);
    activeTextColor = hex;

    // Restore selection if previously recorded and editor was blurred
    if (lastEditorSelection && !lastEditorSelection.empty) {
        const docSize = wordEditor.state.doc.content.size;
        const from = Math.max(0, Math.min(lastEditorSelection.from, docSize));
        const to = Math.max(0, Math.min(lastEditorSelection.to, docSize));
        wordEditor.commands.setTextSelection({ from, to });
        wordEditor.chain().focus().setColor(hex).run();
    } else if (wordEditor.state.selection.empty) {
        if (wordEditor.isActive('textStyle')) {
            wordEditor.chain().focus().extendMarkRange('textStyle').setColor(hex).run();
        } else {
            // Expand to current word if cursor is inside or adjacent to word characters
            const { $from } = wordEditor.state.selection;
            const textBefore = $from.nodeBefore?.isText ? $from.nodeBefore.text : '';
            const textAfter = $from.nodeAfter?.isText ? $from.nodeAfter.text : '';
            if (textBefore || textAfter) {
                const matchBefore = textBefore.match(/\S+$/);
                const matchAfter = textAfter.match(/^\S+/);
                const start = $from.pos - (matchBefore ? matchBefore[0].length : 0);
                const end = $from.pos + (matchAfter ? matchAfter[0].length : 0);
                if (end > start) {
                    wordEditor.commands.setTextSelection({ from: start, to: end });
                    wordEditor.chain().focus().setColor(hex).run();
                } else {
                    wordEditor.chain().focus().setColor(hex).run();
                }
            } else {
                wordEditor.chain().focus().setColor(hex).run();
            }
        }
    } else {
        wordEditor.chain().focus().setColor(hex).run();
    }

    const colorInput = $('btn-color');
    if (colorInput) colorInput.value = hex;
    const colorBar = $('color-indicator-bar');
    if (colorBar) colorBar.style.backgroundColor = hex;
}

export function clearTextColor() {
    if (!wordEditor) return;
    activeTextColor = '#000000';
    const colorBar = $('color-indicator-bar');
    if (colorBar) colorBar.style.backgroundColor = '#000000';
    const colorInput = $('btn-color');
    if (colorInput) colorInput.value = '#000000';

    if (lastEditorSelection && !lastEditorSelection.empty) {
        const docSize = wordEditor.state.doc.content.size;
        const from = Math.max(0, Math.min(lastEditorSelection.from, docSize));
        const to = Math.max(0, Math.min(lastEditorSelection.to, docSize));
        wordEditor.commands.setTextSelection({ from, to });
        wordEditor.chain().focus().unsetColor().run();
    } else if (wordEditor.state.selection.empty && wordEditor.isActive('textStyle')) {
        wordEditor.chain().focus().extendMarkRange('textStyle').unsetColor().run();
    } else {
        wordEditor.chain().focus().unsetColor().run();
    }
}

export function applyHighlightColor(colorVal) {
    if (!wordEditor) return;
    const hex = toHexColor(colorVal || '#ffff00');

    if (lastEditorSelection && !lastEditorSelection.empty) {
        const docSize = wordEditor.state.doc.content.size;
        const from = Math.max(0, Math.min(lastEditorSelection.from, docSize));
        const to = Math.max(0, Math.min(lastEditorSelection.to, docSize));
        wordEditor.commands.setTextSelection({ from, to });
        wordEditor.chain().focus().setHighlight({ color: hex }).run();
    } else if (wordEditor.state.selection.empty) {
        if (wordEditor.isActive('highlight')) {
            wordEditor.chain().focus().extendMarkRange('highlight').setHighlight({ color: hex }).run();
        } else {
            const { $from } = wordEditor.state.selection;
            const textBefore = $from.nodeBefore?.isText ? $from.nodeBefore.text : '';
            const textAfter = $from.nodeAfter?.isText ? $from.nodeAfter.text : '';
            if (textBefore || textAfter) {
                const matchBefore = textBefore.match(/\S+$/);
                const matchAfter = textAfter.match(/^\S+/);
                const start = $from.pos - (matchBefore ? matchBefore[0].length : 0);
                const end = $from.pos + (matchAfter ? matchAfter[0].length : 0);
                if (end > start) {
                    wordEditor.commands.setTextSelection({ from: start, to: end });
                    wordEditor.chain().focus().setHighlight({ color: hex }).run();
                } else {
                    wordEditor.chain().focus().setHighlight({ color: hex }).run();
                }
            } else {
                wordEditor.chain().focus().setHighlight({ color: hex }).run();
            }
        }
    } else {
        wordEditor.chain().focus().setHighlight({ color: hex }).run();
    }

    const hlInput = $('btn-highlight-color');
    if (hlInput) hlInput.value = hex;
}

export function clearHighlightColor() {
    if (!wordEditor) return;
    if (lastEditorSelection && !lastEditorSelection.empty) {
        const docSize = wordEditor.state.doc.content.size;
        const from = Math.max(0, Math.min(lastEditorSelection.from, docSize));
        const to = Math.max(0, Math.min(lastEditorSelection.to, docSize));
        wordEditor.commands.setTextSelection({ from, to });
        wordEditor.chain().focus().unsetHighlight().run();
    } else if (wordEditor.state.selection.empty && wordEditor.isActive('highlight')) {
        wordEditor.chain().focus().extendMarkRange('highlight').unsetHighlight().run();
    } else {
        wordEditor.chain().focus().unsetHighlight().run();
    }
}

// Find & Replace state
let searchMatches = [];   // [{from, to}]
let searchIndex = -1;

/* ============================================================
 * Storage
 * ========================================================== */
const WORD_STORAGE_KEY_PREFIX = 'kivu_doc_';
const WORD_DOCS_INDEX = 'kivu_docs_index';

function getDocsIndex() {
    try {
        const idx = localStorage.getItem(WORD_DOCS_INDEX);
        const parsed = idx ? JSON.parse(idx) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
}
function saveDocsIndex(index) {
    try {
        localStorage.setItem(WORD_DOCS_INDEX, JSON.stringify(index));
    } catch (e) { console.warn('[Word] Could not save docs index:', e); }
}
function getDocData(id) {
    const raw = localStorage.getItem(WORD_STORAGE_KEY_PREFIX + id);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.type === 'doc') return { content: parsed, layout: null };
        return parsed;
    } catch (e) { return null; }
}
function saveDocData(id, partial) {
    if (!id) return;
    const existing = getDocData(id) || {};
    try {
        localStorage.setItem(WORD_STORAGE_KEY_PREFIX + id, JSON.stringify({ ...existing, ...partial }));
    } catch (e) {
        console.warn('[Word] Storage quota exceeded:', e);
        toast('Storage full — document may not save. Try exporting to DOCX.', true);
    }
}
function saveCurrentLayout() {
    if (!currentDocId) return;
    saveDocData(currentDocId, {
        layout: {
            paperSize: currentPaperSize,
            margins: { ...docMargins },
            landscape: isLandscape,
        },
    });
}
function saveDocToIndex(title) {
    if (!currentDocId) return;
    let idx = getDocsIndex();
    const existing = idx.find(d => d.id === currentDocId);
    if (existing) {
        existing.title = title;
        existing.updatedAt = Date.now();
    } else {
        idx.push({ id: currentDocId, title: title || 'Untitled Document', type: 'word', updatedAt: Date.now() });
    }
    saveDocsIndex(idx);
}

export function getMyDocuments() {
    return getDocsIndex();
}
export function deleteDocument(id) {
    localStorage.removeItem(WORD_STORAGE_KEY_PREFIX + id);
    const idx = getDocsIndex().filter(d => d.id !== id);
    saveDocsIndex(idx);
    if (window.renderMyDocuments) window.renderMyDocuments();
}

export function updateWordPagination() { /* no-op for backward compatibility */ }

/* ============================================================
 * Markup
 * ========================================================== */
const wordEditorHtml = `
<div id="word-editor-modal" class="hidden flex flex-col overflow-hidden transition-transform transform translate-y-full"
     style="position: fixed; inset: 0; background-color: #eef1f6 !important; z-index: 99999;">

    <!-- Header -->
    <div class="h-14 flex-shrink-0 flex items-center justify-between px-3 bg-white border-b border-gray-200 shadow-sm z-20">
        <button id="close-word-btn" class="text-xl text-gray-700 p-2 -ml-1 rounded-lg hover:bg-gray-100 active:scale-95 transition-all" aria-label="Back">
            <i class="fas fa-arrow-left"></i>
        </button>
        <div class="flex flex-col items-center min-w-0 flex-1 px-2">
            <input type="text" id="word-doc-title" value="Untitled Document"
                   class="text-sm font-bold text-center border-none bg-transparent hover:bg-gray-50 focus:bg-white focus:ring-1 focus:ring-blue-500 rounded px-2 py-0.5 outline-none w-full max-w-[220px] text-gray-800 transition-colors" />
            <span id="word-save-status" class="text-[11px] text-gray-500 font-medium">Saved locally</span>
        </div>
        <div class="flex items-center gap-1">
            <button id="btn-search-header" class="text-lg text-gray-700 p-2 rounded-lg hover:bg-gray-100 active:scale-95 transition-all" title="Find & Replace"><i class="fas fa-search"></i></button>
            <button id="word-file-btn-top" class="text-lg text-gray-700 p-2 -mr-1 rounded-lg hover:bg-gray-100 active:scale-95 transition-all" title="File, import & export"><i class="fas fa-ellipsis-v"></i></button>
        </div>
    </div>

    <!-- Search / Replace panel -->
    <div id="word-search-panel" class="hidden fixed top-16 left-2 right-2 sm:absolute sm:top-16 sm:right-6 sm:left-auto sm:w-80 bg-white rounded-lg shadow-2xl border border-gray-200 p-3 flex-col gap-2.5" style="z-index: 100000;">
        <div class="flex items-center gap-2">
            <input type="text" id="inp-search-term" placeholder="Find..." class="flex-1 h-10 border border-gray-300 rounded-lg px-3 text-sm focus:outline-none focus:border-blue-500">
            <span id="search-status" class="text-xs text-gray-500 w-10 text-center font-medium">0/0</span>
            <button id="btn-search-prev" class="w-9 h-10 flex items-center justify-center bg-gray-50 hover:bg-gray-100 rounded-lg text-gray-600"><i class="fas fa-chevron-up"></i></button>
            <button id="btn-search-next" class="w-9 h-10 flex items-center justify-center bg-gray-50 hover:bg-gray-100 rounded-lg text-gray-600"><i class="fas fa-chevron-down"></i></button>
            <button id="btn-search-close" class="w-9 h-10 flex items-center justify-center hover:bg-red-50 rounded-lg text-red-500"><i class="fas fa-times"></i></button>
        </div>
        <div class="flex items-center gap-2">
            <input type="text" id="inp-replace-term" placeholder="Replace with..." class="flex-1 h-10 border border-gray-300 rounded-lg px-3 text-sm focus:outline-none focus:border-blue-500">
            <button id="btn-replace" class="px-3 h-10 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700">Replace</button>
            <button id="btn-replace-all" class="px-3 h-10 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700">All</button>
        </div>
    </div>

    <!-- Editor workspace -->
    <div id="word-editor-scroll-area" class="flex-1 overflow-y-auto flex justify-center custom-editor-scrollbar"
         style="background-color: #eef1f6 !important; padding: 16px 8px 80px 8px; width: 100%;">
        <div id="word-page-card" class="word-page-card">
            <div id="tiptap-editor-container" class="prose prose-sm max-w-none focus:outline-none focus:ring-0"></div>
        </div>
    </div>

    <!-- Bottom ribbon -->
    <div class="flex-shrink-0 bg-white border-t border-gray-200 flex flex-col pb-safe shadow-[0_-4px_16px_rgba(0,0,0,0.06)] z-20">

        <div id="tab-home-content" class="h-14 flex items-center justify-start px-3 gap-1 overflow-x-auto scrollbar-hide text-gray-700">
            <button id="btn-undo" class="ribbon-btn" title="Undo"><i class="fas fa-undo"></i></button>
            <button id="btn-redo" class="ribbon-btn" title="Redo"><i class="fas fa-redo"></i></button>
            <div class="ribbon-sep"></div>
            <select id="sel-font-family" class="ribbon-select font-medium">
                <option value="Arial">Arial</option>
                <option value="Times New Roman">Times New Roman</option>
                <option value="Calibri">Calibri</option>
                <option value="Segoe UI">Segoe UI</option>
                <option value="Courier New">Courier New</option>
                <option value="Georgia">Georgia</option>
                <option value="Verdana">Verdana</option>
                <option value="Comic Sans MS">Comic Sans</option>
            </select>
            <select id="sel-font-size" class="ribbon-select w-16 font-medium">
                <option value="9pt">9</option><option value="10pt">10</option><option value="11pt">11</option>
                <option value="12pt" selected>12</option><option value="14pt">14</option><option value="16pt">16</option>
                <option value="18pt">18</option><option value="24pt">24</option><option value="32pt">32</option>
            </select>
            <div class="ribbon-sep"></div>
            <button id="btn-bold" class="ribbon-btn" title="Bold"><i class="fas fa-bold"></i></button>
            <button id="btn-italic" class="ribbon-btn" title="Italic"><i class="fas fa-italic"></i></button>
            <button id="btn-underline" class="ribbon-btn" title="Underline"><i class="fas fa-underline"></i></button>
            <button id="btn-strike" class="ribbon-btn" title="Strikethrough"><i class="fas fa-strikethrough"></i></button>
            <button id="btn-subscript" class="ribbon-btn" title="Subscript"><i class="fas fa-subscript"></i></button>
            <button id="btn-superscript" class="ribbon-btn" title="Superscript"><i class="fas fa-superscript"></i></button>
            <div class="ribbon-sep"></div>
            <!-- Text Color split button: click 'A' to apply current color, click caret to pick new color, slash to reset -->
            <div class="relative flex items-center">
                <button id="btn-text-color-apply" class="ribbon-btn relative flex-col" title="Apply Text Color">
                    <i class="fas fa-font text-sm"></i>
                    <span id="color-indicator-bar" class="w-4 h-1 rounded-full absolute bottom-1 bg-black"></span>
                </button>
                <button id="btn-color-picker-toggle" class="w-6 h-8 flex items-center justify-center cursor-pointer -ml-1 text-gray-500 hover:text-gray-800 active:scale-95 transition-all" title="Choose Color">
                    <i class="fas fa-caret-down text-[10px]"></i>
                </button>
                <input type="color" id="btn-color" class="w-0 h-0 opacity-0 absolute" value="#000000">
                <button id="btn-color-clear" class="ribbon-btn -ml-1" title="Reset Text Color"><i class="fas fa-remove-format text-xs text-gray-500"></i></button>
            </div>
            <!-- Highlight Color split button -->
            <div class="relative flex items-center">
                <button id="btn-highlight-apply" class="ribbon-btn relative flex-col" title="Apply Highlight">
                    <i class="fas fa-highlighter text-sm"></i>
                </button>
                <button id="btn-highlight-picker-toggle" class="w-6 h-8 flex items-center justify-center cursor-pointer -ml-1 text-gray-500 hover:text-gray-800 active:scale-95 transition-all" title="Choose Highlight Color">
                    <i class="fas fa-caret-down text-[10px]"></i>
                </button>
                <input type="color" id="btn-highlight-color" class="w-0 h-0 opacity-0 absolute" value="#ffff00">
                <button id="btn-highlight-clear" class="ribbon-btn -ml-1" title="Clear Highlight"><i class="fas fa-eraser"></i></button>
            </div>
            <div class="ribbon-sep"></div>
            <button id="btn-align-left" class="ribbon-btn" title="Align Left"><i class="fas fa-align-left"></i></button>
            <button id="btn-align-center" class="ribbon-btn" title="Align Center"><i class="fas fa-align-center"></i></button>
            <button id="btn-align-right" class="ribbon-btn" title="Align Right"><i class="fas fa-align-right"></i></button>
            <button id="btn-align-justify" class="ribbon-btn" title="Justify"><i class="fas fa-align-justify"></i></button>
            <div class="ribbon-sep"></div>
            <button id="btn-outdent" class="ribbon-btn" title="Decrease Indent"><i class="fas fa-outdent"></i></button>
            <button id="btn-indent" class="ribbon-btn" title="Increase Indent"><i class="fas fa-indent"></i></button>
            <button id="btn-bullet" class="ribbon-btn" title="Bullet List"><i class="fas fa-list-ul"></i></button>
            <button id="btn-ordered" class="ribbon-btn" title="Numbered List"><i class="fas fa-list-ol"></i></button>
            <select id="sel-line-height" class="ribbon-select w-16 font-medium" title="Line Spacing">
                <option value="normal" selected>1.0</option><option value="1.15">1.15</option>
                <option value="1.5">1.5</option><option value="2.0">2.0</option>
            </select>
        </div>

        <div id="tab-insert-content" class="h-14 hidden items-center justify-start px-3 gap-2.5 overflow-x-auto scrollbar-hide text-gray-700">
            <button id="btn-insert-page-break" class="ribbon-pill ribbon-pill-indigo"><i class="fas fa-cut text-indigo-500"></i> Page Break</button>
            <div class="ribbon-sep-lg"></div>
            <button id="btn-insert-link" class="ribbon-pill"><i class="fas fa-link text-blue-500"></i> Link</button>
            <button id="btn-insert-image" class="ribbon-pill"><i class="fas fa-image text-emerald-500"></i> Image</button>
            <div class="ribbon-sep-lg"></div>
            <button id="btn-insert-table" class="ribbon-pill"><i class="fas fa-table text-indigo-500"></i> Table</button>
            <button id="btn-insert-row" class="ribbon-pill"><i class="fas fa-plus text-gray-500"></i> Row</button>
            <button id="btn-insert-col" class="ribbon-pill"><i class="fas fa-plus text-gray-500"></i> Col</button>
            <button id="btn-delete-table" class="ribbon-pill ribbon-pill-danger"><i class="fas fa-trash"></i> Table</button>
        </div>

        <div id="tab-file-content" class="h-14 hidden items-center justify-start px-3 gap-2.5 overflow-x-auto scrollbar-hide">
            <button id="btn-import" class="ribbon-pill"><i class="fas fa-file-import text-amber-500"></i> Import</button>
            <div class="ribbon-sep-lg"></div>
            <button id="btn-export-pdf" class="ribbon-pill ribbon-pill-red"><i class="fas fa-file-pdf"></i> PDF</button>
            <button id="btn-export-docx" class="ribbon-pill ribbon-pill-blue"><i class="fas fa-file-word"></i> DOCX</button>
            <button id="btn-print-doc" class="ribbon-pill ribbon-pill-indigo"><i class="fas fa-print"></i> Print</button>
            <div class="ribbon-sep-lg"></div>
            <button id="btn-page-setup" class="ribbon-pill"><i class="fas fa-sliders-h"></i> Page Setup</button>
            <label class="ribbon-pill cursor-pointer">
                <input type="checkbox" id="chk-landscape" class="rounded border-gray-300 text-blue-600 focus:ring-blue-500"> Landscape
            </label>
        </div>

        <!-- Tabs -->
        <div class="flex items-center justify-around border-t border-gray-200 bg-gray-50 h-10 shrink-0">
            <button class="word-tab-btn active text-blue-600 font-bold text-xs uppercase tracking-wider flex-1 h-full flex items-center justify-center gap-2" data-target="tab-home-content"><i class="fas fa-pen text-[10px]"></i> Home</button>
            <button class="word-tab-btn text-gray-500 font-bold text-xs uppercase tracking-wider flex-1 h-full flex items-center justify-center gap-2" data-target="tab-insert-content"><i class="fas fa-plus text-[10px]"></i> Insert</button>
            <button class="word-tab-btn text-gray-500 font-bold text-xs uppercase tracking-wider flex-1 h-full flex items-center justify-center gap-2" data-target="tab-file-content"><i class="fas fa-file-alt text-[10px]"></i> File</button>
        </div>
    </div>

    <!-- Hidden file input used for Import -->
    <input type="file" id="word-import-input" accept=".docx,.html,.htm,.txt,.json,.md" style="display:none" />

    <!-- Backdrop for mobile bottom sheets / palettes -->
    <div id="word-palette-backdrop" class="hidden fixed inset-0 transition-opacity" style="z-index: 100005; background: rgba(0,0,0,0.4); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px);"></div>

    <!-- Mobile-First Bottom Sheet & Desktop Popover: Text Color -->
    <div id="word-color-palette-popover" class="hidden fixed sm:absolute bottom-0 sm:bottom-20 left-0 right-0 sm:left-12 sm:right-auto bg-white border-t sm:border border-gray-200 rounded-t-3xl sm:rounded-2xl shadow-2xl p-4 sm:p-4 flex flex-col gap-3 w-full sm:w-88 max-h-[85vh] sm:max-h-[520px] overflow-y-auto transition-all duration-200" style="z-index: 100010;">
        <!-- Drag indicator handle for mobile -->
        <div class="w-12 h-1 bg-gray-300 rounded-full mx-auto sm:hidden -mt-1 mb-1"></div>

        <!-- Header -->
        <div class="flex items-center justify-between pb-2 border-b border-gray-100">
            <div class="flex items-center gap-2">
                <div class="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xs">
                    <i class="fas fa-font"></i>
                </div>
                <span class="text-sm font-bold text-gray-800">Text Color</span>
            </div>
            <div class="flex items-center gap-1.5">
                <button id="btn-palette-auto-color" class="px-2.5 py-1 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 active:scale-95 rounded-lg transition-all flex items-center gap-1">
                    <i class="fas fa-undo-alt text-[10px]"></i> Automatic
                </button>
                <button id="btn-palette-color-close" class="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-700 active:scale-95 rounded-lg transition-all" aria-label="Close">
                    <i class="fas fa-times text-sm"></i>
                </button>
            </div>
        </div>

        <!-- Palette Colors Grid -->
        <div>
            <div class="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">Palette Colors</div>
            <div id="word-theme-color-grid" class="grid grid-cols-8 sm:grid-cols-10 gap-2 sm:gap-1.5"></div>
        </div>

        <!-- Custom Color Bar -->
        <div class="pt-2 border-t border-gray-100 flex items-center justify-between">
            <label for="btn-color" class="flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 active:scale-95 rounded-xl border border-gray-200 text-xs text-gray-700 font-semibold cursor-pointer transition-all">
                <i class="fas fa-eyedropper text-blue-600"></i> Custom Color Spectrum
            </label>
        </div>
    </div>

    <!-- Mobile-First Bottom Sheet & Desktop Popover: Text Highlight -->
    <div id="word-highlight-palette-popover" class="hidden fixed sm:absolute bottom-0 sm:bottom-20 left-0 right-0 sm:left-32 sm:right-auto bg-white border-t sm:border border-gray-200 rounded-t-3xl sm:rounded-2xl shadow-2xl p-4 sm:p-4 flex flex-col gap-3 w-full sm:w-80 max-h-[85vh] sm:max-h-[520px] overflow-y-auto transition-all duration-200" style="z-index: 100010;">
        <!-- Drag indicator handle for mobile -->
        <div class="w-12 h-1 bg-gray-300 rounded-full mx-auto sm:hidden -mt-1 mb-1"></div>

        <!-- Header -->
        <div class="flex items-center justify-between pb-2 border-b border-gray-100">
            <div class="flex items-center gap-2">
                <div class="w-7 h-7 rounded-lg bg-yellow-50 text-amber-500 flex items-center justify-center font-bold text-xs">
                    <i class="fas fa-highlighter"></i>
                </div>
                <span class="text-sm font-bold text-gray-800">Highlight Color</span>
            </div>
            <div class="flex items-center gap-1.5">
                <button id="btn-palette-no-highlight" class="px-2.5 py-1 text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 active:scale-95 rounded-lg transition-all flex items-center gap-1">
                    <i class="fas fa-eraser text-[10px]"></i> Clear
                </button>
                <button id="btn-palette-highlight-close" class="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-700 active:scale-95 rounded-lg transition-all" aria-label="Close">
                    <i class="fas fa-times text-sm"></i>
                </button>
            </div>
        </div>

        <!-- Pastel Highlights Grid -->
        <div>
            <div class="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">Pastel Highlights</div>
            <div id="word-highlight-color-grid" class="grid grid-cols-5 gap-2 sm:gap-2"></div>
        </div>

        <!-- Custom Highlight Bar -->
        <div class="pt-2 border-t border-gray-100 flex items-center justify-between">
            <label for="btn-highlight-color" class="flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-gray-100 active:scale-95 rounded-xl border border-gray-200 text-xs text-gray-700 font-semibold cursor-pointer transition-all">
                <i class="fas fa-palette text-amber-500"></i> Custom Highlight
            </label>
        </div>
    </div>
</div>

<!-- Page Setup Modal -->
<div id="word-page-setup-modal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center backdrop-blur-sm" style="z-index: 999999;">
    <div class="bg-white rounded-xl shadow-2xl p-6 w-[360px] max-w-[92vw]">
        <h3 class="text-lg font-bold text-gray-800 mb-4">Page Setup</h3>
        <p class="text-xs text-gray-500 mb-4">Paper size &amp; margins apply to PDF / DOCX export.</p>
        <div class="space-y-4">
            <div>
                <label class="block text-xs font-semibold text-gray-600 mb-1">Paper Size</label>
                <select id="sel-paper-size" class="w-full h-10 border border-gray-300 rounded-lg px-4 text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                    <option value="A4">A4 (21 x 29.7 cm)</option>
                    <option value="Letter">Letter (21.59 x 27.94 cm)</option>
                    <option value="A5">A5 (14.8 x 21 cm)</option>
                </select>
            </div>
            <div class="grid grid-cols-2 gap-4">
                <div><label class="block text-xs font-semibold text-gray-600 mb-1">Top (cm)</label><input type="number" id="inp-margin-top" step="0.1" class="w-full h-10 border border-gray-300 rounded-lg px-4 text-sm focus:ring-2 focus:ring-blue-500 outline-none"></div>
                <div><label class="block text-xs font-semibold text-gray-600 mb-1">Bottom (cm)</label><input type="number" id="inp-margin-bottom" step="0.1" class="w-full h-10 border border-gray-300 rounded-lg px-4 text-sm focus:ring-2 focus:ring-blue-500 outline-none"></div>
                <div><label class="block text-xs font-semibold text-gray-600 mb-1">Left (cm)</label><input type="number" id="inp-margin-left" step="0.1" class="w-full h-10 border border-gray-300 rounded-lg px-4 text-sm focus:ring-2 focus:ring-blue-500 outline-none"></div>
                <div><label class="block text-xs font-semibold text-gray-600 mb-1">Right (cm)</label><input type="number" id="inp-margin-right" step="0.1" class="w-full h-10 border border-gray-300 rounded-lg px-4 text-sm focus:ring-2 focus:ring-blue-500 outline-none"></div>
            </div>
        </div>
        <div class="flex justify-end gap-3 mt-6">
            <button id="btn-page-setup-cancel" class="px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">Cancel</button>
            <button id="btn-page-setup-apply" class="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-sm">Apply</button>
        </div>
    </div>
</div>

<style>
/* Mobile-First Palette Bottom Sheets & Popovers */
#word-palette-backdrop {
    position: fixed !important;
    inset: 0 !important;
    z-index: 100005 !important;
    background: rgba(0, 0, 0, 0.4) !important;
    backdrop-filter: blur(2px) !important;
    -webkit-backdrop-filter: blur(2px) !important;
    transition: opacity 0.2s ease !important;
}
#word-color-palette-popover,
#word-highlight-palette-popover {
    z-index: 100010 !important;
    background: #ffffff !important;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.25), 0 8px 10px -6px rgba(0, 0, 0, 0.1) !important;
}
@media (max-width: 640px) {
    #word-color-palette-popover,
    #word-highlight-palette-popover {
        position: fixed !important;
        bottom: 0 !important;
        left: 0 !important;
        right: 0 !important;
        width: 100% !important;
        max-width: 100vw !important;
        max-height: 82vh !important;
        border-top-left-radius: 24px !important;
        border-top-right-radius: 24px !important;
        border-bottom-left-radius: 0 !important;
        border-bottom-right-radius: 0 !important;
        border-top: 1px solid #e5e7eb !important;
        padding: 1rem 1rem max(1.5rem, env(safe-area-inset-bottom)) 1rem !important;
    }
}
@media (min-width: 641px) {
    #word-color-palette-popover {
        position: absolute !important;
        bottom: 5rem !important;
        left: 2rem !important;
        width: 22rem !important;
        max-width: 95vw !important;
        max-height: 520px !important;
        border-radius: 1rem !important;
        border: 1px solid #e5e7eb !important;
    }
    #word-highlight-palette-popover {
        position: absolute !important;
        bottom: 5rem !important;
        left: 7rem !important;
        width: 20rem !important;
        max-width: 95vw !important;
        max-height: 520px !important;
        border-radius: 1rem !important;
        border: 1px solid #e5e7eb !important;
    }
}
.word-color-swatch {
    min-width: 36px !important;
    min-height: 36px !important;
    width: 36px !important;
    height: 36px !important;
    border-radius: 8px !important;
    cursor: pointer !important;
    touch-action: manipulation !important;
}
.word-hl-swatch {
    min-width: 44px !important;
    min-height: 38px !important;
    width: 44px !important;
    height: 38px !important;
    border-radius: 8px !important;
    cursor: pointer !important;
    touch-action: manipulation !important;
}

/* Ribbon button helpers */
.ribbon-btn { width: 2.25rem; height: 2.25rem; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 0.5rem; color: #374151; transition: background .15s, transform .05s; }
.ribbon-btn:hover { background: #f9fafb; }
.ribbon-btn:active { background: #f3f4f6; transform: scale(.95); }
.ribbon-select { height: 2.25rem; border: 1px solid #d1d5db; border-radius: 0.5rem; padding: 0 0.5rem; font-size: 0.75rem; background: #fff; color: #1f2937; flex-shrink: 0; }
.ribbon-sep { width: 1px; height: 1.5rem; background: #d1d5db; margin: 0 0.25rem; flex-shrink: 0; }
.ribbon-sep-lg { width: 1px; height: 1.75rem; background: #d1d5db; margin: 0 0.25rem; flex-shrink: 0; }
.ribbon-pill { padding: 0 1.25rem; height: 2.5rem; min-width: fit-content; flex-shrink: 0; white-space: nowrap; display: flex; align-items: center; justify-content: center; gap: 0.6rem; background: #f9fafb; border: 1px solid #e5e7eb; color: #374151; border-radius: 0.5rem; font-size: 0.875rem; font-weight: 600; transition: background .15s; }
.ribbon-pill:hover { background: #f3f4f6; }
.ribbon-pill:active { background: #e5e7eb; }
.ribbon-pill-danger { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
.ribbon-pill-red { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
.ribbon-pill-blue { background: #eff6ff; color: #2563eb; border-color: #bfdbfe; }
.ribbon-pill-indigo { background: #eef2ff; color: #4f46e5; border-color: #c7d2fe; }
.scrollbar-hide::-webkit-scrollbar { display: none; }
.scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }

.custom-editor-scrollbar::-webkit-scrollbar { width: 8px; height: 8px; }
.custom-editor-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
.custom-editor-scrollbar::-webkit-scrollbar-thumb:hover { background: #94a3b8; }

/* Page Break Node */
.word-page-break-node {
    position: relative;
    margin: 28px 0;
    text-align: center;
    user-select: none;
    cursor: default;
    border-top: 2px dashed #94a3b8;
    padding-top: 4px;
}
.word-page-break-label {
    display: inline-block;
    background: #f1f5f9;
    color: #475569;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 12px;
    border-radius: 9999px;
    border: 1px solid #cbd5e1;
    transform: translateY(-16px);
    letter-spacing: 0.025em;
}

/* Fluid Page Card (mobile reflow & A4 desktop WYSIWYG) */
.word-page-card {
    width: 100%;
    max-width: 794px;
    background: #ffffff;
    border: 1px solid rgba(0,0,0,0.06);
    border-radius: 4px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04);
    box-sizing: border-box;
    padding: 72px 96px;
    min-height: 1123px;
    align-self: flex-start;
    margin-bottom: 40px;
}
@media (max-width: 640px) {
    .word-page-card {
        max-width: 100%;
        padding: 18px 16px;
        border-radius: 6px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        min-height: 60vh;
    }
}

/* ProseMirror typography — synchronized 1:1 with PDF export geometry */
.ProseMirror { outline: none !important; min-height: 100%; box-sizing: border-box; overflow-wrap: break-word; word-wrap: break-word; word-break: break-word; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; font-family: Arial, "Helvetica Neue", Helvetica, sans-serif; font-size: 12pt; line-height: 1.5; color: #111827; }
.ProseMirror p { margin: 0 0 0.5em 0; overflow-wrap: break-word; word-wrap: break-word; word-break: break-word; }
.ProseMirror p.is-editor-empty:first-child::before,
.ProseMirror p.is-empty:first-child::before { content: attr(data-placeholder); float: left; color: #94a3b8; pointer-events: none; height: 0; }
.ProseMirror h1 { font-size: 22pt; font-weight: bold; margin: 0.6em 0 0.3em 0; line-height: 1.25; }
.ProseMirror h2 { font-size: 18pt; font-weight: bold; margin: 0.5em 0 0.25em 0; line-height: 1.3; }
.ProseMirror h3 { font-size: 15pt; font-weight: bold; margin: 0.4em 0 0.2em 0; line-height: 1.35; }
.ProseMirror h4, .ProseMirror h5, .ProseMirror h6 { font-size: 12pt; font-weight: bold; margin: 0.3em 0 0.2em 0; }
/* Highlight / mark styling — prevents background from obscuring text */
.ProseMirror mark {
    padding: 0.1em 0.2em;
    border-radius: 0.2em;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
}
.ProseMirror table { border-collapse: collapse; table-layout: fixed; width: 100%; margin: 8px 0; overflow: hidden; box-sizing: border-box; }
.ProseMirror td, .ProseMirror th { min-width: 1em; border: 1px solid #94a3b8; padding: 6px 8px; vertical-align: top; box-sizing: border-box; position: relative; overflow-wrap: break-word; word-break: break-word; }
.ProseMirror th { font-weight: bold; text-align: left; background: #f1f5f9; }
.ProseMirror td > p, .ProseMirror th > p { margin: 0 0 4px 0; }
.ProseMirror td > p:last-child, .ProseMirror th > p:last-child { margin-bottom: 0; }
.ProseMirror .selectedCell:after { z-index: 2; position: absolute; content: ""; inset: 0; background: rgba(59,130,246,.15); pointer-events: none; }
.ProseMirror .column-resize-handle { position: absolute; right: -2px; top: 0; bottom: 0; width: 4px; background: #2563eb; pointer-events: none; z-index: 20; }
.ProseMirror img { max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 2px 6px rgba(0,0,0,.08); display: block; margin: 8px 0; }
.ProseMirror p, .ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6,
.ProseMirror ul, .ProseMirror ol, .ProseMirror li, .ProseMirror blockquote { overflow-wrap: break-word; word-break: break-word; max-width: 100%; box-sizing: border-box; }
.ProseMirror blockquote { border-left: 3px solid #cbd5e1; padding-left: 12px; margin: 0.5em 0; color: #475569; font-style: italic; }
.ProseMirror pre { background: #1e293b; color: #f8fafc; padding: 10px 12px; border-radius: 6px; font-family: 'Courier New', Courier, monospace; font-size: 10.5pt; line-height: 1.4; margin: 0.5em 0; white-space: pre-wrap; word-break: break-all; overflow-x: auto; }
.ProseMirror code { font-family: 'Courier New', Courier, monospace; font-size: 0.95em; background: #f1f5f9; padding: 0.15em 0.35em; border-radius: 0.25em; }
.ProseMirror pre code { background: none; padding: 0; border-radius: 0; font-size: inherit; color: inherit; }
.ProseMirror ul { list-style-type: disc !important; padding-left: 1.5rem !important; margin: 0.4em 0; }
.ProseMirror ol { list-style-type: decimal !important; padding-left: 1.5rem !important; margin: 0.4em 0; }
.ProseMirror li { margin: 0.2em 0; }
.ProseMirror li > p { margin: 0; }
.ProseMirror a { color: #2563eb; text-decoration: underline; }
.word-tab-btn.active { border-bottom: 2px solid #2563eb; color: #2563eb; }
.search-result { background: rgba(253,224,71,.5); border-bottom: 2px solid #facc15; }
.search-result-current { background: rgba(250,204,21,.85); border-bottom: 2px solid #ca8a04; box-shadow: 0 0 0 1px #eab308; border-radius: 2px; }

@media print {
    body * { visibility: hidden !important; }
    #word-editor-modal, #word-editor-modal * { visibility: visible !important; }
    #word-editor-modal { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; background: #fff !important; z-index: 999999 !important; }
    #word-editor-modal > div:first-child, #word-editor-modal > div:last-child { display: none !important; }
    .word-page-card { box-shadow: none !important; border: none !important; padding: 0 !important; width: 100% !important; max-width: 100% !important; margin: 0 !important; }
    .word-page-break-node { page-break-after: always !important; break-after: page !important; border: none !important; }
    .word-page-break-label { display: none !important; }
    @page { margin: 20mm; size: auto; }
}
</style>
`;

/* ============================================================
 * Open / close
 * ========================================================== */
export function openWordEditor(docId = null) {
    if (!$('word-editor-modal')) {
        document.body.insertAdjacentHTML('beforeend', wordEditorHtml);
        bindWordEvents();
    }

    currentDocId = docId;
    const titleEl = $('word-doc-title');
    if (!currentDocId) {
        currentDocId = 'doc_' + Date.now();
        if (titleEl) titleEl.value = 'Untitled Document';
    } else {
        const idx = getDocsIndex().find(d => d.id === currentDocId);
        if (titleEl) titleEl.value = idx ? idx.title : 'Untitled Document';
    }

    const modal = $('word-editor-modal');
    if (modal) {
        modal.classList.remove('hidden');
        setTimeout(() => modal.classList.remove('translate-y-full'), 10);
    }

    initTiptap();
    applyPageGeometry();
}

function closeWordEditor() {
    const modal = $('word-editor-modal');
    if (!modal) return;
    // Save title immediately before closing (in case user edited without blur)
    const titleEl = $('word-doc-title');
    if (titleEl && currentDocId) saveDocToIndex(titleEl.value);
    modal.classList.add('translate-y-full');
    window.removeEventListener('resize', applyPageGeometry);
    setTimeout(() => {
        modal.classList.add('hidden');
        if (wordEditor) { wordEditor.destroy(); wordEditor = null; }
        if (window.renderMyDocuments) window.renderMyDocuments();
    }, 300);
}

/* ============================================================
 * Tiptap init
 * ========================================================== */
function buildExtensions() {
    return [
        StarterKit.configure({
            link: false,
            underline: false,
        }),
        Placeholder.configure({ placeholder: 'Start typing your document...' }),
        TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
        Image.configure({ inline: false, allowBase64: true }),
        Table.configure({ resizable: true }),
        TableRow, TableHeader, TableCell,
        TextStyle, Color, Underline,
        Highlight.configure({ multicolor: true }),
        Link.configure({ openOnClick: false, autolink: true }),
        Subscript, Superscript, FontFamily,
        FontSize, Indent, LineHeight,
        PageBreak,
        SearchExtension,
    ];
}

function initTiptap() {
    try {
        const editorEl = document.querySelector('#tiptap-editor-container');
        if (!editorEl) {
            console.warn('[Word] #tiptap-editor-container not found in DOM');
            return;
        }

        const savedData = getDocData(currentDocId);
        const savedContent = savedData?.content;

        const layout = savedData?.layout;
        currentPaperSize = layout?.paperSize || 'A4';
        docMargins = layout?.margins ? { ...layout.margins } : { ...DEFAULT_MARGINS };
        isLandscape = !!layout?.landscape;

        const chk = $('chk-landscape'); if (chk) chk.checked = isLandscape;

        if (wordEditor) { wordEditor.destroy(); wordEditor = null; }

        wordEditor = new Editor({
            element: editorEl,
            extensions: buildExtensions(),
            content: savedContent || '',
            autofocus: false,
            onUpdate: ({ editor }) => {
                saveDocData(currentDocId, { content: editor.getJSON() });
                const titleEl = $('word-doc-title');
                saveDocToIndex(titleEl ? titleEl.value : 'Untitled Document');
                flashSaveStatus();
            },
            onSelectionUpdate: ({ editor }) => {
                if (editor?.state?.selection) {
                    lastEditorSelection = {
                        from: editor.state.selection.from,
                        to: editor.state.selection.to,
                        empty: editor.state.selection.empty
                    };
                }
                refreshToolbarState(editor);
            },
            onTransaction: ({ editor }) => {
                if (editor?.state?.selection) {
                    lastEditorSelection = {
                        from: editor.state.selection.from,
                        to: editor.state.selection.to,
                        empty: editor.state.selection.empty
                    };
                }
                refreshToolbarState(editor);
            },
        });
    } catch (err) {
        console.error('[Word] Failed to initialize Tiptap editor:', err);
    }
}

function flashSaveStatus() {
    const el = $('word-save-status');
    if (!el) return;
    el.textContent = 'Saving...';
    clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => { el.textContent = 'Saved locally'; }, 400);
}

function refreshToolbarState(editor) {
    const tb = (id, active) => { const el = $(id); if (el) el.classList.toggle('bg-blue-100', active); };
    tb('btn-bold', editor.isActive('bold'));
    tb('btn-italic', editor.isActive('italic'));
    tb('btn-underline', editor.isActive('underline'));
    tb('btn-strike', editor.isActive('strike'));
    tb('btn-subscript', editor.isActive('subscript'));
    tb('btn-superscript', editor.isActive('superscript'));
    tb('btn-align-left', editor.isActive({ textAlign: 'left' }));
    tb('btn-align-center', editor.isActive({ textAlign: 'center' }));
    tb('btn-align-right', editor.isActive({ textAlign: 'right' }));
    tb('btn-align-justify', editor.isActive({ textAlign: 'justify' }));
    tb('btn-bullet', editor.isActive('bulletList'));
    tb('btn-ordered', editor.isActive('orderedList'));

    // Sync font family dropdown
    const fontFamily = editor.getAttributes('textStyle')?.fontFamily;
    const selFont = $('sel-font-family');
    if (selFont && fontFamily) selFont.value = fontFamily;

    // Sync font size dropdown
    const fontSize = editor.getAttributes('textStyle')?.fontSize;
    const selSize = $('sel-font-size');
    if (selSize && fontSize) selSize.value = fontSize;

    // Sync line height dropdown
    const lineHeight = editor.getAttributes('paragraph')?.lineHeight || editor.getAttributes('heading')?.lineHeight;
    const selLH = $('sel-line-height');
    if (selLH && lineHeight) selLH.value = lineHeight;

    // Sync text color
    const color = editor.getAttributes('textStyle')?.color;
    const colorInput = $('btn-color');
    const colorBar = $('color-indicator-bar');
    if (color) {
        activeTextColor = toHexColor(color);
        if (colorInput) colorInput.value = activeTextColor;
        if (colorBar) colorBar.style.backgroundColor = activeTextColor;
    } else {
        if (colorInput) colorInput.value = activeTextColor;
        if (colorBar) colorBar.style.backgroundColor = activeTextColor;
    }

    // Sync highlight color
    const hlColor = editor.getAttributes('highlight')?.color;
    const hlInput = $('btn-highlight-color');
    if (hlInput) hlInput.value = hlColor ? toHexColor(hlColor) : '#ffff00';

    // Undo / Redo enabled state
    const undoBtn = $('btn-undo');
    const redoBtn = $('btn-redo');
    if (undoBtn) undoBtn.style.opacity = editor.can().undo() ? '1' : '0.35';
    if (redoBtn) redoBtn.style.opacity = editor.can().redo() ? '1' : '0.35';
}

/* ============================================================
 * Visual page geometry (Reflow)
 * ========================================================== */
function applyPageGeometry() {
    const card = $('word-page-card');
    if (!card) return;

    const isSmall = typeof window !== 'undefined' && window.innerWidth <= 640;
    if (isSmall) {
        card.style.width = '100%';
        card.style.maxWidth = '100%';
        card.style.padding = '18px 16px';
        card.style.boxSizing = 'border-box';
    } else {
        const geo = getExportGeometry();
        card.style.width = `${geo.pageWidthPx}px`;
        card.style.maxWidth = `${geo.pageWidthPx}px`;
        card.style.paddingTop = `${geo.paddingTopPx}px`;
        card.style.paddingBottom = `${geo.paddingBottomPx}px`;
        card.style.paddingLeft = `${geo.paddingLeftPx}px`;
        card.style.paddingRight = `${geo.paddingRightPx}px`;
        card.style.boxSizing = 'border-box';
    }
}

/* ============================================================
 * Event wiring
 * ========================================================== */
function chain() { return wordEditor ? wordEditor.chain().focus() : null; }

function bindWordEvents() {
    if (eventsBound) return;
    eventsBound = true;

    $('close-word-btn')?.addEventListener('click', closeWordEditor);
    $('word-doc-title')?.addEventListener('change', (e) => saveDocToIndex(e.target.value));
    $('word-doc-title')?.addEventListener('input', (e) => saveDocToIndex(e.target.value));

    // Ribbon tabs
    document.querySelectorAll('.word-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.word-tab-btn').forEach(b => {
                b.classList.remove('active', 'text-blue-600');
                b.classList.add('text-gray-500');
            });
            btn.classList.add('active', 'text-blue-600');
            btn.classList.remove('text-gray-500');
            ['tab-home-content', 'tab-insert-content', 'tab-file-content'].forEach(id => {
                const el = $(id);
                if (el) { el.classList.add('hidden'); el.classList.remove('flex'); }
            });
            const target = $(btn.dataset.target);
            if (target) { target.classList.remove('hidden'); target.classList.add('flex'); }
        });
    });

    // Home tab
    $('btn-undo')?.addEventListener('click', () => chain()?.undo().run());
    $('btn-redo')?.addEventListener('click', () => chain()?.redo().run());
    $('sel-font-family')?.addEventListener('change', (e) => chain()?.setFontFamily(e.target.value).run());
    $('sel-font-size')?.addEventListener('change', (e) => chain()?.setFontSize(e.target.value).run());
    $('btn-bold')?.addEventListener('click', () => chain()?.toggleBold().run());
    $('btn-italic')?.addEventListener('click', () => chain()?.toggleItalic().run());
    $('btn-underline')?.addEventListener('click', () => chain()?.toggleUnderline().run());
    $('btn-strike')?.addEventListener('click', () => chain()?.toggleStrike().run());
    $('btn-subscript')?.addEventListener('click', () => chain()?.toggleSubscript().run());
    $('btn-superscript')?.addEventListener('click', () => chain()?.toggleSuperscript().run());
    const THEME_SWATCHES = [
        // Row 1: Grayscale / Neutrals
        '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
        // Row 2: Deep tones
        '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#0b5394', '#351c75', '#741b47', '#4a86e8', '#674ea7',
        // Row 3: Vibrant / Standard
        '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#9900ff', '#ff00ff', '#16a34a', '#2563eb',
        // Row 4: Pastels / Tints
        '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#9fc5e8', '#b4a7d6', '#d5a6bd', '#e06666', '#f6b26b'
    ];

    const HIGHLIGHT_SWATCHES = [
        '#ffff00', '#fef08a', '#fde047', '#86efac', '#bbf7d0',
        '#67e8f9', '#bae6fd', '#93c5fd', '#c7d2fe', '#c084fc',
        '#e9d5ff', '#f472b6', '#fbcfe8', '#fdba74', '#fed7aa'
    ];

    function recordEditorSelection() {
        if (wordEditor && wordEditor.state && wordEditor.state.selection) {
            lastEditorSelection = {
                from: wordEditor.state.selection.from,
                to: wordEditor.state.selection.to,
                empty: wordEditor.state.selection.empty
            };
        }
    }

    const backdropEl = $('word-palette-backdrop');
    const colorPopoverEl = $('word-color-palette-popover');
    const hlPopoverEl = $('word-highlight-palette-popover');

    function openColorPalette() {
        recordEditorSelection();
        hlPopoverEl?.classList.add('hidden');
        colorPopoverEl?.classList.remove('hidden');
        backdropEl?.classList.remove('hidden');
    }

    function closeColorPalette() {
        colorPopoverEl?.classList.add('hidden');
        if (hlPopoverEl?.classList.contains('hidden') || !hlPopoverEl) {
            backdropEl?.classList.add('hidden');
        }
    }

    function openHighlightPalette() {
        recordEditorSelection();
        colorPopoverEl?.classList.add('hidden');
        hlPopoverEl?.classList.remove('hidden');
        backdropEl?.classList.remove('hidden');
    }

    function closeHighlightPalette() {
        hlPopoverEl?.classList.add('hidden');
        if (colorPopoverEl?.classList.contains('hidden') || !colorPopoverEl) {
            backdropEl?.classList.add('hidden');
        }
    }

    function closeAllPalettes() {
        colorPopoverEl?.classList.add('hidden');
        hlPopoverEl?.classList.add('hidden');
        backdropEl?.classList.add('hidden');
    }

    // Populate theme color grid swatches with generous touch targets (>= 36px on mobile)
    const themeGrid = $('word-theme-color-grid');
    if (themeGrid && themeGrid.children.length === 0) {
        THEME_SWATCHES.forEach(color => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'word-color-swatch w-9 h-9 sm:w-7 sm:h-7 min-w-[36px] min-h-[36px] sm:min-w-[28px] sm:min-h-[28px] rounded-xl sm:rounded-lg border border-gray-200 transition-all hover:scale-110 active:scale-95 cursor-pointer shadow-xs focus:outline-none flex items-center justify-center';
            btn.style.backgroundColor = color;
            btn.style.minWidth = '36px';
            btn.style.minHeight = '36px';
            btn.style.width = '36px';
            btn.style.height = '36px';
            btn.style.borderRadius = '8px';
            btn.style.cursor = 'pointer';
            btn.style.flexShrink = '0';
            btn.style.touchAction = 'manipulation';
            btn.title = color;
            btn.setAttribute('data-color', color);
            btn.setAttribute('aria-label', color);
            btn.addEventListener('pointerdown', (e) => e.preventDefault());
            btn.addEventListener('mousedown', (e) => {
                e.preventDefault(); // Preserve editor selection!
            });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                applyTextColor(color);
                closeColorPalette();
            });
            themeGrid.appendChild(btn);
        });
    }

    // Populate highlight color grid swatches (>= 36px on mobile)
    const hlGrid = $('word-highlight-color-grid');
    if (hlGrid && hlGrid.children.length === 0) {
        HIGHLIGHT_SWATCHES.forEach(color => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'word-hl-swatch w-11 h-10 sm:w-10 sm:h-8 min-w-[40px] min-h-[36px] sm:min-w-[36px] sm:min-h-[32px] rounded-xl sm:rounded-lg border border-gray-200 transition-all hover:scale-105 active:scale-95 cursor-pointer shadow-xs focus:outline-none flex items-center justify-center';
            btn.style.backgroundColor = color;
            btn.style.minWidth = '44px';
            btn.style.minHeight = '38px';
            btn.style.width = '44px';
            btn.style.height = '38px';
            btn.style.borderRadius = '8px';
            btn.style.cursor = 'pointer';
            btn.style.flexShrink = '0';
            btn.style.touchAction = 'manipulation';
            btn.title = color;
            btn.setAttribute('data-color', color);
            btn.setAttribute('aria-label', color);
            btn.addEventListener('pointerdown', (e) => e.preventDefault());
            btn.addEventListener('mousedown', (e) => {
                e.preventDefault(); // Preserve editor selection!
            });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                applyHighlightColor(color);
                closeHighlightPalette();
            });
            hlGrid.appendChild(btn);
        });
    }

    // Toggle color palette popover
    $('btn-color-picker-toggle')?.addEventListener('pointerdown', (e) => e.preventDefault());
    $('btn-color-picker-toggle')?.addEventListener('mousedown', (e) => e.preventDefault());
    $('btn-color-picker-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const popover = $('word-color-palette-popover');
        if (popover && !popover.classList.contains('hidden')) {
            closeColorPalette();
        } else {
            openColorPalette();
        }
    });

    // Toggle highlight palette popover
    $('btn-highlight-picker-toggle')?.addEventListener('pointerdown', (e) => e.preventDefault());
    $('btn-highlight-picker-toggle')?.addEventListener('mousedown', (e) => e.preventDefault());
    $('btn-highlight-picker-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const popover = $('word-highlight-palette-popover');
        if (popover && !popover.classList.contains('hidden')) {
            closeHighlightPalette();
        } else {
            openHighlightPalette();
        }
    });

    // Palette close buttons
    $('btn-palette-color-close')?.addEventListener('pointerdown', (e) => e.preventDefault());
    $('btn-palette-color-close')?.addEventListener('mousedown', (e) => e.preventDefault());
    $('btn-palette-color-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeColorPalette();
    });

    $('btn-palette-highlight-close')?.addEventListener('pointerdown', (e) => e.preventDefault());
    $('btn-palette-highlight-close')?.addEventListener('mousedown', (e) => e.preventDefault());
    $('btn-palette-highlight-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeHighlightPalette();
    });

    // Backdrop dismissal
    backdropEl?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPalettes();
    });

    // Automatic color (reset text color)
    $('btn-palette-auto-color')?.addEventListener('pointerdown', (e) => e.preventDefault());
    $('btn-palette-auto-color')?.addEventListener('mousedown', (e) => e.preventDefault());
    $('btn-palette-auto-color')?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearTextColor();
        closeColorPalette();
    });

    // No highlight color (clear highlight)
    $('btn-palette-no-highlight')?.addEventListener('pointerdown', (e) => e.preventDefault());
    $('btn-palette-no-highlight')?.addEventListener('mousedown', (e) => e.preventDefault());
    $('btn-palette-no-highlight')?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearHighlightColor();
        closeHighlightPalette();
    });

    // Dismiss popovers when clicking outside
    document.addEventListener('click', (e) => {
        const colorPopover = $('word-color-palette-popover');
        const colorToggle = $('btn-color-picker-toggle');
        const colorApply = $('btn-text-color-apply');
        const hlPopover = $('word-highlight-palette-popover');
        const hlToggle = $('btn-highlight-picker-toggle');
        const hlApply = $('btn-highlight-apply');
        const bd = $('word-palette-backdrop');

        const inColor = colorPopover?.contains(e.target) || colorToggle?.contains(e.target) || colorApply?.contains(e.target);
        const inHl = hlPopover?.contains(e.target) || hlToggle?.contains(e.target) || hlApply?.contains(e.target);
        const inBd = bd?.contains(e.target);

        if (!inColor && !inHl && !inBd) {
            closeAllPalettes();
        }
    });

    $('btn-text-color-apply')?.addEventListener('click', (e) => {
        const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
        const popover = $('word-color-palette-popover');
        if (isMobile && popover && popover.classList.contains('hidden')) {
            e.stopPropagation();
            openColorPalette();
            return;
        }
        applyTextColor(activeTextColor);
    });
    const colorInput = $('btn-color');
    if (colorInput) {
        ['input', 'change'].forEach(evt => {
            colorInput.addEventListener(evt, (e) => {
                applyTextColor(e.target.value);
                closeColorPalette();
            });
        });
    }
    $('btn-color-clear')?.addEventListener('click', () => {
        clearTextColor();
        closeColorPalette();
    });

    $('btn-highlight-apply')?.addEventListener('click', (e) => {
        const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
        const popover = $('word-highlight-palette-popover');
        if (isMobile && popover && popover.classList.contains('hidden')) {
            e.stopPropagation();
            openHighlightPalette();
            return;
        }
        const hlInput = $('btn-highlight-color');
        applyHighlightColor(hlInput?.value || '#ffff00');
        closeHighlightPalette();
    });
    const hlInput = $('btn-highlight-color');
    if (hlInput) {
        ['input', 'change'].forEach(evt => {
            hlInput.addEventListener(evt, (e) => {
                applyHighlightColor(e.target.value);
                closeHighlightPalette();
            });
        });
    }
    $('btn-highlight-clear')?.addEventListener('click', () => {
        clearHighlightColor();
        closeHighlightPalette();
    });
    $('btn-align-left')?.addEventListener('click', () => chain()?.setTextAlign('left').run());
    $('btn-align-center')?.addEventListener('click', () => chain()?.setTextAlign('center').run());
    $('btn-align-right')?.addEventListener('click', () => chain()?.setTextAlign('right').run());
    $('btn-align-justify')?.addEventListener('click', () => chain()?.setTextAlign('justify').run());
    $('btn-indent')?.addEventListener('click', () => chain()?.indent().run());
    $('btn-outdent')?.addEventListener('click', () => chain()?.outdent().run());
    $('btn-bullet')?.addEventListener('click', () => chain()?.toggleBulletList().run());
    $('btn-ordered')?.addEventListener('click', () => chain()?.toggleOrderedList().run());
    $('sel-line-height')?.addEventListener('change', (e) => chain()?.setLineHeight(e.target.value).run());

    // Insert tab
    $('btn-insert-page-break')?.addEventListener('click', () => {
        chain()?.setPageBreak().run();
        toast('Page Break inserted 📄');
    });
    $('btn-insert-link')?.addEventListener('click', () => {
        const prev = wordEditor?.getAttributes('link')?.href || '';
        const url = prompt('Enter URL:', prev);
        if (url === null) return;
        if (url === '') {
            chain()?.extendMarkRange('link').unsetLink().run();
        } else if (wordEditor?.state.selection.empty && !wordEditor?.isActive('link')) {
            // Insert URL as visible text when nothing is selected
            wordEditor.chain().focus().insertContent(`<a href="${url}">${url}</a>`).run();
        } else {
            chain()?.extendMarkRange('link').setLink({ href: url }).run();
        }
    });
    $('btn-insert-image')?.addEventListener('click', insertImage);
    $('btn-insert-table')?.addEventListener('click', () => chain()?.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run());
    $('btn-insert-row')?.addEventListener('click', () => chain()?.addRowAfter().run());
    $('btn-insert-col')?.addEventListener('click', () => chain()?.addColumnAfter().run());
    $('btn-delete-table')?.addEventListener('click', () => chain()?.deleteTable().run());

    // File tab
    $('word-file-btn-top')?.addEventListener('click', () => document.querySelector('[data-target="tab-file-content"]')?.click());
    $('btn-import')?.addEventListener('click', () => $('word-import-input')?.click());
    $('word-import-input')?.addEventListener('change', handleImportFile);
    $('btn-export-pdf')?.addEventListener('click', exportToPDF);
    $('btn-export-docx')?.addEventListener('click', exportToDOCX);
    $('btn-print-doc')?.addEventListener('click', () => window.print());

    // Landscape toggle
    $('chk-landscape')?.addEventListener('change', (e) => {
        isLandscape = e.target.checked;
        saveCurrentLayout();
        applyPageGeometry();
    });

    // Page setup
    $('btn-page-setup')?.addEventListener('click', () => {
        $('sel-paper-size').value = currentPaperSize;
        $('inp-margin-top').value = (docMargins.top / PX_PER_CM).toFixed(2);
        $('inp-margin-bottom').value = (docMargins.bottom / PX_PER_CM).toFixed(2);
        $('inp-margin-left').value = (docMargins.left / PX_PER_CM).toFixed(2);
        $('inp-margin-right').value = (docMargins.right / PX_PER_CM).toFixed(2);
        $('word-page-setup-modal')?.classList.remove('hidden');
    });
    $('btn-page-setup-cancel')?.addEventListener('click', () => $('word-page-setup-modal')?.classList.add('hidden'));
    $('btn-page-setup-apply')?.addEventListener('click', () => {
        currentPaperSize = $('sel-paper-size').value;
        const cm = (id, def) => (parseFloat($(id).value) || def);
        docMargins.top = Math.round(cm('inp-margin-top', 2.54) * PX_PER_CM);
        docMargins.bottom = Math.round(cm('inp-margin-bottom', 2.54) * PX_PER_CM);
        docMargins.left = Math.round(cm('inp-margin-left', 2.54) * PX_PER_CM);
        docMargins.right = Math.round(cm('inp-margin-right', 2.54) * PX_PER_CM);
        $('word-page-setup-modal')?.classList.add('hidden');
        saveCurrentLayout();
        applyPageGeometry();
    });

    bindFindReplace();
    window.addEventListener('resize', applyPageGeometry);
}

function insertImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => chain()?.setImage({ src: reader.result }).run();
        reader.readAsDataURL(file);
    };
    input.click();
}

/* ============================================================
 * Find & Replace
 * ========================================================== */
function bindFindReplace() {
    const panel = $('word-search-panel');
    const inpSearch = $('inp-search-term');
    const inpReplace = $('inp-replace-term');
    const status = $('search-status');

    const setStatus = () => {
        if (!status) return;
        status.textContent = searchMatches.length === 0 ? '0/0' : `${searchIndex + 1}/${searchMatches.length}`;
    };

    const paint = () => {
        if (!wordEditor) return;
        const decos = searchMatches.map((m, i) =>
            Decoration.inline(m.from, m.to, { class: i === searchIndex ? 'search-result-current' : 'search-result' }));
        const set = DecorationSet.create(wordEditor.state.doc, decos);
        wordEditor.view.dispatch(wordEditor.state.tr.setMeta(SearchPluginKey, { decorations: set }));
        if (searchMatches.length) scrollToCurrent();
    };

    const clearPaint = () => {
        if (!wordEditor) return;
        wordEditor.view.dispatch(wordEditor.state.tr.setMeta(SearchPluginKey, { decorations: DecorationSet.empty }));
    };

    const scrollToCurrent = () => setTimeout(() => {
        const el = document.querySelector('.search-result-current');
        const container = $('word-editor-scroll-area');
        if (el && container) {
            const r = el.getBoundingClientRect();
            const c = container.getBoundingClientRect();
            if (r.top < c.top + 60 || r.bottom > c.bottom - 40) {
                container.scrollBy({ top: r.top - c.top - 120, behavior: 'smooth' });
            }
        }
    }, 10);

    const runSearch = (term) => {
        searchMatches = [];
        searchIndex = -1;
        if (!wordEditor || !term) { setStatus(); clearPaint(); return; }
        const lower = term.toLowerCase();
        wordEditor.state.doc.descendants((node, pos) => {
            if (node.isText && node.text) {
                const t = node.text.toLowerCase();
                let i = t.indexOf(lower);
                while (i !== -1) {
                    searchMatches.push({ from: pos + i, to: pos + i + term.length });
                    i = t.indexOf(lower, i + 1);
                }
            }
        });
        if (searchMatches.length) { searchIndex = 0; paint(); } else { clearPaint(); }
        setStatus();
    };

    const next = () => { if (!searchMatches.length) return; searchIndex = (searchIndex + 1) % searchMatches.length; paint(); setStatus(); };
    const prev = () => { if (!searchMatches.length) return; searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length; paint(); setStatus(); };

    const openPanel = () => { panel?.classList.remove('hidden'); panel?.classList.add('flex'); inpSearch?.focus(); if (inpSearch?.value) runSearch(inpSearch.value); };
    const closePanel = () => { panel?.classList.add('hidden'); panel?.classList.remove('flex'); searchMatches = []; searchIndex = -1; clearPaint(); };

    inpSearch?.addEventListener('input', (e) => runSearch(e.target.value));
    inpSearch?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
    $('btn-search-next')?.addEventListener('click', next);
    $('btn-search-prev')?.addEventListener('click', prev);
    $('btn-search-close')?.addEventListener('click', closePanel);
    $('btn-search-header')?.addEventListener('click', () => (panel?.classList.contains('hidden') ? openPanel() : closePanel()));

    $('btn-replace')?.addEventListener('click', () => {
        if (!wordEditor || !searchMatches.length) return;
        if (searchIndex < 0) searchIndex = 0;
        const m = searchMatches[searchIndex];
        const keep = searchIndex;
        wordEditor.view.dispatch(wordEditor.state.tr.insertText(inpReplace.value, m.from, m.to));
        runSearch(inpSearch.value);
        if (searchMatches.length) { searchIndex = keep >= searchMatches.length ? 0 : keep; paint(); setStatus(); }
    });
    $('btn-replace-all')?.addEventListener('click', () => {
        if (!wordEditor || !searchMatches.length) return;
        const tr = wordEditor.state.tr;
        for (let i = searchMatches.length - 1; i >= 0; i--) tr.insertText(inpReplace.value, searchMatches[i].from, searchMatches[i].to);
        wordEditor.view.dispatch(tr);
        runSearch(inpSearch.value);
    });

    document.addEventListener('keydown', (e) => {
        const modal = $('word-editor-modal');
        const open = modal && !modal.classList.contains('hidden') && !modal.classList.contains('translate-y-full');
        if (open && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openPanel(); }
    });
}

/* ============================================================
 * Import (.docx / .html / .txt / .md / .json)
 * ========================================================== */
async function handleImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const name = file.name || 'Imported Document';
    const baseTitle = name.replace(/\.[^.]+$/, '');
    const ext = (name.split('.').pop() || '').toLowerCase();

    toast('Importing ' + name + '...');
    try {
        currentDocId = 'doc_' + Date.now();
        $('word-doc-title').value = baseTitle || 'Imported Document';

        if (ext === 'json') {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const content = parsed?.content?.content ? parsed.content : (parsed?.type === 'doc' ? parsed : parsed?.content || parsed);
            initTiptap();
            wordEditor.commands.setContent(content || '');
        } else if (ext === 'docx') {
            const arrayBuffer = await file.arrayBuffer();
            const mammoth = await loadMammoth();
            if (!mammoth) { toast('DOCX import needs the "mammoth" package installed.', true); return; }
            const result = await mammoth.convertToHtml({ arrayBuffer });
            initTiptap();
            wordEditor.commands.setContent(result.value || '');
        } else if (ext === 'html' || ext === 'htm') {
            const html = await file.text();
            const body = extractBodyHtml(html);
            initTiptap();
            wordEditor.commands.setContent(body);
        } else {
            const text = await file.text();
            const html = text.split(/\r?\n/).map(line => `<p>${escapeHtml(line) || '<br>'}</p>`).join('');
            initTiptap();
            wordEditor.commands.setContent(html);
        }

        saveDocData(currentDocId, { content: wordEditor.getJSON() });
        saveDocToIndex($('word-doc-title').value);
        applyPageGeometry();
        if (window.renderMyDocuments) window.renderMyDocuments();
        toast('Imported successfully 📄');
    } catch (err) {
        console.error('[word.js] import failed:', err);
        toast('Could not import this file.', true);
    }
}

async function loadMammoth() {
    if (typeof window !== 'undefined' && window.mammoth) return window.mammoth;
    const pkg = 'mammoth';
    try { const m = await import(/* @vite-ignore */ pkg); return m.default || m; }
    catch (e) { console.warn('[word.js] mammoth not available:', e); return null; }
}

function extractBodyHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body ? doc.body.innerHTML : html;
}
function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export async function init(docId = null) {
    return openWordEditor(docId);
}

/* ============================================================
 * Export helpers & Intelligent DOM Flow Pagination Engine
 * ========================================================== */
const PX_PER_MM = 3.779527559; // 96 DPI / 25.4 mm

export function getExportGeometry() {
    let pdfWidthMm = 210;
    let pdfHeightMm = 297;
    if (currentPaperSize === 'Letter') {
        pdfWidthMm = 215.9;
        pdfHeightMm = 279.4;
    } else if (currentPaperSize === 'A5') {
        pdfWidthMm = 148;
        pdfHeightMm = 210;
    }

    if (isLandscape) {
        const tmp = pdfWidthMm;
        pdfWidthMm = pdfHeightMm;
        pdfHeightMm = tmp;
    }

    // Convert docMargins (in px at 96 DPI) to mm, with safe minimums
    const topMm = Math.max(8, (docMargins.top || 54) / PX_PER_MM);
    const bottomMm = Math.max(12, (docMargins.bottom || 54) / PX_PER_MM);
    const leftMm = Math.max(10, (docMargins.left || 54) / PX_PER_MM);
    const rightMm = Math.max(10, (docMargins.right || 54) / PX_PER_MM);

    const pageWidthPx = Math.round(pdfWidthMm * PX_PER_MM);
    const pageHeightPx = Math.round(pdfHeightMm * PX_PER_MM);

    const paddingTopPx = Math.round(topMm * PX_PER_MM);
    const paddingBottomPx = Math.round(bottomMm * PX_PER_MM);
    const paddingLeftPx = Math.round(leftMm * PX_PER_MM);
    const paddingRightPx = Math.round(rightMm * PX_PER_MM);

    const contentWidthPx = Math.max(200, pageWidthPx - paddingLeftPx - paddingRightPx);
    const contentHeightPx = Math.max(200, pageHeightPx - paddingTopPx - paddingBottomPx);

    return {
        pdfWidthMm,
        pdfHeightMm,
        topMm,
        bottomMm,
        leftMm,
        rightMm,
        pageWidthPx,
        pageHeightPx,
        paddingTopPx,
        paddingBottomPx,
        paddingLeftPx,
        paddingRightPx,
        contentWidthPx,
        contentHeightPx,
    };
}

/**
 * Strips editor-only artifacts out of the live ProseMirror DOM before export.
 * Find & Replace decorations (.search-result / .search-result-current) carry a
 * yellow background and a bottom border, and table column-resize handles are
 * blue bars: none of that belongs in a PDF or DOCX.
 */
function sanitizeExportHtml(rawHtml) {
    if (!rawHtml) return '';
    if (typeof DOMParser === 'undefined') return rawHtml;
    try {
        const doc = new DOMParser().parseFromString(
            `<body><div id="kivu-export-root">${rawHtml}</div></body>`, 'text/html');
        const root = (doc.getElementById ? doc.getElementById('kivu-export-root') : null) || (doc.querySelector ? doc.querySelector('#kivu-export-root') : null);
        if (!root) return rawHtml;

        // 1. Purely decorative editor widgets.
        root.querySelectorAll(
            '.column-resize-handle, .ProseMirror-gapcursor, .ProseMirror-separator, .word-page-break-label'
        ).forEach(el => el.parentNode && el.parentNode.removeChild(el));

        // 2. Unwrap search decoration spans, keeping their text.
        root.querySelectorAll('.search-result, .search-result-current').forEach(el => {
            const parent = el.parentNode;
            if (!parent) return;
            if (el.tagName === 'SPAN') {
                while (el.firstChild) parent.insertBefore(el.firstChild, el);
                parent.removeChild(el);
            } else {
                el.classList.remove('search-result');
                el.classList.remove('search-result-current');
                if (el.getAttribute('class') === '') el.removeAttribute('class');
            }
        });

        // 3. Drop transient editing state.
        root.querySelectorAll('.selectedCell, .ProseMirror-selectednode').forEach(el => {
            el.classList.remove('selectedCell');
            el.classList.remove('ProseMirror-selectednode');
            if (el.getAttribute('class') === '') el.removeAttribute('class');
        });
        root.querySelectorAll('[contenteditable], [spellcheck], [draggable]').forEach(el => {
            el.removeAttribute('contenteditable');
            el.removeAttribute('spellcheck');
            el.removeAttribute('draggable');
        });

        return root.innerHTML;
    } catch (e) {
        console.warn('[word.js] export HTML sanitize skipped:', e);
        return rawHtml;
    }
}

function getContentHtml() {
    const pm = document.querySelector('#tiptap-editor-container .ProseMirror');
    const raw = pm ? pm.innerHTML : (wordEditor ? wordEditor.getHTML() : '');
    return sanitizeExportHtml(raw);
}

/* ============================================================
 * Highlight / inline background export pipeline
 *
 * html2canvas cannot be trusted with the background of an *inline* element:
 *   - the painted box comes from ONE getBoundingClientRect(), i.e. the union
 *     of every line box the run covers, so a highlight that wraps becomes a
 *     full-width rectangle, and inline backgrounds are painted after block
 *     text — the rectangle swallowed the text underneath it;
 *   - even for a single line the band lands ~0.47em above the glyphs.
 *
 * So the export does it by hand: getClientRects() already returns exactly one
 * rectangle per line box, those are remembered, the element's own background
 * is removed, and after rasterizing each page the bands are filled onto the
 * canvas behind the text with 'multiply', vertically snapped to the glyph ink
 * that html2canvas actually produced. Nothing in the DOM is restructured, so
 * line breaking and the measured page height cannot change.
 * ========================================================== */

function hasVisibleBgColor(color) {
    if (!color) return false;
    const c = String(color).trim().toLowerCase();
    if (!c || c === 'transparent' || c === 'none' || c === 'initial' || c === 'unset') return false;
    const m = c.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
        const parts = m[1].split(',').map(v => parseFloat(v));
        if (parts.length >= 4 && !(parts[3] > 0.01)) return false;
    }
    return true;
}

function parseRgb(color) {
    const m = String(color || '').match(/^rgba?\(([^)]+)\)$/);
    if (!m) return null;
    const p = m[1].split(',').map(v => parseFloat(v));
    if (p.length < 3 || p.some(v => !isFinite(v))) return null;
    return [p[0], p[1], p[2]];
}

function lumaOf(rgb) {
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

/**
 * A highlighted run whose text is light (white text on a dark highlight) relies
 * on its background for contrast. Once the background is taken out of the DOM
 * that text is white on white — unrecoverable from the bitmap, since the band is
 * later blended with 'multiply'. Such text is darkened, keeping its hue, so the
 * characters survive rasterization and stay readable through the band. The
 * highlight colour itself is never touched.
 */
function darkenLightTextInRun(el, win) {
    const fix = node => {
        let cs;
        try { cs = win.getComputedStyle(node); } catch (_) { return; }
        const rgb = cs && parseRgb(cs.color);
        if (!rgb || lumaOf(rgb) < 170) return;
        const k = 70 / Math.max(1, lumaOf(rgb));          // land around luma 70
        node.style.color = `rgb(${Math.round(rgb[0] * k)}, ${Math.round(rgb[1] * k)}, ${Math.round(rgb[2] * k)})`;
    };
    fix(el);
    Array.from(el.querySelectorAll('*')).forEach(fix);
}

/**
 * Strips backgrounds from staged page elements and extracts exact highlight
 * bounding boxes in page-sheet local coordinates.
 * Disables the element's DOM background so html2canvas renders clean text glyphs,
 * which are then overlaid on canvas with 'multiply' blend mode.
 */
export function extractHighlightBoxes(pageEl, contentEl) {
    const bands = [];
    if (!pageEl || !contentEl) return bands;
    const win = (pageEl.ownerDocument || document).defaultView || window;
    if (!win || typeof win.getComputedStyle !== 'function') return bands;

    let base = { left: 0, top: 0, width: 0, height: 0 };
    if (typeof pageEl.getBoundingClientRect === 'function') {
        try { base = pageEl.getBoundingClientRect(); } catch (_) {}
    }

    const handled = [];
    const candidates = Array.from(contentEl.querySelectorAll('*'));

    candidates.forEach(el => {
        const tag = (el.tagName || '').toLowerCase();
        const isMark = tag === 'mark';
        const explicitColor = el.getAttribute('data-highlight-color') ||
                              el.getAttribute('data-color') ||
                              (el.style && el.style.backgroundColor);

        let color = null;
        if (hasVisibleBgColor(explicitColor)) {
            color = explicitColor;
        } else if (isMark) {
            let cs;
            try { cs = win.getComputedStyle(el); } catch (_) {}
            if (cs && hasVisibleBgColor(cs.backgroundColor)) {
                color = cs.backgroundColor;
            }
        }

        if (!color) return;

        // Save original color so re-extraction or subsequent passes preserve color
        el.setAttribute('data-highlight-color', color);

        // Outermost background container wins (avoids nested duplicate multiply passes)
        if (handled.some(done => done.contains(el))) return;
        handled.push(el);

        let cs;
        try { cs = win.getComputedStyle(el); } catch (_) {}

        let rects = [];
        const isInline = !cs || cs.display === 'inline' || isMark;
        if (isInline && typeof el.getClientRects === 'function') {
            try { rects = Array.from(el.getClientRects()); } catch (_) { rects = []; }
        }

        if (rects.length === 0 && typeof el.getBoundingClientRect === 'function') {
            try {
                const b = el.getBoundingClientRect();
                if (b && (b.width > 0.5 || b.height > 0.5)) {
                    rects = [b];
                }
            } catch (_) {}
        }

        if (rects.length === 0 && el.offsetWidth && el.offsetHeight) {
            let cur = el;
            let ox = 0, oy = 0;
            while (cur && cur !== pageEl) {
                ox += cur.offsetLeft || 0;
                oy += cur.offsetTop || 0;
                cur = cur.offsetParent;
            }
            rects = [{ left: base.left + ox, top: base.top + oy, width: el.offsetWidth, height: el.offsetHeight }];
        }

        darkenLightTextInRun(el, win);
        el.style.backgroundColor = 'transparent';
        el.style.backgroundImage = 'none';

        rects.forEach(r => {
            if (!r || r.width < 0.5 || r.height < 0.5) return;
            const relX = r.left - base.left;
            const relY = r.top - base.top;
            bands.push({
                x: Math.max(0, relX),
                y: Math.max(0, relY),
                w: r.width,
                h: r.height,
                color
            });
        });
    });

    return bands;
}

export const collectInlineHighlights = extractHighlightBoxes;

/**
 * Renders highlight boxes onto a rasterized page canvas.
 * Uses 'multiply' composite mode to guarantee text ink is never obscured.
 * Direct coordinate scaling avoids inaccurate canvas pixel reading or shifting.
 */
export function renderHighlightsOnCanvas(canvas, highlights, geometry) {
    if (!canvas || !highlights || highlights.length === 0) return;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;

    const pageWidth = (geometry && geometry.pageWidthPx) || canvas.width;
    const pageHeight = (geometry && geometry.pageHeightPx) || canvas.height;
    const sx = canvas.width / pageWidth;
    const sy = canvas.height / pageHeight;

    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    if (ctx.globalCompositeOperation !== 'multiply') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.4;
    }

    const padX = Math.max(1, Math.round(sx * 1.0));
    const padY = Math.max(1, Math.round(sy * 0.5));

    highlights.forEach(b => {
        if (!b || !b.color || !(b.w > 0.5) || !(b.h > 0.5)) return;
        if (b.x >= pageWidth || b.y >= pageHeight) return;

        const x = Math.max(0, Math.round(b.x * sx) - padX);
        const y = Math.max(0, Math.round(b.y * sy) - padY);
        if (x >= canvas.width || y >= canvas.height) return;

        const w = Math.max(1, Math.round(b.w * sx) + padX * 2);
        const h = Math.max(1, Math.round(b.h * sy) + padY * 2);

        const dw = Math.min(w, canvas.width - x);
        const dh = Math.min(h, canvas.height - y);
        if (dw <= 0 || dh <= 0) return;

        ctx.fillStyle = b.color;
        ctx.fillRect(x, y, dw, dh);
    });

    ctx.restore();
}

export const paintHighlightBands = renderHighlightsOnCanvas;

/**
 * Paginates document HTML into discrete DOM page containers.
 * Eliminates mid-line text slicing, row clipping, and duplicated lines.
 */
export function paginateDocument(rawHtml, geometry) {
    const sandbox = document.createElement('div');
    sandbox.className = 'word-pdf-staging-sandbox';
    sandbox.style.cssText = `
        position: fixed;
        left: 0;
        top: 0;
        width: ${geometry.pageWidthPx}px;
        background: #ffffff;
        pointer-events: none;
        z-index: -9999;
        visibility: visible;
        opacity: 1;
    `;
    document.body.appendChild(sandbox);

    const styleTag = document.createElement('style');
    styleTag.textContent = `
        .pdf-page-sheet {
            width: ${geometry.pageWidthPx}px;
            height: ${geometry.pageHeightPx}px;
            padding: ${geometry.paddingTopPx}px ${geometry.paddingRightPx}px ${geometry.paddingBottomPx}px ${geometry.paddingLeftPx}px;
            box-sizing: border-box;
            background: #ffffff;
            color: #111827;
            position: relative;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
            font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
            font-size: 12pt;
            line-height: 1.5;
            -webkit-text-size-adjust: 100% !important;
            text-size-adjust: 100% !important;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            text-rendering: geometricPrecision;
            font-kerning: normal;
        }
        .pdf-page-content {
            width: 100%;
            height: 100%;
            max-height: ${geometry.contentHeightPx}px;
            box-sizing: border-box;
            overflow: hidden;
            flex: 1 1 auto;
        }
        .pdf-page-content p {
            margin: 0 0 0.5em 0;
            overflow-wrap: break-word;
            word-wrap: break-word;
            word-break: break-word;
        }
        .pdf-page-content h1 { font-size: 22pt; font-weight: bold; margin: 0.6em 0 0.3em 0; line-height: 1.25; }
        .pdf-page-content h2 { font-size: 18pt; font-weight: bold; margin: 0.5em 0 0.25em 0; line-height: 1.3; }
        .pdf-page-content h3 { font-size: 15pt; font-weight: bold; margin: 0.4em 0 0.2em 0; line-height: 1.35; }
        .pdf-page-content h4, .pdf-page-content h5, .pdf-page-content h6 { font-size: 12pt; font-weight: bold; margin: 0.3em 0 0.2em 0; }
        .pdf-page-content table {
            border-collapse: collapse;
            width: 100%;
            margin: 8px 0;
            table-layout: fixed;
            box-sizing: border-box;
        }
        .pdf-page-content td, .pdf-page-content th {
            border: 1px solid #94a3b8;
            padding: 6px 8px;
            vertical-align: top;
            box-sizing: border-box;
            word-break: break-word;
            overflow-wrap: break-word;
        }
        .pdf-page-content th {
            background: #f1f5f9;
            font-weight: bold;
        }
        .pdf-page-content td > p, .pdf-page-content th > p {
            margin: 0 0 4px 0;
        }
        .pdf-page-content td > p:last-child, .pdf-page-content th > p:last-child {
            margin-bottom: 0;
        }
        .pdf-table-repeated-header {
            background: #f8fafc;
        }
        .pdf-page-content ul { list-style-type: disc !important; padding-left: 1.5rem !important; margin: 0.4em 0; }
        .pdf-page-content ol { list-style-type: decimal !important; padding-left: 1.5rem !important; margin: 0.4em 0; }
        .pdf-page-content li { margin: 0.2em 0; }
        .pdf-page-content blockquote {
            border-left: 3px solid #cbd5e1;
            padding-left: 12px;
            margin: 0.5em 0;
            color: #475569;
            font-style: italic;
        }
        .pdf-page-content pre {
            background: #1e293b;
            color: #f8fafc;
            padding: 10px 12px;
            border-radius: 6px;
            font-family: 'Courier New', Courier, monospace;
            font-size: 10.5pt;
            line-height: 1.4;
            margin: 0.5em 0;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .pdf-page-content code {
            font-family: 'Courier New', Courier, monospace;
            font-size: 0.95em;
        }
        .pdf-page-content img {
            max-width: 100%;
            height: auto;
            border-radius: 4px;
            display: block;
            margin: 8px 0;
        }
        /* The highlight is painted onto the canvas afterwards from these
           rectangles (collectInlineHighlights / paintHighlightBands), so the
           <mark> must contribute nothing but its exact per-line boxes. */
        .pdf-page-content mark {
            padding: 0 !important;
            border-radius: 0 !important;
        }
        /* Find & Replace decorations are editor UI, never document content. */
        .pdf-page-content .search-result,
        .pdf-page-content .search-result-current {
            background: transparent !important;
            border-bottom: none !important;
            box-shadow: none !important;
        }
        .pdf-page-footer {
            position: absolute;
            bottom: 8px;
            left: ${geometry.paddingLeftPx}px;
            right: ${geometry.paddingRightPx}px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 9pt;
            color: #94a3b8;
            font-family: sans-serif;
            pointer-events: none;
        }
    `;
    sandbox.appendChild(styleTag);

    const pages = [];

    function createPageSheet(pageNum) {
        const pageEl = document.createElement('div');
        pageEl.className = 'pdf-page-sheet';

        const contentEl = document.createElement('div');
        contentEl.className = 'pdf-page-content ProseMirror';

        const footerEl = document.createElement('div');
        footerEl.className = 'pdf-page-footer';
        footerEl.innerHTML = `<span></span><span class="pdf-page-num">${pageNum}</span>`;

        pageEl.appendChild(contentEl);
        pageEl.appendChild(footerEl);
        sandbox.appendChild(pageEl);

        const pageObj = { pageEl, contentEl, footerEl, pageNum };
        pages.push(pageObj);
        return pageObj;
    }

    let cur = createPageSheet(1);
    const maxH = geometry.contentHeightPx;

    function fits(contentEl) {
        const sh = contentEl.scrollHeight;
        if (typeof sh !== 'number' || isNaN(sh)) return true;
        return sh <= maxH + 2;
    }

    function nextPage() {
        cur = createPageSheet(pages.length + 1);
        return cur;
    }

    // Parse blocks from raw HTML
    let blockNodes = [];
    if (typeof DOMParser !== 'undefined') {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(`<body><div>${rawHtml}</div></body>`, 'text/html');
            const root = (doc.body && doc.body.firstElementChild) || doc.body;
            if (root) {
                blockNodes = Array.from((root.childNodes && root.childNodes.length) ? root.childNodes : (root.children || []));
            }
        } catch (_) {}
    }
    if (!blockNodes || blockNodes.length === 0) {
        const temp = document.createElement('div');
        temp.innerHTML = rawHtml;
        blockNodes = Array.from((temp.childNodes && temp.childNodes.length) ? temp.childNodes : (temp.children || []));
    }

    for (let i = 0; i < blockNodes.length; i++) {
        const node = blockNodes[i];

        // Plain text node
        if (node.nodeType === 3 || node.nodeType === Node?.TEXT_NODE || node.tagName === '#TEXT') {
            const text = node.textContent || '';
            if (!text.trim()) continue;
            const p = document.createElement('p');
            p.textContent = text;
            addBlock(p);
            continue;
        }

        if (node.nodeType !== 1 && node.nodeType !== Node?.ELEMENT_NODE && typeof node.getAttribute !== 'function') continue;

        const tag = (node.tagName || '').toLowerCase();

        // 1. Explicit Page Break
        const isPageBreak = (typeof node.getAttribute === 'function' && node.getAttribute('data-type') === 'page-break') ||
            (node.dataset && node.dataset.type === 'page-break') ||
            (node.classList && typeof node.classList.contains === 'function' && (node.classList.contains('word-page-break-node') || node.classList.contains('page-break'))) ||
            (tag === 'hr' && typeof node.getAttribute === 'function' && node.getAttribute('data-type') === 'page-break');

        if (isPageBreak) {
            if (cur.contentEl.childNodes.length > 0) {
                nextPage();
            }
            continue;
        }

        // 2. Heading: keep with next content to avoid orphaned headers
        if (/^h[1-6]$/.test(tag)) {
            const clone = node.cloneNode(true);
            cur.contentEl.appendChild(clone);
            const remaining = maxH - cur.contentEl.scrollHeight;
            if (!fits(cur.contentEl) || (remaining < 80 && cur.contentEl.childNodes.length > 1)) {
                cur.contentEl.removeChild(clone);
                nextPage();
                cur.contentEl.appendChild(clone);
            }
            continue;
        }

        // 3. Image
        if (tag === 'img' || (tag === 'p' && node.querySelector('img') && node.textContent.trim() === '')) {
            const clone = node.cloneNode(true);
            const img = clone.tagName.toLowerCase() === 'img' ? clone : clone.querySelector('img');
            if (img) {
                img.style.maxHeight = `${maxH - 20}px`;
                img.style.maxWidth = '100%';
                img.style.objectFit = 'contain';
            }
            cur.contentEl.appendChild(clone);
            if (!fits(cur.contentEl)) {
                if (cur.contentEl.childNodes.length > 1) {
                    cur.contentEl.removeChild(clone);
                    nextPage();
                    cur.contentEl.appendChild(clone);
                }
            }
            continue;
        }

        // 4. Table: Split row by row cleanly, preserving column widths, headers, and tall cells
        if (tag === 'table') {
            const clone = node.cloneNode(true);
            cur.contentEl.appendChild(clone);
            if (fits(cur.contentEl)) {
                continue;
            }
            cur.contentEl.removeChild(clone);

            // Normalize <colgroup> across all split tables so column widths never shift across pages
            let colgroup = node.querySelector('colgroup');
            if (!colgroup || !colgroup.querySelector('col')) {
                const firstRow = node.querySelector('tr');
                if (firstRow) {
                    const cells = Array.from(firstRow.children).filter(c => {
                        const ct = (c.tagName || '').toLowerCase();
                        return ct === 'th' || ct === 'td';
                    });
                    if (cells.length > 0) {
                        const synth = document.createElement('colgroup');
                        const widths = cells.map(cell => {
                            const cw = (typeof cell.getAttribute === 'function' ? cell.getAttribute('data-colwidth') : null) || cell.style?.width;
                            if (cw) {
                                const num = parseFloat(cw);
                                if (!isNaN(num) && num > 0) {
                                    return String(cw).endsWith('%') ? String(cw) : `${num}px`;
                                }
                            }
                            return null;
                        });
                        cells.forEach((cell, idx) => {
                            const col = document.createElement('col');
                            const w = widths[idx];
                            if (w) {
                                col.style.width = w;
                            } else {
                                col.style.width = `${(100 / cells.length).toFixed(2)}%`;
                            }
                            synth.appendChild(col);
                        });
                        colgroup = synth;
                    }
                }
            }

            const thead = node.querySelector('thead');
            const allRows = Array.from(node.querySelectorAll('tr'));

            // Detect header row: either in thead or the first row in tbody with <th>
            const headerRow = !thead && allRows.length > 0 && allRows[0].querySelector('th') ? allRows[0] : null;

            const makeTable = (isContinuation = false) => {
                const tbl = document.createElement('table');
                tbl.className = node.className;
                tbl.style.cssText = node.style.cssText;
                if (colgroup) tbl.appendChild(colgroup.cloneNode(true));
                if (thead) {
                    tbl.appendChild(thead.cloneNode(true));
                }
                const tb = document.createElement('tbody');
                tbl.appendChild(tb);
                if (isContinuation && headerRow) {
                    const rep = headerRow.cloneNode(true);
                    rep.classList.add('pdf-table-repeated-header');
                    tb.appendChild(rep);
                }
                return { tbl, tbody: tb };
            };

            const splitTallRow = (tbody, tallTr, getNextTbody) => {
                const cells = Array.from(tallTr.children);
                let splittable = false;
                for (const c of cells) {
                    if (c.children && c.children.length > 1) { splittable = true; break; }
                    if (c.textContent && c.textContent.length > 100) { splittable = true; break; }
                }
                if (!splittable) return;

                const nextTr = document.createElement('tr');
                nextTr.className = tallTr.className;
                nextTr.style.cssText = tallTr.style.cssText;

                cells.forEach((cell) => {
                    const nextCell = cell.cloneNode(false);
                    nextTr.appendChild(nextCell);

                    const paras = Array.from(cell.childNodes);
                    if (paras.length > 1) {
                        const mid = Math.ceil(paras.length / 2);
                        for (let p = mid; p < paras.length; p++) {
                            nextCell.appendChild(paras[p]);
                        }
                    } else if (paras.length === 1 && paras[0].textContent && paras[0].textContent.length > 100) {
                        const pNode = paras[0];
                        const words = (pNode.textContent || '').split(/(\s+)/);
                        if (words.length > 4) {
                            const mid = Math.floor(words.length / 2);
                            const w1 = words.slice(0, mid).join('');
                            const w2 = words.slice(mid).join('');
                            pNode.textContent = w1;
                            const nextP = pNode.cloneNode(false);
                            nextP.textContent = w2;
                            nextCell.appendChild(nextP);
                        }
                    } else {
                        nextCell.innerHTML = '&nbsp;';
                    }
                });

                const nextTb = getNextTbody();
                nextTb.appendChild(nextTr);
            };

            let { tbl: curTable, tbody: curTbody } = makeTable(false);
            cur.contentEl.appendChild(curTable);

            let rowsOnPage = 0;
            let startRowIdx = 0;
            if (headerRow) {
                const hClone = headerRow.cloneNode(true);
                curTbody.appendChild(hClone);
                rowsOnPage = 1;
                startRowIdx = 1;
            }

            // Track active rowspans: array of { colIdx, remainingRows, originalCell, cellInCurTable }
            let activeSpans = [];

            for (let r = startRowIdx; r < allRows.length; r++) {
                const tr = allRows[r];
                if (thead && thead.contains(tr)) continue;

                const trClone = tr.cloneNode(true);

                // Compute column indices for cells in tr to track rowspans
                let currentVirtualCol = 0;
                const rowSpansInThisRow = [];
                const cellsInTr = Array.from(trClone.children);
                cellsInTr.forEach(c => {
                    while (activeSpans.some(s => s.colIdx === currentVirtualCol)) {
                        currentVirtualCol++;
                    }
                    const colIdx = currentVirtualCol;
                    const cspan = parseInt(c.getAttribute?.('colspan') || '1', 10);
                    const rspan = parseInt(c.getAttribute?.('rowspan') || '1', 10);
                    if (rspan > 1) {
                        rowSpansInThisRow.push({
                            colIdx,
                            remainingRows: rspan - 1,
                            originalCell: c,
                            cellInCurTable: c
                        });
                    }
                    currentVirtualCol += cspan;
                });

                curTbody.appendChild(trClone);

                if (!fits(cur.contentEl)) {
                    if (rowsOnPage > (headerRow ? 1 : 0)) {
                        curTbody.removeChild(trClone);

                        // Clamp rowspans on the previous page
                        activeSpans.forEach(span => {
                            if (span.cellInCurTable) {
                                const origRspan = parseInt(span.originalCell.getAttribute?.('rowspan') || '1', 10);
                                const clamped = origRspan - span.remainingRows;
                                if (clamped > 1) {
                                    span.cellInCurTable.setAttribute('rowspan', String(clamped));
                                } else {
                                    span.cellInCurTable.removeAttribute('rowspan');
                                }
                            }
                        });

                        nextPage();

                        const cont = makeTable(true);
                        curTable = cont.tbl;
                        curTbody = cont.tbody;
                        cur.contentEl.appendChild(curTable);

                        // Inject continuation cells into trClone for active spans from previous pages
                        activeSpans.forEach(span => {
                            const contCell = span.originalCell.cloneNode(false);
                            contCell.className = span.originalCell.className;
                            contCell.classList.add('pdf-table-rowspan-continuation');
                            contCell.style.cssText = span.originalCell.style?.cssText || '';
                            if (span.remainingRows > 1) {
                                contCell.setAttribute('rowspan', String(span.remainingRows));
                            } else {
                                contCell.removeAttribute('rowspan');
                            }
                            contCell.innerHTML = '<span style="font-size: 0.85em; opacity: 0.7; font-style: italic;">(cont.)</span>';
                            const children = Array.from(trClone.children);
                            if (span.colIdx < children.length) {
                                trClone.insertBefore(contCell, children[span.colIdx]);
                            } else {
                                trClone.appendChild(contCell);
                            }
                        });

                        curTbody.appendChild(trClone);
                        rowsOnPage = headerRow ? 2 : 1;

                        if (!fits(cur.contentEl)) {
                            splitTallRow(curTbody, trClone, () => {
                                nextPage();
                                const nextCont = makeTable(true);
                                curTable = nextCont.tbl;
                                curTbody = nextCont.tbody;
                                cur.contentEl.appendChild(curTable);
                                return curTbody;
                            });
                        }
                    } else {
                        if (cur.contentEl.childNodes.length > 1) {
                            cur.contentEl.removeChild(curTable);
                            nextPage();

                            const cont = makeTable(true);
                            curTable = cont.tbl;
                            curTbody = cont.tbody;
                            cur.contentEl.appendChild(curTable);

                            curTbody.appendChild(trClone);
                            rowsOnPage = headerRow ? 2 : 1;
                        } else {
                            splitTallRow(curTbody, trClone, () => {
                                nextPage();
                                const nextCont = makeTable(true);
                                curTable = nextCont.tbl;
                                curTbody = nextCont.tbody;
                                cur.contentEl.appendChild(curTable);
                                return curTbody;
                            });
                            rowsOnPage = headerRow ? 2 : 1;
                        }
                    }
                } else {
                    rowsOnPage++;
                }

                // Advance active spans
                activeSpans.forEach(s => s.remainingRows--);
                activeSpans = activeSpans.filter(s => s.remainingRows > 0);
                activeSpans.push(...rowSpansInThisRow);
            }
            continue;
        }

        // 5. Lists (ul, ol): Split item by item
        if (tag === 'ul' || tag === 'ol') {
            const clone = node.cloneNode(true);
            cur.contentEl.appendChild(clone);
            if (fits(cur.contentEl)) {
                continue;
            }
            cur.contentEl.removeChild(clone);

            const isOl = tag === 'ol';
            const items = Array.from(node.children).filter(c => c.tagName.toLowerCase() === 'li');
            let startIdx = parseInt(node.getAttribute('start') || '1', 10);

            let curList = document.createElement(tag);
            curList.className = node.className;
            curList.style.cssText = node.style.cssText;
            if (isOl) curList.setAttribute('start', String(startIdx));
            cur.contentEl.appendChild(curList);

            let itemsOnPage = 0;
            for (let liIdx = 0; liIdx < items.length; liIdx++) {
                const li = items[liIdx];
                const liClone = li.cloneNode(true);
                curList.appendChild(liClone);

                if (!fits(cur.contentEl)) {
                    if (itemsOnPage > 0) {
                        curList.removeChild(liClone);
                        nextPage();

                        curList = document.createElement(tag);
                        curList.className = node.className;
                        curList.style.cssText = node.style.cssText;
                        if (isOl) curList.setAttribute('start', String(startIdx + liIdx));
                        cur.contentEl.appendChild(curList);

                        curList.appendChild(liClone);
                        itemsOnPage = 1;
                    } else {
                        if (cur.contentEl.childNodes.length > 1) {
                            cur.contentEl.removeChild(curList);
                            nextPage();

                            curList = document.createElement(tag);
                            curList.className = node.className;
                            curList.style.cssText = node.style.cssText;
                            if (isOl) curList.setAttribute('start', String(startIdx + liIdx));
                            cur.contentEl.appendChild(curList);

                            curList.appendChild(liClone);
                            itemsOnPage = 1;
                        } else {
                            itemsOnPage = 1;
                        }
                    }
                } else {
                    itemsOnPage++;
                }
            }
            continue;
        }

        // 6. Code Block (<pre>): Split lines cleanly at newline boundaries
        if (tag === 'pre') {
            const clone = node.cloneNode(true);
            cur.contentEl.appendChild(clone);
            if (fits(cur.contentEl)) {
                continue;
            }
            cur.contentEl.removeChild(clone);

            const codeEl = node.querySelector('code') || node;
            const fullText = codeEl.textContent || '';
            const lines = fullText.split('\n');

            let curPre = document.createElement('pre');
            curPre.className = node.className;
            curPre.style.cssText = node.style.cssText;
            let curCode = document.createElement('code');
            curCode.className = codeEl.className;
            curCode.style.cssText = codeEl.style.cssText;
            curPre.appendChild(curCode);
            cur.contentEl.appendChild(curPre);

            let linesOnPage = 0;
            let curLines = [];

            for (let l = 0; l < lines.length; l++) {
                const line = lines[l];
                curLines.push(line);
                curCode.textContent = curLines.join('\n');

                if (!fits(cur.contentEl)) {
                    if (linesOnPage > 0) {
                        curLines.pop();
                        curCode.textContent = curLines.join('\n');
                        nextPage();

                        curPre = document.createElement('pre');
                        curPre.className = node.className;
                        curPre.style.cssText = node.style.cssText;
                        curCode = document.createElement('code');
                        curCode.className = codeEl.className;
                        curCode.style.cssText = codeEl.style.cssText;
                        curPre.appendChild(curCode);
                        cur.contentEl.appendChild(curPre);

                        curLines = [line];
                        curCode.textContent = line;
                        linesOnPage = 1;
                    } else {
                        if (cur.contentEl.childNodes.length > 1) {
                            cur.contentEl.removeChild(curPre);
                            nextPage();

                            curPre = document.createElement('pre');
                            curPre.className = node.className;
                            curPre.style.cssText = node.style.cssText;
                            curCode = document.createElement('code');
                            curCode.className = codeEl.className;
                            curCode.style.cssText = codeEl.style.cssText;
                            curPre.appendChild(curCode);
                            cur.contentEl.appendChild(curPre);

                            curLines = [line];
                            curCode.textContent = line;
                            linesOnPage = 1;
                        } else {
                            linesOnPage = 1;
                        }
                    }
                } else {
                    linesOnPage++;
                }
            }
            continue;
        }

        // 7. General Paragraph & Block Splitting
        addBlock(node);
    }

    function addBlock(node) {
        const clone = node.cloneNode(true);
        cur.contentEl.appendChild(clone);
        if (fits(cur.contentEl)) {
            return;
        }
        cur.contentEl.removeChild(clone);

        const rem = maxH - cur.contentEl.scrollHeight;
        if (rem < 45 && cur.contentEl.childNodes.length > 0) {
            nextPage();
            const cloneNext = node.cloneNode(true);
            cur.contentEl.appendChild(cloneNext);
            if (fits(cur.contentEl)) return;
            cur.contentEl.removeChild(cloneNext);
        }

        paginateParagraphNode(node);
    }

    function paginateParagraphNode(node) {
        const childNodes = Array.from(node.childNodes);
        if (childNodes.length === 0) return;

        let curP = node.cloneNode(false);
        cur.contentEl.appendChild(curP);

        // Track ancestor formatting elements (e.g. <strong>, <em>, <span style="...">, etc.)
        const ancestorStack = [];

        function getCurrentTarget() {
            let target = curP;
            for (let i = 0; i < ancestorStack.length; i++) {
                const anc = ancestorStack[i];
                let last = target.lastChild;
                if (!last || last.nodeType !== 1 || (last.tagName || '').toLowerCase() !== (anc.tagName || '').toLowerCase()) {
                    const wrapClone = anc.cloneNode(false);
                    target.appendChild(wrapClone);
                    target = wrapClone;
                } else {
                    target = last;
                }
            }
            return target;
        }

        function processNode(child) {
            const isText = child.nodeType === 3 || (typeof Node !== 'undefined' && child.nodeType === Node?.TEXT_NODE) || child.tagName === '#TEXT';
            if (isText) {
                const words = (child.textContent || '').split(/(\s+)/);
                for (let w = 0; w < words.length; w++) {
                    const word = words[w];
                    if (!word) continue;

                    let target = getCurrentTarget();
                    const textNode = document.createTextNode(word);
                    target.appendChild(textNode);

                    if (!fits(cur.contentEl)) {
                        target.removeChild(textNode);

                        // Clean up any empty containers left on this page
                        let check = target;
                        while (check && check !== cur.contentEl && (!check.childNodes || check.childNodes.length === 0)) {
                            const p = check.parentNode;
                            if (p) p.removeChild(check);
                            check = p;
                        }

                        nextPage();

                        curP = node.cloneNode(false);
                        cur.contentEl.appendChild(curP);

                        // Rebuild ancestor chain on the new page
                        target = getCurrentTarget();
                        target.appendChild(textNode);
                    }
                }
                return;
            }

            const isElement = child.nodeType === 1 || (typeof Node !== 'undefined' && child.nodeType === Node?.ELEMENT_NODE);
            if (isElement) {
                const tag = (child.tagName || '').toLowerCase();
                if (tag === 'br' || tag === 'img') {
                    let target = getCurrentTarget();
                    const elClone = child.cloneNode(true);
                    target.appendChild(elClone);
                    if (!fits(cur.contentEl)) {
                        target.removeChild(elClone);
                        nextPage();
                        curP = node.cloneNode(false);
                        cur.contentEl.appendChild(curP);
                        target = getCurrentTarget();
                        target.appendChild(elClone);
                    }
                    return;
                }

                // Check if the entire formatting node fits cleanly
                let target = getCurrentTarget();
                const entireClone = child.cloneNode(true);
                target.appendChild(entireClone);
                if (fits(cur.contentEl)) {
                    return;
                }
                target.removeChild(entireClone);

                // Recurse into children, maintaining ancestorStack
                ancestorStack.push(child);
                const grandChildren = Array.from(child.childNodes);
                for (let g = 0; g < grandChildren.length; g++) {
                    processNode(grandChildren[g]);
                }
                ancestorStack.pop();
                return;
            }
        }

        for (let c = 0; c < childNodes.length; c++) {
            processNode(childNodes[c]);
        }
    }

    const finalPages = pages.filter(p => p.contentEl.childNodes.length > 0);
    const totalPages = Math.max(1, finalPages.length);
    finalPages.forEach((p, idx) => {
        const numEl = p.footerEl.querySelector('.pdf-page-num');
        if (numEl) numEl.textContent = `${idx + 1} / ${totalPages}`;
    });

    // NOTE: highlight extraction is deliberately NOT done here. It was previously
    // called here with all pages visible/stacked, which caused coordinate errors
    // for pages below the viewport. Instead, extractHighlightBoxes is called in
    // exportToPDF per-page, with only the target page visible at (0,0), ensuring
    // accurate getBoundingClientRect/getClientRects measurements.

    return {
        pages: finalPages.length ? finalPages : [pages[0]],
        cleanup: () => {
            if (sandbox.parentNode) sandbox.parentNode.removeChild(sandbox);
        }
    };
}

/* Direct Client-Side PDF Generation (Intelligent Multi-page DOM Flow & Direct Download / Share) */
export async function exportToPDF() {
    toast('Preparing document for PDF export...');
    const title = ($('word-doc-title')?.value) || 'Document';
    const filename = `${(title.trim() || 'Document')}.pdf`;

    let paginated = null;
    let origScrollX = typeof window !== 'undefined' ? (window.scrollX || window.pageXOffset || 0) : 0;
    let origScrollY = typeof window !== 'undefined' ? (window.scrollY || window.pageYOffset || 0) : 0;
    try {
        const rawHtml = getContentHtml();
        if (!rawHtml || !rawHtml.trim()) {
            toast('Document is empty', true);
            return;
        }

        // Check window globals first (CDN / bundler / mock), then dynamic imports with fallback
        let html2canvas = typeof window !== 'undefined' ? (window.html2canvas || null) : null;
        let jsPDF = typeof window !== 'undefined' ? (window.jsPDF || null) : null;

        if (!html2canvas) {
            try {
                const html2canvasMod = await import('html2canvas');
                html2canvas = html2canvasMod.default || html2canvasMod;
            } catch (e) {
                try {
                    const html2pdfMod = await import('html2pdf.js');
                    html2canvas = (html2pdfMod.default || html2pdfMod).html2canvas || (typeof window !== 'undefined' && window.html2canvas);
                } catch (_) {}
            }
        }

        if (!jsPDF) {
            try {
                const jsPdfMod = await import('jspdf');
                jsPDF = jsPdfMod.jsPDF || jsPdfMod.default?.jsPDF || (typeof jsPdfMod.default === 'function' ? jsPdfMod.default : jsPdfMod);
            } catch (e) {
                try {
                    const html2pdfMod = await import('html2pdf.js');
                    jsPDF = (html2pdfMod.default || html2pdfMod).jsPDF || (typeof window !== 'undefined' && window.jsPDF);
                } catch (_) {}
            }
        }

        if (!html2canvas || !jsPDF) {
            throw new Error('PDF export engines could not be loaded');
        }

        // Scroll to document origin BEFORE pagination and measurement to guarantee
        // that all getBoundingClientRect() and getClientRects() offsets are not biased by scroll.
        origScrollX = typeof window !== 'undefined' ? (window.scrollX || window.pageXOffset || 0) : 0;
        origScrollY = typeof window !== 'undefined' ? (window.scrollY || window.pageYOffset || 0) : 0;
        if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
            window.scrollTo(0, 0);
        }
        if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
            try { await document.fonts.ready; } catch (_) {}
        }

        const geometry = getExportGeometry();
        paginated = paginateDocument(rawHtml, geometry);
        const { pages } = paginated;

        if (!pages || pages.length === 0) {
            throw new Error('Pagination produced no pages');
        }

        const isLand = isLandscape;
        const pdf = new jsPDF({
            orientation: isLand ? 'landscape' : 'portrait',
            unit: 'mm',
            format: [geometry.pdfWidthMm, geometry.pdfHeightMm]
        });

        for (let i = 0; i < pages.length; i++) {
            const { pageEl, pageNum } = pages[i];
            toast(`Rendering PDF: Page ${pageNum} of ${pages.length}...`);

            // Only the sheet being rasterized may be laid out. The staging
            // sandbox is fixed at the document origin, so the visible sheet sits
            // exactly at (0,0) — which is where html2canvas crops.
            pages.forEach((p, k) => { p.pageEl.style.display = (k === i) ? 'flex' : 'none'; });

            // Delay to allow browser paint and toast updates
            await new Promise(resolve => setTimeout(resolve, 50));

            // Force reflow so getBoundingClientRect / getClientRects return
            // accurate coordinates after the display-mode switch above.
            // Without this, some browsers return stale layout data.
            void pageEl.offsetHeight;

            // Extract highlight boxes while pageEl is the sole visible element
            // at viewport origin (0, 0). This strips inline <mark> backgrounds
            // and returns their per-line bounding rects.
            const contentEl = pageEl.querySelector('.pdf-page-content') || pages[i].contentEl;
            const highlights = extractHighlightBoxes(pageEl, contentEl);

            // ── DOM-overlay approach (replaces canvas-painting) ──────────
            // Instead of painting highlight bands on the canvas AFTER rasterization
            // (which caused coordinate-mapping errors between getBoundingClientRect
            // and html2canvas's internal coordinate system), we inject them as
            // absolutely-positioned <div> overlays into the page DOM BEFORE
            // html2canvas runs. Since pageEl has position:relative, the overlays
            // sit at the correct coordinates. z-index:-1 places them behind
            // the content text but in front of the white page background.
            // html2canvas renders the full DOM tree—text AND overlays—in one
            // pass, guaranteeing correct relative positioning.
            const overlayEls = [];
            if (highlights && highlights.length > 0) {
                const padX = 2;   // px horizontal padding around text
                const padY = 2;   // px extra height below text for descender coverage
                const yShift = 7; // px downward shift — html2canvas renders text slightly
                                  // lower than getBoundingClientRect reports, so we nudge
                                  // the overlay down to match the rasterised baseline.
                highlights.forEach(b => {
                    if (!b || !b.color || !(b.w > 0.5) || !(b.h > 0.5)) return;
                    const overlay = document.createElement('div');
                    overlay.style.cssText = `
                        position: absolute;
                        left: ${Math.max(0, Math.round(b.x - padX))}px;
                        top: ${Math.max(0, Math.round(b.y + yShift))}px;
                        width: ${Math.round(b.w + padX * 2)}px;
                        height: ${Math.round(b.h + padY)}px;
                        background-color: ${b.color};
                        z-index: -1;
                        pointer-events: none;
                    `;
                    pageEl.appendChild(overlay);
                    overlayEls.push(overlay);
                });
                // Force reflow so html2canvas picks up the new overlay elements
                void pageEl.offsetHeight;
            }

            const canvas = await html2canvas(pageEl, {
                scale: 2,
                useCORS: true,
                allowTaint: true,
                logging: false,
                backgroundColor: '#ffffff',
                width: geometry.pageWidthPx,
                height: geometry.pageHeightPx,
                windowWidth: geometry.pageWidthPx,
                windowHeight: geometry.pageHeightPx,
                scrollX: 0,
                scrollY: 0,
                x: 0,
                y: 0
            });

            // Clean up overlay divs after html2canvas has captured them
            overlayEls.forEach(o => { if (o.parentNode) o.parentNode.removeChild(o); });

            if (i > 0) {
                pdf.addPage([geometry.pdfWidthMm, geometry.pdfHeightMm], isLand ? 'landscape' : 'portrait');
            }

            const imgData = canvas.toDataURL('image/png');
            pdf.addImage(imgData, 'PNG', 0, 0, geometry.pdfWidthMm, geometry.pdfHeightMm, undefined, 'FAST');

            // Free canvas memory immediately (vital for mobile memory)
            canvas.width = 1;
            canvas.height = 1;
        }

        const blob = pdf.output('blob');

        // Mobile Web Share API support
        const file = new File([blob], filename, { type: 'application/pdf' });
        if (typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({
                    files: [file],
                    title: title || 'Document',
                    text: 'PDF exported from Kivu Word'
                });
                toast('PDF shared successfully! 📄');
                return;
            } catch (shareErr) {
                if (shareErr.name !== 'AbortError') {
                    console.log('Mobile share fallback to download:', shareErr);
                }
            }
        }

        downloadBlob(blob, filename);
        toast('PDF exported successfully! 📄');

    } catch (err) {
        console.error('[word.js] PDF export failed:', err);
        toast('Error exporting PDF. Please try DOCX export.', true);
    } finally {
        if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
            window.scrollTo(origScrollX, origScrollY);
        }
        if (paginated && typeof paginated.cleanup === 'function') {
            paginated.cleanup();
        }
    }
}

/* DOCX export via html-to-docx */
async function exportToDOCX() {
    toast('Generating DOCX...');
    try {
        const mod = await import('html-to-docx');
        const HTMLtoDOCX = mod.default || mod;
        let rawHtml = getContentHtml();
        // Replace page break widgets with Word page breaks (div and hr variants)
        rawHtml = rawHtml.replace(
            /<div[^>]*data-type="page-break"[^>]*>[\s\S]*?<\/div>/gi,
            '<br style="page-break-before: always; clear: both;" />'
        );
        rawHtml = rawHtml.replace(
            /<hr[^>]*data-type="page-break"[^>]*\/?>/gi,
            '<br style="page-break-before: always; clear: both;" />'
        );
        const html = `<!DOCTYPE html><html><head><style>
            table { border-collapse: collapse; width: 100%; }
            td, th { border: 1px solid #000000; padding: 5px; }
        </style></head><body>${rawHtml}</body></html>`;
        // Convert margins from px to mm
        const PX_TO_MM = 25.4 / 96;
        const data = await HTMLtoDOCX(html, null, {
            table: { row: { cantSplit: true } },
            footer: true,
            pageNumber: true,
            orientation: isLandscape ? 'landscape' : 'portrait',
            margins: {
                top: Math.round((docMargins.top || 96) * PX_TO_MM),
                bottom: Math.round((docMargins.bottom || 96) * PX_TO_MM),
                left: Math.round((docMargins.left || 96) * PX_TO_MM),
                right: Math.round((docMargins.right || 96) * PX_TO_MM),
            },
        });
        const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        const title = ($('word-doc-title')?.value) || 'Document';
        const filename = `${(title.trim() || 'Document')}.docx`;

        // Mobile share support (matching PDF export behavior)
        const file = new File([blob], filename, { type: blob.type });
        if (typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file], title, text: 'DOCX exported from Kivu Word' });
                toast('DOCX shared successfully! 📄');
                return;
            } catch (shareErr) {
                if (shareErr.name !== 'AbortError') console.log('Mobile share fallback to download:', shareErr);
            }
        }

        downloadBlob(blob, filename);
        toast('DOCX exported successfully! 📄');
    } catch (e) {
        console.error('[word.js] DOCX export failed:', e);
        toast('Error exporting DOCX', true);
    }
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}