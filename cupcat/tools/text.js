import { state } from '../state.js';
import { generateId, getTotalDuration, getMaxTimelineDuration, formatTime, getClipDuration, getClipStartTime } from '../utils.js';
import { pushHistory } from '../history.js';

let renderTimeline = () => {};
let updatePreview = () => {};
let saveDocument = () => {};
let updateKeyframeDiamondButton = () => {};
let updateImageSettingsButton = () => {};
let updateCanvasTransformBox = () => {};
let getInterpolatedKeyframe = () => ({});

export function setTextCallbacks(callbacks) {
    if (callbacks.renderTimeline) renderTimeline = callbacks.renderTimeline;
    if (callbacks.updatePreview) updatePreview = callbacks.updatePreview;
    if (callbacks.saveDocument) saveDocument = callbacks.saveDocument;
    if (callbacks.updateKeyframeDiamondButton) updateKeyframeDiamondButton = callbacks.updateKeyframeDiamondButton;
    if (callbacks.updateImageSettingsButton) updateImageSettingsButton = callbacks.updateImageSettingsButton;
    if (callbacks.updateCanvasTransformBox) updateCanvasTransformBox = callbacks.updateCanvasTransformBox;
    if (callbacks.getInterpolatedKeyframe) getInterpolatedKeyframe = callbacks.getInterpolatedKeyframe;
}

export function openTextModal() {
    state.textModalIsNew = true;
    state.textModalEditId = null;

    const modal = document.getElementById('cupcat-text-modal');
    modal.style.display = 'flex';

    document.getElementById('cupcat-text-input').value = '';
    document.getElementById('cupcat-text-start').value = state.playheadTime.toFixed(1);
    document.getElementById('cupcat-text-end').value = Math.min(state.playheadTime + 3, Math.max(getTotalDuration(), state.playheadTime + 3)).toFixed(1);
    document.getElementById('cupcat-text-color').value = '#ffffff';
    document.getElementById('cupcat-text-fontsize').value = 36;
    document.getElementById('cupcat-text-fontsize-val').textContent = '36px';
    document.getElementById('cupcat-text-font').value = 'Inter';
    state.textModalPosition = 'bottom';
    updateTextPositionButtons();
}

export function openTextModalForEdit(id) {
    const overlay = state.textOverlays.find(t => t.id === id);
    if (!overlay) return;

    state.textModalIsNew = false;
    state.textModalEditId = id;

    const modal = document.getElementById('cupcat-text-modal');
    modal.style.display = 'flex';

    document.getElementById('cupcat-text-input').value = overlay.text || '';
    document.getElementById('cupcat-text-start').value = (overlay.startTime || 0).toFixed(1);
    document.getElementById('cupcat-text-end').value = (overlay.endTime || 3).toFixed(1);
    document.getElementById('cupcat-text-color').value = overlay.color || '#ffffff';
    document.getElementById('cupcat-text-fontsize').value = overlay.fontSize || 36;
    document.getElementById('cupcat-text-fontsize-val').textContent = (overlay.fontSize || 36) + 'px';
    document.getElementById('cupcat-text-font').value = overlay.font || 'Inter';
    state.textModalPosition = overlay.position || 'bottom';
    updateTextPositionButtons();
}

export function closeTextModal() {
    document.getElementById('cupcat-text-modal').style.display = 'none';
    state.textModalIsNew = false;
    state.textModalEditId = null;
}

export function applyText() {
    const text = document.getElementById('cupcat-text-input').value.trim();
    if (!text) {
        if (window.showToast) window.showToast('Enter some text', false);
        return;
    }

    const startTime = Math.max(0, parseFloat(document.getElementById('cupcat-text-start').value) || 0);
    const endTime = Math.max(startTime + 0.1, parseFloat(document.getElementById('cupcat-text-end').value) || 3);
    const color = document.getElementById('cupcat-text-color').value || '#ffffff';
    const fontSize = parseInt(document.getElementById('cupcat-text-fontsize').value) || 36;
    const font = document.getElementById('cupcat-text-font').value || 'Inter';

    pushHistory();

    if (state.textModalIsNew) {
        const newId = generateId();
        state.textOverlays.push({
            id: newId,
            text,
            startTime,
            endTime,
            position: state.textModalPosition,
            color,
            fontSize,
            font,
            posX: 50,
            posY: (state.textModalPosition === 'top') ? 12 : (state.textModalPosition === 'center' ? 50 : 88),
            scale: 100,
            opacity: 100,
            rotation: 0,
            keyframes: [],
        });
        state.selectedTextId = newId;
        state.selectedClipId = null;
        state.selectedAudioId = null;
        state.selectedOverlayId = null;
        if (window.showToast) window.showToast('Text overlay added', false);
    } else if (state.textModalEditId) {
        const overlay = state.textOverlays.find(t => t.id === state.textModalEditId);
        if (overlay) {
            overlay.text = text;
            overlay.startTime = startTime;
            overlay.endTime = endTime;
            overlay.position = state.textModalPosition;
            overlay.color = color;
            overlay.fontSize = fontSize;
            overlay.font = font;
        }
        if (window.showToast) window.showToast('Text overlay updated', false);
    }

    closeTextModal();
    renderTimeline();
    updateTextOverlayPreview();
    updatePreview();
    updateCanvasTransformBox();
    saveDocument();
}

export function updateTextPositionButtons() {
    document.querySelectorAll('.cupcat-text-pos-btn').forEach(btn => {
        const isActive = btn.dataset.pos === state.textModalPosition;
        btn.style.background = isActive ? 'rgba(255,110,64,0.25)' : 'rgba(255,110,64,0.08)';
        btn.style.borderColor = isActive ? '#ff6e40' : 'rgba(255,110,64,0.22)';
    });
}

export function renderTextTrack() {
    const container = document.getElementById('cupcat-text-tracks-container');
    if (!container) return;
    container.innerHTML = '';

    if (state.textOverlays.length === 0) return;

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
        font-size: 9px; color: #ff6e40;
        writing-mode: vertical-lr; text-orientation: mixed;
        text-align: center; font-weight: 700; letter-spacing: 1px;
    `;
    rowLabel.textContent = 'TXT';
    row.appendChild(rowLabel);

    const trackEl = document.createElement('div');
    trackEl.style.cssText = `
        position: relative; height: 36px; flex-shrink: 0;
        width: ${totalDur * state.timelineZoom + Math.max(window.innerWidth * 0.5, 200)}px;
    `;

    state.textOverlays.forEach(overlay => {
        const startPx = overlay.startTime * state.timelineZoom;
        const durPx = Math.max((overlay.endTime - overlay.startTime) * state.timelineZoom, 4);
        const isSelected = overlay.id === state.selectedTextId;

        const el = document.createElement('div');
        el.dataset.textId = overlay.id;
        el.style.cssText = `
            position: absolute; left: ${startPx}px; top: 0;
            width: ${durPx}px; height: 36px;
            background: ${isSelected
                ? 'linear-gradient(135deg, rgba(255,110,64,0.25), rgba(255,61,0,0.25))'
                : 'linear-gradient(135deg, rgba(255,110,64,0.10), rgba(255,61,0,0.10))'
            };
            border: 1.5px solid ${isSelected ? '#ff6e40' : 'rgba(255,110,64,0.3)'};
            border-radius: 6px; cursor: pointer;
            display: flex; align-items: center;
            overflow: hidden; user-select: none;
        `;

        const label = document.createElement('div');
        label.style.cssText = `
            padding: 0 8px; overflow: hidden;
            white-space: nowrap; text-overflow: ellipsis;
            font-size: 10px; font-weight: 600; color: rgba(255,255,255,0.7);
            pointer-events: none;
        `;
        label.textContent = '\u270f\ufe0f ' + (overlay.text || '').substring(0, 20);
        el.appendChild(label);

        // Keyframe diamond markers
        if (overlay.keyframes && overlay.keyframes.length > 0) {
            overlay.keyframes.forEach(kf => {
                const kfPos = (kf.time - overlay.startTime) * state.timelineZoom;
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

        if (durPx > 40) {
            const badge = document.createElement('div');
            badge.style.cssText = `
                position: absolute; bottom: 2px; right: 4px;
                font-size: 8px; color: rgba(255,255,255,0.4);
                font-variant-numeric: tabular-nums; z-index: 2;
            `;
            badge.textContent = formatTime(overlay.endTime - overlay.startTime);
            el.appendChild(badge);
        }

        // Trim handles
        if (isSelected) {
            const leftHandle = document.createElement('div');
            leftHandle.className = 'cupcat-trim-handle-left';
            leftHandle.style.cssText = `
                position: absolute; left: 0; top: 0; bottom: 0; width: 8px;
                background: #00b0ff; cursor: ew-resize; z-index: 5;
                border-radius: 6px 0 0 6px;
                display: flex; align-items: center; justify-content: center;
            `;
            leftHandle.innerHTML = '<div style="width:2px;height:16px;background:rgba(255,255,255,0.5);border-radius:1px;"></div>';
            el.appendChild(leftHandle);

            const rightHandle = document.createElement('div');
            rightHandle.className = 'cupcat-trim-handle-right';
            rightHandle.style.cssText = `
                position: absolute; right: 0; top: 0; bottom: 0; width: 8px;
                background: #0091ea; cursor: ew-resize; z-index: 5;
                border-radius: 0 6px 6px 0;
                display: flex; align-items: center; justify-content: center;
            `;
            rightHandle.innerHTML = '<div style="width:2px;height:16px;background:rgba(255,255,255,0.5);border-radius:1px;"></div>';
            el.appendChild(rightHandle);

            bindTextTrimHandle(leftHandle, overlay, 'start', el);
            bindTextTrimHandle(rightHandle, overlay, 'end', el);
        }

        el.addEventListener('click', (e) => {
            if (e.target.closest('.cupcat-trim-handle-left') || e.target.closest('.cupcat-trim-handle-right')) return;
            state.selectedTextId = overlay.id;
            state.selectedClipId = null;
            state.selectedAudioId = null;
            state.selectedOverlayId = null;
            renderTimeline();
            updateImageSettingsButton();
            updateKeyframeDiamondButton();
            updateCanvasTransformBox();
        });

        el.addEventListener('dblclick', () => {
            state.selectedTextId = overlay.id;
            openTextModalForEdit(overlay.id);
        });

        // Drag text horizontally
        let textDragStartX = 0;
        let textDragStartOffset = 0;
        let textDragged = false;
        
        el.addEventListener('mousedown', startTextDrag);
        el.addEventListener('touchstart', startTextDrag, { passive: false });

        function startTextDrag(e) {
            if (e.target.closest('.cupcat-trim-handle-left') || e.target.closest('.cupcat-trim-handle-right')) return;
            if (e.type === 'mousedown' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation(); // prevent timeline panning if any
            
            state.selectedTextId = overlay.id;
            state.selectedClipId = null;
            state.selectedAudioId = null;
            state.selectedOverlayId = null;
            
            // Visual selection styling
            document.querySelectorAll('.cupcat-text-overlay').forEach(node => {
                node.style.borderColor = 'rgba(255,110,64,0.3)';
                node.style.background = 'linear-gradient(135deg, rgba(255,110,64,0.10), rgba(255,61,0,0.10))';
            });
            el.style.borderColor = '#ff6e40';
            el.style.background = 'linear-gradient(135deg, rgba(255,110,64,0.25), rgba(255,61,0,0.25))';
            
            updateImageSettingsButton();
            updateKeyframeDiamondButton();
            updateCanvasTransformBox();

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            textDragStartX = clientX;
            textDragStartOffset = overlay.startTime;
            textDragged = false;

            function onMove(me) {
                const cx = me.touches ? me.touches[0].clientX : me.clientX;
                const dx = cx - textDragStartX;
                if (Math.abs(dx) > 3) {
                    if (!textDragged) {
                        textDragged = true;
                        if (pushHistory) pushHistory();
                    }
                    const dur = overlay.endTime - overlay.startTime;
                    const shift = dx / state.timelineZoom;
                    
                    const newStartTime = Math.max(0, textDragStartOffset + shift);
                    const timeDelta = newStartTime - overlay.startTime;
                    
                    overlay.startTime = newStartTime;
                    overlay.endTime = overlay.startTime + dur;
                    
                    if (overlay.keyframes && timeDelta !== 0) {
                        overlay.keyframes.forEach(kf => { kf.time += timeDelta; });
                    }
                    
                    el.style.left = (overlay.startTime * state.timelineZoom) + 'px';
                }
            }
            
            function onEnd() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onEnd);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);
                if (textDragged) {
                    if (saveDocument) saveDocument();
                }
                renderTimeline();
                updateTextOverlayPreview();
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

function bindTextTrimHandle(handle, text, side, textEl) {
    let startX = 0;
    let startVal = 0;

    function onStart(e) {
        e.preventDefault();
        e.stopPropagation();
        startX = e.touches ? e.touches[0].clientX : e.clientX;
        startVal = side === 'start' ? (text.startTime || 0) : (text.endTime || 0);
        
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
            text.startTime = Math.max(0, Math.min(text.endTime - 0.1, startVal + dt));
        } else {
            text.endTime = Math.max(text.startTime + 0.1, startVal + dt);
        }

        if (textEl) {
            const w = (text.endTime - text.startTime) * state.timelineZoom;
            textEl.style.width = Math.max(w, 4) + 'px';
            textEl.style.left = (text.startTime * state.timelineZoom) + 'px';
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
export function updateTextOverlayPreview() {
    const container = document.getElementById('cupcat-text-overlay-container');
    if (!container) return;
    container.innerHTML = '';
}
