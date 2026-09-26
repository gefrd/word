import { state } from '../state.js';
import { pushHistory } from '../history.js';
import { getClipDuration } from '../utils.js';

let renderTimeline = () => {};
let updatePreview = () => {};
let saveDocument = () => {};

export function setTransitionCallbacks(callbacks) {
    if (callbacks.renderTimeline) renderTimeline = callbacks.renderTimeline;
    if (callbacks.updatePreview) updatePreview = callbacks.updatePreview;
    if (callbacks.saveDocument) saveDocument = callbacks.saveDocument;
}

export function openTransitionModal(clipIndex) {
    state.transitionModalClipIndex = clipIndex;
    const clip = state.videoClips[clipIndex];
    const trans = clip.transitionOut || { type: 'none', duration: 0.5 };

    const modal = document.getElementById('cupcat-transition-modal');
    modal.style.display = 'flex';

    document.getElementById('cupcat-trans-duration').value = trans.duration || 0.5;
    document.getElementById('cupcat-trans-duration-val').textContent = (trans.duration || 0.5).toFixed(1) + 's';
    updateTransitionTypeButtons(trans.type || 'none');
}

export function closeTransitionModal() {
    document.getElementById('cupcat-transition-modal').style.display = 'none';
    state.transitionModalClipIndex = -1;
}

export function applyTransition() {
    if (state.transitionModalClipIndex < 0 || state.transitionModalClipIndex >= state.videoClips.length - 1) return;

    const activeBtn = document.querySelector('.cupcat-trans-type-btn[data-active="true"]');
    const type = activeBtn ? activeBtn.dataset.trans : 'none';
    const duration = parseFloat(document.getElementById('cupcat-trans-duration').value) || 0.5;

    // Clamp duration: can't exceed either adjacent clip's duration
    const clip = state.videoClips[state.transitionModalClipIndex];
    const nextClip = state.videoClips[state.transitionModalClipIndex + 1];
    const maxDur = Math.min(getClipDuration(clip), getClipDuration(nextClip)) * 0.8;
    const clampedDur = Math.min(duration, maxDur);

    pushHistory();
    clip.transitionOut = { type, duration: clampedDur };

    closeTransitionModal();
    renderTimeline();
    saveDocument();
    if (window.showToast) window.showToast(type === 'none' ? 'Transition removed' : `${type} transition (${clampedDur.toFixed(1)}s) applied`, false);
}

export function updateTransitionTypeButtons(activeType) {
    document.querySelectorAll('.cupcat-trans-type-btn').forEach(btn => {
        const isActive = btn.dataset.trans === activeType;
        btn.dataset.active = isActive ? 'true' : 'false';
        btn.style.background = isActive ? 'rgba(255,171,0,0.25)' : 'rgba(255,171,0,0.06)';
        btn.style.borderColor = isActive ? '#ffab00' : 'rgba(255,171,0,0.2)';
    });
}
