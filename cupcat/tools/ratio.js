import { state } from '../state.js';
import { CANVAS_ASPECTS } from '../constants.js';
import { pushHistory } from '../history.js';

let _updateCanvasBox = () => {};
let _updateExportSettingsModalUI = () => {};
let _saveDocument = () => {};

export function setRatioCallbacks(cbs) {
    if (cbs.updateCanvasBox) _updateCanvasBox = cbs.updateCanvasBox;
    if (cbs.updateExportSettingsModalUI) _updateExportSettingsModalUI = cbs.updateExportSettingsModalUI;
    if (cbs.saveDocument) _saveDocument = cbs.saveDocument;
}

export function openRatioModal() {
    const modal = document.getElementById('cupcat-ratio-modal');
    modal.style.display = 'flex';
    updateRatioModalSelection();
}

export function closeRatioModal() {
    document.getElementById('cupcat-ratio-modal').style.display = 'none';
}

export function updateRatioModalSelection() {
    document.querySelectorAll('.cupcat-ratio-option').forEach(btn => {
        const isActive = btn.dataset.ratio === state.canvasAspect;
        btn.style.background = isActive ? 'rgba(224,64,251,0.10)' : 'rgba(255,255,255,0.03)';
        btn.style.borderColor = isActive ? 'rgba(224,64,251,0.6)' : 'rgba(255,255,255,0.08)';
        const check = btn.querySelector('.cupcat-ratio-check');
        if (check) check.style.visibility = isActive ? 'visible' : 'hidden';
    });
}

export function selectCanvasAspect(ratio) {
    if (!CANVAS_ASPECTS[ratio]) return;
    if (ratio === state.canvasAspect) {
        closeRatioModal();
        return;
    }

    pushHistory();
    state.canvasAspect = ratio;

    // Deselect any active overlay/text/clip to hide the blue selection box
    state.selectedClipId = null;
    state.selectedTextId = null;
    state.selectedOverlayId = null;
    state.selectedAudioId = null;
    state.isCropping = false;

    const activeBox = document.getElementById('cupcat-canvas-active-box');
    if (activeBox) activeBox.style.display = 'none';
    const cropBox = document.getElementById('cupcat-crop-box');
    if (cropBox) cropBox.style.display = 'none';

    _updateCanvasBox();
    updateRatioModalSelection();

    const label = document.getElementById('cupcat-ratio-btn-label');
    if (label) label.textContent = state.canvasAspect;

    _updateExportSettingsModalUI();
    _saveDocument();
    closeRatioModal();
    if (window.showToast) window.showToast(`Canvas set to ${ratio}`, false);
}
