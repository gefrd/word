// src/modules/tools/scanner-ocr.js
// Text recognition, loaded only when the user asks for it.
//
// Size is the whole design constraint: the WASM core is ~4 MB and each language
// adds 2-3 MB more. Bundling that into a PWA would triple the first load for a
// feature most people never touch, so nothing here is imported until the OCR
// button is pressed — and the user is told the size before the download starts.

const TESSERACT_VERSION_NOTE = 'tesseract.js v5';

// Languages with a traineddata file that is actually good. Kinyarwanda has no
// Tesseract model at all, so it is deliberately absent instead of silently
// falling back to English and producing nonsense.
export const OCR_LANGUAGES = [
    { code: 'eng',     label: 'English',            size: '~2 MB' },
    { code: 'fra',     label: 'French',             size: '~2 MB' },
    { code: 'swa',     label: 'Swahili',            size: '~2 MB' },
    { code: 'rus',     label: 'Russian',            size: '~2 MB' },
    { code: 'spa',     label: 'Spanish',            size: '~2 MB' },
    { code: 'deu',     label: 'German',             size: '~2 MB' },
    { code: 'por',     label: 'Portuguese',         size: '~2 MB' },
    { code: 'ara',     label: 'Arabic',             size: '~3 MB' },
    { code: 'chi_sim', label: 'Chinese (simplified)', size: '~4 MB' }
];

const LANG_STORAGE_KEY = 'kivu_scanner_ocr_lang';
const DOWNLOADED_KEY = 'kivu_scanner_ocr_downloaded';

let tesseractPromise = null;
let workerPromise = null;
let workerLang = null;

/* ------------------------------------------------------------------ */
/* Preferences                                                         */
/* ------------------------------------------------------------------ */

export function getPreferredLanguage() {
    try {
        const saved = localStorage.getItem(LANG_STORAGE_KEY);
        if (saved && OCR_LANGUAGES.some((l) => l.code === saved)) return saved;
        // Guess once from the browser locale, then let the user's choice win.
        const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
        const guess = { en: 'eng', fr: 'fra', sw: 'swa', ru: 'rus', es: 'spa', de: 'deu', pt: 'por', ar: 'ara', zh: 'chi_sim' }[nav];
        return guess || 'eng';
    } catch (_) {
        return 'eng';
    }
}

export function setPreferredLanguage(code) {
    try { localStorage.setItem(LANG_STORAGE_KEY, code); } catch (_) {}
}

// Which languages have already been fetched, so the UI can say "ready" instead of
// warning about a download that will actually come from cache.
function getDownloadedLanguages() {
    try {
        const raw = localStorage.getItem(DOWNLOADED_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
}

function markDownloaded(code) {
    const list = getDownloadedLanguages();
    if (!list.includes(code)) {
        list.push(code);
        try { localStorage.setItem(DOWNLOADED_KEY, JSON.stringify(list)); } catch (_) {}
    }
}

export function isLanguageReady(code) {
    return getDownloadedLanguages().includes(code);
}

export function describeDownload(code) {
    const lang = OCR_LANGUAGES.find((l) => l.code === code) || OCR_LANGUAGES[0];
    if (isLanguageReady(code)) return { needsDownload: false, text: `${lang.label} is ready to use offline.` };
    const engineDownloaded = getDownloadedLanguages().length > 0;
    const total = engineDownloaded ? lang.size : `~6 MB (engine + ${lang.label})`;
    return {
        needsDownload: true,
        text: `Recognising ${lang.label} needs a one-time download of ${total}. After that it works offline.`
    };
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

function loadTesseract() {
    if (!tesseractPromise) {
        tesseractPromise = import('tesseract.js').catch((err) => {
            tesseractPromise = null;
            throw new Error('Text recognition could not be loaded. Check your connection. (' + (err.message || err) + ')');
        });
    }
    return tesseractPromise;
}

/**
 * One worker is kept alive between pages — spinning it up costs 1-2 seconds, and
 * batch-recognising a 10-page document would otherwise pay that ten times.
 * Switching language tears the old one down first, since a worker is bound to
 * the language it was created with.
 */
async function getWorker(lang, onProgress) {
    if (workerPromise && workerLang === lang) return workerPromise;
    if (workerPromise) await terminateOcr();

    const { createWorker } = await loadTesseract();
    workerLang = lang;
    workerPromise = createWorker(lang, 1, {
        logger: (m) => {
            if (!onProgress) return;
            // Tesseract reports several phases; only two are worth showing.
            if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') {
                onProgress({ phase: 'engine', progress: m.progress || 0, label: 'Loading engine…' });
            } else if (m.status === 'loading language traineddata' || m.status === 'initializing api') {
                onProgress({ phase: 'language', progress: m.progress || 0, label: 'Loading language…' });
            } else if (m.status === 'recognizing text') {
                onProgress({ phase: 'recognize', progress: m.progress || 0, label: 'Reading text…' });
            }
        }
    }).then((worker) => {
        markDownloaded(lang);
        return worker;
    }).catch((err) => {
        workerPromise = null;
        workerLang = null;
        throw err;
    });

    return workerPromise;
}

export async function terminateOcr() {
    if (!workerPromise) return;
    const pending = workerPromise;
    workerPromise = null;
    workerLang = null;
    try {
        const worker = await pending;
        await worker.terminate();
    } catch (_) {}
}

/**
 * Recognises one page.
 * @param {Blob} blob the PROCESSED page image — feed it the filtered version,
 *        because a clean high-contrast bitmap raises accuracy far more than any
 *        Tesseract setting does.
 * @returns {Promise<{text: string, confidence: number, words: number}>}
 */
export async function recognizeBlob(blob, lang = getPreferredLanguage(), onProgress = null) {
    const worker = await getWorker(lang, onProgress);
    const { data } = await worker.recognize(blob);
    const text = (data && data.text ? data.text : '').replace(/\n{3,}/g, '\n\n').trim();
    return {
        text,
        confidence: data && typeof data.confidence === 'number' ? Math.round(data.confidence) : 0,
        words: text ? text.split(/\s+/).length : 0
    };
}

/**
 * Recognises several pages in order, reporting page-level progress.
 * @param {Array<{id: string, blob: Blob}>} pages
 */
export async function recognizePages(pages, lang = getPreferredLanguage(), onProgress = null) {
    const results = [];
    for (let i = 0; i < pages.length; i++) {
        if (onProgress) onProgress({ phase: 'page', page: i + 1, total: pages.length, progress: i / pages.length, label: `Page ${i + 1} of ${pages.length}…` });
        try {
            const res = await recognizeBlob(pages[i].blob, lang, onProgress);
            results.push({ id: pages[i].id, ...res });
        } catch (err) {
            // One unreadable page must not throw away the text from the rest.
            results.push({ id: pages[i].id, text: '', confidence: 0, words: 0, error: (err && err.message) || String(err) });
        }
    }
    return results;
}

/* ------------------------------------------------------------------ */
/* Hand-off to the Kivu Word editor                                    */
/* ------------------------------------------------------------------ */

// Plain text to Tiptap's document JSON. Blank lines become paragraph breaks;
// a single newline inside a paragraph is a hard break, which is what OCR output
// of a wrapped line actually means.
export function textToTiptapDoc(text) {
    const blocks = String(text || '').split(/\n\s*\n/);
    const content = blocks.map((block) => {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        if (!lines.length) return { type: 'paragraph' };
        const inline = [];
        lines.forEach((line, idx) => {
            if (idx > 0) inline.push({ type: 'hardBreak' });
            inline.push({ type: 'text', text: line });
        });
        return { type: 'paragraph', content: inline };
    }).filter(Boolean);

    return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

const DOCS_INDEX_KEY = 'kivu_docs_index';

// Reuses the page setup of an existing Word document instead of inventing layout
// field names this module has no business knowing.
function borrowWordLayout() {
    try {
        const index = JSON.parse(localStorage.getItem(DOCS_INDEX_KEY) || '[]');
        for (const entry of index) {
            if (!entry || entry.type !== 'word') continue;
            const raw = localStorage.getItem('kivu_doc_' + entry.id);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            if (parsed && parsed.layout) return parsed.layout;
        }
    } catch (_) {}
    return null;
}

/**
 * Creates a Word document from recognised text and returns its id, so the caller
 * can call the Word editor's openWordEditor(docId).
 * Text is small, so it stays in localStorage where word.js expects to find it.
 */
export function createWordDocumentFromText(title, text) {
    const docId = 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const payload = { content: textToTiptapDoc(text) };
    const layout = borrowWordLayout();
    if (layout) payload.layout = layout;

    try {
        localStorage.setItem('kivu_doc_' + docId, JSON.stringify(payload));
    } catch (err) {
        throw new Error('Not enough space to save the text document. Free up some space and try again.');
    }

    try {
        const index = JSON.parse(localStorage.getItem(DOCS_INDEX_KEY) || '[]');
        index.push({
            id: docId,
            title: (title ? title + ' (text)' : 'Scanned text'),
            type: 'word',
            updatedAt: Date.now()
        });
        localStorage.setItem(DOCS_INDEX_KEY, JSON.stringify(index));
    } catch (err) {
        localStorage.removeItem('kivu_doc_' + docId);
        throw new Error('Could not add the document to your list.');
    }

    if (typeof window !== 'undefined' && typeof window.renderMyDocuments === 'function') {
        try { window.renderMyDocuments(); } catch (_) {}
    }
    return docId;
}

export function downloadText(text, filename = 'scan.txt') {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 4000);
}

export { TESSERACT_VERSION_NOTE };
