// cupcat/utils.js — Helper functions (depends on: state)

import { state } from './state.js';

export function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

export function stopPlaybackSafe() {
    state.isPlaying = false;
    if (state.playInterval) {
        cancelAnimationFrame(state.playInterval);
        state.playInterval = null;
    }
    state.audioTracks.forEach(audio => {
        if (audio._audioEl) {
            audio._audioEl.pause();
            if (audio._audioEl._gainNode) {
                audio._audioEl._gainNode.disconnect();
                audio._audioEl._srcNode.disconnect();
            }
            audio._audioEl = null;
        }
    });
}

export function getClipSpeed(item) {
    return item && item.speed ? item.speed : 1;
}

// FFmpeg's `atempo` filter only accepts factors in [0.5, 2.0], so a target
// speed outside that range has to be reached by chaining multiple atempo
// stages (e.g. 4x = atempo=2.0,atempo=2.0). Used at export time only — the
// live preview instead just sets HTMLMediaElement.playbackRate directly.
export function buildAtempoChain(speed) {
    let s = speed;
    const stages = [];
    if (s < 0.5) {
        while (s < 0.5) { stages.push(0.5); s /= 0.5; }
    } else if (s > 2.0) {
        while (s > 2.0) { stages.push(2.0); s /= 2.0; }
    }
    stages.push(s);
    return stages.map(v => `atempo=${v.toFixed(4)}`).join(',');
}

// Timeline (output) duration — the trimmed source duration scaled by speed.
// A 2x clip occupies half the timeline space; a 0.5x clip occupies double.
export function getClipDuration(clip) {
    const trimmed = (clip.duration || 0) - (clip.startTrim || 0) - (clip.endTrim || 0);
    return trimmed / getClipSpeed(clip);
}

export function getTotalDuration() {
    let total = 0;
    state.videoClips.forEach(c => { total += getClipDuration(c); });
    return total;
}

/**
 * Maximum end point across ALL timeline tracks (video, audio, overlays, text, subtitles).
 * Audio tracks can have offsets and be longer than video, so we must find the
 * rightmost point for proper container width / scrolling.
 */
export function getMaxTimelineDuration() {
    let maxEnd = getTotalDuration();

    if (state.audioTracks) {
        state.audioTracks.forEach(audio => {
            const audioEnd = (audio.offset || 0) + getAudioDuration(audio);
            if (audioEnd > maxEnd) maxEnd = audioEnd;
        });
    }
    if (state.overlayTracks) {
        state.overlayTracks.forEach(ovl => {
            const ovlEnd = ovl.endTime || 0;
            if (ovlEnd > maxEnd) maxEnd = ovlEnd;
        });
    }
    if (state.textOverlays) {
        state.textOverlays.forEach(txt => {
            const txtEnd = txt.endTime || 0;
            if (txtEnd > maxEnd) maxEnd = txtEnd;
        });
    }
    if (state.subtitleTracks) {
        state.subtitleTracks.forEach(sub => {
            const subEnd = sub.endTime || 0;
            if (subEnd > maxEnd) maxEnd = subEnd;
        });
    }

    return maxEnd;
}

export function getClipStartTime(index) {
    let t = 0;
    for (let i = 0; i < index; i++) {
        t += getClipDuration(state.videoClips[i]);
    }
    return t;
}

export function getAudioDuration(audio) {
    const trimmed = (audio.duration || 0) - (audio.startTrim || 0) - (audio.endTrim || 0);
    return trimmed / getClipSpeed(audio);
}

// Volume as stored on the item (0-2, where 1 = 100%), collapsed to 0 when muted.
export function getItemVolume(item) {
    return item.volume !== undefined ? item.volume : 1;
}

// Convert a linear volume (0-2) to a perceptually natural amplitude.
// Human hearing is logarithmic, so a linear slider mapped directly to
// amplitude feels like "nothing changes until mute".  Squaring the
// value (power-of-2 curve) provides a good perceptual mapping where
// 50% on the slider sounds about half as loud as 100%.
export function perceptualVolume(linear) {
    return linear <= 0 ? 0 : Math.pow(linear, 2);
}

// Native <video>/<audio> elements only accept 0-1, so preview clamps at 100%
// even if the stored value allows boosting above that for export.
export function getEffectiveVolume(item) {
    if (!item || item.muted) return 0;
    return getItemVolume(item); // Allow values > 1.0 for volume boost (export uses full gain)
}

// Same as getEffectiveVolume, but additionally animates a linear fade-in/
// fade-out on top of it. localTime is seconds elapsed since the item's own
// start on the timeline (0 at the first frame of the clip/track, up to
// getClipDuration(item) at its last frame) — NOT absolute playhead time and
// NOT source-file time. getClipDuration/getAudioDuration share the same
// (duration - startTrim - endTrim) / speed formula, so getClipDuration works
// for audio tracks too.
export function getEffectiveVolumeAtTime(item, localTime) {
    const base = getEffectiveVolume(item);
    if (base <= 0) return 0;

    const fadeIn = item.fadeIn || 0;
    const fadeOut = item.fadeOut || 0;
    if (fadeIn <= 0 && fadeOut <= 0) return base;

    const dur = getClipDuration(item);
    let mult = 1;

    if (fadeIn > 0 && localTime < fadeIn) {
        mult = Math.min(mult, Math.max(0, localTime / fadeIn));
    }
    if (fadeOut > 0) {
        const fadeOutStart = dur - fadeOut;
        if (localTime > fadeOutStart) {
            mult = Math.min(mult, Math.max(0, (dur - localTime) / fadeOut));
        }
    }

    return base * mult;
}

export function formatTime(seconds) {
    const s = Math.max(0, seconds);
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);
    return `${m}:${sec.toString().padStart(2, '0')}.${ms}`;
}

export function getMediaDuration(file) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        // Images have no intrinsic duration — default to 5 seconds
        if (file.type.startsWith('image')) {
            resolve({ duration: 5, url, isImage: true });
            return;
        }
        const el = file.type.startsWith('video') ? document.createElement('video') : document.createElement('audio');
        el.preload = 'metadata';
        el.onloadedmetadata = () => {
            resolve({
                duration: el.duration,
                url,
                isImage: false,
                // Expose native dimensions so the caller can auto-detect
                // the video's aspect ratio (portrait vs landscape).
                videoWidth: el.videoWidth || 0,
                videoHeight: el.videoHeight || 0,
            });
        };
        el.onerror = () => resolve({ duration: 10, url, isImage: false });
        el.src = url;
    });
}

export function getCurrentClipAtTime(time) {
    let t = 0;
    for (let i = 0; i < state.videoClips.length; i++) {
        const dur = getClipDuration(state.videoClips[i]);
        if (time >= t && time < t + dur) return state.videoClips[i];
        t += dur;
    }
    return null;
}
