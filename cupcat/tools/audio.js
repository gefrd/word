import { state } from '../state.js';
import { getClipDuration, getClipSpeed, getItemVolume, formatTime, getEffectiveVolumeAtTime, getClipStartTime, getTotalDuration } from '../utils.js';
import { pushHistory } from '../history.js';
import { setMediaVolume, initAudioContext } from '../playback.js';

let renderTimeline = () => {};
let updatePreview = () => {};
let saveDocument = () => {};
let updatePlayhead = () => {};
let updatePreviewAtTime = () => {};

export function setAudioCallbacks(cbs) {
    if (cbs.renderTimeline) renderTimeline = cbs.renderTimeline;
    if (cbs.updatePreview) updatePreview = cbs.updatePreview;
    if (cbs.saveDocument) saveDocument = cbs.saveDocument;
    if (cbs.updatePlayhead) updatePlayhead = cbs.updatePlayhead;
    if (cbs.updatePreviewAtTime) updatePreviewAtTime = cbs.updatePreviewAtTime;
}

/* ==============================
   VOLUME / MUTE MODAL
   ============================== */

export function openVolumeModal() {
    let item = null;
    let type = '';

    if (state.selectedClipId) {
        item = state.videoClips.find(c => c.id === state.selectedClipId);
        type = 'video';
    } else if (state.selectedAudioId) {
        item = state.audioTracks.find(a => a.id === state.selectedAudioId);
        type = 'audio';
    }

    if (!item) {
        if (window.showToast) window.showToast('Select a clip or audio to adjust volume', false);
        return;
    }

    state.volumeTarget = { type, id: item.id };
    state.volumeModalMuted = !!item.muted;

    const modal = document.getElementById('cupcat-volume-modal');
    modal.style.display = 'flex';

    const slider = document.getElementById('cupcat-volume-slider');
    slider.value = Math.round(getItemVolume(item) * 100);

    // Cap fade range to half the clip's own on-timeline length so fade-in
    // and fade-out can't be dragged into total overlap from the UI alone.
    const dur = getClipDuration(item);
    const maxFade = Math.max(0.5, dur / 2);
    const fadeInSlider = document.getElementById('cupcat-volume-fadein-slider');
    const fadeOutSlider = document.getElementById('cupcat-volume-fadeout-slider');
    fadeInSlider.max = maxFade.toFixed(1);
    fadeOutSlider.max = maxFade.toFixed(1);
    fadeInSlider.value = Math.min(item.fadeIn || 0, maxFade);
    fadeOutSlider.value = Math.min(item.fadeOut || 0, maxFade);

    updateVolumeModalLabel();
    updateVolumeModalFadeLabels();
    updateVolumeModalMuteUI();
}

export function closeVolumeModal() {
    document.getElementById('cupcat-volume-modal').style.display = 'none';
    state.volumeTarget = null;
}

export function updateVolumeModalLabel() {
    const slider = document.getElementById('cupcat-volume-slider');
    const valEl = document.getElementById('cupcat-volume-slider-val');
    if (slider && valEl) valEl.textContent = slider.value + '%';
}

export function updateVolumeModalFadeLabels() {
    const fadeInSlider = document.getElementById('cupcat-volume-fadein-slider');
    const fadeInVal = document.getElementById('cupcat-volume-fadein-val');
    if (fadeInSlider && fadeInVal) fadeInVal.textContent = parseFloat(fadeInSlider.value).toFixed(1) + 's';

    const fadeOutSlider = document.getElementById('cupcat-volume-fadeout-slider');
    const fadeOutVal = document.getElementById('cupcat-volume-fadeout-val');
    if (fadeOutSlider && fadeOutVal) fadeOutVal.textContent = parseFloat(fadeOutSlider.value).toFixed(1) + 's';
}

export function toggleVolumeModalMute() {
    state.volumeModalMuted = !state.volumeModalMuted;
    updateVolumeModalMuteUI();
}

export function updateVolumeModalMuteUI() {
    const btn = document.getElementById('cupcat-volume-mute-toggle');
    const label = document.getElementById('cupcat-volume-mute-label');
    if (!btn || !label) return;

    if (state.volumeModalMuted) {
        btn.style.background = '#ff5252';
        btn.style.color = '#fff';
        label.textContent = 'Muted — tap to unmute';
    } else {
        btn.style.background = 'rgba(255,82,82,0.10)';
        btn.style.color = '#ff5252';
        label.textContent = 'Mute this clip';
    }
}

export function applyVolume() {
    if (!state.volumeTarget) return;
    initAudioContext();

    const slider = document.getElementById('cupcat-volume-slider');
    const level = Math.max(0, parseInt(slider.value, 10) || 0) / 100;

    const fadeInSlider = document.getElementById('cupcat-volume-fadein-slider');
    const fadeOutSlider = document.getElementById('cupcat-volume-fadeout-slider');
    let fadeIn = Math.max(0, parseFloat(fadeInSlider.value) || 0);
    let fadeOut = Math.max(0, parseFloat(fadeOutSlider.value) || 0);

    let item;
    if (state.volumeTarget.type === 'video') {
        item = state.videoClips.find(c => c.id === state.volumeTarget.id);
    } else {
        item = state.audioTracks.find(a => a.id === state.volumeTarget.id);
    }

    if (item) {
        // Fades can't add up to more than the clip's own on-timeline length —
        // scale both down proportionally rather than letting them overlap.
        const dur = getClipDuration(item);
        if (fadeIn + fadeOut > dur && (fadeIn + fadeOut) > 0) {
            const scale = dur / (fadeIn + fadeOut);
            fadeIn *= scale;
            fadeOut *= scale;
        }

        pushHistory();
        item.volume = level;
        item.muted = state.volumeModalMuted;
        item.fadeIn = fadeIn;
        item.fadeOut = fadeOut;

        // Live-update anything currently playing so the change is heard immediately,
        // without waiting for the next clip switch / resync tick.
        if (state.volumeTarget.type === 'video' && state.dom.previewVideo && item.objectUrl && state.dom.previewVideo.src === item.objectUrl) {
            const idx = state.videoClips.findIndex(c => c.id === item.id);
            setMediaVolume(state.dom.previewVideo, getEffectiveVolumeAtTime(item, state.playheadTime - getClipStartTime(idx)));
        } else if (state.volumeTarget.type === 'audio' && item._audioEl) {
            setMediaVolume(item._audioEl, getEffectiveVolumeAtTime(item, state.playheadTime - (item.offset || 0)));
        }
    }

    closeVolumeModal();
    renderTimeline();
    saveDocument();
    if (window.showToast) window.showToast('Volume updated', false);
}

/* ==============================
   SPEED MODAL
   ============================== */

export function openSpeedModal() {
    let item = null;
    let type = '';

    if (state.selectedClipId) {
        item = state.videoClips.find(c => c.id === state.selectedClipId);
        type = 'video';
    } else if (state.selectedAudioId) {
        item = state.audioTracks.find(a => a.id === state.selectedAudioId);
        type = 'audio';
    }

    if (!item) {
        if (window.showToast) window.showToast('Select a clip or audio to change speed', false);
        return;
    }

    state.speedTarget = { type, id: item.id };

    const modal = document.getElementById('cupcat-speed-modal');
    modal.style.display = 'flex';

    const slider = document.getElementById('cupcat-speed-slider');
    slider.value = getClipSpeed(item);

    updateSpeedModalLabel();
    updateSpeedPreviewInfo();
}

export function closeSpeedModal() {
    document.getElementById('cupcat-speed-modal').style.display = 'none';
    state.speedTarget = null;
}

export function updateSpeedModalLabel() {
    const slider = document.getElementById('cupcat-speed-slider');
    const valEl = document.getElementById('cupcat-speed-slider-val');
    if (slider && valEl) valEl.textContent = parseFloat(slider.value).toFixed(2).replace(/\.?0+$/, '') + 'x';
}

export function updateSpeedPreviewInfo() {
    if (!state.speedTarget) return;

    let item;
    if (state.speedTarget.type === 'video') {
        item = state.videoClips.find(c => c.id === state.speedTarget.id);
    } else {
        item = state.audioTracks.find(a => a.id === state.speedTarget.id);
    }
    if (!item) return;

    const slider = document.getElementById('cupcat-speed-slider');
    const newSpeed = parseFloat(slider.value) || 1;
    const trimmed = (item.duration || 0) - (item.startTrim || 0) - (item.endTrim || 0);
    const newDur = trimmed / newSpeed;

    const info = document.getElementById('cupcat-speed-preview-info');
    if (info) {
        info.innerHTML = `
            Clip length: <strong>${formatTime(trimmed / getClipSpeed(item))}</strong> →
            <strong style="color: #ffd600">${formatTime(newDur)}</strong>
        `;
    }
}

export function applySpeed() {
    if (!state.speedTarget) return;

    const slider = document.getElementById('cupcat-speed-slider');
    const newSpeed = Math.min(4, Math.max(0.25, parseFloat(slider.value) || 1));

    let item;
    if (state.speedTarget.type === 'video') {
        item = state.videoClips.find(c => c.id === state.speedTarget.id);
    } else {
        item = state.audioTracks.find(a => a.id === state.speedTarget.id);
    }

    if (item) {
        pushHistory();
        item.speed = newSpeed;

        // Live-update anything currently playing so the change is heard/seen
        // immediately, without waiting for the next clip switch / resync tick.
        if (state.speedTarget.type === 'video' && state.dom.previewVideo && item.objectUrl && state.dom.previewVideo.src === item.objectUrl) {
            state.dom.previewVideo.playbackRate = newSpeed;
        } else if (state.speedTarget.type === 'audio' && item._audioEl) {
            item._audioEl.playbackRate = newSpeed;
        }

        // Changing speed changes this clip's timeline duration, which shifts
        // every clip after it — clamp the playhead in case it now sits past
        // the new (shorter) total duration.
        const totalDur = getTotalDuration();
        if (state.playheadTime > totalDur) {
            state.playheadTime = totalDur;
        }
    }

    closeSpeedModal();
    renderTimeline();
    updatePlayhead();
    updatePreviewAtTime(state.playheadTime);
    saveDocument();
    if (window.showToast) window.showToast('Speed updated', false);
}
