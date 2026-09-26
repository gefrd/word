import { state } from '../state.js';

import { pushHistory } from '../history.js';

let renderTimeline = () => {};
let updatePreview = () => {};
let saveDocument = () => {};

export function setImageSettingsCallbacks(cbs) {
    if (cbs.renderTimeline) renderTimeline = cbs.renderTimeline;
    if (cbs.updatePreview) updatePreview = cbs.updatePreview;
    if (cbs.saveDocument) saveDocument = cbs.saveDocument;
}

export function updateImageSettingsButton() {
    const btn = document.getElementById('cupcat-imgset-btn');
    if (!btn) return;

    let selectedIsImage = false;
    if (state.selectedClipId) {
        const clip = state.videoClips.find(c => c.id === state.selectedClipId);
        if (clip && clip.isImage) selectedIsImage = true;
    }
    btn.style.display = selectedIsImage ? 'flex' : 'none';
}

export function openImageSettingsModal() {
    if (!state.selectedClipId) return;
    const clip = state.videoClips.find(c => c.id === state.selectedClipId);
    if (!clip || !clip.isImage) {
        if (window.showToast) window.showToast('Select an image clip first', false);
        return;
    }

    const modal = document.getElementById('cupcat-imgset-modal');
    modal.style.display = 'flex';

    // Set duration slider
    const durSlider = document.getElementById('cupcat-imgset-duration');
    durSlider.value = clip.duration || 5;
    document.getElementById('cupcat-imgset-duration-val').textContent = (clip.duration || 5).toFixed(1) + 's';

    // Highlight current Ken Burns option
    const currentKB = clip.kenBurns || 'none';
    document.querySelectorAll('.cupcat-kb-option').forEach(btn => {
        const isActive = btn.dataset.kb === currentKB;
        btn.style.background = isActive ? 'rgba(0,176,255,0.25)' : 'rgba(0,176,255,0.08)';
        btn.style.borderColor = isActive ? '#00b0ff' : 'rgba(0,176,255,0.22)';
    });
}

export function closeImageSettingsModal() {
    document.getElementById('cupcat-imgset-modal').style.display = 'none';
}

export function applyImageSettings() {
    if (!state.selectedClipId) return;
    const clip = state.videoClips.find(c => c.id === state.selectedClipId);
    if (!clip || !clip.isImage) return;

    pushHistory();

    // Apply duration
    const newDuration = parseFloat(document.getElementById('cupcat-imgset-duration').value) || 5;
    // Adjust startTrim/endTrim proportionally if they would exceed new duration
    if (clip.startTrim + clip.endTrim >= newDuration) {
        clip.startTrim = 0;
        clip.endTrim = 0;
    }
    clip.duration = newDuration;

    // Apply Ken Burns
    const activeKB = document.querySelector('.cupcat-kb-option[style*="rgba(0,176,255,0.25)"]');
    clip.kenBurns = activeKB ? activeKB.dataset.kb : 'none';

    closeImageSettingsModal();
    renderTimeline();
    updatePreview();
    saveDocument();
    if (window.showToast) window.showToast('Image settings applied', false);
}
