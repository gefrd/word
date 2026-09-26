import { state } from '../state.js';
import { generateId, getClipDuration, getClipStartTime, getTotalDuration, formatTime, stopPlaybackSafe, getAudioDuration } from '../utils.js';
import { pushHistory } from '../history.js';

let renderTimeline = () => {};
let updatePreview = () => {};
let updatePlayhead = () => {};
let updateEmptyState = () => {};
let saveDocument = () => {};
let updateKeyframeDiamondButton = () => {};
let updateTextOverlayPreview = () => {};
let updateCanvasBox = () => {};
let updateOverlayPreview = () => {};
let updatePreviewAtTime = () => {};

export function setTrimCallbacks(cbs) {
    if (cbs.renderTimeline) renderTimeline = cbs.renderTimeline;
    if (cbs.updatePreview) updatePreview = cbs.updatePreview;
    if (cbs.updatePlayhead) updatePlayhead = cbs.updatePlayhead;
    if (cbs.updateEmptyState) updateEmptyState = cbs.updateEmptyState;
    if (cbs.saveDocument) saveDocument = cbs.saveDocument;
    if (cbs.updateKeyframeDiamondButton) updateKeyframeDiamondButton = cbs.updateKeyframeDiamondButton;
    if (cbs.updateTextOverlayPreview) updateTextOverlayPreview = cbs.updateTextOverlayPreview;
    if (cbs.updateCanvasBox) updateCanvasBox = cbs.updateCanvasBox;
    if (cbs.updateOverlayPreview) updateOverlayPreview = cbs.updateOverlayPreview;
    if (cbs.updatePreviewAtTime) updatePreviewAtTime = cbs.updatePreviewAtTime;
}

export function splitAtPlayhead() {
    // When audio is selected, try to split audio FIRST (before video).
    // Otherwise the video track always catches the playhead position and
    // audio can never be split with scissors.
    if (state.selectedAudioId) {
        const audioIdx = state.audioTracks.findIndex(a => a.id === state.selectedAudioId);
        if (audioIdx >= 0) {
            const audio = state.audioTracks[audioIdx];
            const audioOffset = audio.offset || 0;
            const audioDur = getAudioDuration(audio);

            if (state.playheadTime > audioOffset && state.playheadTime < audioOffset + audioDur) {
                const localTime = state.playheadTime - audioOffset;
                const speed = audio.speed || 1;
                const actualTime = localTime * speed + (audio.startTrim || 0);

                const audio1 = { ...audio, id: generateId(), endTrim: audio.duration - actualTime };
                const audio2 = { ...audio, id: generateId(), startTrim: actualTime, offset: state.playheadTime };

                pushHistory();
                state.audioTracks.splice(audioIdx, 1, audio1, audio2);
                state.selectedAudioId = null;
                renderTimeline();
                saveDocument();

                if (window.showToast) window.showToast('Audio split at playhead', false);
                return;
            }
        }
    }

    if (state.videoClips.length === 0) {
        if (window.showToast) window.showToast('Place playhead within a clip to split', false);
        return;
    }

    // Find which video clip the playhead is in
    let accumulated = 0;
    for (let i = 0; i < state.videoClips.length; i++) {
        const clipDur = getClipDuration(state.videoClips[i]);
        if (state.playheadTime > accumulated && state.playheadTime < accumulated + clipDur) {
            const clip = state.videoClips[i];
            const localTime = state.playheadTime - accumulated; // time within the clip's visible duration
            const actualTime = localTime + (clip.startTrim || 0); // time in the original file

            // Create two clips from this one
            const clip1 = {
                ...clip,
                id: generateId(),
                endTrim: clip.duration - actualTime,
                rotation: clip.rotation || 0,
                flipH: !!clip.flipH,
                flipV: !!clip.flipV,
                filters: clip.filters ? { ...clip.filters } : { preset: 'none', brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0 },
            };
            const clip2 = {
                ...clip,
                id: generateId(),
                startTrim: actualTime,
                rotation: clip.rotation || 0,
                flipH: !!clip.flipH,
                flipV: !!clip.flipV,
                filters: clip.filters ? { ...clip.filters } : { preset: 'none', brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0 },
            };

            // Replace original with two clips
            pushHistory();
            state.videoClips.splice(i, 1, clip1, clip2);
            state.selectedClipId = null;
            renderTimeline();
            updateEmptyState();
            saveDocument();

            if (window.showToast) window.showToast('Clip split at playhead', false);
            return;
        }
        accumulated += clipDur;
    }

    if (window.showToast) window.showToast('Place playhead within a clip to split', false);
}

export function deleteSelected() {
    if (state.selectedClipId) {
        pushHistory();
        const toDelete = state.videoClips.find(c => c.id === state.selectedClipId);
        state.videoClips = state.videoClips.filter(c => c.id !== state.selectedClipId);
        if (toDelete && toDelete.objectUrl) {
            const stillUsed = state.videoClips.some(c => c.objectUrl === toDelete.objectUrl);
            if (!stillUsed) { try { URL.revokeObjectURL(toDelete.objectUrl); } catch (_) {} }
        }
        state.selectedClipId = null;
        renderTimeline();
        updateEmptyState();
        updatePreview();
        saveDocument();
        if (window.showToast) window.showToast('Clip deleted', false);
    } else if (state.selectedAudioId) {
        pushHistory();
        const toDelete = state.audioTracks.find(a => a.id === state.selectedAudioId);
        state.audioTracks = state.audioTracks.filter(a => a.id !== state.selectedAudioId);
        if (toDelete && toDelete.objectUrl) {
            const stillUsed = state.audioTracks.some(a => a.objectUrl === toDelete.objectUrl);
            if (!stillUsed) { try { URL.revokeObjectURL(toDelete.objectUrl); } catch (_) {} }
        }
        state.selectedAudioId = null;
        renderTimeline();
        saveDocument();
        if (window.showToast) window.showToast('Audio track deleted', false);
    } else if (state.selectedTextId) {
        pushHistory();
        state.textOverlays = state.textOverlays.filter(t => t.id !== state.selectedTextId);
        state.selectedTextId = null;
        renderTimeline();
        updateTextOverlayPreview();
        updateCanvasBox();
        saveDocument();
        if (window.showToast) window.showToast('Text overlay deleted', false);
    } else if (state.selectedOverlayId) {
        pushHistory();
        const toDelete = state.overlayTracks.find(o => o.id === state.selectedOverlayId);
        state.overlayTracks = state.overlayTracks.filter(o => o.id !== state.selectedOverlayId);
        if (toDelete && toDelete.objectUrl && !toDelete.isSticker) {
            const stillUsed = state.overlayTracks.some(o => o.objectUrl === toDelete.objectUrl);
            if (!stillUsed) { try { URL.revokeObjectURL(toDelete.objectUrl); } catch (_) {} }
        }
        state.selectedOverlayId = null;
        renderTimeline();
        updateOverlayPreview();
        updateCanvasBox();
        saveDocument();
        if (window.showToast) window.showToast('Overlay/Sticker deleted', false);
    } else if (state.selectedSubtitleId) {
        pushHistory();
        state.subtitleTracks = state.subtitleTracks.filter(s => s.id !== state.selectedSubtitleId);
        state.selectedSubtitleId = null;
        renderTimeline();
        updateCanvasBox();
        saveDocument();
        if (window.showToast) window.showToast('Subtitle deleted', false);
    } else {
        if (window.showToast) window.showToast('Select a clip, audio, text, or overlay to delete', false);
    }
}

/* ==============================
   TRIM MODAL
   ============================== */

export function openTrimModal() {
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
        if (window.showToast) window.showToast('Select a clip or audio to trim', false);
        return;
    }

    state.trimTarget = { type, id: item.id };

    const modal = document.getElementById('cupcat-trim-modal');
    modal.style.display = 'flex';

    const startSlider = document.getElementById('cupcat-trim-start');
    const endSlider = document.getElementById('cupcat-trim-end');
    const maxTrim = item.duration * 0.9;

    startSlider.max = maxTrim;
    endSlider.max = maxTrim;
    startSlider.value = item.startTrim || 0;
    endSlider.value = item.endTrim || 0;

    updateTrimPreview();
}

export function closeTrimModal() {
    document.getElementById('cupcat-trim-modal').style.display = 'none';
    state.trimTarget = null;
}

export function updateTrimPreview() {
    const startVal = parseFloat(document.getElementById('cupcat-trim-start').value);
    const endVal = parseFloat(document.getElementById('cupcat-trim-end').value);

    document.getElementById('cupcat-trim-start-val').textContent = startVal.toFixed(1) + 's';
    document.getElementById('cupcat-trim-end-val').textContent = endVal.toFixed(1) + 's';

    if (state.trimTarget) {
        let item;
        if (state.trimTarget.type === 'video') {
            item = state.videoClips.find(c => c.id === state.trimTarget.id);
        } else {
            item = state.audioTracks.find(a => a.id === state.trimTarget.id);
        }
        if (item) {
            const remaining = item.duration - startVal - endVal;
            const info = document.getElementById('cupcat-trim-preview-info');
            info.innerHTML = `
                Original: <strong>${formatTime(item.duration)}</strong> →
                Result: <strong style="color: ${remaining > 0.1 ? '#00e676' : '#ff5252'}">${formatTime(Math.max(0, remaining))}</strong>
            `;
        }
    }
}

export function applyTrim() {
    if (!state.trimTarget) return;

    const startVal = parseFloat(document.getElementById('cupcat-trim-start').value);
    const endVal = parseFloat(document.getElementById('cupcat-trim-end').value);

    let item;
    if (state.trimTarget.type === 'video') {
        item = state.videoClips.find(c => c.id === state.trimTarget.id);
    } else {
        item = state.audioTracks.find(a => a.id === state.trimTarget.id);
    }

    if (item) {
        const remaining = item.duration - startVal - endVal;
        if (remaining < 0.1) {
            if (window.showToast) window.showToast('Trim values too large - clip would be empty', true);
            return;
        }
        pushHistory();
        item.startTrim = startVal;
        item.endTrim = endVal;
    }

    closeTrimModal();
    renderTimeline();
    saveDocument();
    if (window.showToast) window.showToast('Trim applied', false);
}

/* ==============================
   DUPLICATE SELECTED
   ============================== */
export function duplicateSelected() {
    if (state.selectedClipId) {
        const idx = state.videoClips.findIndex(c => c.id === state.selectedClipId);
        if (idx >= 0) {
            const orig = state.videoClips[idx];
            const copy = {
                ...orig,
                id: generateId(),
                name: (orig.name || 'Clip') + ' (Copy)',
                filters: orig.filters ? { ...orig.filters } : undefined,
                keyframes: orig.keyframes ? JSON.parse(JSON.stringify(orig.keyframes)) : []
            };
            pushHistory();
            state.videoClips.splice(idx + 1, 0, copy);
            state.selectedClipId = copy.id;
            renderTimeline();
            updateEmptyState();
            updatePreview();
            saveDocument();
            if (window.showToast) window.showToast('Clip duplicated', false);
            return;
        }
    } else if (state.selectedAudioId) {
        const idx = state.audioTracks.findIndex(a => a.id === state.selectedAudioId);
        if (idx >= 0) {
            const orig = state.audioTracks[idx];
            const dur = getAudioDuration(orig);
            const copy = {
                ...orig,
                id: generateId(),
                name: (orig.name || 'Audio') + ' (Copy)',
                offset: (orig.offset || 0) + dur + 0.5
            };
            pushHistory();
            state.audioTracks.push(copy);
            state.selectedAudioId = copy.id;
            renderTimeline();
            saveDocument();
            if (window.showToast) window.showToast('Audio track duplicated', false);
            return;
        }
    } else if (state.selectedTextId) {
        const orig = state.textOverlays.find(t => t.id === state.selectedTextId);
        if (orig) {
            const dur = (orig.endTime || 5) - (orig.startTime || 0);
            const copy = {
                ...orig,
                id: generateId(),
                startTime: orig.endTime || 5,
                endTime: (orig.endTime || 5) + dur,
                keyframes: orig.keyframes ? JSON.parse(JSON.stringify(orig.keyframes)) : []
            };
            pushHistory();
            state.textOverlays.push(copy);
            state.selectedTextId = copy.id;
            renderTimeline();
            updateTextOverlayPreview();
            updateCanvasBox();
            saveDocument();
            if (window.showToast) window.showToast('Text duplicated', false);
            return;
        }
    } else if (state.selectedOverlayId) {
        const orig = state.overlayTracks.find(o => o.id === state.selectedOverlayId);
        if (orig) {
            const dur = (orig.endTime || 5) - (orig.startTime || 0);
            const copy = {
                ...orig,
                id: generateId(),
                startTime: orig.endTime || 5,
                endTime: (orig.endTime || 5) + dur,
                keyframes: orig.keyframes ? JSON.parse(JSON.stringify(orig.keyframes)) : []
            };
            pushHistory();
            state.overlayTracks.push(copy);
            state.selectedOverlayId = copy.id;
            renderTimeline();
            updateOverlayPreview();
            updateCanvasBox();
            saveDocument();
            if (window.showToast) window.showToast('Overlay duplicated', false);
            return;
        }
    } else if (state.selectedSubtitleId) {
        const orig = state.subtitleTracks.find(s => s.id === state.selectedSubtitleId);
        if (orig) {
            const dur = (orig.endTime || 3) - (orig.startTime || 0);
            const copy = {
                ...orig,
                id: generateId(),
                startTime: orig.endTime || 3,
                endTime: (orig.endTime || 3) + dur,
                keyframes: orig.keyframes ? JSON.parse(JSON.stringify(orig.keyframes)) : []
            };
            pushHistory();
            state.subtitleTracks.push(copy);
            state.selectedSubtitleId = copy.id;
            renderTimeline();
            updateCanvasBox();
            saveDocument();
            if (window.showToast) window.showToast('Subtitle duplicated', false);
            return;
        }
    } else {
        if (window.showToast) window.showToast('Select a clip, audio, text, or overlay to duplicate', false);
    }
}

/* ==============================
   EXTRACT AUDIO FROM VIDEO
   ============================== */
export function extractAudioFromSelected() {
    if (!state.selectedClipId) {
        if (window.showToast) window.showToast('Select a video clip to extract audio', false);
        return;
    }
    const idx = state.videoClips.findIndex(c => c.id === state.selectedClipId);
    if (idx < 0) return;
    const clip = state.videoClips[idx];
    if (clip.isImage) {
        if (window.showToast) window.showToast('Photos do not contain audio', true);
        return;
    }

    pushHistory();
    clip.muted = true;
    clip.volume = 0;

    const audioOffset = getClipStartTime(idx);
    const newAudio = {
        id: generateId(),
        name: `Audio from ${clip.name || 'Video'}`,
        file: clip.file,
        objectUrl: clip.objectUrl,
        duration: clip.duration,
        startTrim: clip.startTrim || 0,
        endTrim: clip.endTrim || 0,
        speed: clip.speed || 1,
        offset: audioOffset,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
        muted: false
    };

    state.audioTracks.push(newAudio);
    state.selectedClipId = null;
    state.selectedAudioId = newAudio.id;
    renderTimeline();
    saveDocument();
    if (window.showToast) window.showToast('Audio extracted to music track ✓', false);
}

/* ==============================
   FRAME CAPTURE UTILITY
   ============================== */
export async function captureCurrentFrameBlob() {
    const v = state.dom.previewVideo;
    const canvas = document.createElement('canvas');
    if (v && v.videoWidth > 0 && v.videoHeight > 0) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(v, 0, 0, v.videoWidth, v.videoHeight);
    } else if (state.dom.mainCanvas && state.dom.mainCanvas.width > 0) {
        canvas.width = state.dom.mainCanvas.width;
        canvas.height = state.dom.mainCanvas.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(state.dom.mainCanvas, 0, 0);
    } else {
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 1280, 720);
    }
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

/* ==============================
   FREEZE FRAME MODAL & ACTION
   ============================== */
let freezeFrameBlob = null;
let freezeFrameUrl = null;

export async function openFreezeModal() {
    if (state.videoClips.length === 0) {
        if (window.showToast) window.showToast('Add video clips to timeline first', false);
        return;
    }

    freezeFrameBlob = await captureCurrentFrameBlob();
    if (freezeFrameUrl) URL.revokeObjectURL(freezeFrameUrl);
    freezeFrameUrl = URL.createObjectURL(freezeFrameBlob);

    const thumb = document.getElementById('cupcat-freeze-thumb');
    if (thumb) thumb.src = freezeFrameUrl;

    const slider = document.getElementById('cupcat-freeze-duration-slider');
    if (slider) slider.value = 3.0;

    const valEl = document.getElementById('cupcat-freeze-duration-val');
    if (valEl) valEl.textContent = '3.0s';

    const modal = document.getElementById('cupcat-freeze-modal');
    if (modal) modal.style.display = 'flex';
}

export function closeFreezeModal() {
    const modal = document.getElementById('cupcat-freeze-modal');
    if (modal) modal.style.display = 'none';
}

export function updateFreezeDuration(dur) {
    const slider = document.getElementById('cupcat-freeze-duration-slider');
    if (slider) slider.value = dur;
    const valEl = document.getElementById('cupcat-freeze-duration-val');
    if (valEl) valEl.textContent = Number(dur).toFixed(1) + 's';
}

export async function applyFreezeFrame() {
    const slider = document.getElementById('cupcat-freeze-duration-slider');
    const duration = slider ? parseFloat(slider.value) || 3.0 : 3.0;

    if (!freezeFrameBlob) {
        freezeFrameBlob = await captureCurrentFrameBlob();
        freezeFrameUrl = URL.createObjectURL(freezeFrameBlob);
    }

    let accumulated = 0;
    let targetClipIdx = -1;
    for (let i = 0; i < state.videoClips.length; i++) {
        const clipDur = getClipDuration(state.videoClips[i]);
        if (state.playheadTime >= accumulated && state.playheadTime <= accumulated + clipDur) {
            targetClipIdx = i;
            break;
        }
        accumulated += clipDur;
    }

    if (targetClipIdx < 0 && state.videoClips.length > 0) {
        targetClipIdx = state.videoClips.length - 1;
    }

    if (targetClipIdx < 0) {
        if (window.showToast) window.showToast('Select a position on timeline to freeze', false);
        return;
    }

    const clip = state.videoClips[targetClipIdx];
    const localTime = Math.max(0, state.playheadTime - accumulated);
    const actualTime = localTime + (clip.startTrim || 0);

    const persistentBlob = freezeFrameBlob;
    const frameFile = new File([persistentBlob], `freeze_${Date.now()}.png`, { type: 'image/png' });
    const persistentUrl = URL.createObjectURL(persistentBlob);

    const freezeClip = {
        id: generateId(),
        name: `Freeze (${duration.toFixed(1)}s)`,
        file: frameFile,
        objectUrl: persistentUrl,
        duration: duration,
        startTrim: 0,
        endTrim: 0,
        isImage: true,
        kenBurns: 'none',
        volume: 0,
        muted: true,
        filters: clip.filters ? { ...clip.filters } : { preset: 'none', brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0 },
        rotation: clip.rotation || 0,
        flipH: !!clip.flipH,
        flipV: !!clip.flipV,
    };

    pushHistory();
    if (!clip.isImage && localTime > 0.05 && localTime < getClipDuration(clip) - 0.05) {
        const clip1 = {
            ...clip,
            id: generateId(),
            endTrim: clip.duration - actualTime,
        };
        const clip2 = {
            ...clip,
            id: generateId(),
            startTrim: actualTime,
        };
        state.videoClips.splice(targetClipIdx, 1, clip1, freezeClip, clip2);
    } else {
        state.videoClips.splice(targetClipIdx + 1, 0, freezeClip);
    }

    state.selectedClipId = freezeClip.id;
    closeFreezeModal();
    renderTimeline();
    updateEmptyState();
    updatePreview();
    saveDocument();
    if (window.showToast) window.showToast(`Freeze frame inserted (${duration.toFixed(1)}s) ✓`, false);
}

/* ==============================
   REVERSE VIDEO MODAL & ACTION
   ============================== */
let reverseTargetClip = null;
let reverseMode = 'all'; // 'all' or 'segment'

export function openReverseModal() {
    if (state.videoClips.length === 0) {
        if (window.showToast) window.showToast('No video clips on timeline', false);
        return;
    }

    let clip = null;
    if (state.selectedClipId) {
        clip = state.videoClips.find(c => c.id === state.selectedClipId);
    }
    if (!clip) {
        let acc = 0;
        for (let i = 0; i < state.videoClips.length; i++) {
            const dur = getClipDuration(state.videoClips[i]);
            if (state.playheadTime >= acc && state.playheadTime <= acc + dur) {
                clip = state.videoClips[i];
                state.selectedClipId = clip.id;
                break;
            }
            acc += dur;
        }
    }
    if (!clip) clip = state.videoClips[0];

    if (clip.isImage) {
        if (window.showToast) window.showToast('Photos cannot be reversed', true);
        return;
    }

    reverseTargetClip = clip;
    reverseMode = 'all';

    const titleEl = document.getElementById('cupcat-reverse-clip-name');
    if (titleEl) titleEl.textContent = clip.name || 'Video Clip';

    const startSlider = document.getElementById('cupcat-reverse-start');
    const endSlider = document.getElementById('cupcat-reverse-end');
    const dur = clip.duration || 5;

    if (startSlider) {
        startSlider.min = 0;
        startSlider.max = Math.max(0, dur - 0.2).toFixed(2);
        startSlider.value = (clip.startTrim || 0).toFixed(2);
    }
    if (endSlider) {
        endSlider.min = 0;
        endSlider.max = Math.max(0, dur - 0.2).toFixed(2);
        endSlider.value = (clip.endTrim || 0).toFixed(2);
    }

    setReverseMode('all');
    updateReverseSegmentPreview();

    const modal = document.getElementById('cupcat-reverse-modal');
    if (modal) modal.style.display = 'flex';
}

export function closeReverseModal() {
    const modal = document.getElementById('cupcat-reverse-modal');
    if (modal) modal.style.display = 'none';
    reverseTargetClip = null;
}

export function setReverseMode(mode) {
    reverseMode = mode;
    const btnAll = document.getElementById('cupcat-reverse-mode-all');
    const btnSeg = document.getElementById('cupcat-reverse-mode-segment');
    const segControls = document.getElementById('cupcat-reverse-segment-controls');

    if (btnAll && btnSeg) {
        if (mode === 'all') {
            btnAll.style.background = 'rgba(255,138,101,0.25)';
            btnAll.style.borderColor = '#ff8a65';
            btnAll.style.color = '#ff8a65';
            btnSeg.style.background = 'rgba(255,255,255,0.05)';
            btnSeg.style.borderColor = 'transparent';
            btnSeg.style.color = '#aaa';
            if (segControls) segControls.style.display = 'none';
        } else {
            btnSeg.style.background = 'rgba(255,138,101,0.25)';
            btnSeg.style.borderColor = '#ff8a65';
            btnSeg.style.color = '#ff8a65';
            btnAll.style.background = 'rgba(255,255,255,0.05)';
            btnAll.style.borderColor = 'transparent';
            btnAll.style.color = '#aaa';
            if (segControls) segControls.style.display = 'block';
        }
    }
    updateReverseSegmentPreview();
}

export function updateReverseSegmentPreview() {
    if (!reverseTargetClip) return;
    const dur = reverseTargetClip.duration || 5;
    const startVal = parseFloat(document.getElementById('cupcat-reverse-start')?.value || 0);
    const endVal = parseFloat(document.getElementById('cupcat-reverse-end')?.value || 0);

    const startValEl = document.getElementById('cupcat-reverse-start-val');
    const endValEl = document.getElementById('cupcat-reverse-end-val');
    if (startValEl) startValEl.textContent = startVal.toFixed(1) + 's';
    if (endValEl) endValEl.textContent = endVal.toFixed(1) + 's';

    const infoEl = document.getElementById('cupcat-reverse-info');
    if (!infoEl) return;

    if (reverseMode === 'all') {
        const isCurrentlyReversed = !!reverseTargetClip.isReversed;
        infoEl.innerHTML = `
            Status: <strong>${isCurrentlyReversed ? 'Currently Reversed' : 'Normal Playback'}</strong><br>
            Action: <strong>${isCurrentlyReversed ? 'Restore forward playback' : 'Play entire clip backwards'}</strong>
        `;
    } else {
        const segmentDur = Math.max(0.1, dur - startVal - endVal);
        infoEl.innerHTML = `
            Reversing segment from <strong>${formatTime(startVal)}</strong> to <strong>${formatTime(dur - endVal)}</strong><br>
            Segment length: <strong style="color: #ff8a65">${segmentDur.toFixed(1)}s</strong>
        `;
    }
}

export function applyReverseAction() {
    if (!reverseTargetClip) return;
    const clipIdx = state.videoClips.findIndex(c => c.id === reverseTargetClip.id);
    if (clipIdx < 0) return;

    const clip = state.videoClips[clipIdx];
    const reverseAudioCheckbox = document.getElementById('cupcat-reverse-audio-toggle');
    const reverseAudio = reverseAudioCheckbox ? reverseAudioCheckbox.checked : true;

    pushHistory();

    if (reverseMode === 'all') {
        clip.isReversed = !clip.isReversed;
        clip.reverseAudio = reverseAudio;
        state.selectedClipId = clip.id;
        if (window.showToast) window.showToast(clip.isReversed ? 'Clip reversed ✓' : 'Forward playback restored ✓', false);
    } else {
        const startVal = parseFloat(document.getElementById('cupcat-reverse-start')?.value || 0);
        const endVal = parseFloat(document.getElementById('cupcat-reverse-end')?.value || 0);
        const dur = clip.duration || 5;

        const segStartActual = (clip.startTrim || 0) + startVal;
        const segEndActual = dur - (clip.endTrim || 0) - endVal;

        if (segEndActual - segStartActual < 0.2) {
            if (window.showToast) window.showToast('Selected segment is too short', true);
            return;
        }

        const newClips = [];
        if (startVal > 0.1) {
            newClips.push({
                ...clip,
                id: generateId(),
                endTrim: dur - segStartActual,
            });
        }

        const revClip = {
            ...clip,
            id: generateId(),
            name: `${clip.name || 'Clip'} (Reversed)`,
            startTrim: segStartActual,
            endTrim: dur - segEndActual,
            isReversed: true,
            reverseAudio: reverseAudio,
        };
        newClips.push(revClip);

        if (endVal > 0.1) {
            newClips.push({
                ...clip,
                id: generateId(),
                startTrim: segEndActual,
            });
        }

        state.videoClips.splice(clipIdx, 1, ...newClips);
        state.selectedClipId = revClip.id;
        if (window.showToast) window.showToast('Reversed segment created ✓', false);
    }

    closeReverseModal();
    renderTimeline();
    updateEmptyState();
    updatePreview();
    saveDocument();
}
