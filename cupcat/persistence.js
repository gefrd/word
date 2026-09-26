// cupcat/persistence.js — IndexedDB + localStorage project storage
// Depends on: state, constants, utils

import { state } from './state.js';
import { CANVAS_ASPECTS } from './constants.js';
import { createEmojiDataUrl } from './tools/stickers.js';

const DB_NAME = 'kivu_cupcat_db';
const STORE_NAME = 'cupcat_docs';

export function getDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function saveFilesToIDB(id, clips, audioTracks) {
    try {
        const db = await getDB();
        const data = {
            id,
            clips: clips.map(c => c.file),
            audioTracks: audioTracks.map(a => a.file),
            overlays: state.overlayTracks.map(o => o.file)
        };
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.put(data);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.error('Failed to save files to IDB:', e);
    }
}

export async function getFilesFromIDB(id) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        console.error('Failed to load files from IDB:', e);
        return null;
    }
}

export async function loadDocument() {
    const data = localStorage.getItem('kivu_doc_' + state.currentDocId);
    if (data) {
        try {
            const parsed = JSON.parse(data);
            state.videoClips = (parsed.clips || []).map(c => ({
                volume: 1,
                muted: false,
                speed: 1,
                fadeIn: 0,
                fadeOut: 0,
                isImage: false,
                kenBurns: 'none',
                rotation: 0,
                flipH: false,
                flipV: false,
                ...c,
                filters: c.filters ? { preset: 'none', brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0, ...c.filters } : { preset: 'none', brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0 },
                file: null,
                objectUrl: null
            }));
            state.audioTracks = (parsed.audioTracks || []).map(a => ({ volume: 1, muted: false, speed: 1, fadeIn: 0, fadeOut: 0, ...a, file: null, objectUrl: null }));
            state.textOverlays = (parsed.textOverlays || []).map(t => ({ ...t }));
            state.subtitleTracks = (parsed.subtitleTracks || []).map(s => ({ ...s }));
            state.overlayTracks = (parsed.overlayTracks || []).map(o => ({
                posX: 50, posY: 50, posPreset: 'center', scale: 30, opacity: 100,
                ...o,
                file: null,
                objectUrl: null
            }));
            state.docTitle = parsed.title || 'Video Project';
            state.canvasAspect = CANVAS_ASPECTS[parsed.canvasAspect] ? parsed.canvasAspect : '16:9';
            
            // Load files from IDB
            const filesData = await getFilesFromIDB(state.currentDocId);
            if (filesData) {
                if (filesData.clips) {
                    for (let i = 0; i < state.videoClips.length; i++) {
                        if (filesData.clips[i]) {
                            state.videoClips[i].file = filesData.clips[i];
                            state.videoClips[i].objectUrl = URL.createObjectURL(filesData.clips[i]);
                        }
                    }
                }
                if (filesData.audioTracks) {
                    for (let i = 0; i < state.audioTracks.length; i++) {
                        if (filesData.audioTracks[i]) {
                            state.audioTracks[i].file = filesData.audioTracks[i];
                            state.audioTracks[i].objectUrl = URL.createObjectURL(filesData.audioTracks[i]);
                        }
                    }
                }
                if (filesData.overlays) {
                    for (let i = 0; i < state.overlayTracks.length; i++) {
                        if (filesData.overlays[i]) {
                            state.overlayTracks[i].file = filesData.overlays[i];
                            state.overlayTracks[i].objectUrl = URL.createObjectURL(filesData.overlays[i]);
                        }
                    }
                }
            }

            // Restore sticker objectUrls for sticker overlays
            state.overlayTracks.forEach(o => {
                if (o.isSticker && (o.emoji || o.stickerEmoji) && !o.objectUrl) {
                    o.objectUrl = createEmojiDataUrl(o.emoji || o.stickerEmoji);
                }
            });
        } catch (e) {
            console.error(e);
        }
    }
}

export async function saveDocument() {
    const data = {
        id: state.currentDocId,
        title: state.docTitle,
        type: 'cupcat',
        canvasAspect: state.canvasAspect,
        clips: state.videoClips.map(c => ({ ...c, file: null, objectUrl: null })),
        audioTracks: state.audioTracks.map(a => ({ ...a, file: null, objectUrl: null })),
        textOverlays: state.textOverlays.map(t => ({ ...t })),
        subtitleTracks: state.subtitleTracks.map(s => ({ ...s })),
        overlayTracks: state.overlayTracks.map(o => ({ ...o, file: null, objectUrl: null })),
        updatedAt: Date.now()
    };
    localStorage.setItem('kivu_doc_' + state.currentDocId, JSON.stringify(data));

    const idx = localStorage.getItem('kivu_docs_index');
    let docs = idx ? JSON.parse(idx) : [];
    const existing = docs.findIndex(d => d.id === state.currentDocId);
    if (existing >= 0) {
        docs[existing].updatedAt = data.updatedAt;
        docs[existing].title = data.title;
    } else {
        docs.push({ id: state.currentDocId, type: 'cupcat', title: data.title, updatedAt: data.updatedAt });
    }
    localStorage.setItem('kivu_docs_index', JSON.stringify(docs));
    
    // Save files to IDB
    await saveFilesToIDB(state.currentDocId, state.videoClips, state.audioTracks);

    if (window.renderMyDocuments) window.renderMyDocuments();
}
