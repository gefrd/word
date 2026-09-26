// cupcat/tools/subtitles.js — Advanced Subtitle & Caption Management System
// Supports interactive on-video editing, batch sync ("Apply to all"),
// CapCut-style presets, quick inspector drawer, SRT/VTT import/export.

import { state } from '../state.js';
import { generateId, getTotalDuration, getMaxTimelineDuration, formatTime } from '../utils.js';
import { pushHistory } from '../history.js';

let renderTimeline = () => {};
let updatePreview = () => {};
let updatePlayhead = () => {};
let saveDocument = () => {};
let updateKeyframeDiamondButton = () => {};
let updateImageSettingsButton = () => {};
let updateCanvasTransformBox = () => {};
let getInterpolatedKeyframe = () => ({});
let updatePreviewAtTime = () => {};

export function setSubtitleCallbacks(callbacks) {
    if (callbacks.renderTimeline) renderTimeline = callbacks.renderTimeline;
    if (callbacks.updatePreview) updatePreview = callbacks.updatePreview;
    if (callbacks.updatePlayhead) updatePlayhead = callbacks.updatePlayhead;
    if (callbacks.saveDocument) saveDocument = callbacks.saveDocument;
    if (callbacks.updateKeyframeDiamondButton) updateKeyframeDiamondButton = callbacks.updateKeyframeDiamondButton;
    if (callbacks.updateImageSettingsButton) updateImageSettingsButton = callbacks.updateImageSettingsButton;
    if (callbacks.updateCanvasTransformBox) updateCanvasTransformBox = callbacks.updateCanvasTransformBox;
    if (callbacks.getInterpolatedKeyframe) getInterpolatedKeyframe = callbacks.getInterpolatedKeyframe;
    if (callbacks.updatePreviewAtTime) updatePreviewAtTime = callbacks.updatePreviewAtTime;
}

// ============================================================
// PRESET STYLES (CapCut-inspired)
// ============================================================
export const SUBTITLE_PRESETS = {
    classic: {
        name: 'Classic',
        font: 'Inter',
        fontSize: 24,
        color: '#ffffff',
        bgColor: 'rgba(0, 0, 0, 0.75)',
        bgOpacity: 0.8,
        showBg: true,
        bgRadius: 8,
        bgPadding: 1,
        showStroke: false,
        strokeWidth: 0,
        strokeColor: '#000000',
        showShadow: false,
        shadowColor: 'rgba(0,0,0,0.8)',
        shadowBlur: 0,
        shadowOffsetY: 0,
        isBold: false,
        isItalic: false,
        isUppercase: false,
        textAlign: 'center',
        badgeBg: 'rgba(0,0,0,0.85)',
        badgeColor: '#ffffff'
    },
    tiktok: {
        name: 'TikTok / Reels',
        font: 'Montserrat',
        fontSize: 28,
        color: '#ffffff',
        bgColor: 'transparent',
        bgOpacity: 0,
        showBg: false,
        bgRadius: 0,
        bgPadding: 1,
        showStroke: true,
        strokeWidth: 4,
        strokeColor: '#000000',
        showShadow: true,
        shadowColor: 'rgba(0, 0, 0, 0.9)',
        shadowBlur: 8,
        shadowOffsetY: 3,
        isBold: true,
        isItalic: false,
        isUppercase: true,
        textAlign: 'center',
        badgeBg: '#000000',
        badgeColor: '#ffffff'
    },
    karaoke: {
        name: 'Karaoke (Yellow)',
        font: 'Montserrat',
        fontSize: 28,
        color: '#ffe600',
        bgColor: 'transparent',
        bgOpacity: 0,
        showBg: false,
        bgRadius: 0,
        bgPadding: 1,
        showStroke: true,
        strokeWidth: 4,
        strokeColor: '#000000',
        showShadow: true,
        shadowColor: 'rgba(0, 0, 0, 0.95)',
        shadowBlur: 6,
        shadowOffsetY: 2,
        isBold: true,
        isItalic: false,
        isUppercase: false,
        textAlign: 'center',
        badgeBg: '#ffe600',
        badgeColor: '#000000'
    },
    neon: {
        name: 'Neon (Cyber Glow)',
        font: 'Inter',
        fontSize: 26,
        color: '#ffffff',
        bgColor: 'rgba(20, 5, 35, 0.85)',
        bgOpacity: 0.85,
        showBg: true,
        bgRadius: 10,
        bgPadding: 1.1,
        showStroke: true,
        strokeWidth: 2,
        strokeColor: '#e040fb',
        showShadow: true,
        shadowColor: '#00e5ff',
        shadowBlur: 14,
        shadowOffsetY: 0,
        isBold: true,
        isItalic: false,
        isUppercase: false,
        textAlign: 'center',
        badgeBg: 'linear-gradient(135deg, #e040fb, #00e5ff)',
        badgeColor: '#ffffff'
    },
    minimal: {
        name: 'Minimal',
        font: 'Inter',
        fontSize: 22,
        color: '#ffffff',
        bgColor: 'transparent',
        bgOpacity: 0,
        showBg: false,
        bgRadius: 0,
        bgPadding: 1,
        showStroke: false,
        strokeWidth: 0,
        strokeColor: '#000000',
        showShadow: true,
        shadowColor: 'rgba(0, 0, 0, 0.85)',
        shadowBlur: 8,
        shadowOffsetY: 2,
        isBold: false,
        isItalic: false,
        isUppercase: false,
        textAlign: 'center',
        badgeBg: 'rgba(255,255,255,0.2)',
        badgeColor: '#ffffff'
    },
    red_pill: {
        name: 'Red Alert',
        font: 'Montserrat',
        fontSize: 24,
        color: '#ffffff',
        bgColor: '#ff1744',
        bgOpacity: 0.95,
        showBg: true,
        bgRadius: 14,
        bgPadding: 1.2,
        showStroke: false,
        strokeWidth: 0,
        strokeColor: '#000000',
        showShadow: true,
        shadowColor: 'rgba(0, 0, 0, 0.5)',
        shadowBlur: 6,
        shadowOffsetY: 2,
        isBold: true,
        isItalic: false,
        isUppercase: false,
        textAlign: 'center',
        badgeBg: '#ff1744',
        badgeColor: '#ffffff'
    },
    impact_bold: {
        name: 'Impact ALL-CAPS',
        font: 'Impact',
        fontSize: 32,
        color: '#ffffff',
        bgColor: 'transparent',
        bgOpacity: 0,
        showBg: false,
        bgRadius: 0,
        bgPadding: 1,
        showStroke: true,
        strokeWidth: 5,
        strokeColor: '#000000',
        showShadow: true,
        shadowColor: 'rgba(0, 0, 0, 0.95)',
        shadowBlur: 10,
        shadowOffsetY: 3,
        isBold: false,
        isItalic: false,
        isUppercase: true,
        textAlign: 'center',
        badgeBg: '#333333',
        badgeColor: '#ffffff'
    },
    cyber_yellow: {
        name: 'Cyber Yellow Block',
        font: 'Oswald',
        fontSize: 26,
        color: '#000000',
        bgColor: '#ffd600',
        bgOpacity: 1,
        showBg: true,
        bgRadius: 4,
        bgPadding: 0.9,
        showStroke: false,
        strokeWidth: 0,
        strokeColor: '#000000',
        showShadow: false,
        shadowColor: 'transparent',
        shadowBlur: 0,
        shadowOffsetY: 0,
        isBold: true,
        isItalic: false,
        isUppercase: true,
        textAlign: 'center',
        badgeBg: '#ffd600',
        badgeColor: '#000000'
    }
};

// ============================================================
// INSPECTOR & MODAL CONTROLS
// ============================================================

export function openSubtitleManager() {
    openSubtitleInspector(state.selectedSubtitleId, 'list');
}

export function closeSubtitleManager() {
    closeSubtitleInspector();
}

export function openSubtitleModal() {
    openSubtitleInspector(state.selectedSubtitleId, 'text');
}

export function closeSubtitleModal() {
    closeSubtitleInspector();
}

export function openSubtitleModalForEdit(id) {
    openSubtitleInspector(id, 'text');
}

export function applySubtitle() {
    closeSubtitleInspector();
}

export function updateSubPositionButtons() {}
export function updateBulkPreview() {}

export function openSubtitleInspector(subId = null, initialTab = null) {
    if (!state.subtitleTracks) state.subtitleTracks = [];

    // Determine which subtitle to select
    let targetSub = null;
    if (subId) {
        targetSub = state.subtitleTracks.find(s => s.id === subId);
    }
    if (!targetSub && state.selectedSubtitleId) {
        targetSub = state.subtitleTracks.find(s => s.id === state.selectedSubtitleId);
    }
    if (!targetSub && state.subtitleTracks.length > 0) {
        targetSub = state.subtitleTracks.find(s => state.playheadTime >= s.startTime && state.playheadTime <= s.endTime) || state.subtitleTracks[0];
    }

    if (targetSub) {
        state.selectedSubtitleId = targetSub.id;
        state.selectedClipId = null;
        state.selectedAudioId = null;
        state.selectedOverlayId = null;
        state.selectedTextId = null;
    } else {
        state.selectedSubtitleId = null;
    }

    if (initialTab) {
        state.subInspectorTab = initialTab;
    }

    const modal = document.getElementById('cupcat-sub-editor-modal') || document.getElementById('cupcat-sub-manager-modal');
    if (modal) {
        modal.style.display = 'flex';
    }

    renderSubtitleInspectorContent();
    renderTimeline();
    updateCanvasTransformBox();
}

export function closeSubtitleInspector() {
    const modal = document.getElementById('cupcat-sub-editor-modal') || document.getElementById('cupcat-sub-manager-modal');
    if (modal) {
        modal.style.display = 'none';
    }
    updateCanvasTransformBox();
}

export function switchSubtitleTab(tabName) {
    state.subInspectorTab = tabName;
    renderSubtitleInspectorContent();
}

export function selectSubtitle(subId, seekToTime = true) {
    const sub = (state.subtitleTracks || []).find(s => s.id === subId);
    if (!sub) return;

    state.selectedSubtitleId = sub.id;
    state.selectedClipId = null;
    state.selectedAudioId = null;
    state.selectedOverlayId = null;
    state.selectedTextId = null;

    if (seekToTime) {
        state.playheadTime = sub.startTime;
        updatePlayhead();
        updatePreviewAtTime(state.playheadTime);
    }

    renderTimeline();
    updateKeyframeDiamondButton();
    updateCanvasTransformBox();
    renderSubtitleInspectorContent();
    saveDocument();
}

export function selectPrevSubtitle() {
    if (!state.subtitleTracks || state.subtitleTracks.length === 0) return;
    const sorted = [...state.subtitleTracks].sort((a, b) => a.startTime - b.startTime);
    const currIdx = sorted.findIndex(s => s.id === state.selectedSubtitleId);
    if (currIdx > 0) {
        selectSubtitle(sorted[currIdx - 1].id, true);
    } else {
        selectSubtitle(sorted[sorted.length - 1].id, true); // wrap
    }
}

export function selectNextSubtitle() {
    if (!state.subtitleTracks || state.subtitleTracks.length === 0) return;
    const sorted = [...state.subtitleTracks].sort((a, b) => a.startTime - b.startTime);
    const currIdx = sorted.findIndex(s => s.id === state.selectedSubtitleId);
    if (currIdx >= 0 && currIdx < sorted.length - 1) {
        selectSubtitle(sorted[currIdx + 1].id, true);
    } else {
        selectSubtitle(sorted[0].id, true); // wrap
    }
}

// ============================================================
// SUBTITLE EDITING & TIMING OPERATIONS
// ============================================================

export function updateSubtitleText(id, newText) {
    if (!state.subtitleTracks) state.subtitleTracks = [];
    let sub = state.subtitleTracks.find(s => s.id === id);
    if (!sub) {
        if (state.subtitleTracks.length === 0) {
            addEmptySubtitle();
            sub = state.subtitleTracks.find(s => s.id === state.selectedSubtitleId);
        } else {
            sub = state.subtitleTracks[0];
            state.selectedSubtitleId = sub.id;
        }
    }
    if (!sub) return;

    sub.text = newText;
    renderTimeline();
    updatePreview();
    updateCanvasTransformBox();
    saveDocument();
}

export function adjustSubtitleTiming(id, field, delta) {
    const sub = (state.subtitleTracks || []).find(s => s.id === id);
    if (!sub) return;
    pushHistory();

    if (field === 'start') {
        sub.startTime = Math.max(0, Math.min(sub.endTime - 0.1, sub.startTime + delta));
    } else if (field === 'end') {
        sub.endTime = Math.max(sub.startTime + 0.1, sub.endTime + delta);
    }

    renderTimeline();
    updatePreview();
    renderSubtitleInspectorContent();
    saveDocument();
}

export function setSubtitleTimingToPlayhead(id, field) {
    const sub = (state.subtitleTracks || []).find(s => s.id === id);
    if (!sub) return;
    pushHistory();

    if (field === 'start') {
        sub.startTime = Math.max(0, Math.min(sub.endTime - 0.1, state.playheadTime));
    } else if (field === 'end') {
        sub.endTime = Math.max(sub.startTime + 0.1, state.playheadTime);
    }

    renderTimeline();
    updatePreview();
    renderSubtitleInspectorContent();
    saveDocument();
}

export function splitSubtitleAtPlayhead(id = state.selectedSubtitleId) {
    if (!id) return;
    const sub = (state.subtitleTracks || []).find(s => s.id === id);
    if (!sub) return;

    const splitTime = state.playheadTime;
    if (splitTime <= sub.startTime || splitTime >= sub.endTime) {
        if (window.showToast) window.showToast('Playhead must be inside subtitle to split', true);
        return;
    }

    pushHistory();

    const originalText = sub.text || '';
    const words = originalText.trim().split(/\s+/);
    let text1 = originalText;
    let text2 = '...';

    if (words.length > 1) {
        const mid = Math.ceil(words.length / 2);
        text1 = words.slice(0, mid).join(' ');
        text2 = words.slice(mid).join(' ');
    }

    const oldEnd = sub.endTime;
    sub.endTime = splitTime;
    sub.text = text1;

    const newSub = {
        ...sub,
        id: generateId(),
        text: text2,
        startTime: splitTime,
        endTime: oldEnd,
        keyframes: []
    };

    state.subtitleTracks.push(newSub);
    state.selectedSubtitleId = newSub.id;

    renderTimeline();
    updatePreview();
    renderSubtitleInspectorContent();
    updateCanvasTransformBox();
    saveDocument();
    if (window.showToast) window.showToast('Subtitle split successfully', false);
}

export function mergeSubtitleWithNext(id = state.selectedSubtitleId) {
    if (!id) return;
    const sorted = [...(state.subtitleTracks || [])].sort((a, b) => a.startTime - b.startTime);
    const currIdx = sorted.findIndex(s => s.id === id);
    if (currIdx < 0 || currIdx >= sorted.length - 1) {
        if (window.showToast) window.showToast('No next subtitle to merge with', true);
        return;
    }

    const current = sorted[currIdx];
    const next = sorted[currIdx + 1];

    pushHistory();
    current.text = `${current.text.trim()} ${next.text.trim()}`;
    current.endTime = next.endTime;

    state.subtitleTracks = state.subtitleTracks.filter(s => s.id !== next.id);

    renderTimeline();
    updatePreview();
    renderSubtitleInspectorContent();
    updateCanvasTransformBox();
    saveDocument();
    if (window.showToast) window.showToast('Subtitles merged', false);
}

export function splitSubtitleAtCursor(subId, caretPos) {
    if (!state.subtitleTracks || state.subtitleTracks.length === 0) return;
    const idx = state.subtitleTracks.findIndex(s => s.id === subId);
    if (idx === -1) return;

    const currentSub = state.subtitleTracks[idx];
    const fullText = currentSub.text || '';

    // Split text into before and after cursor
    const pos = Math.max(0, Math.min(fullText.length, caretPos !== undefined ? caretPos : Math.floor(fullText.length / 2)));
    const text1 = fullText.slice(0, pos).trim();
    const text2 = fullText.slice(pos).trim();

    if (!text1 && !text2) return;

    pushHistory();

    const totalDur = Math.max(0.4, currentSub.endTime - currentSub.startTime);
    const totalChars = (text1.length + text2.length) || 1;
    // Calculate proportional split duration (min 0.2s for each part)
    let ratio = (text1.length > 0 && text2.length > 0)
        ? Math.max(0.2, Math.min(0.8, text1.length / totalChars))
        : 0.5;

    const splitTime = currentSub.startTime + totalDur * ratio;

    // 1. Update current subtitle (first half)
    currentSub.text = text1 || fullText;
    const originalEndTime = currentSub.endTime;
    currentSub.endTime = splitTime;

    // 2. Create second subtitle (second half)
    const newId = generateId();
    const newSub = {
        ...currentSub,
        id: newId,
        text: text2 || '...',
        startTime: splitTime + 0.05,
        endTime: originalEndTime,
        keyframes: []
    };

    // Insert immediately after currentSub
    state.subtitleTracks.splice(idx + 1, 0, newSub);
    state.selectedSubtitleId = newId;

    renderTimeline();
    updatePreview();
    renderSubtitleInspectorContent();
    updateCanvasTransformBox();
    saveDocument();

    // Auto-focus the new subtitle row on screen
    setTimeout(() => {
        const newRowInput = document.querySelector(`[data-id="${newId}"] .cupcat-sub-row-text`);
        if (newRowInput) {
            newRowInput.focus();
            newRowInput.setSelectionRange(0, 0);
        }
    }, 50);

    if (window.showToast) window.showToast('Subtitle split (↵)', false);
}

export function mergeSubtitleWithPrevious(subId) {
    if (!state.subtitleTracks || state.subtitleTracks.length < 2) return;
    const sorted = [...state.subtitleTracks].sort((a, b) => a.startTime - b.startTime);
    const sortedIdx = sorted.findIndex(s => s.id === subId);
    if (sortedIdx <= 0) return; // Cannot merge the first subtitle

    const prevSub = sorted[sortedIdx - 1];
    const currSub = sorted[sortedIdx];

    pushHistory();

    const prevText = prevSub.text || '';
    const currText = currSub.text || '';
    const prevLen = prevText.length;

    // Merge texts cleanly with a space
    prevSub.text = prevText && currText ? `${prevText} ${currText}` : (prevText || currText);
    prevSub.endTime = Math.max(prevSub.endTime, currSub.endTime);

    // Remove currSub from timeline
    state.subtitleTracks = state.subtitleTracks.filter(s => s.id !== currSub.id);
    state.selectedSubtitleId = prevSub.id;

    renderTimeline();
    updatePreview();
    renderSubtitleInspectorContent();
    updateCanvasTransformBox();
    saveDocument();

    // Auto-focus previous subtitle with cursor placed at the merge boundary
    setTimeout(() => {
        const prevRowInput = document.querySelector(`[data-id="${prevSub.id}"] .cupcat-sub-row-text`);
        if (prevRowInput) {
            prevRowInput.focus();
            const caret = prevText && currText ? prevLen + 1 : prevLen;
            prevRowInput.setSelectionRange(caret, caret);
        }
    }, 50);

    if (window.showToast) window.showToast('Subtitles merged (⌫)', false);
}

export function duplicateSubtitle(id = state.selectedSubtitleId) {
    if (!id) return;
    const sub = (state.subtitleTracks || []).find(s => s.id === id);
    if (!sub) return;

    pushHistory();
    const dur = sub.endTime - sub.startTime;
    const newStart = sub.endTime + 0.1;
    const newSub = {
        ...sub,
        id: generateId(),
        startTime: newStart,
        endTime: newStart + dur,
        keyframes: []
    };

    state.subtitleTracks.push(newSub);
    state.selectedSubtitleId = newSub.id;

    renderTimeline();
    updatePreview();
    renderSubtitleInspectorContent();
    updateCanvasTransformBox();
    saveDocument();
    if (window.showToast) window.showToast('Subtitle duplicated', false);
}

export function deleteSubtitle(id = state.selectedSubtitleId) {
    if (!id) return;
    pushHistory();
    state.subtitleTracks = (state.subtitleTracks || []).filter(s => s.id !== id);

    if (state.subtitleTracks.length > 0) {
        state.selectedSubtitleId = state.subtitleTracks[0].id;
    } else {
        state.selectedSubtitleId = null;
    }

    renderTimeline();
    updatePreview();
    renderSubtitleInspectorContent();
    updateCanvasTransformBox();
    saveDocument();
    if (window.showToast) window.showToast('Subtitle deleted', false);
}

export function addEmptySubtitle(atTime = null) {
    pushHistory();
    if (!state.subtitleTracks) state.subtitleTracks = [];

    let startTime = atTime !== null ? atTime : state.playheadTime;
    if (startTime === 0 && state.subtitleTracks.length > 0) {
        startTime = Math.max(...state.subtitleTracks.map(s => s.endTime)) + 0.1;
    }

    // Default styles from first subtitle or classic preset
    const sample = state.subtitleTracks.length > 0 ? state.subtitleTracks[0] : SUBTITLE_PRESETS.classic;

    const newSub = {
        id: generateId(),
        text: 'New subtitle',
        startTime: startTime,
        endTime: startTime + 2.5,
        position: sample.position || 'bottom',
        color: sample.color || '#ffffff',
        bgColor: sample.bgColor || 'rgba(0, 0, 0, 0.75)',
        bgOpacity: sample.bgOpacity !== undefined ? sample.bgOpacity : 0.8,
        showBg: sample.showBg !== undefined ? sample.showBg : true,
        bgRadius: sample.bgRadius || 8,
        bgPadding: sample.bgPadding || 1,
        fontSize: sample.fontSize || 24,
        font: sample.font || 'Inter',
        isBold: !!sample.isBold,
        isItalic: !!sample.isItalic,
        isUppercase: !!sample.isUppercase,
        showStroke: !!sample.showStroke,
        strokeColor: sample.strokeColor || '#000000',
        strokeWidth: sample.strokeWidth || 0,
        showShadow: !!sample.showShadow,
        shadowColor: sample.shadowColor || 'rgba(0,0,0,0.8)',
        shadowBlur: sample.shadowBlur || 0,
        shadowOffsetY: sample.shadowOffsetY || 0,
        textAlign: sample.textAlign || 'center',
        posX: sample.posX !== undefined ? sample.posX : 50,
        posY: sample.posY !== undefined ? sample.posY : 88,
        scale: sample.scale || 100,
        opacity: sample.opacity || 100,
        rotation: sample.rotation || 0,
        keyframes: []
    };

    state.subtitleTracks.push(newSub);
    state.selectedSubtitleId = newSub.id;

    renderTimeline();
    updatePreview();
    renderSubtitleInspectorContent();
    updateCanvasTransformBox();
    saveDocument();
}

export function clearSubtitles() {
    if (state.subtitleTracks && state.subtitleTracks.length > 0) {
        if (!confirm('Clear ALL subtitles in this project?')) return;
    }
    pushHistory();
    state.subtitleTracks = [];
    state.selectedSubtitleId = null;
    renderTimeline();
    updatePreview();
    renderSubtitleInspectorContent();
    updateCanvasTransformBox();
    saveDocument();
    if (window.showToast) window.showToast('All subtitles cleared', false);
}

// ============================================================
// STYLING & SYNC LOGIC ("Apply to all" vs "Single")
// ============================================================

export function toggleSubApplyToAll(forceVal = null) {
    if (forceVal !== null) {
        state.subApplyToAll = forceVal;
    } else {
        state.subApplyToAll = !state.subApplyToAll;
    }

    renderSubtitleInspectorContent();
    updateCanvasTransformBox();

    const toastMsg = state.subApplyToAll
        ? 'Mode: Apply changes to ALL subtitles'
        : 'Mode: Editing CURRENT subtitle only';
    if (window.showToast) window.showToast(toastMsg, false);
}

export function applyStylePropToSubtitle(prop, value) {
    const curr = (state.subtitleTracks || []).find(s => s.id === state.selectedSubtitleId);
    if (!curr) return;

    pushHistory();

    const targets = state.subApplyToAll ? state.subtitleTracks : [curr];
    targets.forEach(sub => {
        sub[prop] = value;
        if (prop === 'fontFamily') sub.font = value;
        if (prop === 'font') sub.fontFamily = value;
        if (prop === 'hasBg') sub.showBg = value;
        if (prop === 'showBg') sub.hasBg = value;
        if (prop === 'hasStroke') sub.showStroke = value;
        if (prop === 'showStroke') sub.hasStroke = value;
        if (prop === 'hasShadow') sub.showShadow = value;
        if (prop === 'showShadow') sub.hasShadow = value;
    });

    renderTimeline();
    updatePreview();
    updateCanvasTransformBox();
    saveDocument();
}

export function applySubtitlePreset(presetKey) {
    const preset = SUBTITLE_PRESETS[presetKey];
    if (!preset) return;

    const curr = (state.subtitleTracks || []).find(s => s.id === state.selectedSubtitleId);
    if (!curr && state.subtitleTracks.length === 0) return;

    pushHistory();
    const targets = state.subApplyToAll ? state.subtitleTracks : (curr ? [curr] : state.subtitleTracks);

    targets.forEach(sub => {
        sub.font = preset.font;
        sub.fontSize = preset.fontSize;
        sub.color = preset.color;
        sub.bgColor = preset.bgColor;
        sub.bgOpacity = preset.bgOpacity;
        sub.showBg = preset.showBg;
        sub.bgRadius = preset.bgRadius;
        sub.bgPadding = preset.bgPadding;
        sub.showStroke = preset.showStroke;
        sub.strokeWidth = preset.strokeWidth;
        sub.strokeColor = preset.strokeColor;
        sub.showShadow = preset.showShadow;
        sub.shadowColor = preset.shadowColor;
        sub.shadowBlur = preset.shadowBlur;
        sub.shadowOffsetY = preset.shadowOffsetY;
        sub.isBold = preset.isBold;
        sub.isItalic = preset.isItalic;
        sub.isUppercase = preset.isUppercase;
        sub.textAlign = preset.textAlign;
    });

    renderTimeline();
    updatePreview();
    renderSubtitleInspectorContent();
    updateCanvasTransformBox();
    saveDocument();
    if (window.showToast) window.showToast(`Applied style: ${preset.name}`, false);
}

export function copyCurrentStyleToAll() {
    const curr = (state.subtitleTracks || []).find(s => s.id === state.selectedSubtitleId);
    if (!curr) return;

    pushHistory();
    state.subtitleTracks.forEach(sub => {
        if (sub.id !== curr.id) {
            sub.font = curr.font;
            sub.fontSize = curr.fontSize;
            sub.color = curr.color;
            sub.bgColor = curr.bgColor;
            sub.bgOpacity = curr.bgOpacity;
            sub.showBg = curr.showBg;
            sub.bgRadius = curr.bgRadius;
            sub.bgPadding = curr.bgPadding;
            sub.showStroke = curr.showStroke;
            sub.strokeWidth = curr.strokeWidth;
            sub.strokeColor = curr.strokeColor;
            sub.showShadow = curr.showShadow;
            sub.shadowColor = curr.shadowColor;
            sub.shadowBlur = curr.shadowBlur;
            sub.shadowOffsetY = curr.shadowOffsetY;
            sub.isBold = curr.isBold;
            sub.isItalic = curr.isItalic;
            sub.isUppercase = curr.isUppercase;
            sub.textAlign = curr.textAlign;
            sub.posX = curr.posX;
            sub.posY = curr.posY;
            sub.scale = curr.scale;
            sub.position = curr.position;
        }
    });

    renderTimeline();
    updatePreview();
    updateCanvasTransformBox();
    saveDocument();
    if (window.showToast) window.showToast('Style copied to ALL subtitles', false);
}

// Legacy global style method (kept for backward compatibility)
export function applyGlobalSubtitleStyle() {
    copyCurrentStyleToAll();
}

// ============================================================
// SMART GENERATOR & BULK SPLITTING
// ============================================================

export function splitTextIntoSubtitlePhrases(text, maxChars = 32) {
    if (!text || !text.trim()) return [];

    const rawLines = text.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
    const phrases = [];

    rawLines.forEach(line => {
        // Split on major sentence terminators: . ! ? …
        const sentences = line.split(/(?<=[.!?…])\s+/).filter(s => s.trim().length > 0);

        sentences.forEach(sentence => {
            const trimmed = sentence.trim();
            if (trimmed.length <= maxChars) {
                phrases.push(trimmed);
                return;
            }

            // Split on secondary clause markers: , ; : — -
            const clauses = trimmed.split(/(?<=[,;:\u2014\-])\s+/).filter(c => c.trim().length > 0);

            clauses.forEach(clause => {
                const cTrim = clause.trim();
                if (cTrim.length <= maxChars) {
                    phrases.push(cTrim);
                    return;
                }

                // Split words
                const words = cTrim.split(/\s+/).filter(Boolean);
                let currentChunk = [];
                let currentLen = 0;

                for (const word of words) {
                    if (currentLen + word.length + (currentChunk.length > 0 ? 1 : 0) > maxChars && currentChunk.length > 0) {
                        phrases.push(currentChunk.join(' '));
                        currentChunk = [word];
                        currentLen = word.length;
                    } else {
                        currentChunk.push(word);
                        currentLen += word.length + (currentChunk.length > 1 ? 1 : 0);
                    }
                }
                if (currentChunk.length > 0) phrases.push(currentChunk.join(' '));
            });
        });
    });

    return phrases.filter(p => p.trim().length > 0);
}

export function generateBulkSubtitles() {
    const textEl = document.getElementById('cupcat-sub-mgr-text') || document.getElementById('cupcat-sub-smart-text') || document.getElementById('cupcat-sub-input-text');
    const text = textEl ? textEl.value.trim() : '';
    if (!text) {
        if (window.showToast) window.showToast('Enter or paste text to generate subtitles', false);
        return;
    }

    const maxChars = parseInt(document.getElementById('cupcat-sub-mgr-chars')?.value || document.getElementById('cupcat-sub-smart-chars')?.value) || 32;
    const baseDuration = parseFloat(document.getElementById('cupcat-sub-mgr-dur')?.value || document.getElementById('cupcat-sub-smart-dur')?.value) || 2.4;
    const gap = 0.08;

    pushHistory();
    if (!state.subtitleTracks) state.subtitleTracks = [];

    // Check if the only existing subtitle is an untouched/placeholder "New subtitle"
    const isOnlyPlaceholder = state.subtitleTracks.length === 1 &&
        (state.subtitleTracks[0].text === 'New subtitle' || !state.subtitleTracks[0].text.trim());

    if (isOnlyPlaceholder) {
        state.subtitleTracks = [];
    }

    let currentTime = 0;
    if (state.subtitleTracks.length > 0) {
        currentTime = Math.max(...state.subtitleTracks.map(s => s.endTime)) + gap;
    } else {
        // Start from 0:00 (or playhead if user explicitly positioned playhead > 0.5s)
        currentTime = (state.playheadTime && state.playheadTime > 0.5) ? state.playheadTime : 0;
    }

    // Default style
    const sample = state.subtitleTracks.length > 0 ? state.subtitleTracks[0] : SUBTITLE_PRESETS.classic;

    const chunks = splitTextIntoSubtitlePhrases(text, maxChars);
    if (chunks.length === 0) {
        if (window.showToast) window.showToast('Could not extract subtitle phrases', true);
        return;
    }

    let firstAddedId = null;
    for (let chunk of chunks) {
        const newId = generateId();
        if (!firstAddedId) firstAddedId = newId;

        // Dynamic timing based on phrase length and word count (min 1.6s, max 5.0s)
        const wordCount = chunk.split(/\s+/).filter(Boolean).length;
        const phraseDur = Math.max(1.6, Math.min(5.0, Math.max(baseDuration, wordCount * 0.38 + 0.6)));

        state.subtitleTracks.push({
            id: newId,
            text: chunk,
            startTime: parseFloat(currentTime.toFixed(3)),
            endTime: parseFloat((currentTime + phraseDur).toFixed(3)),
            position: sample.position || 'bottom',
            color: sample.color || '#ffffff',
            bgColor: sample.bgColor || 'rgba(0,0,0,0.75)',
            bgOpacity: sample.bgOpacity !== undefined ? sample.bgOpacity : 0.8,
            showBg: sample.showBg !== undefined ? sample.showBg : true,
            bgRadius: sample.bgRadius || 8,
            bgPadding: sample.bgPadding || 1,
            fontSize: sample.fontSize || 24,
            font: sample.font || 'Inter',
            isBold: !!sample.isBold,
            isItalic: !!sample.isItalic,
            isUppercase: !!sample.isUppercase,
            showStroke: !!sample.showStroke,
            strokeColor: sample.strokeColor || '#000000',
            strokeWidth: sample.strokeWidth || 0,
            showShadow: !!sample.showShadow,
            shadowColor: sample.shadowColor || 'rgba(0,0,0,0.8)',
            shadowBlur: sample.shadowBlur || 0,
            shadowOffsetY: sample.shadowOffsetY || 0,
            textAlign: sample.textAlign || 'center',
            posX: sample.posX !== undefined ? sample.posX : 50,
            posY: sample.posY !== undefined ? sample.posY : 88,
            scale: sample.scale || 100,
            opacity: sample.opacity || 100,
            rotation: sample.rotation || 0,
            keyframes: []
        });
        currentTime += phraseDur + gap;
    }

    if (firstAddedId) state.selectedSubtitleId = firstAddedId;
    if (textEl && textEl.id !== 'cupcat-sub-input-text') textEl.value = '';

    renderTimeline();
    updatePreview();
    renderSubtitleInspectorContent();
    updateCanvasTransformBox();
    saveDocument();
    if (window.showToast) window.showToast(`Generated ${chunks.length} subtitles`, false);
}

// ============================================================
// SRT & VTT IMPORT / EXPORT
// ============================================================

export function exportSubtitlesSRT() {
    if (!state.subtitleTracks || state.subtitleTracks.length === 0) {
        if (window.showToast) window.showToast('No subtitles to export', true);
        return;
    }

    const sorted = [...state.subtitleTracks].sort((a, b) => a.startTime - b.startTime);
    let srt = '';

    function srtTime(t) {
        const hrs = Math.floor(t / 3600);
        const mins = Math.floor((t % 3600) / 60);
        const secs = Math.floor(t % 60);
        const ms = Math.floor((t % 1) * 1000);
        return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    }

    sorted.forEach((sub, idx) => {
        srt += `${idx + 1}\n`;
        srt += `${srtTime(sub.startTime)} --> ${srtTime(sub.endTime)}\n`;
        srt += `${sub.text}\n\n`;
    });

    downloadTextFile(srt, `${state.docTitle || 'subtitles'}.srt`, 'text/plain');
    if (window.showToast) window.showToast('.SRT file exported', false);
}

export function exportSubtitlesVTT() {
    if (!state.subtitleTracks || state.subtitleTracks.length === 0) {
        if (window.showToast) window.showToast('No subtitles to export', true);
        return;
    }

    const sorted = [...state.subtitleTracks].sort((a, b) => a.startTime - b.startTime);
    let vtt = 'WEBVTT\n\n';

    function vttTime(t) {
        const hrs = Math.floor(t / 3600);
        const mins = Math.floor((t % 3600) / 60);
        const secs = Math.floor(t % 60);
        const ms = Math.floor((t % 1) * 1000);
        return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    }

    sorted.forEach((sub, idx) => {
        vtt += `${idx + 1}\n`;
        vtt += `${vttTime(sub.startTime)} --> ${vttTime(sub.endTime)}\n`;
        vtt += `${sub.text}\n\n`;
    });

    downloadTextFile(vtt, `${state.docTitle || 'subtitles'}.vtt`, 'text/vtt');
    if (window.showToast) window.showToast('.VTT file exported', false);
}

export function exportSubtitlesTXT() {
    if (!state.subtitleTracks || state.subtitleTracks.length === 0) {
        if (window.showToast) window.showToast('No subtitles to export', true);
        return;
    }

    const sorted = [...state.subtitleTracks].sort((a, b) => a.startTime - b.startTime);
    const txt = sorted.map(s => s.text).join('\n');
    downloadTextFile(txt, `${state.docTitle || 'transcript'}.txt`, 'text/plain');
    if (window.showToast) window.showToast('Transcript text exported', false);
}

export function importSubtitlesFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const content = e.target.result;
            const parsed = parseSRTorVTT(content);
            if (parsed.length === 0) {
                if (window.showToast) window.showToast('Could not parse subtitle file', true);
                return;
            }

            pushHistory();
            if (!state.subtitleTracks) state.subtitleTracks = [];

            const sample = state.subtitleTracks.length > 0 ? state.subtitleTracks[0] : SUBTITLE_PRESETS.classic;

            parsed.forEach(item => {
                state.subtitleTracks.push({
                    id: generateId(),
                    text: item.text,
                    startTime: item.startTime,
                    endTime: item.endTime,
                    position: sample.position || 'bottom',
                    color: sample.color || '#ffffff',
                    bgColor: sample.bgColor || 'rgba(0,0,0,0.75)',
                    bgOpacity: sample.bgOpacity !== undefined ? sample.bgOpacity : 0.8,
                    showBg: sample.showBg !== undefined ? sample.showBg : true,
                    bgRadius: sample.bgRadius || 8,
                    bgPadding: sample.bgPadding || 1,
                    fontSize: sample.fontSize || 24,
                    font: sample.font || 'Inter',
                    isBold: !!sample.isBold,
                    isItalic: !!sample.isItalic,
                    isUppercase: !!sample.isUppercase,
                    showStroke: !!sample.showStroke,
                    strokeColor: sample.strokeColor || '#000000',
                    strokeWidth: sample.strokeWidth || 0,
                    showShadow: !!sample.showShadow,
                    shadowColor: sample.shadowColor || 'rgba(0,0,0,0.8)',
                    shadowBlur: sample.shadowBlur || 0,
                    shadowOffsetY: sample.shadowOffsetY || 0,
                    textAlign: sample.textAlign || 'center',
                    posX: sample.posX !== undefined ? sample.posX : 50,
                    posY: sample.posY !== undefined ? sample.posY : 88,
                    scale: sample.scale || 100,
                    opacity: sample.opacity || 100,
                    rotation: sample.rotation || 0,
                    keyframes: []
                });
            });

            if (parsed.length > 0) {
                state.selectedSubtitleId = state.subtitleTracks[state.subtitleTracks.length - parsed.length].id;
            }

            renderTimeline();
            updatePreview();
            renderSubtitleInspectorContent();
            updateCanvasTransformBox();
            saveDocument();
            if (window.showToast) window.showToast(`Imported ${parsed.length} subtitles`, false);
        } catch (err) {
            console.error('Subtitle import error:', err);
            if (window.showToast) window.showToast('Error reading file', true);
        }
    };
    reader.readAsText(file);
}

function parseSRTorVTT(text) {
    const entries = [];
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalized.split(/\n\s*\n/);

    function parseTimeStr(tStr) {
        const parts = tStr.trim().replace(',', '.').split(':');
        if (parts.length === 3) {
            return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        } else if (parts.length === 2) {
            return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
        }
        return 0;
    }

    blocks.forEach(block => {
        const lines = block.trim().split('\n');
        let timeLineIdx = -1;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('-->')) {
                timeLineIdx = i;
                break;
            }
        }

        if (timeLineIdx >= 0) {
            const timeParts = lines[timeLineIdx].split('-->');
            if (timeParts.length === 2) {
                const startTime = parseTimeStr(timeParts[0]);
                const endTime = parseTimeStr(timeParts[1].split(' ')[0]);
                const subText = lines.slice(timeLineIdx + 1).join('\n').replace(/<[^>]*>/g, '').trim();
                if (subText && endTime > startTime) {
                    entries.push({ startTime, endTime, text: subText });
                }
            }
        }
    });

    return entries;
}

function downloadTextFile(content, fileName, mimeType = 'text/plain') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================
// INSPECTOR UI RENDERING
// ============================================================

export function renderSubtitleInspectorContent() {
    const container = document.getElementById('cupcat-sub-editor-body');
    if (!container) return;

    window.cupcatAddEmptySubtitle = () => addEmptySubtitle();

    if (!state.subtitleTracks) state.subtitleTracks = [];

    let sub = state.subtitleTracks.find(s => s.id === state.selectedSubtitleId);
    if (!sub && state.subtitleTracks.length > 0) {
        sub = state.subtitleTracks[0];
        state.selectedSubtitleId = sub.id;
    }

    const sorted = [...state.subtitleTracks].sort((a, b) => a.startTime - b.startTime);
    const currIdx = sub ? sorted.findIndex(s => s.id === sub.id) : 0;
    const totalCount = sorted.length;

    // Header counter and sync toggle
    const countLabel = document.getElementById('cupcat-sub-inspector-counter');
    if (countLabel) {
        countLabel.textContent = sub ? `Subtitle ${currIdx + 1} of ${totalCount}` : `Subtitles: ${totalCount}`;
    }

    const syncCheckbox = document.getElementById('cupcat-sub-sync-all-toggle');
    if (syncCheckbox) {
        syncCheckbox.checked = !!state.subApplyToAll;
    }

    // Tab buttons highlight
    ['text', 'style', 'list'].forEach(tab => {
        const btn = document.getElementById(`cupcat-sub-tab-${tab}`);
        if (btn) {
            const isActive = (state.subInspectorTab || 'text') === tab;
            btn.style.background = isActive ? 'linear-gradient(135deg, #00bcd4, #009688)' : 'rgba(255,255,255,0.06)';
            btn.style.color = isActive ? '#ffffff' : 'rgba(255,255,255,0.7)';
            btn.style.fontWeight = isActive ? '700' : '500';
        }
        const panel = document.getElementById(`cupcat-sub-panel-${tab}`);
        if (panel) {
            panel.style.display = ((state.subInspectorTab || 'text') === tab) ? 'block' : 'none';
        }
    });

    // 1. Text Panel Content
    renderTextPanel(sub, currIdx, totalCount);

    // 2. Style Panel Content
    if (sub) {
        renderStylePanel(sub);
    } else {
        renderStylePanel(SUBTITLE_PRESETS.classic);
    }

    // 3. List Panel Content
    renderListPanel(sorted);
}

function renderTextPanel(sub, currIdx, totalCount) {
    const textInput = document.getElementById('cupcat-sub-input-text');
    if (textInput && textInput !== document.activeElement) {
        textInput.value = sub ? (sub.text || '') : '';
        textInput.placeholder = sub ? 'Enter subtitle text...' : 'No subtitles. Click + Add Subtitle or use Transcript tab to generate';
    }

    const startValEl = document.getElementById('cupcat-sub-start-val');
    if (startValEl) startValEl.textContent = sub ? `${sub.startTime.toFixed(1)}s` : '0.0s';

    const endValEl = document.getElementById('cupcat-sub-end-val');
    if (endValEl) endValEl.textContent = sub ? `${sub.endTime.toFixed(1)}s` : '0.0s';

    const durValEl = document.getElementById('cupcat-sub-dur-val');
    if (durValEl) durValEl.textContent = sub ? `${(sub.endTime - sub.startTime).toFixed(1)}s` : '0.0s';
}

function renderStylePanel(sub) {
    // Preset cards
    const presetGrid = document.getElementById('cupcat-sub-presets-grid');
    if (presetGrid && presetGrid.dataset.rendered !== 'true') {
        presetGrid.dataset.rendered = 'true';
        presetGrid.innerHTML = '';
        Object.entries(SUBTITLE_PRESETS).forEach(([key, preset]) => {
            const card = document.createElement('div');
            card.style.cssText = `
                padding: 10px 8px; border-radius: 10px; cursor: pointer; text-align: center;
                background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
                transition: all 0.2s ease; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
            `;
            card.innerHTML = `
                <div style="background: ${preset.badgeBg}; color: ${preset.badgeColor}; font-size: 11px; font-weight: 800; padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${preset.isUppercase ? 'CAPS' : 'Text'}
                </div>
                <div style="font-size: 11px; color: #ccc; font-weight: 600;">${preset.name}</div>
            `;
            card.addEventListener('click', () => applySubtitlePreset(key));
            presetGrid.appendChild(card);
        });
    }

    if (!sub) return;

    // Font select
    const fontSelect = document.getElementById('cupcat-sub-style-font');
    if (fontSelect) fontSelect.value = sub.font || 'Inter';

    // Font size
    const sizeInput = document.getElementById('cupcat-sub-style-size');
    const sizeVal = document.getElementById('cupcat-sub-style-size-val');
    if (sizeInput) sizeInput.value = sub.fontSize || 24;
    if (sizeVal) sizeVal.textContent = `${sub.fontSize || 24}px`;

    // Colors
    const textColorInput = document.getElementById('cupcat-sub-style-color');
    if (textColorInput) textColorInput.value = sub.color || '#ffffff';

    const bgColorInput = document.getElementById('cupcat-sub-style-bgcolor');
    if (bgColorInput) bgColorInput.value = (sub.bgColor && sub.bgColor.startsWith('#')) ? sub.bgColor : '#000000';

    const bgToggle = document.getElementById('cupcat-sub-style-bg-toggle');
    if (bgToggle) bgToggle.checked = sub.showBg !== false;

    const bgOpacityInput = document.getElementById('cupcat-sub-style-bg-opacity');
    const bgOpacityVal = document.getElementById('cupcat-sub-style-bg-opacity-val');
    if (bgOpacityInput) bgOpacityInput.value = Math.round((sub.bgOpacity !== undefined ? sub.bgOpacity : 0.8) * 100);
    if (bgOpacityVal) bgOpacityVal.textContent = `${Math.round((sub.bgOpacity !== undefined ? sub.bgOpacity : 0.8) * 100)}%`;

    const bgRadiusInput = document.getElementById('cupcat-sub-style-bg-radius');
    if (bgRadiusInput) bgRadiusInput.value = sub.bgRadius !== undefined ? sub.bgRadius : 8;

    // Stroke
    const strokeToggle = document.getElementById('cupcat-sub-style-stroke-toggle');
    if (strokeToggle) strokeToggle.checked = !!sub.showStroke;

    const strokeColorInput = document.getElementById('cupcat-sub-style-stroke-color');
    if (strokeColorInput) strokeColorInput.value = sub.strokeColor || '#000000';

    const strokeWidthInput = document.getElementById('cupcat-sub-style-stroke-width');
    const strokeWidthVal = document.getElementById('cupcat-sub-style-stroke-width-val');
    if (strokeWidthInput) strokeWidthInput.value = sub.strokeWidth || 3;
    if (strokeWidthVal) strokeWidthVal.textContent = `${sub.strokeWidth || 3}px`;

    // Shadow
    const shadowToggle = document.getElementById('cupcat-sub-style-shadow-toggle');
    if (shadowToggle) shadowToggle.checked = !!sub.showShadow;

    // Formatting buttons
    const boldBtn = document.getElementById('cupcat-sub-format-bold');
    if (boldBtn) boldBtn.style.background = sub.isBold ? 'rgba(0,188,212,0.3)' : 'rgba(255,255,255,0.06)';

    const italicBtn = document.getElementById('cupcat-sub-format-italic');
    if (italicBtn) italicBtn.style.background = sub.isItalic ? 'rgba(0,188,212,0.3)' : 'rgba(255,255,255,0.06)';

    const capsBtn = document.getElementById('cupcat-sub-format-caps');
    if (capsBtn) capsBtn.style.background = sub.isUppercase ? 'rgba(0,188,212,0.3)' : 'rgba(255,255,255,0.06)';

    // Alignment
    ['left', 'center', 'right'].forEach(align => {
        const btn = document.getElementById(`cupcat-sub-align-${align}`);
        if (btn) {
            btn.style.background = (sub.textAlign === align || (!sub.textAlign && align === 'center')) ? 'rgba(0,188,212,0.3)' : 'rgba(255,255,255,0.06)';
        }
    });

    // Position presets
    ['top', 'center', 'bottom'].forEach(pos => {
        const btn = document.getElementById(`cupcat-sub-pos-${pos}`);
        if (btn) {
            const isMatch = (pos === 'top' && sub.posY <= 25) || (pos === 'center' && sub.posY > 25 && sub.posY < 70) || (pos === 'bottom' && sub.posY >= 70);
            btn.style.background = isMatch ? 'rgba(0,188,212,0.3)' : 'rgba(255,255,255,0.06)';
        }
    });
}

function renderListPanel(sorted) {
    const listEl = document.getElementById('cupcat-sub-transcript-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const query = (state.subSearchQuery || '').toLowerCase().trim();
    const filtered = query ? sorted.filter(s => (s.text || '').toLowerCase().includes(query)) : sorted;

    if (filtered.length === 0) {
        listEl.innerHTML = `
            <div style="color: #888; font-size: 12px; text-align: center; padding: 24px 10px;">
                <i class="fas fa-closed-captioning" style="font-size: 24px; margin-bottom: 8px; color: #555; display: block;"></i>
                No subtitles yet.<br>
                <span style="font-size: 11px; color: #aaa;">Paste text in Smart Auto-Split below or click <b>+ Add Subtitle</b></span>
            </div>
        `;
        return;
    }

    filtered.forEach((item, index) => {
        const isSelected = item.id === state.selectedSubtitleId;
        const row = document.createElement('div');
        row.dataset.id = item.id;
        row.style.cssText = `
            display: flex; gap: 6px; align-items: center; padding: 8px 10px; border-radius: 10px;
            background: ${isSelected ? 'rgba(0,188,212,0.15)' : 'rgba(255,255,255,0.03)'};
            border: 1px solid ${isSelected ? '#00bcd4' : 'rgba(255,255,255,0.06)'};
            transition: background 0.15s ease;
        `;

        row.innerHTML = `
            <div style="font-size: 11px; font-weight: 700; color: ${isSelected ? '#00bcd4' : '#888'}; width: 20px; text-align: center;">
                ${index + 1}
            </div>
            <button class="cupcat-sub-row-seek" title="Jump to subtitle" style="background: rgba(255,255,255,0.08); border: none; border-radius: 6px; color: #fff; padding: 4px 6px; font-size: 10px; cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums;">
                ${formatTime(item.startTime)}
            </button>
            <input type="text" class="cupcat-sub-row-text" value="${(item.text || '').replace(/"/g, '&quot;')}" placeholder="Subtitle text..." style="flex: 1; min-width: 80px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 5px 8px; color: #fff; font-size: 12px; outline: none;">
            <button class="cupcat-sub-row-split" title="Split subtitle at cursor (↵ / Enter)" style="background: rgba(0,188,212,0.12); border: 1px solid rgba(0,188,212,0.25); color: #00bcd4; border-radius: 6px; cursor: pointer; padding: 4px 7px; font-size: 11px;"><i class="fas fa-cut"></i></button>
            <button class="cupcat-sub-row-del" title="Delete" style="background: none; border: none; color: #ff5252; cursor: pointer; padding: 4px 6px; font-size: 13px;"><i class="fas fa-trash-alt"></i></button>
        `;

        // Seek button click
        row.querySelector('.cupcat-sub-row-seek').addEventListener('click', (e) => {
            e.stopPropagation();
            selectSubtitle(item.id, true);
        });

        const textInput = row.querySelector('.cupcat-sub-row-text');

        // Text edit on the fly
        textInput.addEventListener('input', (e) => {
            updateSubtitleText(item.id, e.target.value);
        });

        textInput.addEventListener('focus', () => {
            if (state.selectedSubtitleId !== item.id) {
                selectSubtitle(item.id, false);
            }
        });

        // Keydown: Enter (Split) & Backspace at pos 0 (Merge)
        textInput.addEventListener('keydown', (e) => {
            // 1. Enter key -> Split into new subtitle row
            if (e.key === 'Enter' || e.keyCode === 13) {
                e.preventDefault();
                const caret = textInput.selectionStart !== undefined ? textInput.selectionStart : textInput.value.length;
                splitSubtitleAtCursor(item.id, caret);
                return;
            }

            // 2. Backspace at beginning of text (selectionStart === 0) -> Merge with previous row
            if ((e.key === 'Backspace' || e.keyCode === 8) && textInput.selectionStart === 0 && textInput.selectionEnd === 0) {
                e.preventDefault();
                mergeSubtitleWithPrevious(item.id);
                return;
            }
        });

        // Split button click
        row.querySelector('.cupcat-sub-row-split').addEventListener('click', (e) => {
            e.stopPropagation();
            const caret = (textInput.selectionStart !== undefined && textInput.selectionStart > 0)
                ? textInput.selectionStart
                : Math.floor(textInput.value.length / 2);
            splitSubtitleAtCursor(item.id, caret);
        });

        // Row click
        row.addEventListener('click', (e) => {
            if (e.target.closest('.cupcat-sub-row-del') || e.target.closest('.cupcat-sub-row-split') || e.target.closest('.cupcat-sub-row-text')) return;
            selectSubtitle(item.id, true);
        });

        // Delete button
        row.querySelector('.cupcat-sub-row-del').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteSubtitle(item.id);
        });

        listEl.appendChild(row);
    });
}

// ============================================================
// TIMELINE TRACK RENDERING
// ============================================================

export function renderSubtitleTrack() {
    const container = document.getElementById('cupcat-subtitle-tracks-container');
    if (!container) return;
    container.innerHTML = '';

    if (!state.subtitleTracks || state.subtitleTracks.length === 0) return;

    const totalDur = Math.max(getMaxTimelineDuration(), 10);

    const row = document.createElement('div');
    row.style.cssText = `
        display: flex; align-items: center;
        padding: 4px 0 4px 4px;
        min-height: 44px;
    `;

    const rowLabel = document.createElement('div');
    rowLabel.style.cssText = `
        width: 28px; flex-shrink: 0;
        font-size: 9px; color: #00bcd4;
        writing-mode: vertical-lr; text-orientation: mixed;
        text-align: center; font-weight: 700; letter-spacing: 1px;
    `;
    rowLabel.textContent = 'SUB';
    row.appendChild(rowLabel);

    const trackEl = document.createElement('div');
    trackEl.style.cssText = `
        position: relative; height: 36px; flex-shrink: 0;
        width: ${totalDur * state.timelineZoom + Math.max(window.innerWidth * 0.5, 200)}px;
    `;

    state.subtitleTracks.forEach(sub => {
        const startPx = sub.startTime * state.timelineZoom;
        const durPx = Math.max((sub.endTime - sub.startTime) * state.timelineZoom, 6);
        const isSelected = sub.id === state.selectedSubtitleId;

        const el = document.createElement('div');
        el.dataset.subId = sub.id;
        el.style.cssText = `
            position: absolute; left: ${startPx}px; top: 0;
            width: ${durPx}px; height: 36px;
            background: ${isSelected
                ? 'linear-gradient(135deg, rgba(0,188,212,0.35), rgba(0,150,136,0.35))'
                : 'linear-gradient(135deg, rgba(0,188,212,0.15), rgba(0,150,136,0.15))'
            };
            border: 1.5px solid ${isSelected ? '#00e5ff' : 'rgba(0,188,212,0.35)'};
            box-shadow: ${isSelected ? '0 0 10px rgba(0,229,255,0.4)' : 'none'};
            border-radius: 6px; cursor: pointer;
            display: flex; align-items: center;
            overflow: hidden; user-select: none;
        `;

        const label = document.createElement('div');
        label.style.cssText = `
            padding: 0 8px; overflow: hidden;
            white-space: nowrap; text-overflow: ellipsis;
            font-size: 11px; font-weight: 600; color: ${isSelected ? '#ffffff' : 'rgba(255,255,255,0.85)'};
            pointer-events: none;
        `;
        label.textContent = '💬 ' + (sub.text || '').substring(0, 25);
        el.appendChild(label);

        // Keyframe diamond markers
        if (sub.keyframes && sub.keyframes.length > 0) {
            sub.keyframes.forEach(kf => {
                const kfPos = (kf.time - sub.startTime) * state.timelineZoom;
                if (kfPos >= 0 && kfPos <= durPx) {
                    const dia = document.createElement('div');
                    dia.className = 'cupcat-kf-diamond-marker';
                    dia.title = `Keyframe @ ${kf.time.toFixed(2)}s`;
                    dia.style.cssText = `
                        position: absolute; left: ${kfPos - 5}px; top: 3px;
                        width: 9px; height: 9px;
                        background: #ffd600; transform: rotate(45deg);
                        border: 1.5px solid #1e1e2d; border-radius: 2px;
                        z-index: 6; pointer-events: none;
                        box-shadow: 0 0 6px rgba(255,214,0,0.7);
                    `;
                    el.appendChild(dia);
                }
            });
        }

        if (durPx > 45) {
            const badge = document.createElement('div');
            badge.style.cssText = `
                position: absolute; bottom: 2px; right: 4px;
                font-size: 8px; color: rgba(255,255,255,0.6);
                font-variant-numeric: tabular-nums; z-index: 2;
            `;
            badge.textContent = formatTime(sub.endTime - sub.startTime);
            el.appendChild(badge);
        }

        // Trim handles
        if (isSelected) {
            const leftHandle = document.createElement('div');
            leftHandle.className = 'cupcat-trim-handle-left';
            leftHandle.style.cssText = `
                position: absolute; left: 0; top: 0; bottom: 0; width: 8px;
                background: #00e5ff; cursor: ew-resize; z-index: 5;
                border-radius: 6px 0 0 6px;
                display: flex; align-items: center; justify-content: center;
            `;
            leftHandle.innerHTML = '<div style="width:2px;height:16px;background:rgba(255,255,255,0.7);border-radius:1px;"></div>';
            el.appendChild(leftHandle);

            const rightHandle = document.createElement('div');
            rightHandle.className = 'cupcat-trim-handle-right';
            rightHandle.style.cssText = `
                position: absolute; right: 0; top: 0; bottom: 0; width: 8px;
                background: #00e5ff; cursor: ew-resize; z-index: 5;
                border-radius: 0 6px 6px 0;
                display: flex; align-items: center; justify-content: center;
            `;
            rightHandle.innerHTML = '<div style="width:2px;height:16px;background:rgba(255,255,255,0.7);border-radius:1px;"></div>';
            el.appendChild(rightHandle);

            bindSubtitleTrimHandle(leftHandle, sub, 'start', el);
            bindSubtitleTrimHandle(rightHandle, sub, 'end', el);
        }

        el.addEventListener('click', (e) => {
            if (e.target.closest('.cupcat-trim-handle-left') || e.target.closest('.cupcat-trim-handle-right')) return;
            selectSubtitle(sub.id, false);
        });

        el.addEventListener('dblclick', () => {
            openSubtitleInspector(sub.id, 'text');
        });

        // Drag horizontally
        let dragStartX = 0;
        let dragStartOffset = 0;
        let dragged = false;

        el.addEventListener('mousedown', startDrag);
        el.addEventListener('touchstart', startDrag, { passive: false });

        function startDrag(e) {
            if (e.target.closest('.cupcat-trim-handle-left') || e.target.closest('.cupcat-trim-handle-right')) return;
            if (e.type === 'mousedown' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            selectSubtitle(sub.id, false);

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            dragStartX = clientX;
            dragStartOffset = sub.startTime;
            dragged = false;

            function onMove(me) {
                const cx = me.touches ? me.touches[0].clientX : me.clientX;
                const dx = cx - dragStartX;
                if (Math.abs(dx) > 3) {
                    if (!dragged) {
                        dragged = true;
                        pushHistory();
                    }
                    const dur = sub.endTime - sub.startTime;
                    const shift = dx / state.timelineZoom;
                    const newStartTime = Math.max(0, dragStartOffset + shift);
                    const timeDelta = newStartTime - sub.startTime;

                    sub.startTime = newStartTime;
                    sub.endTime = sub.startTime + dur;

                    if (sub.keyframes && timeDelta !== 0) {
                        sub.keyframes.forEach(kf => { kf.time += timeDelta; });
                    }

                    el.style.left = (sub.startTime * state.timelineZoom) + 'px';
                }
            }

            function onEnd() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onEnd);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
                document.removeEventListener('touchcancel', onEnd);
                if (dragged) {
                    saveDocument();
                }
                renderTimeline();
                updatePreview();
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
            document.addEventListener('touchcancel', onEnd);
        }

        trackEl.appendChild(el);
    });

    row.appendChild(trackEl);
    container.appendChild(row);
}

function bindSubtitleTrimHandle(handle, sub, side, subEl) {
    let startX = 0;
    let startVal = 0;

    function onStart(e) {
        e.preventDefault();
        e.stopPropagation();
        startX = e.touches ? e.touches[0].clientX : e.clientX;
        startVal = side === 'start' ? (sub.startTime || 0) : (sub.endTime || 0);

        pushHistory();
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
        document.addEventListener('touchcancel', onEnd);
    }

    function onMove(e) {
        e.preventDefault();
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const dx = cx - startX;
        const dt = dx / state.timelineZoom;

        if (side === 'start') {
            sub.startTime = Math.max(0, Math.min(sub.endTime - 0.1, startVal + dt));
        } else {
            sub.endTime = Math.max(sub.startTime + 0.1, startVal + dt);
        }

        if (subEl) {
            const w = (sub.endTime - sub.startTime) * state.timelineZoom;
            subEl.style.width = Math.max(w, 6) + 'px';
            subEl.style.left = (sub.startTime * state.timelineZoom) + 'px';
        }
    }

    function onEnd() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);
        renderTimeline();
        saveDocument();
    }

    handle.addEventListener('mousedown', onStart);
    handle.addEventListener('touchstart', onStart, { passive: false });
}

export function updateSubtitlePreview() {
    const container = document.getElementById('cupcat-subtitle-overlay-container');
    if (!container) return;
    container.innerHTML = '';
}
