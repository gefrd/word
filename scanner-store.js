// src/modules/tools/scanner-store.js
// Storage layer for the Kivu Pro Scanner.
//
// Design decisions (see PLAN.md):
//  - Image bytes live in IndexedDB as Blobs. localStorage only ever holds the
//    lightweight document index (`kivu_docs_index`), because the host app's
//    renderMyDocuments() only reads title/type/updatedAt.
//  - Every page keeps its ORIGINAL capture plus the parameters used to derive
//    the processed result, so corners/filters stay editable forever.
//  - The processed result is cached lazily; it can always be recomputed.
//  - When the origin runs out of space we drop originals of the oldest
//    documents first (processed pages survive).

const DB_NAME = 'kivu_scanner';
const DB_VERSION = 1;
const STORE_DOCS = 'docs';
const STORE_BLOBS = 'blobs';

export const DOCS_INDEX_KEY = 'kivu_docs_index';
export const LEGACY_DOC_PREFIX = 'kivu_doc_';
const MIGRATION_FLAG = 'kivu_scanner_migrated_v1';

let dbPromise = null;

/* ------------------------------------------------------------------ */
/* Low-level IndexedDB helpers (no external dependency)               */
/* ------------------------------------------------------------------ */

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB unavailable'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_DOCS)) {
                db.createObjectStore(STORE_DOCS, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORE_BLOBS)) {
                db.createObjectStore(STORE_BLOBS);
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            // If another tab upgrades the schema, drop our handle so the next
            // call reopens cleanly instead of throwing InvalidStateError.
            db.onversionchange = () => { try { db.close(); } catch (_) {} dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    }).catch((err) => {
        dbPromise = null;
        throw err;
    });
    return dbPromise;
}

function tx(store, mode, fn) {
    return openDB().then((db) => new Promise((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const objectStore = transaction.objectStore(store);
        let result;
        try {
            result = fn(objectStore);
        } catch (err) {
            reject(err);
            return;
        }
        transaction.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
    }));
}

function wrap(req) { return { __req: req }; }

/* ------------------------------------------------------------------ */
/* Blob storage                                                        */
/* ------------------------------------------------------------------ */

// kind: 'orig' | 'out' | 'thumb'
export function blobKey(docId, pageId, kind) {
    return `${docId}/${pageId}/${kind}`;
}

export function putBlob(docId, pageId, kind, blob) {
    return tx(STORE_BLOBS, 'readwrite', (s) => wrap(s.put(blob, blobKey(docId, pageId, kind))));
}

export function getBlob(docId, pageId, kind) {
    return tx(STORE_BLOBS, 'readonly', (s) => wrap(s.get(blobKey(docId, pageId, kind))))
        .then((v) => v || null)
        .catch(() => null);
}

export function deleteBlob(docId, pageId, kind) {
    return tx(STORE_BLOBS, 'readwrite', (s) => wrap(s.delete(blobKey(docId, pageId, kind))))
        .catch(() => null);
}

// Removes every blob belonging to a page (all three kinds).
export function deletePageBlobs(docId, pageId) {
    return Promise.all(['orig', 'out', 'thumb'].map((k) => deleteBlob(docId, pageId, k)));
}

/* ------------------------------------------------------------------ */
/* Document records                                                    */
/* ------------------------------------------------------------------ */

export function createEmptyDoc(docId, mode = 'document') {
    return {
        id: docId || ('doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
        title: 'Scanned Document',
        type: 'scanner',
        mode,                 // 'document' | 'id-card' | 'photo'
        pages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
}

// A page never stores pixels — only the recipe to rebuild them.
export function createPage(pageId, srcWidth, srcHeight, corners, filter = 'magic') {
    return {
        id: pageId,
        srcWidth,
        srcHeight,
        corners,              // [{x,y} x4] in ORIGINAL image pixel coordinates
        filter,               // 'original' | 'magic' | 'bw' | 'grayscale'
        rotation: 0,          // 0 | 90 | 180 | 270, applied after warp
        brightness: 0,        // -100..100
        contrast: 0,          // -100..100
        outWidth: 0,
        outHeight: 0,
        dirty: true,          // processed cache is stale
        text: null            // OCR result, if any
    };
}

export function saveDoc(doc) {
    doc.updatedAt = Date.now();
    return tx(STORE_DOCS, 'readwrite', (s) => wrap(s.put(doc)))
        .then(() => { syncIndexEntry(doc); return doc; })
        .catch((err) => {
            try {
                localStorage.setItem(LEGACY_DOC_PREFIX + doc.id, JSON.stringify(doc));
            } catch (_) {}
            syncIndexEntry(doc);
            return doc;
        });
}

export function loadDoc(docId) {
    if (!docId) return Promise.resolve(null);
    return tx(STORE_DOCS, 'readonly', (s) => wrap(s.get(docId)))
        .then((v) => v || null)
        .catch(() => {
            try {
                const raw = localStorage.getItem(LEGACY_DOC_PREFIX + docId);
                return raw ? JSON.parse(raw) : null;
            } catch (_) {
                return null;
            }
        });
}

export function listDocs() {
    return tx(STORE_DOCS, 'readonly', (s) => wrap(s.getAll()))
        .then((all) => (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)))
        .catch(() => []);
}

export async function deleteDoc(docId) {
    const doc = await loadDoc(docId);
    if (doc && Array.isArray(doc.pages)) {
        await Promise.all(doc.pages.map((p) => deletePageBlobs(docId, p.id)));
    }
    await tx(STORE_DOCS, 'readwrite', (s) => wrap(s.delete(docId))).catch(() => null);
    removeIndexEntry(docId);
}

/* ------------------------------------------------------------------ */
/* localStorage index (host app contract)                              */
/* ------------------------------------------------------------------ */

export function getDocsIndex() {
    try {
        const raw = localStorage.getItem(DOCS_INDEX_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error('[Scanner] docs index unreadable:', err);
        return [];
    }
}

function writeDocsIndex(index) {
    try {
        localStorage.setItem(DOCS_INDEX_KEY, JSON.stringify(index));
        return true;
    } catch (err) {
        console.warn('[Scanner] docs index write failed:', err);
        return false;
    }
}

// Keeps the shared index in sync WITHOUT ever writing image data into it.
function syncIndexEntry(doc) {
    const index = getDocsIndex();
    const entry = {
        id: doc.id,
        title: doc.title || 'Scanned Document',
        type: 'scanner',
        updatedAt: doc.updatedAt || Date.now(),
        pageCount: Array.isArray(doc.pages) ? doc.pages.length : 0
    };
    const at = index.findIndex((d) => d && d.id === doc.id);
    if (at === -1) index.push(entry); else index[at] = { ...index[at], ...entry };
    writeDocsIndex(index);
    if (typeof window !== 'undefined' && typeof window.renderMyDocuments === 'function') {
        try { window.renderMyDocuments(); } catch (_) {}
    }
}

function removeIndexEntry(docId) {
    writeDocsIndex(getDocsIndex().filter((d) => d && d.id !== docId));
    if (typeof window !== 'undefined' && typeof window.renderMyDocuments === 'function') {
        try { window.renderMyDocuments(); } catch (_) {}
    }
}

/* ------------------------------------------------------------------ */
/* Migration away from the old base64-in-localStorage format           */
/* ------------------------------------------------------------------ */

function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (comma === -1) return null;
    const meta = dataUrl.slice(0, comma);
    const isB64 = /;base64/i.test(meta);
    const mime = (meta.match(/^data:([^;,]+)/) || [, 'image/jpeg'])[1];
    const body = dataUrl.slice(comma + 1);
    try {
        if (!isB64) return new Blob([decodeURIComponent(body)], { type: mime });
        const bin = atob(body);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    } catch (err) {
        console.warn('[Scanner] could not decode legacy data URL:', err);
        return null;
    }
}

// Moves every legacy scan (imageData base64 in localStorage) into IndexedDB and
// frees the 5 MB quota it was squatting on — which also unblocks the Word editor.
// Word documents (type:'word') are left completely untouched.
export async function migrateLegacyScans() {
    if (typeof localStorage === 'undefined') return { moved: 0, freed: 0 };
    if (localStorage.getItem(MIGRATION_FLAG)) return { moved: 0, freed: 0 };

    let moved = 0;
    let freed = 0;
    const index = getDocsIndex();

    for (const entry of index) {
        if (!entry || entry.type !== 'scanner') continue;
        const key = LEGACY_DOC_PREFIX + entry.id;
        const raw = localStorage.getItem(key);
        if (!raw) continue;

        let payload;
        try { payload = JSON.parse(raw); } catch (_) { continue; }
        if (!payload || typeof payload.imageData !== 'string') continue;

        const blob = dataUrlToBlob(payload.imageData);
        if (!blob) continue;

        const pageId = 'p1';
        const doc = createEmptyDoc(entry.id, 'document');
        doc.title = payload.title || entry.title || 'Scanned Document';
        doc.updatedAt = payload.updatedAt || entry.updatedAt || Date.now();

        // Legacy scans were already cropped/filtered destructively, so the stored
        // bitmap is treated as the finished page. There is no original to recover.
        const page = createPage(pageId, 0, 0, null, payload.filter || 'original');
        page.dirty = false;
        page.legacy = true;
        doc.pages.push(page);

        try {
            await putBlob(entry.id, pageId, 'out', blob);
            await saveDoc(doc);
            freed += raw.length;
            localStorage.removeItem(key);
            moved++;
        } catch (err) {
            console.warn('[Scanner] migration failed for', entry.id, err);
        }
    }

    try { localStorage.setItem(MIGRATION_FLAG, String(Date.now())); } catch (_) {}
    if (moved) console.info(`[Scanner] migrated ${moved} legacy scan(s), freed ~${Math.round(freed / 1024)} KB of localStorage`);
    return { moved, freed };
}

/* ------------------------------------------------------------------ */
/* Quota handling                                                      */
/* ------------------------------------------------------------------ */

export async function getQuota() {
    try {
        if (navigator.storage && navigator.storage.estimate) {
            const { usage = 0, quota = 0 } = await navigator.storage.estimate();
            return { usage, quota, ratio: quota ? usage / quota : 0 };
        }
    } catch (_) {}
    return { usage: 0, quota: 0, ratio: 0 };
}

// Asking for persistence is what stops the browser from silently evicting
// scans when the device gets low on space. Safe to call on every open.
export async function requestPersistence() {
    try {
        if (navigator.storage && navigator.storage.persist && navigator.storage.persisted) {
            if (await navigator.storage.persisted()) return true;
            return await navigator.storage.persist();
        }
    } catch (_) {}
    return false;
}

// Frees space by discarding ORIGINAL captures of the oldest documents.
// Processed pages and thumbnails are kept, so nothing visible disappears —
// only the ability to re-adjust corners on very old scans is lost.
export async function reclaimSpace(keepDocId = null, targetBytes = 8 * 1024 * 1024) {
    const docs = (await listDocs()).filter((d) => d.id !== keepDocId).reverse(); // oldest first
    let reclaimed = 0;

    for (const doc of docs) {
        if (reclaimed >= targetBytes) break;
        if (!Array.isArray(doc.pages)) continue;
        let touched = false;

        for (const page of doc.pages) {
            if (page.originalDropped) continue;
            const orig = await getBlob(doc.id, page.id, 'orig');
            if (!orig) continue;
            // Only drop the original once a processed result exists to fall back on.
            const out = await getBlob(doc.id, page.id, 'out');
            if (!out) continue;
            await deleteBlob(doc.id, page.id, 'orig');
            page.originalDropped = true;
            reclaimed += orig.size || 0;
            touched = true;
            if (reclaimed >= targetBytes) break;
        }
        if (touched) await saveDoc(doc);
    }
    if (reclaimed) console.info(`[Scanner] reclaimed ~${Math.round(reclaimed / 1024)} KB by dropping old originals`);
    return reclaimed;
}

// Single entry point used by the UI: try the write, and on a quota failure make
// room and retry once before giving up.
export async function safeWrite(fn, keepDocId = null) {
    try {
        return await fn();
    } catch (err) {
        const quotaish = err && (err.name === 'QuotaExceededError' || err.code === 22 ||
            /quota/i.test(err.message || ''));
        if (!quotaish) throw err;
        await reclaimSpace(keepDocId);
        return await fn();
    }
}

export async function initStore() {
    await requestPersistence();
    await migrateLegacyScans();
}
