import { state } from './state.js';
import { getClipDuration, getTotalDuration, getClipSpeed, getEffectiveVolumeAtTime, getAudioDuration, getCurrentClipAtTime, perceptualVolume } from './utils.js';
import { renderScene } from './render-scene.js';

// ── Web Audio API volume control ──────────────────────────────────────
// Android WebView ignores HTMLMediaElement.volume for intermediate values
// (only 0 = mute works).  Routing each element through a GainNode gives
// reliable per-element volume on every platform.
let _audioCtx = null;

export function initAudioContext() {
    if (!_audioCtx) {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_audioCtx.state === 'suspended') {
        _audioCtx.resume().catch(() => {});
    }
    return _audioCtx;
}

function getAudioContext() {
    return initAudioContext();
}

/**
 * Ensure the given HTMLMediaElement is connected through a GainNode.
 * Caches the GainNode on the element as `_gainNode` and the source as `_srcNode`.
 * Returns the GainNode.
 */
function ensureGainNode(mediaEl) {
    if (mediaEl._gainNode) return mediaEl._gainNode;

    const ctx = getAudioContext();
    const src = ctx.createMediaElementSource(mediaEl);
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(ctx.destination);

    mediaEl._srcNode = src;
    mediaEl._gainNode = gain;
    // Once routed through Web Audio, the element's own volume must stay at 1
    // (gain is controlled exclusively via GainNode).
    mediaEl.volume = 1;
    return gain;
}

/**
 * Apply a volume level to a media element via its GainNode.
 * `level` is the effective linear amplitude (0 – 2, where 1 = 100%).
 * An exponential (power-of-2) curve is applied so that the perceptual
 * loudness scales naturally with the UI slider position.
 */
export function setMediaVolume(mediaEl, level) {
    if (level <= 0) {
        mediaEl.muted = true;
        // Even if we use GainNode, setting muted is a reliable fallback for 0
    } else {
        mediaEl.muted = false;
    }
    
    try {
        const gain = ensureGainNode(mediaEl);
        gain.gain.value = perceptualVolume(level);
        mediaEl.volume = 1; // Handled by GainNode
    } catch (e) {
        // Fallback if GainNode fails (e.g. CORS on some WebViews)
        mediaEl.volume = perceptualVolume(level);
    }
}

// ── Anti-flicker: snapshot last frame to offscreen canvas before changing src ──
// When switching to a different source file, Android WebView clears the
// decoded buffer immediately — causing a poster / black flash.
// We capture the last decoded frame into an offscreen canvas; renderScene()
// draws it on the main editor canvas while the new source loads its first frame.
function holdLastFrame() {
    const v = state.dom.previewVideo;
    if (!v || v.videoWidth === 0) return;
    try {
        if (!state._heldFrameCanvas) {
            state._heldFrameCanvas = document.createElement('canvas');
        }
        const hc = state._heldFrameCanvas;
        hc.width = v.videoWidth;
        hc.height = v.videoHeight;
        const hCtx = hc.getContext('2d');
        hCtx.drawImage(v, 0, 0);
        state._holdingFrame = true;
    } catch (_) {}
}

function releaseHeldFrame() {
    state._holdingFrame = false;
}

let updatePreview = () => {};
let updatePreviewAtTime = () => {};
let updatePlayhead = () => {};
let updateTimeDisplay = () => {};
let renderTimeline = () => {};
let updateKeyframeDiamondButton = () => {};
let updateCanvasTransformBox = () => {};
let showPreviewImage = () => {};
let showPreviewVideo = () => {};
let applyPreviewFilter = () => {};
let applyPreviewTransform = () => {};
let updateTextOverlayPreview = () => {};
let updateOverlayPreview = () => {};
let updateSubtitlePreview = () => {};

export function setPlaybackCallbacks(callbacks) {
    if (callbacks.updatePreview) updatePreview = callbacks.updatePreview;
    if (callbacks.updatePreviewAtTime) updatePreviewAtTime = callbacks.updatePreviewAtTime;
    if (callbacks.updatePlayhead) updatePlayhead = callbacks.updatePlayhead;
    if (callbacks.updateTimeDisplay) updateTimeDisplay = callbacks.updateTimeDisplay;
    if (callbacks.renderTimeline) renderTimeline = callbacks.renderTimeline;
    if (callbacks.updateKeyframeDiamondButton) updateKeyframeDiamondButton = callbacks.updateKeyframeDiamondButton;
    if (callbacks.updateCanvasTransformBox) updateCanvasTransformBox = callbacks.updateCanvasTransformBox;
    if (callbacks.showPreviewImage) showPreviewImage = callbacks.showPreviewImage;
    if (callbacks.showPreviewVideo) showPreviewVideo = callbacks.showPreviewVideo;
    if (callbacks.applyPreviewFilter) applyPreviewFilter = callbacks.applyPreviewFilter;
    if (callbacks.applyPreviewTransform) applyPreviewTransform = callbacks.applyPreviewTransform;
    if (callbacks.updateTextOverlayPreview) updateTextOverlayPreview = callbacks.updateTextOverlayPreview;
    if (callbacks.updateOverlayPreview) updateOverlayPreview = callbacks.updateOverlayPreview;
    if (callbacks.updateSubtitlePreview) updateSubtitlePreview = callbacks.updateSubtitlePreview;
}

export function togglePlay() {
    const btn = document.getElementById('cupcat-play-btn');
    if (state.isPlaying) {
        stopPlayback();
    } else {
        startPlayback();
    }
}

export function startPlayback() {
    if (state.videoClips.length === 0) return;

    state.isPlaying = true;
    const btn = document.getElementById('cupcat-play-btn');
    btn.innerHTML = '<i class="fas fa-pause"></i>';

    const totalDur = getTotalDuration();
    if (state.playheadTime >= totalDur) {
        state.playheadTime = 0;
    }

    // Find current clip
    updatePreviewAtTime(state.playheadTime);
    // Only play video if the first visible clip is not an image
    const firstClip = getCurrentClipAtTime(state.playheadTime);
    state._playbackClipId = firstClip ? firstClip.id : null;
    if (firstClip && !firstClip.isImage) {
        state.dom.previewVideo.play().catch(() => {});
    }

    // Start any audio tracks that already overlap the current playhead
    syncAudioTracksToPlayhead();

    let lastTime = performance.now();
    state.playInterval = requestAnimationFrame(async function tick() {
        if (!state.isPlaying) return;

        const now = performance.now();
        const dt = Math.max(0, (now - lastTime) / 1000);
        lastTime = now;
        state.playheadTime += dt;

        const totalDur = getTotalDuration();
        if (state.playheadTime >= totalDur) {
            state.playheadTime = totalDur;
            stopPlayback();
            return;
        }

        // Check if we need to switch clips
        let accumulated = 0;
        let activeClip = null;
        for (let i = 0; i < state.videoClips.length; i++) {
            const clipDur = getClipDuration(state.videoClips[i]);
            if (state.playheadTime < accumulated + clipDur) {
                const clip = state.videoClips[i];
                activeClip = clip;
                if (clip.isImage) {
                    // Show image if not already showing this one
                    if (state.dom.previewImg.style.display === 'none' || state.dom.previewImg.src !== clip.objectUrl) {
                        showPreviewImage(clip.objectUrl, clip.kenBurns, clipDur);
                        applyPreviewFilter(clip);
                        applyPreviewTransform(clip);
                    }
                } else if (clip.objectUrl && state._playbackClipId !== clip.id) {
                    // ── Crossed into a new clip ──
                    state._playbackClipId = clip.id;

                    // Check: same source file? (split video shares the same objectUrl)
                    const isSameUrl = state.dom.previewVideo.getAttribute('src') === clip.objectUrl;
                    const expectedTrim = clip.startTrim || 0;
                    // Continuous split: same file AND playhead naturally sits at the new trimStart
                    const isContinuousSplit = isSameUrl && Math.abs((state.dom.previewVideo.currentTime || 0) - expectedTrim) < 0.35;

                    if (isContinuousSplit) {
                        // SEAMLESS: same source, continuous position — just update metadata, no re-seek!
                        state.dom.previewVideo.playbackRate = getClipSpeed(clip);
                        applyPreviewFilter(clip);
                        applyPreviewTransform(clip);
                        if (state.dom.previewVideo.paused) state.dom.previewVideo.play().catch(() => {});
                    } else if (isSameUrl) {
                        // Same source but need to seek (non-adjacent split)
                        state.dom.previewVideo.currentTime = expectedTrim;
                        state.dom.previewVideo.playbackRate = getClipSpeed(clip);
                        applyPreviewFilter(clip);
                        applyPreviewTransform(clip);
                        state.dom.previewVideo.play().catch(() => {});
                    } else {
                        // DIFFERENT source file — hold last frame, hide video, then switch
                        holdLastFrame();
                        showPreviewVideo();
                        state.dom.previewVideo.style.display = 'none'; // hide to prevent poster flash
                        state.dom.previewVideo.src = clip.objectUrl;
                        state.dom.previewVideo.playbackRate = getClipSpeed(clip);
                        applyPreviewFilter(clip);
                        applyPreviewTransform(clip);
                        const trimStart = clip.startTrim || 0;
                        state.dom.previewVideo.addEventListener('loadeddata', () => {
                            state.dom.previewVideo.currentTime = trimStart;
                            state.dom.previewVideo.style.display = 'block';
                            releaseHeldFrame();
                            state.dom.previewVideo.play().catch(() => {});
                        }, { once: true });
                    }
                } else if (clip.objectUrl && (state.dom.previewVideo.getAttribute('src') !== clip.objectUrl || state.dom.previewImg.style.display !== 'none')) {
                    // Different source file or switching from image → video (first encounter)
                    state._playbackClipId = clip.id;
                    holdLastFrame();
                    showPreviewVideo();
                    state.dom.previewVideo.style.display = 'none'; // hide to prevent poster flash
                    state.dom.previewVideo.src = clip.objectUrl;
                    state.dom.previewVideo.playbackRate = getClipSpeed(clip);
                    applyPreviewFilter(clip);
                    applyPreviewTransform(clip);
                    // Wait for first frame before showing
                    const trimStart = clip.startTrim || 0;
                    state.dom.previewVideo.addEventListener('loadeddata', () => {
                        state.dom.previewVideo.currentTime = trimStart;
                        state.dom.previewVideo.style.display = 'block';
                        releaseHeldFrame();
                        state.dom.previewVideo.play().catch(() => {});
                    }, { once: true });
                }
                break;
            }
            accumulated += clipDur;
        }

        if (activeClip && !activeClip.isImage) {
            setMediaVolume(state.dom.previewVideo, getEffectiveVolumeAtTime(activeClip, state.playheadTime - accumulated));
        }

        syncAudioTracksToPlayhead();

        updateTextOverlayPreview();
        updateOverlayPreview();
        updateSubtitlePreview();
        if (state.useCanvasRenderer) {
            await renderScene(state.playheadTime);
        }
        updatePlayhead();
        if (state.isPlaying) {
            state.playInterval = requestAnimationFrame(tick);
        }
    });
}

export function stopPlayback() {
    state.isPlaying = false;
    if (state.playInterval) {
        cancelAnimationFrame(state.playInterval);
        state.playInterval = null;
    }
    state._playbackClipId = null;

    const btn = document.getElementById('cupcat-play-btn');
    if (btn) btn.innerHTML = '<i class="fas fa-play"></i>';

    if (state.dom.previewVideo) state.dom.previewVideo.pause();

    // Pause any playing overlay video elements
    state.overlayTracks.forEach(ovl => {
        if (ovl._previewEl && !ovl.isImage && ovl._previewEl.tagName === 'VIDEO') {
            ovl._previewEl.pause();
        }
    });

    stopAudioPlayback();
    updatePlayhead();
}

export function syncAudioTracksToPlayhead() {
    state.audioTracks.forEach(audio => {
        if (!audio.objectUrl) return;

        const audioOffset = audio.offset || 0;
        const audioStart = audio.startTrim || 0;
        const inRange = state.playheadTime >= audioOffset && state.playheadTime < audioOffset + getAudioDuration(audio);

        if (inRange) {
            const speed = getClipSpeed(audio);
            const expectedTime = audioStart + (state.playheadTime - audioOffset) * speed;
            if (!audio._audioEl) {
                const el = new Audio(audio.objectUrl);
                audio._audioEl = el;
                el.playbackRate = speed;
                // Safari (WebKit/AVFoundation) ignores currentTime assignment
                // when readyState === 0 (HAVE_NOTHING). Setting it before
                // metadata is loaded causes Safari to return 0 on subsequent
                // reads, triggering drift correction on every rAF frame
                // (~60-120 Hz), which flushes hardware audio buffers and
                // produces audible 0.5-1s gaps / skips / pauses.
                // Wait for loadedmetadata to ensure the seek is accepted.
                el.addEventListener('loadedmetadata', () => {
                    if (audio._audioEl === el) {
                        el.currentTime = audioStart + (state.playheadTime - audioOffset) * speed;
                        el.play().catch(() => {});
                    }
                }, { once: true });
            } else if (
                // Guard drift correction against Safari-specific edge cases:
                // 1) readyState >= 1 ensures metadata is loaded (currentTime reads are valid)
                // 2) !seeking prevents re-issuing seeks while a previous seek is pending,
                //    which in Safari/AVFoundation cancels the in-flight seek and stalls playback
                // The threshold scales with speed: at higher playback rates,
                // small timing variances are amplified, so a fixed 0.4s
                // threshold triggers too-frequent re-seeks that cause audible
                // gaps.  Scaling by speed (min 0.4s) keeps 1x behaviour
                // identical while giving 2x+ room to breathe.
                audio._audioEl.readyState >= 1 &&
                !audio._audioEl.seeking &&
                Math.abs(audio._audioEl.currentTime - expectedTime) > Math.max(0.4, 0.4 * speed)
            ) {
                // Native audio playback can drift from the rAF-driven
                // playhead over time — nudge it back in sync.
                audio._audioEl.currentTime = expectedTime;
            }
            // Recomputed every tick (this function runs once per rAF frame
            // during playback), so fade-in/out animates smoothly across the
            // track's own local timeline rather than jumping only when the
            // element is (re)created.
            if (audio._audioEl.readyState >= 1) {
                setMediaVolume(audio._audioEl, getEffectiveVolumeAtTime(audio, state.playheadTime - audioOffset));
            }
        } else if (audio._audioEl) {
            audio._audioEl.pause();
            if (audio._audioEl._gainNode) {
                audio._audioEl._gainNode.disconnect();
                audio._audioEl._srcNode.disconnect();
            }
            audio._audioEl = null;
        }
    });
}

export function stopAudioPlayback() {
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
