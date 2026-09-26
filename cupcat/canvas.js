import { state } from './state.js';
import { CANVAS_ASPECTS } from './constants.js';
import { syncCanvasSize, renderScene } from './render-scene.js';

let updatePreview;
let saveDocument;
let pushHistory;
let getInterpolatedKeyframe;
let getSelectedTarget;
let applyPropertyChangeToTarget;
let updateTextOverlayPreview;
let updateOverlayPreview;
let renderTimeline;
let updateKeyframeDiamondButton;
let deleteSelected;
let openTextModalForEdit;
let openSubtitleInspector;
let splitSubtitleAtPlayhead;
let toggleSubApplyToAll;

export function setCanvasCallbacks(callbacks) {
    if (callbacks.updatePreview) updatePreview = callbacks.updatePreview;
    if (callbacks.saveDocument) saveDocument = callbacks.saveDocument;
    if (callbacks.pushHistory) pushHistory = callbacks.pushHistory;
    if (callbacks.getInterpolatedKeyframe) getInterpolatedKeyframe = callbacks.getInterpolatedKeyframe;
    if (callbacks.getSelectedTarget) getSelectedTarget = callbacks.getSelectedTarget;
    if (callbacks.applyPropertyChangeToTarget) applyPropertyChangeToTarget = callbacks.applyPropertyChangeToTarget;
    if (callbacks.updateTextOverlayPreview) updateTextOverlayPreview = callbacks.updateTextOverlayPreview;
    if (callbacks.updateOverlayPreview) updateOverlayPreview = callbacks.updateOverlayPreview;
    if (callbacks.renderTimeline) renderTimeline = callbacks.renderTimeline;
    if (callbacks.updateKeyframeDiamondButton) updateKeyframeDiamondButton = callbacks.updateKeyframeDiamondButton;
    if (callbacks.deleteSelected) deleteSelected = callbacks.deleteSelected;
    if (callbacks.openTextModalForEdit) openTextModalForEdit = callbacks.openTextModalForEdit;
    if (callbacks.openSubtitleInspector) openSubtitleInspector = callbacks.openSubtitleInspector;
    if (callbacks.splitSubtitleAtPlayhead) splitSubtitleAtPlayhead = callbacks.splitSubtitleAtPlayhead;
    if (callbacks.toggleSubApplyToAll) toggleSubApplyToAll = callbacks.toggleSubApplyToAll;
}

export function bindResizeHandle() {
    const handle = document.getElementById('cupcat-resize-handle');
    const timeline = document.getElementById('cupcat-timeline-container');
    if (!handle || !timeline) return;

    const MIN_TL = 20;
    const MAX_TL = 500;
    let startY = 0;
    let startH = 0;
    let dragging = false;

    function onStart(e) {
        e.preventDefault();
        dragging = true;
        startY = e.touches ? e.touches[0].clientY : e.clientY;
        startH = timeline.offsetHeight;
        handle.style.background = 'linear-gradient(180deg, #1a1a3a 0%, #22224a 100%)';
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
    }

    function onMove(e) {
        if (!dragging) return;
        e.preventDefault();
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const delta = startY - clientY; // dragging up = positive delta = grow bottom
        const newH = Math.max(MIN_TL, Math.min(MAX_TL, startH + delta));
        timeline.style.height = newH + 'px';
        updateCanvasBox();
    }

    function onEnd() {
        if (!dragging) return;
        dragging = false;
        handle.style.background = 'linear-gradient(180deg, #0d0d1f 0%, #12122a 100%)';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
    }

    handle.addEventListener('mousedown', onStart, { passive: false });
    handle.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('mousemove', onMove, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
}

// Sizes #cupcat-canvas to fit within #cupcat-preview-area while preserving
// the selected canvasAspect ratio, so the preview always shows the actual
// export frame (with letterboxing) instead of stretching to fill the area.
export async function updateCanvasBox() {
    const area = document.getElementById('cupcat-preview-area');
    const canvas = document.getElementById('cupcat-canvas');
    if (!area || !canvas) return;

    const dims = CANVAS_ASPECTS[state.canvasAspect] || CANVAS_ASPECTS['16:9'];
    const ratio = dims.w / dims.h;

    const padding = 8;
    const maxW = Math.max(0, area.clientWidth - padding * 2);
    const maxH = Math.max(0, area.clientHeight - padding * 2);
    if (maxW <= 0 || maxH <= 0) return;

    let w = maxW;
    let h = w / ratio;
    if (h > maxH) {
        h = maxH;
        w = h * ratio;
    }

    canvas.style.width = `${Math.round(w)}px`;
    canvas.style.height = `${Math.round(h)}px`;

    // Sync the Canvas rendering buffer with the new display size
    syncCanvasSize();
    if (state.useCanvasRenderer) await renderScene(state.playheadTime);
}

export function updateCanvasTransformBox() {
    const box = document.getElementById('cupcat-canvas-active-box');
    if (!box) return;

    const target = getSelectedTarget();
    if (!target) {
        box.style.display = 'none';
        return;
    }

    const item = target.item;
    const isVisible = (item.startTime !== undefined && item.endTime !== undefined)
        ? (state.playheadTime >= item.startTime && state.playheadTime <= item.endTime)
        : true;

    if (!isVisible) {
        box.style.display = 'none';
        return;
    }

    const previewContainer = document.getElementById('cupcat-canvas');
    const rect = previewContainer ? previewContainer.getBoundingClientRect() : null;

    const kf = getInterpolatedKeyframe(item, state.playheadTime);
    let scaleVal = (kf.scale !== undefined ? kf.scale : (item.scale || 30) / 100) * 100;
    let posX = kf.x !== undefined ? kf.x : (item.posX !== undefined ? item.posX : 50);
    let posY = kf.y !== undefined ? kf.y : (item.posY !== undefined ? item.posY : 50);
    const rot = kf.rotation !== undefined ? kf.rotation : 0;

    let widthStyle = `${Math.max(scaleVal, 10)}%`;
    let heightStyle = `${Math.max(scaleVal, 10)}%`;

    if (target.type === 'text') {
        const textScale = kf.scale !== undefined ? kf.scale : 1;
        scaleVal = Math.max(20, Math.min(80, (item.fontSize || 36) * textScale * 1.2));
        widthStyle = `${scaleVal}%`;
        heightStyle = 'auto';
    } else if (target.type === 'subtitle') {
        if (item._lastRenderBounds && rect && rect.width > 0 && rect.height > 0) {
            const wPct = (item._lastRenderBounds.boxW / rect.width) * 100;
            const hPct = (item._lastRenderBounds.boxH / rect.height) * 100;
            widthStyle = `${Math.max(12, Math.min(100, wPct + 4))}%`;
            heightStyle = `${Math.max(6, Math.min(100, hPct + 4))}%`;
        } else {
            const scalePct = Math.max(20, Math.min(95, (item.fontSize || 24) * 2.2 * ((item.scale || 100) / 100)));
            widthStyle = `${scalePct}%`;
            heightStyle = 'auto';
        }
    }

    // For text/subtitle overlays without explicit posX/posY, use position preset
    if (target.type === 'text' || target.type === 'subtitle') {
        if (kf.x === undefined && item.posX === undefined) posX = 50;
        if (kf.y === undefined && item.posY === undefined) {
            if (item.position === 'top') posY = 12;
            else if (item.position === 'center') posY = 50;
            else posY = 88; // default bottom
        }
    }

    box.style.display = 'block';
    box.style.left = `${posX}%`;
    box.style.top = `${posY}%`;
    box.style.width = widthStyle;
    box.style.height = heightStyle;
    box.style.minHeight = '32px';
    box.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;

    // Update Quick Action Toolbar items
    const styleBtn = document.getElementById('cupcat-box-style-btn');
    const syncBtn = document.getElementById('cupcat-box-sync-btn');
    const splitBtn = document.getElementById('cupcat-box-split-btn');

    if (target.type === 'subtitle') {
        if (styleBtn) styleBtn.style.display = 'flex';
        if (syncBtn) {
            syncBtn.style.display = 'flex';
            syncBtn.innerHTML = state.subApplyToAll
                ? '<i class="fas fa-globe"></i> Sync All'
                : '<i class="fas fa-dot-circle"></i> Single';
            syncBtn.style.background = state.subApplyToAll ? 'linear-gradient(135deg, #00bcd4, #009688)' : 'rgba(255,255,255,0.15)';
            syncBtn.style.color = '#fff';
        }
        if (splitBtn) splitBtn.style.display = 'flex';
    } else {
        if (styleBtn) styleBtn.style.display = 'none';
        if (syncBtn) syncBtn.style.display = 'none';
        if (splitBtn) splitBtn.style.display = 'none';
    }
}

export function bindCanvasInteractiveBox() {
    const box = document.getElementById('cupcat-canvas-active-box');
    const previewContainer = document.getElementById('cupcat-canvas');
    if (!box || !previewContainer) return;

    // Helper to get clientX/Y from mouse or touch event
    function getXY(e) {
        if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (e.changedTouches && e.changedTouches.length > 0) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        return { x: e.clientX, y: e.clientY };
    }

    function onBoxStart(e) {
        if (e.target.closest('.cupcat-box-handle') || e.target.closest('#cupcat-box-quick-actions')) return;
        const target = getSelectedTarget();
        if (!target) return;

        state.isBoxDragging = true;
        const pt = getXY(e);
        state.dragStartX = pt.x;
        state.dragStartY = pt.y;

        const kf = getInterpolatedKeyframe(target.item, state.playheadTime);
        let initX = kf.x !== undefined ? kf.x : target.item.posX;
        let initY = kf.y !== undefined ? kf.y : target.item.posY;

        if (initX === undefined) initX = 50;
        if (initY === undefined) {
            if (target.item.position === 'top') initY = 12;
            else if (target.item.position === 'center') initY = 50;
            else initY = (target.type === 'subtitle' || target.type === 'text') ? 88 : 50;
        }

        state.initialPosX = initX;
        state.initialPosY = initY;

        e.preventDefault();
        e.stopPropagation();

        document.addEventListener('mousemove', onBoxMouseMove);
        document.addEventListener('mouseup', onBoxMouseUp);
        document.addEventListener('touchmove', onBoxMouseMove, { passive: false });
        document.addEventListener('touchend', onBoxMouseUp);
        document.addEventListener('touchcancel', onBoxMouseUp);
    }

    box.addEventListener('mousedown', onBoxStart);
    box.addEventListener('touchstart', onBoxStart, { passive: false });

    document.querySelectorAll('.cupcat-box-handle').forEach(handle => {
        function onHandleStart(e) {
            const target = getSelectedTarget();
            if (!target) return;

            state.isHandleResizing = true;
            state.resizeHandleType = handle.dataset.handle;
            const pt = getXY(e);
            state.dragStartX = pt.x;
            state.dragStartY = pt.y;

            const kf = getInterpolatedKeyframe(target.item, state.playheadTime);
            state.initialScale = (kf.scale !== undefined ? kf.scale : ((target.item.scale || 30) / 100)) * 100;

            e.preventDefault();
            e.stopPropagation();

            document.addEventListener('mousemove', onResizeMouseMove);
            document.addEventListener('mouseup', onResizeMouseUp);
            document.addEventListener('touchmove', onResizeMouseMove, { passive: false });
            document.addEventListener('touchend', onResizeMouseUp);
            document.addEventListener('touchcancel', onResizeMouseUp);
        }

        handle.addEventListener('mousedown', onHandleStart);
        handle.addEventListener('touchstart', onHandleStart, { passive: false });
    });

    function onBoxMouseMove(e) {
        if (!state.isBoxDragging) return;
        const target = getSelectedTarget();
        if (!target) return;

        e.preventDefault();
        const pt = getXY(e);
        const rect = previewContainer.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const dxPercent = ((pt.x - state.dragStartX) / rect.width) * 100;
        const dyPercent = ((pt.y - state.dragStartY) / rect.height) * 100;

        const newX = Math.max(-20, Math.min(120, Math.round((state.initialPosX + dxPercent) * 10) / 10));
        const newY = Math.max(-20, Math.min(120, Math.round((state.initialPosY + dyPercent) * 10) / 10));

        applyPropertyChangeToTarget(target.item, 'x', newX);
        applyPropertyChangeToTarget(target.item, 'y', newY);

        updateTextOverlayPreview();
        updateOverlayPreview();
        updateCanvasTransformBox();
        
        if (state.useCanvasRenderer) {
            renderScene(state.playheadTime);
        }
    }

    function onBoxMouseUp() {
        if (state.isBoxDragging) {
            state.isBoxDragging = false;
            document.removeEventListener('mousemove', onBoxMouseMove);
            document.removeEventListener('mouseup', onBoxMouseUp);
            document.removeEventListener('touchmove', onBoxMouseMove);
            document.removeEventListener('touchend', onBoxMouseUp);
            document.removeEventListener('touchcancel', onBoxMouseUp);
            pushHistory();
            renderTimeline();
            updateKeyframeDiamondButton();
            saveDocument();
        }
    }

    function onResizeMouseMove(e) {
        if (!state.isHandleResizing) return;
        const target = getSelectedTarget();
        if (!target) return;

        e.preventDefault();
        const pt = getXY(e);
        const rect = previewContainer.getBoundingClientRect();
        if (rect.width === 0) return;

        const dx = pt.x - state.dragStartX;
        const deltaScale = (dx / rect.width) * 100 * (state.resizeHandleType && state.resizeHandleType.includes('r') ? 1 : -1);
        const newScale = Math.max(5, Math.min(300, Math.round(state.initialScale + deltaScale)));

        applyPropertyChangeToTarget(target.item, 'scale', newScale / 100);

        updateTextOverlayPreview();
        updateOverlayPreview();
        updateCanvasTransformBox();

        if (state.useCanvasRenderer) {
            renderScene(state.playheadTime);
        }
    }

    function onResizeMouseUp() {
        if (state.isHandleResizing) {
            state.isHandleResizing = false;
            document.removeEventListener('mousemove', onResizeMouseMove);
            document.removeEventListener('mouseup', onResizeMouseUp);
            document.removeEventListener('touchmove', onResizeMouseMove);
            document.removeEventListener('touchend', onResizeMouseUp);
            document.removeEventListener('touchcancel', onResizeMouseUp);
            pushHistory();
            renderTimeline();
            updateKeyframeDiamondButton();
            saveDocument();
        }
    }

    // Tap/Click on Canvas to Select Text, Stickers, Overlays, or Subtitles
    previewContainer.addEventListener('click', (e) => {
        if (e.target.closest('#cupcat-canvas-active-box') || e.target.closest('#cupcat-crop-box')) return;
        const rect = previewContainer.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const clickX = ((e.clientX - rect.left) / rect.width) * 100;
        const clickY = ((e.clientY - rect.top) / rect.height) * 100;

        // 1. Check Text Overlays
        const activeTexts = (state.textOverlays || []).filter(t => state.playheadTime >= t.startTime && state.playheadTime <= t.endTime);
        for (let i = activeTexts.length - 1; i >= 0; i--) {
            const txt = activeTexts[i];
            const bounds = txt._lastRenderBounds;
            const posX = bounds ? bounds.posX : (txt.posX !== undefined ? txt.posX : 50);
            const posY = bounds ? bounds.posY : (txt.posY !== undefined ? txt.posY : (txt.position === 'top' ? 12 : (txt.position === 'center' ? 50 : 88)));
            const boxW = bounds ? (bounds.boxW / rect.width) * 100 : 35;
            const boxH = bounds ? (bounds.boxH / rect.height) * 100 : 15;

            if (clickX >= posX - boxW / 2 - 5 && clickX <= posX + boxW / 2 + 5 &&
                clickY >= posY - boxH / 2 - 5 && clickY <= posY + boxH / 2 + 5) {
                state.selectedTextId = txt.id;
                state.selectedSubtitleId = null;
                state.selectedOverlayId = null;
                state.selectedClipId = null;
                state.selectedAudioId = null;
                renderTimeline();
                updateKeyframeDiamondButton();
                updateCanvasTransformBox();
                return;
            }
        }

        // 2. Check Overlays & Stickers
        const activeOverlays = (state.overlayTracks || []).filter(o => state.playheadTime >= o.startTime && state.playheadTime <= o.endTime);
        for (let i = activeOverlays.length - 1; i >= 0; i--) {
            const ovl = activeOverlays[i];
            const bounds = ovl._lastRenderBounds;
            const posX = bounds ? bounds.posX : (ovl.posX !== undefined ? ovl.posX : 50);
            const posY = bounds ? bounds.posY : (ovl.posY !== undefined ? ovl.posY : 50);
            const boxW = bounds ? (bounds.boxW / rect.width) * 100 : (ovl.scale || 30);
            const boxH = bounds ? (bounds.boxH / rect.height) * 100 : (ovl.scale || 30);

            if (clickX >= posX - boxW / 2 - 5 && clickX <= posX + boxW / 2 + 5 &&
                clickY >= posY - boxH / 2 - 5 && clickY <= posY + boxH / 2 + 5) {
                state.selectedOverlayId = ovl.id;
                state.selectedSubtitleId = null;
                state.selectedTextId = null;
                state.selectedClipId = null;
                state.selectedAudioId = null;
                renderTimeline();
                updateKeyframeDiamondButton();
                updateCanvasTransformBox();
                return;
            }
        }

        // 3. Check Subtitles
        const activeSubs = (state.subtitleTracks || []).filter(s => state.playheadTime >= s.startTime && state.playheadTime <= s.endTime);
        for (let i = activeSubs.length - 1; i >= 0; i--) {
            const sub = activeSubs[i];
            const bounds = sub._lastRenderBounds;
            const posX = bounds ? bounds.posX : (sub.posX !== undefined ? sub.posX : 50);
            const posY = bounds ? bounds.posY : (sub.posY !== undefined ? sub.posY : 88);
            const subW = bounds ? (bounds.boxW / rect.width) * 100 : 40;
            const subH = bounds ? (bounds.boxH / rect.height) * 100 : 15;

            if (clickX >= posX - subW / 2 - 5 && clickX <= posX + subW / 2 + 5 &&
                clickY >= posY - subH / 2 - 5 && clickY <= posY + subH / 2 + 5) {
                state.selectedSubtitleId = sub.id;
                state.selectedClipId = null;
                state.selectedAudioId = null;
                state.selectedOverlayId = null;
                state.selectedTextId = null;
                renderTimeline();
                updateKeyframeDiamondButton();
                updateCanvasTransformBox();
                return;
            }
        }
    });

    // Quick Action Handlers
    const delBtn = document.getElementById('cupcat-box-delete-btn');
    if (delBtn) {
        const onDel = (e) => {
            e.preventDefault();
            e.stopPropagation();
            deleteSelected();
        };
        delBtn.addEventListener('mousedown', onDel);
        delBtn.addEventListener('touchstart', onDel, { passive: false });
    }

    const editBtn = document.getElementById('cupcat-box-edit-btn');
    if (editBtn) {
        const onEdit = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (state.selectedSubtitleId && openSubtitleInspector) {
                openSubtitleInspector(state.selectedSubtitleId, 'text');
            } else if (state.selectedTextId && openTextModalForEdit) {
                openTextModalForEdit(state.selectedTextId);
            }
        };
        editBtn.addEventListener('mousedown', onEdit);
        editBtn.addEventListener('touchstart', onEdit, { passive: false });
    }

    const styleBtn = document.getElementById('cupcat-box-style-btn');
    if (styleBtn) {
        const onStyle = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (state.selectedSubtitleId && openSubtitleInspector) {
                openSubtitleInspector(state.selectedSubtitleId, 'style');
            }
        };
        styleBtn.addEventListener('mousedown', onStyle);
        styleBtn.addEventListener('touchstart', onStyle, { passive: false });
    }

    const syncBtn = document.getElementById('cupcat-box-sync-btn');
    if (syncBtn) {
        const onSync = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (toggleSubApplyToAll) {
                toggleSubApplyToAll();
            } else {
                state.subApplyToAll = !state.subApplyToAll;
                updateCanvasTransformBox();
            }
        };
        syncBtn.addEventListener('mousedown', onSync);
        syncBtn.addEventListener('touchstart', onSync, { passive: false });
    }

    const splitBtn = document.getElementById('cupcat-box-split-btn');
    if (splitBtn) {
        const onSplit = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (state.selectedSubtitleId && splitSubtitleAtPlayhead) {
                splitSubtitleAtPlayhead(state.selectedSubtitleId);
            }
        };
        splitBtn.addEventListener('mousedown', onSplit);
        splitBtn.addEventListener('touchstart', onSplit, { passive: false });
    }
}
export function toggleCropMode() {
    const target = getSelectedTarget();
    if (!target || target.type !== 'clip') {
        if (window.showToast) window.showToast('Select a video clip to crop', false);
        state.isCropping = false;
        updateCropBoxUI();
        return;
    }
    state.isCropping = !state.isCropping;
    
    // Set default crop if missing
    if (state.isCropping && !target.item.crop) {
        target.item.crop = { top: 0, bottom: 0, left: 0, right: 0 };
    }
    
    // Toggle active box off when cropping, and vice versa
    if (state.isCropping) {
        const activeBox = document.getElementById('cupcat-canvas-active-box');
        if (activeBox) activeBox.style.display = 'none';
        if (window.showToast) window.showToast('Drag edges to crop video', false);
    } else {
        updateCanvasTransformBox();
    }
    
    updateCropBoxUI();
}

export function updateCropBoxUI() {
    const box = document.getElementById('cupcat-crop-box');
    if (!box) return;

    if (!state.isCropping) {
        box.style.display = 'none';
        return;
    }

    const target = getSelectedTarget();
    if (!target || target.type !== 'clip') {
        box.style.display = 'none';
        state.isCropping = false;
        return;
    }

    const item = target.item;
    if (!item.crop) item.crop = { top: 0, bottom: 0, left: 0, right: 0 };

    // For main video clips, the video fills the entire canvas (cover-fit).
    // The crop box represents the visible portion of the source after cropping.
    // We position the box to show the crop inset relative to the full canvas.
    const cropL = item.crop.left || 0;
    const cropT = item.crop.top || 0;
    const cropR = item.crop.right || 0;
    const cropB = item.crop.bottom || 0;

    box.style.display = 'block';
    box.style.left = `${cropL}%`;
    box.style.top = `${cropT}%`;
    box.style.width = `${100 - cropL - cropR}%`;
    box.style.height = `${100 - cropT - cropB}%`;
    box.style.transform = 'none';
}

export function bindCropBox() {
    const box = document.getElementById('cupcat-crop-box');
    if (!box) return;

    function getXY(e) {
        if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (e.changedTouches && e.changedTouches.length > 0) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        return { x: e.clientX, y: e.clientY };
    }

    let dragEdge = null;
    let startVal = 0;
    let startX = 0;
    let startY = 0;

    document.querySelectorAll('.cupcat-crop-handle').forEach(handle => {
        function onStart(e) {
            const target = getSelectedTarget();
            if (!target || target.type !== 'clip') return;
            
            dragEdge = handle.dataset.edge;
            if (!target.item.crop) target.item.crop = { top: 0, bottom: 0, left: 0, right: 0 };
            startVal = target.item.crop[dragEdge];
            
            const pt = getXY(e);
            startX = pt.x;
            startY = pt.y;
            
            e.preventDefault();
            e.stopPropagation();
            if (pushHistory) pushHistory();
            
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
            document.addEventListener('touchcancel', onEnd);
        }
        handle.addEventListener('mousedown', onStart);
        handle.addEventListener('touchstart', onStart, { passive: false });
    });

    function onMove(e) {
        if (!dragEdge) return;
        const target = getSelectedTarget();
        if (!target) return;
        
        e.preventDefault();
        const pt = getXY(e);
        const previewContainer = document.getElementById('cupcat-canvas');
        const rect = previewContainer.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        
        // Map pixel delta to percentage of canvas
        const dxPercent = ((pt.x - startX) / rect.width) * 100;
        const dyPercent = ((pt.y - startY) / rect.height) * 100;
        
        const crop = target.item.crop;
        
        if (dragEdge === 'top') {
            crop.top = Math.max(0, Math.min(100 - crop.bottom - 5, startVal + dyPercent));
        } else if (dragEdge === 'bottom') {
            crop.bottom = Math.max(0, Math.min(100 - crop.top - 5, startVal - dyPercent));
        } else if (dragEdge === 'left') {
            crop.left = Math.max(0, Math.min(100 - crop.right - 5, startVal + dxPercent));
        } else if (dragEdge === 'right') {
            crop.right = Math.max(0, Math.min(100 - crop.left - 5, startVal - dxPercent));
        }
        
        updateCropBoxUI();
        // Re-render canvas to show the crop result live
        if (state.useCanvasRenderer) {
            renderScene(state.playheadTime);
        }
    }

    function onEnd() {
        if (dragEdge) {
            dragEdge = null;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            document.removeEventListener('touchcancel', onEnd);
            if (saveDocument) saveDocument();
            // Final render to ensure preview is up to date
            if (state.useCanvasRenderer) {
                renderScene(state.playheadTime);
            }
        }
    }
}
