// src/modules/tools/cupcat/editor.js
// CupCat Video Editor — Full modular editor bootstrap & coordinator
// Connects state, UI, timeline, preview, canvas, tools, and export.

import { state } from './state.js';
import { CANVAS_ASPECTS } from './constants.js';
import { formatTime, getTotalDuration, getClipDuration, getClipStartTime, stopPlaybackSafe, generateId } from './utils.js';
import { loadDocument, saveDocument } from './persistence.js';
import { pushHistory, undo, redo, updateUndoRedoButtons, setHistoryCallbacks } from './history.js';
import { renderUI, bindEvents, setUICallbacks } from './ui.js';
import { renderTimeline, updatePlayhead, bindRulerDrag, bindPlayheadDrag, updateEmptyState, updateTimeDisplay, setTimelineCallbacks } from './timeline.js';
import { updatePreview, updatePreviewAtTime, showPreviewImage, showPreviewVideo, applyKenBurnsCSS, setPreviewCallbacks } from './preview.js';
import { togglePlay, startPlayback, stopPlayback, setPlaybackCallbacks, setMediaVolume } from './playback.js';
import { renderScene, setRenderSceneCallbacks } from './render-scene.js';
import { updateCanvasBox, bindResizeHandle, bindCanvasInteractiveBox, bindCropBox, toggleCropMode, setCanvasCallbacks } from './canvas.js';
import { toggleAntigravity, updateAntigravityButton } from './antigravity-ui.js';
import { openExportSettingsModal, closeExportSettingsModal, exportVideo, setExportResolution, setExportSpeedPreset, setExportQuality, setExportDependencies, loadExportSettings, bindCancelExportButton, exportScreenshot, shareLastExport, exportAudioOnly, exportGif, exportBoomerang } from './export.js';

// Tools imports
import {
    splitAtPlayhead, deleteSelected, duplicateSelected, extractAudioFromSelected,
    openFreezeModal, closeFreezeModal, applyFreezeFrame, updateFreezeDuration,
    openReverseModal, closeReverseModal, applyReverseAction, setReverseMode, updateReverseSegmentPreview,
    setTrimCallbacks
} from './tools/trim.js';

import {
    openVolumeModal, closeVolumeModal, applyVolume, toggleVolumeModalMute, updateVolumeModalLabel, updateVolumeModalFadeLabels,
    openSpeedModal, closeSpeedModal, applySpeed, updateSpeedModalLabel, updateSpeedPreviewInfo,
    setAudioCallbacks
} from './tools/audio.js';

import {
    openFiltersModal, closeFiltersModal, selectFilterPreset, updateFilterPresetHighlightOnly,
    updateFilterModalUI, resetFilterSliders, applyLiveFilterPreview, applyFilters,
    getClipFilters, getClipCSSFilter, buildColorFilter, applyPreviewFilter,
    setFiltersCallbacks
} from './tools/filters.js';

import {
    openTransformModal, closeTransformModal, updateTransformModalUI, applyLiveTransformPreview,
    rotateClipStep, setClipRotationAngle, toggleClipFlipH, toggleClipFlipV,
    resetTransformControls, applyTransform, getClipTransform, getClipCSSTransform,
    buildTransformFilter, applyPreviewTransform,
    setTransformCallbacks
} from './tools/transform.js';

import {
    updateImageSettingsButton, openImageSettingsModal, closeImageSettingsModal,
    applyImageSettings,
    setImageSettingsCallbacks
} from './tools/image-settings.js';

import {
    openRatioModal, closeRatioModal, selectCanvasAspect,
    setRatioCallbacks
} from './tools/ratio.js';

import {
    toggleKeyframeAtPlayhead, navigateKeyframe, getInterpolatedKeyframe, updateKeyframeDiamondButton,
    getSelectedTarget, applyPropertyChangeToTarget,
    setKeyframeCallbacks
} from './tools/keyframes.js';

import {
    openTextModal, openTextModalForEdit, closeTextModal, applyText,
    updateTextPositionButtons, renderTextTrack, updateTextOverlayPreview,
    setTextCallbacks
} from './tools/text.js';

import {
    openStickersModal, closeStickersModal, populateStickerGrid, addStickerToTimeline,
    setStickersCallbacks
} from './tools/stickers.js';

import {
    openSubtitleInspector, closeSubtitleInspector, openSubtitleManager, closeSubtitleManager,
    switchSubtitleTab, selectPrevSubtitle, selectNextSubtitle, addEmptySubtitle,
    updateSubtitleText, adjustSubtitleTiming, setSubtitleTimingToPlayhead,
    splitSubtitleAtPlayhead, toggleSubApplyToAll,
    renderSubtitleInspectorContent, renderSubtitleTrack, updateSubtitlePreview,
    setSubtitleCallbacks
} from './tools/subtitles.js';

import {
    openOverlayModal, openOverlayModalForEdit, closeOverlayModal,
    renderOverlayTrack, updateOverlayPreview,
    setOverlayCallbacks
} from './tools/overlay.js';

import {
    openTransitionModal, closeTransitionModal, applyTransition,
    setTransitionCallbacks
} from './tools/transitions.js';

/**
 * Initialize all inter-module callbacks across the CupCat editor.
 */
function wireAllCallbacks() {
    // 1. History
    setHistoryCallbacks({
        renderTimeline,
        updatePreview,
        updatePlayhead,
        updateCanvasBox,
        saveDocument,
        updateUndoRedoButtons,
        updateEmptyState
    });

    // 2. Render Scene
    setRenderSceneCallbacks({
        getClipCSSFilter,
        getClipTransform,
        getClipFilters,
        getInterpolatedKeyframe
    });

    // 3. Canvas
    setCanvasCallbacks({
        updatePreview,
        saveDocument,
        pushHistory,
        getInterpolatedKeyframe,
        getSelectedTarget,
        applyPropertyChangeToTarget,
        updateTextOverlayPreview,
        updateOverlayPreview,
        renderTimeline,
        updateKeyframeDiamondButton,
        deleteSelected,
        openTextModalForEdit,
        openSubtitleInspector,
        splitSubtitleAtPlayhead,
        toggleSubApplyToAll
    });

    // 4. Preview
    setPreviewCallbacks({
        getClipCSSFilter,
        applyPreviewFilter,
        getClipCSSTransform,
        applyPreviewTransform,
        getInterpolatedKeyframe,
        updateCanvasTransformBox: updateCanvasBox,
        renderTimeline,
        updateTextOverlayPreview,
        updateOverlayPreview,
        updateSubtitlePreview
    });

    // 5. Playback
    setPlaybackCallbacks({
        updatePreview,
        updatePreviewAtTime,
        updatePlayhead,
        updateTimeDisplay,
        renderTimeline,
        updateKeyframeDiamondButton,
        updateCanvasTransformBox: updateCanvasBox,
        showPreviewImage,
        showPreviewVideo,
        applyPreviewFilter,
        applyPreviewTransform,
        updateTextOverlayPreview,
        updateOverlayPreview,
        updateSubtitlePreview
    });

    // 6. Timeline
    setTimelineCallbacks({
        updatePreview,
        updatePreviewAtTime,
        saveDocument,
        updateImageSettingsButton,
        updateKeyframeDiamondButton,
        updateCanvasTransformBox: updateCanvasBox,
        renderOverlayTrack,
        renderTextTrack,
        renderSubtitleTrack,
        splitAtPlayhead,
        getClipFilters,
        getClipTransform,
        openTransitionModal
    });

    // 7. Trim / Edit Tool
    setTrimCallbacks({
        renderTimeline,
        updatePreview,
        updatePlayhead,
        updateEmptyState,
        saveDocument,
        updateKeyframeDiamondButton,
        updateTextOverlayPreview,
        updateCanvasBox,
        updateOverlayPreview,
        updatePreviewAtTime
    });

    // 8. Audio Tool
    setAudioCallbacks({
        renderTimeline,
        updatePreview,
        saveDocument
    });

    // 9. Filters Tool
    setFiltersCallbacks({
        renderTimeline,
        updatePreview,
        saveDocument
    });

    // 10. Transform Tool
    setTransformCallbacks({
        renderTimeline,
        updatePreview,
        saveDocument
    });

    // 11. Image Settings Tool
    setImageSettingsCallbacks({
        renderTimeline,
        updatePreview,
        saveDocument
    });

    // 12. Ratio Tool
    setRatioCallbacks({
        updateCanvasBox,
        saveDocument
    });

    // 13. Keyframes Tool
    setKeyframeCallbacks({
        renderTimeline,
        updatePreview,
        saveDocument,
        updateCanvasBox
    });

    // 14. Text Tool
    setTextCallbacks({
        renderTimeline,
        updatePreview,
        saveDocument,
        updateCanvasBox
    });

    // 15. Stickers Tool
    setStickersCallbacks({
        renderTimeline,
        updatePreview,
        saveDocument,
        updateCanvasBox
    });

    // 16. Subtitles Tool
    setSubtitleCallbacks({
        renderTimeline,
        updatePreview,
        saveDocument,
        updateCanvasBox
    });

    // 17. Overlay Tool
    setOverlayCallbacks({
        renderTimeline,
        updatePreview,
        saveDocument,
        updateCanvasBox
    });

    // 18. Transitions Tool
    setTransitionCallbacks({
        renderTimeline,
        updatePreview,
        saveDocument
    });

    // 19. Export Dependencies
    setExportDependencies({
        buildColorFilter,
        buildTransformFilter,
        getClipFilters,
        getClipTransform,
        getInterpolatedKeyframe,
        saveDocument
    });

    // 20. UI Callbacks (the central hub for user action clicks)
    setUICallbacks({
        splitAtPlayhead,
        deleteSelected,
        duplicateSelected,
        extractAudioFromSelected,
        openFreezeModal,
        closeFreezeModal,
        applyFreezeFrame,
        updateFreezeDuration,
        openReverseModal,
        closeReverseModal,
        applyReverseAction,
        setReverseMode,
        updateReverseSegmentPreview,
        toggleCropMode,
        openVolumeModal,
        closeVolumeModal,
        applyVolume,
        toggleVolumeModalMute,
        updateVolumeModalLabel,
        updateVolumeModalFadeLabels,
        openSpeedModal,
        closeSpeedModal,
        applySpeed,
        updateSpeedModalLabel,
        updateSpeedPreviewInfo,
        openFiltersModal,
        closeFiltersModal,
        applyFilters,
        resetFilterSliders,
        updateFilterPresetHighlightOnly,
        applyLiveFilterPreview,
        openTransformModal,
        closeTransformModal,
        applyTransform,
        resetTransformControls,
        rotateClipStep,
        openImageSettingsModal,
        closeImageSettingsModal,
        applyImageSettings,
        openRatioModal,
        closeRatioModal,
        selectCanvasAspect,
        toggleKeyframeAtPlayhead,
        navigateKeyframe,
        openTextModal,
        closeTextModal,
        applyText,
        updateTextPositionButtons,
        openStickersModal,
        closeStickersModal,
        openSubtitleInspector,
        closeSubtitleInspector,
        openSubtitleManager,
        closeSubtitleManager,
        switchSubtitleTab,
        selectPrevSubtitle,
        selectNextSubtitle,
        addEmptySubtitle,
        updateSubtitleText,
        adjustSubtitleTiming,
        setSubtitleTimingToPlayhead,
        renderSubtitleInspectorContent,
        openOverlayModal,
        closeOverlayModal,
        toggleAntigravity,
        openExportSettingsModal,
        closeExportSettingsModal,
        exportVideo,
        exportScreenshot,
        shareLastExport,
        exportAudioOnly,
        exportGif,
        exportBoomerang,
        setExportResolution,
        setExportSpeedPreset,
        setExportQuality,
        togglePlay,
        startPlayback,
        stopPlayback,
        renderScene,
        seekPlayheadTo: (t) => {
            state.playheadTime = Math.max(0, t);
            updatePlayhead();
            updatePreviewAtTime(state.playheadTime);
        },
        updatePlayhead,
        bindRulerDrag,
        bindPlayheadDrag,
        updatePreview,
        updatePreviewAtTime,
        renderTimeline,
        saveDocument,
        undo,
        redo,
        updateCanvasBox,
        updateUndoRedoButtons,
        updateEmptyState,
        updateImageSettingsButton,
        closeEditor: () => {
            if (window.NativeBack && typeof window.NativeBack.closeApp === 'function') {
                window.NativeBack.closeApp();
            } else if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
                window.Capacitor.Plugins.App.minimizeApp();
            }
        }
    });
}

/**
 * Initialize and open the full CupCat Video Editor.
 * @param {string|null} docId - Optional document ID to load from storage.
 */
export async function init(docId = null) {
    // Stop any existing playback and clean up memory
    stopPlaybackSafe();
    if (state.videoClips) state.videoClips.forEach(c => { if (c.objectUrl) URL.revokeObjectURL(c.objectUrl); });
    if (state.audioTracks) state.audioTracks.forEach(a => { if (a.objectUrl) URL.revokeObjectURL(a.objectUrl); });
    if (state.overlayTracks) state.overlayTracks.forEach(o => { if (o.objectUrl) URL.revokeObjectURL(o.objectUrl); });

    // Reset state
    state.selectedClipId = null;
    state.selectedAudioId = null;
    state.selectedTextId = null;
    state.selectedOverlayId = null;
    state.selectedSubtitleId = null;
    state.playheadTime = 0;
    state.isPlaying = false;
    state.isExporting = false;
    state.trimTarget = null;
    state.undoStack = [];
    state.redoStack = [];

    state.currentDocId = docId;
    if (state.currentDocId) {
        await loadDocument();
    } else {
        state.currentDocId = 'doc_' + Date.now();
        state.docTitle = 'New Video Project';
        state.videoClips = [];
        state.audioTracks = [];
        state.textOverlays = [];
        state.subtitleTracks = [];
        state.overlayTracks = [];
        state.canvasAspect = '16:9';
        await saveDocument();
    }

    loadExportSettings();
    wireAllCallbacks();

    // Render editor UI into #module-tools
    renderUI();
    bindEvents();
    bindResizeHandle();
    bindCanvasInteractiveBox();
    bindCropBox();
    bindCancelExportButton();

    renderTimeline();
    updateEmptyState();
    await updatePreview();

    console.log('[CupCat] Video Editor Initialized with full toolbar (Freeze, Reverse, Subtitles, Keyframes, etc.)');
}
