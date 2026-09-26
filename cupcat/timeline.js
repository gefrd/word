import { state } from './state.js';
import { getClipDuration, getTotalDuration, getMaxTimelineDuration, getClipStartTime, getAudioDuration, formatTime, getClipSpeed, getItemVolume } from './utils.js';
import { pushHistory } from './history.js';
import { FILTER_PRESETS } from './constants.js';

let updatePreview;
let updatePreviewAtTime;
let saveDocument;
let updateImageSettingsButton;
let updateKeyframeDiamondButton;
let updateCanvasTransformBox;
let renderOverlayTrack;
let renderTextTrack;
let renderSubtitleTrack;
let splitAtPlayhead;
let getClipFilters;
let getClipTransform;
let openTransitionModal;

export function setTimelineCallbacks(callbacks) {
    if (callbacks.updatePreview) updatePreview = callbacks.updatePreview;
    if (callbacks.updatePreviewAtTime) updatePreviewAtTime = callbacks.updatePreviewAtTime;
    if (callbacks.saveDocument) saveDocument = callbacks.saveDocument;
    if (callbacks.updateImageSettingsButton) updateImageSettingsButton = callbacks.updateImageSettingsButton;
    if (callbacks.updateKeyframeDiamondButton) updateKeyframeDiamondButton = callbacks.updateKeyframeDiamondButton;
    if (callbacks.updateCanvasTransformBox) updateCanvasTransformBox = callbacks.updateCanvasTransformBox;
    if (callbacks.renderOverlayTrack) renderOverlayTrack = callbacks.renderOverlayTrack;
    if (callbacks.renderTextTrack) renderTextTrack = callbacks.renderTextTrack;
    if (callbacks.renderSubtitleTrack) renderSubtitleTrack = callbacks.renderSubtitleTrack;
    if (callbacks.splitAtPlayhead) splitAtPlayhead = callbacks.splitAtPlayhead;
    if (callbacks.getClipFilters) getClipFilters = callbacks.getClipFilters;
    if (callbacks.getClipTransform) getClipTransform = callbacks.getClipTransform;
    if (callbacks.openTransitionModal) openTransitionModal = callbacks.openTransitionModal;
}

export function scrubToClientX(clientX) {
    const tracksInner = document.getElementById('cupcat-tracks-inner');
    if (!tracksInner) return;
    const rect = tracksInner.getBoundingClientRect();
    const x = clientX - rect.left;
    state.playheadTime = Math.max(0, x / state.timelineZoom);
    updatePlayhead();
    if (updatePreviewAtTime) updatePreviewAtTime(state.playheadTime);
}

export function bindRulerDrag(ruler) {
    // Document-level listeners are only attached for the duration of an
    // actual drag (mousedown -> mouseup), and removed on release. This
    // prevents them from piling up on `document` every time the editor
    // is re-initialized (bindEvents runs again on every renderUI()).
    function onStart(e) {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        // Convert ruler position to tracks position
        const rulerInner = document.getElementById('cupcat-ruler-inner');
        if (!rulerInner) return;
        const rect = rulerInner.getBoundingClientRect();
        const x = clientX - rect.left;
        state.playheadTime = Math.max(0, x / state.timelineZoom);
        updatePlayhead();
        if (updatePreviewAtTime) updatePreviewAtTime(state.playheadTime);
        e.preventDefault();

        document.addEventListener('mousemove', onMove);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchend', onEnd);
        document.addEventListener('touchcancel', onEnd);
    }

    function onMove(e) {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const rulerInner = document.getElementById('cupcat-ruler-inner');
        if (!rulerInner) return;
        const rect = rulerInner.getBoundingClientRect();
        const x = clientX - rect.left;
        state.playheadTime = Math.max(0, x / state.timelineZoom);
        updatePlayhead();
        if (updatePreviewAtTime) updatePreviewAtTime(state.playheadTime);
        e.preventDefault();
    }

    function onEnd() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);
    }

    ruler.addEventListener('mousedown', onStart);
    ruler.addEventListener('touchstart', onStart, { passive: false });
}

export function bindPlayheadDrag() {
    const handle = document.getElementById('cupcat-playhead-handle');
    if (!handle) return;

    // Same fix as bindRulerDrag: only listen on `document` while a drag
    // is actually in progress, so repeated editor inits don't leak handlers.
    function onStart(e) {
        handle.style.cursor = 'grabbing';
        e.preventDefault();
        e.stopPropagation();

        document.addEventListener('mousemove', onMove);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchend', onEnd);
        document.addEventListener('touchcancel', onEnd);
    }

    function onMove(e) {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        scrubToClientX(clientX);
        e.preventDefault();
    }

    function onEnd() {
        handle.style.cursor = 'grab';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);
    }

    handle.addEventListener('mousedown', onStart);
    handle.addEventListener('touchstart', onStart, { passive: false });
}

/* ==============================
   TIMELINE RENDERING
   ============================== */

export function renderTimeline() {
    renderRuler();
    renderVideoTrack();
    renderAudioTracks();
    if (renderTextTrack) renderTextTrack();
    if (renderSubtitleTrack) renderSubtitleTrack();
    if (renderOverlayTrack) renderOverlayTrack();
    updatePlayhead();
    updateTimeDisplay();

    // Force the scroll container to be wide enough for ALL tracks + padding.
    // Without this, #cupcat-tracks-inner is a block element (width = parent = screen width)
    // and flex rows inside get shrunk to fit, making the right-side padding invisible.
    const tracksInner = document.getElementById('cupcat-tracks-inner');
    if (tracksInner) {
        const totalDur = Math.max(getMaxTimelineDuration(), 10);
        const fullWidth = totalDur * state.timelineZoom + Math.max(window.innerWidth * 0.5, 200);
        tracksInner.style.minWidth = fullWidth + 'px';
    }
}

export function renderRuler() {
    const rulerInner = document.getElementById('cupcat-ruler-inner');
    if (!rulerInner) return;

    const totalDur = Math.max(getMaxTimelineDuration(), 10);
    const totalWidth = totalDur * state.timelineZoom + Math.max(window.innerWidth * 0.5, 200);
    rulerInner.style.width = totalWidth + 'px';
    rulerInner.innerHTML = '';

    // Draw tick marks
    let step = 1;
    if (state.timelineZoom < 40) step = 5;
    if (state.timelineZoom < 20) step = 10;
    if (state.timelineZoom > 150) step = 0.5;

    for (let t = 0; t <= totalDur + 5; t += step) {
        const x = t * state.timelineZoom;
        const isMajor = t % (step >= 1 ? Math.max(1, Math.round(5 / step) * step) : 1) === 0;
        const tick = document.createElement('div');
        tick.style.cssText = `
            position: absolute; left: ${x}px; top: ${isMajor ? 0 : 10}px;
            width: 1px; height: ${isMajor ? 24 : 14}px;
            background: ${isMajor ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)'};
        `;
        if (isMajor) {
            const label = document.createElement('div');
            label.style.cssText = `
                position: absolute; left: ${x + 4}px; top: 2px;
                font-size: 9px; color: rgba(255,255,255,0.35);
                white-space: nowrap; font-variant-numeric: tabular-nums;
            `;
            label.textContent = formatTime(t);
            rulerInner.appendChild(label);
        }
        rulerInner.appendChild(tick);
    }
}

export function renderVideoTrack() {
    const track = document.getElementById('cupcat-video-track');
    if (!track) return;
    track.innerHTML = '';

    const totalDur = Math.max(getMaxTimelineDuration(), 10);
    track.style.width = (totalDur * state.timelineZoom + Math.max(window.innerWidth * 0.5, 200)) + 'px';

    if (state.videoClips.length === 0) {
        track.innerHTML = `<div style="
            position: absolute; left: 36px; top: 50%; transform: translateY(-50%);
            font-size: 11px; color: #555; font-style: italic;
        ">Drop videos here or click + Video</div>`;
        return;
    }

    state.videoClips.forEach((clip, index) => {
        const dur = getClipDuration(clip);
        const w = dur * state.timelineZoom;
        const isSelected = clip.id === state.selectedClipId;

        const el = document.createElement('div');
        el.className = 'cupcat-clip';
        el.dataset.clipId = clip.id;
        el.style.cssText = `
            width: ${Math.max(w, 4)}px; height: 44px;
            background: ${isSelected
                ? 'linear-gradient(135deg, rgba(224,64,251,0.3), rgba(124,77,255,0.3))'
                : 'linear-gradient(135deg, rgba(224,64,251,0.12), rgba(124,77,255,0.12))'
            };
            border: 1.5px solid ${isSelected ? '#e040fb' : 'rgba(224,64,251,0.3)'};
            border-radius: 6px;
            flex-shrink: 0;
            position: relative;
            cursor: pointer;
            overflow: hidden;
            transition: border-color 0.15s, background 0.15s;
            display: flex; align-items: center;
            user-select: none;
        `;

        // Trim handles
        if (isSelected) {
            // Left trim handle
            const leftHandle = document.createElement('div');
            leftHandle.className = 'cupcat-trim-handle-left';
            leftHandle.style.cssText = `
                position: absolute; left: 0; top: 0; bottom: 0; width: 14px;
                background: #e040fb; cursor: ew-resize; z-index: 5;
                border-radius: 6px 0 0 6px;
                display: flex; align-items: center; justify-content: center;
                touch-action: none;
            `;
            leftHandle.innerHTML = '<div style="width:2px;height:16px;background:rgba(255,255,255,0.5);border-radius:1px;"></div>';
            el.appendChild(leftHandle);

            // Right trim handle
            const rightHandle = document.createElement('div');
            rightHandle.className = 'cupcat-trim-handle-right';
            rightHandle.style.cssText = `
                position: absolute; right: 0; top: 0; bottom: 0; width: 14px;
                background: #7c4dff; cursor: ew-resize; z-index: 5;
                border-radius: 0 6px 6px 0;
                display: flex; align-items: center; justify-content: center;
                touch-action: none;
            `;
            rightHandle.innerHTML = '<div style="width:2px;height:16px;background:rgba(255,255,255,0.5);border-radius:1px;"></div>';
            el.appendChild(rightHandle);

            // Bind drag trim
            bindTrimHandle(leftHandle, clip, 'start', el);
            bindTrimHandle(rightHandle, clip, 'end', el);
        }

        // Clip label
        const label = document.createElement('div');
        label.style.cssText = `
            padding: 0 ${isSelected ? 14 : 6}px; overflow: hidden;
            white-space: nowrap; text-overflow: ellipsis;
            font-size: 10px; font-weight: 600; color: rgba(255,255,255,0.7);
            pointer-events: none;
        `;
        const trimInfo = (clip.startTrim > 0 || clip.endTrim > 0) ? ` [trimmed]` : '';
        const volInfo = clip.muted
            ? ' 🔇'
            : (getItemVolume(clip) !== 1 ? ` 🔊${Math.round(getItemVolume(clip) * 100)}%` : '');
        const speedInfo = getClipSpeed(clip) !== 1 ? ` ⚡${getClipSpeed(clip)}x` : '';
        const imgInfo = clip.isImage ? '📷 ' : '';
        const kbInfo = (clip.isImage && clip.kenBurns && clip.kenBurns !== 'none') ? ` 🎞️${clip.kenBurns}` : '';
        const f = getClipFilters ? getClipFilters(clip) : { preset: 'none', brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0 };
        let filterInfo = '';
        if (f.preset && f.preset !== 'none') {
            const p = FILTER_PRESETS[f.preset];
            filterInfo = ` 🎨${p ? p.name : f.preset}`;
        } else if (Math.abs(f.brightness) > 0.005 || Math.abs(f.contrast - 1) > 0.005 || Math.abs(f.saturation - 1) > 0.005 || Math.abs(f.hue) > 0.5 || f.sepia > 0.5) {
            filterInfo = ' 🎨Adj';
        }
        const tr = getClipTransform ? getClipTransform(clip) : { rotation: 0, flipH: false, flipV: false };
        let transformInfo = '';
        if (tr.rotation !== 0) {
            transformInfo += ` 🔄${tr.rotation}°`;
        }
        if (tr.flipH) {
            transformInfo += ' ↔️';
        }
        if (tr.flipV) {
            transformInfo += ' ↕️';
        }
        const clipDisplayName = String(clip.name || clip.title || 'Clip');
        label.textContent = imgInfo + clipDisplayName.replace(/\.[^.]+$/, '') + trimInfo + volInfo + speedInfo + kbInfo + filterInfo + transformInfo;
        el.appendChild(label);

        // Keyframe diamond markers
        if (clip.keyframes && clip.keyframes.length > 0) {
            const clipStart = getClipStartTime(index);
            clip.keyframes.forEach(kf => {
                const kfPos = (kf.time - clipStart) * state.timelineZoom;
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

        // Duration badge
        if (w > 40) {
            const badge = document.createElement('div');
            badge.style.cssText = `
                position: absolute; bottom: 2px; right: 4px;
                font-size: 8px; color: rgba(255,255,255,0.4);
                font-variant-numeric: tabular-nums;
            `;
            badge.textContent = formatTime(dur);
            el.appendChild(badge);
        }

        // Custom Touch/Mouse Reordering for Video Clips
        let vidDragStartX = 0;
        let vidDragged = false;
        let dropIndicator = null;
        let dropIndex = index;

        el.addEventListener('mousedown', startVidDrag);
        el.addEventListener('touchstart', startVidDrag, { passive: false });

        function startVidDrag(e) {
            if (e.target.closest('.cupcat-trim-handle-left') || e.target.closest('.cupcat-trim-handle-right')) return;
            if (e.type === 'mousedown' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            vidDragStartX = clientX;
            vidDragged = false;
            dropIndex = index;

            function onMove(me) {
                const cx = me.touches ? me.touches[0].clientX : me.clientX;
                const dx = cx - vidDragStartX;
                if (Math.abs(dx) > 10) {
                    if (!vidDragged) {
                        vidDragged = true;
                        el.style.opacity = '0.5';
                        
                        // Create visual drop indicator
                        dropIndicator = document.createElement('div');
                        dropIndicator.style.cssText = `
                            position: absolute; top: 0; bottom: 0; width: 4px;
                            background: #ffab00; z-index: 100; pointer-events: none;
                            border-radius: 2px; box-shadow: 0 0 8px #ffab00;
                        `;
                        track.appendChild(dropIndicator);
                    }
                    
                    const trackRect = track.getBoundingClientRect();
                    const localX = cx - trackRect.left;
                    
                    const childNodes = Array.from(track.querySelectorAll('.cupcat-clip'));
                    let foundIndex = state.videoClips.length;
                    
                    for (let i = 0; i < childNodes.length; i++) {
                        const rect = childNodes[i].getBoundingClientRect();
                        const mid = rect.left + rect.width / 2 - trackRect.left;
                        if (localX < mid) {
                            foundIndex = i;
                            break;
                        }
                    }
                    
                    dropIndex = foundIndex;
                    
                    if (dropIndex === 0) {
                        dropIndicator.style.left = '0px';
                    } else if (dropIndex >= childNodes.length) {
                        const last = childNodes[childNodes.length - 1];
                        dropIndicator.style.left = (last.offsetLeft + last.offsetWidth) + 'px';
                    } else {
                        const target = childNodes[dropIndex];
                        dropIndicator.style.left = target.offsetLeft + 'px';
                    }
                }
            }

            function onEnd() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onEnd);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);
                
                if (dropIndicator && dropIndicator.parentNode) {
                    dropIndicator.parentNode.removeChild(dropIndicator);
                    dropIndicator = null;
                }
                
                if (vidDragged) {
                    el.style.opacity = '1';
                    if (dropIndex !== index) {
                        if (pushHistory) pushHistory();
                        let toIndex = dropIndex;
                        if (toIndex > index) toIndex--; // Adjust for self removal
                        
                        const [moved] = state.videoClips.splice(index, 1);
                        state.videoClips.splice(toIndex, 0, moved);
                        if (saveDocument) saveDocument();
                    }
                    renderTimeline();
                } else {
                    // It was just a click
                    state.selectedClipId = clip.id;
                    state.selectedAudioId = null;
                    state.selectedTextId = null;
                    state.selectedOverlayId = null;
                    renderTimeline();
                    
                    if (updateImageSettingsButton) updateImageSettingsButton();
                    if (updateKeyframeDiamondButton) updateKeyframeDiamondButton();
                    if (updateCanvasTransformBox) updateCanvasTransformBox();
                    
                    const startT = getClipStartTime(index);
                    state.playheadTime = startT;
                    if (updatePlayhead) updatePlayhead();
                    if (updatePreviewAtTime) updatePreviewAtTime(state.playheadTime);
                }
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        document.addEventListener('touchcancel', onEnd);
        }

        track.appendChild(el);

        // Transition indicator between clips
        if (index < state.videoClips.length - 1) {
            const trans = clip.transitionOut || { type: 'none', duration: 0.5 };
            const indicator = document.createElement('div');
            indicator.className = 'cupcat-transition-indicator';
            indicator.dataset.clipIndex = index;
            indicator.style.cssText = `
                width: 24px; height: 44px; flex-shrink: 0;
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; position: relative;
                margin: 0 -2px; z-index: 3;
            `;

            if (trans.type !== 'none') {
                indicator.innerHTML = `<div style="
                    width: 22px; height: 28px; border-radius: 6px;
                    background: linear-gradient(135deg, rgba(255,171,0,0.25), rgba(255,109,0,0.25));
                    border: 1.5px solid rgba(255,171,0,0.5);
                    display: flex; align-items: center; justify-content: center;
                    font-size: 10px; color: #ffab00;
                "><i class='fas fa-exchange-alt' style='font-size:8px;'></i></div>`;
                indicator.title = trans.type + ' (' + trans.duration.toFixed(1) + 's)';
            } else {
                indicator.innerHTML = `<div style="
                    width: 18px; height: 18px; border-radius: 50%;
                    background: rgba(255,255,255,0.04);
                    border: 1px dashed rgba(255,255,255,0.15);
                    display: flex; align-items: center; justify-content: center;
                    font-size: 9px; color: rgba(255,255,255,0.25);
                    transition: all 0.15s;
                "><i class='fas fa-plus' style='font-size:7px;'></i></div>`;
                indicator.title = 'Add transition';
            }

            indicator.addEventListener('click', () => {
                if (openTransitionModal) openTransitionModal(index);
            });

            // Hover effect for empty indicators
            if (trans.type === 'none') {
                indicator.addEventListener('mouseenter', () => {
                    indicator.firstElementChild.style.borderColor = 'rgba(255,171,0,0.5)';
                    indicator.firstElementChild.style.color = '#ffab00';
                    indicator.firstElementChild.style.background = 'rgba(255,171,0,0.1)';
                });
                indicator.addEventListener('mouseleave', () => {
                    indicator.firstElementChild.style.borderColor = 'rgba(255,255,255,0.15)';
                    indicator.firstElementChild.style.color = 'rgba(255,255,255,0.25)';
                    indicator.firstElementChild.style.background = 'rgba(255,255,255,0.04)';
                });
            }

            track.appendChild(indicator);
        }
    });
}

export function renderAudioTracks() {
    const container = document.getElementById('cupcat-audio-tracks-container');
    if (!container) return;
    container.innerHTML = '';

    if (state.audioTracks.length === 0) return;

    const totalDur = Math.max(getMaxTimelineDuration(), 10);

    state.audioTracks.forEach((audio, index) => {
        const row = document.createElement('div');
        row.style.cssText = `
            display: flex; align-items: center;
            padding: 4px 0 4px 4px;
            min-height: 44px;
        `;

        const rowLabel = document.createElement('div');
        rowLabel.style.cssText = `
            width: 28px; flex-shrink: 0;
            font-size: 9px; color: #00e676;
            writing-mode: vertical-lr; text-orientation: mixed;
            text-align: center; font-weight: 700; letter-spacing: 1px;
        `;
        rowLabel.textContent = `A${index + 1}`;
        row.appendChild(rowLabel);

        const trackEl = document.createElement('div');
        trackEl.style.cssText = `
            position: relative; height: 36px; flex-shrink: 0;
            width: ${totalDur * state.timelineZoom + Math.max(window.innerWidth * 0.5, 200)}px;
        `;

        const dur = getAudioDuration(audio);
        const w = dur * state.timelineZoom;
        const offsetPx = (audio.offset || 0) * state.timelineZoom;
        const isSelected = audio.id === state.selectedAudioId;

        const audioEl = document.createElement('div');
        audioEl.className = 'cupcat-audio-clip';
        audioEl.dataset.audioId = audio.id;
        audioEl.style.cssText = `
            position: absolute; left: ${offsetPx}px; top: 0;
            width: ${Math.max(w, 4)}px; height: 36px;
            background: ${isSelected
                ? 'linear-gradient(135deg, rgba(0,230,118,0.25), rgba(0,200,83,0.25))'
                : 'linear-gradient(135deg, rgba(0,230,118,0.10), rgba(0,200,83,0.10))'
            };
            border: 1.5px solid ${isSelected ? '#00e676' : 'rgba(0,230,118,0.3)'};
            border-radius: 6px; cursor: pointer;
            display: flex; align-items: center;
            overflow: hidden; user-select: none;
        `;

        // Wave decoration
        const wave = document.createElement('div');
        wave.style.cssText = `
            position: absolute; inset: 0;
            display: flex; align-items: center; gap: 1px;
            padding: 0 4px; opacity: 0.3; pointer-events: none;
        `;
        for (let i = 0; i < Math.floor(w / 4); i++) {
            const bar = document.createElement('div');
            const h = 4 + Math.random() * 20;
            bar.style.cssText = `
                width: 2px; height: ${h}px; flex-shrink: 0;
                background: #00e676; border-radius: 1px;
            `;
            wave.appendChild(bar);
        }
        audioEl.appendChild(wave);

        // Audio label
        const audioLabel = document.createElement('div');
        audioLabel.style.cssText = `
            position: relative; z-index: 2;
            padding: 0 8px; overflow: hidden;
            white-space: nowrap; text-overflow: ellipsis;
            font-size: 10px; font-weight: 600; color: rgba(255,255,255,0.7);
            pointer-events: none;
        `;
        const audioVolInfo = audio.muted
            ? ' 🔇'
            : (getItemVolume(audio) !== 1 ? ` 🔊${Math.round(getItemVolume(audio) * 100)}%` : '');
        const audioSpeedInfo = getClipSpeed(audio) !== 1 ? ` ⚡${getClipSpeed(audio)}x` : '';
        audioLabel.textContent = audio.name.replace(/\.[^.]+$/, '') + audioVolInfo + audioSpeedInfo;
        audioEl.appendChild(audioLabel);

        // Duration badge
        if (w > 40) {
            const badge = document.createElement('div');
            badge.style.cssText = `
                position: absolute; bottom: 2px; right: 4px;
                font-size: 8px; color: rgba(255,255,255,0.4);
                font-variant-numeric: tabular-nums; z-index: 2;
            `;
            badge.textContent = formatTime(dur);
            audioEl.appendChild(badge);
        }

        // Trim handles
        if (isSelected) {
            const leftHandle = document.createElement('div');
            leftHandle.className = 'cupcat-trim-handle-left';
            leftHandle.style.cssText = `
                position: absolute; left: 0; top: 0; bottom: 0; width: 14px;
                background: #00e676; cursor: ew-resize; z-index: 5;
                border-radius: 6px 0 0 6px;
                display: flex; align-items: center; justify-content: center;
                touch-action: none;
            `;
            leftHandle.innerHTML = '<div style="width:2px;height:16px;background:rgba(255,255,255,0.5);border-radius:1px;"></div>';
            audioEl.appendChild(leftHandle);

            const rightHandle = document.createElement('div');
            rightHandle.className = 'cupcat-trim-handle-right';
            rightHandle.style.cssText = `
                position: absolute; right: 0; top: 0; bottom: 0; width: 14px;
                background: #00c853; cursor: ew-resize; z-index: 5;
                border-radius: 0 6px 6px 0;
                display: flex; align-items: center; justify-content: center;
                touch-action: none;
            `;
            rightHandle.innerHTML = '<div style="width:2px;height:16px;background:rgba(255,255,255,0.5);border-radius:1px;"></div>';
            audioEl.appendChild(rightHandle);

            bindAudioTrimHandle(leftHandle, audio, 'start', audioEl);
            bindAudioTrimHandle(rightHandle, audio, 'end', audioEl);
        }

        // Click to select
        audioEl.addEventListener('click', (e) => {
            if (e.target.closest('.cupcat-trim-handle-left') || e.target.closest('.cupcat-trim-handle-right')) return;
            state.selectedAudioId = audio.id;
            state.selectedClipId = null;
            state.selectedTextId = null;
            state.selectedOverlayId = null;
            renderTimeline();
        });

        // Drag audio horizontally (offset)
        let audioDragStartX = 0;
        let audioDragStartOffset = 0;
        let audioDragged = false;
        audioEl.addEventListener('mousedown', startAudioDrag);
        audioEl.addEventListener('touchstart', startAudioDrag, { passive: false });

        function startAudioDrag(e) {
            if (e.target.closest('.cupcat-trim-handle-left') || e.target.closest('.cupcat-trim-handle-right')) return;
            if (e.type === 'mousedown' && e.button !== 0) return;
            e.preventDefault();
            // Select audio immediately on mousedown (fixes click being swallowed)
            state.selectedAudioId = audio.id;
            state.selectedClipId = null;
            state.selectedTextId = null;
            state.selectedOverlayId = null;
            
            // Visual selection update (without re-rendering DOM and breaking drag)
            document.querySelectorAll('.cupcat-audio').forEach(el => {
                el.style.borderColor = 'rgba(0,229,255,0.3)';
                el.style.background = 'linear-gradient(135deg, rgba(0,229,255,0.12), rgba(0,176,255,0.12))';
            });
            audioEl.style.borderColor = '#00e5ff';
            audioEl.style.background = 'linear-gradient(135deg, rgba(0,229,255,0.3), rgba(0,176,255,0.3))';
            
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            audioDragStartX = clientX;
            audioDragStartOffset = audio.offset || 0;
            audioDragged = false;

            function onMove(me) {
                const cx = me.touches ? me.touches[0].clientX : me.clientX;
                const dx = cx - audioDragStartX;
                if (Math.abs(dx) > 3) {
                    if (!audioDragged) {
                        audioDragged = true;
                        if (pushHistory) pushHistory();
                    }
                    audio.offset = Math.max(0, audioDragStartOffset + dx / state.timelineZoom);
                    audioEl.style.left = (audio.offset * state.timelineZoom) + 'px';
                }
            }
            function onEnd() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onEnd);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);
                if (audioDragged) {
                    if (saveDocument) saveDocument();
                }
                renderTimeline();
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        document.addEventListener('touchcancel', onEnd);
        }

        trackEl.appendChild(audioEl);
        row.appendChild(trackEl);
        container.appendChild(row);
    });
}

export function bindTrimHandle(handle, clip, side, clipEl) {
    let startX = 0;
    let startVal = 0;

    function onStart(e) {
        e.preventDefault();
        e.stopPropagation();
        startX = e.touches ? e.touches[0].clientX : e.clientX;
        startVal = side === 'start' ? (clip.startTrim || 0) : (clip.endTrim || 0);
        if (pushHistory) pushHistory();

        // Temporarily disable scroll on the tracks container during drag
        const scrollContainer = document.getElementById('cupcat-tracks-scroll');
        if (scrollContainer) scrollContainer.style.overflowX = 'hidden';

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
        document.addEventListener('touchcancel', onEnd);
    }

    function onMove(e) {
        e.preventDefault();
        e.stopPropagation();
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const dx = cx - startX;
        // Timeline pixels represent output (post-speed) time; convert back to
        // source time — the unit startTrim/endTrim are actually stored in —
        // by scaling with the clip's speed.
        const dt = (dx / state.timelineZoom) * getClipSpeed(clip);

        if (side === 'start') {
            clip.startTrim = Math.max(0, Math.min(clip.duration - (clip.endTrim || 0) - 0.1, startVal + dt));
        } else {
            clip.endTrim = Math.max(0, Math.min(clip.duration - (clip.startTrim || 0) - 0.1, startVal - dt));
        }

        if (clipEl) {
            const dur = getClipDuration(clip);
            clipEl.style.width = Math.max(dur * state.timelineZoom, 4) + 'px';
        }

        // Refresh the preview so the user sees the trimmed content immediately
        // instead of seeing the old frame while the timeline clip shrinks.
        if (updatePreviewAtTime) updatePreviewAtTime(state.playheadTime);
    }

    function onEnd() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);

        // Restore scroll on the tracks container
        const scrollContainer = document.getElementById('cupcat-tracks-scroll');
        if (scrollContainer) scrollContainer.style.overflowX = 'auto';

        renderTimeline();
        if (saveDocument) saveDocument();
    }

    handle.addEventListener('mousedown', onStart);
    handle.addEventListener('touchstart', onStart, { passive: false });
}

export function bindAudioTrimHandle(handle, audio, side, audioEl) {
    let startX = 0;
    let startVal = 0;
    let startOffset = 0;

    function onStart(e) {
        e.preventDefault();
        e.stopPropagation();
        startX = e.touches ? e.touches[0].clientX : e.clientX;
        startVal = side === 'start' ? (audio.startTrim || 0) : (audio.endTrim || 0);
        startOffset = audio.offset || 0;
        
        if (pushHistory) pushHistory();

        // Temporarily disable scroll on the tracks container during drag
        // to prevent the browser from fighting our drag gesture
        const scrollContainer = document.getElementById('cupcat-tracks-scroll');
        if (scrollContainer) scrollContainer.style.overflowX = 'hidden';

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
        document.addEventListener('touchcancel', onEnd);
    }

    function onMove(e) {
        e.preventDefault();
        e.stopPropagation();
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const dx = cx - startX;
        
        const speed = getClipSpeed(audio);
        const dt = (dx / state.timelineZoom) * speed;

        if (side === 'start') {
            audio.startTrim = Math.max(0, Math.min(audio.duration - (audio.endTrim || 0) - 0.1, startVal + dt));
            // Offset moves as well so the right edge stays in place while the left edge shrinks/grows
            const trimDiff = audio.startTrim - startVal;
            audio.offset = Math.max(0, startOffset + trimDiff / speed);
        } else {
            audio.endTrim = Math.max(0, Math.min(audio.duration - (audio.startTrim || 0) - 0.1, startVal - dt));
        }

        if (audioEl) {
            const dur = getAudioDuration(audio);
            audioEl.style.width = Math.max(dur * state.timelineZoom, 4) + 'px';
            audioEl.style.left = (audio.offset || 0) * state.timelineZoom + 'px';
        }
    }

    function onEnd() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        document.removeEventListener('touchcancel', onEnd);

        // Restore scroll on the tracks container
        const scrollContainer = document.getElementById('cupcat-tracks-scroll');
        if (scrollContainer) scrollContainer.style.overflowX = 'auto';

        renderTimeline();
        if (saveDocument) saveDocument();
    }

    handle.addEventListener('mousedown', onStart);
    handle.addEventListener('touchstart', onStart, { passive: false });
}

export function updatePlayhead() {
    const playhead = document.getElementById('cupcat-playhead');
    if (!playhead) return;
    playhead.style.left = (state.playheadTime * state.timelineZoom) + 'px';
    updateTimeDisplay();
    if (updateKeyframeDiamondButton) updateKeyframeDiamondButton();
    if (updateCanvasTransformBox) updateCanvasTransformBox();
}

export function updateTimeDisplay() {
    const current = document.getElementById('cupcat-current-time');
    const total = document.getElementById('cupcat-total-time');
    if (current) current.textContent = formatTime(state.playheadTime);
    if (total) total.textContent = formatTime(getTotalDuration());
}

export function updateEmptyState() {
    const empty = document.getElementById('cupcat-empty-state');
    if (empty) {
        empty.style.display = state.videoClips.length === 0 ? 'flex' : 'none';
    }
}
