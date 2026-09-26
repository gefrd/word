import { state } from '../state.js';
import { getClipDuration } from '../utils.js';
import { pushHistory } from '../history.js';

export let renderTimeline = () => {};
export let updatePreview = () => {};
export let updatePreviewAtTime = () => {};
export let saveDocument = () => {};
export let updateCanvasTransformBox = () => {};
export let updatePlayhead = () => {};
export let updateTextOverlayPreview = () => {};
export let updateOverlayPreview = () => {};

export function setKeyframeCallbacks(callbacks) {
    if (callbacks.renderTimeline) renderTimeline = callbacks.renderTimeline;
    if (callbacks.updatePreview) updatePreview = callbacks.updatePreview;
    if (callbacks.updatePreviewAtTime) updatePreviewAtTime = callbacks.updatePreviewAtTime;
    if (callbacks.saveDocument) saveDocument = callbacks.saveDocument;
    if (callbacks.updateCanvasTransformBox) updateCanvasTransformBox = callbacks.updateCanvasTransformBox;
    if (callbacks.updatePlayhead) updatePlayhead = callbacks.updatePlayhead;
    if (callbacks.updateTextOverlayPreview) updateTextOverlayPreview = callbacks.updateTextOverlayPreview;
    if (callbacks.updateOverlayPreview) updateOverlayPreview = callbacks.updateOverlayPreview;
}

export function getSelectedTarget() {
    if (state.selectedOverlayId) {
        const item = state.overlayTracks.find(o => o.id === state.selectedOverlayId);
        if (item) return { type: 'overlay', item, name: item.name || 'Overlay/Sticker' };
    }
    if (state.selectedTextId) {
        const item = state.textOverlays.find(t => t.id === state.selectedTextId);
        if (item) return { type: 'text', item, name: `Text: "${(item.text || '').substring(0, 12)}"` };
    }
    if (state.selectedSubtitleId) {
        const item = state.subtitleTracks.find(s => s.id === state.selectedSubtitleId);
        if (item) return { type: 'subtitle', item, name: `Sub: "${(item.text || '').substring(0, 14)}"` };
    }
    if (state.selectedClipId) {
        const item = state.videoClips.find(c => c.id === state.selectedClipId);
        if (item) return { type: 'clip', item, name: item.name || 'Video Clip' };
    }
    return null;
}

export function getInterpolatedKeyframe(item, time) {
    const defaults = {
        x: item && item.posX !== undefined ? item.posX : 50,
        y: item && item.posY !== undefined ? item.posY : 50,
        scale: item && item.scale !== undefined ? item.scale / 100 : (item && item.fontSize ? 1 : 0.3),
        rotation: item && item.rotation !== undefined ? item.rotation : 0,
        opacity: item && item.opacity !== undefined ? item.opacity / 100 : 1
    };

    if (!item || !item.keyframes || item.keyframes.length === 0) {
        return defaults;
    }

    const sorted = [...item.keyframes].sort((a, b) => a.time - b.time);

    if (time <= sorted[0].time) {
        const k = sorted[0];
        return {
            x: k.x !== undefined ? k.x : defaults.x,
            y: k.y !== undefined ? k.y : defaults.y,
            scale: k.scale !== undefined ? k.scale : defaults.scale,
            rotation: k.rotation !== undefined ? k.rotation : defaults.rotation,
            opacity: k.opacity !== undefined ? k.opacity : defaults.opacity
        };
    }

    if (time >= sorted[sorted.length - 1].time) {
        const k = sorted[sorted.length - 1];
        return {
            x: k.x !== undefined ? k.x : defaults.x,
            y: k.y !== undefined ? k.y : defaults.y,
            scale: k.scale !== undefined ? k.scale : defaults.scale,
            rotation: k.rotation !== undefined ? k.rotation : defaults.rotation,
            opacity: k.opacity !== undefined ? k.opacity : defaults.opacity
        };
    }

    for (let i = 0; i < sorted.length - 1; i++) {
        const k0 = sorted[i];
        const k1 = sorted[i + 1];
        if (time >= k0.time && time <= k1.time) {
            const span = k1.time - k0.time;
            const t = span > 0 ? (time - k0.time) / span : 0;

            const x0 = k0.x !== undefined ? k0.x : defaults.x;
            const x1 = k1.x !== undefined ? k1.x : defaults.x;
            const y0 = k0.y !== undefined ? k0.y : defaults.y;
            const y1 = k1.y !== undefined ? k1.y : defaults.y;
            const s0 = k0.scale !== undefined ? k0.scale : defaults.scale;
            const s1 = k1.scale !== undefined ? k1.scale : defaults.scale;
            const r0 = k0.rotation !== undefined ? k0.rotation : defaults.rotation;
            const r1 = k1.rotation !== undefined ? k1.rotation : defaults.rotation;
            const o0 = k0.opacity !== undefined ? k0.opacity : defaults.opacity;
            const o1 = k1.opacity !== undefined ? k1.opacity : defaults.opacity;

            return {
                x: x0 + (x1 - x0) * t,
                y: y0 + (y1 - y0) * t,
                scale: s0 + (s1 - s0) * t,
                rotation: r0 + (r1 - r0) * t,
                opacity: o0 + (o1 - o0) * t
            };
        }
    }

    return defaults;
}

export function getKeyframeAtPlayhead(item) {
    if (!item || !item.keyframes) return null;
    return item.keyframes.find(k => Math.abs(k.time - state.playheadTime) < 0.08);
}

export function addKeyframeAtPlayhead() {
    const target = getSelectedTarget();
    if (!target) {
        if (window.showToast) window.showToast('Select a sticker, text, or clip first to add keyframe', true);
        return;
    }
    pushHistory();
    const item = target.item;
    if (!item.keyframes) item.keyframes = [];

    const current = getInterpolatedKeyframe(item, state.playheadTime);
    const existingIndex = item.keyframes.findIndex(k => Math.abs(k.time - state.playheadTime) < 0.08);

    const newKf = {
        time: parseFloat(state.playheadTime.toFixed(3)),
        x: Math.round(current.x * 10) / 10,
        y: Math.round(current.y * 10) / 10,
        scale: Math.round(current.scale * 100) / 100,
        rotation: Math.round(current.rotation),
        opacity: Math.round(current.opacity * 100) / 100
    };

    if (existingIndex >= 0) {
        item.keyframes[existingIndex] = newKf;
    } else {
        item.keyframes.push(newKf);
        item.keyframes.sort((a, b) => a.time - b.time);
    }

    renderTimeline();
    updatePreviewAtTime(state.playheadTime);
    updateKeyframeDiamondButton();
    updateCanvasTransformBox();
    saveDocument();
    if (window.showToast) window.showToast(`Keyframe pin set at ${state.playheadTime.toFixed(2)}s`, false);
}

export function toggleKeyframeAtPlayhead() {
    const target = getSelectedTarget();
    if (!target) {
        if (window.showToast) window.showToast('Select a sticker, text, or overlay to animate', true);
        return;
    }
    const item = target.item;
    if (!item.keyframes) item.keyframes = [];
    const existingIndex = item.keyframes.findIndex(k => Math.abs(k.time - state.playheadTime) < 0.08);

    if (existingIndex >= 0) {
        pushHistory();
        item.keyframes.splice(existingIndex, 1);
        renderTimeline();
        updatePreviewAtTime(state.playheadTime);
        updateKeyframeDiamondButton();
        updateCanvasTransformBox();
        saveDocument();
        if (window.showToast) window.showToast('Keyframe pin removed', false);
    } else {
        addKeyframeAtPlayhead();
    }
}

export function navigateKeyframe(dir) {
    const target = getSelectedTarget();
    if (!target || !target.item.keyframes || target.item.keyframes.length === 0) {
        if (window.showToast) window.showToast('No keyframes on selected element', false);
        return;
    }
    const sorted = [...target.item.keyframes].sort((a, b) => a.time - b.time);
    if (dir === 'prev') {
        const prev = sorted.filter(k => k.time < state.playheadTime - 0.05).pop();
        if (prev) {
            state.playheadTime = prev.time;
            updatePlayhead();
            updatePreviewAtTime(state.playheadTime);
        } else {
            state.playheadTime = sorted[0].time;
            updatePlayhead();
            updatePreviewAtTime(state.playheadTime);
        }
    } else {
        const next = sorted.find(k => k.time > state.playheadTime + 0.05);
        if (next) {
            state.playheadTime = next.time;
            updatePlayhead();
            updatePreviewAtTime(state.playheadTime);
        } else {
            state.playheadTime = sorted[sorted.length - 1].time;
            updatePlayhead();
            updatePreviewAtTime(state.playheadTime);
        }
    }
}

export function updateKeyframeDiamondButton() {
    const btn = document.getElementById('cupcat-kf-toggle-btn');
    const icon = document.getElementById('cupcat-kf-diamond-icon');
    const prevBtn = document.getElementById('cupcat-kf-prev-btn');
    const nextBtn = document.getElementById('cupcat-kf-next-btn');
    if (!btn || !icon) return;

    const target = getSelectedTarget();
    if (!target) {
        btn.style.opacity = '0.35';
        btn.style.pointerEvents = 'none';
        btn.style.borderColor = 'rgba(255,255,255,0.15)';
        btn.style.background = 'rgba(255,255,255,0.04)';
        icon.style.color = '#ccc';
        icon.textContent = '◆';
        if (prevBtn) prevBtn.style.opacity = '0.3';
        if (nextBtn) nextBtn.style.opacity = '0.3';
        return;
    }

    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
    const item = target.item;
    const hasKfs = item.keyframes && item.keyframes.length > 0;
    if (prevBtn) prevBtn.style.opacity = hasKfs ? '1' : '0.3';
    if (nextBtn) nextBtn.style.opacity = hasKfs ? '1' : '0.3';

    const currentKf = getKeyframeAtPlayhead(item);
    if (currentKf) {
        btn.style.background = 'rgba(255,214,0,0.22)';
        btn.style.borderColor = '#ffd600';
        btn.title = 'Remove Keyframe (Delete Pin)';
        icon.style.color = '#ffd600';
        icon.textContent = '◆−';
    } else {
        btn.style.background = 'rgba(255,255,255,0.06)';
        btn.style.borderColor = 'rgba(255,255,255,0.2)';
        btn.title = 'Add Keyframe (Set Pin)';
        icon.style.color = '#fff';
        icon.textContent = '◆+';
    }
}

export function clearAllKeyframesForSelected() {
    const target = getSelectedTarget();
    if (!target) return;
    pushHistory();
    target.item.keyframes = [];
    renderTimeline();
    updatePreviewAtTime(state.playheadTime);
    updateKeyframeDiamondButton();
    updateCanvasTransformBox();
    renderKeyframeModalContent();
    saveDocument();
    if (window.showToast) window.showToast('All keyframes cleared for selected item', false);
}

export function applyKeyframePreset(preset) {
    const target = getSelectedTarget();
    if (!target) {
        if (window.showToast) window.showToast('Select an item first to apply preset motion', true);
        return;
    }
    const item = target.item;
    let t0 = item.startTime !== undefined ? item.startTime : 0;
    let t1 = item.endTime !== undefined ? item.endTime : (t0 + (getClipDuration(item) || 4));
    if (t1 <= t0) t1 = t0 + 4;
    const dur = t1 - t0;

    pushHistory();
    item.keyframes = [];

    const baseScale = item.scale !== undefined ? item.scale / 100 : (target.type === 'text' ? 1 : 0.3);
    const baseRot = item.rotation !== undefined ? item.rotation : 0;

    if (preset === 'slide-lr') {
        item.keyframes.push({ time: t0, x: -20, y: 50, scale: baseScale, rotation: baseRot, opacity: 1 });
        item.keyframes.push({ time: t1, x: 120, y: 50, scale: baseScale, rotation: baseRot, opacity: 1 });
    } else if (preset === 'slide-rl') {
        item.keyframes.push({ time: t0, x: 120, y: 50, scale: baseScale, rotation: baseRot, opacity: 1 });
        item.keyframes.push({ time: t1, x: -20, y: 50, scale: baseScale, rotation: baseRot, opacity: 1 });
    } else if (preset === 'zoom-in') {
        item.keyframes.push({ time: t0, x: 50, y: 50, scale: 0.05, rotation: baseRot, opacity: 0 });
        item.keyframes.push({ time: t0 + Math.min(0.8, dur * 0.4), x: 50, y: 50, scale: baseScale, rotation: baseRot, opacity: 1 });
        item.keyframes.push({ time: t1, x: 50, y: 50, scale: baseScale * 1.5, rotation: baseRot, opacity: 1 });
    } else if (preset === 'zoom-out') {
        item.keyframes.push({ time: t0, x: 50, y: 50, scale: baseScale * 1.6, rotation: baseRot, opacity: 1 });
        item.keyframes.push({ time: t1, x: 50, y: 50, scale: 0.02, rotation: baseRot, opacity: 0 });
    } else if (preset === 'spin-grow') {
        item.keyframes.push({ time: t0, x: 50, y: 50, scale: 0.05, rotation: -180, opacity: 0 });
        item.keyframes.push({ time: t0 + Math.min(1.0, dur * 0.5), x: 50, y: 50, scale: baseScale, rotation: 0, opacity: 1 });
        item.keyframes.push({ time: t1, x: 50, y: 50, scale: baseScale * 1.2, rotation: 360, opacity: 1 });
    } else if (preset === 'bounce') {
        item.keyframes.push({ time: t0, x: 50, y: -20, scale: baseScale, rotation: baseRot, opacity: 1 });
        item.keyframes.push({ time: t0 + dur * 0.35, x: 50, y: 58, scale: baseScale * 1.15, rotation: baseRot, opacity: 1 });
        item.keyframes.push({ time: t0 + dur * 0.55, x: 50, y: 44, scale: baseScale * 0.95, rotation: baseRot, opacity: 1 });
        item.keyframes.push({ time: t0 + dur * 0.75, x: 50, y: 52, scale: baseScale, rotation: baseRot, opacity: 1 });
        item.keyframes.push({ time: t1, x: 50, y: 50, scale: baseScale, rotation: baseRot, opacity: 1 });
    } else if (preset === 'fade') {
        item.keyframes.push({ time: t0, x: 50, y: 50, scale: baseScale, rotation: baseRot, opacity: 0 });
        item.keyframes.push({ time: t0 + Math.min(0.6, dur * 0.3), x: 50, y: 50, scale: baseScale, rotation: baseRot, opacity: 1 });
        item.keyframes.push({ time: Math.max(t0 + 0.7, t1 - Math.min(0.6, dur * 0.3)), x: 50, y: 50, scale: baseScale, rotation: baseRot, opacity: 1 });
        item.keyframes.push({ time: t1, x: 50, y: 50, scale: baseScale, rotation: baseRot, opacity: 0 });
    }

    renderTimeline();
    updatePreviewAtTime(state.playheadTime);
    updateKeyframeDiamondButton();
    updateCanvasTransformBox();
    renderKeyframeModalContent();
    saveDocument();
    if (window.showToast) window.showToast(`Applied preset "${preset}"`, false);
}

export function openKeyframeModal() {
    const modal = document.getElementById('cupcat-kf-modal');
    if (modal) modal.style.display = 'flex';
    renderKeyframeModalContent();
}

export function closeKeyframeModal() {
    const modal = document.getElementById('cupcat-kf-modal');
    if (modal) modal.style.display = 'none';
}

export function renderKeyframeModalContent() {
    const target = getSelectedTarget();
    const nameEl = document.getElementById('cupcat-kf-target-name') || document.getElementById('cupcat-kf-target-info');
    const countEl = document.getElementById('cupcat-kf-count-label');
    const playheadEl = document.getElementById('cupcat-kf-playhead-time');
    const statusEl = document.getElementById('cupcat-kf-status-badge');
    const listEl = document.getElementById('cupcat-kf-list-container') || document.getElementById('cupcat-kf-points-list');

    if (playheadEl) playheadEl.textContent = `${state.playheadTime.toFixed(2)}s`;

    if (!target) {
        if (nameEl) nameEl.textContent = 'Target: No item selected';
        if (countEl) countEl.textContent = '0 Keyframes';
        if (statusEl) statusEl.textContent = '◆ No selection';
        if (listEl) listEl.innerHTML = '<div style="color: #666; font-size: 11px; text-align: center; padding: 12px;">Select a sticker, text, or overlay to animate</div>';
        return;
    }

    const item = target.item;
    const keyframesCount = item.keyframes ? item.keyframes.length : 0;
    if (nameEl) nameEl.textContent = `Target: ${target.name}`;
    if (countEl) countEl.textContent = `${keyframesCount} Keyframe${keyframesCount === 1 ? '' : 's'}`;

    const exactKf = item.keyframes ? item.keyframes.find(k => Math.abs(k.time - state.playheadTime) < 0.05) : null;
    if (statusEl) {
        if (exactKf) {
            statusEl.textContent = '◆ Active Pin (On Frame)';
            statusEl.style.color = '#00e676';
        } else {
            statusEl.textContent = '◇ Interpolated (In Between)';
            statusEl.style.color = '#ffd700';
        }
    }

    const kf = getInterpolatedKeyframe(item, state.playheadTime);
    const posXInput = document.getElementById('cupcat-kf-slider-posx') || document.getElementById('cupcat-kf-pos-x');
    const posYInput = document.getElementById('cupcat-kf-slider-posy') || document.getElementById('cupcat-kf-pos-y');
    const scaleInput = document.getElementById('cupcat-kf-slider-scale') || document.getElementById('cupcat-kf-scale');
    const rotInput = document.getElementById('cupcat-kf-slider-rot') || document.getElementById('cupcat-kf-rotation');

    if (posXInput) posXInput.value = Math.round(kf.x);
    if (posYInput) posYInput.value = Math.round(kf.y);
    if (scaleInput) scaleInput.value = Math.round(kf.scale * 100);
    if (rotInput) rotInput.value = Math.round(kf.rotation);

    const posXVal = document.getElementById('cupcat-kf-val-posx') || document.getElementById('cupcat-kf-pos-x-val');
    const posYVal = document.getElementById('cupcat-kf-val-posy') || document.getElementById('cupcat-kf-pos-y-val');
    const scaleVal = document.getElementById('cupcat-kf-val-scale') || document.getElementById('cupcat-kf-scale-val');
    const rotVal = document.getElementById('cupcat-kf-val-rot') || document.getElementById('cupcat-kf-rotation-val');

    if (posXVal) posXVal.textContent = `${Math.round(kf.x)}%`;
    if (posYVal) posYVal.textContent = `${Math.round(kf.y)}%`;
    if (scaleVal) scaleVal.textContent = `${Math.round(kf.scale * 100)}%`;
    if (rotVal) rotVal.textContent = `${Math.round(kf.rotation)}°`;

    if (!listEl) return;
    listEl.innerHTML = '';

    if (!item.keyframes || item.keyframes.length === 0) {
        listEl.innerHTML = '<div style="color: #888; font-size: 11px; text-align: center; padding: 10px;">No keyframe pins set yet. Move playhead & adjust sliders or click "◆" to pin.</div>';
        return;
    }

    const sorted = [...item.keyframes].sort((a, b) => a.time - b.time);
    sorted.forEach((k, idx) => {
        const isCurrent = Math.abs(k.time - state.playheadTime) < 0.08;
        const row = document.createElement('div');
        row.style.cssText = `
            display: flex; align-items: center; justify-content: space-between;
            padding: 6px 10px; border-radius: 8px; font-size: 11px;
            background: ${isCurrent ? 'rgba(255,214,0,0.18)' : 'rgba(255,255,255,0.03)'};
            border: 1.5px solid ${isCurrent ? '#ffd600' : 'rgba(255,255,255,0.08)'};
            cursor: pointer; transition: all 0.15s ease;
        `;
        row.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="color: #ffd600; font-weight: bold;">◆ #${idx + 1}</span>
                <span style="color: #fff; font-family: monospace; font-weight: 600;">${k.time.toFixed(2)}s</span>
                <span style="color: #888; font-size: 10px;">(X:${Math.round(k.x)}% Y:${Math.round(k.y)}% S:${Math.round(k.scale * 100)}% R:${Math.round(k.rotation)}°)</span>
            </div>
            <button class="cupcat-kf-delete-point-btn" style="
                background: rgba(255,82,82,0.15); border: 1px solid rgba(255,82,82,0.3); color: #ff5252; font-size: 12px;
                cursor: pointer; padding: 2px 6px; border-radius: 4px; font-weight: 700;
            " title="Delete this pin">✕</button>
        `;

        row.addEventListener('click', (e) => {
            if (e.target.classList.contains('cupcat-kf-delete-point-btn')) return;
            state.playheadTime = k.time;
            updatePlayhead();
            updatePreviewAtTime(state.playheadTime);
            renderKeyframeModalContent();
        });

        const delBtn = row.querySelector('.cupcat-kf-delete-point-btn');
        if (delBtn) {
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                pushHistory();
                const targetIdx = item.keyframes.findIndex(x => Math.abs(x.time - k.time) < 0.001);
                if (targetIdx >= 0) item.keyframes.splice(targetIdx, 1);
                renderTimeline();
                updatePreviewAtTime(state.playheadTime);
                updateKeyframeDiamondButton();
                updateCanvasTransformBox();
                renderKeyframeModalContent();
                saveDocument();
            });
        }

        listEl.appendChild(row);
    });
}

export function onKeyframeSliderChange(prop, val) {
    const target = getSelectedTarget();
    if (!target) return;

    let numVal = parseFloat(val);
    if (prop === 'scale') numVal = numVal / 100;
    if (prop === 'opacity') numVal = numVal / 100;

    applyPropertyChangeToTarget(target.item, prop, numVal);

    updateTextOverlayPreview();
    updateOverlayPreview();
    updateCanvasTransformBox();
    renderTimeline();
    updateKeyframeDiamondButton();
    renderKeyframeModalContent();
}

export function applyPropertyChangeToTarget(item, prop, val) {
    if (!item) return;
    const isSub = state.subtitleTracks && state.subtitleTracks.some(s => s.id === item.id);
    if (isSub && state.subApplyToAll) {
        state.subtitleTracks.forEach(sub => {
            if (!sub.keyframes || sub.keyframes.length === 0) {
                if (prop === 'x') { sub.posX = val; delete sub.position; }
                else if (prop === 'y') { sub.posY = val; delete sub.position; }
                else if (prop === 'scale') sub.scale = val * 100;
                else if (prop === 'rotation') sub.rotation = val;
                else if (prop === 'opacity') sub.opacity = val * 100;
            }
        });
    }

    if (!item.keyframes || item.keyframes.length === 0) {
        if (prop === 'x') { item.posX = val; delete item.position; }
        else if (prop === 'y') { item.posY = val; delete item.position; }
        else if (prop === 'scale') item.scale = val * 100;
        else if (prop === 'rotation') item.rotation = val;
        else if (prop === 'opacity') item.opacity = val * 100;
    } else {
        const existing = getKeyframeAtPlayhead(item);
        if (existing) {
            existing[prop] = val;
        } else {
            const current = getInterpolatedKeyframe(item, state.playheadTime);
            const newKf = {
                time: parseFloat(state.playheadTime.toFixed(3)),
                x: current.x,
                y: current.y,
                scale: current.scale,
                rotation: current.rotation,
                opacity: current.opacity
            };
            newKf[prop] = val;
            item.keyframes.push(newKf);
            item.keyframes.sort((a, b) => a.time - b.time);
        }
    }
}
