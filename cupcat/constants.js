// cupcat/constants.js — All heavy constants (no dependencies)

export const EXPORT_RESOLUTIONS = {
    '16:9': {
        '1080p': { w: 1920, h: 1080, label: '1080p Full HD', desc: '1920×1080 · High clarity' },
        '720p': { w: 1280, h: 720, label: '720p HD', desc: '1280×720 · Recommended' },
        '480p': { w: 854, h: 480, label: '480p SD', desc: '854×480 · Fast draft' }
    },
    '9:16': {
        '1080p': { w: 1080, h: 1920, label: '1080p Full HD', desc: '1080×1920 · High clarity' },
        '720p': { w: 720, h: 1280, label: '720p HD', desc: '720×1280 · Recommended' },
        '480p': { w: 480, h: 854, label: '480p SD', desc: '480×854 · Fast draft' }
    },
    '1:1': {
        '1080p': { w: 1080, h: 1080, label: '1080p Full HD', desc: '1080×1080 · High clarity' },
        '720p': { w: 720, h: 720, label: '720p HD', desc: '720×720 · Recommended' },
        '480p': { w: 480, h: 480, label: '480p SD', desc: '480×480 · Fast draft' }
    },
    '4:3': {
        '1080p': { w: 1440, h: 1080, label: '1080p Full HD', desc: '1440×1080 · High clarity' },
        '720p': { w: 960, h: 720, label: '720p HD', desc: '960×720 · Recommended' },
        '480p': { w: 640, h: 480, label: '480p SD', desc: '640×480 · Fast draft' }
    },
    '3:4': {
        '1080p': { w: 1080, h: 1440, label: '1080p Full HD', desc: '1080×1440 · High clarity' },
        '720p': { w: 720, h: 960, label: '720p HD', desc: '720×960 · Recommended' },
        '480p': { w: 480, h: 640, label: '480p SD', desc: '480×640 · Fast draft' }
    },
    '4:5': {
        '1080p': { w: 1080, h: 1350, label: '1080p Full HD', desc: '1080×1350 · High clarity' },
        '720p': { w: 720, h: 900, label: '720p HD', desc: '720×900 · Recommended' },
        '480p': { w: 480, h: 600, label: '480p SD', desc: '480×600 · Fast draft' }
    },
    '21:9': {
        '1080p': { w: 2520, h: 1080, label: '1080p Full HD', desc: '2520×1080 · High clarity' },
        '720p': { w: 1680, h: 720, label: '720p HD', desc: '1680×720 · Recommended' },
        '480p': { w: 1120, h: 480, label: '480p SD', desc: '1120×480 · Fast draft' }
    }
};

export const EXPORT_SPEED_PRESETS = {
    'ultrafast': { label: 'Ultrafast', desc: 'Fastest render, larger size' },
    'fast': { label: 'Fast', desc: 'Balanced speed & size' },
    'medium': { label: 'Medium', desc: 'Best compression, slower' }
};

export const EXPORT_QUALITY_CRF = {
    'high': { crf: 18, label: 'High (CRF 18)', desc: 'Crisp details, higher bitrate' },
    'medium': { crf: 23, label: 'Medium (CRF 23)', desc: 'Optimal standard quality' },
    'draft': { crf: 28, label: 'Economy (CRF 28)', desc: 'Small file size, draft' }
};

// Filter Presets Definition
export const FILTER_PRESETS = {
    'none': {
        name: 'Normal',
        icon: 'fas fa-ban',
        brightness: 0,
        contrast: 1,
        saturation: 1,
        hue: 0,
        sepia: 0
    },
    'bw': {
        name: 'B&W',
        icon: 'fas fa-adjust',
        brightness: 0,
        contrast: 1.15,
        saturation: 0,
        hue: 0,
        sepia: 0
    },
    'vintage': {
        name: 'Vintage',
        icon: 'fas fa-camera-retro',
        brightness: 0.05,
        contrast: 1.1,
        saturation: 0.75,
        hue: -5,
        sepia: 35
    },
    'cinematic': {
        name: 'Cinematic',
        icon: 'fas fa-film',
        brightness: -0.04,
        contrast: 1.25,
        saturation: 0.9,
        hue: 5,
        sepia: 0
    },
    'warm': {
        name: 'Warm',
        icon: 'fas fa-sun',
        brightness: 0.02,
        contrast: 1.05,
        saturation: 1.2,
        hue: -12,
        sepia: 15
    },
    'cold': {
        name: 'Cold',
        icon: 'fas fa-snowflake',
        brightness: 0.02,
        contrast: 1.05,
        saturation: 0.85,
        hue: 15,
        sepia: 0
    },
    'vivid': {
        name: 'Vivid',
        icon: 'fas fa-magic',
        brightness: 0.02,
        contrast: 1.2,
        saturation: 1.5,
        hue: 0,
        sepia: 0
    }
};

export const MAX_HISTORY = 50;

// Supported canvas/export aspect ratios. Resolution is capped around 720px
// on the short side across all of them, matching the original hardcoded
// 1280x720 (16:9) so switching ratios doesn't change export time/output size
// by more than the ratio itself accounts for.
export const CANVAS_ASPECTS = {
    '16:9': { w: 1280, h: 720, sub: 'Landscape · YouTube' },
    '9:16': { w: 720, h: 1280, sub: 'Reels · Shorts · TikTok · Stories' },
    '1:1': { w: 720, h: 720, sub: 'Square · Feed post' },
    '4:3': { w: 960, h: 720, sub: 'Classic · Photo · iPad' },
    '3:4': { w: 720, h: 960, sub: 'Portrait · Pinterest' },
    '4:5': { w: 720, h: 900, sub: 'Instagram Portrait · Facebook' },
    '21:9': { w: 1512, h: 720, sub: 'Ultrawide · Cinematic' }
};

export const TRANSITION_XFADE_MAP = {
    'crossfade': 'fade',
    'fade-black': 'fadeblack',
    'wipe-left': 'wipeleft',
    'wipe-right': 'wiperight',
    'dissolve': 'dissolve'
};
