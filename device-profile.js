// src/modules/tools/device-profile.js
// One codebase for every phone: tools read these limits instead of shipping
// separate "lite" and "full" builds.
//
// Tier is derived from navigator.deviceMemory (Chrome/Android; rounded GB),
// with navigator.connection telling us about Data Saver / 2G. Browsers that
// hide deviceMemory (Safari, Firefox) are treated as 'mid'.
//
// Users (or the host app's settings screen) can force a mode:
//   setPerformanceMode('lite' | 'full' | 'auto')

const MODE_KEY = 'kivu_perf_mode';

const TIERS = {
    // ≤ 2 GB RAM: typical entry-level Tecno / Itel / Infinix / Android Go
    low: {
        imageMaxDim: 1280,      // photos inserted into documents
        pdfRenderScale: 1.0,    // PDF page → image rendering
        undoLimit: 5,           // canvas-heavy undo history
    },
    mid: {
        imageMaxDim: 1600,
        pdfRenderScale: 1.5,
        undoLimit: 10,
    },
    high: {
        imageMaxDim: 2048,
        pdfRenderScale: 2.0,
        undoLimit: 20,
    },
};

function readMode() {
    try {
        const v = localStorage.getItem(MODE_KEY);
        return v === 'lite' || v === 'full' ? v : 'auto';
    } catch (_) {
        return 'auto';
    }
}

function detectTier() {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const mem = nav.deviceMemory;
    if (typeof mem !== 'number') return 'mid';
    if (mem <= 2) return 'low';
    if (mem <= 4) return 'mid';
    return 'high';
}

function detectDataSaver() {
    const c = typeof navigator !== 'undefined' ? navigator.connection : null;
    if (!c) return false;
    return !!c.saveData || c.effectiveType === '2g' || c.effectiveType === 'slow-2g';
}

let cached = null;

export function getDeviceProfile() {
    if (cached) return cached;
    const mode = readMode();
    const detected = detectTier();
    const tier = mode === 'lite' ? 'low' : (mode === 'full' ? 'high' : detected);
    cached = Object.freeze({
        tier,
        detectedTier: detected,
        mode,
        dataSaver: detectDataSaver(),
        ...TIERS[tier],
    });
    return cached;
}

export function setPerformanceMode(mode) {
    try {
        if (mode === 'lite' || mode === 'full') localStorage.setItem(MODE_KEY, mode);
        else localStorage.removeItem(MODE_KEY);
    } catch (_) { /* storage blocked: stays on auto for this session */ }
    cached = null;
    return getDeviceProfile();
}

if (typeof window !== 'undefined') {
    // Lets the host app (settings screen, menus) read or switch the mode
    // without importing this module.
    window.kivuDeviceProfile = { get: getDeviceProfile, setMode: setPerformanceMode };
}
