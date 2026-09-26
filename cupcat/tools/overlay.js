import { state } from '../state.js';
import { generateId, getTotalDuration, getMaxTimelineDuration, getClipDuration, getClipStartTime, formatTime, getMediaDuration } from '../utils.js';
import { pushHistory } from '../history.js';
import { renderScene } from '../render-scene.js';

// Late bindings
let renderTimeline = () => {};
let saveDocument = () => {};
let updateKeyframeDiamondButton = () => {};
let updateCanvasTransformBox = () => {};
let updateImageSettingsButton = () => {};
let getInterpolatedKeyframe = (...args) => {};
let updatePreview = () => {};

export function setOverlayCallbacks(cbs) {
    if (cbs.renderTimeline) renderTimeline = cbs.renderTimeline;
    if (cbs.saveDocument) saveDocument = cbs.saveDocument;
    if (cbs.updateKeyframeDiamondButton) updateKeyframeDiamondButton = cbs.updateKeyframeDiamondButton;
    if (cbs.updateCanvasTransformBox) updateCanvasTransformBox = cbs.updateCanvasTransformBox;
    if (cbs.updateImageSettingsButton) updateImageSettingsButton = cbs.updateImageSettingsButton;
    if (cbs.getInterpolatedKeyframe) getInterpolatedKeyframe = cbs.getInterpolatedKeyframe;
    if (cbs.updatePreview) updatePreview = cbs.updatePreview;
}

const OVERLAY_POS_MAP = {
    'top-left':      { x: 5,  y: 5 },
    'top-center':    { x: 50, y: 5 },
    'top-right':     { x: 95, y: 5 },
    'center-left':   { x: 5,  y: 50 },
    'center':        { x: 50, y: 50 },
    'center-right':  { x: 95, y: 50 },
    'bottom-left':   { x: 5,  y: 95 },
    'bottom-center': { x: 50, y: 95 },
    'bottom-right':  { x: 95, y: 95 },
};

export function openOverlayModal() {
    state.overlayModalFile = null;
    state.overlayModalEditId = null;
    const modal = document.getElementById('cupcat-overlay-modal');
    modal.style.display = 'flex';
    document.getElementById('cupcat-overlay-file-label').textContent = 'Click to select image or video file';
    document.getElementById('cupcat-overlay-start').value = state.playheadTime.toFixed(1);
    document.getElementById('cupcat-overlay-end').value = Math.min(state.playheadTime + 5, getTotalDuration() || 10).toFixed(1);
    document.getElementById('cupcat-overlay-x').value = 50;
    document.getElementById('cupcat-overlay-y').value = 50;
    document.getElementById('cupcat-overlay-x-val').textContent = '50%';
    document.getElementById('cupcat-overlay-y-val').textContent = '50%';
    document.getElementById('cupcat-overlay-scale').value = 30;
    document.getElementById('cupcat-overlay-scale-val').textContent = '30%';
    document.getElementById('cupcat-overlay-opacity').value = 100;
    document.getElementById('cupcat-overlay-opacity-val').textContent = '100%';
    document.getElementById('cupcat-overlay-delete').style.display = 'none';
    document.getElementById('cupcat-overlay-apply').textContent = 'Add Overlay';
    updateOverlayPosButtons('center');
}

export function openOverlayModalForEdit(id) {
    const ovl = state.overlayTracks.find(o => o.id === id);
    if (!ovl) return;
    state.overlayModalEditId = id;
    state.overlayModalFile = ovl.file;
    const modal = document.getElementById('cupcat-overlay-modal');
    modal.style.display = 'flex';
    document.getElementById('cupcat-overlay-file-label').textContent = ovl.name || 'File selected';
    document.getElementById('cupcat-overlay-start').value = (ovl.startTime || 0).toFixed(1);
    document.getElementById('cupcat-overlay-end').value = (ovl.endTime || 5).toFixed(1);
    document.getElementById('cupcat-overlay-x').value = ovl.posX || 50;
    document.getElementById('cupcat-overlay-y').value = ovl.posY || 50;
    document.getElementById('cupcat-overlay-x-val').textContent = (ovl.posX || 50) + '%';
    document.getElementById('cupcat-overlay-y-val').textContent = (ovl.posY || 50) + '%';
    document.getElementById('cupcat-overlay-scale').value = ovl.scale || 30;
    document.getElementById('cupcat-overlay-scale-val').textContent = (ovl.scale || 30) + '%';
    document.getElementById('cupcat-overlay-opacity').value = ovl.opacity !== undefined ? ovl.opacity : 100;
    document.getElementById('cupcat-overlay-opacity-val').textContent = (ovl.opacity !== undefined ? ovl.opacity : 100) + '%';
    document.getElementById('cupcat-overlay-delete').style.display = 'flex';
    document.getElementById('cupcat-overlay-apply').textContent = 'Update Overlay';
    updateOverlayPosButtons(ovl.posPreset || 'center');
}

export function closeOverlayModal() {
    document.getElementById('cupcat-overlay-modal').style.display = 'none';
    state.overlayModalFile = null;
    state.overlayModalEditId = null;
}

export function updateOverlayPosButtons(activePreset) {
    document.querySelectorAll('.cupcat-ovl-pos-btn').forEach(btn => {
        const isActive = btn.dataset.pos === activePreset;
        btn.style.background = isActive ? 'rgba(206,147,216,0.25)' : 'rgba(206,147,216,0.08)';
        btn.style.borderColor = isActive ? '#ce93d8' : 'rgba(206,147,216,0.22)';
    });
}

export function selectOverlayPosPreset(preset) {
    const coords = OVERLAY_POS_MAP[preset];
    if (!coords) return;
    document.getElementById('cupcat-overlay-x').value = coords.x;
    document.getElementById('cupcat-overlay-y').value = coords.y;
    document.getElementById('cupcat-overlay-x-val').textContent = coords.x + '%';
    document.getElementById('cupcat-overlay-y-val').textContent = coords.y + '%';
    updateOverlayPosButtons(preset);
}

export async function applyOverlay() {
    if (!state.overlayModalFile && !state.overlayModalEditId) {
        if (window.showToast) window.showToast('Please select a file first.', true);
        return;
    }
    pushHistory();
    const startTime = parseFloat(document.getElementById('cupcat-overlay-start').value) || 0;
    const endTime = parseFloat(document.getElementById('cupcat-overlay-end').value) || 5;
    const posX = parseInt(document.getElementById('cupcat-overlay-x').value) || 50;
    const posY = parseInt(document.getElementById('cupcat-overlay-y').value) || 50;
    const scale = parseInt(document.getElementById('cupcat-overlay-scale').value) || 30;
    const opacity = parseInt(document.getElementById('cupcat-overlay-opacity').value);
    // Find which preset matches
    let posPreset = 'custom';
    for (const [key, val] of Object.entries(OVERLAY_POS_MAP)) {
        if (val.x === posX && val.y === posY) { posPreset = key; break; }
    }

    if (state.overlayModalEditId) {
        // Update existing
        const ovl = state.overlayTracks.find(o => o.id === state.overlayModalEditId);
        if (ovl) {
            if (state.overlayModalFile && state.overlayModalFile !== ovl.file) {
                if (ovl.objectUrl) URL.revokeObjectURL(ovl.objectUrl);
                ovl.file = state.overlayModalFile;
                ovl.name = state.overlayModalFile.name;
                ovl.objectUrl = URL.createObjectURL(state.overlayModalFile);
                const info = await getMediaDuration(state.overlayModalFile);
                ovl.duration = info.duration;
                ovl.isImage = !!info.isImage;
            }
            ovl.startTime = startTime;
            ovl.endTime = endTime;
            ovl.posX = posX;
            ovl.posY = posY;
            ovl.posPreset = posPreset;
            ovl.scale = scale;
            ovl.opacity = opacity;
        }
    } else {
        // Add new
        const info = await getMediaDuration(state.overlayModalFile);
        const newId = generateId();
        state.overlayTracks.push({
            id: newId,
            file: state.overlayModalFile,
            name: state.overlayModalFile.name,
            objectUrl: URL.createObjectURL(state.overlayModalFile),
            duration: info.duration,
            isImage: !!info.isImage,
            startTime,
            endTime,
            posX,
            posY,
            posPreset,
            scale,
            opacity,
        });
        state.selectedOverlayId = newId;
        state.selectedClipId = null;
        state.selectedAudioId = null;
        state.selectedTextId = null;
    }
    closeOverlayModal();
    renderTimeline();
    updateOverlayPreview();
    updateCanvasTransformBox();
    saveDocument();
}

export function deleteOverlay() {
    if (!state.overlayModalEditId) return;
    pushHistory();
    const idx = state.overlayTracks.findIndex(o => o.id === state.overlayModalEditId);
    if (idx !== -1) {
        if (state.overlayTracks[idx].objectUrl) URL.revokeObjectURL(state.overlayTracks[idx].objectUrl);
        state.overlayTracks.splice(idx, 1);
    }
    if (state.selectedOverlayId === state.overlayModalEditId) state.selectedOverlayId = null;
    closeOverlayModal();
    renderTimeline();
    updateOverlayPreview();
    saveDocument();
}

export function renderOverlayTrack() {
    const container = document.getElementById('cupcat-overlay-tracks-container');
    if (!container) return;
    container.innerHTML = '';
    if (state.overlayTracks.length === 0) return;

    const totalDur = Math.max(getMaxTimelineDuration(), 10);
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; padding: 4px 0 4px 4px; min-height: 40px;';

    const label = document.createElement('div');
    label.style.cssText = 'width: 28px; flex-shrink: 0; font-size: 10px; color: #ce93d8; writing-mode: vertical-lr; text-orientation: mixed; text-align: center; font-weight: 700; letter-spacing: 1px;';
    label.textContent = 'OVL';
    row.appendChild(label);

    const trackEl = document.createElement('div');
    trackEl.style.cssText = `display: flex; align-items: center; height: 36px; position: relative; flex-shrink: 0; width: ${totalDur * state.timelineZoom + Math.max(window.innerWidth * 0.5, 200)}px;`;

    state.overlayTracks.forEach(ovl => {
        const dur = (ovl.endTime || 0) - (ovl.startTime || 0);
        const left = (ovl.startTime || 0) * state.timelineZoom;
        const w = Math.max(dur * state.timelineZoom, 4);
        const isSelected = ovl.id === state.selectedOverlayId;

        const el = document.createElement('div');
        el.style.cssText = `
            position: absolute; left: ${left}px; width: ${w}px;
            height: 32px; border-radius: 6px;
            background: ${isSelected ? 'rgba(206,147,216,0.35)' : 'rgba(156,39,176,0.18)'};
            border: 1.5px solid ${isSelected ? '#ce93d8' : 'rgba(156,39,176,0.4)'};
            display: flex; align-items: center; padding: 0 6px;
            cursor: pointer; overflow: hidden;
            font-size: 10px; color: #ce93d8; font-weight: 600;
        `;
        // Keyframe diamond markers
        if (ovl.keyframes && ovl.keyframes.length > 0) {
            ovl.keyframes.forEach(kf => {
                const kfPos = (kf.time - ovl.startTime) * state.timelineZoom;
                if (kfPos >= 0 && kfPos <= w) {
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

        // Trim handles
        if (isSelected) {
            const leftHandle = document.createElement('div');
            leftHandle.className = 'cupcat-trim-handle-left';
            leftHandle.style.cssText = `
                position: absolute; left: 0; top: 0; bottom: 0; width: 8px;
                background: #ce93d8; cursor: ew-resize; z-index: 5;
                border-radius: 6px 0 0 6px;
                display: flex; align-items: center; justify-content: center;
            `;
            leftHandle.innerHTML = '<div style="width:2px;height:16px;background:rgba(255,255,255,0.5);border-radius:1px;"></div>';
            el.appendChild(leftHandle);

            const rightHandle = document.createElement('div');
            rightHandle.className = 'cupcat-trim-handle-right';
            rightHandle.style.cssText = `
                position: absolute; right: 0; top: 0; bottom: 0; width: 8px;
                background: #ba68c8; cursor: ew-resize; z-index: 5;
                border-radius: 0 6px 6px 0;
                display: flex; align-items: center; justify-content: center;
            `;
            rightHandle.innerHTML = '<div style="width:2px;height:16px;background:rgba(255,255,255,0.5);border-radius:1px;"></div>';
            el.appendChild(rightHandle);

            bindOverlayTrimHandle(leftHandle, ovl, 'start', el);
            bindOverlayTrimHandle(rightHandle, ovl, 'end', el);
        }

        el.addEventListener('click', (e) => {
            if (e.target.closest('.cupcat-trim-handle-left') || e.target.closest('.cupcat-trim-handle-right')) return;
            state.selectedOverlayId = ovl.id;
            state.selectedClipId = null;
            state.selectedAudioId = null;
            state.selectedTextId = null;
            renderTimeline();
            updateImageSettingsButton();
            updateKeyframeDiamondButton();
            updateCanvasTransformBox();
        });

        el.addEventListener('dblclick', () => {
            state.selectedOverlayId = ovl.id;
            openOverlayModalForEdit(ovl.id);
        });

        // Drag overlay horizontally
        let ovlDragStartX = 0;
        let ovlDragStartOffset = 0;
        let ovlDragged = false;
        
        el.addEventListener('mousedown', startOvlDrag);
        el.addEventListener('touchstart', startOvlDrag, { passive: false });

        function startOvlDrag(e) {
            if (e.target.closest('.cupcat-trim-handle-left') || e.target.closest('.cupcat-trim-handle-right')) return;
            if (e.type === 'mousedown' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            
            state.selectedOverlayId = ovl.id;
            state.selectedClipId = null;
            state.selectedAudioId = null;
            state.selectedTextId = null;
            
            // Visual selection
            document.querySelectorAll('.cupcat-overlay-track > div').forEach(node => {
                node.style.borderColor = 'rgba(156,39,176,0.4)';
                node.style.background = 'rgba(156,39,176,0.18)';
            });
            el.style.borderColor = '#ce93d8';
            el.style.background = 'rgba(206,147,216,0.35)';
            
            updateImageSettingsButton();
            updateKeyframeDiamondButton();
            updateCanvasTransformBox();

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            ovlDragStartX = clientX;
            ovlDragStartOffset = ovl.startTime || 0;
            ovlDragged = false;

            function onMove(me) {
                const cx = me.touches ? me.touches[0].clientX : me.clientX;
                const dx = cx - ovlDragStartX;
                if (Math.abs(dx) > 3) {
                    if (!ovlDragged) {
                        ovlDragged = true;
                        if (pushHistory) pushHistory();
                    }
                    const dur = (ovl.endTime || 0) - (ovl.startTime || 0);
                    const shift = dx / state.timelineZoom;
                    
                    const newStartTime = Math.max(0, ovlDragStartOffset + shift);
                    const timeDelta = newStartTime - (ovl.startTime || 0);
                    
                    ovl.startTime = newStartTime;
                    ovl.endTime = ovl.startTime + dur;
                    
                    if (ovl.keyframes && timeDelta !== 0) {
                        ovl.keyframes.forEach(kf => { kf.time += timeDelta; });
                    }
                    
                    el.style.left = (ovl.startTime * state.timelineZoom) + 'px';
                }
            }
            
            function onEnd() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onEnd);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);
                if (ovlDragged) {
                    if (saveDocument) saveDocument();
                }
                renderTimeline();
                updateOverlayPreview();
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

function bindOverlayTrimHandle(handle, ovl, side, ovlEl) {
    let startX = 0;
    let startVal = 0;

    function onStart(e) {
        e.preventDefault();
        e.stopPropagation();
        startX = e.touches ? e.touches[0].clientX : e.clientX;
        startVal = side === 'start' ? (ovl.startTime || 0) : (ovl.endTime || 0);
        
        if (pushHistory) pushHistory();
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
            ovl.startTime = Math.max(0, Math.min((ovl.endTime || 0) - 0.1, startVal + dt));
        } else {
            ovl.endTime = Math.max((ovl.startTime || 0) + 0.1, startVal + dt);
        }

        if (ovlEl) {
            const w = (ovl.endTime - ovl.startTime) * state.timelineZoom;
            ovlEl.style.width = Math.max(w, 4) + 'px';
            ovlEl.style.left = (ovl.startTime * state.timelineZoom) + 'px';
        }
    }

    function onEnd() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);
        renderTimeline();
        if (saveDocument) saveDocument();
    }

    handle.addEventListener('mousedown', onStart);
    handle.addEventListener('touchstart', onStart, { passive: false });
}

export function updateOverlayPreview() {
    const container = document.getElementById('cupcat-overlay-preview-container');
    if (!container) return;

    // When Canvas renderer is active, overlays are drawn by renderScene → drawOverlays.
    // DOM preview elements must be hidden to prevent double-rendering (ghost stickers).
    if (state.useCanvasRenderer) {
        // Clean up any leftover DOM preview elements
        state.overlayTracks.forEach(ovl => {
            if (ovl._previewEl && ovl._previewEl.parentNode === container) {
                if (!ovl.isImage && ovl._previewEl.tagName === 'VIDEO') {
                    ovl._previewEl.pause();
                }
                container.removeChild(ovl._previewEl);
                ovl._previewEl = null;
            }
        });
        // Remove any orphaned children
        while (container.firstChild) {
            if (container.firstChild.tagName === 'VIDEO') container.firstChild.pause();
            container.removeChild(container.firstChild);
        }
        // Re-render canvas so new/changed overlays appear immediately.
        // Skip during drag — the drag handler already calls renderScene.
        if (!state.isBoxDragging && !state.isHandleResizing) {
            renderScene(state.playheadTime);
        }
        return;
    }

    // Track which overlay IDs are currently active (visible at playhead)
    const activeIds = new Set();

    state.overlayTracks.forEach(ovl => {
        const inRange = state.playheadTime >= ovl.startTime && state.playheadTime <= ovl.endTime && ovl.objectUrl;
        if (!inRange) {
            // Out of range — remove cached preview element if exists
            if (ovl._previewEl) {
                if (!ovl.isImage && ovl._previewEl.tagName === 'VIDEO') {
                    ovl._previewEl.pause();
                }
                if (ovl._previewEl.parentNode) ovl._previewEl.parentNode.removeChild(ovl._previewEl);
                ovl._previewEl = null;
            }
            return;
        }

        activeIds.add(ovl.id);
        const kf = getInterpolatedKeyframe(ovl, state.playheadTime);
        const scalePercent = (kf.scale !== undefined ? kf.scale : (ovl.scale || 30) / 100) * 100;
        const opacityVal = kf.opacity !== undefined ? kf.opacity : ((ovl.opacity !== undefined ? ovl.opacity : 100) / 100);
        const posX = kf.x !== undefined ? kf.x : (ovl.posX !== undefined ? ovl.posX : 50);
        const posY = kf.y !== undefined ? kf.y : (ovl.posY !== undefined ? ovl.posY : 50);
        const rot = kf.rotation !== undefined ? kf.rotation : (ovl.rotation || 0);

        const cssText = `
            position: absolute;
            width: ${scalePercent}%;
            left: ${posX}%; top: ${posY}%;
            transform: translate(-50%, -50%) rotate(${rot}deg);
            opacity: ${opacityVal};
            pointer-events: none;
            border-radius: 4px;
            object-fit: contain;
        `;

        if (!ovl._previewEl) {
            // Create the element for the first time
            const el = document.createElement(ovl.isImage ? 'img' : 'video');
            el.style.cssText = cssText;
            el.dataset.overlayId = ovl.id;

            if (ovl.isImage) {
                el.src = ovl.objectUrl;
            } else {
                el.src = ovl.objectUrl;
                el.muted = true;
                el.playsInline = true;
                el.currentTime = Math.max(0, state.playheadTime - ovl.startTime);
                if (state.isPlaying) {
                    el.play().catch(() => {});
                }
            }

            container.appendChild(el);
            ovl._previewEl = el;
        } else {
            // Update existing element's position/scale/opacity
            ovl._previewEl.style.cssText = cssText;

            // For videos: sync time and play state
            if (!ovl.isImage && ovl._previewEl.tagName === 'VIDEO') {
                const expectedTime = Math.max(0, state.playheadTime - ovl.startTime);
                // Only seek if drift exceeds 0.3s to avoid constant seeking
                if (Math.abs(ovl._previewEl.currentTime - expectedTime) > 0.3) {
                    ovl._previewEl.currentTime = expectedTime;
                }
                if (state.isPlaying && ovl._previewEl.paused) {
                    ovl._previewEl.play().catch(() => {});
                } else if (!state.isPlaying && !ovl._previewEl.paused) {
                    ovl._previewEl.pause();
                    ovl._previewEl.currentTime = expectedTime;
                }
            }
        }
    });

    // Remove orphaned DOM elements (from deleted overlays)
    Array.from(container.children).forEach(child => {
        if (child.dataset.overlayId && !activeIds.has(child.dataset.overlayId)) {
            if (child.tagName === 'VIDEO') child.pause();
            container.removeChild(child);
        }
    });
}
