import { state } from './state.js';
import { EXPORT_RESOLUTIONS, EXPORT_SPEED_PRESETS, EXPORT_QUALITY_CRF, CANVAS_ASPECTS, TRANSITION_XFADE_MAP } from './constants.js';
import { getClipDuration, getTotalDuration, getClipStartTime, getClipSpeed, buildAtempoChain, getEffectiveVolume, getAudioDuration, formatTime, perceptualVolume } from './utils.js';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
let FFmpegWorker = '';
async function getFFmpegWorker() {
    if (FFmpegWorker) return FFmpegWorker;
    try {
        const workerMod = await import(/* @vite-ignore */ '@ffmpeg/ffmpeg/worker?url');
        FFmpegWorker = workerMod?.default || '';
    } catch (e) {
        FFmpegWorker = '';
    }
    return FFmpegWorker;
}
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { renderScene, drawSingleSubtitle, drawTextOverlayItem } from './render-scene.js';
import { updatePreviewAtTime } from './preview.js';
import { createEmojiDataUrl } from './tools/stickers.js';

// Capacitor Filesystem for native file saving (lazy-loaded on first use)
let Filesystem, Directory, Encoding;
let _fsLoaded = false;
async function loadFilesystem() {
    if (_fsLoaded) return;
    _fsLoaded = true;

    // Method 1: Pre-registered by main.js via static import (APK build)
    if (window.__CapFS) {
        Filesystem = window.__CapFS.Filesystem;
        Directory = window.__CapFS.Directory;
        Encoding = window.__CapFS.Encoding;
        console.log('[CupCat] Filesystem loaded via __CapFS (main.js static import)');
        return;
    }

    // Method 2: Capacitor plugin bridge (fallback)
    if (window.Capacitor?.Plugins?.Filesystem) {
        Filesystem = window.Capacitor.Plugins.Filesystem;
        Directory = { CACHE: 'CACHE', DOCUMENTS: 'DOCUMENTS', DATA: 'DATA', EXTERNAL: 'EXTERNAL', EXTERNAL_STORAGE: 'EXTERNAL_STORAGE', LIBRARY: 'LIBRARY' };
        Encoding = { UTF8: 'utf8', ASCII: 'ascii', UTF16: 'utf16' };
        console.log('[CupCat] Filesystem loaded via Capacitor bridge');
        return;
    }

    // Method 3: ES module import (works in dev/non-externalized builds)
    try {
        const fsMod = await import(/* @vite-ignore */ '@capacitor/filesystem');
        Filesystem = fsMod.Filesystem;
        Directory = fsMod.Directory;
        Encoding = fsMod.Encoding;
        console.log('[CupCat] Filesystem loaded via ES import');
    } catch (e) {
        console.log('[CupCat] @capacitor/filesystem not available (web mode)');
    }
}

// Late-binding dependencies
let buildColorFilter = () => '';
let buildTransformFilter = () => '';
let getClipFilters = () => [];
let getClipTransform = () => ({});
let getInterpolatedKeyframe = () => ({});
let saveDocument = () => {};

export function setExportDependencies(deps) {
    if (deps.buildColorFilter) buildColorFilter = deps.buildColorFilter;
    if (deps.buildTransformFilter) buildTransformFilter = deps.buildTransformFilter;
    if (deps.getClipFilters) getClipFilters = deps.getClipFilters;
    if (deps.getClipTransform) getClipTransform = deps.getClipTransform;
    if (deps.getInterpolatedKeyframe) getInterpolatedKeyframe = deps.getInterpolatedKeyframe;
    if (deps.saveDocument) saveDocument = deps.saveDocument;
}

export function loadExportSettings() {
    try {
        const saved = localStorage.getItem('cupcat_export_settings');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed.resolution && ['1080p', '720p', '480p'].includes(parsed.resolution)) {
                state.exportSettings.resolution = parsed.resolution;
            }
            if (parsed.preset && ['ultrafast', 'fast', 'medium'].includes(parsed.preset)) {
                state.exportSettings.preset = parsed.preset;
            }
            if (parsed.quality && ['high', 'medium', 'draft'].includes(parsed.quality)) {
                state.exportSettings.quality = parsed.quality;
            }
            if (parsed.format && ['mp4', 'webm'].includes(parsed.format)) {
                state.exportSettings.format = parsed.format;
            }
        }
    } catch (e) {
        console.warn('Could not load export settings from localStorage', e);
    }
}

export function saveExportSettings() {
    try {
        localStorage.setItem('cupcat_export_settings', JSON.stringify(state.exportSettings));
    } catch (e) {
        console.warn('Could not save export settings to localStorage', e);
    }
}

export function getExportDimensions(aspect, res) {
    let aspMap = EXPORT_RESOLUTIONS[aspect];
    // Dynamic computation for custom aspect ratios (e.g. '9:20' from auto-detection)
    if (!aspMap && aspect && aspect.includes(':')) {
        const [rw, rh] = aspect.split(':').map(Number);
        if (rw > 0 && rh > 0) {
            const ratio = rw / rh;
            const makeDims = (shortSide) => {
                let w, h;
                if (ratio < 1) { w = shortSide; h = Math.round(shortSide / ratio); }
                else { h = shortSide; w = Math.round(shortSide * ratio); }
                if (w % 2 !== 0) w += 1;
                if (h % 2 !== 0) h += 1;
                return { w, h };
            };
            aspMap = {
                '1080p': makeDims(1080),
                '720p': makeDims(720),
                '480p': makeDims(480)
            };
        }
    }
    if (!aspMap) aspMap = EXPORT_RESOLUTIONS['16:9'];
    const r = aspMap[res] || aspMap['720p'];
    let w = r.w;
    let h = r.h;
    if (w % 2 !== 0) w += 1;
    if (h % 2 !== 0) h += 1;
    return { w, h };
}

export async function loadFFmpeg() {
    if (state.ffmpegLoaded) return;
    if (loadFFmpeg._loading) return; // prevent duplicate calls
    loadFFmpeg._loading = true;

    // On native Capacitor platforms, skip WASM FFmpeg entirely — native FFmpegPlugin handles export
    const isNativePlatform = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
    if (isNativePlatform) {
        console.log('[CupCat] Native platform detected — skipping FFmpeg WASM (native plugin will be used for export)');
        loadFFmpeg._loading = false;
        return;
    }

    try {
        // Pre-check: SharedArrayBuffer is required for FFmpeg WASM
        if (typeof SharedArrayBuffer === 'undefined') {
            console.warn('[CupCat] SharedArrayBuffer is NOT available. FFmpeg WASM cannot load.');
            console.warn('[CupCat] crossOriginIsolated:', window.crossOriginIsolated);
            console.warn('[CupCat] This is normal on iOS. Export will use WebCodecs if available.');
            
            // Don't show alarming toast at startup — only log to console
            // The export router will handle fallback automatically
            loadFFmpeg._loading = false;
            return;
        }

        if (window.showToast) window.showToast('Loading video engine...', false);

        state.ffmpeg = new FFmpeg();
        state.ffmpeg.on('log', ({ message }) => {
            console.log('[FFmpeg]', message);
        });
        state.ffmpeg.on('progress', ({ progress }) => {
            const p = Math.round(progress * 100);
            updateExportProgress(p);
        });

        console.log('[CupCat] Loading FFmpeg core WASM...');
        console.log('[CupCat] crossOriginIsolated:', window.crossOriginIsolated);
        console.log('[CupCat] SharedArrayBuffer:', typeof SharedArrayBuffer);

        const base = document.baseURI || window.location.href;
        const coreURL = new URL('ffmpeg/ffmpeg-core.js', base).href;
        const wasmURL = 'https://assets.kivu.site/ffmpeg-core.wasm';
        
        console.log(`[CupCat] Fetching FFmpeg core from: ${coreURL}`);

        // Use a timeout wrapper for toBlobURL calls — they can hang in
        // environments where fetch silently fails (e.g. Capacitor WebView
        // without proper COOP/COEP headers).
        const withTimeout = (promise, ms, label) => {
            return Promise.race([
                promise,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Timeout loading ${label} after ${ms / 1000}s`)), ms)
                )
            ]);
        };

        const LOAD_TIMEOUT = 60000; // 60 seconds for WASM (32MB)

        let workerBlobURL, coreBlobURL, wasmBlobURL;
        try {
            const workerSource = await getFFmpegWorker();
            workerBlobURL = await withTimeout(
                toBlobURL(workerSource, 'application/javascript'),
                15000, 'FFmpeg worker'
            );
            coreBlobURL = await withTimeout(
                toBlobURL(coreURL, 'text/javascript'),
                15000, 'FFmpeg core JS'
            );
            wasmBlobURL = await withTimeout(
                toBlobURL(wasmURL, 'application/wasm'),
                LOAD_TIMEOUT, 'FFmpeg WASM'
            );
        } catch (blobErr) {
            console.warn('[CupCat] toBlobURL failed, trying direct URL load:', blobErr.message);
            // Fallback: load FFmpeg with direct URLs instead of blob URLs
            // This works when the files are served from the same origin (Capacitor local server)
            workerBlobURL = undefined;
            coreBlobURL = coreURL;
            wasmBlobURL = wasmURL;
        }

        const loadConfig = {
            coreURL: coreBlobURL,
            wasmURL: wasmBlobURL,
        };
        if (workerBlobURL) {
            loadConfig.classWorkerURL = workerBlobURL;
        }

        await withTimeout(
            state.ffmpeg.load(loadConfig),
            LOAD_TIMEOUT, 'FFmpeg initialization'
        );

        state.ffmpegLoaded = true;
        loadFFmpeg._loading = false;
        console.log('[CupCat] FFmpeg fully loaded and ready!');
        if (window.showToast) window.showToast('Video engine ready ✓', false);

    } catch (e) {
        loadFFmpeg._loading = false;
        console.error('[CupCat] FFmpeg load error:', e);

        // Check if it's a SharedArrayBuffer issue
        if (!window.crossOriginIsolated) {
            console.warn('[CupCat] Page is NOT cross-origin isolated. SharedArrayBuffer may not be available.');
            console.warn('[CupCat] Server needs headers: Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy: require-corp');
        }

        if (window.showToast) {
            window.showToast('Video engine failed: ' + e.message, true);
        }

        // Retry once after a short delay
        if (!loadFFmpeg._retried) {
            loadFFmpeg._retried = true;
            console.log('[CupCat] Retrying FFmpeg load in 5 seconds...');
            setTimeout(() => loadFFmpeg(), 5000);
        } else {
            console.error('[CupCat] FFmpeg failed after retry. Export will use WebCodecs-only path if available.');
            if (window.showToast) {
                window.showToast('Video engine unavailable. Export may be limited.', true);
            }
        }
    }
}

export function openExportSettingsModal() {
    // Note: we no longer block on FFmpeg loading here. If FFmpeg isn't loaded,
    // the export will use WebCodecs video-only fallback (without audio).
    if (!state.ffmpegLoaded && !window.VideoEncoder) {
        if (window.showToast) window.showToast('Video engine is still loading. Export may be limited.', false);
    }
    if (state.videoClips.length === 0) {
        if (window.showToast) window.showToast('Add at least one media clip first.', true);
        return;
    }

    updateExportSettingsModalUI();

    // Smart Preset: check source resolution vs export resolution
    try {
        const maxSourceH = Math.max(...state.videoClips.map(c => c.height || 0).filter(h => h > 0));
        if (maxSourceH > 0) {
            const resHint = document.getElementById('cupcat-export-res-hint');
            const exportRes = state.exportSettings.resolution;
            const exportH = exportRes === '1080p' ? 1080 : exportRes === '720p' ? 720 : exportRes === '4K' ? 2160 : 720;
            if (exportH > maxSourceH * 1.2) {
                if (resHint) {
                    const suggested = maxSourceH >= 1000 ? '1080p' : maxSourceH >= 600 ? '720p' : '480p';
                    resHint.textContent += ` ⚠️ Source is ${maxSourceH}p — ${suggested} recommended`;
                    resHint.style.color = '#ffab00';
                }
            }
        }
    } catch (_) {}

    const modal = document.getElementById('cupcat-export-settings-modal');
    if (modal) modal.style.display = 'flex';
}

export function closeExportSettingsModal() {
    const modal = document.getElementById('cupcat-export-settings-modal');
    if (modal) modal.style.display = 'none';
}

export function updateExportSettingsModalUI() {
    // 1. Resolution highlight & hints
    const dims = getExportDimensions(state.canvasAspect, state.exportSettings.resolution);
    const resHint = document.getElementById('cupcat-export-res-hint');
    if (resHint) {
        const aspMap = EXPORT_RESOLUTIONS[state.canvasAspect] || EXPORT_RESOLUTIONS['16:9'];
        const resInfo = aspMap[state.exportSettings.resolution] || aspMap['720p'];
        resHint.textContent = `${resInfo.label} (${dims.w}×${dims.h})`;
    }

    document.querySelectorAll('.cupcat-export-res-btn').forEach(btn => {
        const res = btn.dataset.res;
        const isActive = res === state.exportSettings.resolution;
        btn.style.background = isActive ? 'rgba(224,64,251,0.18)' : 'rgba(255,255,255,0.04)';
        btn.style.border = isActive ? '1.5px solid #e040fb' : '1px solid rgba(255,255,255,0.1)';
        btn.style.color = isActive ? '#e040fb' : '#ccc';
        const sub = btn.querySelector('div:last-child');
        if (sub) sub.style.color = isActive ? '#e040fb' : '#888';
    });

    // 2. Preset highlight & hints
    const presetHint = document.getElementById('cupcat-export-preset-hint');
    if (presetHint) {
        const pInfo = EXPORT_SPEED_PRESETS[state.exportSettings.preset] || EXPORT_SPEED_PRESETS['ultrafast'];
        presetHint.textContent = pInfo.label;
    }

    document.querySelectorAll('.cupcat-export-preset-btn').forEach(btn => {
        const preset = btn.dataset.preset;
        const isActive = preset === state.exportSettings.preset;
        btn.style.background = isActive ? 'rgba(0,229,255,0.18)' : 'rgba(255,255,255,0.04)';
        btn.style.border = isActive ? '1.5px solid #00e5ff' : '1px solid rgba(255,255,255,0.1)';
        btn.style.color = isActive ? '#00e5ff' : '#ccc';
        const sub = btn.querySelector('div:last-child');
        if (sub) sub.style.color = isActive ? '#00e5ff' : '#888';
    });

    // 3. Quality highlight & hints
    const qualHint = document.getElementById('cupcat-export-quality-hint');
    if (qualHint) {
        const qInfo = EXPORT_QUALITY_CRF[state.exportSettings.quality] || EXPORT_QUALITY_CRF['medium'];
        qualHint.textContent = qInfo.label;
    }

    document.querySelectorAll('.cupcat-export-quality-btn').forEach(btn => {
        const qual = btn.dataset.quality;
        const isActive = qual === state.exportSettings.quality;
        btn.style.background = isActive ? 'rgba(0,230,118,0.18)' : 'rgba(255,255,255,0.04)';
        btn.style.border = isActive ? '1.5px solid #00e676' : '1px solid rgba(255,255,255,0.1)';
        btn.style.color = isActive ? '#00e676' : '#ccc';
        const sub = btn.querySelector('div:last-child');
        if (sub) sub.style.color = isActive ? '#00e676' : '#888';
    });

    // 4. Summary badge & dim label
    const dimLabel = document.getElementById('cupcat-export-dim-label');
    if (dimLabel) {
        dimLabel.textContent = `${dims.w}×${dims.h} (${state.canvasAspect})`;
    }

    const badge = document.getElementById('cupcat-export-speed-badge');
    if (badge) {
        if (state.exportSettings.preset === 'ultrafast') {
            badge.innerHTML = '⚡ Fastest Render';
            badge.style.color = '#00e5ff';
        } else if (state.exportSettings.preset === 'fast') {
            badge.innerHTML = '⚖️ Balanced Speed';
            badge.style.color = '#00e676';
        } else {
            badge.innerHTML = '📦 Best Compression';
            badge.style.color = '#ffab00';
        }
    }
}

export function setExportResolution(res) {
    if (['1080p', '720p', '480p'].includes(res)) {
        state.exportSettings.resolution = res;
        saveExportSettings();
        updateExportSettingsModalUI();
    }
}

export function setExportSpeedPreset(preset) {
    if (['ultrafast', 'fast', 'medium'].includes(preset)) {
        state.exportSettings.preset = preset;
        saveExportSettings();
        updateExportSettingsModalUI();
    }
}

export function setExportQuality(quality) {
    if (['high', 'medium', 'draft'].includes(quality)) {
        state.exportSettings.quality = quality;
        saveExportSettings();
        updateExportSettingsModalUI();
    }
}

export function buildFFmpegKeyframeCoordExpr(keyframes, prop, defaultVal, isText, outDim, elementDim) {
    if (!keyframes || keyframes.length === 0) {
        if (isText && prop === 'y') {
            if (defaultVal === 'top') return 'h*0.08';
            if (defaultVal === 'bottom') return 'h-text_h-h*0.08';
            return '(h-text_h)/2';
        }
        if (isText && prop === 'x') {
            return '(w-text_w)/2';
        }
        const pct = (typeof defaultVal === 'number' ? defaultVal : 50) / 100;
        return `(${outDim}*${pct}-${elementDim}/2)`;
    }

    if (keyframes.length === 1) {
        const val = keyframes[0][prop] !== undefined ? keyframes[0][prop] : (typeof defaultVal === 'number' ? defaultVal : 50);
        return `(${outDim}*${val / 100}-${elementDim}/2)`;
    }

    const sorted = [...keyframes].sort((a, b) => a.time - b.time);
    
    let expr = '';
    const lastKf = sorted[sorted.length - 1];
    const lastVal = lastKf[prop] !== undefined ? lastKf[prop] : (typeof defaultVal === 'number' ? defaultVal : 50);
    expr = `(${outDim}*${lastVal / 100}-${elementDim}/2)`;

    for (let i = sorted.length - 2; i >= 0; i--) {
        const k0 = sorted[i];
        const k1 = sorted[i + 1];
        const v0 = k0[prop] !== undefined ? k0[prop] : (typeof defaultVal === 'number' ? defaultVal : 50);
        const v1 = k1[prop] !== undefined ? k1[prop] : (typeof defaultVal === 'number' ? defaultVal : 50);
        const t0 = k0.time.toFixed(3);
        const t1 = k1.time.toFixed(3);
        const span = Math.max(0.001, k1.time - k0.time).toFixed(3);

        const lerp = `(${outDim}*(${v0}+(${v1 - v0})*(t-${t0})/${span})/100-${elementDim}/2)`;
        expr = `if(lt(t\\,${t1})\\,${lerp}\\,${expr})`;
    }

    const firstKf = sorted[0];
    const firstVal = firstKf[prop] !== undefined ? firstKf[prop] : (typeof defaultVal === 'number' ? defaultVal : 50);
    const firstT = firstKf.time.toFixed(3);
    const beforeFirst = `(${outDim}*${firstVal / 100}-${elementDim}/2)`;
    expr = `if(lt(t\\,${firstT})\\,${beforeFirst}\\,${expr})`;

    return expr;
}

export function updateExportProgress(percent) {
    const text = document.getElementById('cupcat-progress-text');
    const bar = document.getElementById('cupcat-progress-bar');
    if (text) text.innerText = percent + '%';
    if (bar) bar.style.width = percent + '%';
}

// ============================================================
// Cancel Export — abort any running render
// ============================================================
export async function cancelExport() {
    if (!state.isExporting) return;
    console.log('[CupCat] Cancel export requested');

    // 1. Native FFmpeg (ffmpeg-kit)
    const FFmpegNative = window.Capacitor?.Plugins?.FFmpegPlugin || window.__CapFFmpeg;
    if (FFmpegNative && FFmpegNative.cancelExport) {
        try {
            await FFmpegNative.cancelExport();
            console.log('[CupCat] Native FFmpeg cancelled');
        } catch (e) {
            console.warn('[CupCat] cancelExport native call failed:', e);
        }
    }

    // 2. WASM FFmpeg
    if (state.ffmpeg && state.ffmpegLoaded) {
        try {
            // ffmpeg.wasm doesn't have cancel — terminate and reload
            state.ffmpeg.terminate();
            state.ffmpegLoaded = false;
            console.log('[CupCat] WASM FFmpeg terminated');
        } catch (e) {
            console.warn('[CupCat] WASM FFmpeg terminate failed:', e);
        }
    }

    // 3. Set flag so export loops can break
    state._exportCancelled = true;
    state.isExporting = false;

    // 4. Hide overlay
    const overlay = document.getElementById('cupcat-export-overlay');
    if (overlay) overlay.style.display = 'none';

    if (window.showToast) window.showToast('Export cancelled', false);
}

// Bind cancel button (called once after UI renders)
export function bindCancelExportButton() {
    const btn = document.getElementById('cupcat-cancel-export-btn');
    if (btn) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            cancelExport();
        });
    }
}

// ============================================================
// Screenshot — save current canvas frame as PNG
// ============================================================
export async function exportScreenshot() {
    const canvas = document.getElementById('cupcat-main-canvas');
    if (!canvas) {
        if (window.showToast) window.showToast('No canvas to capture', true);
        return;
    }

    try {
        const dataUrl = canvas.toDataURL('image/png');
        const FFmpegNative = window.Capacitor?.Plugins?.FFmpegPlugin || window.__CapFFmpeg;

        if (FFmpegNative && FFmpegNative.saveImage) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const fileName = `${state.docTitle || 'CupCat'}_frame_${ts}.png`;
            const result = await FFmpegNative.saveImage({ base64Data: dataUrl, fileName });
            if (result && result.success) {
                if (window.showToast) window.showToast('📸 Screenshot saved to Pictures/CupCat', false);
            }
        } else {
            // Web fallback — download
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = `${state.docTitle || 'CupCat'}_frame.png`;
            a.click();
            if (window.showToast) window.showToast('📸 Screenshot downloaded', false);
        }
    } catch (e) {
        console.error('[CupCat] Screenshot failed:', e);
        if (window.showToast) window.showToast('Screenshot failed: ' + e.message, true);
    }
}

// ============================================================
// Share — open Android Share Sheet for last exported video
// ============================================================
let _lastExportPath = null;

export function setLastExportPath(path) {
    _lastExportPath = path;
}

export async function shareLastExport() {
    const FFmpegNative = window.Capacitor?.Plugins?.FFmpegPlugin || window.__CapFFmpeg;

    if (!FFmpegNative || !FFmpegNative.shareFile) {
        if (window.showToast) window.showToast('Share is only available on Android APK', true);
        return;
    }

    if (!_lastExportPath) {
        if (window.showToast) window.showToast('Export a video first', true);
        return;
    }

    try {
        await FFmpegNative.shareFile({
            filePath: _lastExportPath,
            mimeType: 'video/mp4',
            title: 'Share Video'
        });
    } catch (e) {
        console.error('[CupCat] Share failed:', e);
        if (window.showToast) window.showToast('Share failed: ' + e.message, true);
    }
}

// ============================================================
// Export Audio Only — extract mixed audio as MP3
// ============================================================
export async function exportAudioOnly() {
    const FFmpegNative = window.Capacitor?.Plugins?.FFmpegPlugin || window.__CapFFmpeg;
    if (!FFmpegNative) {
        if (window.showToast) window.showToast('Audio export requires native FFmpeg', true);
        return;
    }
    if (state.videoClips.length === 0) {
        if (window.showToast) window.showToast('Add at least one media clip first', true);
        return;
    }

    state._exportCancelled = false;
    state.isExporting = true;
    const overlay = document.getElementById('cupcat-export-overlay');
    if (overlay) overlay.style.display = 'flex';
    updateExportProgress(0);

    try {
        const { loadFilesystem, writeTempBlob, getNativePath, tempDir } = await getExportNativeHelpers();

        // Write clip files to temp
        let inputArgs = [];
        for (let i = 0; i < state.videoClips.length; i++) {
            const clip = state.videoClips[i];
            if (!clip.file) continue;
            const ext = clip.file.name ? clip.file.name.split('.').pop() : 'mp4';
            const path = await writeTempBlob(`aud_clip${i}.${ext}`, clip.file);
            if (path) inputArgs.push('-i', `"${path}"`);
        }

        // Add audio tracks
        for (let a = 0; a < state.audioTracks.length; a++) {
            const audio = state.audioTracks[a];
            if (!audio.file) continue;
            const ext = audio.file.name ? audio.file.name.split('.').pop() : 'mp3';
            const path = await writeTempBlob(`aud_track${a}.${ext}`, audio.file);
            if (path) inputArgs.push('-i', `"${path}"`);
        }

        updateExportProgress(30);

        const totalInputs = state.videoClips.filter(c => c.file).length + state.audioTracks.filter(a => a.file).length;
        let filterParts = [];
        let mixLabels = [];

        for (let i = 0; i < totalInputs; i++) {
            const vol = i < state.videoClips.length
                ? (state.videoClips[i].muted ? 0 : perceptualVolume(state.videoClips[i].volume !== undefined ? state.videoClips[i].volume : 1))
                : (state.audioTracks[i - state.videoClips.length].muted ? 0 : perceptualVolume(state.audioTracks[i - state.videoClips.length].volume !== undefined ? state.audioTracks[i - state.videoClips.length].volume : 1));
            filterParts.push(`[${i}:a]volume=${vol}[a${i}]`);
            mixLabels.push(`[a${i}]`);
        }

        if (mixLabels.length > 1) {
            filterParts.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest[outa]`);
        } else if (mixLabels.length === 1) {
            filterParts.push(`${mixLabels[0]}acopy[outa]`);
        }

        const { Filesystem, Directory } = await loadFilesystem();
        try { await Filesystem.mkdir({ path: tempDir, directory: Directory.CACHE, recursive: true }); } catch (_) {}
        try { await Filesystem.writeFile({ path: tempDir + '/audio_output.mp3', data: '', directory: Directory.CACHE, recursive: true }); } catch (_) {}
        const outputPath = await getNativePath(tempDir + '/audio_output.mp3');

        const ffmpegCmd = [
            ...inputArgs,
            '-filter_complex', `"${filterParts.join('; ')}"`,
            '-map', '[outa]',
            '-c:a', 'libmp3lame',
            '-b:a', '192k',
            '-y', `"${outputPath}"`
        ].join(' ');

        updateExportProgress(50);
        const result = await FFmpegNative.execute({ command: ffmpegCmd });
        
        if (!result.success) {
            throw new Error('FFmpeg audio export failed');
        }

        updateExportProgress(85);

        // Save to gallery
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const savedFileName = `${state.docTitle || 'CupCat'}_audio_${ts}.mp3`;
        
        try {
            await FFmpegNative.saveToGallery({ filePath: outputPath, fileName: savedFileName });
            if (window.showToast) window.showToast('🎵 Audio saved to gallery', false);
        } catch (e) {
            // Fallback: copy to Documents
            try {
                await Filesystem.copy({
                    from: tempDir + '/audio_output.mp3',
                    directory: Directory.CACHE,
                    to: 'CupCat/' + savedFileName,
                    toDirectory: Directory.DOCUMENTS
                });
                if (window.showToast) window.showToast('🎵 Audio saved to Documents/CupCat', false);
            } catch (e2) {
                if (window.showToast) window.showToast('Audio save failed', true);
            }
        }

        updateExportProgress(100);
    } catch (e) {
        console.error('[CupCat] Audio export error:', e);
        if (window.showToast) window.showToast('Audio export failed: ' + e.message, true);
    } finally {
        state.isExporting = false;
        if (overlay) overlay.style.display = 'none';
    }
}

// Helper to get native export utilities (avoids code duplication)
async function getExportNativeHelpers() {
    const loadFilesystem = async () => {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        return { Filesystem, Directory };
    };
    const { Filesystem, Directory } = await loadFilesystem();
    const FFmpegNative = window.Capacitor?.Plugins?.FFmpegPlugin || window.__CapFFmpeg;
    const tempDir = 'cupcat_export_temp_' + Date.now();

    const getNativePath = async (relPath) => {
        try {
            const result = await Filesystem.getUri({ path: relPath, directory: Directory.CACHE });
            let native = result.uri;
            if (native.startsWith('file://')) native = native.substring(7);
            return decodeURIComponent(native);
        } catch (_) { return null; }
    };

    const writeTempBlob = async (filename, fileOrBlob, objectUrl) => {
        try {
            let base64 = '';
            if (fileOrBlob) {
                const buf = await fileOrBlob.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let binary = '';
                for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
                base64 = btoa(binary);
            } else if (objectUrl) {
                const resp = await fetch(objectUrl);
                const buf = await resp.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let binary = '';
                for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
                base64 = btoa(binary);
            }
            if (!base64) return null;

            const filePath = tempDir + '/' + filename;
            await Filesystem.writeFile({ path: filePath, data: base64, directory: Directory.CACHE, recursive: true });
            return await getNativePath(filePath);
        } catch (e) {
            console.warn('[CupCat] writeTempBlob failed for ' + filename, e);
            return null;
        }
    };

    return { loadFilesystem, Filesystem, Directory, FFmpegNative, tempDir, getNativePath, writeTempBlob };
}

// ============================================================
// Export GIF — high-quality animated GIF with palette
// ============================================================
export async function exportGif() {
    const FFmpegNative = window.Capacitor?.Plugins?.FFmpegPlugin || window.__CapFFmpeg;
    if (!FFmpegNative) {
        if (window.showToast) window.showToast('GIF export requires native FFmpeg', true);
        return;
    }
    if (state.videoClips.length === 0) {
        if (window.showToast) window.showToast('Add at least one media clip first', true);
        return;
    }

    state._exportCancelled = false;
    state.isExporting = true;
    const overlay = document.getElementById('cupcat-export-overlay');
    if (overlay) overlay.style.display = 'flex';
    updateExportProgress(0);

    try {
        const { writeTempBlob, getNativePath, tempDir, Filesystem, Directory } = await getExportNativeHelpers();

        const clip = state.videoClips[0];
        if (!clip.file) throw new Error('No clip file');
        const ext = clip.file.name ? clip.file.name.split('.').pop() : 'mp4';
        const inputPath = await writeTempBlob(`gif_input.${ext}`, clip.file);
        if (!inputPath) throw new Error('Failed to write input file');

        updateExportProgress(30);

        // Create palette first for quality
        const palettePath = await getNativePath(tempDir + '/palette.png');
        try { await Filesystem.writeFile({ path: tempDir + '/palette.png', data: '', directory: Directory.CACHE, recursive: true }); } catch (_) {}

        const fps = 12;
        const maxW = 480;
        const duration = getClipDuration(clip, 0);
        const maxDur = Math.min(duration, 15); // Max 15s for GIF

        const paletteCmd = `-ss 0 -t ${maxDur} -i "${inputPath}" -vf "fps=${fps},scale=${maxW}:-1:flags=lanczos,palettegen=stats_mode=diff" -y "${palettePath}"`;
        await FFmpegNative.execute({ command: paletteCmd });

        updateExportProgress(50);

        // Render GIF using palette
        const outputPath = await getNativePath(tempDir + '/output.gif');
        try { await Filesystem.writeFile({ path: tempDir + '/output.gif', data: '', directory: Directory.CACHE, recursive: true }); } catch (_) {}

        const gifCmd = `-ss 0 -t ${maxDur} -i "${inputPath}" -i "${palettePath}" -lavfi "fps=${fps},scale=${maxW}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -y "${outputPath}"`;
        await FFmpegNative.execute({ command: gifCmd });

        updateExportProgress(80);

        // Save to gallery
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fileName = `${state.docTitle || 'CupCat'}_${ts}.gif`;

        // Save as image to Pictures
        try {
            const gifData = await Filesystem.readFile({ path: tempDir + '/output.gif', directory: Directory.CACHE });
            if (gifData && gifData.data) {
                await FFmpegNative.saveImage({ base64Data: gifData.data, fileName });
            }
        } catch (e) {
            // Fallback: copy to Documents
            try {
                await Filesystem.copy({
                    from: tempDir + '/output.gif', directory: Directory.CACHE,
                    to: 'CupCat/' + fileName, toDirectory: Directory.DOCUMENTS
                });
            } catch (_) {}
        }

        updateExportProgress(100);
        if (window.showToast) window.showToast('🎞️ GIF saved! (' + maxDur.toFixed(1) + 's, ' + maxW + 'px)', false);
        try { FFmpegNative.showNotification({ title: '🎞️ CupCat', message: 'GIF exported!' }); } catch (_) {}

    } catch (e) {
        console.error('[CupCat] GIF export error:', e);
        if (window.showToast) window.showToast('GIF export failed: ' + e.message, true);
    } finally {
        state.isExporting = false;
        if (overlay) overlay.style.display = 'none';
    }
}

// ============================================================
// Export Boomerang — forward + reversed loop as MP4
// ============================================================
export async function exportBoomerang() {
    const FFmpegNative = window.Capacitor?.Plugins?.FFmpegPlugin || window.__CapFFmpeg;
    if (!FFmpegNative) {
        if (window.showToast) window.showToast('Boomerang requires native FFmpeg', true);
        return;
    }
    if (state.videoClips.length === 0) {
        if (window.showToast) window.showToast('Add at least one media clip first', true);
        return;
    }

    state._exportCancelled = false;
    state.isExporting = true;
    const overlay = document.getElementById('cupcat-export-overlay');
    if (overlay) overlay.style.display = 'flex';
    updateExportProgress(0);

    try {
        const { writeTempBlob, getNativePath, tempDir, Filesystem, Directory } = await getExportNativeHelpers();

        const clip = state.videoClips[0];
        if (!clip.file) throw new Error('No clip file');
        const ext = clip.file.name ? clip.file.name.split('.').pop() : 'mp4';
        const inputPath = await writeTempBlob(`boom_input.${ext}`, clip.file);
        if (!inputPath) throw new Error('Failed to write input file');

        updateExportProgress(20);

        const duration = getClipDuration(clip, 0);
        const maxDur = Math.min(duration, 6); // Max 6s for boomerang (forward = 3s, loop = 6s)

        const outputPath = await getNativePath(tempDir + '/boomerang.mp4');
        try { await Filesystem.writeFile({ path: tempDir + '/boomerang.mp4', data: '', directory: Directory.CACHE, recursive: true }); } catch (_) {}

        // Forward + Reverse concat using filter_complex
        const cmd = `-ss 0 -t ${maxDur} -i "${inputPath}" -filter_complex "[0:v]split[fwd][rev];[rev]reverse[rv];[fwd][rv]concat=n=2:v=1:a=0[v]" -map "[v]" -c:v h264_mediacodec -b:v 4M -an -y "${outputPath}"`;

        updateExportProgress(40);
        const result = await FFmpegNative.execute({ command: cmd });

        if (!result.success) {
            // Fallback: try without hardware encoder
            const cmdSw = `-ss 0 -t ${maxDur} -i "${inputPath}" -filter_complex "[0:v]split[fwd][rev];[rev]reverse[rv];[fwd][rv]concat=n=2:v=1:a=0[v]" -map "[v]" -c:v libx264 -preset ultrafast -crf 23 -an -y "${outputPath}"`;
            await FFmpegNative.execute({ command: cmdSw });
        }

        updateExportProgress(80);

        // Save to gallery
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fileName = `${state.docTitle || 'CupCat'}_boomerang_${ts}.mp4`;

        try {
            await FFmpegNative.saveToGallery({ filePath: outputPath, fileName });
            setLastExportPath(outputPath);
            if (window.showToast) window.showToast('🔄 Boomerang saved to Gallery!', false);
        } catch (e) {
            try {
                await Filesystem.copy({
                    from: tempDir + '/boomerang.mp4', directory: Directory.CACHE,
                    to: 'CupCat/' + fileName, toDirectory: Directory.DOCUMENTS
                });
                if (window.showToast) window.showToast('🔄 Boomerang saved to Documents/CupCat', false);
            } catch (_) {
                if (window.showToast) window.showToast('Boomerang save failed', true);
            }
        }

        updateExportProgress(100);
        try { FFmpegNative.showNotification({ title: '🔄 CupCat', message: 'Boomerang ready!' }); } catch (_) {}

    } catch (e) {
        console.error('[CupCat] Boomerang export error:', e);
        if (window.showToast) window.showToast('Boomerang failed: ' + e.message, true);
    } finally {
        state.isExporting = false;
        if (overlay) overlay.style.display = 'none';
    }
}

export async function exportVideo() {
    const isNative = !!(
        window.__CapFFmpeg ||
        window.Capacitor?.Plugins?.FFmpegPlugin ||
        (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) ||
        window.Capacitor?.platform === 'android' ||
        (window.Capacitor?.getPlatform && window.Capacitor.getPlatform() === 'android') ||
        (typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent) && !!window.Capacitor)
    );
    
    console.log('[CupCat Export Router]', {
        Capacitor: !!window.Capacitor,
        isNative,
        hasFFmpegPlugin: !!window.Capacitor?.Plugins?.FFmpegPlugin || !!window.__CapFFmpeg,
        hasVideoEncoder: !!window.VideoEncoder,
        hasFFmpegWasm: state.ffmpegLoaded,
        __CapFS: !!window.__CapFS,
        plugins: Object.keys(window.Capacitor?.Plugins || {})
    });

    if (isNative) {
        console.log('[CupCat] Using Native FFmpeg Plugin for Export');
        await exportVideoNative();
    } else if (state.ffmpegLoaded) {
        console.log('[CupCat] Using Software FFmpeg for Export');
        await exportVideoFFmpeg();
    } else if (window.VideoEncoder) {
        console.log('[CupCat] Using Hardware WebCodecs for Export');
        await exportVideoWebCodecs();
    } else {
        console.log('[CupCat] Defaulting to Native FFmpeg Export');
        await exportVideoNative();
    }
}

// ============================================================
// Helper: trigger download in any environment (web or WebView)
// In native Capacitor mode, saves via Filesystem API + gallery
// ============================================================
async function triggerBlobDownload(blob, filename) {
    const isNative = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
    const CHUNK_SIZE = 512 * 1024; // 512KB per chunk — safe for Capacitor bridge
    
    // Helper: convert Uint8Array to base64 safely
    function uint8ToBase64(u8) {
        let bin = '';
        for (let j = 0; j < u8.length; j += 32768) {
            bin += String.fromCharCode.apply(null, u8.subarray(j, j + 32768));
        }
        return btoa(bin);
    }
    
    if (isNative && Filesystem && Directory) {
        // Native Android: save to cache first, then move to gallery via MediaStore
        try {
            const ab = await blob.arrayBuffer();
            const u8 = new Uint8Array(ab);
            
            console.log('[CupCat] Blob size:', u8.length, 'bytes (' + (u8.length / 1024 / 1024).toFixed(2) + ' MB)');
            
            // Save to cache using CHUNKED writes to avoid OOM on large videos
            const cachePath = 'CupCat_export/' + filename;
            
            if (u8.length <= CHUNK_SIZE) {
                // Small file — single write
                await Filesystem.writeFile({
                    path: cachePath,
                    data: uint8ToBase64(u8),
                    directory: Directory.CACHE,
                    recursive: true
                });
            } else {
                // Large file — write first chunk, then append rest
                const firstChunk = u8.subarray(0, CHUNK_SIZE);
                await Filesystem.writeFile({
                    path: cachePath,
                    data: uint8ToBase64(firstChunk),
                    directory: Directory.CACHE,
                    recursive: true
                });
                
                for (let offset = CHUNK_SIZE; offset < u8.length; offset += CHUNK_SIZE) {
                    const chunk = u8.subarray(offset, Math.min(offset + CHUNK_SIZE, u8.length));
                    await Filesystem.appendFile({
                        path: cachePath,
                        data: uint8ToBase64(chunk),
                        directory: Directory.CACHE
                    });
                }
            }
            
            console.log('[CupCat] Saved to cache (chunked): ' + cachePath);
            
            // Verify the file was actually written correctly
            let nativePath;
            try {
                const stat = await Filesystem.getUri({ path: cachePath, directory: Directory.CACHE });
                nativePath = stat.uri.replace('file://', '');
                console.log('[CupCat] Cache file URI:', nativePath);
            } catch (uriErr) {
                console.error('[CupCat] Failed to get URI for cache file:', uriErr);
                throw uriErr;
            }
            
            // Move to gallery via FFmpegPlugin.saveToGallery (Movies/CupCat)
            const FFmpegNative = window.Capacitor?.Plugins?.FFmpegPlugin || window.__CapFFmpeg;
            let gallerySaved = false;
            
            if (FFmpegNative && FFmpegNative.saveToGallery) {
                try {
                    console.log('[CupCat] Calling saveToGallery, path:', nativePath, 'fileName:', filename);
                    const gr = await FFmpegNative.saveToGallery({ filePath: nativePath, fileName: filename });
                    if (gr && gr.success) {
                        gallerySaved = true;
                        console.log('[CupCat] Gallery save SUCCESS:', gr.uri);
                        if (window.showToast) window.showToast(`✅ Video saved to Gallery (Movies/CupCat)`, false);
                    } else {
                        console.error('[CupCat] Gallery save returned without success:', JSON.stringify(gr));
                    }
                } catch (ge) {
                    console.error('[CupCat] Gallery save FAILED:', ge && ge.message ? ge.message : ge);
                }
            } else {
                console.warn('[CupCat] FFmpegPlugin.saveToGallery not available, trying direct Filesystem save');
            }
            
            // Fallback: if gallery save failed, try saving directly to Documents
            if (!gallerySaved) {
                try {
                    console.log('[CupCat] Trying fallback: save to Documents/CupCat/');
                    const docPath = 'CupCat/' + filename;
                    
                    // Try copying from cache to Documents
                    await Filesystem.copy({
                        from: cachePath,
                        directory: Directory.CACHE,
                        to: docPath,
                        toDirectory: Directory.DOCUMENTS
                    });
                    
                    console.log('[CupCat] Fallback save to Documents succeeded:', docPath);
                    if (window.showToast) window.showToast(`✅ Video saved to Documents/CupCat/ (check file manager)`, false);
                    gallerySaved = true;
                } catch (docErr) {
                    console.error('[CupCat] Documents fallback also failed:', docErr);
                }
            }
            
            // Final fallback: try saving to EXTERNAL_STORAGE
            if (!gallerySaved) {
                try {
                    console.log('[CupCat] Trying final fallback: EXTERNAL_STORAGE');
                    const extPath = 'CupCat/' + filename;
                    
                    await Filesystem.copy({
                        from: cachePath,
                        directory: Directory.CACHE,
                        to: extPath,
                        toDirectory: Directory.EXTERNAL_STORAGE
                    });
                    
                    console.log('[CupCat] External storage save succeeded:', extPath);
                    if (window.showToast) window.showToast(`✅ Video saved to phone storage (CupCat/)`, false);
                    gallerySaved = true;
                } catch (extErr) {
                    console.error('[CupCat] External storage fallback failed:', extErr);
                    if (window.showToast) window.showToast(`❌ Failed to save video. Try freeing up storage.`, true);
                }
            }
            
            // Delay cleanup to let MediaScanner finish indexing
            setTimeout(async () => {
                try { await Filesystem.deleteFile({ path: cachePath, directory: Directory.CACHE }); } catch (_) {}
            }, 3000);
            
            // Return a web-viewable URL for preview
            const previewUrl = URL.createObjectURL(blob);
            return previewUrl;
        } catch (fsErr) {
            console.error('[CupCat] Filesystem save failed, falling back to blob download:', fsErr);
            if (window.showToast) window.showToast(`⚠️ Native save failed, downloading file...`, true);
            // Fall through to web download
        }
    }
    
    // Web mode: standard blob download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
    }, 3000);
    return url;
}

// ============================================================
// ASS (Advanced Substation Alpha) Generator for Native FFmpeg
// Converts subtitleTracks and textOverlays into a unified ASS
// script that libass renders vectorially in a single pass with
// zero image loops and zero extra overlay filters (50x faster).
// ============================================================

export function formatAssTime(s) {
    if (isNaN(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const cs = Math.floor(Math.min(99, Math.round((s % 1) * 100)));
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function cssColorToAss(col, defaultAss = '&H00FFFFFF&') {
    if (!col) return defaultAss;
    col = String(col).trim();
    if (col === 'transparent' || col === 'none') return '&HFF000000&';
    if (col === 'black') return '&H00000000&';
    if (col === 'white') return '&H00FFFFFF&';
    if (col === 'yellow') return '&H0000E6FF&';
    if (col === 'red') return '&H000000FF&';

    // Hex #RGB, #RRGGBB, #RRGGBBAA
    if (col.startsWith('#')) {
        let hex = col.slice(1);
        if (hex.length === 3) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        if (hex.length === 6) {
            const r = hex.slice(0, 2);
            const g = hex.slice(2, 4);
            const b = hex.slice(4, 6);
            return `&H00${b}${g}${r}&`.toUpperCase();
        }
        if (hex.length === 8) {
            const r = hex.slice(0, 2);
            const g = hex.slice(2, 4);
            const b = hex.slice(4, 6);
            const a = hex.slice(6, 8);
            const assA = (255 - parseInt(a, 16)).toString(16).padStart(2, '0');
            return `&H${assA}${b}${g}${r}&`.toUpperCase();
        }
    }

    // rgba(r, g, b, a) or rgb(r, g, b)
    const rgbaMatch = col.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (rgbaMatch) {
        const r = parseInt(rgbaMatch[1], 10).toString(16).padStart(2, '0');
        const g = parseInt(rgbaMatch[2], 10).toString(16).padStart(2, '0');
        const b = parseInt(rgbaMatch[3], 10).toString(16).padStart(2, '0');
        const a = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
        const assA = Math.round((1 - Math.max(0, Math.min(1, a))) * 255).toString(16).padStart(2, '0');
        return `&H${assA}${b}${g}${r}&`.toUpperCase();
    }

    return defaultAss;
}

export function generateAssContent(subtitles = [], textOverlays = [], outW = 1080, outH = 1920) {
    const fontScale = Math.min(outW, outH) / 360;
    const dialogues = [];

    // 1. Process Subtitle Tracks
    for (const sub of subtitles) {
        const rawText = sub.text || '';
        if (!rawText.trim()) continue;

        const startTime = formatAssTime(sub.startTime || 0);
        const endTime = formatAssTime(sub.endTime || (sub.startTime || 0) + 2);

        let text = rawText;
        if (sub.isUppercase) text = text.toUpperCase();
        text = text.replace(/[{}]/g, '').replace(/\r\n|\r|\n/g, '\\N');

        const baseFontSize = sub.fontSize || 24;
        const scaleFactor = (sub.scale !== undefined ? sub.scale : 100) / 100;
        const fontSize = Math.max(12, Math.round(baseFontSize * scaleFactor * fontScale));

        let posX = sub.posX !== undefined ? sub.posX : 50;
        let posY = sub.posY !== undefined ? sub.posY : (sub.position === 'top' ? 12 : sub.position === 'center' ? 50 : 88);
        const x = Math.round((posX / 100) * outW);
        const y = Math.round((posY / 100) * outH);

        const fontName = sub.font || sub.fontFamily || 'Inter, sans-serif';
        const isBold = sub.isBold !== false ? 1 : 0;
        const isItalic = sub.isItalic ? 1 : 0;

        const primaryColor = cssColorToAss(sub.color || '#ffffff', '&H00FFFFFF&');
        const hasBg = sub.showBg || sub.hasBg || (sub.bgColor && sub.bgColor !== 'transparent' && sub.bgColor !== 'none');
        const bgColor = cssColorToAss(sub.bgColor || 'rgba(0,0,0,0.75)', '&H40000000&');

        const hasStroke = sub.showStroke || (sub.strokeWidth && sub.strokeWidth > 0);
        const strokeWidth = hasStroke ? Math.max(1, Math.round((sub.strokeWidth || 3) * fontScale)) : 0;
        const strokeColor = cssColorToAss(sub.strokeColor || '#000000', '&H00000000&');

        const hasShadow = sub.showShadow || (sub.shadowBlur && sub.shadowBlur > 0);
        const shadowDepth = hasShadow ? Math.max(1, Math.round((sub.shadowOffsetY || 2) * fontScale)) : 0;
        const shadowColor = cssColorToAss(sub.shadowColor || 'rgba(0,0,0,0.85)', '&H80000000&');

        let overrideTags = `\\an5\\pos(${x},${y})\\fn${fontName}\\fs${fontSize}\\b${isBold}\\i${isItalic}`;

        if (hasBg) {
            const pad = Math.max(4, Math.round(fontSize * 0.25));
            overrideTags += `\\bord${pad}\\shad0\\1c${primaryColor}\\3c${bgColor}\\4c${bgColor}`;
        } else {
            overrideTags += `\\bord${strokeWidth}\\shad${shadowDepth}\\1c${primaryColor}\\3c${strokeColor}\\4c${shadowColor}`;
        }

        dialogues.push(`Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,{${overrideTags}}${text}`);
    }

    // 2. Process Text Overlays (Titles, Headers)
    for (const ovl of textOverlays) {
        const rawText = ovl.text || '';
        if (!rawText.trim()) continue;

        const startTime = formatAssTime(ovl.startTime || 0);
        const endTime = formatAssTime(ovl.endTime || (ovl.startTime || 0) + 5);

        let text = rawText;
        text = text.replace(/[{}]/g, '').replace(/\r\n|\r|\n/g, '\\N');

        const baseFontSize = ovl.fontSize || 36;
        const fontSize = Math.max(14, Math.round(baseFontSize * fontScale));

        let posX = ovl.posX !== undefined ? ovl.posX : 50;
        let posY = ovl.posY !== undefined ? ovl.posY : (ovl.position === 'top' ? 12 : ovl.position === 'bottom' ? 88 : 50);
        const x = Math.round((posX / 100) * outW);
        const y = Math.round((posY / 100) * outH);

        const fontName = ovl.font || 'Inter, sans-serif';
        const primaryColor = cssColorToAss(ovl.color || '#ffffff', '&H00FFFFFF&');
        const strokeWidth = Math.max(1, Math.round(2 * fontScale));
        const shadowDepth = Math.max(1, Math.round(2 * fontScale));

        const overrideTags = `\\an5\\pos(${x},${y})\\fn${fontName}\\fs${fontSize}\\b1\\bord${strokeWidth}\\shad${shadowDepth}\\1c${primaryColor}\\3c&H00000000&\\4c&H80000000&`;
        dialogues.push(`Dialogue: 1,${startTime},${endTime},Default,,0,0,0,,{${overrideTags}}${text}`);
    }

    if (dialogues.length === 0) return null;

    return `[Script Info]
ScriptType: v4.00+
PlayResX: ${outW}
PlayResY: ${outH}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Inter,36,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogues.join('\n')}
`;
}

// Helper: render a text overlay to a transparent PNG blob for use as an image overlay.
// This replaces the FFmpeg drawtext filter which requires libfreetype and may be
// unavailable in native ffmpeg-kit builds or sandboxed mobile environments.
async function renderTextOverlayToBlob(ovl, outW, outH) {
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, outW, outH);

    const fontSize = Math.max(12, Math.round(ovl.fontSize || 36));
    const fontFamily = ovl.font || 'Inter';

    // Position: percentage-based (matches render-scene.js drawTextOverlays)
    let posX = ovl.posX !== undefined ? ovl.posX : 50;
    let posY = ovl.posY !== undefined ? ovl.posY : 50;
    if (ovl.position === 'top') posY = 12;
    else if (ovl.position === 'bottom') posY = 88;

    const x = (posX / 100) * outW;
    const y = (posY / 100) * outH;

    ctx.save();
    ctx.translate(x, y);

    ctx.font = `700 ${fontSize}px '${fontFamily}', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Shadow (matches render-scene.js)
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;

    // Stroke outline for readability
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.strokeText(ovl.text || '', 0, 0);

    // Main fill
    ctx.fillStyle = ovl.color || '#ffffff';
    ctx.fillText(ovl.text || '', 0, 0);

    ctx.restore();

    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function wrapExportText(ctx, text, maxWidth) {
    const paragraphs = String(text || '').split('\n');
    const lines = [];
    for (const para of paragraphs) {
        if (!para.trim()) {
            lines.push('');
            continue;
        }
        const words = para.split(' ');
        let currentLine = words[0] || '';
        for (let i = 1; i < words.length; i++) {
            const word = words[i];
            const testLine = currentLine + ' ' + word;
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && currentLine.length > 0) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        lines.push(currentLine);
    }
    return lines;
}

// Render a subtitle with background box to a transparent PNG for FFmpeg overlay
async function renderSubtitleOverlayToBlob(sub, outW, outH) {
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, outW, outH);

    drawSingleSubtitle(ctx, sub, sub.startTime || 0, outW, outH);

    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

// Render ALL text and subtitle overlays in one composite PNG (massive perf optimization)
async function renderCompositeOverlayToBlob(overlays, outW, outH) {
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;

    // ANDROID FIX: Some Android WebViews silently fail fillText() on canvases
    // not attached to the DOM. Attach it hidden, draw, then remove.
    canvas.style.cssText = 'position:fixed;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none;z-index:-1;';
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        console.error('[CupCat Composite] Failed to get canvas 2d context');
        document.body.removeChild(canvas);
        return null;
    }
    ctx.clearRect(0, 0, outW, outH);

    // Wait for web fonts to be loaded before rendering text on canvas (with timeout)
    try {
        if (document.fonts && document.fonts.ready) {
            await Promise.race([
                document.fonts.ready,
                new Promise(resolve => setTimeout(resolve, 3000))
            ]);
        }
    } catch (fontErr) {
        console.warn('[CupCat Composite] document.fonts.ready failed (non-fatal):', fontErr);
    }

    const fontScale = Math.min(outW, outH) / 360;
    console.log(`[CupCat Composite] Canvas: ${outW}x${outH}, fontScale: ${fontScale.toFixed(2)}, overlays: ${overlays.length}`);

    for (const ovl of overlays) {
        const text = ovl.text || '';
        if (!text.trim()) {
            console.warn('[CupCat Composite] Skipping overlay with empty text');
            continue;
        }

        try {
            if (ovl._type === 'sub') {
                drawSingleSubtitle(ctx, ovl, ovl.startTime || 0, outW, outH);
                console.log(`[CupCat Composite] Drew subtitle: "${text.substring(0,30)}" at unified scale`);
            } else {
                drawTextOverlayItem(ctx, ovl, ovl.startTime || 0, outW, outH);
                console.log(`[CupCat Composite] Drew text: "${text.substring(0,30)}" at unified scale`);
            }
        } catch (drawErr) {
            console.error('[CupCat Composite] Error drawing overlay:', drawErr);
        }
    }

    // Verify something was drawn
    const checkPixels = ctx.getImageData(0, 0, Math.min(outW, 100), Math.min(outH, 100));
    let hasContent = false;
    for (let i = 3; i < checkPixels.data.length; i += 4) {
        if (checkPixels.data[i] > 0) { hasContent = true; break; }
    }
    if (!hasContent) {
        // Check the full canvas, not just the corner
        const fullCheck = ctx.getImageData(0, 0, outW, outH);
        for (let i = 3; i < fullCheck.data.length; i += 16) {
            if (fullCheck.data[i] > 0) { hasContent = true; break; }
        }
    }
    console.log(`[CupCat Composite] Canvas has visible content: ${hasContent}`);

    // ANDROID FIX: If nothing was drawn, retry with simplified sans-serif font
    // and basic styling. Some Android WebViews fail with custom fonts on canvas.
    if (!hasContent) {
        console.warn('[CupCat Composite] RETRY: Re-rendering with simplified sans-serif font');
        ctx.clearRect(0, 0, outW, outH);
        for (const ovl of overlays) {
            const text = ovl.text || '';
            if (!text.trim()) continue;
            try {
                if (ovl._type === 'sub') {
                    drawSingleSubtitle(ctx, { ...ovl, font: 'sans-serif', fontFamily: 'sans-serif' }, ovl.startTime || 0, outW, outH);
                } else {
                    drawTextOverlayItem(ctx, { ...ovl, font: 'sans-serif', fontFamily: 'sans-serif' }, ovl.startTime || 0, outW, outH);
                }
            } catch (retryErr) {
                console.error('[CupCat Composite] Retry draw error:', retryErr);
            }
        }

        // Re-check content
        const retryCheck = ctx.getImageData(0, 0, outW, outH);
        for (let i = 3; i < retryCheck.data.length; i += 16) {
            if (retryCheck.data[i] > 0) { hasContent = true; break; }
        }
        console.log(`[CupCat Composite] RETRY has visible content: ${hasContent}`);
    }

    // ANDROID FALLBACK #3: Use SVG foreignObject to render text via HTML/CSS.
    // This bypasses canvas fillText entirely and uses the WebView's HTML renderer
    // which is always reliable on Android.
    if (!hasContent) {
        console.warn('[CupCat Composite] FALLBACK #3: Using SVG foreignObject to render text');
        try {
            ctx.clearRect(0, 0, outW, outH);

            // Build HTML for all overlays
            let htmlParts = '';
            for (const ovl of overlays) {
                const text = ovl.text || '';
                if (!text.trim()) continue;

                const fontSize = Math.max(12, Math.round((ovl.fontSize || 36) * fontScale));
                let posX = ovl.posX !== undefined ? ovl.posX : 50;
                let posY = ovl.posY !== undefined ? ovl.posY : 50;

                if (ovl._type === 'sub') {
                    if (ovl.posY === undefined) {
                        if (ovl.position === 'top') posY = 12;
                        else if (ovl.position === 'center') posY = 50;
                        else if (ovl.position === 'bottom') posY = 88;
                    }
                } else {
                    if (ovl.posY === undefined) {
                        if (ovl.position === 'top') posY = 12;
                        else if (ovl.position === 'center') posY = 50;
                        else posY = 88;
                    }
                }

                const x = Math.round((posX / 100) * outW);
                const y = Math.round((posY / 100) * outH);
                const color = ovl.color || '#ffffff';
                const bgStyle = ovl._type === 'sub'
                    ? `background:${ovl.bgColor || 'rgba(0,0,0,0.7)'};padding:${fontSize * 0.35}px ${fontSize * 0.5}px;border-radius:${fontSize * 0.3}px;`
                    : `text-shadow:0 2px 8px rgba(0,0,0,0.8),-1px -1px 0 rgba(0,0,0,0.6),1px -1px 0 rgba(0,0,0,0.6),-1px 1px 0 rgba(0,0,0,0.6),1px 1px 0 rgba(0,0,0,0.6);`;

                // Use CSS-escaped text content
                const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                htmlParts += `<div style="position:absolute;left:${x}px;top:${y}px;transform:translate(-50%,-50%);font:bold ${fontSize}px sans-serif;color:${color};white-space:nowrap;${bgStyle}">${escapedText}</div>`;
            }

            const svgData = `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}">
                <foreignObject width="100%" height="100%">
                    <div xmlns="http://www.w3.org/1999/xhtml" style="width:${outW}px;height:${outH}px;position:relative;">
                        ${htmlParts}
                    </div>
                </foreignObject>
            </svg>`;

            const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
            const svgUrl = URL.createObjectURL(svgBlob);

            const img = new Image();
            img.width = outW;
            img.height = outH;

            await new Promise((resolve, reject) => {
                img.onload = () => {
                    ctx.drawImage(img, 0, 0, outW, outH);
                    URL.revokeObjectURL(svgUrl);
                    resolve();
                };
                img.onerror = (err) => {
                    console.error('[CupCat Composite] SVG foreignObject failed:', err);
                    URL.revokeObjectURL(svgUrl);
                    reject(err);
                };
                img.src = svgUrl;
            });

            // Check if SVG approach produced content
            const svgCheck = ctx.getImageData(0, 0, outW, outH);
            for (let i = 3; i < svgCheck.data.length; i += 16) {
                if (svgCheck.data[i] > 0) { hasContent = true; break; }
            }
            console.log(`[CupCat Composite] SVG foreignObject has visible content: ${hasContent}`);
        } catch (svgErr) {
            console.error('[CupCat Composite] SVG foreignObject fallback failed:', svgErr);
        }
    }

    // Use toBlob with fallback to toDataURL for Android WebView compatibility
    const result = await new Promise(resolve => {
        try {
            canvas.toBlob(blob => {
                if (blob && blob.size > 0) {
                    resolve(blob);
                } else {
                    // Fallback: toDataURL → manually convert to Blob
                    console.warn('[CupCat Composite] toBlob returned null/empty, using toDataURL fallback');
                    try {
                        const dataUrl = canvas.toDataURL('image/png');
                        const byteString = atob(dataUrl.split(',')[1]);
                        const ab = new ArrayBuffer(byteString.length);
                        const ia = new Uint8Array(ab);
                        for (let i = 0; i < byteString.length; i++) {
                            ia[i] = byteString.charCodeAt(i);
                        }
                        resolve(new Blob([ab], { type: 'image/png' }));
                    } catch (fallbackErr) {
                        console.error('[CupCat Composite] toDataURL fallback also failed:', fallbackErr);
                        resolve(null);
                    }
                }
            }, 'image/png');
        } catch (toBlobErr) {
            console.error('[CupCat Composite] toBlob threw:', toBlobErr);
            resolve(null);
        }
    });

    // Cleanup: remove canvas from DOM
    try { document.body.removeChild(canvas); } catch (_) {}

    return result;
}

// ============================================================
// NATIVE EXPORT — Capacitor APK with native FFmpeg (ffmpeg-kit)
// Mirrors exportVideoFFmpeg() filter graph but runs through the
// native Java FFmpegPlugin for hardware-accelerated encoding.
// Replaces the old frame-by-frame WebCodecs approach that was
// extremely slow (~30 min for a 3 min video).
// ============================================================
export async function exportVideoNative() {
    await loadFilesystem();

    if (state.videoClips.length === 0) {
        if (window.showToast) window.showToast('Add at least one media clip first.', true);
        return;
    }
    const missing = state.videoClips.find(c => !c.file);
    if (missing) {
        if (window.showToast) window.showToast('Some clips are missing files. Delete and re-add them.', true);
        return;
    }
    if (!Filesystem) {
        if (window.showToast) window.showToast('Filesystem not available.', true);
        console.error('[CupCat Native] Filesystem is null. __CapFS:', window.__CapFS, 'Capacitor:', !!window.Capacitor);
        return;
    }
    let FFmpegNative = window.Capacitor?.Plugins?.FFmpegPlugin || window.__CapFFmpeg;
    console.log('[CupCat Native] Plugin check:', {
        Capacitor: !!window.Capacitor,
        isNative: window.Capacitor?.isNativePlatform?.(),
        Plugins: Object.keys(window.Capacitor?.Plugins || {}),
        FFmpegPlugin: !!FFmpegNative,
        __CapFFmpeg: !!window.__CapFFmpeg,
        Filesystem: !!Filesystem
    });
    // Verify that FFmpegPlugin is actually registered on the native side
    // by making a quick test call. The Proxy object from main.js is always
    // truthy, so we need to actually call the native bridge to check.
    if (FFmpegNative) {
        try {
            // A harmless probe that will fail fast if plugin isn't registered
            await FFmpegNative.execute({ command: '-version' });
            console.log('[CupCat Native] FFmpegPlugin verified — native bridge responding');
        } catch (verifyErr) {
            const msg = (verifyErr && verifyErr.message) ? verifyErr.message : '';
            if (msg.includes('unable to find plugin')) {
                console.error('[CupCat Native] FFmpegPlugin is NOT registered on native side. Falling back to WebCodecs.');
                if (window.showToast) window.showToast('⚠️ FFmpeg native plugin not available — using slower export', true);
                return exportVideoWebCodecs();
            }
            // If -version "fails" for other reasons (it returns non-zero because no output file),
            // that's fine — it means the plugin IS registered and responding.
            console.log('[CupCat Native] FFmpegPlugin verified (probe returned error but plugin exists):', msg.substring(0, 100));
        }
    }
    if (!FFmpegNative) {
        console.error('[CupCat Native] FFmpegPlugin NOT FOUND! Falling back to slow WebCodecs.');
        if (window.showToast) window.showToast('⚠️ FFmpegPlugin not found — using slow export', true);
        return exportVideoWebCodecs();
    }
    
    // Default to h264_mediacodec (Android Hardware H.264 - fast, universal, supported in WebView)
    let videoEncoder = 'h264_mediacodec';
    let hasLibx264 = false;
    let hasMediacodec = false;
    try {
        const encRes = await FFmpegNative.execute({ command: '-encoders' });
        if (encRes && encRes.logs) {
            hasMediacodec = encRes.logs.includes('h264_mediacodec');
            hasLibx264 = encRes.logs.includes('libx264');
            if (hasMediacodec) {
                videoEncoder = 'h264_mediacodec';
            } else if (encRes.logs.includes('libopenh264')) {
                videoEncoder = 'libopenh264';
            } else if (hasLibx264) {
                videoEncoder = 'libx264';
            } else {
                videoEncoder = 'mpeg4';
            }
        }
    } catch (_) {}
    
    console.log('[CupCat Native] Encoder detection: libx264=' + hasLibx264 + ', mediacodec=' + hasMediacodec + ', selected=' + videoEncoder);
    if (window.showToast) window.showToast('🚀 Using native FFmpeg (fast export)', false);

    state._exportCancelled = false;
    state.isExporting = true;
    const overlay = document.getElementById('cupcat-export-overlay');
    if (overlay) overlay.style.display = 'flex';
    updateExportProgress(0);

    // Chunk size: 4MB for high-performance buffered transfer
    const tempDir = 'CupCat/.temp_export';
    const CHUNK_SIZE = 4 * 1024 * 1024;

    // Helper: convert Uint8Array to base64
    function uint8ToBase64(u8) {
        let bin = '';
        for (let j = 0; j < u8.length; j += 32768) {
            bin += String.fromCharCode.apply(null, u8.subarray(j, j + 32768));
        }
        return btoa(bin);
    }

    // ---- Write blob to cache using high-speed native buffered chunks ----
    async function writeTempBlob(filename, blob, objectUrl) {
        const path = tempDir + '/' + filename;
        let ab = null;

        // 1. Direct ArrayBuffer from Blob / File
        if (blob && typeof blob.arrayBuffer === 'function') {
            try {
                ab = await blob.arrayBuffer();
            } catch (e) {
                console.warn('[CupCat Native] blob.arrayBuffer() failed:', e);
            }
        }

        // 2. FileReader fallback for Blob / File
        if (!ab && blob && (blob instanceof Blob || blob instanceof File)) {
            try {
                ab = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsArrayBuffer(blob);
                });
            } catch (e) {
                console.warn('[CupCat Native] FileReader failed:', e);
            }
        }

        // 3. Fallback for data URLs / blob URLs
        if (!ab && objectUrl) {
            try {
                if (objectUrl.startsWith('data:')) {
                    const base64Part = objectUrl.split(',')[1] || '';
                    const binaryStr = atob(base64Part);
                    const len = binaryStr.length;
                    const bytes = new Uint8Array(len);
                    for (let i = 0; i < len; i++) {
                        bytes[i] = binaryStr.charCodeAt(i);
                    }
                    ab = bytes.buffer;
                } else if (objectUrl.startsWith('blob:')) {
                    // Try XHR first (more reliable in WebView with COEP than fetch)
                    try {
                        ab = await new Promise((resolve, reject) => {
                            const xhr = new XMLHttpRequest();
                            xhr.open('GET', objectUrl, true);
                            xhr.responseType = 'arraybuffer';
                            xhr.onload = () => {
                                if (xhr.response) resolve(xhr.response);
                                else reject(new Error('Empty XHR response'));
                            };
                            xhr.onerror = () => reject(new Error('XHR blob fetch failed'));
                            xhr.send();
                        });
                    } catch (xhrErr) {
                        const res = await fetch(objectUrl);
                        const fetchedBlob = await res.blob();
                        ab = await fetchedBlob.arrayBuffer();
                    }
                } else {
                    const res = await fetch(objectUrl);
                    const fetchedBlob = await res.blob();
                    ab = await fetchedBlob.arrayBuffer();
                }
            } catch (e) {
                console.warn('[CupCat Native] objectUrl read failed for', filename, e);
            }
        }
        if (!ab && objectUrl) {
            // Last resort: re-fetch the objectUrl with a fresh fetch attempt
            try {
                const lastRes = await fetch(objectUrl);
                if (lastRes.ok) {
                    const lastBlob = await lastRes.blob();
                    if (lastBlob.size > 0) {
                        ab = await lastBlob.arrayBuffer();
                    }
                }
            } catch (e) {
                console.warn('[CupCat Native] Last-resort fetch failed for', filename, e);
            }
        }

        if (!ab) throw new Error(`Could not get binary data for ${filename}`);
        const u8 = new Uint8Array(ab);
        const nativePath = await getNativePath(path);

        // High-performance Java buffered stream (avoids bridge serialization bottleneck)
        if (FFmpegNative && FFmpegNative.writeChunk) {
            for (let offset = 0; offset < u8.length; offset += CHUNK_SIZE) {
                const chunk = u8.subarray(offset, Math.min(offset + CHUNK_SIZE, u8.length));
                const b64 = uint8ToBase64(chunk);
                await FFmpegNative.writeChunk({
                    filePath: nativePath,
                    base64Data: b64,
                    append: offset > 0
                });
            }
            return nativePath;
        }

        // Fallback: Capacitor Filesystem
        if (u8.length <= CHUNK_SIZE) {
            await Filesystem.writeFile({ path, data: uint8ToBase64(u8), directory: Directory.CACHE, recursive: true });
        } else {
            const firstChunk = u8.subarray(0, CHUNK_SIZE);
            await Filesystem.writeFile({ path, data: uint8ToBase64(firstChunk), directory: Directory.CACHE, recursive: true });

            for (let offset = CHUNK_SIZE; offset < u8.length; offset += CHUNK_SIZE) {
                const chunk = u8.subarray(offset, Math.min(offset + CHUNK_SIZE, u8.length));
                await Filesystem.appendFile({ path, data: uint8ToBase64(chunk), directory: Directory.CACHE });
            }
        }
        return nativePath;
    }

    async function getNativePath(relPath) {
        const stat = await Filesystem.getUri({ path: relPath, directory: Directory.CACHE });
        return stat.uri.replace('file://', '');
    }

    try {
        const exportDims = getExportDimensions(state.canvasAspect, state.exportSettings.resolution);
        const outW = exportDims.w;
        const outH = exportDims.h;

        if (window.showToast) window.showToast('Preparing files...', false);

        // ─── 1. Write media files to cache & build input args ───
        let inputArgs = [];
        let filterParts = [];
        let videoCount = 0;
        let hasAudioArray = [];

        for (let i = 0; i < state.videoClips.length; i++) {
            const clip = state.videoClips[i];
            const ext = (clip.file && clip.file.name) ? clip.file.name.split('.').pop() : 'mp4';
            const nativePath = await writeTempBlob(`vid${i}.${ext}`, clip.file || null, clip.objectUrl);

            updateExportProgress(Math.round(((i + 1) / state.videoClips.length) * 15));

            if (clip.isImage) {
                const imgDur = getClipDuration(clip);
                inputArgs.push('-loop', '1', '-framerate', '25', '-t', imgDur.toFixed(3), '-i', `"${nativePath}"`);
                hasAudioArray.push(false);
            } else {
                let hasAudio = false;
                // Fast native probe via MediaExtractor (1ms without spawning FFmpeg)
                if (FFmpegNative && FFmpegNative.probeMedia) {
                    try {
                        const probeRes = await FFmpegNative.probeMedia({ filePath: nativePath });
                        if (probeRes && probeRes.hasAudio) hasAudio = true;
                    } catch (_) {}
                }
                if (!hasAudio && clip.hasAudio !== undefined) {
                    hasAudio = clip.hasAudio;
                }
                hasAudioArray.push(hasAudio);
                inputArgs.push('-i', `"${nativePath}"`);
            }
        }

        // Silence generator for clips without audio
        const needsSilence = hasAudioArray.some(h => !h);
        const silenceIdx = state.videoClips.length;
        if (needsSilence) {
            inputArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
        }

        updateExportProgress(20);
        if (window.showToast) window.showToast('Building filters...', false);

        // ─── 2. Build filter graph ───
        for (let i = 0; i < state.videoClips.length; i++) {
            const clip = state.videoClips[i];
            const speed = getClipSpeed(clip);
            videoCount++;

            if (clip.isImage) {
                const imgDur = getClipDuration(clip);
                const totalFrames = Math.round(imgDur * 25);
                let kbFilter = '';
                const kb = clip.kenBurns || 'none';
                if (kb === 'zoom-in') {
                    kbFilter = `zoompan=z='min(zoom+${(0.3 / totalFrames).toFixed(6)}\\,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outW}x${outH}:fps=25,`;
                } else if (kb === 'zoom-out') {
                    kbFilter = `zoompan=z='if(eq(on\\,0)\\,1.3\\,max(zoom-${(0.3 / totalFrames).toFixed(6)}\\,1))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outW}x${outH}:fps=25,`;
                } else if (kb === 'pan-left') {
                    kbFilter = `zoompan=z='1.2':x='iw/1.2-iw/1.2*on/${totalFrames}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outW}x${outH}:fps=25,`;
                } else if (kb === 'pan-right') {
                    kbFilter = `zoompan=z='1.2':x='iw/1.2*on/${totalFrames}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outW}x${outH}:fps=25,`;
                }

                const transformFilter = buildTransformFilter(clip);
                const colorFilter = buildColorFilter(clip);

                let cropFilter = '';
                if (clip.crop && (clip.crop.top > 0 || clip.crop.bottom > 0 || clip.crop.left > 0 || clip.crop.right > 0)) {
                    const c = clip.crop;
                    cropFilter = `crop=iw*(1-(${c.left}+${c.right})/100):ih*(1-(${c.top}+${c.bottom})/100):iw*${c.left}/100:ih*${c.top}/100,`;
                }

                if (kbFilter) {
                    filterParts.push(`[${i}:v]${cropFilter}${transformFilter}${kbFilter}${colorFilter}setsar=1[v${i}]`);
                } else {
                    filterParts.push(`[${i}:v]${cropFilter}${transformFilter}${colorFilter}scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},setsar=1[v${i}]`);
                }

                const clipVol = clip.muted ? 0 : perceptualVolume(clip.volume !== undefined ? clip.volume : 1);
                filterParts.push(`[${silenceIdx}:a]atrim=duration=${imgDur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${clipVol}[a${i}]`);
            } else {
                // --- VIDEO CLIP ---
                let trimFilter = '';
                if (clip.startTrim > 0 || clip.endTrim > 0) {
                    const startPts = clip.startTrim || 0;
                    const endPts = clip.duration - (clip.endTrim || 0);
                    trimFilter = `trim=start=${startPts}:end=${endPts},setpts=PTS-STARTPTS,`;
                }
                if (speed !== 1) {
                    trimFilter += `setpts=PTS/${speed},`;
                }
                const reverseFilter = clip.isReversed ? 'reverse,' : '';

                let atrimFilter = '';
                if (clip.startTrim > 0 || clip.endTrim > 0) {
                    const startPts = clip.startTrim || 0;
                    const endPts = clip.duration - (clip.endTrim || 0);
                    atrimFilter = `atrim=start=${startPts}:end=${endPts},asetpts=PTS-STARTPTS,`;
                }
                if (speed !== 1) {
                    atrimFilter += buildAtempoChain(speed) + ',';
                }
                const areverseFilter = clip.isReversed ? 'areverse,' : '';

                const transformFilter = buildTransformFilter(clip);
                const colorFilter = buildColorFilter(clip);

                let cropFilter = '';
                if (clip.crop && (clip.crop.top > 0 || clip.crop.bottom > 0 || clip.crop.left > 0 || clip.crop.right > 0)) {
                    const c = clip.crop;
                    cropFilter = `crop=iw*(1-(${c.left}+${c.right})/100):ih*(1-(${c.top}+${c.bottom})/100):iw*${c.left}/100:ih*${c.top}/100,`;
                }

                filterParts.push(`[${i}:v]${trimFilter}${reverseFilter}${cropFilter}${transformFilter}${colorFilter}scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},setsar=1[v${i}]`);

                const clipVol = clip.muted ? 0 : perceptualVolume(clip.volume !== undefined ? clip.volume : 1);

                let clipFadeFilter = '';
                const clipFadeIn = clip.fadeIn || 0;
                const clipFadeOut = clip.fadeOut || 0;
                if (clipFadeIn > 0) {
                    clipFadeFilter += `afade=t=in:st=0:d=${clipFadeIn},`;
                }
                if (clipFadeOut > 0) {
                    const clipTimelineDur = getClipDuration(clip);
                    const fadeOutStart = Math.max(0, clipTimelineDur - clipFadeOut).toFixed(3);
                    clipFadeFilter += `afade=t=out:st=${fadeOutStart}:d=${clipFadeOut},`;
                }

                if (hasAudioArray[i]) {
                    filterParts.push(`[${i}:a]${atrimFilter}${areverseFilter}${clipFadeFilter}volume=${clipVol}[a${i}]`);
                } else {
                    const videoDur = getClipDuration(clip);
                    filterParts.push(`[${silenceIdx}:a]atrim=duration=${videoDur.toFixed(3)},asetpts=PTS-STARTPTS,${clipFadeFilter}volume=${clipVol}[a${i}]`);
                }
            }
        }

        // ─── Concat or Crossfade ───
        let currentVideoLabel = '';
        let currentAudioLabel = '';

        if (videoCount === 1) {
            currentVideoLabel = '[v0]';
            currentAudioLabel = '[a0]';
        } else {
            const hasAnyTransition = state.videoClips.some((c, idx) => idx < state.videoClips.length - 1 && c.transition && c.transition.type !== 'none');

            if (hasAnyTransition) {
                let accDuration = getClipDuration(state.videoClips[0]);
                currentVideoLabel = '[v0]';
                currentAudioLabel = '[a0]';

                for (let i = 1; i < videoCount; i++) {
                    const prevClip = state.videoClips[i - 1];
                    const trans = prevClip.transition;
                    const transType = trans ? trans.type : 'none';
                    const transDur = trans ? (trans.duration || 0.5) : 0.5;

                    if (transType !== 'none') {
                        const xfadeType = TRANSITION_XFADE_MAP[transType] || 'fade';
                        const offset = Math.max(0, accDuration - transDur);
                        const vOut = `[xv${i}]`;
                        const aOut = `[xa${i}]`;
                        filterParts.push(`${currentVideoLabel}[v${i}]xfade=transition=${xfadeType}:duration=${transDur.toFixed(3)}:offset=${offset.toFixed(3)}${vOut}`);
                        filterParts.push(`${currentAudioLabel}[a${i}]acrossfade=d=${transDur.toFixed(3)}:c1=tri:c2=tri${aOut}`);
                        currentVideoLabel = vOut;
                        currentAudioLabel = aOut;
                        accDuration += getClipDuration(state.videoClips[i]) - transDur;
                    } else {
                        const vOut = `[xv${i}]`;
                        const aOut = `[xa${i}]`;
                        filterParts.push(`${currentVideoLabel}${currentAudioLabel}[v${i}][a${i}]concat=n=2:v=1:a=1${vOut}${aOut}`);
                        currentVideoLabel = vOut;
                        currentAudioLabel = aOut;
                        accDuration += getClipDuration(state.videoClips[i]);
                    }
                }
            } else {
                let concatParts = '';
                for (let i = 0; i < videoCount; i++) {
                    concatParts += `[v${i}][a${i}]`;
                }
                filterParts.push(`${concatParts}concat=n=${videoCount}:v=1:a=1[outv][outa]`);
                currentVideoLabel = '[outv]';
                currentAudioLabel = '[outa]';
            }
        }

        // ─── Audio tracks ───
        let audioInputIdx = state.videoClips.length + (needsSilence ? 1 : 0);

        for (let a = 0; a < state.audioTracks.length; a++) {
            const audio = state.audioTracks[a];
            if (!audio.file && !audio.objectUrl) continue;

            const audioBlob = audio.file || null;
            const aExt = (audioBlob && audioBlob.name) ? audioBlob.name.split('.').pop() : ((audio.name && audio.name.includes('.')) ? audio.name.split('.').pop() : 'mp3');
            const aPath = await writeTempBlob(`aud${a}.${aExt}`, audioBlob, audio.objectUrl);
            inputArgs.push('-i', `"${aPath}"`);

            let audioFilter = `[${audioInputIdx}:a]`;
            if (audio.startTrim > 0 || audio.endTrim > 0) {
                const aStart = audio.startTrim || 0;
                const aEnd = audio.duration - (audio.endTrim || 0);
                audioFilter += `atrim=start=${aStart}:end=${aEnd},asetpts=PTS-STARTPTS,`;
            }
            const audioSpeed = getClipSpeed(audio);
            if (audioSpeed !== 1) {
                audioFilter += buildAtempoChain(audioSpeed) + ',';
            }

            const audioFadeIn = audio.fadeIn || 0;
            const audioFadeOut = audio.fadeOut || 0;
            if (audioFadeIn > 0) {
                audioFilter += `afade=t=in:st=0:d=${audioFadeIn},`;
            }
            if (audioFadeOut > 0) {
                const audioTimelineDur = getClipDuration(audio);
                const fadeOutStart = Math.max(0, audioTimelineDur - audioFadeOut).toFixed(3);
                audioFilter += `afade=t=out:st=${fadeOutStart}:d=${audioFadeOut},`;
            }

            const audioVol = audio.muted ? 0 : perceptualVolume(audio.volume !== undefined ? audio.volume : 1);
            audioFilter += `volume=${audioVol}`;

            if (audio.offset > 0) {
                const delayMs = Math.round(audio.offset * 1000);
                audioFilter += `,adelay=${delayMs}|${delayMs}`;
            }

            filterParts.push(`${audioFilter}[audout${a}]`);
            audioInputIdx++;
        }

        // Mix all audio streams
        if (state.audioTracks.length > 0) {
            let mixInputs = currentAudioLabel;
            let activeAudios = 1;
            for (let a = 0; a < state.audioTracks.length; a++) {
                if (state.audioTracks[a].file || state.audioTracks[a].objectUrl) {
                    mixInputs += `[audout${a}]`;
                    activeAudios++;
                }
            }
            if (activeAudios > 1) {
                filterParts.push(`${mixInputs}amix=inputs=${activeAudios}:duration=longest:dropout_transition=2[mixeda]`);
                currentAudioLabel = '[mixeda]';
            }
        }

        // ─── Text + Subtitle Overlays (High-Speed Segmented Composite Canvas PNGs) ───
        {
            const allTextOverlays = [
                ...(state.textOverlays || []).map(t => ({ ...t, _type: 'text' })),
                ...(state.subtitleTracks || []).map(s => ({ ...s, _type: 'sub' }))
            ];

            if (allTextOverlays.length > 0) {
                const totalVidDur = state.videoClips.reduce((acc, c) => acc + getClipDuration(c), 0);

                const boundaries = new Set([0, totalVidDur]);
                allTextOverlays.forEach(o => {
                    boundaries.add(Math.max(0, Math.min(totalVidDur, o.startTime || 0)));
                    boundaries.add(Math.max(0, Math.min(totalVidDur, o.endTime || (o.startTime || 0) + 3)));
                });
                const sortedBounds = [...boundaries].sort((a, b) => a - b);

                const segments = [];
                for (let i = 0; i < sortedBounds.length - 1; i++) {
                    const segStart = sortedBounds[i];
                    const segEnd = sortedBounds[i + 1];
                    if (segEnd - segStart < 0.04) continue;
                    const segMid = (segStart + segEnd) / 2;
                    const visible = allTextOverlays.filter(o => segMid >= (o.startTime || 0) && segMid <= (o.endTime || 0));
                    if (visible.length > 0) {
                        segments.push({ start: segStart, end: segEnd, overlays: visible });
                    }
                }

                const uniqueComposites = [];
                const seen = new Map();
                for (const seg of segments) {
                    const key = seg.overlays.map(o => o.id || o.text).sort().join('|');
                    if (seen.has(key)) {
                        seen.get(key).ranges.push({ start: seg.start, end: seg.end });
                    } else {
                        const entry = { overlays: seg.overlays, ranges: [{ start: seg.start, end: seg.end }] };
                        seen.set(key, entry);
                        uniqueComposites.push(entry);
                    }
                }

                for (let ci = 0; ci < uniqueComposites.length; ci++) {
                    const comp = uniqueComposites[ci];
                    const compositeBlob = await renderCompositeOverlayToBlob(comp.overlays, outW, outH);
                    if (!compositeBlob || compositeBlob.size === 0) {
                        console.warn(`[CupCat Native] Composite ${ci} blob is empty, skipping.`);
                        continue;
                    }

                    const compPath = await writeTempBlob(`comp${ci}.png`, compositeBlob);
                    if (!compPath) continue;

                    // Calculate precise time span for this overlay
                    const firstStart = comp.ranges[0].start;
                    const lastEnd = comp.ranges[comp.ranges.length - 1].end;
                    const compActiveDur = Math.max(0.1, lastEnd - firstStart);

                    inputArgs.push('-loop', '1', '-framerate', '25', '-t', compActiveDur.toFixed(3), '-i', `"${compPath}"`);

                    const scaledLabel = `[compscaled${ci}]`;
                    filterParts.push(`[${audioInputIdx}:v]format=rgba,setpts=PTS-STARTPTS+${firstStart.toFixed(3)}/TB${scaledLabel}`);

                    const enableParts = comp.ranges.map(r => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`);
                    const enableExpr = enableParts.join('+');

                    const outLabel = `[compout${ci}]`;
                    filterParts.push(
                        `${currentVideoLabel}${scaledLabel}overlay=x=0:y=0:enable='${enableExpr}':eof_action=pass${outLabel}`
                    );
                    currentVideoLabel = outLabel;
                    audioInputIdx++;
                }
            }
        }

        // ─── Overlay (PiP & Stickers) tracks (Optimized Bounding Box + PTS Sync) ───
        if (state.overlayTracks && state.overlayTracks.length > 0) {
            const totalVidDur = state.videoClips.reduce((acc, c) => acc + getClipDuration(c), 0);
            let overlayInputIdx = audioInputIdx;

            for (let oi = 0; oi < state.overlayTracks.length; oi++) {
                const ovl = state.overlayTracks[oi];
                if (!ovl.file && !ovl.objectUrl && !ovl.emoji) continue;

                let oExt = ovl.isImage || ovl.isSticker ? 'png' : 'mp4';
                let oPath;
                if (ovl.file) {
                    oExt = ovl.file.name ? ovl.file.name.split('.').pop() : (ovl.isImage ? 'png' : 'mp4');
                    oPath = await writeTempBlob(`ovl${oi}.${oExt}`, ovl.file, ovl.objectUrl);
                } else if (ovl.isSticker && ovl.emoji) {
                    const dataUrl = ovl.objectUrl || createEmojiDataUrl(ovl.emoji);
                    oPath = await writeTempBlob(`ovl${oi}.png`, null, dataUrl);
                } else if (ovl.objectUrl) {
                    oPath = await writeTempBlob(`ovl${oi}.${oExt}`, null, ovl.objectUrl);
                }
                if (!oPath) continue;

                const ovlStart = Math.max(0, ovl.startTime || 0);
                const ovlEnd = Math.max(ovlStart + 0.1, ovl.endTime || (ovlStart + 5));
                const ovlDur = ovlEnd - ovlStart;

                let rawScaleW = Math.round(outW * (ovl.scale || 30) / 100);
                if (rawScaleW < 16) rawScaleW = 16;
                const ovlScaleW = rawScaleW % 2 === 0 ? rawScaleW : rawScaleW + 1;

                let ovlX = `(main_w*${(ovl.posX !== undefined ? ovl.posX : 50) / 100}-overlay_w/2)`;
                let ovlY = `(main_h*${(ovl.posY !== undefined ? ovl.posY : 50) / 100}-overlay_h/2)`;

                if (ovl.keyframes && ovl.keyframes.length > 0) {
                    ovlX = buildFFmpegKeyframeCoordExpr(ovl.keyframes, 'x', ovl.posX !== undefined ? ovl.posX : 50, false, 'main_w', 'overlay_w');
                    ovlY = buildFFmpegKeyframeCoordExpr(ovl.keyframes, 'y', ovl.posY !== undefined ? ovl.posY : 50, false, 'main_h', 'overlay_h');
                }

                const ovlOpacity = (ovl.opacity !== undefined ? ovl.opacity : 100) / 100;
                let opacityFilter = ovlOpacity < 1 ? `,colorchannelmixer=aa=${ovlOpacity.toFixed(2)}` : '';

                if (ovl.isImage) {
                    // Sticker / image overlay
                    inputArgs.push('-loop', '1', '-framerate', '25', '-t', totalVidDur.toFixed(3), '-i', `"${oPath}"`);
                    const scaledLabel = `[stkscaled${oi}]`;
                    filterParts.push(`[${overlayInputIdx}:v]format=rgba,scale=${ovlScaleW}:-2${opacityFilter}${scaledLabel}`);

                    const ovlOutLabel = `[stkout${oi}]`;
                    filterParts.push(
                        `${currentVideoLabel}${scaledLabel}overlay=x='${ovlX}':y='${ovlY}':enable='between(t,${ovlStart.toFixed(3)},${ovlEnd.toFixed(3)})':eof_action=pass${ovlOutLabel}`
                    );
                    currentVideoLabel = ovlOutLabel;
                    overlayInputIdx++;
                } else {
                    // PiP Video overlay — pre-trimmed and synchronized
                    inputArgs.push('-i', `"${oPath}"`);
                    const scaledLabel = `[pipscaled${oi}]`;
                    filterParts.push(`[${overlayInputIdx}:v]trim=duration=${ovlDur.toFixed(3)},setpts=PTS-STARTPTS+${ovlStart.toFixed(3)}/TB,scale=${ovlScaleW}:-2${opacityFilter}${scaledLabel}`);

                    const ovlOutLabel = `[pipout${oi}]`;
                    filterParts.push(
                        `${currentVideoLabel}${scaledLabel}overlay=x='${ovlX}':y='${ovlY}':enable='between(t,${ovlStart.toFixed(3)},${ovlEnd.toFixed(3)})':eof_action=pass${ovlOutLabel}`
                    );
                    currentVideoLabel = ovlOutLabel;
                    overlayInputIdx++;
                }
            }
        }

        updateExportProgress(25);

        // ─── 3. Assemble & run native FFmpeg command ───
        const filterComplex = filterParts.join('; ');
        const crfVal = (EXPORT_QUALITY_CRF[state.exportSettings.quality] ? EXPORT_QUALITY_CRF[state.exportSettings.quality].crf : 23).toString();

        // Ensure temp output dir exists
        try { await Filesystem.mkdir({ path: tempDir, directory: Directory.CACHE, recursive: true }); } catch (_) {}
        try {
            await Filesystem.writeFile({ path: tempDir + '/output.mp4', data: '', directory: Directory.CACHE, recursive: true });
        } catch (_) {}
        const outputPath = await getNativePath(tempDir + '/output.mp4');

        let encoderArgs = [];
        if (videoEncoder === 'h264_mediacodec') {
            const bitrateStr = (EXPORT_QUALITY_CRF[state.exportSettings.quality] ? 
                               (EXPORT_QUALITY_CRF[state.exportSettings.quality].crf <= 20 ? '8M' : '4M') : '5M');
            encoderArgs = [
                '-c:v', 'h264_mediacodec',
                '-b:v', bitrateStr,
                '-pix_fmt', 'yuv420p'
            ];
        } else if (videoEncoder === 'libopenh264') {
            encoderArgs = [
                '-c:v', 'libopenh264',
                '-b:v', '4M',
                '-pix_fmt', 'yuv420p'
            ];
        } else if (videoEncoder === 'libx264') {
            encoderArgs = [
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', crfVal,
                '-pix_fmt', 'yuv420p',
                '-threads', '0'
            ];
        } else {
            encoderArgs = [
                '-c:v', 'mpeg4',
                '-q:v', '2',
                '-pix_fmt', 'yuv420p',
                '-threads', '0'
            ];
        }

        // Native ffmpeg-kit takes a single command string (not array)
        // We MUST quote filterComplex because it contains spaces!
        const ffmpegCmd = [
            ...inputArgs,
            '-filter_complex', `"${filterComplex}"`,
            '-map', currentVideoLabel,
            '-map', currentAudioLabel,
            ...encoderArgs,
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y', `"${outputPath}"`
        ].join(' ');

        console.log('[CupCat Native] FFmpeg command:', ffmpegCmd);
        updateExportProgress(30);
        if (window.showToast) window.showToast('Encoding video (native)...', false);

        // Listen for progress from native Java FFmpegKit statistics callback
        const totalDurationMs = state.videoClips.reduce((acc, c) => acc + getClipDuration(c) * 1000, 0);
        let progressListener = null;
        try {
            if (FFmpegNative.addListener) {
                progressListener = await FFmpegNative.addListener('ffmpegProgress', (info) => {
                    const ms = info.time || 0;
                    if (totalDurationMs > 0 && ms > 0) {
                        const pct = Math.min(100, Math.round((ms / totalDurationMs) * 100));
                        const scaled = Math.round(30 + (pct * 0.55));
                        updateExportProgress(scaled);
                    }
                });
            }
        } catch (listenerErr) {
            console.warn('[CupCat Native] addListener failed (non-fatal):', listenerErr && listenerErr.message);
            progressListener = null;
        }

        const result = await FFmpegNative.execute({ command: ffmpegCmd });

        if (progressListener) {
            try { progressListener.remove(); } catch (_) {}
        }

        if (!result.success) {
            console.error('[CupCat Native] FFmpeg logs:', result.logs);
            throw new Error('FFmpeg failed: ' + (result.message || result.logs?.substring(result.logs.length - 300) || 'unknown'));
        }

        console.log('[CupCat Native] Encoding complete');
        updateExportProgress(85);

        // ─── 4. Save to Gallery (Movies/CupCat) via MediaStore ───
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const savedFileName = `${state.docTitle || 'CupCat'}_${ts}.mp4`;

        // Use the native output path DIRECTLY for gallery save.
        // Previous approach (Filesystem.copy to cache then save) was fragile
        // because Capacitor's Filesystem.copy sometimes fails to see files
        // written directly by FFmpegKit's native code.
        const directOutputPath = outputPath; // Already a native filesystem path
        console.log('[CupCat Native] Output path for gallery save:', directOutputPath);

        let gallerySaveOk = false;

        // Primary: saveToGallery via FFmpegPlugin (MediaStore API)
        try {
            console.log('[CupCat Native] Calling saveToGallery:', directOutputPath, savedFileName);
            const gr = await FFmpegNative.saveToGallery({ filePath: directOutputPath, fileName: savedFileName });
            if (gr && gr.success) {
                gallerySaveOk = true;
                console.log('[CupCat Native] Gallery save SUCCESS:', gr.uri);
            } else {
                console.error('[CupCat Native] Gallery save returned without success:', JSON.stringify(gr));
            }
        } catch (ge) {
            console.error('[CupCat Native] Gallery save FAILED:', ge && ge.message ? ge.message : ge);
        }

        // Fallback 1: Copy output to Documents/CupCat/ via Filesystem
        if (!gallerySaveOk) {
            try {
                console.log('[CupCat Native] Trying fallback: copy to Documents/CupCat/');
                const outputRelPath = tempDir + '/output.mp4';
                const docPath = 'CupCat/' + savedFileName;
                await Filesystem.copy({
                    from: outputRelPath,
                    directory: Directory.CACHE,
                    to: docPath,
                    toDirectory: Directory.DOCUMENTS
                });
                gallerySaveOk = true;
                console.log('[CupCat Native] Documents fallback save succeeded:', docPath);
                if (window.showToast) window.showToast(`✅ Video saved to Documents/CupCat/`, false);
            } catch (docErr) {
                console.error('[CupCat Native] Documents fallback failed:', docErr && docErr.message);
            }
        }

        // Fallback 2: Copy to EXTERNAL_STORAGE
        if (!gallerySaveOk) {
            try {
                console.log('[CupCat Native] Trying final fallback: EXTERNAL_STORAGE');
                const outputRelPath = tempDir + '/output.mp4';
                const extPath = 'CupCat/' + savedFileName;
                await Filesystem.copy({
                    from: outputRelPath,
                    directory: Directory.CACHE,
                    to: extPath,
                    toDirectory: Directory.EXTERNAL_STORAGE
                });
                gallerySaveOk = true;
                console.log('[CupCat Native] External storage save succeeded:', extPath);
                if (window.showToast) window.showToast(`✅ Video saved to phone storage (CupCat/)`, false);
            } catch (extErr) {
                console.error('[CupCat Native] External storage fallback failed:', extErr && extErr.message);
            }
        }

        updateExportProgress(100);
        if (gallerySaveOk) {
            setLastExportPath(directOutputPath);
            if (window.showToast) window.showToast(`✅ Video saved to Gallery (Movies/CupCat)`, false);
            // Push notification (visible even when app is minimized)
            try { FFmpegNative.showNotification({ title: '✅ CupCat', message: 'Video exported successfully!' }); } catch (_) {}
        } else {
            if (window.showToast) window.showToast(`❌ Failed to save video to gallery. Check app permissions in settings.`, true);
        }

        // Set preview — use a blob URL for preview since gallery files can't be accessed directly

    } catch (e) {
        console.error('[CupCat Native Export Error]', e);
        const errMsg = e && e.message ? e.message : '';
        // If the native FFmpeg plugin isn't available, fall back to WebCodecs
        if (errMsg.includes('unable to find plugin')) {
            console.warn('[CupCat Native] Plugin not found during export — falling back to WebCodecs');
            if (window.showToast) window.showToast('⚠️ Native plugin unavailable — retrying with WebCodecs...', true);
            state.isExporting = false;
            if (overlay) overlay.style.display = 'none';
            return exportVideoWebCodecs();
        }
        if (window.showToast) window.showToast('Export failed: ' + (e.message || 'unknown error'), true);
    } finally {
        state.isExporting = false;
        if (overlay) overlay.style.display = 'none';
        // Delay temp dir cleanup too
        setTimeout(async () => {
            try { await Filesystem.rmdir({ path: tempDir, directory: Directory.CACHE, recursive: true }); } catch (_) {}
        }, 3000);
    }
}


export async function exportVideoWebCodecs() {
    // WebCodecs can work WITHOUT FFmpeg — it exports video-only in that case.
    // When FFmpeg IS loaded, it multiplexes audio into the final file.
    const hasFFmpeg = state.ffmpegLoaded;
    
    if (!hasFFmpeg) {
        console.warn('[CupCat] FFmpeg not available — exporting video without audio');
        if (window.showToast) window.showToast('Exporting video (without audio — engine still loading)...', false);
    }
    if (state.videoClips.length === 0) {
        if (window.showToast) window.showToast('Add at least one media clip.', true);
        return;
    }

    const missing = state.videoClips.find(c => !c.file);
    if (missing) {
        if (window.showToast) window.showToast('Some clips are missing files (from page reload). Delete and re-add them.', true);
        return;
    }

    state._exportCancelled = false;
    state.isExporting = true;
    const overlay = document.getElementById('cupcat-export-overlay');
    if (overlay) overlay.style.display = 'flex';
    updateExportProgress(0);
    
    // Save previous state to restore later
    const originalPlayhead = state.playheadTime;

    let encoder = null;
    try {
        const exportDims = getExportDimensions(state.canvasAspect, state.exportSettings.resolution);
        
        // 1. Setup Canvas
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = exportDims.w;
        exportCanvas.height = exportDims.h;
        const exportCtx = exportCanvas.getContext('2d', { willReadFrequently: true });
        
        // 2. Setup Muxer
        const muxer = new Muxer({
            target: new ArrayBufferTarget(),
            video: {
                codec: 'avc',
                width: exportDims.w,
                height: exportDims.h
            },
            fastStart: 'in-memory',
        });
        
        // 3. Setup VideoEncoder
        let errorObj = null;
        encoder = new window.VideoEncoder({
            output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
            error: (e) => {
                console.error('[WebCodecs Encoder Error]', e);
                errorObj = e;
            }
        });
        
        let bitrate = 5_000_000;
        if (state.exportSettings.quality === 'high') bitrate = 10_000_000;
        else if (state.exportSettings.quality === 'draft') bitrate = 2_500_000;

        // avc1.640028 = H.264 High Profile, Level 4.0 — supports up to 1080p@30fps
        let codecStr = 'avc1.640028';
        const configParams = {
            codec: codecStr,
            width: exportDims.w,
            height: exportDims.h,
            bitrate: bitrate,
            framerate: 30
        };

        try {
            const support = await window.VideoEncoder.isConfigSupported(configParams);
            if (!support.supported) {
                console.warn('[CupCat] High Profile not supported, falling back to Baseline');
                configParams.codec = 'avc1.42E01E'; // Baseline profile
            }
        } catch (e) {
            console.warn('[CupCat] isConfigSupported check failed, using High Profile as default', e);
        }

        encoder.configure(configParams);
        
        // 4. Virtual Render Loop
        const totalDur = getTotalDuration();
        const fps = 30;
        const step = 1 / fps;
        const totalFrames = Math.ceil(totalDur * fps);
        
        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
            if (errorObj) throw errorObj;
            
            const t = frameIndex * step;
            
            // Sync all DOM elements to precise time and AWAIT them
            await updatePreviewAtTime(t, true);
            
            // Draw to our high-res offscreen canvas
            await renderScene(t, exportCanvas, exportCtx);
            
            // Capture and encode
            const frame = new window.VideoFrame(exportCanvas, {
                timestamp: Math.round(frameIndex * (1_000_000 / fps))
            });
            
            // Force keyframe every 2 seconds
            const isKeyframe = frameIndex % (fps * 2) === 0;
            encoder.encode(frame, { keyFrame: isKeyframe });
            frame.close();
            
            if (encoder.encodeQueueSize > 10) {
                await new Promise(r => setTimeout(r, 10));
            }
            
            updateExportProgress(Math.round((frameIndex / totalFrames) * 50));
        }
        
        await encoder.flush();
        encoder.close();
        muxer.finalize();
        
        const videoBuffer = muxer.target.buffer;
        
        if (hasFFmpeg) {
            // 5. Multiplex Audio using FFmpeg
            updateExportProgress(50);
            console.log('[CupCat] Video encoded. Multiplexing audio via FFmpeg...');
            
            await state.ffmpeg.writeFile('video_only.mp4', new Uint8Array(videoBuffer));
            
            let inputArgs = ['-i', 'video_only.mp4'];
            let filterParts = [];
            
            let audioInputIdx = 1;
            let hasAudioArray = [];
            
            for (let i = 0; i < state.videoClips.length; i++) {
                const clip = state.videoClips[i];
                const ext = (clip.file && clip.file.name) ? clip.file.name.split('.').pop() : 'mp4';
                const filename = `vid_a${i}.${ext}`;
                await state.ffmpeg.writeFile(filename, await fetchFile(clip.file));
                
                if (clip.isImage) {
                    hasAudioArray.push(false);
                } else {
                    let hasAudio = false;
                    const logHandler = ({ message }) => {
                        if (message.toLowerCase().includes('audio:')) hasAudio = true;
                    };
                    state.ffmpeg.on('log', logHandler);
                    try { await state.ffmpeg.exec(['-i', filename]); } catch (e) {}
                    state.ffmpeg.off('log', logHandler);
                    hasAudioArray.push(hasAudio);
                    
                    inputArgs.push('-i', filename);
                    audioInputIdx++;
                }
            }
            
            const needsSilence = hasAudioArray.some(has => !has);
            const silenceIdx = audioInputIdx;
            if (needsSilence) {
                inputArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
                audioInputIdx++;
            }
            
            let currentAudioLabel = '';
            let clipAudioOuts = [];
            let fileIdx = 1;
            
            for (let i = 0; i < state.videoClips.length; i++) {
                const clip = state.videoClips[i];
                const speed = getClipSpeed(clip);
                const clipVol = clip.muted ? 0 : perceptualVolume(clip.volume !== undefined ? clip.volume : 1);
                
                let clipFadeFilter = '';
                const clipFadeIn = clip.fadeIn || 0;
                const clipFadeOut = clip.fadeOut || 0;
                if (clipFadeIn > 0) clipFadeFilter += `afade=t=in:st=0:d=${clipFadeIn},`;
                if (clipFadeOut > 0) {
                    const clipTimelineDur = getClipDuration(clip);
                    const fadeOutStart = Math.max(0, clipTimelineDur - clipFadeOut).toFixed(3);
                    clipFadeFilter += `afade=t=out:st=${fadeOutStart}:d=${clipFadeOut},`;
                }
                
                if (clip.isImage) {
                    const imgDur = getClipDuration(clip);
                    filterParts.push(`[${silenceIdx}:a]atrim=duration=${imgDur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${clipVol}[a${i}]`);
                } else {
                    let atrimFilter = '';
                    if (clip.startTrim > 0 || clip.endTrim > 0) {
                        const startPts = clip.startTrim || 0;
                        const endPts = clip.duration - (clip.endTrim || 0);
                        atrimFilter = `atrim=start=${startPts}:end=${endPts},asetpts=PTS-STARTPTS,`;
                    }
                    if (speed !== 1) atrimFilter += buildAtempoChain(speed) + ',';
                    
                    if (hasAudioArray[i]) {
                        filterParts.push(`[${fileIdx}:a]${atrimFilter}${clipFadeFilter}volume=${clipVol}[a${i}]`);
                        fileIdx++;
                    } else {
                        const videoDur = getClipDuration(clip);
                        filterParts.push(`[${silenceIdx}:a]atrim=duration=${videoDur.toFixed(3)},asetpts=PTS-STARTPTS,${clipFadeFilter}volume=${clipVol}[a${i}]`);
                        fileIdx++;
                    }
                }
                clipAudioOuts.push(`[a${i}]`);
            }
            
            const hasAnyTransition = state.videoClips.some((c, idx) => idx < state.videoClips.length - 1 && c.transition && c.transition.type !== 'none');
            if (hasAnyTransition) {
                let accDuration = getClipDuration(state.videoClips[0]);
                currentAudioLabel = '[a0]';
                for (let i = 1; i < state.videoClips.length; i++) {
                    const prevClip = state.videoClips[i - 1];
                    const trans = prevClip.transition;
                    const transType = trans ? trans.type : 'none';
                    const transDur = trans ? (trans.duration || 0.5) : 0.5;
                    if (transType !== 'none') {
                        const aOut = `[xa${i}]`;
                        filterParts.push(`${currentAudioLabel}[a${i}]acrossfade=d=${transDur.toFixed(3)}:c1=tri:c2=tri${aOut}`);
                        currentAudioLabel = aOut;
                        accDuration += getClipDuration(state.videoClips[i]) - transDur;
                    } else {
                        const aOut = `[xa${i}]`;
                        filterParts.push(`${currentAudioLabel}[a${i}]concat=n=2:v=0:a=1${aOut}`);
                        currentAudioLabel = aOut;
                        accDuration += getClipDuration(state.videoClips[i]);
                    }
                }
            } else {
                let concatParts = '';
                for (let i = 0; i < state.videoClips.length; i++) concatParts += `[a${i}]`;
                filterParts.push(`${concatParts}concat=n=${state.videoClips.length}:v=0:a=1[outa]`);
                currentAudioLabel = '[outa]';
            }
            
            for (let a = 0; a < state.audioTracks.length; a++) {
                const audio = state.audioTracks[a];
                if (!audio.file) continue;
                const aExt = (audio.file && audio.file.name) ? audio.file.name.split('.').pop() : ((audio.name && audio.name.includes('.')) ? audio.name.split('.').pop() : 'mp3');
                const aFilename = `aud_a${a}.${aExt}`;
                await state.ffmpeg.writeFile(aFilename, await fetchFile(audio.file));
                inputArgs.push('-i', aFilename);
                
                let audioFilter = `[${audioInputIdx}:a]`;
                if (audio.startTrim > 0 || audio.endTrim > 0) {
                    const aStart = audio.startTrim || 0;
                    const aEnd = audio.duration - (audio.endTrim || 0);
                    audioFilter += `atrim=start=${aStart}:end=${aEnd},asetpts=PTS-STARTPTS,`;
                }
                const audioSpeed = getClipSpeed(audio);
                if (audioSpeed !== 1) audioFilter += buildAtempoChain(audioSpeed) + ',';
                
                const audioFadeIn = audio.fadeIn || 0;
                const audioFadeOut = audio.fadeOut || 0;
                if (audioFadeIn > 0) audioFilter += `afade=t=in:st=0:d=${audioFadeIn},`;
                if (audioFadeOut > 0) {
                    const audioTimelineDur = getClipDuration(audio);
                    const fadeOutStart = Math.max(0, audioTimelineDur - audioFadeOut).toFixed(3);
                    audioFilter += `afade=t=out:st=${fadeOutStart}:d=${audioFadeOut},`;
                }
                
                const audioVol = audio.muted ? 0 : perceptualVolume(audio.volume !== undefined ? audio.volume : 1);
                audioFilter += `volume=${audioVol}`;
                
                if (audio.offset > 0) {
                    const delayMs = Math.round(audio.offset * 1000);
                    audioFilter += `,adelay=${delayMs}|${delayMs}`;
                }
                
                filterParts.push(`${audioFilter}[audout${a}]`);
                audioInputIdx++;
            }
            
            if (state.audioTracks.length > 0) {
                let mixInputs = currentAudioLabel;
                let activeAudios = 1;
                for (let a = 0; a < state.audioTracks.length; a++) {
                    if (state.audioTracks[a].file) {
                        mixInputs += `[audout${a}]`;
                        activeAudios++;
                    }
                }
                if (activeAudios > 1) {
                    filterParts.push(`${mixInputs}amix=inputs=${activeAudios}:duration=longest:dropout_transition=2[mixeda]`);
                    currentAudioLabel = '[mixeda]';
                }
            }
            
            let ffmpegArgs = [
                ...inputArgs,
                '-c:v', 'copy'
            ];
            
            if (filterParts.length > 0) {
                ffmpegArgs.push('-filter_complex', filterParts.join('; '));
                ffmpegArgs.push('-map', '0:v');
                ffmpegArgs.push('-map', currentAudioLabel);
                ffmpegArgs.push('-c:a', 'aac');
                ffmpegArgs.push('-b:a', '192k');
            } else {
                ffmpegArgs.push('-c:a', 'copy');
            }
            
            ffmpegArgs.push('final_output.mp4');
            
            const progressHandler = ({ progress }) => {
                updateExportProgress(50 + Math.round(progress * 50));
            };
            state.ffmpeg.on('progress', progressHandler);
            
            await state.ffmpeg.exec(ffmpegArgs);
            state.ffmpeg.off('progress', progressHandler);
            
            const finalData = await state.ffmpeg.readFile('final_output.mp4');
            const finalBlob = new Blob([finalData.buffer], { type: 'video/mp4' });
            await loadFilesystem();
            const url = await triggerBlobDownload(finalBlob, `${state.docTitle}.mp4`);
            
            if (state.dom.previewVideo) state.dom.previewVideo.src = url;
            if (window.showToast) window.showToast('Video exported successfully!', false);
        } else {
            // No FFmpeg — export video-only directly from mp4-muxer
            updateExportProgress(90);
            console.log('[CupCat] Exporting video-only (no audio muxing — FFmpeg unavailable)');
            
            const videoBlob = new Blob([videoBuffer], { type: 'video/mp4' });
            await loadFilesystem();
            const url = await triggerBlobDownload(videoBlob, `${state.docTitle}.mp4`);
            
            if (state.dom.previewVideo) state.dom.previewVideo.src = url;
            updateExportProgress(100);
            if (window.showToast) window.showToast('Video exported (without audio)', false);
        }
        
    } catch (e) {
        console.error(e);
        if (window.showToast) window.showToast('Export failed: ' + e.message, true);
    } finally {
        // Clean up encoder if it's still open
        if (encoder && encoder.state !== 'closed') {
            try { encoder.close(); } catch (_) {}
        }
        
        await updatePreviewAtTime(originalPlayhead, true);
        
        state.isExporting = false;
        if (overlay) overlay.style.display = 'none';
    }
}

export async function exportVideoFFmpeg() {
    if (!state.ffmpegLoaded) {
        if (window.showToast) window.showToast('FFmpeg is still loading. Please wait...', false);
        return;
    }
    if (state.videoClips.length === 0) {
        if (window.showToast) window.showToast('Add at least one media clip.', true);
        return;
    }

    const missing = state.videoClips.find(c => !c.file);
    if (missing) {
        if (window.showToast) window.showToast('Some clips are missing files (from page reload). Delete and re-add them.', true);
        return;
    }

    state._exportCancelled = false;
    state.isExporting = true;
    const overlay = document.getElementById('cupcat-export-overlay');
    if (overlay) overlay.style.display = 'flex';
    updateExportProgress(0);

    try {
        const exportDims = getExportDimensions(state.canvasAspect, state.exportSettings.resolution);
        let inputArgs = [];
        let filterParts = []; 
        let videoCount = 0;

        let hasAudioArray = [];
        for (let i = 0; i < state.videoClips.length; i++) {
            const clip = state.videoClips[i];
            const ext = (clip.file && clip.file.name) ? clip.file.name.split('.').pop() : 'mp4';
            const filename = `vid${i}.${ext}`;
            await state.ffmpeg.writeFile(filename, await fetchFile(clip.file));

            if (clip.isImage) {
                const imgDur = getClipDuration(clip);
                inputArgs.push(
                    '-loop', '1',
                    '-framerate', '25',
                    '-t', imgDur.toFixed(3),
                    '-i', filename
                );
                hasAudioArray.push(false);
            } else {
                let hasAudio = false;
                const logHandler = ({ message }) => {
                    if (message.toLowerCase().includes('audio:')) hasAudio = true;
                };
                state.ffmpeg.on('log', logHandler);
                try {
                    await state.ffmpeg.exec(['-i', filename]);
                } catch (probeErr) {
                    console.warn('[CupCat] Probe exec exited non-zero for', filename, '(expected):', probeErr);
                }
                state.ffmpeg.off('log', logHandler);
                hasAudioArray.push(hasAudio);

                inputArgs.push('-i', filename);
            }
        }

        const needsSilence = hasAudioArray.some(has => !has);
        const silenceIdx = state.videoClips.length;
        if (needsSilence) {
            inputArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
        }

        const outW = exportDims.w;
        const outH = exportDims.h;

        for (let i = 0; i < state.videoClips.length; i++) {
            const clip = state.videoClips[i];
            const speed = getClipSpeed(clip);
            videoCount++;

            if (clip.isImage) {
                const imgDur = getClipDuration(clip);
                const totalFrames = Math.round(imgDur * 25);
                let kbFilter = '';
                const kb = clip.kenBurns || 'none';
                if (kb === 'zoom-in') {
                    kbFilter = `zoompan=z='min(zoom+${(0.3 / totalFrames).toFixed(6)}\\,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outW}x${outH}:fps=25,`;
                } else if (kb === 'zoom-out') {
                    kbFilter = `zoompan=z='if(eq(on\\,0)\\,1.3\\,max(zoom-${(0.3 / totalFrames).toFixed(6)}\\,1))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outW}x${outH}:fps=25,`;
                } else if (kb === 'pan-left') {
                    kbFilter = `zoompan=z='1.2':x='iw/1.2-iw/1.2*on/${totalFrames}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outW}x${outH}:fps=25,`;
                } else if (kb === 'pan-right') {
                    kbFilter = `zoompan=z='1.2':x='iw/1.2*on/${totalFrames}':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outW}x${outH}:fps=25,`;
                }

                const transformFilter = buildTransformFilter(clip);
                const colorFilter = buildColorFilter(clip);
                
                let cropFilter = '';
                if (clip.crop && (clip.crop.top > 0 || clip.crop.bottom > 0 || clip.crop.left > 0 || clip.crop.right > 0)) {
                    const c = clip.crop;
                    cropFilter = `crop=iw*(1-(${c.left}+${c.right})/100):ih*(1-(${c.top}+${c.bottom})/100):iw*${c.left}/100:ih*${c.top}/100,`;
                }
                
                if (kbFilter) {
                    filterParts.push(`[${i}:v]${cropFilter}${transformFilter}${kbFilter}${colorFilter}setsar=1[v${i}]`);
                } else {
                    filterParts.push(`[${i}:v]${cropFilter}${transformFilter}${colorFilter}scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},setsar=1[v${i}]`);
                }

                const clipVol = clip.muted ? 0 : perceptualVolume(clip.volume !== undefined ? clip.volume : 1);
                filterParts.push(`[${silenceIdx}:a]atrim=duration=${imgDur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${clipVol}[a${i}]`);
            } else {
                let trimFilter = '';
                if (clip.startTrim > 0 || clip.endTrim > 0) {
                    const startPts = clip.startTrim || 0;
                    const endPts = clip.duration - (clip.endTrim || 0);
                    trimFilter = `trim=start=${startPts}:end=${endPts},setpts=PTS-STARTPTS,`;
                }
                if (speed !== 1) {
                    trimFilter += `setpts=PTS/${speed},`;
                }

                let atrimFilter = '';
                if (clip.startTrim > 0 || clip.endTrim > 0) {
                    const startPts = clip.startTrim || 0;
                    const endPts = clip.duration - (clip.endTrim || 0);
                    atrimFilter = `atrim=start=${startPts}:end=${endPts},asetpts=PTS-STARTPTS,`;
                }
                if (speed !== 1) {
                    atrimFilter += buildAtempoChain(speed) + ',';
                }

                const transformFilter = buildTransformFilter(clip);
                const colorFilter = buildColorFilter(clip);
                
                let cropFilter = '';
                if (clip.crop && (clip.crop.top > 0 || clip.crop.bottom > 0 || clip.crop.left > 0 || clip.crop.right > 0)) {
                    const c = clip.crop;
                    cropFilter = `crop=iw*(1-(${c.left}+${c.right})/100):ih*(1-(${c.top}+${c.bottom})/100):iw*${c.left}/100:ih*${c.top}/100,`;
                }

                filterParts.push(`[${i}:v]${trimFilter}${cropFilter}${transformFilter}${colorFilter}scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},setsar=1[v${i}]`);

                const clipVol = clip.muted ? 0 : perceptualVolume(clip.volume !== undefined ? clip.volume : 1);

                let clipFadeFilter = '';
                const clipFadeIn = clip.fadeIn || 0;
                const clipFadeOut = clip.fadeOut || 0;
                if (clipFadeIn > 0) {
                    clipFadeFilter += `afade=t=in:st=0:d=${clipFadeIn},`;
                }
                if (clipFadeOut > 0) {
                    const clipTimelineDur = getClipDuration(clip);
                    const fadeOutStart = Math.max(0, clipTimelineDur - clipFadeOut).toFixed(3);
                    clipFadeFilter += `afade=t=out:st=${fadeOutStart}:d=${clipFadeOut},`;
                }

                if (hasAudioArray[i]) {
                    filterParts.push(`[${i}:a]${atrimFilter}${clipFadeFilter}volume=${clipVol}[a${i}]`);
                } else {
                    const videoDur = getClipDuration(clip);
                    filterParts.push(`[${silenceIdx}:a]atrim=duration=${videoDur.toFixed(3)},asetpts=PTS-STARTPTS,${clipFadeFilter}volume=${clipVol}[a${i}]`);
                }
            }
        }

        let currentVideoLabel = '';
        let currentAudioLabel = '';

        if (videoCount === 1) {
            currentVideoLabel = '[v0]';
            currentAudioLabel = '[a0]';
        } else {
            const hasAnyTransition = state.videoClips.some((c, idx) => idx < state.videoClips.length - 1 && c.transition && c.transition.type !== 'none');

            if (hasAnyTransition) {
                let accDuration = getClipDuration(state.videoClips[0]);
                currentVideoLabel = '[v0]';
                currentAudioLabel = '[a0]';

                for (let i = 1; i < videoCount; i++) {
                    const prevClip = state.videoClips[i - 1];
                    const trans = prevClip.transition;
                    const transType = trans ? trans.type : 'none';
                    const transDur = trans ? (trans.duration || 0.5) : 0.5;

                    if (transType !== 'none') {
                        const xfadeType = TRANSITION_XFADE_MAP[transType] || 'fade';
                        const offset = Math.max(0, accDuration - transDur);
                        const vOut = `[xv${i}]`;
                        const aOut = `[xa${i}]`;
                        filterParts.push(`${currentVideoLabel}[v${i}]xfade=transition=${xfadeType}:duration=${transDur.toFixed(3)}:offset=${offset.toFixed(3)}${vOut}`);
                        filterParts.push(`${currentAudioLabel}[a${i}]acrossfade=d=${transDur.toFixed(3)}:c1=tri:c2=tri${aOut}`);
                        currentVideoLabel = vOut;
                        currentAudioLabel = aOut;
                        accDuration += getClipDuration(state.videoClips[i]) - transDur;
                    } else {
                        const vOut = `[xv${i}]`;
                        const aOut = `[xa${i}]`;
                        filterParts.push(`${currentVideoLabel}${currentAudioLabel}[v${i}][a${i}]concat=n=2:v=1:a=1${vOut}${aOut}`);
                        currentVideoLabel = vOut;
                        currentAudioLabel = aOut;
                        accDuration += getClipDuration(state.videoClips[i]);
                    }
                }
            } else {
                let concatParts = '';
                for (let i = 0; i < videoCount; i++) {
                    concatParts += `[v${i}][a${i}]`;
                }
                filterParts.push(`${concatParts}concat=n=${videoCount}:v=1:a=1[outv][outa]`);
                currentVideoLabel = '[outv]';
                currentAudioLabel = '[outa]';
            }
        }

        let audioInputIdx = state.videoClips.length + (needsSilence ? 1 : 0);

        for (let a = 0; a < state.audioTracks.length; a++) {
            const audio = state.audioTracks[a];
            if (!audio.file) continue;

            const aExt = (audio.file && audio.file.name) ? audio.file.name.split('.').pop() : ((audio.name && audio.name.includes('.')) ? audio.name.split('.').pop() : 'mp3');
            const aFilename = `aud${a}.${aExt}`;
            await state.ffmpeg.writeFile(aFilename, await fetchFile(audio.file));
            inputArgs.push('-i', aFilename);

            let audioFilter = `[${audioInputIdx}:a]`;
            if (audio.startTrim > 0 || audio.endTrim > 0) {
                const aStart = audio.startTrim || 0;
                const aEnd = audio.duration - (audio.endTrim || 0);
                audioFilter += `atrim=start=${aStart}:end=${aEnd},asetpts=PTS-STARTPTS,`;
            }
            const audioSpeed = getClipSpeed(audio);
            if (audioSpeed !== 1) {
                audioFilter += buildAtempoChain(audioSpeed) + ',';
            }

            const audioFadeIn = audio.fadeIn || 0;
            const audioFadeOut = audio.fadeOut || 0;
            if (audioFadeIn > 0) {
                audioFilter += `afade=t=in:st=0:d=${audioFadeIn},`;
            }
            if (audioFadeOut > 0) {
                const audioTimelineDur = getClipDuration(audio);
                const fadeOutStart = Math.max(0, audioTimelineDur - audioFadeOut).toFixed(3);
                audioFilter += `afade=t=out:st=${fadeOutStart}:d=${audioFadeOut},`;
            }

            const audioVol = audio.muted ? 0 : perceptualVolume(audio.volume !== undefined ? audio.volume : 1);
            audioFilter += `volume=${audioVol}`;

            if (audio.offset > 0) {
                const delayMs = Math.round(audio.offset * 1000);
                audioFilter += `,adelay=${delayMs}|${delayMs}`;
            }

            filterParts.push(`${audioFilter}[audout${a}]`);
            audioInputIdx++;
        }

        if (state.audioTracks.length > 0) {
            let mixInputs = currentAudioLabel;
            let activeAudios = 1;
            for (let a = 0; a < state.audioTracks.length; a++) {
                if (state.audioTracks[a].file) {
                    mixInputs += `[audout${a}]`;
                    activeAudios++;
                }
            }
            if (activeAudios > 1) {
                filterParts.push(`${mixInputs}amix=inputs=${activeAudios}:duration=longest:dropout_transition=2[mixeda]`);
                currentAudioLabel = '[mixeda]';
            }
        }

        // ─── Text + Subtitle Overlays (High-Speed Segmented Composite Canvas PNGs) ───
        {
            const allTextOverlays = [
                ...(state.textOverlays || []).map(t => ({ ...t, _type: 'text' })),
                ...(state.subtitleTracks || []).map(s => ({ ...s, _type: 'sub' }))
            ];

            if (allTextOverlays.length > 0) {
                const totalVidDur = state.videoClips.reduce((acc, c) => acc + getClipDuration(c), 0);

                const boundaries = new Set([0, totalVidDur]);
                allTextOverlays.forEach(o => {
                    boundaries.add(Math.max(0, Math.min(totalVidDur, o.startTime || 0)));
                    boundaries.add(Math.max(0, Math.min(totalVidDur, o.endTime || (o.startTime || 0) + 3)));
                });
                const sortedBounds = [...boundaries].sort((a, b) => a - b);

                const segments = [];
                for (let i = 0; i < sortedBounds.length - 1; i++) {
                    const segStart = sortedBounds[i];
                    const segEnd = sortedBounds[i + 1];
                    if (segEnd - segStart < 0.04) continue;
                    const segMid = (segStart + segEnd) / 2;
                    const visible = allTextOverlays.filter(o => segMid >= (o.startTime || 0) && segMid <= (o.endTime || 0));
                    if (visible.length > 0) {
                        segments.push({ start: segStart, end: segEnd, overlays: visible });
                    }
                }

                const uniqueComposites = [];
                const seen = new Map();
                for (const seg of segments) {
                    const key = seg.overlays.map(o => o.id || o.text).sort().join('|');
                    if (seen.has(key)) {
                        seen.get(key).ranges.push({ start: seg.start, end: seg.end });
                    } else {
                        const entry = { overlays: seg.overlays, ranges: [{ start: seg.start, end: seg.end }] };
                        seen.set(key, entry);
                        uniqueComposites.push(entry);
                    }
                }

                for (let ci = 0; ci < uniqueComposites.length; ci++) {
                    const comp = uniqueComposites[ci];
                    const compositeBlob = await renderCompositeOverlayToBlob(comp.overlays, outW, outH);
                    if (!compositeBlob || compositeBlob.size === 0) continue;

                    const compositeData = new Uint8Array(await compositeBlob.arrayBuffer());
                    const compositeFilename = `comp${ci}.png`;
                    await state.ffmpeg.writeFile(compositeFilename, compositeData);

                    const firstStart = comp.ranges[0].start;
                    const lastEnd = comp.ranges[comp.ranges.length - 1].end;
                    const compActiveDur = Math.max(0.1, lastEnd - firstStart);

                    inputArgs.push('-loop', '1', '-framerate', '25', '-t', compActiveDur.toFixed(3), '-i', compositeFilename);

                    const scaledLabel = `[compscaled${ci}]`;
                    filterParts.push(`[${audioInputIdx}:v]format=rgba,setpts=PTS-STARTPTS+${firstStart.toFixed(3)}/TB${scaledLabel}`);

                    const enableParts = comp.ranges.map(r => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`);
                    const enableExpr = enableParts.join('+');

                    const outLabel = `[compout${ci}]`;
                    filterParts.push(
                        `${currentVideoLabel}${scaledLabel}overlay=x=0:y=0:enable='${enableExpr}':eof_action=pass${outLabel}`
                    );
                    currentVideoLabel = outLabel;
                    audioInputIdx++;
                }
            }
        }

        // ─── Overlay (PiP & Stickers) tracks (Optimized Bounding Box + PTS Sync) ───
        if (state.overlayTracks && state.overlayTracks.length > 0) {
            const totalVidDur = state.videoClips.reduce((acc, c) => acc + getClipDuration(c), 0);
            let overlayInputIdx = audioInputIdx;

            for (let oi = 0; oi < state.overlayTracks.length; oi++) {
                const ovl = state.overlayTracks[oi];
                if (!ovl.file && !ovl.objectUrl && !ovl.emoji) continue;

                let oData = null;
                let oExt = ovl.isImage || ovl.isSticker ? 'png' : 'mp4';
                if (ovl.file) {
                    oExt = ovl.file.name ? ovl.file.name.split('.').pop() : (ovl.isImage ? 'png' : 'mp4');
                    oData = await fetchFile(ovl.file);
                } else if (ovl.isSticker && ovl.emoji) {
                    const dataUrl = ovl.objectUrl || createEmojiDataUrl(ovl.emoji);
                    oData = await fetchFile(dataUrl);
                } else if (ovl.objectUrl) {
                    oExt = ovl.isImage ? 'png' : 'mp4';
                    oData = await fetchFile(ovl.objectUrl);
                }
                if (!oData) continue;

                const oFilename = `ovl${oi}.${oExt}`;
                await state.ffmpeg.writeFile(oFilename, oData);

                const ovlStart = Math.max(0, ovl.startTime || 0);
                const ovlEnd = Math.max(ovlStart + 0.1, ovl.endTime || (ovlStart + 5));
                const ovlDur = ovlEnd - ovlStart;

                let rawScaleW = Math.round(outW * (ovl.scale || 30) / 100);
                if (rawScaleW < 16) rawScaleW = 16;
                const ovlScaleW = rawScaleW % 2 === 0 ? rawScaleW : rawScaleW + 1;

                let ovlX = `(main_w*${(ovl.posX !== undefined ? ovl.posX : 50) / 100}-overlay_w/2)`;
                let ovlY = `(main_h*${(ovl.posY !== undefined ? ovl.posY : 50) / 100}-overlay_h/2)`;

                if (ovl.keyframes && ovl.keyframes.length > 0) {
                    ovlX = buildFFmpegKeyframeCoordExpr(ovl.keyframes, 'x', ovl.posX !== undefined ? ovl.posX : 50, false, 'main_w', 'overlay_w');
                    ovlY = buildFFmpegKeyframeCoordExpr(ovl.keyframes, 'y', ovl.posY !== undefined ? ovl.posY : 50, false, 'main_h', 'overlay_h');
                }

                const ovlOpacity = (ovl.opacity !== undefined ? ovl.opacity : 100) / 100;
                let opacityFilter = ovlOpacity < 1 ? `,colorchannelmixer=aa=${ovlOpacity.toFixed(2)}` : '';

                if (ovl.isImage) {
                    inputArgs.push('-loop', '1', '-framerate', '25', '-t', totalVidDur.toFixed(3), '-i', oFilename);
                    const scaledLabel = `[stkscaled${oi}]`;
                    filterParts.push(`[${overlayInputIdx}:v]format=rgba,scale=${ovlScaleW}:-2${opacityFilter}${scaledLabel}`);

                    const ovlOutLabel = `[stkout${oi}]`;
                    filterParts.push(
                        `${currentVideoLabel}${scaledLabel}overlay=x='${ovlX}':y='${ovlY}':enable='between(t,${ovlStart.toFixed(3)},${ovlEnd.toFixed(3)})':eof_action=pass${ovlOutLabel}`
                    );
                    currentVideoLabel = ovlOutLabel;
                    overlayInputIdx++;
                } else {
                    inputArgs.push('-i', oFilename);
                    const scaledLabel = `[pipscaled${oi}]`;
                    filterParts.push(`[${overlayInputIdx}:v]trim=duration=${ovlDur.toFixed(3)},setpts=PTS-STARTPTS+${ovlStart.toFixed(3)}/TB,scale=${ovlScaleW}:-2${opacityFilter}${scaledLabel}`);

                    const ovlOutLabel = `[pipout${oi}]`;
                    filterParts.push(
                        `${currentVideoLabel}${scaledLabel}overlay=x='${ovlX}':y='${ovlY}':enable='between(t,${ovlStart.toFixed(3)},${ovlEnd.toFixed(3)})':eof_action=pass${ovlOutLabel}`
                    );
                    currentVideoLabel = ovlOutLabel;
                    overlayInputIdx++;
                }
            }
        }

        const filterComplex = filterParts.join('; ');

        const speedPreset = state.exportSettings.preset || 'ultrafast';
        const crfVal = (EXPORT_QUALITY_CRF[state.exportSettings.quality] ? EXPORT_QUALITY_CRF[state.exportSettings.quality].crf : 23).toString();

        const args = [
            ...inputArgs,
            '-filter_complex', filterComplex,
            '-map', currentVideoLabel,
            '-map', currentAudioLabel,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', crfVal,
            '-pix_fmt', 'yuv420p',
            '-threads', '0',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            'output.mp4'
        ];

        console.log('Running FFmpeg with args:', args);
        const ret = await state.ffmpeg.exec(args);
        if (typeof ret === 'number' && ret !== 0) {
            throw new Error(`FFmpeg processing failed (exit code ${ret}). Check console for details.`);
        }

        const data = await state.ffmpeg.readFile('output.mp4');
        const blob = new Blob([data.buffer], { type: 'video/mp4' });
        const url = triggerBlobDownload(blob, `${state.docTitle}.mp4`);

        state.dom.previewVideo.src = url;
        if (window.showToast) window.showToast('Video exported successfully!', false);

    } catch (e) {
        console.error(e);
        if (window.showToast) window.showToast('Export failed: ' + e.message, true);
    } finally {
        state.isExporting = false;
        const overlay = document.getElementById('cupcat-export-overlay');
        if (overlay) overlay.style.display = 'none';
    }
}
