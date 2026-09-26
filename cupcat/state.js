// cupcat/state.js — Centralized mutable state (no dependencies)
// All modules import this object and read/write through it.
// Because `state` is a mutable reference, updates from one module
// are immediately visible to all other modules.

export const state = {
    currentDocId: null,
    ffmpeg: null,
    ffmpegLoaded: false,
    isExporting: false,
    docTitle: 'Untitled Video',
    isCropping: false,
    
    // Timeline state
    videoClips: [],     // { id, file, name, objectUrl, duration, startTrim, endTrim, isImage, kenBurns, keyframes: [], crop: {top, bottom, left, right} }
    audioTracks: [],    // { id, file, name, objectUrl, duration, startTrim, endTrim, offset }
    textOverlays: [],   // { id, text, startTime, endTime, position, color, fontSize, font, posX, posY, rotation, opacity, keyframes: [] }
    overlayTracks: [],  // { id, file, name, objectUrl, duration, isImage, isSticker, stickerEmoji, startTime, endTime, posX, posY, posPreset, scale, opacity, rotation, keyframes: [] }
    subtitleTracks: [], // { id, text, startTime, endTime, fontSize, color, bgColor, font, position, posX, posY, scale, opacity, rotation, keyframes: [] }
    selectedClipId: null,
    selectedAudioId: null,
    selectedTextId: null,
    selectedOverlayId: null,
    selectedSubtitleId: null,
    playheadTime: 0,
    isPlaying: false,
    playInterval: null,
    _playbackClipId: null, // tracks which clip ID is currently playing in the preview, needed to detect transitions between clips that share the same source URL (e.g. split video)
    _preloadedClipId: null, // tracks which clip ID is preloaded in the background video buffer
    timelineZoom: 80,      // pixels per second
    draggingClip: null,
    draggingAudio: null,
    splitMode: false,
    trimTarget: null,      // { type: 'video'|'audio', id: string }
    volumeTarget: null,    // { type: 'video'|'audio', id: string }
    volumeModalMuted: false, // pending mute toggle state while the volume modal is open
    speedTarget: null,     // { type: 'video'|'audio', id: string }
    filterTarget: null,    // { type: 'video', id: string }
    filterModalPending: { preset: 'none', brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0 },
    transformTarget: null, // { type: 'video', id: string }
    transformModalPending: { rotation: 0, flipH: false, flipV: false },
    textModalIsNew: false, // whether the text modal is currently creating a new overlay vs editing selectedTextId
    textModalEditId: null, // id of the text overlay being edited, when not creating new
    textModalPosition: 'bottom', // pending position value while the text modal is open ('top'|'center'|'bottom')
    transitionModalClipIndex: -1, // index of the clip whose outgoing transition is being edited
    canvasAspect: '16:9',  // '16:9' | '9:16' | '1:1'

    // Keyframe & Canvas Drag State
    activeStickerCategory: 'popular',
    canvasDraggingTarget: null, // { type: 'overlay'|'text', id: string, startX, startY, startPosX, startPosY, isHandle: boolean, handleType: string, startScale: number }

    // Export Quality Settings
    exportSettings: {
        resolution: '720p',
        preset: 'ultrafast',
        quality: 'medium', // 'high' (CRF 18), 'medium' (CRF 23), 'draft' (CRF 28)
        format: 'mp4'
    },

    // Undo/Redo history
    undoStack: [],
    redoStack: [],

    // Video element references (DOM refs)
    dom: {
        previewVideo: null,          // <video id="cupcat-preview"> — the single preview video element
        previewAudio: null,
        previewResizeObserver: null, // keeps #cupcat-canvas sized to canvasAspect as #cupcat-preview-area resizes
        previewImg: null,            // <img> element for showing image clips in preview
        mainCanvas: null,            // <canvas id="cupcat-main-canvas"> — unified canvas for rendering
        mainCtx: null,               // CanvasRenderingContext2D for mainCanvas
    },

    // Canvas render loop state
    animFrameId: null,               // requestAnimationFrame ID for the render loop
    useCanvasRenderer: true,         // true = Canvas pipeline, false = legacy DOM pipeline (fallback)

    // Canvas interactive box state
    isBoxDragging: false,
    isHandleResizing: false,
    resizeHandleType: '',
    dragStartX: 0,
    dragStartY: 0,
    initialPosX: 50,
    initialPosY: 50,
    initialScale: 30,

    // Subtitle & Overlay Inspector state
    subApplyToAll: true, // when true, changing style/size/pos applies to all subtitles
    subInspectorTab: 'text', // 'text' | 'style' | 'list'
    subSearchQuery: '',
    overlayModalFile: null,
    overlayModalEditId: null,
};
