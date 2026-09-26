import { state } from './state.js';
import { getClipDuration, getClipSpeed, getEffectiveVolumeAtTime } from './utils.js';
import { renderScene } from './render-scene.js';
import { setMediaVolume } from './playback.js';

let getClipCSSFilter = () => '';
let applyPreviewFilter = () => {};
let getClipCSSTransform = () => '';
let applyPreviewTransform = () => {};
let getInterpolatedKeyframe = () => null;

let updateCanvasTransformBox = () => {};
let renderTimeline = () => {};
let updateTextOverlayPreview = () => {};
let updateOverlayPreview = () => {};
let updateSubtitlePreview = () => {};

export function setPreviewCallbacks(callbacks) {
    if (callbacks.getClipCSSFilter) getClipCSSFilter = callbacks.getClipCSSFilter;
    if (callbacks.applyPreviewFilter) applyPreviewFilter = callbacks.applyPreviewFilter;
    if (callbacks.getClipCSSTransform) getClipCSSTransform = callbacks.getClipCSSTransform;
    if (callbacks.applyPreviewTransform) applyPreviewTransform = callbacks.applyPreviewTransform;
    if (callbacks.getInterpolatedKeyframe) getInterpolatedKeyframe = callbacks.getInterpolatedKeyframe;

    if (callbacks.updateCanvasTransformBox) updateCanvasTransformBox = callbacks.updateCanvasTransformBox;
    if (callbacks.renderTimeline) renderTimeline = callbacks.renderTimeline;
    if (callbacks.updateTextOverlayPreview) updateTextOverlayPreview = callbacks.updateTextOverlayPreview;
    if (callbacks.updateOverlayPreview) updateOverlayPreview = callbacks.updateOverlayPreview;
    if (callbacks.updateSubtitlePreview) updateSubtitlePreview = callbacks.updateSubtitlePreview;
}

export function showPreviewImage(url, kenBurns, duration) {
    if (state.dom.previewVideo) {
        state.dom.previewVideo.style.display = 'none';
        state.dom.previewVideo.pause();
    }
    if (state.dom.previewImg) {
        state.dom.previewImg.style.display = 'block';
        if (state.dom.previewImg.src !== url) {
            state.dom.previewImg.src = url;
        }
        applyKenBurnsCSS(state.dom.previewImg, kenBurns, duration);
    }
}

export function showPreviewVideo() {
    if (state.dom.previewImg) {
        state.dom.previewImg.style.display = 'none';
        state.dom.previewImg.style.animation = '';
        state.dom.previewImg.style.transform = '';
    }
    if (state.dom.previewVideo) {
        state.dom.previewVideo.style.display = 'block';
    }
}

export function applyKenBurnsCSS(el, kenBurns, duration) {
    el.style.animation = '';
    el.style.transform = '';
    const dur = (duration || 5) + 's';
    if (kenBurns === 'zoom-in') {
        el.style.animation = `cupcat-kb-zoom-in ${dur} ease-in-out forwards`;
    } else if (kenBurns === 'zoom-out') {
        el.style.animation = `cupcat-kb-zoom-out ${dur} ease-in-out forwards`;
    } else if (kenBurns === 'pan-left') {
        el.style.animation = `cupcat-kb-pan-left ${dur} ease-in-out forwards`;
    } else if (kenBurns === 'pan-right') {
        el.style.animation = `cupcat-kb-pan-right ${dur} ease-in-out forwards`;
    }
}

export async function updatePreview() {
    if (state.videoClips.length > 0 && state.videoClips[0].objectUrl) {
        const clip = state.videoClips[0];
        if (clip.isImage) {
            showPreviewImage(clip.objectUrl, clip.kenBurns, getClipDuration(clip));
            applyPreviewFilter(clip);
            applyPreviewTransform(clip);
        } else {
            showPreviewVideo();
            state.dom.previewVideo.style.display = 'none'; // hide to prevent poster flash
            state.dom.previewVideo.src = clip.objectUrl;
            state.dom.previewVideo.volume = 1;
            setMediaVolume(state.dom.previewVideo, getEffectiveVolumeAtTime(clip, 0));
            state.dom.previewVideo.playbackRate = getClipSpeed(clip);
            applyPreviewFilter(clip);
            applyPreviewTransform(clip);
            state.dom.previewVideo.addEventListener('loadeddata', () => {
                if (clip.startTrim > 0) {
                    state.dom.previewVideo.currentTime = clip.startTrim;
                }
                state.dom.previewVideo.style.display = 'block';
                state._holdingFrame = false;
            }, { once: true });
        }
    } else {
        showPreviewVideo();
        state.dom.previewVideo.src = '';
        applyPreviewFilter(null);
        applyPreviewTransform(null);
    }
    if (state.useCanvasRenderer) await renderScene(state.playheadTime);
}

export async function updatePreviewAtTime(time, awaitSeek = false) {
    updateTextOverlayPreview();
    updateOverlayPreview();
    updateSubtitlePreview();
    // Find which clip the time falls into
    let accumulated = 0;
    let clipFound = false;
    for (let i = 0; i < state.videoClips.length; i++) {
        const clipDur = getClipDuration(state.videoClips[i]);
        if (time < accumulated + clipDur) {
            clipFound = true;
            const clip = state.videoClips[i];
            if (clip.isImage && clip.objectUrl) {
                showPreviewImage(clip.objectUrl, clip.kenBurns, clipDur);
                applyPreviewFilter(clip);
                applyPreviewTransform(clip);
            } else if (clip.objectUrl) {
                showPreviewVideo();
                const localTimelineTime = (time - accumulated) * getClipSpeed(clip);
                let clipTime;
                if (clip.isReversed) {
                    clipTime = (clip.duration - (clip.endTrim || 0)) - localTimelineTime;
                } else {
                    clipTime = (clip.startTrim || 0) + localTimelineTime;
                }
                clipTime = Math.max(0, Math.min(clip.duration || 10, clipTime));
                
                if (state.dom.previewVideo.getAttribute('src') !== clip.objectUrl) {
                    // Different source — hold frame, hide video while loading
                    if (state.dom.previewVideo.videoWidth > 0) {
                        if (!state._heldFrameCanvas) state._heldFrameCanvas = document.createElement('canvas');
                        const hc = state._heldFrameCanvas;
                        hc.width = state.dom.previewVideo.videoWidth;
                        hc.height = state.dom.previewVideo.videoHeight;
                        hc.getContext('2d').drawImage(state.dom.previewVideo, 0, 0);
                        state._holdingFrame = true;
                    }
                    state.dom.previewVideo.style.display = 'none';
                    state.dom.previewVideo.src = clip.objectUrl;
                    if (awaitSeek) {
                        await new Promise(r => {
                            state.dom.previewVideo.addEventListener('loadeddata', () => {
                                state.dom.previewVideo.currentTime = clipTime;
                                state.dom.previewVideo.style.display = 'block';
                                state._holdingFrame = false;
                                r();
                            }, { once: true });
                        });
                    } else {
                        state.dom.previewVideo.addEventListener('loadeddata', () => {
                            state.dom.previewVideo.currentTime = clipTime;
                            state.dom.previewVideo.style.display = 'block';
                            state._holdingFrame = false;
                        }, { once: true });
                    }
                } else {
                    state.dom.previewVideo.currentTime = clipTime;
                }
                
                setMediaVolume(state.dom.previewVideo, getEffectiveVolumeAtTime(clip, time - accumulated));
                state.dom.previewVideo.playbackRate = getClipSpeed(clip);
                applyPreviewFilter(clip);
                applyPreviewTransform(clip);
            }
            break;
        }
        accumulated += clipDur;
    }

    if (awaitSeek) {
        const waitSeek = (el) => {
            if (!el || el.tagName !== 'VIDEO') return Promise.resolve();
            if (el.readyState >= 2 && !el.seeking) return Promise.resolve();
            return new Promise(r => {
                let timer = null;
                const handler = () => {
                    clearTimeout(timer);
                    el.removeEventListener('seeked', handler);
                    el.removeEventListener('canplay', handler);
                    r();
                };
                el.addEventListener('seeked', handler);
                el.addEventListener('canplay', handler);
                // Safety timeout: resolve after 5s even if no event fires
                timer = setTimeout(handler, 5000);
            });
        };

        const promises = [];
        if (state.dom.previewVideo && state.dom.previewVideo.style.display !== 'none' && state.dom.previewVideo.src) {
            promises.push(waitSeek(state.dom.previewVideo));
        }

        state.overlayTracks.forEach(ovl => {
            if (ovl._previewEl && ovl._previewEl.tagName === 'VIDEO') {
                promises.push(waitSeek(ovl._previewEl));
            }
        });

        await Promise.all(promises);
    }

    if (state.useCanvasRenderer && !awaitSeek) await renderScene(time);
}
