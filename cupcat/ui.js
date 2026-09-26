import { state } from './state.js';
import { CANVAS_ASPECTS, EXPORT_RESOLUTIONS } from './constants.js';
import { formatTime, getMediaDuration, generateId, getTotalDuration, getClipDuration, getClipStartTime, stopPlaybackSafe } from './utils.js';
import { pushHistory, undo, redo } from './history.js';

let cb = {};

export function setUICallbacks(callbacks) {
    cb = { ...cb, ...callbacks };
}

export function handleEditorKeyDown(e) {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    if (!document.getElementById('cupcat-editor')) return;

    const mod = e.ctrlKey || e.metaKey;

    if (mod && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        undo();
    } else if ((mod && e.key === 'y') || (mod && e.shiftKey && (e.key === 'z' || e.key === 'Z'))) {
        e.preventDefault();
        redo();
    } else if (e.code === 'Space') {
        e.preventDefault();
        if (cb.togglePlay) cb.togglePlay();
    } else if (e.key === 's' || e.key === 'S' || e.key === 'ы' || e.key === 'Ы') {
        if (!mod) {
            e.preventDefault();
            if (cb.splitAtPlayhead) cb.splitAtPlayhead();
        }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (cb.deleteSelected) cb.deleteSelected();
    } else if (e.key === 'k' || e.key === 'K' || e.key === 'л' || e.key === 'Л') {
        if (!mod) {
            e.preventDefault();
            if (cb.toggleKeyframeAtPlayhead) cb.toggleKeyframeAtPlayhead();
        }
    } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (cb.seekPlayheadTo) cb.seekPlayheadTo(Math.max(0, state.playheadTime - (e.shiftKey ? 1 : 0.1)));
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (cb.seekPlayheadTo) cb.seekPlayheadTo(state.playheadTime + (e.shiftKey ? 1 : 0.1));
    } else if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        if (cb.navigateKeyframe) cb.navigateKeyframe('prev');
    } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        if (cb.navigateKeyframe) cb.navigateKeyframe('next');
    }
}

export function renderUI() {
    const container = document.getElementById('module-tools');
    if (!container) return;

    // Remove any existing editor
    const existing = document.getElementById('cupcat-editor');
    if (existing) existing.remove();

    const ui = `
    <div id="cupcat-editor" style="
        position: absolute; inset: 0;
        background: #0f0f1a;
        color: #e0e0e0;
        display: flex; flex-direction: column;
        z-index: 100;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        overflow: hidden;
        padding-top: env(safe-area-inset-top, 0px);
    ">
        <!-- HEADER -->
        <div id="cupcat-header" style="
            height: 52px; flex-shrink: 0;
            display: flex; align-items: center; justify-content: space-between;
            padding: 0 12px;
            background: linear-gradient(180deg, #1a1a2e 0%, #16162a 100%);
            border-bottom: 1px solid rgba(255,255,255,0.06);
        ">
            <button id="cupcat-back" style="
                display: flex; align-items: center; gap: 6px;
                background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12);
                color: #fff; padding: 6px 14px; border-radius: 20px;
                font-size: 13px; font-weight: 700; cursor: pointer;
                transition: background 0.2s;
            "><i class="fas fa-chevron-left" style="font-size: 12px;"></i><span>Back</span></button>

            <div id="cupcat-title-wrap" style="flex: 1; text-align: center; padding: 0 8px;">
                <input id="cupcat-title" value="${state.docTitle}" style="
                    background: transparent; border: none; color: #fff;
                    font-size: 15px; font-weight: 700; text-align: center;
                    width: 100%; max-width: 200px; outline: none;
                "/>
            </div>

            <button id="cupcat-export" style="
                background: linear-gradient(135deg, #e040fb 0%, #7c4dff 100%);
                color: #fff; border: none; padding: 7px 18px;
                border-radius: 20px; font-size: 13px; font-weight: 700;
                cursor: pointer; letter-spacing: 0.3px;
                box-shadow: 0 2px 12px rgba(224,64,251,0.3);
            ">Export</button>
        </div>

        <!-- PREVIEW AREA -->
        <div id="cupcat-preview-area" style="
            flex: 1; min-height: 0;
            background: #000;
            display: flex; align-items: center; justify-content: center;
            position: relative; overflow: hidden;
        ">
            <div id="cupcat-canvas" style="
                position: relative;
                background: #000;
                box-shadow: 0 0 0 1px rgba(255,255,255,0.06);
                overflow: hidden;
            ">
                <canvas id="cupcat-main-canvas" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 1;"></canvas>
                <video id="cupcat-preview" style="
                    width: 100%; height: 100%; object-fit: cover; display: none; position: absolute; inset: 0;
                " playsinline webkit-playsinline preload="auto"></video>
                <img id="cupcat-preview-img" style="
                    width: 100%; height: 100%; object-fit: cover;
                    display: none; position: absolute; inset: 0;
                "/>
                <div id="cupcat-overlay-preview-container" style="
                    position: absolute; inset: 0; pointer-events: none; z-index: 5;
                "></div>
                <div id="cupcat-subtitle-overlay-container" style="
                    position: absolute; inset: 0; pointer-events: none; z-index: 8;
                "></div>
                <div id="cupcat-text-overlay-container" style="
                    position: absolute; inset: 0; pointer-events: none; z-index: 10;
                "></div>
                <!-- Interactive Canvas Bounding Box for Drag / Resize -->
                <div id="cupcat-canvas-active-box" style="
                    position: absolute; display: none; pointer-events: auto; z-index: 30;
                    border: 2px dashed #00e5ff; box-shadow: 0 0 12px rgba(0,229,255,0.45);
                    cursor: move; user-select: none; box-sizing: border-box;
                ">
                    <div class="cupcat-box-handle cupcat-bh-tl" data-handle="tl" style="position: absolute; top: -7px; left: -7px; width: 14px; height: 14px; background: #00e5ff; border: 2px solid #fff; border-radius: 50%; cursor: nwse-resize; z-index: 35; box-shadow: 0 1px 4px rgba(0,0,0,0.5);"></div>
                    <div class="cupcat-box-handle cupcat-bh-tr" data-handle="tr" style="position: absolute; top: -7px; right: -7px; width: 14px; height: 14px; background: #00e5ff; border: 2px solid #fff; border-radius: 50%; cursor: nesw-resize; z-index: 35; box-shadow: 0 1px 4px rgba(0,0,0,0.5);"></div>
                    <div class="cupcat-box-handle cupcat-bh-bl" data-handle="bl" style="position: absolute; bottom: -7px; left: -7px; width: 14px; height: 14px; background: #00e5ff; border: 2px solid #fff; border-radius: 50%; cursor: nesw-resize; z-index: 35; box-shadow: 0 1px 4px rgba(0,0,0,0.5);"></div>
                    <div class="cupcat-box-handle cupcat-bh-br" data-handle="br" style="position: absolute; bottom: -7px; right: -7px; width: 14px; height: 14px; background: #00e5ff; border: 2px solid #fff; border-radius: 50%; cursor: nwse-resize; z-index: 35; box-shadow: 0 1px 4px rgba(0,0,0,0.5);"></div>

                    <!-- Keyframe Badge -->
                    <div id="cupcat-box-kf-badge" style="
                        position: absolute; top: -26px; left: 50%; transform: translateX(-50%);
                        background: linear-gradient(135deg, #00e5ff, #00b0ff); color: #000;
                        font-size: 10px; font-weight: 800; padding: 2px 8px; border-radius: 10px;
                        white-space: nowrap; pointer-events: none; letter-spacing: 0.5px;
                        box-shadow: 0 2px 6px rgba(0,229,255,0.4); display: none;
                    ">◆ KEYFRAME</div>

                    <!-- Quick Floating Actions Toolbar -->
                    <div id="cupcat-box-quick-actions" style="
                        position: absolute; bottom: -40px; left: 50%; transform: translateX(-50%);
                        display: flex; gap: 6px; pointer-events: auto; z-index: 40; white-space: nowrap;
                    ">
                        <button id="cupcat-box-edit-btn" style="
                            background: #00e5ff; color: #000; border: none; border-radius: 14px;
                            padding: 5px 11px; font-size: 11px; font-weight: 700; cursor: pointer;
                            box-shadow: 0 2px 6px rgba(0,0,0,0.6); display: flex; align-items: center; gap: 4px;
                        "><i class="fas fa-pen"></i> Text</button>
                        <button id="cupcat-box-style-btn" style="
                            background: linear-gradient(135deg, #e040fb, #7c4dff); color: #fff; border: none; border-radius: 14px;
                            padding: 5px 11px; font-size: 11px; font-weight: 700; cursor: pointer;
                            box-shadow: 0 2px 6px rgba(0,0,0,0.6); display: none; align-items: center; gap: 4px;
                        "><i class="fas fa-palette"></i> Style</button>
                        <button id="cupcat-box-sync-btn" style="
                            background: linear-gradient(135deg, #00bcd4, #009688); color: #fff; border: none; border-radius: 14px;
                            padding: 5px 10px; font-size: 11px; font-weight: 700; cursor: pointer;
                            box-shadow: 0 2px 6px rgba(0,0,0,0.6); display: none; align-items: center; gap: 4px;
                        "><i class="fas fa-globe"></i> Sync All</button>
                        <button id="cupcat-box-split-btn" style="
                            background: rgba(255,255,255,0.18); color: #fff; border: 1px solid rgba(255,255,255,0.25); border-radius: 14px;
                            padding: 5px 9px; font-size: 11px; font-weight: 700; cursor: pointer;
                            box-shadow: 0 2px 6px rgba(0,0,0,0.6); display: none; align-items: center; gap: 3px;
                        "><i class="fas fa-cut"></i></button>
                        <button id="cupcat-box-delete-btn" style="
                            background: #ff5252; color: #fff; border: none; border-radius: 14px;
                            padding: 5px 10px; font-size: 11px; font-weight: 700; cursor: pointer;
                            box-shadow: 0 2px 6px rgba(0,0,0,0.6); display: flex; align-items: center; gap: 4px;
                        "><i class="fas fa-trash"></i></button>
                    </div>
                </div>
                
                <!-- Interactive Canvas Crop Box -->
                <div id="cupcat-crop-box" style="
                    position: absolute; display: none; pointer-events: none; z-index: 40;
                    border: 2px solid #fff; box-shadow: 0 0 0 9999px rgba(0,0,0,0.6);
                    box-sizing: border-box;
                ">
                    <!-- Lines (rules of thirds) -->
                    <div style="position: absolute; left: 33.33%; top: 0; bottom: 0; border-left: 1px solid rgba(255,255,255,0.4);"></div>
                    <div style="position: absolute; left: 66.66%; top: 0; bottom: 0; border-left: 1px solid rgba(255,255,255,0.4);"></div>
                    <div style="position: absolute; top: 33.33%; left: 0; right: 0; border-top: 1px solid rgba(255,255,255,0.4);"></div>
                    <div style="position: absolute; top: 66.66%; left: 0; right: 0; border-top: 1px solid rgba(255,255,255,0.4);"></div>
                    
                    <!-- Edges for dragging -->
                    <div class="cupcat-crop-handle" data-edge="top" style="position: absolute; top: -10px; left: 0; right: 0; height: 20px; cursor: ns-resize; pointer-events: auto;">
                        <div style="position: absolute; top: 8px; left: 50%; transform: translateX(-50%); width: 30px; height: 4px; background: #fff; border-radius: 2px; box-shadow: 0 1px 4px rgba(0,0,0,0.5);"></div>
                    </div>
                    <div class="cupcat-crop-handle" data-edge="bottom" style="position: absolute; bottom: -10px; left: 0; right: 0; height: 20px; cursor: ns-resize; pointer-events: auto;">
                        <div style="position: absolute; top: 8px; left: 50%; transform: translateX(-50%); width: 30px; height: 4px; background: #fff; border-radius: 2px; box-shadow: 0 1px 4px rgba(0,0,0,0.5);"></div>
                    </div>
                    <div class="cupcat-crop-handle" data-edge="left" style="position: absolute; top: 0; bottom: 0; left: -10px; width: 20px; cursor: ew-resize; pointer-events: auto;">
                        <div style="position: absolute; top: 50%; left: 8px; transform: translateY(-50%); width: 4px; height: 30px; background: #fff; border-radius: 2px; box-shadow: 0 1px 4px rgba(0,0,0,0.5);"></div>
                    </div>
                    <div class="cupcat-crop-handle" data-edge="right" style="position: absolute; top: 0; bottom: 0; right: -10px; width: 20px; cursor: ew-resize; pointer-events: auto;">
                        <div style="position: absolute; top: 50%; left: 8px; transform: translateY(-50%); width: 4px; height: 30px; background: #fff; border-radius: 2px; box-shadow: 0 1px 4px rgba(0,0,0,0.5);"></div>
                    </div>
                </div>
            </div>

            <!-- Empty state -->
            <div id="cupcat-empty-state" style="
                position: absolute; inset: 0;
                display: flex; flex-direction: column; align-items: center; justify-content: center;
                gap: 12px;
            ">
                <div style="
                    width: 72px; height: 72px; border-radius: 50%;
                    background: linear-gradient(135deg, rgba(224,64,251,0.15), rgba(124,77,255,0.15));
                    display: flex; align-items: center; justify-content: center;
                ">
                    <i class="fas fa-film" style="font-size: 28px; color: #e040fb;"></i>
                </div>
                <div style="font-size: 15px; color: #888; font-weight: 500;">Add videos or images to start editing</div>
            </div>

            <!-- Export overlay -->
            <div id="cupcat-export-overlay" style="
                position: absolute; inset: 0;
                background: rgba(0,0,0,0.85);
                display: none; flex-direction: column; align-items: center; justify-content: center;
                z-index: 50;
            ">
                <i class="fas fa-circle-notch fa-spin" style="font-size: 36px; color: #e040fb; margin-bottom: 16px;"></i>
                <div style="font-size: 16px; font-weight: 700; margin-bottom: 8px;">Rendering Video...</div>
                <div id="cupcat-progress-text" style="font-size: 13px; color: #888;">0%</div>
                <div style="width: 220px; height: 6px; background: #333; border-radius: 3px; margin-top: 16px; overflow: hidden;">
                    <div id="cupcat-progress-bar" style="height: 100%; background: linear-gradient(90deg, #e040fb, #7c4dff); width: 0%; transition: width 0.3s;"></div>
                </div>
                <button id="cupcat-cancel-export-btn" style="
                    margin-top: 20px; padding: 8px 28px;
                    background: rgba(255,82,82,0.15); border: 1px solid rgba(255,82,82,0.4);
                    color: #ff5252; border-radius: 20px; font-size: 13px; font-weight: 600;
                    cursor: pointer;
                ">✕ Cancel</button>
            </div>

            <!-- Time display -->
            <div id="cupcat-time-display" style="
                position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%);
                background: rgba(0,0,0,0.7); padding: 4px 12px; border-radius: 12px;
                font-size: 12px; font-weight: 600; color: #fff;
                font-variant-numeric: tabular-nums;
            ">
                <span id="cupcat-current-time">0:00.0</span> / <span id="cupcat-total-time">0:00.0</span>
            </div>
        </div>

        <!-- RESIZE HANDLE — drag to resize preview vs bottom panel -->
        <div id="cupcat-resize-handle" style="
            height: 18px; flex-shrink: 0;
            display: flex; align-items: center; justify-content: center;
            cursor: ns-resize;
            background: linear-gradient(180deg, #0d0d1f 0%, #12122a 100%);
            touch-action: none;
            user-select: none; -webkit-user-select: none;
            z-index: 10;
        ">
            <div style="
                width: 36px; height: 4px;
                background: rgba(255,255,255,0.2);
                border-radius: 2px;
            "></div>
        </div>

        <!-- FULLSCREEN PREVIEW OVERLAY -->
        <div id="cupcat-fullscreen-overlay" style="
            position: fixed; inset: 0; z-index: 99999;
            background: #000; display: none;
            flex-direction: column;
        ">
            <div id="cupcat-fs-canvas-area" style="
                flex: 1; min-height: 0; display: flex;
                align-items: center; justify-content: center;
                position: relative; overflow: hidden;
            ">
                <canvas id="cupcat-fs-canvas" style="max-width: 100%; max-height: 100%; object-fit: contain;"></canvas>
            </div>
            <div id="cupcat-fs-controls" style="
                height: 56px; flex-shrink: 0;
                display: flex; align-items: center; justify-content: center; gap: 16px;
                background: rgba(0,0,0,0.85);
                backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
                border-top: 1px solid rgba(255,255,255,0.08);
                padding: 0 16px;
            ">
                <button id="cupcat-fs-close-btn" title="Exit fullscreen" style="
                    position: absolute; left: 16px;
                    width: 36px; height: 36px; border-radius: 50%;
                    background: rgba(255,255,255,0.08);
                    border: 1px solid rgba(255,255,255,0.12);
                    color: #fff; font-size: 16px; cursor: pointer;
                    display: flex; align-items: center; justify-content: center;
                    transition: background 0.2s;
                "><i class="fas fa-compress"></i></button>

                <button id="cupcat-fs-play-btn" title="Play / Pause" style="
                    width: 44px; height: 44px; border-radius: 50%;
                    background: linear-gradient(135deg, #e040fb, #7c4dff);
                    border: none; color: #fff; font-size: 16px; cursor: pointer;
                    display: flex; align-items: center; justify-content: center;
                    box-shadow: 0 2px 12px rgba(224,64,251,0.4);
                "><i class="fas fa-play"></i></button>

                <div id="cupcat-fs-time" style="
                    position: absolute; right: 16px;
                    font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.8);
                    font-variant-numeric: tabular-nums;
                ">0:00.0 / 0:00.0</div>
            </div>
            <!-- Fullscreen progress bar -->
            <div id="cupcat-fs-progress-bar" style="
                position: absolute; bottom: 56px; left: 0; right: 0; height: 6px;
                background: rgba(255,255,255,0.1); cursor: pointer; z-index: 2;
            ">
                <div id="cupcat-fs-progress-fill" style="
                    height: 100%; width: 0%;
                    background: linear-gradient(90deg, #e040fb, #7c4dff);
                    border-radius: 0 3px 3px 0;
                    transition: width 0.05s linear;
                    pointer-events: none;
                "></div>
            </div>
        </div>

        <!-- PLAYBACK & KEYFRAME CONTROLS -->
        <div id="cupcat-playback-controls" style="
            height: 44px; flex-shrink: 0;
            display: flex; align-items: center; justify-content: center; gap: 12px;
            background: #12122a;
            border-top: 1px solid rgba(255,255,255,0.05);
            border-bottom: 1px solid rgba(255,255,255,0.05);
            position: relative;
        ">
            <button id="cupcat-fullscreen-btn" title="Fullscreen Preview (F)" style="
                position: absolute; left: 8px;
                width: 34px; height: 34px; border-radius: 50%;
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.08);
                color: #aaa; font-size: 14px; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                transition: all 0.2s;
            "><i class="fas fa-expand"></i></button>

            <button id="cupcat-undo-btn" title="Undo (Ctrl+Z)" style="
                width: 34px; height: 34px; border-radius: 50%;
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.08);
                color: #aaa; font-size: 14px; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                opacity: 0.3; pointer-events: none;
                transition: opacity 0.2s;
            "><i class="fas fa-undo"></i></button>

            <!-- Keyframe Navigation & Diamond Button -->
            <div style="display: flex; align-items: center; gap: 4px; background: rgba(0,0,0,0.25); padding: 2px 6px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.06);">
                <button id="cupcat-kf-prev-btn" title="Previous Keyframe (J)" style="
                    background: none; border: none; color: #ffd700; font-size: 11px;
                    padding: 4px 6px; cursor: pointer; opacity: 0.3; transition: opacity 0.2s;
                "><i class="fas fa-step-backward"></i></button>

                <button id="cupcat-kf-toggle-btn" title="Add / Remove Keyframe at Playhead (K)" style="
                    display: flex; align-items: center; gap: 5px;
                    background: rgba(255,215,0,0.10); color: #ffd700;
                    border: 1.5px solid rgba(255,215,0,0.35);
                    padding: 3px 10px; border-radius: 14px;
                    font-size: 11px; font-weight: 700; cursor: pointer;
                    transition: all 0.2s;
                "><span id="cupcat-kf-diamond-icon" style="font-size: 12px; font-weight: 900;">◆+</span> <span>Keyframe</span></button>

                <button id="cupcat-kf-next-btn" title="Next Keyframe (L)" style="
                    background: none; border: none; color: #ffd700; font-size: 11px;
                    padding: 4px 6px; cursor: pointer; opacity: 0.3; transition: opacity 0.2s;
                "><i class="fas fa-step-forward"></i></button>
            </div>

            <button id="cupcat-play-btn" title="Play / Pause (Space)" style="
                width: 36px; height: 36px; border-radius: 50%;
                background: linear-gradient(135deg, #e040fb, #7c4dff);
                border: none; color: #fff; font-size: 14px; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                box-shadow: 0 2px 8px rgba(224,64,251,0.3);
            "><i class="fas fa-play"></i></button>

            <button id="cupcat-redo-btn" title="Redo (Ctrl+Y)" style="
                width: 34px; height: 34px; border-radius: 50%;
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.08);
                color: #aaa; font-size: 14px; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                opacity: 0.3; pointer-events: none;
                transition: opacity 0.2s;
            "><i class="fas fa-redo"></i></button>
        </div>

        <!-- Hidden file inputs -->
        <input type="file" id="cupcat-file-input" accept="video/*,image/*" multiple style="display:none;">
        <input type="file" id="cupcat-audio-input" accept="audio/*" style="display:none;">

        <!-- TIMELINE -->
        <div id="cupcat-timeline-container" style="
            flex-shrink: 0;
            height: 180px;
            background: #0d0d1f;
            display: flex; flex-direction: column;
            overflow: hidden;
            position: relative;
        ">
            <!-- Time ruler -->
            <div id="cupcat-ruler" style="
                height: 24px; flex-shrink: 0;
                background: #12122a;
                position: relative;
                overflow: hidden;
                border-bottom: 1px solid rgba(255,255,255,0.06);
            ">
                <div id="cupcat-ruler-inner" style="position: relative; height: 100%;"></div>
            </div>

            <!-- Tracks area -->
            <div id="cupcat-tracks-scroll" style="
                flex: 1;
                overflow-x: auto; overflow-y: auto;
                position: relative;
                -webkit-overflow-scrolling: touch;
            ">
                <div id="cupcat-tracks-inner" style="position: relative; min-height: 100%;">
                    <!-- Playhead -->
                    <div id="cupcat-playhead" style="
                        position: absolute; top: 0; bottom: 0;
                        width: 2px; background: #e040fb;
                        z-index: 20; pointer-events: none;
                        left: 0;
                        box-shadow: 0 0 6px rgba(224,64,251,0.5);
                    ">
                        <!-- Draggable handle -->
                        <div id="cupcat-playhead-handle" style="
                            position: absolute; top: -6px; left: -14px;
                            width: 30px; height: 30px;
                            pointer-events: auto; cursor: grab;
                            display: flex; align-items: flex-start; justify-content: center;
                            z-index: 25;
                        ">
                            <div style="
                                width: 14px; height: 14px;
                                background: #e040fb; border-radius: 3px;
                                transform: rotate(45deg);
                                box-shadow: 0 0 8px rgba(224,64,251,0.6);
                                margin-top: 4px;
                            "></div>
                        </div>
                    </div>

                    <!-- Video track -->
                    <div style="
                        display: flex; align-items: center;
                        padding: 4px 0 4px 4px;
                        min-height: 56px;
                    ">
                        <div style="
                            width: 28px; flex-shrink: 0;
                            font-size: 10px; color: #e040fb;
                            writing-mode: vertical-lr; text-orientation: mixed;
                            text-align: center; font-weight: 700; letter-spacing: 1px;
                        ">VID</div>
                        <div id="cupcat-video-track" style="
                            display: flex; align-items: center;
                            height: 48px; position: relative;
                            gap: 2px; flex-shrink: 0;
                        "></div>
                    </div>

                    <!-- Audio tracks -->
                    <div id="cupcat-audio-tracks-container" style="min-height: 0;"></div>

                    <!-- Text overlay tracks -->
                    <div id="cupcat-text-tracks-container" style="min-height: 0;"></div>

                    <!-- Subtitle tracks -->
                    <div id="cupcat-subtitle-tracks-container" style="min-height: 0;"></div>

                    <!-- Overlay (PiP) tracks -->
                    <div id="cupcat-overlay-tracks-container" style="min-height: 0;"></div>
                </div>
            </div>
        </div>

        <!-- TOOLBAR — Bottom CapCut-style layout -->
        <!-- Row 1: ADD tools + Zoom -->
        <div id="cupcat-toolbar" style="
            min-height: 58px; height: auto; flex-shrink: 0;
            display: flex; align-items: center; gap: 2px;
            padding: 4px 6px;
            padding-bottom: calc(4px + env(safe-area-inset-bottom, 0px));
            background: #16162a;
            border-top: 1px solid rgba(255,255,255,0.06);
            overflow-x: auto;
            scrollbar-width: none;
        ">
            <button id="cupcat-add-video-btn" class="cupcat-tool-btn" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(224,64,251,0.10); color: #e040fb;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-plus" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Media</span></button>

            <button id="cupcat-add-audio-btn" class="cupcat-tool-btn" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(0,230,118,0.08); color: #00e676;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-music" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Audio</span></button>

            <button id="cupcat-stickers-btn" class="cupcat-tool-btn" title="Add Stickers & Emojis" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: linear-gradient(135deg, rgba(255,193,7,0.12), rgba(255,111,0,0.12)); color: #ffb300;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-smile" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 700; white-space: nowrap;">Stickers</span></button>

            <button id="cupcat-text-btn" class="cupcat-tool-btn" title="Add text overlay" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(255,110,64,0.08); color: #ff6e40;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-font" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Text</span></button>

            <button id="cupcat-sub-btn" class="cupcat-tool-btn" title="Add subtitles" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(0,188,212,0.08); color: #00bcd4;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-closed-captioning" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Subs</span></button>

            <button id="cupcat-overlay-btn" class="cupcat-tool-btn" title="Add overlay (PiP)" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(156,39,176,0.08); color: #ce93d8;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-layer-group" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Overlay</span></button>

            <button id="cupcat-kf-presets-btn" class="cupcat-tool-btn" title="Cinematic Keyframe Animation Presets" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: linear-gradient(135deg, rgba(255,215,0,0.12), rgba(255,140,0,0.12)); color: #ffd700;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-gem" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 700; white-space: nowrap;">Motion</span></button>

            <div style="flex: 1; min-width: 4px;"></div>

            <button id="cupcat-zoom-out" class="cupcat-tool-btn" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(255,255,255,0.04); color: #888;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 42px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-search-minus" style="font-size: 14px;"></i><span style="font-size: 9px; font-weight: 500; white-space: nowrap;">Zoom−</span></button>
            <button id="cupcat-zoom-in" class="cupcat-tool-btn" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(255,255,255,0.04); color: #888;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 42px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-search-plus" style="font-size: 14px;"></i><span style="font-size: 9px; font-weight: 500; white-space: nowrap;">Zoom+</span></button>
        </div>

        <!-- Row 2: EDIT tools (merged into row 1 as one continuous scroll) -->
        <div id="cupcat-toolbar-edit" style="
            height: 0px; flex-shrink: 0; overflow: hidden; padding: 0; display: none;
        ">
            <button id="cupcat-ratio-btn" class="cupcat-tool-btn" title="Canvas ratio" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(224,64,251,0.10); color: #e040fb;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-expand" style="font-size: 18px;"></i><span id="cupcat-ratio-btn-label" style="font-size: 10px; font-weight: 600; white-space: nowrap;">${state.canvasAspect}</span></button>

            <button id="cupcat-split-btn" class="cupcat-tool-btn" title="Split at playhead (S)" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(255,171,0,0.08); color: #ffab00;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-cut" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Split</span></button>

            <button id="cupcat-delete-btn" class="cupcat-tool-btn" title="Delete selected (Del)" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(255,82,82,0.08); color: #ff5252;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-trash" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Delete</span></button>

            <button id="cupcat-duplicate-btn" class="cupcat-tool-btn" title="Duplicate selected" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(186,104,200,0.08); color: #ba68c8;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-clone" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Copy</span></button>

            <button id="cupcat-extract-audio-btn" class="cupcat-tool-btn" title="Extract audio from video" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(77,182,172,0.08); color: #4db6ac;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-file-audio" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Audio</span></button>

            <button id="cupcat-freeze-btn" class="cupcat-tool-btn" title="Freeze frame at playhead (3s)" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(129,212,250,0.08); color: #81d4fa;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-snowflake" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Freeze</span></button>

            <button id="cupcat-reverse-btn" class="cupcat-tool-btn" title="Reverse selected clip" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(255,138,101,0.08); color: #ff8a65;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-history" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Reverse</span></button>

            <button id="cupcat-crop-btn" class="cupcat-tool-btn" title="Crop selected video" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(41,182,246,0.08); color: #29b6f6;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-crop" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Crop</span></button>

            <button id="cupcat-volume-btn" class="cupcat-tool-btn" title="Volume / mute selected clip" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(0,230,118,0.08); color: #00e676;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-volume-up" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Volume</span></button>

            <button id="cupcat-speed-btn" class="cupcat-tool-btn" title="Speed up / slow down selected clip" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(255,214,0,0.08); color: #ffd600;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-tachometer-alt" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Speed</span></button>

            <button id="cupcat-filters-btn" class="cupcat-tool-btn" title="Filters & Color Grading" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(233,30,99,0.08); color: #ff4081;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-palette" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Filters</span></button>


            <button id="cupcat-transform-btn" class="cupcat-tool-btn" title="Rotate & Flip selected clip" style="
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(0,229,255,0.08); color: #00e5ff;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-sync-alt" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Rotate</span></button>

            <button id="cupcat-imgset-btn" class="cupcat-tool-btn" title="Image settings (duration & Ken Burns)" style="
                display: none; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
                background: rgba(0,176,255,0.08); color: #00b0ff;
                border: none;
                padding: 6px 4px; border-radius: 10px;
                min-width: 56px; cursor: pointer;
                transition: background 0.2s;
                touch-action: manipulation;
            "><i class="fas fa-image" style="font-size: 18px;"></i><span style="font-size: 10px; font-weight: 600; white-space: nowrap;">Image</span></button>
        </div>

        <!-- VOLUME MODAL -->
        <div id="cupcat-volume-modal" style="
            display: none; position: absolute; inset: 0;
            background: rgba(0,0,0,0.85);
            z-index: 200;
            flex-direction: column; align-items: center; justify-content: center;
            padding: 20px;
        ">
            <div style="
                background: #1a1a2e; border-radius: 16px; padding: 24px;
                width: 100%; max-width: 400px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <div style="font-size: 16px; font-weight: 700; color: #fff;">Volume</div>
                    <button id="cupcat-volume-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;"><i class="fas fa-times"></i></button>
                </div>

                <button id="cupcat-volume-mute-toggle" style="
                    width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
                    padding: 10px; border-radius: 10px; margin-bottom: 20px;
                    background: rgba(255,82,82,0.10); color: #ff5252;
                    border: 1px solid rgba(255,82,82,0.25);
                    font-weight: 700; font-size: 13px; cursor: pointer;
                ">
                    <i id="cupcat-volume-mute-icon" class="fas fa-volume-mute"></i>
                    <span id="cupcat-volume-mute-label">Mute this clip</span>
                </button>

                <div style="margin-bottom: 8px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Level</label>
                    <input id="cupcat-volume-slider" type="range" min="0" max="200" value="100" step="1" style="width: 100%; accent-color: #00e676;">
                    <div id="cupcat-volume-slider-val" style="font-size: 12px; color: #00e676; text-align: center; margin-top: 4px; font-weight: 700;">100%</div>
                </div>

                <div style="margin-bottom: 8px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Fade in</label>
                    <input id="cupcat-volume-fadein-slider" type="range" min="0" max="10" value="0" step="0.1" style="width: 100%; accent-color: #40c4ff;">
                    <div id="cupcat-volume-fadein-val" style="font-size: 12px; color: #40c4ff; text-align: center; margin-top: 4px; font-weight: 700;">0.0s</div>
                </div>

                <div style="margin-bottom: 8px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Fade out</label>
                    <input id="cupcat-volume-fadeout-slider" type="range" min="0" max="10" value="0" step="0.1" style="width: 100%; accent-color: #40c4ff;">
                    <div id="cupcat-volume-fadeout-val" style="font-size: 12px; color: #40c4ff; text-align: center; margin-top: 4px; font-weight: 700;">0.0s</div>
                </div>

                <div style="
                    text-align: center; font-size: 11px; color: #666; margin-bottom: 16px;
                ">Preview is capped at 100% — levels above that only apply on export.</div>

                <button id="cupcat-volume-apply" style="
                    width: 100%; padding: 10px; border-radius: 10px;
                    background: linear-gradient(135deg, #00e676, #00c853);
                    color: #0a0a12; font-weight: 700; border: none; cursor: pointer;
                    font-size: 14px;
                ">Apply</button>
            </div>
        </div>

        <!-- SPEED MODAL -->
        <div id="cupcat-speed-modal" style="
            display: none; position: absolute; inset: 0;
            background: rgba(0,0,0,0.85);
            z-index: 200;
            flex-direction: column; align-items: center; justify-content: center;
            padding: 20px;
        ">
            <div style="
                background: #1a1a2e; border-radius: 16px; padding: 24px;
                width: 100%; max-width: 400px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <div style="font-size: 16px; font-weight: 700; color: #fff;">Speed</div>
                    <button id="cupcat-speed-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;"><i class="fas fa-times"></i></button>
                </div>

                <div id="cupcat-speed-presets" style="
                    display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 20px;
                ">
                    ${[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3].map(v => `
                    <button class="cupcat-speed-preset" data-speed="${v}" style="
                        flex: 1 1 auto; min-width: 52px;
                        padding: 8px 6px; border-radius: 8px;
                        background: rgba(255,214,0,0.08); color: #ffd600;
                        border: 1px solid rgba(255,214,0,0.22);
                        font-weight: 700; font-size: 12px; cursor: pointer;
                    ">${v}x</button>`).join('')}
                </div>

                <div style="margin-bottom: 8px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Fine-tune</label>
                    <input id="cupcat-speed-slider" type="range" min="0.25" max="4" value="1" step="0.05" style="width: 100%; accent-color: #ffd600;">
                    <div id="cupcat-speed-slider-val" style="font-size: 14px; color: #ffd600; text-align: center; margin-top: 4px; font-weight: 700;">1x</div>
                </div>

                <div id="cupcat-speed-preview-info" style="
                    text-align: center; font-size: 11px; color: #666; margin-bottom: 16px;
                "></div>

                <button id="cupcat-speed-apply" style="
                    width: 100%; padding: 10px; border-radius: 10px;
                    background: linear-gradient(135deg, #ffd600, #ffab00);
                    color: #0a0a12; font-weight: 700; border: none; cursor: pointer;
                    font-size: 14px;
                ">Apply</button>
            </div>
        </div>

        <!-- FREEZE FRAME MODAL -->
        <div id="cupcat-freeze-modal" style="
            display: none; position: absolute; inset: 0;
            background: rgba(0,0,0,0.85);
            z-index: 200;
            flex-direction: column; align-items: center; justify-content: center;
            padding: 20px;
        ">
            <div style="
                background: #1a1a2e; border-radius: 16px; padding: 24px;
                width: 100%; max-width: 400px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                    <div style="font-size: 16px; font-weight: 700; color: #fff;"><i class="fas fa-snowflake" style="margin-right: 8px; color: #81d4fa;"></i>Freeze Frame</div>
                    <button id="cupcat-freeze-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;"><i class="fas fa-times"></i></button>
                </div>

                <div style="
                    width: 100%; height: 130px; border-radius: 10px; overflow: hidden;
                    background: #0a0a12; display: flex; align-items: center; justify-content: center;
                    margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.08); position: relative;
                ">
                    <img id="cupcat-freeze-thumb" style="max-width: 100%; max-height: 100%; object-fit: contain;" />
                    <div style="position: absolute; bottom: 6px; right: 8px; background: rgba(0,0,0,0.65); padding: 2px 6px; border-radius: 4px; font-size: 10px; color: #81d4fa; font-weight: 600;">Snapshot at Playhead</div>
                </div>

                <div style="margin-bottom: 14px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Duration Presets</label>
                    <div id="cupcat-freeze-presets" style="display: flex; gap: 6px;">
                        ${[1, 2, 3, 5, 8].map(v => `
                        <button class="cupcat-freeze-preset" data-duration="${v}" style="
                            flex: 1 1 auto; padding: 7px 4px; border-radius: 8px;
                            background: rgba(129,212,250,0.08); color: #81d4fa;
                            border: 1px solid rgba(129,212,250,0.25);
                            font-weight: 700; font-size: 12px; cursor: pointer;
                        ">${v}s</button>`).join('')}
                    </div>
                </div>

                <div style="margin-bottom: 16px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <label style="font-size: 12px; color: #888;">Custom Duration</label>
                        <div id="cupcat-freeze-duration-val" style="font-size: 13px; color: #81d4fa; font-weight: 700;">3.0s</div>
                    </div>
                    <input id="cupcat-freeze-duration-slider" type="range" min="0.5" max="10" value="3" step="0.5" style="width: 100%; accent-color: #81d4fa;">
                </div>

                <button id="cupcat-freeze-apply" style="
                    width: 100%; padding: 11px; border-radius: 10px;
                    background: linear-gradient(135deg, #81d4fa, #29b6f6);
                    color: #0a0a12; font-weight: 700; border: none; cursor: pointer;
                    font-size: 14px;
                ">Insert Freeze Frame</button>
            </div>
        </div>

        <!-- REVERSE VIDEO MODAL -->
        <div id="cupcat-reverse-modal" style="
            display: none; position: absolute; inset: 0;
            background: rgba(0,0,0,0.85);
            z-index: 200;
            flex-direction: column; align-items: center; justify-content: center;
            padding: 20px;
        ">
            <div style="
                background: #1a1a2e; border-radius: 16px; padding: 24px;
                width: 100%; max-width: 400px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                    <div>
                        <div style="font-size: 16px; font-weight: 700; color: #fff;"><i class="fas fa-history" style="margin-right: 8px; color: #ff8a65;"></i>Reverse Video</div>
                        <div id="cupcat-reverse-clip-name" style="font-size: 11px; color: #888; margin-top: 2px;">Clip Name</div>
                    </div>
                    <button id="cupcat-reverse-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;"><i class="fas fa-times"></i></button>
                </div>

                <div style="display: flex; gap: 8px; margin-bottom: 16px;">
                    <button id="cupcat-reverse-mode-all" style="
                        flex: 1; padding: 8px 6px; border-radius: 8px;
                        background: rgba(255,138,101,0.25); color: #ff8a65;
                        border: 1px solid #ff8a65; font-weight: 700; font-size: 12px; cursor: pointer;
                    ">Entire Clip</button>
                    <button id="cupcat-reverse-mode-segment" style="
                        flex: 1; padding: 8px 6px; border-radius: 8px;
                        background: rgba(255,255,255,0.05); color: #aaa;
                        border: 1px solid transparent; font-weight: 700; font-size: 12px; cursor: pointer;
                    ">Select Segment</button>
                </div>

                <div id="cupcat-reverse-segment-controls" style="display: none; margin-bottom: 16px;">
                    <div style="margin-bottom: 10px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                            <label style="font-size: 11px; color: #888;">Segment Start Offset</label>
                            <span id="cupcat-reverse-start-val" style="font-size: 12px; color: #ff8a65; font-weight: 700;">0.0s</span>
                        </div>
                        <input id="cupcat-reverse-start" type="range" min="0" max="10" value="0" step="0.1" style="width: 100%; accent-color: #ff8a65;">
                    </div>

                    <div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                            <label style="font-size: 11px; color: #888;">Segment End Offset</label>
                            <span id="cupcat-reverse-end-val" style="font-size: 12px; color: #ff8a65; font-weight: 700;">0.0s</span>
                        </div>
                        <input id="cupcat-reverse-end" type="range" min="0" max="10" value="0" step="0.1" style="width: 100%; accent-color: #ff8a65;">
                    </div>
                </div>

                <div style="
                    background: rgba(255,255,255,0.03); border-radius: 8px; padding: 10px; margin-bottom: 14px;
                    border: 1px solid rgba(255,255,255,0.06);
                ">
                    <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #ccc; cursor: pointer;">
                        <input id="cupcat-reverse-audio-toggle" type="checkbox" checked style="accent-color: #ff8a65; width: 16px; height: 16px;">
                        <span>Reverse audio track as well</span>
                    </label>
                </div>

                <div id="cupcat-reverse-info" style="
                    text-align: center; font-size: 11px; color: #888; margin-bottom: 16px; line-height: 1.4;
                "></div>

                <button id="cupcat-reverse-apply" style="
                    width: 100%; padding: 11px; border-radius: 10px;
                    background: linear-gradient(135deg, #ff8a65, #ff7043);
                    color: #0a0a12; font-weight: 700; border: none; cursor: pointer;
                    font-size: 14px;
                ">Apply Reverse</button>
            </div>
        </div>

        <!-- IMAGE SETTINGS MODAL -->
        <div id="cupcat-imgset-modal" style="
            display: none; position: absolute; inset: 0;
            background: rgba(0,0,0,0.85);
            z-index: 200;
            flex-direction: column; align-items: center; justify-content: center;
            padding: 20px;
        ">
            <div style="
                background: #1a1a2e; border-radius: 16px; padding: 24px;
                width: 100%; max-width: 400px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <div style="font-size: 16px; font-weight: 700; color: #fff;"><i class="fas fa-image" style="margin-right: 8px; color: #00b0ff;"></i>Image Settings</div>
                    <button id="cupcat-imgset-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;"><i class="fas fa-times"></i></button>
                </div>

                <div style="margin-bottom: 16px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Display duration (seconds)</label>
                    <input id="cupcat-imgset-duration" type="range" min="1" max="30" value="5" step="0.5" style="width: 100%; accent-color: #00b0ff;">
                    <div id="cupcat-imgset-duration-val" style="font-size: 14px; color: #00b0ff; text-align: center; margin-top: 4px; font-weight: 700;">5.0s</div>
                </div>

                <div style="margin-bottom: 20px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 8px;">Ken Burns effect</label>
                    <div id="cupcat-imgset-kenburns" style="display: flex; flex-wrap: wrap; gap: 6px;">
                        <button class="cupcat-kb-option" data-kb="none" style="
                            flex: 1 1 auto; min-width: 70px;
                            padding: 10px 6px; border-radius: 8px;
                            background: rgba(0,176,255,0.08); color: #00b0ff;
                            border: 1px solid rgba(0,176,255,0.22);
                            font-weight: 700; font-size: 11px; cursor: pointer;
                            text-align: center;
                        ">None</button>
                        <button class="cupcat-kb-option" data-kb="zoom-in" style="
                            flex: 1 1 auto; min-width: 70px;
                            padding: 10px 6px; border-radius: 8px;
                            background: rgba(0,176,255,0.08); color: #00b0ff;
                            border: 1px solid rgba(0,176,255,0.22);
                            font-weight: 700; font-size: 11px; cursor: pointer;
                            text-align: center;
                        "><i class="fas fa-search-plus" style="margin-right:4px;"></i>Zoom In</button>
                        <button class="cupcat-kb-option" data-kb="zoom-out" style="
                            flex: 1 1 auto; min-width: 70px;
                            padding: 10px 6px; border-radius: 8px;
                            background: rgba(0,176,255,0.08); color: #00b0ff;
                            border: 1px solid rgba(0,176,255,0.22);
                            font-weight: 700; font-size: 11px; cursor: pointer;
                            text-align: center;
                        "><i class="fas fa-search-minus" style="margin-right:4px;"></i>Zoom Out</button>
                        <button class="cupcat-kb-option" data-kb="pan-left" style="
                            flex: 1 1 auto; min-width: 70px;
                            padding: 10px 6px; border-radius: 8px;
                            background: rgba(0,176,255,0.08); color: #00b0ff;
                            border: 1px solid rgba(0,176,255,0.22);
                            font-weight: 700; font-size: 11px; cursor: pointer;
                            text-align: center;
                        "><i class="fas fa-arrow-left" style="margin-right:4px;"></i>Pan Left</button>
                        <button class="cupcat-kb-option" data-kb="pan-right" style="
                            flex: 1 1 auto; min-width: 70px;
                            padding: 10px 6px; border-radius: 8px;
                            background: rgba(0,176,255,0.08); color: #00b0ff;
                            border: 1px solid rgba(0,176,255,0.22);
                            font-weight: 700; font-size: 11px; cursor: pointer;
                            text-align: center;
                        "><i class="fas fa-arrow-right" style="margin-right:4px;"></i>Pan Right</button>
                    </div>
                </div>

                <button id="cupcat-imgset-apply" style="
                    width: 100%; padding: 10px; border-radius: 10px;
                    background: linear-gradient(135deg, #00b0ff, #0091ea);
                    color: #fff; font-weight: 700; border: none; cursor: pointer;
                    font-size: 14px;
                ">Apply</button>
            </div>
        </div>

        <!-- RATIO MODAL -->
        <div id="cupcat-ratio-modal" style="
            display: none; position: absolute; inset: 0;
            background: rgba(0,0,0,0.85);
            z-index: 200;
            flex-direction: column; align-items: center; justify-content: center;
            padding: 20px;
        ">
            <div style="
                background: #1a1a2e; border-radius: 16px; padding: 24px;
                width: 100%; max-width: 400px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <div style="font-size: 16px; font-weight: 700; color: #fff;">Canvas Ratio</div>
                    <button id="cupcat-ratio-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;"><i class="fas fa-times"></i></button>
                </div>

                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 12px;">
                    <button class="cupcat-ratio-option" data-ratio="16:9" style="
                        padding: 12px; border-radius: 10px;
                        background: rgba(224,64,251,0.08); color: #e040fb;
                        border: 1px solid rgba(224,64,251,0.22);
                        font-weight: 700; font-size: 12px; cursor: pointer;
                        display: flex; flex-direction: column; align-items: center; gap: 6px;
                    "><div style="width: 24px; height: 14px; border: 2px solid #e040fb; border-radius: 2px;"></div>16:9 (YouTube)</button>

                    <button class="cupcat-ratio-option" data-ratio="9:16" style="
                        padding: 12px; border-radius: 10px;
                        background: rgba(224,64,251,0.08); color: #e040fb;
                        border: 1px solid rgba(224,64,251,0.22);
                        font-weight: 700; font-size: 12px; cursor: pointer;
                        display: flex; flex-direction: column; align-items: center; gap: 6px;
                    "><div style="width: 14px; height: 24px; border: 2px solid #e040fb; border-radius: 2px;"></div>9:16 (TikTok)</button>

                    <button class="cupcat-ratio-option" data-ratio="1:1" style="
                        padding: 12px; border-radius: 10px;
                        background: rgba(224,64,251,0.08); color: #e040fb;
                        border: 1px solid rgba(224,64,251,0.22);
                        font-weight: 700; font-size: 12px; cursor: pointer;
                        display: flex; flex-direction: column; align-items: center; gap: 6px;
                    "><div style="width: 20px; height: 20px; border: 2px solid #e040fb; border-radius: 2px;"></div>1:1 (Insta)</button>
                </div>
                
                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;">
                    <button class="cupcat-ratio-option" data-ratio="4:3" style="
                        padding: 12px; border-radius: 10px;
                        background: rgba(224,64,251,0.08); color: #e040fb;
                        border: 1px solid rgba(224,64,251,0.22);
                        font-weight: 700; font-size: 12px; cursor: pointer;
                        display: flex; flex-direction: column; align-items: center; gap: 6px;
                    "><div style="width: 20px; height: 15px; border: 2px solid #e040fb; border-radius: 2px;"></div>4:3</button>

                    <button class="cupcat-ratio-option" data-ratio="3:4" style="
                        padding: 12px; border-radius: 10px;
                        background: rgba(224,64,251,0.08); color: #e040fb;
                        border: 1px solid rgba(224,64,251,0.22);
                        font-weight: 700; font-size: 12px; cursor: pointer;
                        display: flex; flex-direction: column; align-items: center; gap: 6px;
                    "><div style="width: 15px; height: 20px; border: 2px solid #e040fb; border-radius: 2px;"></div>3:4</button>
                    
                    <button class="cupcat-ratio-option" data-ratio="21:9" style="
                        padding: 12px; border-radius: 10px;
                        background: rgba(224,64,251,0.08); color: #e040fb;
                        border: 1px solid rgba(224,64,251,0.22);
                        font-weight: 700; font-size: 12px; cursor: pointer;
                        display: flex; flex-direction: column; align-items: center; gap: 6px;
                    "><div style="width: 28px; height: 12px; border: 2px solid #e040fb; border-radius: 2px;"></div>21:9 (Cinema)</button>
                </div>
            </div>
        </div>

        <!-- EXPORT SETTINGS MODAL -->
        <div id="cupcat-export-settings-modal" style="
            display: none; position: absolute; inset: 0;
            background: rgba(0,0,0,0.85);
            z-index: 200;
            flex-direction: column; align-items: center; justify-content: center;
            padding: 20px;
        ">
            <div style="
                background: #1a1a2e; border-radius: 16px; padding: 24px;
                width: 100%; max-width: 440px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
                    <div style="font-size: 18px; font-weight: 700; color: #fff;">Export Settings</div>
                    <button id="cupcat-export-settings-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;"><i class="fas fa-times"></i></button>
                </div>

                <div style="margin-bottom: 20px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 8px;">Resolution</label>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <button class="cupcat-export-res-btn" data-res="720p" style="flex: 1; padding: 10px; border-radius: 8px; background: rgba(224,64,251,0.1); border: 1px solid rgba(224,64,251,0.3); color: #e040fb; font-weight: 600; cursor: pointer;">720p</button>
                        <button class="cupcat-export-res-btn" data-res="1080p" style="flex: 1; padding: 10px; border-radius: 8px; background: rgba(224,64,251,0.3); border: 1px solid #e040fb; color: #fff; font-weight: 600; cursor: pointer;">1080p</button>
                        <button class="cupcat-export-res-btn" data-res="4K" style="flex: 1; padding: 10px; border-radius: 8px; background: rgba(224,64,251,0.1); border: 1px solid rgba(224,64,251,0.3); color: #e040fb; font-weight: 600; cursor: pointer;">4K</button>
                    </div>
                </div>

                <div style="margin-bottom: 20px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 8px;">Quality (CRF)</label>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <button class="cupcat-export-quality-btn" data-quality="high" style="flex: 1; padding: 10px; border-radius: 8px; background: rgba(41,182,246,0.1); border: 1px solid rgba(41,182,246,0.3); color: #29b6f6; font-weight: 600; cursor: pointer;">High</button>
                        <button class="cupcat-export-quality-btn" data-quality="medium" style="flex: 1; padding: 10px; border-radius: 8px; background: rgba(41,182,246,0.3); border: 1px solid #29b6f6; color: #fff; font-weight: 600; cursor: pointer;">Medium</button>
                        <button class="cupcat-export-quality-btn" data-quality="low" style="flex: 1; padding: 10px; border-radius: 8px; background: rgba(41,182,246,0.1); border: 1px solid rgba(41,182,246,0.3); color: #29b6f6; font-weight: 600; cursor: pointer;">Low</button>
                    </div>
                </div>

                <div style="margin-bottom: 24px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 8px;">Render Speed</label>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <button class="cupcat-export-preset-btn" data-preset="ultrafast" style="flex: 1; padding: 10px; border-radius: 8px; background: rgba(0,230,118,0.1); border: 1px solid rgba(0,230,118,0.3); color: #00e676; font-weight: 600; cursor: pointer;">Fastest</button>
                        <button class="cupcat-export-preset-btn" data-preset="fast" style="flex: 1; padding: 10px; border-radius: 8px; background: rgba(0,230,118,0.3); border: 1px solid #00e676; color: #fff; font-weight: 600; cursor: pointer;">Fast</button>
                        <button class="cupcat-export-preset-btn" data-preset="medium" style="flex: 1; padding: 10px; border-radius: 8px; background: rgba(0,230,118,0.1); border: 1px solid rgba(0,230,118,0.3); color: #00e676; font-weight: 600; cursor: pointer;">Better</button>
                    </div>
                </div>

                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <button id="cupcat-screenshot-btn" style="
                        flex: 1; padding: 10px; border-radius: 8px;
                        background: rgba(255,171,0,0.1); border: 1px solid rgba(255,171,0,0.3);
                        color: #ffab00; font-weight: 600; font-size: 12px; cursor: pointer;
                    "><i class="fas fa-camera" style="margin-right:4px;"></i>Frame</button>
                    <button id="cupcat-audio-export-btn" style="
                        flex: 1; padding: 10px; border-radius: 8px;
                        background: rgba(0,229,255,0.1); border: 1px solid rgba(0,229,255,0.3);
                        color: #00e5ff; font-weight: 600; font-size: 12px; cursor: pointer;
                    "><i class="fas fa-music" style="margin-right:4px;"></i>Audio</button>
                    <button id="cupcat-share-btn" style="
                        flex: 1; padding: 10px; border-radius: 8px;
                        background: rgba(0,230,118,0.1); border: 1px solid rgba(0,230,118,0.3);
                        color: #00e676; font-weight: 600; font-size: 12px; cursor: pointer;
                    "><i class="fas fa-share-alt" style="margin-right:4px;"></i>Share</button>
                </div>
                <div style="display: flex; gap: 8px; margin-bottom: 16px;">
                    <button id="cupcat-gif-export-btn" style="
                        flex: 1; padding: 10px; border-radius: 8px;
                        background: rgba(224,64,251,0.1); border: 1px solid rgba(224,64,251,0.3);
                        color: #e040fb; font-weight: 600; font-size: 12px; cursor: pointer;
                    "><i class="fas fa-film" style="margin-right:4px;"></i>GIF</button>
                    <button id="cupcat-boomerang-btn" style="
                        flex: 1; padding: 10px; border-radius: 8px;
                        background: rgba(255,82,82,0.1); border: 1px solid rgba(255,82,82,0.3);
                        color: #ff5252; font-weight: 600; font-size: 12px; cursor: pointer;
                    "><i class="fas fa-sync-alt" style="margin-right:4px;"></i>Boomerang</button>
                </div>

                <div style="display: flex; gap: 12px;">
                    <button id="cupcat-export-cancel-btn" style="
                        flex: 1; padding: 12px; border-radius: 10px;
                        background: rgba(255,255,255,0.05); color: #fff;
                        border: 1px solid rgba(255,255,255,0.1);
                        font-weight: 700; cursor: pointer;
                    ">Cancel</button>
                    <button id="cupcat-export-start-btn" style="
                        flex: 2; padding: 12px; border-radius: 10px;
                        background: linear-gradient(135deg, #e040fb, #7c4dff);
                        color: #fff; border: none; font-weight: 700; cursor: pointer;
                        box-shadow: 0 4px 15px rgba(224,64,251,0.4);
                    ">Start Export</button>
                </div>
            </div>
        </div>

        <!-- TEXT MODAL -->
        <div id="cupcat-text-modal" style="
            display: none; position: absolute; inset: 0;
            background: rgba(0,0,0,0.85);
            z-index: 200;
            flex-direction: column; align-items: center; justify-content: center;
            padding: 20px;
        ">
            <div style="
                background: #1a1a2e; border-radius: 16px; padding: 24px;
                width: 100%; max-width: 400px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <div style="font-size: 16px; font-weight: 700; color: #fff;"><i class="fas fa-font" style="margin-right: 8px; color: #ff6e40;"></i>Add Text</div>
                    <button id="cupcat-text-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;"><i class="fas fa-times"></i></button>
                </div>

                <div style="margin-bottom: 16px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Text</label>
                    <textarea id="cupcat-text-input" rows="3" placeholder="Enter your text..." style="
                        width: 100%; box-sizing: border-box;
                        background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
                        border-radius: 8px; padding: 10px; color: #fff; font-size: 14px;
                        resize: vertical; font-family: inherit; outline: none;
                    "></textarea>
                </div>

                <div style="display: flex; gap: 12px; margin-bottom: 16px;">
                    <div style="flex: 1;">
                        <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Start (s)</label>
                        <input id="cupcat-text-start" type="number" min="0" step="0.1" value="0" style="
                            width: 100%; box-sizing: border-box;
                            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
                            border-radius: 8px; padding: 8px; color: #fff; font-size: 13px; outline: none;
                        ">
                    </div>
                    <div style="flex: 1;">
                        <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">End (s)</label>
                        <input id="cupcat-text-end" type="number" min="0" step="0.1" value="3" style="
                            width: 100%; box-sizing: border-box;
                            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
                            border-radius: 8px; padding: 8px; color: #fff; font-size: 13px; outline: none;
                        ">
                    </div>
                </div>

                <div style="margin-bottom: 16px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 8px;">Position</label>
                    <div style="display: flex; gap: 6px;">
                        <button class="cupcat-text-pos-btn" data-pos="top" style="
                            flex: 1; padding: 10px 6px; border-radius: 8px;
                            background: rgba(255,110,64,0.08); color: #ff6e40;
                            border: 1px solid rgba(255,110,64,0.22);
                            font-weight: 700; font-size: 11px; cursor: pointer; text-align: center;
                        "><i class="fas fa-arrow-up" style="margin-right:4px;"></i>Top</button>
                        <button class="cupcat-text-pos-btn" data-pos="center" style="
                            flex: 1; padding: 10px 6px; border-radius: 8px;
                            background: rgba(255,110,64,0.08); color: #ff6e40;
                            border: 1px solid rgba(255,110,64,0.22);
                            font-weight: 700; font-size: 11px; cursor: pointer; text-align: center;
                        "><i class="fas fa-align-center" style="margin-right:4px;"></i>Center</button>
                        <button class="cupcat-text-pos-btn" data-pos="bottom" style="
                            flex: 1; padding: 10px 6px; border-radius: 8px;
                            background: rgba(255,110,64,0.08); color: #ff6e40;
                            border: 1px solid rgba(255,110,64,0.22);
                            font-weight: 700; font-size: 11px; cursor: pointer; text-align: center;
                        "><i class="fas fa-arrow-down" style="margin-right:4px;"></i>Bottom</button>
                    </div>
                </div>

                <div style="display: flex; gap: 12px; margin-bottom: 16px;">
                    <div style="flex: 1;">
                        <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Color</label>
                        <input id="cupcat-text-color" type="color" value="#ffffff" style="
                            width: 100%; height: 36px; border: none; border-radius: 8px;
                            cursor: pointer; background: rgba(255,255,255,0.05);
                        ">
                    </div>
                    <div style="flex: 1;">
                        <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Font</label>
                        <select id="cupcat-text-font" style="
                            width: 100%; box-sizing: border-box;
                            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
                            border-radius: 8px; padding: 8px; color: #fff; font-size: 13px; outline: none;
                        ">
                            <option value="Inter">Inter</option>
                            <option value="Arial">Arial</option>
                            <option value="Georgia">Georgia</option>
                            <option value="Impact">Impact</option>
                            <option value="Courier New">Courier New</option>
                        </select>
                    </div>
                </div>

                <div style="margin-bottom: 20px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Font size</label>
                    <input id="cupcat-text-fontsize" type="range" min="12" max="120" value="36" step="1" style="width: 100%; accent-color: #ff6e40;">
                    <div id="cupcat-text-fontsize-val" style="font-size: 14px; color: #ff6e40; text-align: center; margin-top: 4px; font-weight: 700;">36px</div>
                </div>

                <button id="cupcat-text-apply" style="
                    width: 100%; padding: 10px; border-radius: 10px;
                    background: linear-gradient(135deg, #ff6e40, #ff3d00);
                    color: #fff; font-weight: 700; border: none; cursor: pointer;
                    font-size: 14px;
                ">Apply</button>
            </div>
        </div>

        <!-- ADVANCED SUBTITLE INSPECTOR & MANAGER MODAL -->
        <div id="cupcat-sub-editor-modal" class="cupcat-modal-wrap" style="
            display: none; position: absolute; inset: 0;
            background: rgba(0,0,0,0.85);
            z-index: 210;
            flex-direction: column; align-items: center; justify-content: center;
            padding: 16px;
        ">
            <!-- Legacy alias container for compatibility -->
            <div id="cupcat-sub-manager-modal" style="display:none;"></div>

            <div style="
                background: #141424; border-radius: 18px; padding: 20px;
                width: 100%; max-width: 620px;
                box-shadow: 0 16px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08);
                display: flex; flex-direction: column;
                max-height: 92vh; overflow: hidden;
            ">
                <!-- Header -->
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-shrink: 0; gap: 10px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <div style="width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(135deg, rgba(0,188,212,0.2), rgba(0,150,136,0.2)); display: flex; align-items: center; justify-content: center;">
                            <i class="fas fa-closed-captioning" style="color: #00bcd4; font-size: 16px;"></i>
                        </div>
                        <div>
                            <div style="font-size: 15px; font-weight: 700; color: #fff;">Subtitles</div>
                            <div id="cupcat-sub-inspector-counter" style="font-size: 11px; color: #888; font-weight: 500;">Subtitle 1 of 1</div>
                        </div>
                    </div>

                    <!-- Sync All Toggle -->
                    <div style="display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.05); padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.08);">
                        <label style="font-size: 11px; color: #00e5ff; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px; user-select: none;">
                            <input id="cupcat-sub-sync-all-toggle" type="checkbox" checked style="accent-color: #00bcd4; cursor: pointer;">
                            Apply to all
                        </label>
                    </div>

                    <button id="cupcat-sub-manager-close" style="background: rgba(255,255,255,0.06); border: none; border-radius: 50%; width: 30px; height: 30px; color: #aaa; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center;"><i class="fas fa-times"></i></button>
                </div>

                <!-- Tab Navigation Bar -->
                <div style="display: flex; gap: 6px; margin-bottom: 14px; background: rgba(0,0,0,0.3); padding: 4px; border-radius: 12px; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.05);">
                    <button id="cupcat-sub-tab-text" style="flex: 1; padding: 7px 10px; border-radius: 8px; border: none; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.2s;">
                        <i class="fas fa-pen-alt"></i> Text
                    </button>
                    <button id="cupcat-sub-tab-style" style="flex: 1; padding: 7px 10px; border-radius: 8px; border: none; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.2s;">
                        <i class="fas fa-palette"></i> Style & Presets
                    </button>
                    <button id="cupcat-sub-tab-list" style="flex: 1; padding: 7px 10px; border-radius: 8px; border: none; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.2s;">
                        <i class="fas fa-list-ul"></i> Transcript (SRT)
                    </button>
                </div>

                <!-- Inspector Body Container -->
                <div id="cupcat-sub-editor-body" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; min-height: 0;">
                    
                    <!-- ============================================ -->
                    <!-- TAB 1: TEXT & TIMING INSPECTOR -->
                    <!-- ============================================ -->
                    <div id="cupcat-sub-panel-text" style="display: block;">
                        <!-- Prev / Next Navigation Header -->
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 8px;">
                            <div style="display: flex; gap: 6px;">
                                <button id="cupcat-sub-nav-prev" style="padding: 6px 12px; border-radius: 8px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                                    <i class="fas fa-chevron-left"></i> Prev
                                </button>
                                <button id="cupcat-sub-nav-next" style="padding: 6px 12px; border-radius: 8px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                                    Next <i class="fas fa-chevron-right"></i>
                                </button>
                            </div>
                            <button id="cupcat-sub-add-next" style="padding: 6px 12px; border-radius: 8px; background: rgba(0,188,212,0.15); border: 1px solid rgba(0,188,212,0.3); color: #00e5ff; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 5px;">
                                <i class="fas fa-plus"></i> Add Phrase
                            </button>
                        </div>

                        <!-- Main Textarea -->
                        <div style="margin-bottom: 12px;">
                            <textarea id="cupcat-sub-input-text" rows="3" placeholder="Type subtitle text here..." style="
                                width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.35);
                                border: 1.5px solid rgba(0,188,212,0.35); border-radius: 12px;
                                padding: 12px 14px; color: #fff; font-size: 15px; font-weight: 500;
                                line-height: 1.4; resize: vertical; outline: none; transition: border-color 0.2s;
                            "></textarea>
                        </div>

                        <!-- Timing Adjuster Box -->
                        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 12px; margin-bottom: 14px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <div style="font-size: 11px; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Subtitle Timing</div>
                                <div style="font-size: 11px; color: #00bcd4; font-weight: 600;">Duration: <span id="cupcat-sub-dur-val">2.5s</span></div>
                            </div>
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                                <!-- Start Time Controls -->
                                <div style="background: rgba(0,0,0,0.25); padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                                        <span style="font-size: 11px; color: #aaa;">Start:</span>
                                        <span id="cupcat-sub-start-val" style="font-size: 12px; font-weight: 700; color: #00e5ff; font-variant-numeric: tabular-nums;">0.0s</span>
                                    </div>
                                    <div style="display: flex; gap: 4px;">
                                        <button id="cupcat-sub-start-minus" style="flex: 1; padding: 4px; border-radius: 6px; background: rgba(255,255,255,0.06); border: none; color: #ccc; font-size: 10px; font-weight: 700; cursor: pointer;">-0.1s</button>
                                        <button id="cupcat-sub-start-plus" style="flex: 1; padding: 4px; border-radius: 6px; background: rgba(255,255,255,0.06); border: none; color: #ccc; font-size: 10px; font-weight: 700; cursor: pointer;">+0.1s</button>
                                        <button id="cupcat-sub-start-snap" title="Snap to playhead" style="padding: 4px 6px; border-radius: 6px; background: rgba(0,188,212,0.15); border: none; color: #00bcd4; font-size: 10px; cursor: pointer;"><i class="fas fa-crosshairs"></i></button>
                                    </div>
                                </div>

                                <!-- End Time Controls -->
                                <div style="background: rgba(0,0,0,0.25); padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                                        <span style="font-size: 11px; color: #aaa;">End:</span>
                                        <span id="cupcat-sub-end-val" style="font-size: 12px; font-weight: 700; color: #ff5252; font-variant-numeric: tabular-nums;">2.5s</span>
                                    </div>
                                    <div style="display: flex; gap: 4px;">
                                        <button id="cupcat-sub-end-minus" style="flex: 1; padding: 4px; border-radius: 6px; background: rgba(255,255,255,0.06); border: none; color: #ccc; font-size: 10px; font-weight: 700; cursor: pointer;">-0.1s</button>
                                        <button id="cupcat-sub-end-plus" style="flex: 1; padding: 4px; border-radius: 6px; background: rgba(255,255,255,0.06); border: none; color: #ccc; font-size: 10px; font-weight: 700; cursor: pointer;">+0.1s</button>
                                        <button id="cupcat-sub-end-snap" title="Snap to playhead" style="padding: 4px 6px; border-radius: 6px; background: rgba(255,82,82,0.15); border: none; color: #ff5252; font-size: 10px; cursor: pointer;"><i class="fas fa-crosshairs"></i></button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Action Tools -->
                        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
                            <button id="cupcat-sub-btn-split" style="padding: 8px 6px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); color: #fff; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px;">
                                <i class="fas fa-cut" style="color: #ffd600;"></i> Split
                            </button>
                            <button id="cupcat-sub-btn-merge" style="padding: 8px 6px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); color: #fff; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px;">
                                <i class="fas fa-link" style="color: #00bcd4;"></i> Merge
                            </button>
                            <button id="cupcat-sub-btn-dup" style="padding: 8px 6px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); color: #fff; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px;">
                                <i class="fas fa-clone" style="color: #ce93d8;"></i> Duplicate
                            </button>
                            <button id="cupcat-sub-btn-del" style="padding: 8px 6px; border-radius: 10px; background: rgba(255,50,50,0.1); border: 1px solid rgba(255,50,50,0.25); color: #ff5252; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px;">
                                <i class="fas fa-trash-alt"></i> Delete
                            </button>
                        </div>
                    </div>

                    <!-- ============================================ -->
                    <!-- TAB 2: STYLES & PRESETS -->
                    <!-- ============================================ -->
                    <div id="cupcat-sub-panel-style" style="display: none;">
                        
                        <!-- CapCut Presets Grid -->
                        <div style="margin-bottom: 14px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <span style="font-size: 12px; font-weight: 700; color: #fff;">Style Presets (CapCut)</span>
                                <button id="cupcat-sub-copy-all-btn" style="padding: 4px 10px; border-radius: 8px; background: linear-gradient(135deg, #00bcd4, #009688); color: #fff; border: none; font-size: 11px; font-weight: 700; cursor: pointer;">
                                    ✨ Apply to All
                                </button>
                            </div>
                            <div id="cupcat-sub-presets-grid" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
                                <!-- JS injected preset cards -->
                            </div>
                        </div>

                        <!-- Typography & Font Section -->
                        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 12px; margin-bottom: 12px;">
                            <div style="font-size: 11px; font-weight: 700; color: #888; text-transform: uppercase; margin-bottom: 8px;">Font & Size</div>
                            <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                                <div style="flex: 1;">
                                    <select id="cupcat-sub-style-font" style="width: 100%; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 6px 10px; color: #fff; font-size: 13px; outline: none;">
                                        <option value="Inter">Inter (Modern)</option>
                                        <option value="Montserrat">Montserrat (TikTok)</option>
                                        <option value="Roboto">Roboto (Clean)</option>
                                        <option value="Oswald">Oswald (Condensed)</option>
                                        <option value="Bebas Neue">Bebas Neue (Headlines)</option>
                                        <option value="Impact">Impact (Memes)</option>
                                        <option value="Caveat">Caveat (Handwritten)</option>
                                        <option value="Georgia">Georgia (Serif)</option>
                                        <option value="Pacifico">Pacifico (Cursive)</option>
                                        <option value="Courier New">Courier (Monospace)</option>
                                    </select>
                                </div>
                                <div style="flex: 1;">
                                    <div style="display: flex; justify-content: space-between; font-size: 11px; color: #aaa; margin-bottom: 4px;">
                                        <span>Size:</span>
                                        <span id="cupcat-sub-style-size-val" style="color: #00e5ff; font-weight: 700;">24px</span>
                                    </div>
                                    <input id="cupcat-sub-style-size" type="range" min="12" max="96" value="24" step="1" style="width: 100%; accent-color: #00bcd4;">
                                </div>
                            </div>

                            <!-- Formatting Buttons & Alignment -->
                            <div style="display: flex; justify-content: space-between; gap: 8px;">
                                <div style="display: flex; gap: 4px;">
                                    <button id="cupcat-sub-format-bold" style="padding: 6px 12px; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-weight: 800; font-size: 12px; cursor: pointer;">B</button>
                                    <button id="cupcat-sub-format-italic" style="padding: 6px 12px; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-style: italic; font-size: 12px; cursor: pointer;">I</button>
                                    <button id="cupcat-sub-format-caps" style="padding: 6px 10px; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 11px; font-weight: 700; cursor: pointer;">AA</button>
                                </div>
                                <div style="display: flex; gap: 4px;">
                                    <button id="cupcat-sub-align-left" style="padding: 6px 10px; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 11px; cursor: pointer;"><i class="fas fa-align-left"></i></button>
                                    <button id="cupcat-sub-align-center" style="padding: 6px 10px; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 11px; cursor: pointer;"><i class="fas fa-align-center"></i></button>
                                    <button id="cupcat-sub-align-right" style="padding: 6px 10px; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 11px; cursor: pointer;"><i class="fas fa-align-right"></i></button>
                                </div>
                            </div>
                        </div>

                        <!-- Color & Background Pill Section -->
                        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 12px; margin-bottom: 12px;">
                            <div style="font-size: 11px; font-weight: 700; color: #888; text-transform: uppercase; margin-bottom: 8px;">Colors & Background</div>
                            <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 10px;">
                                <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
                                    <label style="font-size: 11px; color: #aaa;">Text:</label>
                                    <input id="cupcat-sub-style-color" type="color" value="#ffffff" style="width: 32px; height: 28px; border: none; border-radius: 6px; cursor: pointer; background: none;">
                                </div>
                                <div style="flex: 1; display: flex; align-items: center; gap: 8px;">
                                    <label style="font-size: 11px; color: #aaa;">Background:</label>
                                    <input id="cupcat-sub-style-bg-toggle" type="checkbox" checked style="accent-color: #00bcd4;">
                                    <input id="cupcat-sub-style-bgcolor" type="color" value="#000000" style="width: 32px; height: 28px; border: none; border-radius: 6px; cursor: pointer; background: none;">
                                </div>
                            </div>

                            <div style="display: flex; gap: 12px; margin-bottom: 6px;">
                                <div style="flex: 1;">
                                    <div style="display: flex; justify-content: space-between; font-size: 10px; color: #888; margin-bottom: 3px;">
                                        <span>Opacity:</span>
                                        <span id="cupcat-sub-style-bg-opacity-val">80%</span>
                                    </div>
                                    <input id="cupcat-sub-style-bg-opacity" type="range" min="0" max="100" value="80" step="5" style="width: 100%; accent-color: #00bcd4;">
                                </div>
                                <div style="flex: 1;">
                                    <div style="display: flex; justify-content: space-between; font-size: 10px; color: #888; margin-bottom: 3px;">
                                        <span>Radius:</span>
                                    </div>
                                    <input id="cupcat-sub-style-bg-radius" type="range" min="0" max="24" value="8" step="1" style="width: 100%; accent-color: #00bcd4;">
                                </div>
                            </div>
                        </div>

                        <!-- Stroke & Shadow Section -->
                        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 12px; margin-bottom: 12px;">
                            <div style="font-size: 11px; font-weight: 700; color: #888; text-transform: uppercase; margin-bottom: 8px;">Outline & Shadow</div>
                            <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 8px;">
                                <div style="flex: 1; display: flex; align-items: center; gap: 6px;">
                                    <input id="cupcat-sub-style-stroke-toggle" type="checkbox" style="accent-color: #00bcd4;">
                                    <label style="font-size: 11px; color: #aaa;">Outline:</label>
                                    <input id="cupcat-sub-style-stroke-color" type="color" value="#000000" style="width: 28px; height: 24px; border: none; border-radius: 4px; cursor: pointer; background: none;">
                                    <input id="cupcat-sub-style-stroke-width" type="range" min="1" max="8" value="3" step="1" style="flex: 1; accent-color: #00bcd4;">
                                    <span id="cupcat-sub-style-stroke-width-val" style="font-size: 10px; color: #00bcd4; width: 22px;">3px</span>
                                </div>
                                <div style="flex: 0 0 90px; display: flex; align-items: center; gap: 6px;">
                                    <input id="cupcat-sub-style-shadow-toggle" type="checkbox" style="accent-color: #00bcd4;">
                                    <label style="font-size: 11px; color: #aaa;">Shadow</label>
                                </div>
                            </div>
                        </div>

                        <!-- Position Presets -->
                        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 10px 12px;">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span style="font-size: 11px; font-weight: 700; color: #888; text-transform: uppercase;">Position:</span>
                                <div style="display: flex; gap: 6px;">
                                    <button id="cupcat-sub-pos-top" style="padding: 5px 10px; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 11px; cursor: pointer;">Top</button>
                                    <button id="cupcat-sub-pos-center" style="padding: 5px 10px; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 11px; cursor: pointer;">Center</button>
                                    <button id="cupcat-sub-pos-bottom" style="padding: 5px 10px; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; font-size: 11px; cursor: pointer;">Bottom</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- ============================================ -->
                    <!-- TAB 3: FULL TRANSCRIPT & SRT IMPORT/EXPORT -->
                    <!-- ============================================ -->
                    <div id="cupcat-sub-panel-list" style="display: none;">
                        
                        <!-- Search & Import / Export Controls -->
                        <div style="display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap;">
                            <input id="cupcat-sub-search-input" type="text" placeholder="🔍 Search subtitles..." style="flex: 1; min-width: 150px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 6px 10px; color: #fff; font-size: 12px; outline: none;">
                            
                            <input id="cupcat-sub-import-file" type="file" accept=".srt,.vtt,.txt" style="display: none;">
                            <button id="cupcat-sub-import-btn" style="padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #fff; font-size: 11px; font-weight: 600; cursor: pointer;">
                                <i class="fas fa-file-import"></i> Import
                            </button>
                            <button id="cupcat-sub-export-srt" style="padding: 6px 10px; border-radius: 8px; background: rgba(0,188,212,0.15); border: 1px solid rgba(0,188,212,0.3); color: #00bcd4; font-size: 11px; font-weight: 600; cursor: pointer;">
                                <i class="fas fa-file-download"></i> .SRT
                            </button>
                            <button id="cupcat-sub-export-vtt" style="padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #fff; font-size: 11px; font-weight: 600; cursor: pointer;">
                                .VTT
                            </button>
                        </div>

                        <!-- Transcript Rows List -->
                        <div id="cupcat-sub-transcript-list" style="flex: 1; max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; background: rgba(0,0,0,0.2); border-radius: 12px; padding: 10px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.05);">
                            <!-- JS injected transcript rows -->
                        </div>

                        <!-- Smart Generator Accordion / Box -->
                        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 10px;">
                            <div style="font-size: 11px; font-weight: 700; color: #00bcd4; margin-bottom: 6px;">Smart Auto-Split Subtitles</div>
                            <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                                <textarea id="cupcat-sub-smart-text" rows="2" placeholder="Paste continuous text here to auto-split..." style="flex: 1; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 6px; color: #fff; font-size: 11px; resize: none; outline: none;"></textarea>
                                <div style="display: flex; flex-direction: column; gap: 2px; width: 95px;">
                                    <label style="font-size: 9px; color: #888;">Max chars: <span id="cupcat-sub-smart-chars-val">32</span></label>
                                    <input id="cupcat-sub-smart-chars" type="range" min="10" max="60" value="32" step="1" style="accent-color: #00bcd4;">
                                    <label style="font-size: 9px; color: #888;">Duration: <span id="cupcat-sub-smart-dur-val">2.4s</span></label>
                                    <input id="cupcat-sub-smart-dur" type="range" min="1" max="5" value="2.4" step="0.2" style="accent-color: #00bcd4;">
                                </div>
                            </div>
                            <div style="display: flex; gap: 6px;">
                                <button id="cupcat-sub-smart-generate" style="flex: 1; padding: 7px; border-radius: 8px; background: linear-gradient(135deg, #00bcd4, #009688); color: #fff; font-weight: 700; border: none; cursor: pointer; font-size: 12px;">+ Generate Subtitles</button>
                                <button id="cupcat-sub-smart-clear" style="padding: 7px 12px; border-radius: 8px; background: rgba(255,50,50,0.1); color: #ff5252; border: 1px solid rgba(255,50,50,0.25); cursor: pointer; font-size: 12px;" title="Clear all subtitles"><i class="fas fa-trash-alt"></i></button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- OVERLAY / PiP MODAL -->
        <div id="cupcat-overlay-modal" style="
            display: none; position: absolute; inset: 0;
            background: rgba(0,0,0,0.85);
            z-index: 200;
            flex-direction: column; align-items: center; justify-content: center;
            padding: 20px;
        ">
            <div style="
                background: #1a1a2e; border-radius: 16px; padding: 24px;
                width: 100%; max-width: 440px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                max-height: 90vh; overflow-y: auto;
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <div style="font-size: 16px; font-weight: 700; color: #fff;"><i class="fas fa-layer-group" style="margin-right: 8px; color: #ce93d8;"></i>Overlay (PiP)</div>
                    <button id="cupcat-overlay-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;"><i class="fas fa-times"></i></button>
                </div>

                <input id="cupcat-overlay-file-input" type="file" accept="video/*,image/*" style="display: none;">
                <div id="cupcat-overlay-file-area" style="
                    margin-bottom: 16px; padding: 16px; border-radius: 10px;
                    border: 2px dashed rgba(206,147,216,0.3); text-align: center; cursor: pointer;
                    background: rgba(156,39,176,0.05); transition: all 0.2s;
                ">
                    <i class="fas fa-cloud-upload-alt" style="font-size: 24px; color: #ce93d8; margin-bottom: 6px; display: block;"></i>
                    <div id="cupcat-overlay-file-label" style="font-size: 12px; color: #aaa;">Click to select image or video file</div>
                </div>

                <div style="display: flex; gap: 12px; margin-bottom: 16px;">
                    <div style="flex: 1;">
                        <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Start (s)</label>
                        <input id="cupcat-overlay-start" type="number" min="0" step="0.1" value="0" style="
                            width: 100%; box-sizing: border-box;
                            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
                            border-radius: 8px; padding: 8px; color: #fff; font-size: 13px; outline: none;
                        ">
                    </div>
                    <div style="flex: 1;">
                        <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">End (s)</label>
                        <input id="cupcat-overlay-end" type="number" min="0" step="0.1" value="5" style="
                            width: 100%; box-sizing: border-box;
                            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
                            border-radius: 8px; padding: 8px; color: #fff; font-size: 13px; outline: none;
                        ">
                    </div>
                </div>

                <div style="margin-bottom: 16px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 8px;">Position preset</label>
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;">
                        <button class="cupcat-ovl-pos-btn" data-pos="top-left" style="padding: 8px 4px; border-radius: 8px; background: rgba(206,147,216,0.08); color: #ce93d8; border: 1px solid rgba(206,147,216,0.22); font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;">↖ Top-Left</button>
                        <button class="cupcat-ovl-pos-btn" data-pos="top-center" style="padding: 8px 4px; border-radius: 8px; background: rgba(206,147,216,0.08); color: #ce93d8; border: 1px solid rgba(206,147,216,0.22); font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;">↑ Top</button>
                        <button class="cupcat-ovl-pos-btn" data-pos="top-right" style="padding: 8px 4px; border-radius: 8px; background: rgba(206,147,216,0.08); color: #ce93d8; border: 1px solid rgba(206,147,216,0.22); font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;">↗ Top-Right</button>
                        <button class="cupcat-ovl-pos-btn" data-pos="center-left" style="padding: 8px 4px; border-radius: 8px; background: rgba(206,147,216,0.08); color: #ce93d8; border: 1px solid rgba(206,147,216,0.22); font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;">← Left</button>
                        <button class="cupcat-ovl-pos-btn" data-pos="center" style="padding: 8px 4px; border-radius: 8px; background: rgba(206,147,216,0.25); color: #ce93d8; border: 1px solid #ce93d8; font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;">⊙ Center</button>
                        <button class="cupcat-ovl-pos-btn" data-pos="center-right" style="padding: 8px 4px; border-radius: 8px; background: rgba(206,147,216,0.08); color: #ce93d8; border: 1px solid rgba(206,147,216,0.22); font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;">→ Right</button>
                        <button class="cupcat-ovl-pos-btn" data-pos="bottom-left" style="padding: 8px 4px; border-radius: 8px; background: rgba(206,147,216,0.08); color: #ce93d8; border: 1px solid rgba(206,147,216,0.22); font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;">↙ Bot-Left</button>
                        <button class="cupcat-ovl-pos-btn" data-pos="bottom-center" style="padding: 8px 4px; border-radius: 8px; background: rgba(206,147,216,0.08); color: #ce93d8; border: 1px solid rgba(206,147,216,0.22); font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;">↓ Bottom</button>
                        <button class="cupcat-ovl-pos-btn" data-pos="bottom-right" style="padding: 8px 4px; border-radius: 8px; background: rgba(206,147,216,0.08); color: #ce93d8; border: 1px solid rgba(206,147,216,0.22); font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;">↘ Bot-Right</button>
                    </div>
                </div>

                <div style="display: flex; gap: 12px; margin-bottom: 16px;">
                    <div style="flex: 1;">
                        <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">X position (%)</label>
                        <input id="cupcat-overlay-x" type="range" min="0" max="100" value="50" step="1" style="width: 100%; accent-color: #ce93d8;">
                        <div id="cupcat-overlay-x-val" style="font-size: 12px; color: #ce93d8; text-align: center; margin-top: 2px;">50%</div>
                    </div>
                    <div style="flex: 1;">
                        <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Y position (%)</label>
                        <input id="cupcat-overlay-y" type="range" min="0" max="100" value="50" step="1" style="width: 100%; accent-color: #ce93d8;">
                        <div id="cupcat-overlay-y-val" style="font-size: 12px; color: #ce93d8; text-align: center; margin-top: 2px;">50%</div>
                    </div>
                </div>

                <div style="margin-bottom: 16px;">
                    <div style="display: flex; justify-content: space-between; font-size: 12px; color: #ccc; margin-bottom: 4px;">
                        <span><i class="fas fa-expand-arrows-alt" style="margin-right: 6px; color: #ce93d8;"></i>Scale</span>
                        <span id="cupcat-overlay-scale-val" style="font-weight: 600; color: #ce93d8;">30%</span>
                    </div>
                    <input id="cupcat-overlay-scale" type="range" min="5" max="100" value="30" step="1" style="width: 100%; accent-color: #ce93d8;">
                </div>

                <div style="margin-bottom: 20px;">
                    <div style="display: flex; justify-content: space-between; font-size: 12px; color: #ccc; margin-bottom: 4px;">
                        <span><i class="fas fa-eye" style="margin-right: 6px; color: #ce93d8;"></i>Opacity</span>
                        <span id="cupcat-overlay-opacity-val" style="font-weight: 600; color: #ce93d8;">100%</span>
                    </div>
                    <input id="cupcat-overlay-opacity" type="range" min="0" max="100" value="100" step="1" style="width: 100%; accent-color: #ce93d8;">
                </div>

                <div style="display: flex; gap: 8px;">
                    <button id="cupcat-overlay-delete" style="
                        flex: 1; padding: 10px; border-radius: 10px;
                        background: rgba(255,82,82,0.10); color: #ff5252;
                        border: 1px solid rgba(255,82,82,0.25);
                        font-weight: 700; font-size: 13px; cursor: pointer; display: none;
                    "><i class="fas fa-trash" style="margin-right: 4px;"></i>Delete</button>
                    <button id="cupcat-overlay-apply" style="
                        flex: 2; padding: 10px; border-radius: 10px;
                        background: linear-gradient(135deg, #ce93d8, #ab47bc);
                        color: #fff; font-weight: 700; border: none; cursor: pointer;
                        font-size: 14px;
                    ">Add Overlay</button>
                </div>
            </div>
        </div>

        <!-- TRANSITION MODAL -->
        <div id="cupcat-transition-modal" style="
            display: none; position: absolute; inset: 0;
            background: rgba(0,0,0,0.85);
            z-index: 200;
            flex-direction: column; align-items: center; justify-content: center;
            padding: 20px;
        ">
            <div style="
                background: #1a1a2e; border-radius: 16px; padding: 24px;
                width: 100%; max-width: 380px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <div style="font-size: 16px; font-weight: 700; color: #fff;"><i class="fas fa-exchange-alt" style="margin-right: 8px; color: #ffab00;"></i>Transition</div>
                    <button id="cupcat-trans-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;"><i class="fas fa-times"></i></button>
                </div>

                <div style="margin-bottom: 16px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 8px;">Type</label>
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;">
                        <button class="cupcat-trans-type-btn" data-trans="none" data-active="true" style="
                            padding: 10px 4px; border-radius: 8px;
                            background: rgba(255,171,0,0.06); color: #ffab00;
                            border: 1px solid rgba(255,171,0,0.2);
                            font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;
                        "><i class="fas fa-cut" style="display:block;margin-bottom:3px;font-size:12px;"></i>None</button>
                        <button class="cupcat-trans-type-btn" data-trans="crossfade" data-active="false" style="
                            padding: 10px 4px; border-radius: 8px;
                            background: rgba(255,171,0,0.06); color: #ffab00;
                            border: 1px solid rgba(255,171,0,0.2);
                            font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;
                        "><i class="fas fa-adjust" style="display:block;margin-bottom:3px;font-size:12px;"></i>Crossfade</button>
                        <button class="cupcat-trans-type-btn" data-trans="fade-black" data-active="false" style="
                            padding: 10px 4px; border-radius: 8px;
                            background: rgba(255,171,0,0.06); color: #ffab00;
                            border: 1px solid rgba(255,171,0,0.2);
                            font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;
                        "><i class="fas fa-moon" style="display:block;margin-bottom:3px;font-size:12px;"></i>Fade Black</button>
                        <button class="cupcat-trans-type-btn" data-trans="wipe-left" data-active="false" style="
                            padding: 10px 4px; border-radius: 8px;
                            background: rgba(255,171,0,0.06); color: #ffab00;
                            border: 1px solid rgba(255,171,0,0.2);
                            font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;
                        "><i class="fas fa-arrow-left" style="display:block;margin-bottom:3px;font-size:12px;"></i>Wipe Left</button>
                        <button class="cupcat-trans-type-btn" data-trans="wipe-right" data-active="false" style="
                            padding: 10px 4px; border-radius: 8px;
                            background: rgba(255,171,0,0.06); color: #ffab00;
                            border: 1px solid rgba(255,171,0,0.2);
                            font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;
                        "><i class="fas fa-arrow-right" style="display:block;margin-bottom:3px;font-size:12px;"></i>Wipe Right</button>
                        <button class="cupcat-trans-type-btn" data-trans="dissolve" data-active="false" style="
                            padding: 10px 4px; border-radius: 8px;
                            background: rgba(255,171,0,0.06); color: #ffab00;
                            border: 1px solid rgba(255,171,0,0.2);
                            font-weight: 700; font-size: 10px; cursor: pointer; text-align: center;
                        "><i class="fas fa-water" style="display:block;margin-bottom:3px;font-size:12px;"></i>Dissolve</button>
                    </div>
                </div>

                <div style="margin-bottom: 20px;">
                    <label style="font-size: 12px; color: #888; display: block; margin-bottom: 6px;">Duration</label>
                    <input id="cupcat-trans-duration" type="range" min="0.2" max="2.0" value="0.5" step="0.1" style="width: 100%; accent-color: #ffab00;">
                    <div id="cupcat-trans-duration-val" style="font-size: 14px; color: #ffab00; text-align: center; margin-top: 4px; font-weight: 700;">0.5s</div>
                </div>

                <button id="cupcat-trans-apply" style="
                    width: 100%; padding: 10px; border-radius: 10px;
                    background: linear-gradient(135deg, #ffab00, #ff6d00);
                    color: #fff; font-weight: 700; border: none; cursor: pointer;
                    font-size: 14px;
                ">Apply</button>
            </div>
        </div>

        <!-- FILTERS / COLOR GRADING MODAL -->
        <div id="cupcat-filters-modal" style="
            display: none; position: absolute; inset: 0;
            background: rgba(0,0,0,0.85);
            z-index: 200;
            flex-direction: column; align-items: center; justify-content: center;
            padding: 20px;
        ">
            <div style="
                background: #1a1a2e; border-radius: 16px; padding: 24px;
                width: 100%; max-width: 440px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                max-height: 90vh; overflow-y: auto;
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                    <div style="font-size: 16px; font-weight: 700; color: #fff;">
                        <i class="fas fa-palette" style="margin-right: 8px; color: #ff4081;"></i>Filters & Color
                    </div>
                    <button id="cupcat-filters-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <!-- Presets -->
                <div style="margin-bottom: 18px;">
                    <label style="font-size: 11px; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.5px; display: block; margin-bottom: 8px;">
                        Presets
                    </label>
                    <div id="cupcat-filters-presets" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;">
                    </div>
                </div>

                <!-- Adjustments -->
                <div style="margin-bottom: 18px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 14px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <label style="font-size: 11px; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">
                            Adjustments
                        </label>
                        <button id="cupcat-filters-reset" style="
                            background: none; border: none; color: #ff4081; font-size: 11px; font-weight: 600; cursor: pointer;
                            padding: 2px 6px; border-radius: 4px;
                        "><i class="fas fa-undo-alt" style="margin-right: 4px;"></i>Reset</button>
                    </div>

                    <!-- Brightness -->
                    <div style="margin-bottom: 12px;">
                        <div style="display: flex; justify-content: space-between; font-size: 12px; color: #ccc; margin-bottom: 4px;">
                            <span><i class="fas fa-sun" style="margin-right: 6px; color: #ffd54f;"></i>Brightness</span>
                            <span id="cupcat-filter-val-brightness" style="font-weight: 600; color: #ffd54f;">0%</span>
                        </div>
                        <input id="cupcat-filter-brightness" type="range" min="-100" max="100" value="0" step="1" style="width: 100%; accent-color: #ffd54f;">
                    </div>

                    <!-- Contrast -->
                    <div style="margin-bottom: 12px;">
                        <div style="display: flex; justify-content: space-between; font-size: 12px; color: #ccc; margin-bottom: 4px;">
                            <span><i class="fas fa-adjust" style="margin-right: 6px; color: #4fc3f7;"></i>Contrast</span>
                            <span id="cupcat-filter-val-contrast" style="font-weight: 600; color: #4fc3f7;">100%</span>
                        </div>
                        <input id="cupcat-filter-contrast" type="range" min="0" max="200" value="100" step="1" style="width: 100%; accent-color: #4fc3f7;">
                    </div>

                    <!-- Saturation -->
                    <div style="margin-bottom: 12px;">
                        <div style="display: flex; justify-content: space-between; font-size: 12px; color: #ccc; margin-bottom: 4px;">
                            <span><i class="fas fa-tint" style="margin-right: 6px; color: #ff4081;"></i>Saturation</span>
                            <span id="cupcat-filter-val-saturation" style="font-weight: 600; color: #ff4081;">100%</span>
                        </div>
                        <input id="cupcat-filter-saturation" type="range" min="0" max="300" value="100" step="1" style="width: 100%; accent-color: #ff4081;">
                    </div>

                    <!-- Temperature / Hue -->
                    <div style="margin-bottom: 12px;">
                        <div style="display: flex; justify-content: space-between; font-size: 12px; color: #ccc; margin-bottom: 4px;">
                            <span><i class="fas fa-thermometer-half" style="margin-right: 6px; color: #ff8a65;"></i>Temperature / Hue</span>
                            <span id="cupcat-filter-val-hue" style="font-weight: 600; color: #ff8a65;">0°</span>
                        </div>
                        <input id="cupcat-filter-hue" type="range" min="-180" max="180" value="0" step="5" style="width: 100%; accent-color: #ff8a65;">
                    </div>
                </div>

                <button id="cupcat-filters-apply" style="
                    width: 100%; padding: 10px; border-radius: 10px;
                    background: linear-gradient(135deg, #ff4081, #e91e63);
                    color: #fff; font-weight: 700; border: none; cursor: pointer;
                    font-size: 14px;
                ">Apply</button>
            </div>
        </div>

        <!-- TRANSFORM (ROTATE & FLIP) MODAL -->
        <div id="cupcat-transform-modal" style="
            position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(8px);
            display: none; align-items: center; justify-content: center; z-index: 1000;
        ">
            <div style="
                background: #1e1e28; border: 1px solid rgba(0,229,255,0.3); border-radius: 16px;
                padding: 24px; width: 380px; max-width: 90vw;
                box-shadow: 0 20px 40px rgba(0,0,0,0.6);
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <div style="font-size: 16px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-sync-alt" style="color: #00e5ff;"></i> Rotate & Flip
                    </div>
                    <button id="cupcat-transform-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <!-- Rotation Section -->
                <div style="margin-bottom: 18px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <span style="font-size: 12px; font-weight: 600; color: #ccc;">Rotation Angle</span>
                        <span id="cupcat-transform-val-rotation" style="font-size: 12px; font-weight: 700; color: #00e5ff;">0°</span>
                    </div>
                    
                    <!-- Quick rotate buttons (-90, +90) -->
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
                        <button id="cupcat-rot-left" style="
                            display: flex; align-items: center; justify-content: center; gap: 6px;
                            padding: 8px 12px; border-radius: 8px;
                            background: rgba(255,255,255,0.04); color: #fff;
                            border: 1px solid rgba(255,255,255,0.1); font-size: 12px; font-weight: 600;
                            cursor: pointer; transition: all 0.15s ease;
                        ">
                            <i class="fas fa-undo"></i> -90° Left
                        </button>
                        <button id="cupcat-rot-right" style="
                            display: flex; align-items: center; justify-content: center; gap: 6px;
                            padding: 8px 12px; border-radius: 8px;
                            background: rgba(255,255,255,0.04); color: #fff;
                            border: 1px solid rgba(255,255,255,0.1); font-size: 12px; font-weight: 600;
                            cursor: pointer; transition: all 0.15s ease;
                        ">
                            <i class="fas fa-redo"></i> +90° Right
                        </button>
                    </div>

                    <!-- Fixed angle presets (0, 90, 180, 270) -->
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;">
                        <button class="cupcat-rot-angle-btn" data-angle="0" style="padding: 6px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #bbb;">0°</button>
                        <button class="cupcat-rot-angle-btn" data-angle="90" style="padding: 6px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #bbb;">90°</button>
                        <button class="cupcat-rot-angle-btn" data-angle="180" style="padding: 6px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #bbb;">180°</button>
                        <button class="cupcat-rot-angle-btn" data-angle="270" style="padding: 6px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #bbb;">270°</button>
                    </div>
                </div>

                <!-- Flip / Mirror Section -->
                <div style="margin-bottom: 20px;">
                    <div style="font-size: 12px; font-weight: 600; color: #ccc; margin-bottom: 8px;">Flip & Mirror</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                        <button id="cupcat-flip-h" style="
                            display: flex; align-items: center; justify-content: center; gap: 8px;
                            padding: 10px; border-radius: 8px;
                            background: rgba(255,255,255,0.04); color: #ccc;
                            border: 1px solid rgba(255,255,255,0.1); font-size: 12px; font-weight: 600;
                            cursor: pointer; transition: all 0.15s ease;
                        ">
                            <i class="fas fa-arrows-alt-h" style="font-size: 14px;"></i> Flip H (↔)
                        </button>
                        <button id="cupcat-flip-v" style="
                            display: flex; align-items: center; justify-content: center; gap: 8px;
                            padding: 10px; border-radius: 8px;
                            background: rgba(255,255,255,0.04); color: #ccc;
                            border: 1px solid rgba(255,255,255,0.1); font-size: 12px; font-weight: 600;
                            cursor: pointer; transition: all 0.15s ease;
                        ">
                            <i class="fas fa-arrows-alt-v" style="font-size: 14px;"></i> Flip V (↕)
                        </button>
                    </div>
                </div>

                <!-- Reset button -->
                <div style="margin-bottom: 16px;">
                    <button id="cupcat-transform-reset" style="
                        width: 100%; padding: 8px; border-radius: 8px;
                        background: rgba(255,255,255,0.03); color: #aaa;
                        border: 1px dashed rgba(255,255,255,0.15); font-size: 11px; font-weight: 600;
                        cursor: pointer; transition: all 0.15s ease;
                    ">
                        <i class="fas fa-undo-alt" style="margin-right: 4px;"></i> Reset Transform
                    </button>
                </div>

                <button id="cupcat-transform-apply" style="
                    width: 100%; padding: 10px; border-radius: 10px;
                    background: linear-gradient(135deg, #00e5ff, #00b0ff);
                    color: #111; font-weight: 700; border: none; cursor: pointer;
                    font-size: 14px;
                ">Apply</button>
            </div>
        </div>

        <!-- STICKERS & EMOJI MODAL -->
        <div id="cupcat-stickers-modal" style="
            position: fixed; inset: 0; background: rgba(0,0,0,0.75); backdrop-filter: blur(10px);
            display: none; align-items: center; justify-content: center; z-index: 1000;
        ">
            <div style="
                background: #181828; border: 1px solid rgba(255,193,7,0.3); border-radius: 18px;
                padding: 24px; width: 460px; max-width: 92vw; max-height: 85vh;
                box-shadow: 0 24px 48px rgba(0,0,0,0.7); display: flex; flex-direction: column;
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                    <div style="font-size: 17px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-smile" style="color: #ffb300;"></i> Stickers & Emojis
                    </div>
                    <button id="cupcat-stickers-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <!-- Category Tabs -->
                <div style="display: flex; gap: 6px; margin-bottom: 14px; overflow-x: auto; padding-bottom: 4px;" id="cupcat-sticker-tabs">
                    <button class="cupcat-sticker-tab active" data-cat="popular" style="
                        padding: 6px 12px; border-radius: 16px; font-size: 12px; font-weight: 600; cursor: pointer;
                        background: rgba(255,193,7,0.25); border: 1px solid #ffb300; color: #ffb300; white-space: nowrap;
                    ">🔥 Popular</button>
                    <button class="cupcat-sticker-tab" data-cat="vlog" style="
                        padding: 6px 12px; border-radius: 16px; font-size: 12px; font-weight: 600; cursor: pointer;
                        background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #ccc; white-space: nowrap;
                    ">🎙️ Vlog</button>
                    <button class="cupcat-sticker-tab" data-cat="badges" style="
                        padding: 6px 12px; border-radius: 16px; font-size: 12px; font-weight: 600; cursor: pointer;
                        background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #ccc; white-space: nowrap;
                    ">💥 Badges</button>
                    <button class="cupcat-sticker-tab" data-cat="fun" style="
                        padding: 6px 12px; border-radius: 16px; font-size: 12px; font-weight: 600; cursor: pointer;
                        background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #ccc; white-space: nowrap;
                    ">🐱 Fun</button>
                </div>

                <!-- Grid of Emojis -->
                <div id="cupcat-stickers-grid" style="
                    display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px;
                    max-height: 280px; overflow-y: auto; padding: 4px; margin-bottom: 16px;
                "></div>

                <div style="font-size: 11px; color: #888; text-align: center;">
                    💡 Click any sticker to add to timeline. Animate it with keyframes (◆) or drag on preview!
                </div>
            </div>
        </div>

        <!-- KEYFRAME MOTION PRESETS & MANAGER MODAL -->
        <div id="cupcat-kf-modal" style="
            position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(5px);
            display: none; flex-direction: column; justify-content: flex-end; z-index: 1000;
        ">
            <div style="
                background: #181828; border-top: 1px solid rgba(255,215,0,0.35); border-radius: 24px 24px 0 0;
                padding: 22px 22px 34px 22px; width: 100%; max-height: 85vh; overflow-y: auto;
                box-shadow: 0 -10px 40px rgba(0,0,0,0.8);
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
                    <div style="font-size: 16px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-gem" style="color: #ffd700;"></i> Keyframe Motion & Presets
                    </div>
                    <button id="cupcat-kf-modal-close" style="background: none; border: none; color: #aaa; font-size: 18px; cursor: pointer;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <div id="cupcat-kf-target-badge" style="
                    background: rgba(255,215,0,0.12); border: 1px solid rgba(255,215,0,0.25);
                    border-radius: 8px; padding: 6px 12px; font-size: 12px; color: #ffd700;
                    margin-bottom: 14px; font-weight: 600; display: flex; justify-content: space-between; align-items: center;
                ">
                    <span id="cupcat-kf-target-name">Target: None selected</span>
                    <span id="cupcat-kf-count-label" style="font-size: 11px; opacity: 0.8;">0 Keyframes</span>
                </div>

                <!-- 1-Click Cinematic Presets -->
                <div style="margin-bottom: 14px;">
                    <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #aaa; letter-spacing: 0.5px; margin-bottom: 8px;">
                        ⚡ 1-Click Motion Presets
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;">
                        <button class="cupcat-kf-preset-btn" data-preset="slide-lr" style="
                            padding: 8px 6px; border-radius: 8px; background: rgba(255,255,255,0.04);
                            border: 1px solid rgba(255,255,255,0.1); color: #e0e0e0; font-size: 11px; font-weight: 600;
                            cursor: pointer; transition: all 0.15s ease; text-align: center;
                        ">↔ Slide L→R</button>
                        <button class="cupcat-kf-preset-btn" data-preset="zoom-in" style="
                            padding: 8px 6px; border-radius: 8px; background: rgba(255,255,255,0.04);
                            border: 1px solid rgba(255,255,255,0.1); color: #e0e0e0; font-size: 11px; font-weight: 600;
                            cursor: pointer; transition: all 0.15s ease; text-align: center;
                        ">🔍 Zoom In</button>
                        <button class="cupcat-kf-preset-btn" data-preset="zoom-out" style="
                            padding: 8px 6px; border-radius: 8px; background: rgba(255,255,255,0.04);
                            border: 1px solid rgba(255,255,255,0.1); color: #e0e0e0; font-size: 11px; font-weight: 600;
                            cursor: pointer; transition: all 0.15s ease; text-align: center;
                        ">🔎 Zoom Out</button>
                        <button class="cupcat-kf-preset-btn" data-preset="spin-grow" style="
                            padding: 8px 6px; border-radius: 8px; background: rgba(255,255,255,0.04);
                            border: 1px solid rgba(255,255,255,0.1); color: #e0e0e0; font-size: 11px; font-weight: 600;
                            cursor: pointer; transition: all 0.15s ease; text-align: center;
                        ">🌀 Spin & Grow</button>
                        <button class="cupcat-kf-preset-btn" data-preset="bounce" style="
                            padding: 8px 6px; border-radius: 8px; background: rgba(255,255,255,0.04);
                            border: 1px solid rgba(255,255,255,0.1); color: #e0e0e0; font-size: 11px; font-weight: 600;
                            cursor: pointer; transition: all 0.15s ease; text-align: center;
                        ">🦘 Bounce / Float</button>
                        <button class="cupcat-kf-preset-btn" data-preset="fade" style="
                            padding: 8px 6px; border-radius: 8px; background: rgba(255,255,255,0.04);
                            border: 1px solid rgba(255,255,255,0.1); color: #e0e0e0; font-size: 11px; font-weight: 600;
                            cursor: pointer; transition: all 0.15s ease; text-align: center;
                        ">🌫️ Fade In/Out</button>
                    </div>
                </div>

                <!-- Active Keyframe Slider Adjustments -->
                <div style="background: rgba(0,0,0,0.3); border-radius: 12px; padding: 12px; margin-bottom: 14px; border: 1px solid rgba(255,255,255,0.06);">
                    <div style="font-size: 11px; font-weight: 700; color: #ffd700; margin-bottom: 10px; display: flex; justify-content: space-between;">
                        <span>💎 Keyframe Properties at <strong id="cupcat-kf-playhead-time">0.0s</strong></span>
                        <span id="cupcat-kf-status-badge" style="color: #00e676; font-size: 10px;">◆ Active Pin</span>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
                        <div>
                            <div style="display: flex; justify-content: space-between; font-size: 13px; color: #aaa; margin-bottom: 6px;">
                                <span>Pos X</span><span id="cupcat-kf-val-posx" style="color: #fff;">50%</span>
                            </div>
                            <input type="range" id="cupcat-kf-slider-posx" min="0" max="100" value="50" style="width: 100%; height: 32px; accent-color: #ffd700;">
                        </div>
                        <div>
                            <div style="display: flex; justify-content: space-between; font-size: 13px; color: #aaa; margin-bottom: 6px;">
                                <span>Pos Y</span><span id="cupcat-kf-val-posy" style="color: #fff;">50%</span>
                            </div>
                            <input type="range" id="cupcat-kf-slider-posy" min="0" max="100" value="50" style="width: 100%; height: 32px; accent-color: #ffd700;">
                        </div>
                        <div>
                            <div style="display: flex; justify-content: space-between; font-size: 13px; color: #aaa; margin-bottom: 6px;">
                                <span>Scale</span><span id="cupcat-kf-val-scale" style="color: #fff;">30%</span>
                            </div>
                            <input type="range" id="cupcat-kf-slider-scale" min="5" max="300" value="30" style="width: 100%; height: 32px; accent-color: #ffd700;">
                        </div>
                        <div>
                            <div style="display: flex; justify-content: space-between; font-size: 13px; color: #aaa; margin-bottom: 6px;">
                                <span>Rotation</span><span id="cupcat-kf-val-rot" style="color: #fff;">0°</span>
                            </div>
                            <input type="range" id="cupcat-kf-slider-rot" min="-360" max="360" value="0" style="width: 100%; height: 32px; accent-color: #ffd700;">
                        </div>
                    </div>
                </div>

                <div style="display: flex; gap: 8px;">
                    <button id="cupcat-kf-add-pin-btn" style="
                        flex: 1; padding: 12px; border-radius: 10px;
                        background: linear-gradient(135deg, #ffd700, #ffab00);
                        color: #111; font-weight: 700; border: none; cursor: pointer;
                        font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 6px;
                    "><i class="fas fa-plus"></i> Add Pin Here</button>
                    <button id="cupcat-kf-clear-btn" style="
                        flex: 1; padding: 12px; border-radius: 10px;
                        background: rgba(255,82,82,0.15); color: #ff5252; border: 1px solid rgba(255,82,82,0.3);
                        font-weight: 700; cursor: pointer; font-size: 13px;
                        display: flex; align-items: center; justify-content: center; gap: 6px;
                    "><i class="fas fa-trash"></i> Clear All</button>
                </div>
            </div>
        </div>
    </div>
    `;
    container.insertAdjacentHTML('beforeend', ui);

    // Merge edit toolbar on top of main toolbar on scroll/resize or just append it right after
    const toolbar = document.getElementById('cupcat-toolbar');
    const toolbarEdit = document.getElementById('cupcat-toolbar-edit');
    if (toolbar && toolbarEdit) {
        while (toolbarEdit.firstChild) {
            toolbar.appendChild(toolbarEdit.firstChild);
        }
    }

    state.dom.previewVideo = document.getElementById('cupcat-preview');
    state.dom.previewImg = document.getElementById('cupcat-preview-img');
    state.dom.mainCanvas = document.getElementById('cupcat-main-canvas');
    if (state.dom.mainCanvas) {
        state.dom.mainCtx = state.dom.mainCanvas.getContext('2d');
    }
    if (cb.renderTimeline) cb.renderTimeline();
    if (cb.updateEmptyState) cb.updateEmptyState();
    if (cb.updateImageSettingsButton) cb.updateImageSettingsButton();

    // Inject Ken Burns CSS keyframes once
    if (!document.getElementById('cupcat-kb-styles')) {
        const kbStyle = document.createElement('style');
        kbStyle.id = 'cupcat-kb-styles';
        kbStyle.textContent = `
            @keyframes cupcat-kb-zoom-in {
                0% { transform: scale(1); }
                100% { transform: scale(1.3); }
            }
            @keyframes cupcat-kb-zoom-out {
                0% { transform: scale(1.3); }
                100% { transform: scale(1); }
            }
            @keyframes cupcat-kb-pan-left {
                0% { transform: scale(1.2) translateX(5%); }
                100% { transform: scale(1.2) translateX(-5%); }
            }
            @keyframes cupcat-kb-pan-right {
                0% { transform: scale(1.2) translateX(-5%); }
                100% { transform: scale(1.2) translateX(5%); }
            }
        `;
        document.head.appendChild(kbStyle);
    }

    // Inject toolbar interaction styles
    if (!document.getElementById('cupcat-toolbar-styles')) {
        const tbStyle = document.createElement('style');
        tbStyle.id = 'cupcat-toolbar-styles';
        tbStyle.textContent = `
            /* Hide scrollbar on both toolbar rows */
            #cupcat-toolbar::-webkit-scrollbar,
            #cupcat-toolbar-edit::-webkit-scrollbar {
                display: none;
            }
            /* Hover effect — brightness only, no transform (transform breaks touch hit areas on mobile) */
            #cupcat-toolbar .cupcat-tool-btn:hover,
            #cupcat-toolbar-edit .cupcat-tool-btn:hover {
                filter: brightness(1.35);
            }
            #cupcat-toolbar .cupcat-tool-btn:active,
            #cupcat-toolbar-edit .cupcat-tool-btn:active {
                filter: brightness(0.8);
                opacity: 0.85;
            }
        `;
        document.head.appendChild(tbStyle);
    }

    if (cb.updateCanvasBox) cb.updateCanvasBox();
    if (cb.updateUndoRedoButtons) cb.updateUndoRedoButtons();
}

export function bindEvents() {
    // Back button — close editor and return to tools hub (or close APK if running native)
    document.getElementById('cupcat-back').addEventListener('click', () => {
        // If running inside native Android APK wrapper, close the app and return to PWA
        if (window.NativeBack && typeof window.NativeBack.closeApp === 'function') {
            window.NativeBack.closeApp();
            return;
        }
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
            window.Capacitor.Plugins.App.minimizeApp();
            return;
        }

        // Stop any playback
        if (typeof stopPlaybackSafe === 'function') stopPlaybackSafe();
        // Clean up object URLs
        if (state.videoClips) state.videoClips.forEach(c => { if (c.objectUrl) URL.revokeObjectURL(c.objectUrl); });
        if (state.audioTracks) state.audioTracks.forEach(a => { if (a.objectUrl) URL.revokeObjectURL(a.objectUrl); });
        if (state.overlayTracks) state.overlayTracks.forEach(o => { if (o.objectUrl) URL.revokeObjectURL(o.objectUrl); });
        // Remove keyboard listener
        document.removeEventListener('keydown', handleEditorKeyDown);
        // Remove editor UI
        const ed = document.getElementById('cupcat-editor');
        if (ed) ed.remove();
        // Ensure tools module is visible (navigate back to tools)
        const toolsModule = document.getElementById('module-tools');
        if (toolsModule) toolsModule.classList.remove('hidden');
        // Also call cb.closeEditor if it was set externally
        if (cb.closeEditor) cb.closeEditor();
    });

    // Undo / Redo
    document.getElementById('cupcat-undo-btn').addEventListener('click', undo);
    document.getElementById('cupcat-redo-btn').addEventListener('click', redo);
    document.removeEventListener('keydown', handleEditorKeyDown);
    document.addEventListener('keydown', handleEditorKeyDown);

    // Title
    document.getElementById('cupcat-title').addEventListener('change', (e) => {
        state.docTitle = e.target.value;
        if (cb.saveDocument) cb.saveDocument();
    });

    // Add video
    document.getElementById('cupcat-add-video-btn').addEventListener('click', () => {
        document.getElementById('cupcat-file-input').click();
    });

    document.getElementById('cupcat-file-input').addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (files.length > 0) pushHistory();
        for (const file of files) {
            const { duration, url, isImage, videoWidth, videoHeight } = await getMediaDuration(file);

            // Immediately copy file data into a memory-backed Blob.
            // Android WebView can invalidate the original File's content:// URI
            // after the file picker closes, making it unreadable during export.
            let preservedFile = file;
            let preservedUrl = url;
            try {
                const ab = await file.arrayBuffer();
                preservedFile = new File([ab], file.name, { type: file.type || 'video/mp4' });
                URL.revokeObjectURL(url); // revoke the old blob URL
                preservedUrl = URL.createObjectURL(preservedFile);
            } catch (e) {
                console.warn('[CupCat] Could not preserve file data, using original File reference:', e);
            }

            state.videoClips.push({
                id: generateId(),
                file: preservedFile,
                name: file.name,
                objectUrl: preservedUrl,
                duration: duration,
                startTrim: 0,
                endTrim: 0,
                volume: 1,
                muted: false,
                speed: 1,
                fadeIn: 0,
                fadeOut: 0,
                isImage: !!isImage,
                kenBurns: 'none',
                rotation: 0,
                flipH: false,
                flipV: false,
                filters: { preset: 'none', brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0 },
            });

            // Auto-detect canvas aspect ratio from the FIRST video added.
            // Like CapCut: use the source video's EXACT ratio so export matches
            // the original with zero cropping and zero letterboxing by default.
            if (state.videoClips.length === 1 && !isImage && videoWidth > 0 && videoHeight > 0) {
                const ratio = videoWidth / videoHeight;

                // Check if any standard preset is close enough (within 3%)
                const presetRatios = {
                    '21:9': 21/9, '16:9': 16/9, '4:3': 4/3, '1:1': 1,
                    '4:5': 4/5, '3:4': 3/4, '9:16': 9/16
                };
                let bestAspect = null;
                let bestDiff = Infinity;
                for (const [name, val] of Object.entries(presetRatios)) {
                    const diff = Math.abs(ratio - val) / val; // relative difference
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        bestAspect = name;
                    }
                }

                // If closest preset differs by >3%, create a custom aspect from exact video dimensions
                if (bestDiff > 0.03) {
                    // Compute GCD-reduced ratio for a clean label (e.g., 1080:2400 → 9:20)
                    const _gcd = (a, b) => b === 0 ? a : _gcd(b, a % b);
                    const g = _gcd(videoWidth, videoHeight);
                    const rW = videoWidth / g;
                    const rH = videoHeight / g;
                    const customKey = `${rW}:${rH}`;

                    // Dynamically add to CANVAS_ASPECTS
                    if (!CANVAS_ASPECTS[customKey]) {
                        const previewScale = Math.min(1280 / videoWidth, 1280 / videoHeight, 1);
                        CANVAS_ASPECTS[customKey] = {
                            w: Math.round(videoWidth * previewScale),
                            h: Math.round(videoHeight * previewScale),
                            sub: `Source · ${videoWidth}×${videoHeight}`
                        };
                    }

                    // Dynamically add to EXPORT_RESOLUTIONS
                    if (!EXPORT_RESOLUTIONS[customKey]) {
                        const isPortrait = ratio < 1;
                        const makeDims = (shortSide) => {
                            let w, h;
                            if (isPortrait) { w = shortSide; h = Math.round(shortSide / ratio); }
                            else { h = shortSide; w = Math.round(shortSide * ratio); }
                            if (w % 2 !== 0) w += 1;
                            if (h % 2 !== 0) h += 1;
                            return { w, h };
                        };
                        const d1080 = makeDims(1080);
                        const d720 = makeDims(720);
                        const d480 = makeDims(480);
                        EXPORT_RESOLUTIONS[customKey] = {
                            '1080p': { ...d1080, label: '1080p Full HD', desc: `${d1080.w}×${d1080.h} · High clarity` },
                            '720p': { ...d720, label: '720p HD', desc: `${d720.w}×${d720.h} · Recommended` },
                            '480p': { ...d480, label: '480p SD', desc: `${d480.w}×${d480.h} · Fast draft` }
                        };
                    }

                    bestAspect = customKey;
                }

                if (bestAspect !== state.canvasAspect) {
                    state.canvasAspect = bestAspect;
                    const label = document.getElementById('cupcat-ratio-btn-label');
                    if (label) label.textContent = state.canvasAspect;
                    if (cb.updateCanvasBox) cb.updateCanvasBox();
                }
            }
        }
        e.target.value = '';
        if (cb.renderTimeline) cb.renderTimeline();
        if (cb.updateEmptyState) cb.updateEmptyState();
        if (cb.updatePreview) cb.updatePreview();
        if (cb.updateImageSettingsButton) cb.updateImageSettingsButton();
        if (cb.saveDocument) cb.saveDocument();
    });

    // Add audio
    document.getElementById('cupcat-add-audio-btn').addEventListener('click', () => {
        document.getElementById('cupcat-audio-input').click();
    });

    document.getElementById('cupcat-audio-input').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        pushHistory();
        const { duration, url } = await getMediaDuration(file);

        // Preserve audio file data in memory (same reason as video — content:// can expire)
        let preservedFile = file;
        let preservedUrl = url;
        try {
            const ab = await file.arrayBuffer();
            preservedFile = new File([ab], file.name, { type: file.type || 'audio/mpeg' });
            URL.revokeObjectURL(url);
            preservedUrl = URL.createObjectURL(preservedFile);
        } catch (e) {
            console.warn('[CupCat] Could not preserve audio file data:', e);
        }

        state.audioTracks.push({
            id: generateId(),
            file: preservedFile,
            name: file.name,
            objectUrl: preservedUrl,
            duration: duration,
            startTrim: 0,
            endTrim: 0,
            offset: 0,
            volume: 1,
            muted: false,
            speed: 1,
            fadeIn: 0,
            fadeOut: 0,
        });
        e.target.value = '';
        if (cb.renderTimeline) cb.renderTimeline();
        if (cb.saveDocument) cb.saveDocument();
    });

    // Split
    document.getElementById('cupcat-split-btn').addEventListener('click', cb.splitAtPlayhead);

    // Delete
    document.getElementById('cupcat-delete-btn').addEventListener('click', cb.deleteSelected);

    // Duplicate
    const dupBtn = document.getElementById('cupcat-duplicate-btn');
    if (dupBtn) dupBtn.addEventListener('click', cb.duplicateSelected);

    // Extract Audio
    const extAudioBtn = document.getElementById('cupcat-extract-audio-btn');
    if (extAudioBtn) extAudioBtn.addEventListener('click', cb.extractAudioFromSelected);

    // Freeze Frame
    const freezeBtn = document.getElementById('cupcat-freeze-btn');
    if (freezeBtn) freezeBtn.addEventListener('click', cb.openFreezeModal);

    // Reverse
    const revBtn = document.getElementById('cupcat-reverse-btn');
    if (revBtn) revBtn.addEventListener('click', cb.openReverseModal);

    // Crop
    document.getElementById('cupcat-crop-btn').addEventListener('click', cb.toggleCropMode);

    // Volume
    document.getElementById('cupcat-volume-btn').addEventListener('click', cb.openVolumeModal);

    // Speed
    document.getElementById('cupcat-speed-btn').addEventListener('click', cb.openSpeedModal);

    // Image settings
    document.getElementById('cupcat-imgset-btn').addEventListener('click', cb.openImageSettingsModal);

    // Ratio
    document.getElementById('cupcat-ratio-btn').addEventListener('click', cb.openRatioModal);

    // Play
    document.getElementById('cupcat-play-btn').addEventListener('click', cb.togglePlay);

    // Zoom
    document.getElementById('cupcat-zoom-in').addEventListener('click', () => {
        state.timelineZoom = Math.min(300, state.timelineZoom + 20);
        if (cb.renderTimeline) cb.renderTimeline();
    });
    document.getElementById('cupcat-zoom-out').addEventListener('click', () => {
        state.timelineZoom = Math.max(20, state.timelineZoom - 20);
        if (cb.renderTimeline) cb.renderTimeline();
    });

    // Export
    document.getElementById('cupcat-export').addEventListener('click', cb.openExportSettingsModal);
    document.getElementById('cupcat-export-settings-close').addEventListener('click', cb.closeExportSettingsModal);
    document.getElementById('cupcat-export-cancel-btn').addEventListener('click', cb.closeExportSettingsModal);
    document.getElementById('cupcat-export-start-btn').addEventListener('click', () => {
        if (cb.closeExportSettingsModal) cb.closeExportSettingsModal();
        if (cb.exportVideo) cb.exportVideo();
    });

    // New feature buttons
    document.getElementById('cupcat-screenshot-btn').addEventListener('click', () => {
        if (cb.closeExportSettingsModal) cb.closeExportSettingsModal();
        if (cb.exportScreenshot) cb.exportScreenshot();
    });
    document.getElementById('cupcat-audio-export-btn').addEventListener('click', () => {
        if (cb.closeExportSettingsModal) cb.closeExportSettingsModal();
        if (cb.exportAudioOnly) cb.exportAudioOnly();
    });
    document.getElementById('cupcat-share-btn').addEventListener('click', () => {
        if (cb.shareLastExport) cb.shareLastExport();
    });
    document.getElementById('cupcat-gif-export-btn').addEventListener('click', () => {
        if (cb.closeExportSettingsModal) cb.closeExportSettingsModal();
        if (cb.exportGif) cb.exportGif();
    });
    document.getElementById('cupcat-boomerang-btn').addEventListener('click', () => {
        if (cb.closeExportSettingsModal) cb.closeExportSettingsModal();
        if (cb.exportBoomerang) cb.exportBoomerang();
    });

    document.querySelectorAll('.cupcat-export-res-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (cb.setExportResolution) cb.setExportResolution(btn.dataset.res);
        });
    });

    document.querySelectorAll('.cupcat-export-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (cb.setExportSpeedPreset) cb.setExportSpeedPreset(btn.dataset.preset);
        });
    });

    document.querySelectorAll('.cupcat-export-quality-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (cb.setExportQuality) cb.setExportQuality(btn.dataset.quality);
        });
    });


    // Timeline click for playhead
    const tracksScroll = document.getElementById('cupcat-tracks-scroll');
    tracksScroll.addEventListener('click', (e) => {
        if (e.target === tracksScroll || e.target.id === 'cupcat-tracks-inner') {
            const rect = document.getElementById('cupcat-tracks-inner').getBoundingClientRect();
            const x = e.clientX - rect.left;
            state.playheadTime = Math.max(0, x / state.timelineZoom);
            if (cb.updatePlayhead) cb.updatePlayhead();
            if (cb.updatePreviewAtTime) cb.updatePreviewAtTime(state.playheadTime);
        }
    });

    // Ruler drag-scrub
    const ruler = document.getElementById('cupcat-ruler');
    if (cb.bindRulerDrag) cb.bindRulerDrag(ruler);

    // Playhead handle drag
    if (cb.bindPlayheadDrag) cb.bindPlayheadDrag();

    // Sync scroll between ruler and tracks
    tracksScroll.addEventListener('scroll', () => {
        document.getElementById('cupcat-ruler').scrollLeft = tracksScroll.scrollLeft;
    });

    // Volume modal
    document.getElementById('cupcat-volume-close').addEventListener('click', cb.closeVolumeModal);
    document.getElementById('cupcat-volume-apply').addEventListener('click', cb.applyVolume);
    document.getElementById('cupcat-volume-mute-toggle').addEventListener('click', cb.toggleVolumeModalMute);
    document.getElementById('cupcat-volume-slider').addEventListener('input', cb.updateVolumeModalLabel);
    document.getElementById('cupcat-volume-fadein-slider').addEventListener('input', cb.updateVolumeModalFadeLabels);
    document.getElementById('cupcat-volume-fadeout-slider').addEventListener('input', cb.updateVolumeModalFadeLabels);

    // Speed modal
    document.getElementById('cupcat-speed-close').addEventListener('click', cb.closeSpeedModal);
    document.getElementById('cupcat-speed-apply').addEventListener('click', cb.applySpeed);
    document.getElementById('cupcat-speed-slider').addEventListener('input', () => {
        if (cb.updateSpeedModalLabel) cb.updateSpeedModalLabel();
        if (cb.updateSpeedPreviewInfo) cb.updateSpeedPreviewInfo();
    });
    document.querySelectorAll('.cupcat-speed-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            const v = parseFloat(btn.dataset.speed);
            document.getElementById('cupcat-speed-slider').value = v;
            if (cb.updateSpeedModalLabel) cb.updateSpeedModalLabel();
            if (cb.updateSpeedPreviewInfo) cb.updateSpeedPreviewInfo();
        });
    });

    // Freeze Frame modal
    const freezeClose = document.getElementById('cupcat-freeze-close');
    if (freezeClose) freezeClose.addEventListener('click', cb.closeFreezeModal);

    const freezeApply = document.getElementById('cupcat-freeze-apply');
    if (freezeApply) freezeApply.addEventListener('click', cb.applyFreezeFrame);

    const freezeSlider = document.getElementById('cupcat-freeze-duration-slider');
    if (freezeSlider) {
        freezeSlider.addEventListener('input', (e) => {
            if (cb.updateFreezeDuration) cb.updateFreezeDuration(parseFloat(e.target.value));
        });
    }
    document.querySelectorAll('.cupcat-freeze-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            const d = parseFloat(btn.dataset.duration);
            if (cb.updateFreezeDuration) cb.updateFreezeDuration(d);
        });
    });

    // Reverse Video modal
    const revClose = document.getElementById('cupcat-reverse-close');
    if (revClose) revClose.addEventListener('click', cb.closeReverseModal);

    const revApply = document.getElementById('cupcat-reverse-apply');
    if (revApply) revApply.addEventListener('click', cb.applyReverseAction);

    const revModeAll = document.getElementById('cupcat-reverse-mode-all');
    if (revModeAll) revModeAll.addEventListener('click', () => {
        if (cb.setReverseMode) cb.setReverseMode('all');
    });

    const revModeSeg = document.getElementById('cupcat-reverse-mode-segment');
    if (revModeSeg) revModeSeg.addEventListener('click', () => {
        if (cb.setReverseMode) cb.setReverseMode('segment');
    });

    const revStart = document.getElementById('cupcat-reverse-start');
    if (revStart) {
        revStart.addEventListener('input', () => {
            if (cb.updateReverseSegmentPreview) cb.updateReverseSegmentPreview();
        });
    }

    const revEnd = document.getElementById('cupcat-reverse-end');
    if (revEnd) {
        revEnd.addEventListener('input', () => {
            if (cb.updateReverseSegmentPreview) cb.updateReverseSegmentPreview();
        });
    }

    // Ratio modal
    document.getElementById('cupcat-ratio-close').addEventListener('click', cb.closeRatioModal);
    document.querySelectorAll('.cupcat-ratio-option').forEach(btn => {
        btn.addEventListener('click', () => {
            if (cb.selectCanvasAspect) cb.selectCanvasAspect(btn.dataset.ratio);
        });
    });

    // Image settings modal
    document.getElementById('cupcat-imgset-close').addEventListener('click', cb.closeImageSettingsModal);
    document.getElementById('cupcat-imgset-apply').addEventListener('click', cb.applyImageSettings);
    document.getElementById('cupcat-imgset-duration').addEventListener('input', () => {
        const val = parseFloat(document.getElementById('cupcat-imgset-duration').value);
        document.getElementById('cupcat-imgset-duration-val').textContent = val.toFixed(1) + 's';
    });
    document.querySelectorAll('.cupcat-kb-option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.cupcat-kb-option').forEach(b => {
                b.style.background = 'rgba(0,176,255,0.08)';
                b.style.borderColor = 'rgba(0,176,255,0.22)';
            });
            btn.style.background = 'rgba(0,176,255,0.25)';
            btn.style.borderColor = '#00b0ff';
        });
    });

    // Text overlay
    document.getElementById('cupcat-text-btn').addEventListener('click', cb.openTextModal);
    document.getElementById('cupcat-text-close').addEventListener('click', cb.closeTextModal);
    document.getElementById('cupcat-text-apply').addEventListener('click', cb.applyText);
    document.getElementById('cupcat-text-fontsize').addEventListener('input', () => {
        document.getElementById('cupcat-text-fontsize-val').textContent = document.getElementById('cupcat-text-fontsize').value + 'px';
    });
    document.querySelectorAll('.cupcat-text-pos-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.textModalPosition = btn.dataset.pos;
            if (cb.updateTextPositionButtons) cb.updateTextPositionButtons();
        });
    });

    // ============================================
    // ADVANCED SUBTITLE INSPECTOR & MANAGER
    // ============================================
    const subBtn = document.getElementById('cupcat-sub-btn');
    if (subBtn) {
        subBtn.addEventListener('click', () => {
            if (cb.openSubtitleInspector) cb.openSubtitleInspector(state.selectedSubtitleId);
            else if (cb.openSubtitleManager) cb.openSubtitleManager();
        });
    }

    const subCloseBtn = document.getElementById('cupcat-sub-manager-close');
    if (subCloseBtn) {
        subCloseBtn.addEventListener('click', () => {
            if (cb.closeSubtitleInspector) cb.closeSubtitleInspector();
            else if (cb.closeSubtitleManager) cb.closeSubtitleManager();
        });
    }

    const subSyncToggle = document.getElementById('cupcat-sub-sync-all-toggle');
    if (subSyncToggle) {
        subSyncToggle.addEventListener('change', (e) => {
            state.subApplyToAll = e.target.checked;
            if (cb.renderSubtitleInspectorContent) cb.renderSubtitleInspectorContent();
            if (cb.updateCanvasTransformBox) cb.updateCanvasTransformBox();
        });
    }

    // Tabs
    const tabText = document.getElementById('cupcat-sub-tab-text');
    if (tabText) tabText.addEventListener('click', () => { if (cb.switchSubtitleTab) cb.switchSubtitleTab('text'); });

    const tabStyle = document.getElementById('cupcat-sub-tab-style');
    if (tabStyle) tabStyle.addEventListener('click', () => { if (cb.switchSubtitleTab) cb.switchSubtitleTab('style'); });

    const tabList = document.getElementById('cupcat-sub-tab-list');
    if (tabList) tabList.addEventListener('click', () => { if (cb.switchSubtitleTab) cb.switchSubtitleTab('list'); });

    // Text Tab Controls
    const navPrev = document.getElementById('cupcat-sub-nav-prev');
    if (navPrev) navPrev.addEventListener('click', () => { if (cb.selectPrevSubtitle) cb.selectPrevSubtitle(); });

    const navNext = document.getElementById('cupcat-sub-nav-next');
    if (navNext) navNext.addEventListener('click', () => { if (cb.selectNextSubtitle) cb.selectNextSubtitle(); });

    const addNext = document.getElementById('cupcat-sub-add-next');
    if (addNext) addNext.addEventListener('click', () => { if (cb.addEmptySubtitle) cb.addEmptySubtitle(); });

    const subInputText = document.getElementById('cupcat-sub-input-text');
    if (subInputText) {
        subInputText.addEventListener('input', (e) => {
            if (cb.updateSubtitleText) cb.updateSubtitleText(state.selectedSubtitleId, e.target.value);
        });
    }

    // Timing adjustments
    const startMinus = document.getElementById('cupcat-sub-start-minus');
    if (startMinus) startMinus.addEventListener('click', () => { if (cb.adjustSubtitleTiming) cb.adjustSubtitleTiming(state.selectedSubtitleId, 'start', -0.1); });

    const startPlus = document.getElementById('cupcat-sub-start-plus');
    if (startPlus) startPlus.addEventListener('click', () => { if (cb.adjustSubtitleTiming) cb.adjustSubtitleTiming(state.selectedSubtitleId, 'start', 0.1); });

    const startSnap = document.getElementById('cupcat-sub-start-snap');
    if (startSnap) startSnap.addEventListener('click', () => { if (cb.setSubtitleTimingToPlayhead) cb.setSubtitleTimingToPlayhead(state.selectedSubtitleId, 'start'); });

    const endMinus = document.getElementById('cupcat-sub-end-minus');
    if (endMinus) endMinus.addEventListener('click', () => { if (cb.adjustSubtitleTiming) cb.adjustSubtitleTiming(state.selectedSubtitleId, 'end', -0.1); });

    const endPlus = document.getElementById('cupcat-sub-end-plus');
    if (endPlus) endPlus.addEventListener('click', () => { if (cb.adjustSubtitleTiming) cb.adjustSubtitleTiming(state.selectedSubtitleId, 'end', 0.1); });

    const endSnap = document.getElementById('cupcat-sub-end-snap');
    if (endSnap) endSnap.addEventListener('click', () => { if (cb.setSubtitleTimingToPlayhead) cb.setSubtitleTimingToPlayhead(state.selectedSubtitleId, 'end'); });

    // Actions
    const btnSplit = document.getElementById('cupcat-sub-btn-split');
    if (btnSplit) btnSplit.addEventListener('click', () => { if (cb.splitSubtitleAtPlayhead) cb.splitSubtitleAtPlayhead(state.selectedSubtitleId); });

    const btnMerge = document.getElementById('cupcat-sub-btn-merge');
    if (btnMerge) btnMerge.addEventListener('click', () => { if (cb.mergeSubtitleWithNext) cb.mergeSubtitleWithNext(state.selectedSubtitleId); });

    const btnDup = document.getElementById('cupcat-sub-btn-dup');
    if (btnDup) btnDup.addEventListener('click', () => { if (cb.duplicateSubtitle) cb.duplicateSubtitle(state.selectedSubtitleId); });

    const btnDel = document.getElementById('cupcat-sub-btn-del');
    if (btnDel) btnDel.addEventListener('click', () => { if (cb.deleteSubtitle) cb.deleteSubtitle(state.selectedSubtitleId); });

    // Style Tab Controls
    const copyAllBtn = document.getElementById('cupcat-sub-copy-all-btn');
    if (copyAllBtn) copyAllBtn.addEventListener('click', () => { if (cb.copyCurrentStyleToAll) cb.copyCurrentStyleToAll(state.selectedSubtitleId); });

    const styleFont = document.getElementById('cupcat-sub-style-font');
    if (styleFont) styleFont.addEventListener('change', (e) => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('fontFamily', e.target.value); });

    const styleSize = document.getElementById('cupcat-sub-style-size');
    if (styleSize) styleSize.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        const label = document.getElementById('cupcat-sub-style-size-val');
        if (label) label.textContent = `${val}px`;
        if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('fontSize', val);
    });

    const formatBold = document.getElementById('cupcat-sub-format-bold');
    if (formatBold) formatBold.addEventListener('click', () => {
        const sub = (state.subtitleTracks || []).find(s => s.id === state.selectedSubtitleId);
        const isBold = sub ? (sub.isBold === false ? true : false) : true;
        if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('isBold', isBold);
    });

    const formatItalic = document.getElementById('cupcat-sub-format-italic');
    if (formatItalic) formatItalic.addEventListener('click', () => {
        const sub = (state.subtitleTracks || []).find(s => s.id === state.selectedSubtitleId);
        const isItalic = sub ? !sub.isItalic : true;
        if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('isItalic', isItalic);
    });

    const formatCaps = document.getElementById('cupcat-sub-format-caps');
    if (formatCaps) formatCaps.addEventListener('click', () => {
        const sub = (state.subtitleTracks || []).find(s => s.id === state.selectedSubtitleId);
        const isUppercase = sub ? !sub.isUppercase : true;
        if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('isUppercase', isUppercase);
    });

    const alignLeft = document.getElementById('cupcat-sub-align-left');
    if (alignLeft) alignLeft.addEventListener('click', () => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('textAlign', 'left'); });

    const alignCenter = document.getElementById('cupcat-sub-align-center');
    if (alignCenter) alignCenter.addEventListener('click', () => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('textAlign', 'center'); });

    const alignRight = document.getElementById('cupcat-sub-align-right');
    if (alignRight) alignRight.addEventListener('click', () => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('textAlign', 'right'); });

    const styleColor = document.getElementById('cupcat-sub-style-color');
    if (styleColor) styleColor.addEventListener('input', (e) => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('color', e.target.value); });

    const bgToggle = document.getElementById('cupcat-sub-style-bg-toggle');
    if (bgToggle) bgToggle.addEventListener('change', (e) => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('hasBg', e.target.checked); });

    const bgColor = document.getElementById('cupcat-sub-style-bgcolor');
    if (bgColor) bgColor.addEventListener('input', (e) => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('bgColor', e.target.value); });

    const bgOpacity = document.getElementById('cupcat-sub-style-bg-opacity');
    if (bgOpacity) bgOpacity.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        const label = document.getElementById('cupcat-sub-style-bg-opacity-val');
        if (label) label.textContent = `${val}%`;
        if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('bgOpacity', val / 100);
    });

    const bgRadius = document.getElementById('cupcat-sub-style-bg-radius');
    if (bgRadius) bgRadius.addEventListener('input', (e) => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('bgRadius', parseInt(e.target.value)); });

    const strokeToggle = document.getElementById('cupcat-sub-style-stroke-toggle');
    if (strokeToggle) strokeToggle.addEventListener('change', (e) => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('hasStroke', e.target.checked); });

    const strokeColor = document.getElementById('cupcat-sub-style-stroke-color');
    if (strokeColor) strokeColor.addEventListener('input', (e) => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('strokeColor', e.target.value); });

    const strokeWidth = document.getElementById('cupcat-sub-style-stroke-width');
    if (strokeWidth) strokeWidth.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        const label = document.getElementById('cupcat-sub-style-stroke-width-val');
        if (label) label.textContent = `${val}px`;
        if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('strokeWidth', val);
    });

    const shadowToggle = document.getElementById('cupcat-sub-style-shadow-toggle');
    if (shadowToggle) shadowToggle.addEventListener('change', (e) => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('hasShadow', e.target.checked); });

    const posTop = document.getElementById('cupcat-sub-pos-top');
    if (posTop) posTop.addEventListener('click', () => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('position', 'top'); });

    const posCenter = document.getElementById('cupcat-sub-pos-center');
    if (posCenter) posCenter.addEventListener('click', () => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('position', 'center'); });

    const posBottom = document.getElementById('cupcat-sub-pos-bottom');
    if (posBottom) posBottom.addEventListener('click', () => { if (cb.applyStylePropToSubtitle) cb.applyStylePropToSubtitle('position', 'bottom'); });

    // Transcript / List Tab Controls
    const searchInput = document.getElementById('cupcat-sub-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            state.subSearchQuery = e.target.value;
            if (cb.renderSubtitleInspectorContent) cb.renderSubtitleInspectorContent();
        });
    }

    const importBtn = document.getElementById('cupcat-sub-import-btn');
    const importFile = document.getElementById('cupcat-sub-import-file');
    if (importBtn && importFile) {
        importBtn.addEventListener('click', () => importFile.click());
        importFile.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
                if (cb.importSubtitlesFromFile) cb.importSubtitlesFromFile(e.target.files[0]);
                e.target.value = '';
            }
        });
    }

    const exportSrtBtn = document.getElementById('cupcat-sub-export-srt');
    if (exportSrtBtn) exportSrtBtn.addEventListener('click', () => { if (cb.exportSubtitlesSRT) cb.exportSubtitlesSRT(); });

    const exportVttBtn = document.getElementById('cupcat-sub-export-vtt');
    if (exportVttBtn) exportVttBtn.addEventListener('click', () => { if (cb.exportSubtitlesVTT) cb.exportSubtitlesVTT(); });

    const smartChars = document.getElementById('cupcat-sub-smart-chars');
    if (smartChars) smartChars.addEventListener('input', (e) => {
        const label = document.getElementById('cupcat-sub-smart-chars-val');
        if (label) label.textContent = e.target.value;
    });

    const smartDur = document.getElementById('cupcat-sub-smart-dur');
    if (smartDur) smartDur.addEventListener('input', (e) => {
        const label = document.getElementById('cupcat-sub-smart-dur-val');
        if (label) label.textContent = `${e.target.value}s`;
    });

    const smartGen = document.getElementById('cupcat-sub-smart-generate');
    if (smartGen) smartGen.addEventListener('click', () => { if (cb.generateBulkSubtitles) cb.generateBulkSubtitles(); });

    const smartClear = document.getElementById('cupcat-sub-smart-clear');
    if (smartClear) smartClear.addEventListener('click', () => { if (cb.clearSubtitles) cb.clearSubtitles(); });

    // Transition modal
    document.getElementById('cupcat-trans-close').addEventListener('click', cb.closeTransitionModal);

    // Overlay (PiP) modal
    document.getElementById('cupcat-overlay-btn').addEventListener('click', cb.openOverlayModal);
    document.getElementById('cupcat-overlay-close').addEventListener('click', cb.closeOverlayModal);
    document.getElementById('cupcat-overlay-apply').addEventListener('click', cb.applyOverlay);
    document.getElementById('cupcat-overlay-delete').addEventListener('click', cb.deleteOverlay);
    document.getElementById('cupcat-overlay-file-area').addEventListener('click', () => {
        document.getElementById('cupcat-overlay-file-input').click();
    });
    document.getElementById('cupcat-overlay-file-input').addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            state.overlayModalFile = e.target.files[0];
            document.getElementById('cupcat-overlay-file-label').textContent = state.overlayModalFile.name;
        }
    });
    document.getElementById('cupcat-overlay-x').addEventListener('input', () => {
        document.getElementById('cupcat-overlay-x-val').textContent = document.getElementById('cupcat-overlay-x').value + '%';
        if (cb.updateOverlayPosButtons) cb.updateOverlayPosButtons('custom');
    });
    document.getElementById('cupcat-overlay-y').addEventListener('input', () => {
        document.getElementById('cupcat-overlay-y-val').textContent = document.getElementById('cupcat-overlay-y').value + '%';
        if (cb.updateOverlayPosButtons) cb.updateOverlayPosButtons('custom');
    });
    document.getElementById('cupcat-overlay-scale').addEventListener('input', () => {
        document.getElementById('cupcat-overlay-scale-val').textContent = document.getElementById('cupcat-overlay-scale').value + '%';
    });
    document.getElementById('cupcat-overlay-opacity').addEventListener('input', () => {
        document.getElementById('cupcat-overlay-opacity-val').textContent = document.getElementById('cupcat-overlay-opacity').value + '%';
    });
    document.querySelectorAll('.cupcat-ovl-pos-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (cb.selectOverlayPosPreset) cb.selectOverlayPosPreset(btn.dataset.pos);
        });
    });
    document.getElementById('cupcat-trans-apply').addEventListener('click', cb.applyTransition);
    document.getElementById('cupcat-trans-duration').addEventListener('input', () => {
        document.getElementById('cupcat-trans-duration-val').textContent = parseFloat(document.getElementById('cupcat-trans-duration').value).toFixed(1) + 's';
    });
    document.querySelectorAll('.cupcat-trans-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (cb.updateTransitionTypeButtons) cb.updateTransitionTypeButtons(btn.dataset.trans);
        });
    });

    // Filters / Color grading modal
    document.getElementById('cupcat-filters-btn').addEventListener('click', cb.openFiltersModal);
    
    document.getElementById('cupcat-filters-close').addEventListener('click', cb.closeFiltersModal);
    document.getElementById('cupcat-filters-apply').addEventListener('click', cb.applyFilters);
    document.getElementById('cupcat-filters-reset').addEventListener('click', cb.resetFilterSliders);

    document.getElementById('cupcat-filter-brightness').addEventListener('input', (e) => {
        state.filterModalPending.brightness = parseFloat(e.target.value) / 100;
        document.getElementById('cupcat-filter-val-brightness').textContent = `${e.target.value}%`;
        state.filterModalPending.preset = 'custom';
        if (cb.updateFilterPresetHighlightOnly) cb.updateFilterPresetHighlightOnly();
        if (cb.applyLiveFilterPreview) cb.applyLiveFilterPreview();
    });

    document.getElementById('cupcat-filter-contrast').addEventListener('input', (e) => {
        state.filterModalPending.contrast = parseFloat(e.target.value) / 100;
        document.getElementById('cupcat-filter-val-contrast').textContent = `${e.target.value}%`;
        state.filterModalPending.preset = 'custom';
        if (cb.updateFilterPresetHighlightOnly) cb.updateFilterPresetHighlightOnly();
        if (cb.applyLiveFilterPreview) cb.applyLiveFilterPreview();
    });

    document.getElementById('cupcat-filter-saturation').addEventListener('input', (e) => {
        state.filterModalPending.saturation = parseFloat(e.target.value) / 100;
        document.getElementById('cupcat-filter-val-saturation').textContent = `${e.target.value}%`;
        state.filterModalPending.preset = 'custom';
        if (cb.updateFilterPresetHighlightOnly) cb.updateFilterPresetHighlightOnly();
        if (cb.applyLiveFilterPreview) cb.applyLiveFilterPreview();
    });

    document.getElementById('cupcat-filter-hue').addEventListener('input', (e) => {
        state.filterModalPending.hue = parseFloat(e.target.value);
        document.getElementById('cupcat-filter-val-hue').textContent = `${e.target.value}°`;
        state.filterModalPending.preset = 'custom';
        if (cb.updateFilterPresetHighlightOnly) cb.updateFilterPresetHighlightOnly();
        if (cb.applyLiveFilterPreview) cb.applyLiveFilterPreview();
    });

    // Transform (Rotate & Flip) modal
    document.getElementById('cupcat-transform-btn').addEventListener('click', cb.openTransformModal);
    document.getElementById('cupcat-transform-close').addEventListener('click', cb.closeTransformModal);
    document.getElementById('cupcat-transform-apply').addEventListener('click', cb.applyTransform);
    document.getElementById('cupcat-transform-reset').addEventListener('click', cb.resetTransformControls);
    document.getElementById('cupcat-rot-left').addEventListener('click', () => {
        if (cb.rotateClipStep) cb.rotateClipStep(-90);
    });
    document.getElementById('cupcat-rot-right').addEventListener('click', () => {
        if (cb.rotateClipStep) cb.rotateClipStep(90);
    });
    document.getElementById('cupcat-flip-h').addEventListener('click', cb.toggleClipFlipH);
    document.getElementById('cupcat-flip-v').addEventListener('click', cb.toggleClipFlipV);
    document.querySelectorAll('.cupcat-rot-angle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (cb.setClipRotationAngle) cb.setClipRotationAngle(parseInt(btn.dataset.angle, 10));
        });
    });

    // Keyframe diamond & navigation buttons in playback bar
    const kfToggleBtn = document.getElementById('cupcat-kf-toggle-btn');
    if (kfToggleBtn) kfToggleBtn.addEventListener('click', cb.toggleKeyframeAtPlayhead);

    const kfPrevBtn = document.getElementById('cupcat-kf-prev-btn');
    if (kfPrevBtn) kfPrevBtn.addEventListener('click', () => {
        if (cb.navigateKeyframe) cb.navigateKeyframe('prev');
    });

    const kfNextBtn = document.getElementById('cupcat-kf-next-btn');
    if (kfNextBtn) kfNextBtn.addEventListener('click', () => {
        if (cb.navigateKeyframe) cb.navigateKeyframe('next');
    });

    // Stickers modal & actions
    const stickersBtn = document.getElementById('cupcat-stickers-btn');
    if (stickersBtn) stickersBtn.addEventListener('click', cb.openStickersModal);

    const stickersCloseBtn = document.getElementById('cupcat-stickers-close');
    if (stickersCloseBtn) stickersCloseBtn.addEventListener('click', cb.closeStickersModal);

    document.querySelectorAll('.cupcat-sticker-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.cupcat-sticker-tab').forEach(t => {
                t.style.background = 'rgba(255,255,255,0.05)';
                t.style.borderColor = 'rgba(255,255,255,0.1)';
                t.style.color = '#ccc';
            });
            tab.style.background = 'rgba(255,193,7,0.25)';
            tab.style.borderColor = '#ffb300';
            tab.style.color = '#ffb300';
            if (cb.populateStickerGrid) cb.populateStickerGrid(tab.dataset.cat);
        });
    });

    // Keyframe presets & Motion Modal
    const kfPresetsBtn = document.getElementById('cupcat-kf-presets-btn');
    if (kfPresetsBtn) kfPresetsBtn.addEventListener('click', cb.openKeyframeModal);

    const kfModalCloseBtn = document.getElementById('cupcat-kf-modal-close');
    if (kfModalCloseBtn) kfModalCloseBtn.addEventListener('click', cb.closeKeyframeModal);

    const kfAddPinBtn = document.getElementById('cupcat-kf-add-pin-btn');
    if (kfAddPinBtn) kfAddPinBtn.addEventListener('click', () => {
        if (cb.addKeyframeAtPlayhead) cb.addKeyframeAtPlayhead();
        if (cb.renderKeyframeModalContent) cb.renderKeyframeModalContent();
    });

    const kfClearBtn = document.getElementById('cupcat-kf-clear-btn');
    if (kfClearBtn) kfClearBtn.addEventListener('click', () => {
        if (cb.clearAllKeyframesForSelected) cb.clearAllKeyframesForSelected();
        if (cb.renderKeyframeModalContent) cb.renderKeyframeModalContent();
    });

    document.querySelectorAll('.cupcat-kf-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (cb.applyKeyframePreset) cb.applyKeyframePreset(btn.dataset.preset);
        });
    });

    // Keyframe modal slider listeners
    const kfSliderX = document.getElementById('cupcat-kf-slider-posx');
    if (kfSliderX) kfSliderX.addEventListener('input', (e) => {
        if (cb.onKeyframeSliderChange) cb.onKeyframeSliderChange('x', parseFloat(e.target.value));
    });

    const kfSliderY = document.getElementById('cupcat-kf-slider-posy');
    if (kfSliderY) kfSliderY.addEventListener('input', (e) => {
        if (cb.onKeyframeSliderChange) cb.onKeyframeSliderChange('y', parseFloat(e.target.value));
    });

    const kfSliderScale = document.getElementById('cupcat-kf-slider-scale');
    if (kfSliderScale) kfSliderScale.addEventListener('input', (e) => {
        if (cb.onKeyframeSliderChange) cb.onKeyframeSliderChange('scale', parseFloat(e.target.value) / 100);
    });

    const kfSliderRot = document.getElementById('cupcat-kf-slider-rot');
    if (kfSliderRot) kfSliderRot.addEventListener('input', (e) => {
        if (cb.onKeyframeSliderChange) cb.onKeyframeSliderChange('rotation', parseFloat(e.target.value));
    });

    // Interactive on-canvas bounding box drag & resize
    if (cb.bindCanvasInteractiveBox) cb.bindCanvasInteractiveBox();
    if (cb.bindCropBox) cb.bindCropBox();

    // Resize handle — drag to resize preview vs bottom panel
    if (cb.bindResizeHandle) cb.bindResizeHandle();

    // Fullscreen Preview
    document.getElementById('cupcat-fullscreen-btn').addEventListener('click', openFullscreenPreview);
    document.getElementById('cupcat-fs-close-btn').addEventListener('click', closeFullscreenPreview);
    document.getElementById('cupcat-fs-play-btn').addEventListener('click', toggleFullscreenPlay);

    const fsProgressBar = document.getElementById('cupcat-fs-progress-bar');
    if (fsProgressBar) {
        const seekFromEvent = (e) => {
            const rect = fsProgressBar.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const totalDur = getTotalDuration();
            state.playheadTime = ratio * totalDur;
            if (cb.updatePlayhead) cb.updatePlayhead();
            if (cb.updatePreviewAtTime) cb.updatePreviewAtTime(state.playheadTime);
            updateFullscreenUI();
            renderFullscreenFrame();
        };
        fsProgressBar.addEventListener('pointerdown', (e) => {
            seekFromEvent(e);
            const onMove = (ev) => seekFromEvent(ev);
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
        });
    }
}

// ============================================================
// FULLSCREEN PREVIEW
// ============================================================
let _fsAnimFrame = null;
let _fsPlaying = false;

export function openFullscreenPreview() {
    const overlay = document.getElementById('cupcat-fullscreen-overlay');
    if (!overlay) return;

    // Stop editor playback if running
    if (state.isPlaying && cb.stopPlayback) cb.stopPlayback();

    overlay.style.display = 'flex';

    // Delay canvas sizing to allow flex layout to compute dimensions
    requestAnimationFrame(() => {
        const fsCanvas = document.getElementById('cupcat-fs-canvas');
        const area = document.getElementById('cupcat-fs-canvas-area');
        if (fsCanvas && area) {
            const canvasDims = CANVAS_ASPECTS[state.canvasAspect];
            let aspect = 16/9;
            if (canvasDims && canvasDims.w && canvasDims.h) {
                aspect = canvasDims.w / canvasDims.h;
            } else if (state.canvasAspect && state.canvasAspect.includes(':')) {
                const [rw, rh] = state.canvasAspect.split(':').map(Number);
                if (rw > 0 && rh > 0) aspect = rw / rh;
            }
            const areaW = area.clientWidth;
            const areaH = area.clientHeight;

            let cw, ch;
            if (areaW / areaH > aspect) {
                ch = areaH;
                cw = ch * aspect;
            } else {
                cw = areaW;
                ch = cw / aspect;
            }

            // Use higher resolution for crisp rendering
            const dpr = window.devicePixelRatio || 1;
            fsCanvas.width = Math.round(cw * dpr);
            fsCanvas.height = Math.round(ch * dpr);
            fsCanvas.style.width = Math.round(cw) + 'px';
            fsCanvas.style.height = Math.round(ch) + 'px';
        }

        updateFullscreenUI();
        renderFullscreenFrame();
    });
}

export function closeFullscreenPreview() {
    const overlay = document.getElementById('cupcat-fullscreen-overlay');
    if (!overlay) return;

    if (_fsPlaying) stopFullscreenPlayback();
    overlay.style.display = 'none';
}

export function toggleFullscreenPlay() {
    if (_fsPlaying) {
        stopFullscreenPlayback();
    } else {
        startFullscreenPlayback();
    }
}

function startFullscreenPlayback() {
    if (state.videoClips.length === 0) return;

    _fsPlaying = true;
    const btn = document.getElementById('cupcat-fs-play-btn');
    if (btn) btn.innerHTML = '<i class="fas fa-pause"></i>';

    const totalDur = getTotalDuration();
    if (state.playheadTime >= totalDur) {
        state.playheadTime = 0;
    }

    // Start editor playback (handles audio, video elements, etc.)
    if (cb.startPlayback) cb.startPlayback();

    let lastTime = performance.now();
    function tick() {
        if (!_fsPlaying) return;

        const now = performance.now();
        const dt = Math.max(0, (now - lastTime) / 1000);
        lastTime = now;

        // Don't update playheadTime here — startPlayback's own loop handles that
        // Just render the fullscreen canvas and update UI
        renderFullscreenFrame();
        updateFullscreenUI();

        const totalDur = getTotalDuration();
        if (state.playheadTime >= totalDur) {
            stopFullscreenPlayback();
            return;
        }

        _fsAnimFrame = requestAnimationFrame(tick);
    }

    _fsAnimFrame = requestAnimationFrame(tick);
}

function stopFullscreenPlayback() {
    _fsPlaying = false;
    if (_fsAnimFrame) {
        cancelAnimationFrame(_fsAnimFrame);
        _fsAnimFrame = null;
    }

    const btn = document.getElementById('cupcat-fs-play-btn');
    if (btn) btn.innerHTML = '<i class="fas fa-play"></i>';

    // Stop editor playback
    if (cb.stopPlayback) cb.stopPlayback();
    renderFullscreenFrame();
    updateFullscreenUI();
}

async function renderFullscreenFrame() {
    const fsCanvas = document.getElementById('cupcat-fs-canvas');
    if (!fsCanvas) return;
    const fsCtx = fsCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    fsCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Use renderScene from the main editor to draw the full scene onto the fullscreen canvas
    if (cb.renderScene) {
        await cb.renderScene(state.playheadTime, fsCanvas, fsCtx);
    } else {
        // Fallback: copy from the main canvas
        const mainCanvas = state.dom.mainCanvas;
        if (mainCanvas) {
            fsCtx.setTransform(1, 0, 0, 1, 0, 0); // Reset for raw pixel copy
            fsCtx.clearRect(0, 0, fsCanvas.width, fsCanvas.height);
            fsCtx.drawImage(mainCanvas, 0, 0, fsCanvas.width, fsCanvas.height);
        }
    }
}

function updateFullscreenUI() {
    const totalDur = getTotalDuration();
    const progress = totalDur > 0 ? (state.playheadTime / totalDur) * 100 : 0;

    const fill = document.getElementById('cupcat-fs-progress-fill');
    if (fill) fill.style.width = progress + '%';

    const timeEl = document.getElementById('cupcat-fs-time');
    if (timeEl) {
        timeEl.textContent = formatTime(state.playheadTime) + ' / ' + formatTime(totalDur);
    }
}

// Handle Escape and F key for fullscreen toggle
const _origHandleEditorKeyDown = handleEditorKeyDown;
const _fsKeyHandler = (e) => {
    const overlay = document.getElementById('cupcat-fullscreen-overlay');
    const isFs = overlay && overlay.style.display !== 'none';

    if (e.key === 'Escape' && isFs) {
        e.preventDefault();
        e.stopPropagation();
        closeFullscreenPreview();
        return;
    }

    if ((e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') && !e.ctrlKey && !e.metaKey) {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
        if (!document.getElementById('cupcat-editor')) return;
        e.preventDefault();
        if (isFs) {
            closeFullscreenPreview();
        } else {
            openFullscreenPreview();
        }
        return;
    }

    // In fullscreen, handle Space for play/pause
    if (isFs && e.code === 'Space') {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
        e.preventDefault();
        toggleFullscreenPlay();
        return;
    }
};

// Install the fullscreen key handler globally
document.removeEventListener('keydown', _fsKeyHandler);
document.addEventListener('keydown', _fsKeyHandler, true);  // capture phase to run before other handlers
