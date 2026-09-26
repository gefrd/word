// cupcat/history.js — Undo/Redo logic
// Depends on: state, constants
// Late-bound dependencies (set via setHistoryCallbacks): renderTimeline, updateEmptyState,
// updatePreview, updateCanvasBox, updateKeyframeDiamondButton, saveDocument

import { state } from './state.js';
import { MAX_HISTORY } from './constants.js';

// Late-binding callbacks to avoid circular dependencies
let _callbacks = {
    renderTimeline: null,
    updateEmptyState: null,
    updatePreview: null,
    updateCanvasBox: null,
    updateKeyframeDiamondButton: null,
    saveDocument: null,
};

export function setHistoryCallbacks(cbs) {
    Object.assign(_callbacks, cbs);
}

export function snapshotState() {
    return {
        videoClips: state.videoClips.map(c => {
            const { _audioEl, ...rest } = c;
            return {
                ...rest,
                rotation: c.rotation || 0,
                flipH: !!c.flipH,
                flipV: !!c.flipV,
                filters: c.filters ? { ...c.filters } : { preset: 'none', brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0 },
                keyframes: (c.keyframes || []).map(k => ({ ...k }))
            };
        }),
        audioTracks: state.audioTracks.map(a => {
            const { _audioEl, ...rest } = a;
            return { ...rest };
        }),
        textOverlays: state.textOverlays.map(t => ({
            ...t,
            keyframes: (t.keyframes || []).map(k => ({ ...k }))
        })),
        overlayTracks: (state.overlayTracks || []).map(o => {
            const { _videoEl, _previewEl, ...rest } = o;
            return {
                ...rest,
                keyframes: (o.keyframes || []).map(k => ({ ...k }))
            };
        }),
        subtitleTracks: (state.subtitleTracks || []).map(s => ({
            ...s,
            keyframes: (s.keyframes || []).map(k => ({ ...k }))
        })),
        canvasAspect: state.canvasAspect,
    };
}

export function restoreState(snapshot) {
    const existingOverlaysMap = new Map();
    state.overlayTracks.forEach(o => {
        if (o.id && (o.file || o.objectUrl)) {
            existingOverlaysMap.set(o.id, { file: o.file, objectUrl: o.objectUrl });
        }
    });

    const existingClipsMap = new Map();
    state.videoClips.forEach(c => {
        if (c.id && (c.file || c.objectUrl)) {
            existingClipsMap.set(c.id, { file: c.file, objectUrl: c.objectUrl });
        }
    });

    const existingAudioMap = new Map();
    state.audioTracks.forEach(a => {
        if (a.id && (a.file || a.objectUrl)) {
            existingAudioMap.set(a.id, { file: a.file, objectUrl: a.objectUrl });
        }
    });

    state.videoClips = snapshot.videoClips.map(c => {
        const exist = existingClipsMap.get(c.id) || {};
        return {
            ...c,
            file: c.file || exist.file || null,
            objectUrl: c.objectUrl || exist.objectUrl || null,
            rotation: c.rotation || 0,
            flipH: !!c.flipH,
            flipV: !!c.flipV,
            filters: c.filters ? { ...c.filters } : { preset: 'none', brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0 },
            keyframes: (c.keyframes || []).map(k => ({ ...k }))
        };
    });

    state.audioTracks = snapshot.audioTracks.map(a => {
        const exist = existingAudioMap.get(a.id) || {};
        return {
            ...a,
            file: a.file || exist.file || null,
            objectUrl: a.objectUrl || exist.objectUrl || null
        };
    });

    state.textOverlays = snapshot.textOverlays.map(t => ({
        ...t,
        keyframes: (t.keyframes || []).map(k => ({ ...k }))
    }));

    state.overlayTracks = (snapshot.overlayTracks || []).map(o => {
        const exist = existingOverlaysMap.get(o.id) || {};
        return {
            ...o,
            file: o.file || exist.file || null,
            objectUrl: o.objectUrl || exist.objectUrl || null,
            keyframes: (o.keyframes || []).map(k => ({ ...k }))
        };
    });

    state.subtitleTracks = (snapshot.subtitleTracks || []).map(s => ({
        ...s,
        keyframes: (s.keyframes || []).map(k => ({ ...k }))
    }));

    state.canvasAspect = snapshot.canvasAspect;
    state.selectedClipId = null;
    state.selectedAudioId = null;
    state.selectedTextId = null;
    state.selectedOverlayId = null;
    state.selectedSubtitleId = null;
}

export function pushHistory() {
    state.undoStack.push(snapshotState());
    if (state.undoStack.length > MAX_HISTORY) state.undoStack.shift();
    state.redoStack = [];
    updateUndoRedoButtons();
}

export function undo() {
    if (state.undoStack.length === 0) return;
    // Use stopPlaybackSafe from utils via late binding to avoid circular dep
    state.isPlaying = false;
    if (state.playInterval) {
        cancelAnimationFrame(state.playInterval);
        state.playInterval = null;
    }
    state.audioTracks.forEach(a => {
        if (a._audioEl) { a._audioEl.pause(); a._audioEl = null; }
    });
    state.redoStack.push(snapshotState());
    restoreState(state.undoStack.pop());
    afterHistoryRestore();
    if (window.showToast) window.showToast('↩ Undone', false);
}

export function redo() {
    if (state.redoStack.length === 0) return;
    state.isPlaying = false;
    if (state.playInterval) {
        cancelAnimationFrame(state.playInterval);
        state.playInterval = null;
    }
    state.audioTracks.forEach(a => {
        if (a._audioEl) { a._audioEl.pause(); a._audioEl = null; }
    });
    state.undoStack.push(snapshotState());
    restoreState(state.redoStack.pop());
    afterHistoryRestore();
    if (window.showToast) window.showToast('↪ Redone', false);
}

export function afterHistoryRestore() {
    if (_callbacks.renderTimeline) _callbacks.renderTimeline();
    if (_callbacks.updateEmptyState) _callbacks.updateEmptyState();
    if (_callbacks.updatePreview) _callbacks.updatePreview();
    if (_callbacks.updateCanvasBox) _callbacks.updateCanvasBox();
    if (_callbacks.updateKeyframeDiamondButton) _callbacks.updateKeyframeDiamondButton();
    const ratioLabel = document.getElementById('cupcat-ratio-btn-label');
    if (ratioLabel) ratioLabel.textContent = state.canvasAspect;
    if (_callbacks.saveDocument) _callbacks.saveDocument();
    updateUndoRedoButtons();
}

export function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('cupcat-undo-btn');
    const redoBtn = document.getElementById('cupcat-redo-btn');
    if (undoBtn) {
        undoBtn.style.opacity = state.undoStack.length > 0 ? '1' : '0.3';
        undoBtn.style.pointerEvents = state.undoStack.length > 0 ? 'auto' : 'none';
    }
    if (redoBtn) {
        redoBtn.style.opacity = state.redoStack.length > 0 ? '1' : '0.3';
        redoBtn.style.pointerEvents = state.redoStack.length > 0 ? 'auto' : 'none';
    }
}
