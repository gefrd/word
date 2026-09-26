import { state } from '../state.js';
import { FILTER_PRESETS } from '../constants.js';
import { pushHistory } from '../history.js';
import { getCurrentClipAtTime } from '../utils.js';

let _renderTimeline = () => {};
let _updatePreview = () => {};
let _saveDocument = () => {};

export function setFiltersCallbacks(cbs) {
    if (cbs.renderTimeline) _renderTimeline = cbs.renderTimeline;
    if (cbs.updatePreview) _updatePreview = cbs.updatePreview;
    if (cbs.saveDocument) _saveDocument = cbs.saveDocument;
}

export function getClipFilters(clip) {
    if (!clip || !clip.filters) {
        return { preset: 'none', brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0 };
    }
    return {
        preset: clip.filters.preset || 'none',
        brightness: typeof clip.filters.brightness === 'number' ? clip.filters.brightness : 0,
        contrast: typeof clip.filters.contrast === 'number' ? clip.filters.contrast : 1,
        saturation: typeof clip.filters.saturation === 'number' ? clip.filters.saturation : 1,
        hue: typeof clip.filters.hue === 'number' ? clip.filters.hue : 0,
        sepia: typeof clip.filters.sepia === 'number' ? clip.filters.sepia : 0
    };
}

export function getClipCSSFilter(clip) {
    const f = getClipFilters(clip);
    const parts = [];

    // Brightness: 0 is normal (100%), range -1..1 -> (1 + f.brightness) * 100%
    const b = Math.max(0, (1 + f.brightness) * 100);
    if (Math.abs(b - 100) > 0.5) parts.push(`brightness(${b.toFixed(1)}%)`);

    // Contrast: 1 is normal (100%), range 0..2 -> f.contrast * 100%
    const c = Math.max(0, f.contrast * 100);
    if (Math.abs(c - 100) > 0.5) parts.push(`contrast(${c.toFixed(1)}%)`);

    // Saturation: 1 is normal (100%), range 0..3 -> f.saturation * 100%
    const s = Math.max(0, f.saturation * 100);
    if (Math.abs(s - 100) > 0.5) parts.push(`saturate(${s.toFixed(1)}%)`);

    // Hue-rotate: 0 is normal (0deg), range -180..180
    if (Math.abs(f.hue) > 0.5) parts.push(`hue-rotate(${f.hue.toFixed(1)}deg)`);

    // Sepia: 0 is normal (0%), range 0..100
    if (f.sepia > 0.5) parts.push(`sepia(${f.sepia.toFixed(1)}%)`);

    return parts.length > 0 ? parts.join(' ') : 'none';
}

export function applyPreviewFilter(clip) {
    const filterStr = getClipCSSFilter(clip);
    if (state.dom.previewVideo) state.dom.previewVideo.style.filter = filterStr;
    if (state.dom.previewImg) state.dom.previewImg.style.filter = filterStr;
}

export function buildColorFilter(clip) {
    const f = getClipFilters(clip);
    const filterNodes = [];

    // Brightness via colorlevels (replaces eq=brightness which is unavailable in ffmpeg-kit)
    // eq brightness range: -1..1 → map to colorlevels min/max adjustments
    if (Math.abs(f.brightness) > 0.005) {
        const b = f.brightness;
        if (b > 0) {
            // Brighten: raise input min levels
            const minVal = Math.min(b, 0.99).toFixed(3);
            filterNodes.push(`colorlevels=rimin=${minVal}:gimin=${minVal}:bimin=${minVal}`);
        } else {
            // Darken: lower input max levels
            const maxVal = Math.max(1 + b, 0.01).toFixed(3);
            filterNodes.push(`colorlevels=rimax=${maxVal}:gimax=${maxVal}:bimax=${maxVal}`);
        }
    }

    // Contrast via colorlevels (avoids quote-escaping issues with curves filter)
    // Contrast > 1: narrow the input range → stretch output → more contrast
    // Contrast < 1: expand the input range → compress output → less contrast
    if (Math.abs(f.contrast - 1) > 0.005) {
        const c = f.contrast;
        // Map contrast factor to input level adjustments
        // At c=1.5: rimin=0.125, rimax=0.875 → stronger contrast
        // At c=0.5: rimin=-0.25 (clamped to 0), rimax=1.25 (clamped to 1) → less contrast
        const imin = Math.max(0, (1 - 1 / c) * 0.5).toFixed(3);
        const imax = Math.min(1, 1 - (1 - 1 / c) * 0.5).toFixed(3);
        filterNodes.push(`colorlevels=rimin=${imin}:gimin=${imin}:bimin=${imin}:rimax=${imax}:gimax=${imax}:bimax=${imax}`);
    }

    // Saturation via hue filter's saturation parameter (universally available)
    if (Math.abs(f.saturation - 1) > 0.005) {
        filterNodes.push(`hue=s=${f.saturation.toFixed(3)}`);
    }

    // Hue rotation via hue filter (h=degrees)
    if (Math.abs(f.hue) > 0.5) {
        // If saturation was also set, merge into one hue call
        if (Math.abs(f.saturation - 1) > 0.005) {
            // Remove the last hue=s= and combine
            filterNodes.pop();
            filterNodes.push(`hue=h=${f.hue.toFixed(1)}:s=${f.saturation.toFixed(3)}`);
        } else {
            filterNodes.push(`hue=h=${f.hue.toFixed(1)}`);
        }
    }

    // sepia / warm colorbalance approximation
    if (f.sepia > 5) {
        // Sepia tint using colorbalance: boost red & green in shadows/midtones, reduce blue
        const factor = (f.sepia / 100);
        const rs = (0.2 * factor).toFixed(2);
        const rm = (0.3 * factor).toFixed(2);
        const gs = (0.05 * factor).toFixed(2);
        const bm = (-0.2 * factor).toFixed(2);
        filterNodes.push(`colorbalance=rs=${rs}:rm=${rm}:gs=${gs}:bm=${bm}`);
    }

    return filterNodes.length > 0 ? filterNodes.join(',') + ',' : '';
}

export function openFiltersModal() {
    let clip = null;
    if (state.selectedClipId) {
        clip = state.videoClips.find(c => c.id === state.selectedClipId);
    }
    if (!clip && state.videoClips.length > 0) {
        clip = getCurrentClipAtTime(state.playheadTime) || state.videoClips[0];
        if (clip) state.selectedClipId = clip.id;
    }
    if (!clip) {
        if (window.showToast) window.showToast('Add a video or image clip first', true);
        return;
    }

    state.filterTarget = { id: clip.id };
    const currentFilters = getClipFilters(clip);
    state.filterModalPending = { ...currentFilters };

    renderFilterPresetsGrid();
    updateFilterModalUI();

    const modal = document.getElementById('cupcat-filters-modal');
    if (modal) modal.style.display = 'flex';
}

export function closeFiltersModal() {
    const modal = document.getElementById('cupcat-filters-modal');
    if (modal) modal.style.display = 'none';

    // Revert live preview to applied state of target clip if canceled
    if (state.filterTarget) {
        const clip = state.videoClips.find(c => c.id === state.filterTarget.id);
        if (clip) applyPreviewFilter(clip);
    }
    state.filterTarget = null;
}

export function renderFilterPresetsGrid() {
    const container = document.getElementById('cupcat-filters-presets');
    if (!container) return;

    container.innerHTML = Object.entries(FILTER_PRESETS).map(([key, p]) => {
        const isActive = state.filterModalPending.preset === key;
        return `
            <button class="cupcat-filter-preset-btn" data-preset="${key}" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center;
                gap: 4px; padding: 8px 4px; border-radius: 8px;
                background: ${isActive ? 'rgba(255,64,129,0.22)' : 'rgba(255,255,255,0.04)'};
                color: ${isActive ? '#ff4081' : '#bbb'};
                border: 1px solid ${isActive ? 'rgba(255,64,129,0.7)' : 'rgba(255,255,255,0.08)'};
                font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.15s ease;
            ">
                <i class="${p.icon}" style="font-size: 14px;"></i>
                <span>${p.name}</span>
            </button>
        `;
    }).join('');

    container.querySelectorAll('.cupcat-filter-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            selectFilterPreset(btn.dataset.preset);
        });
    });
}

export function selectFilterPreset(presetKey) {
    const p = FILTER_PRESETS[presetKey];
    if (!p) return;

    state.filterModalPending.preset = presetKey;
    state.filterModalPending.brightness = p.brightness;
    state.filterModalPending.contrast = p.contrast;
    state.filterModalPending.saturation = p.saturation;
    state.filterModalPending.hue = p.hue;
    state.filterModalPending.sepia = p.sepia;

    updateFilterModalUI();
    applyLiveFilterPreview();
}

export function updateFilterPresetHighlightOnly() {
    document.querySelectorAll('.cupcat-filter-preset-btn').forEach(btn => {
        const isActive = btn.dataset.preset === state.filterModalPending.preset;
        btn.style.background = isActive ? 'rgba(255,64,129,0.22)' : 'rgba(255,255,255,0.04)';
        btn.style.color = isActive ? '#ff4081' : '#bbb';
        btn.style.borderColor = isActive ? 'rgba(255,64,129,0.7)' : 'rgba(255,255,255,0.08)';
    });
}

export function updateFilterModalUI() {
    updateFilterPresetHighlightOnly();

    const bSlider = document.getElementById('cupcat-filter-brightness');
    const cSlider = document.getElementById('cupcat-filter-contrast');
    const sSlider = document.getElementById('cupcat-filter-saturation');
    const hSlider = document.getElementById('cupcat-filter-hue');

    const bVal = document.getElementById('cupcat-filter-val-brightness');
    const cVal = document.getElementById('cupcat-filter-val-contrast');
    const sVal = document.getElementById('cupcat-filter-val-saturation');
    const hVal = document.getElementById('cupcat-filter-val-hue');

    if (bSlider) bSlider.value = Math.round(state.filterModalPending.brightness * 100);
    if (cSlider) cSlider.value = Math.round(state.filterModalPending.contrast * 100);
    if (sSlider) sSlider.value = Math.round(state.filterModalPending.saturation * 100);
    if (hSlider) hSlider.value = Math.round(state.filterModalPending.hue || 0);

    if (bVal) bVal.textContent = `${Math.round(state.filterModalPending.brightness * 100)}%`;
    if (cVal) cVal.textContent = `${Math.round(state.filterModalPending.contrast * 100)}%`;
    if (sVal) sVal.textContent = `${Math.round(state.filterModalPending.saturation * 100)}%`;
    if (hVal) hVal.textContent = `${Math.round(state.filterModalPending.hue || 0)}°`;
}

export function resetFilterSliders() {
    selectFilterPreset('none');
}

export function applyLiveFilterPreview() {
    const dummyClip = { filters: state.filterModalPending };
    const filterStr = getClipCSSFilter(dummyClip);
    if (state.dom.previewVideo) state.dom.previewVideo.style.filter = filterStr;
    if (state.dom.previewImg) state.dom.previewImg.style.filter = filterStr;
}

export function applyFilters() {
    if (!state.filterTarget) return;
    const clip = state.videoClips.find(c => c.id === state.filterTarget.id);
    if (clip) {
        pushHistory();
        clip.filters = { ...state.filterModalPending };
        applyPreviewFilter(clip);
        _renderTimeline();
        _saveDocument();
        if (window.showToast) window.showToast('Filters applied', false);
    }
    const modal = document.getElementById('cupcat-filters-modal');
    if (modal) modal.style.display = 'none';
    state.filterTarget = null;
}
