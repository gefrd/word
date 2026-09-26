import { state } from '../state.js';
import { pushHistory } from '../history.js';
import { getCurrentClipAtTime } from '../utils.js';

let _renderTimeline = () => {};
let _updatePreview = () => {};
let _saveDocument = () => {};

export function setTransformCallbacks(cbs) {
    if (cbs.renderTimeline) _renderTimeline = cbs.renderTimeline;
    if (cbs.updatePreview) _updatePreview = cbs.updatePreview;
    if (cbs.saveDocument) _saveDocument = cbs.saveDocument;
}

export function getClipTransform(clip) {
    if (!clip) return { rotation: 0, flipH: false, flipV: false };
    return {
        rotation: typeof clip.rotation === 'number' ? ((clip.rotation % 360) + 360) % 360 : 0,
        flipH: !!clip.flipH,
        flipV: !!clip.flipV
    };
}

export function getClipCSSTransform(clip) {
    const tr = getClipTransform(clip);
    const parts = [];
    if (tr.rotation !== 0) {
        parts.push(`rotate(${tr.rotation}deg)`);
    }
    const sx = tr.flipH ? -1 : 1;
    const sy = tr.flipV ? -1 : 1;
    if (sx !== 1 || sy !== 1) {
        parts.push(`scale(${sx}, ${sy})`);
    }
    return parts.length > 0 ? parts.join(' ') : '';
}

export function applyPreviewTransform(clip) {
    const transformStr = getClipCSSTransform(clip);
    if (state.dom.previewVideo) state.dom.previewVideo.style.transform = transformStr;
    if (state.dom.previewImg) {
        state.dom.previewImg.style.transform = transformStr;
    }
}

export function buildTransformFilter(clip) {
    const tr = getClipTransform(clip);
    const filterNodes = [];

    // Rotation: 90, 180, 270 degrees
    if (tr.rotation === 90) {
        filterNodes.push('transpose=1');
    } else if (tr.rotation === 180) {
        filterNodes.push('hflip,vflip');
    } else if (tr.rotation === 270) {
        filterNodes.push('transpose=2');
    }

    // Flips
    if (tr.flipH) {
        filterNodes.push('hflip');
    }
    if (tr.flipV) {
        filterNodes.push('vflip');
    }

    return filterNodes.length > 0 ? filterNodes.join(',') + ',' : '';
}

export function openTransformModal() {
    const clip = state.videoClips.find(c => c.id === state.selectedClipId);
    if (!clip) {
        if (window.showToast) window.showToast('Please select a video or image clip first', true);
        return;
    }

    state.transformTarget = { type: 'video', id: clip.id };
    const tr = getClipTransform(clip);
    state.transformModalPending = { ...tr };

    updateTransformModalUI();

    const modal = document.getElementById('cupcat-transform-modal');
    if (modal) {
        modal.style.display = 'flex';
    }
    applyLiveTransformPreview();
}

export function closeTransformModal() {
    const modal = document.getElementById('cupcat-transform-modal');
    if (modal) {
        modal.style.display = 'none';
    }
    state.transformTarget = null;
    const currentClip = getCurrentClipAtTime(state.playheadTime);
    applyPreviewTransform(currentClip);
}

export function updateTransformModalUI() {
    const rotVal = document.getElementById('cupcat-transform-val-rotation');
    if (rotVal) rotVal.textContent = `${state.transformModalPending.rotation}°`;

    // Angle buttons highlight
    document.querySelectorAll('.cupcat-rot-angle-btn').forEach(btn => {
        const angle = parseInt(btn.dataset.angle, 10);
        const isActive = angle === state.transformModalPending.rotation;
        btn.style.background = isActive ? 'rgba(0,229,255,0.2)' : 'rgba(255,255,255,0.04)';
        btn.style.borderColor = isActive ? '#00e5ff' : 'rgba(255,255,255,0.1)';
        btn.style.color = isActive ? '#00e5ff' : '#bbb';
    });

    // Flip buttons highlight
    const btnH = document.getElementById('cupcat-flip-h');
    if (btnH) {
        if (state.transformModalPending.flipH) {
            btnH.style.background = 'rgba(0,229,255,0.2)';
            btnH.style.borderColor = '#00e5ff';
            btnH.style.color = '#00e5ff';
        } else {
            btnH.style.background = 'rgba(255,255,255,0.04)';
            btnH.style.borderColor = 'rgba(255,255,255,0.1)';
            btnH.style.color = '#ccc';
        }
    }

    const btnV = document.getElementById('cupcat-flip-v');
    if (btnV) {
        if (state.transformModalPending.flipV) {
            btnV.style.background = 'rgba(0,229,255,0.2)';
            btnV.style.borderColor = '#00e5ff';
            btnV.style.color = '#00e5ff';
        } else {
            btnV.style.background = 'rgba(255,255,255,0.04)';
            btnV.style.borderColor = 'rgba(255,255,255,0.1)';
            btnV.style.color = '#ccc';
        }
    }
}

export function applyLiveTransformPreview() {
    const dummyClip = { ...state.transformModalPending };
    applyPreviewTransform(dummyClip);
}

export function rotateClipStep(stepDeg) {
    let newRot = (state.transformModalPending.rotation + stepDeg) % 360;
    if (newRot < 0) newRot += 360;
    state.transformModalPending.rotation = newRot;
    updateTransformModalUI();
    applyLiveTransformPreview();
}

export function setClipRotationAngle(deg) {
    let newRot = (deg % 360 + 360) % 360;
    state.transformModalPending.rotation = newRot;
    updateTransformModalUI();
    applyLiveTransformPreview();
}

export function toggleClipFlipH() {
    state.transformModalPending.flipH = !state.transformModalPending.flipH;
    updateTransformModalUI();
    applyLiveTransformPreview();
}

export function toggleClipFlipV() {
    state.transformModalPending.flipV = !state.transformModalPending.flipV;
    updateTransformModalUI();
    applyLiveTransformPreview();
}

export function resetTransformControls() {
    state.transformModalPending = { rotation: 0, flipH: false, flipV: false };
    updateTransformModalUI();
    applyLiveTransformPreview();
}

export function applyTransform() {
    if (!state.transformTarget) {
        closeTransformModal();
        return;
    }
    const clip = state.videoClips.find(c => c.id === state.transformTarget.id);
    if (clip) {
        pushHistory();
        clip.rotation = state.transformModalPending.rotation;
        clip.flipH = state.transformModalPending.flipH;
        clip.flipV = state.transformModalPending.flipV;
        applyPreviewTransform(clip);
        _renderTimeline();
        _saveDocument();
        if (window.showToast) window.showToast('Transform applied', false);
    }
    const modal = document.getElementById('cupcat-transform-modal');
    if (modal) modal.style.display = 'none';
    state.transformTarget = null;
}
