// cupcat/render-scene.js — Unified Canvas compositor (Step 1)
// Renders the current frame of the video editor onto <canvas id="cupcat-main-canvas">
// Layer order: Background (video/photo) → Overlays/Stickers (PiP) → Text
//
// This module does NOT replace DOM rendering — it works in parallel.
// Switching between Canvas and DOM is controlled via state.useCanvasRenderer.

import { state } from './state.js';
import { getClipDuration, getCurrentClipAtTime, getClipSpeed } from './utils.js';
import { CANVAS_ASPECTS } from './constants.js';

// Late-binding callbacks
let _getClipCSSFilter = () => 'none';
let _getClipTransform = () => ({ rotation: 0, flipH: false, flipV: false });
let _getClipFilters = () => ({ preset: 'none', brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0 });
let _getInterpolatedKeyframe = () => ({ x: 50, y: 50, scale: 1, rotation: 0, opacity: 1 });

export function setRenderSceneCallbacks(callbacks) {
    if (callbacks.getClipCSSFilter) _getClipCSSFilter = callbacks.getClipCSSFilter;
    if (callbacks.getClipTransform) _getClipTransform = callbacks.getClipTransform;
    if (callbacks.getClipFilters) _getClipFilters = callbacks.getClipFilters;
    if (callbacks.getInterpolatedKeyframe) _getInterpolatedKeyframe = callbacks.getInterpolatedKeyframe;
}

/**
 * Builds a CSS filter string for ctx.filter from a clip's filter object.
 * Canvas 2D API supports the same CSS filter syntax as DOM.
 */
export function buildCanvasFilter(clip) {
    const f = _getClipFilters(clip);
    const parts = [];

    const b = Math.max(0, (1 + f.brightness) * 100);
    if (Math.abs(b - 100) > 0.5) parts.push(`brightness(${b.toFixed(1)}%)`);

    const c = Math.max(0, f.contrast * 100);
    if (Math.abs(c - 100) > 0.5) parts.push(`contrast(${c.toFixed(1)}%)`);

    const s = Math.max(0, f.saturation * 100);
    if (Math.abs(s - 100) > 0.5) parts.push(`saturate(${s.toFixed(1)}%)`);

    if (Math.abs(f.hue) > 0.5) parts.push(`hue-rotate(${f.hue.toFixed(1)}deg)`);
    if (f.sepia > 0.5) parts.push(`sepia(${f.sepia.toFixed(1)}%)`);

    return parts.length > 0 ? parts.join(' ') : 'none';
}

/**
 * Applies clip transformations (rotation, flipH, flipV) to the Canvas context.
 * Saves and restores ctx state via save/restore.
 */
export function applyCanvasTransform(ctx, clip, w, h) {
    const tr = _getClipTransform(clip);
    if (tr.rotation === 0 && !tr.flipH && !tr.flipV) return;

    // Move origin to canvas center
    ctx.translate(w / 2, h / 2);

    if (tr.rotation !== 0) {
        ctx.rotate((tr.rotation * Math.PI) / 180);
    }

    const sx = tr.flipH ? -1 : 1;
    const sy = tr.flipV ? -1 : 1;
    if (sx !== 1 || sy !== 1) {
        ctx.scale(sx, sy);
    }

    // Move origin back
    ctx.translate(-w / 2, -h / 2);
}

/**
 * Draws a video frame or image on Canvas, fitting to the canvas using cover-fit.
 */
function drawMediaFrame(ctx, source, w, h, clip) {
    if (!source) return;

    // Determine source dimensions
    let srcW, srcH;
    if (source instanceof HTMLVideoElement) {
        srcW = source.videoWidth;
        srcH = source.videoHeight;
    } else if (source instanceof HTMLImageElement) {
        srcW = source.naturalWidth;
        srcH = source.naturalHeight;
    } else {
        srcW = source.width;
        srcH = source.height;
    }

    if (!srcW || !srcH) {
        // Source not loaded yet — draw black background
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        return;
    }

    const crop = (clip && clip.crop) ? clip.crop : { top: 0, bottom: 0, left: 0, right: 0 };
    
    const sX = srcW * (crop.left / 100);
    const sY = srcH * (crop.top / 100);
    const sWidth = srcW * (1 - (crop.left + crop.right) / 100);
    const sHeight = srcH * (1 - (crop.top + crop.bottom) / 100);

    // Cover-fit: scale so the image fills the entire canvas
    // (cropping excess at the edges). This ensures the frame always fills
    // the canvas completely — what you see in the editor is what you get.
    const srcAspect = sWidth / sHeight;
    const dstAspect = w / h;

    // Black background (visible only if source not loaded)
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    let drawW, drawH, offsetX, offsetY;
    if (srcAspect > dstAspect) {
        // Source is wider — crop sides
        drawH = h;
        drawW = h * srcAspect;
        offsetX = (w - drawW) / 2;
        offsetY = 0;
    } else {
        // Source is taller — crop top/bottom
        drawW = w;
        drawH = w / srcAspect;
        offsetX = 0;
        offsetY = (h - drawH) / 2;
    }

    ctx.drawImage(source, sX, sY, sWidth, sHeight, offsetX, offsetY, drawW, drawH);
}

function wrapText(ctx, text, maxWidth) {
    if (text == null) return [];
    text = String(text);
    if (!text) return [];
    const lines = [];
    const rawLines = text.split('\n');
    rawLines.forEach(rawLine => {
        const words = rawLine.split(' ');
        let currentLine = words[0] || '';
        for (let i = 1; i < words.length; i++) {
            const word = words[i];
            const width = ctx.measureText(currentLine + " " + word).width;
            if (width < maxWidth) {
                currentLine += " " + word;
            } else {
                lines.push(currentLine);
                currentLine = word;
            }
        }
        if (currentLine) lines.push(currentLine);
    });
    return lines;
}

/**
 * Unified Subtitle & Text Overlay Renderer
 * Used for:
 * 1) Main editor preview canvas (Retina scaled)
 * 2) Fullscreen preview player (Retina scaled)
 * 3) Native FFmpeg composite PNG export
 * 4) WebCodecs / HTML5 Canvas video export
 */
export function getSubtitleRenderInfo(sub, time, w, h) {
    const kf = typeof _getInterpolatedKeyframe === 'function' ? _getInterpolatedKeyframe(sub, time) : {};
    let posX = kf.x !== undefined ? kf.x : (sub.posX !== undefined ? sub.posX : 50);
    let posY = kf.y !== undefined ? kf.y : (sub.posY !== undefined ? sub.posY : 88);
    let scale = (kf.scale !== undefined ? kf.scale : ((sub.scale !== undefined ? sub.scale : 100) / 100));
    let rot = kf.rotation !== undefined ? kf.rotation : (sub.rotation || 0);
    let op = (kf.opacity !== undefined ? kf.opacity : ((sub.opacity !== undefined ? sub.opacity : 100) / 100));

    if (!sub.keyframes || sub.keyframes.length === 0) {
        if (sub.posY === undefined) {
            if (sub.position === 'top') posY = 12;
            else if (sub.position === 'center') posY = 50;
            else posY = 88;
        }
        if (sub.posX === undefined) posX = 50;
    }

    // Unified reference scale: standard preview reference short side is 360px
    const fontScale = Math.min(w, h) / 360;

    const x = (posX / 100) * w;
    const y = (posY / 100) * h;
    const baseFontSize = sub.fontSize || 24;
    const fontSize = Math.max(8, baseFontSize * scale * fontScale);
    const font = sub.font || sub.fontFamily || 'Inter';
    const fontWeight = sub.fontWeight || (sub.isBold === false ? 'normal' : '800');
    const fontStyle = sub.fontStyle || (sub.isItalic ? 'italic' : 'normal');

    let rawText = sub.text || '';
    if (sub.isUppercase) rawText = rawText.toUpperCase();

    const showBg = sub.showBg !== undefined ? sub.showBg : (sub.hasBg !== undefined ? sub.hasBg : (sub.bgColor && sub.bgColor !== 'transparent' && sub.bgColor !== 'none'));
    const showStroke = sub.showStroke !== undefined ? sub.showStroke : (sub.hasStroke !== undefined ? sub.hasStroke : ((sub.strokeWidth || 0) > 0));
    const showShadow = sub.showShadow !== undefined ? sub.showShadow : (sub.hasShadow !== undefined ? sub.hasShadow : ((sub.shadowBlur || 0) > 0));

    const strokeWidth = (sub.strokeWidth !== undefined ? sub.strokeWidth : (showStroke ? 3 : 0)) * fontScale;
    const shadowBlur = (sub.shadowBlur !== undefined ? sub.shadowBlur : (showShadow ? 6 : 0)) * fontScale;
    const shadowOffsetY = (sub.shadowOffsetY !== undefined ? sub.shadowOffsetY : 2) * fontScale;
    const bgRadius = Math.max(0, (sub.bgRadius !== undefined ? sub.bgRadius : 8) * fontScale);

    return {
        posX, posY, scale, rot, op, x, y,
        fontSize, font, fontWeight, fontStyle,
        rawText,
        textColor: sub.color || '#ffffff',
        bgColor: sub.bgColor || 'rgba(0,0,0,0.75)',
        bgOpacity: sub.bgOpacity !== undefined ? sub.bgOpacity : 1,
        showBg,
        bgRadius,
        bgPadding: sub.bgPadding !== undefined ? sub.bgPadding : 1,
        strokeWidth,
        strokeColor: sub.strokeColor || '#000000',
        showStroke,
        shadowBlur,
        shadowColor: sub.shadowColor || 'rgba(0,0,0,0.85)',
        shadowOffsetY,
        showShadow,
        textAlign: sub.textAlign || 'center',
        fontScale
    };
}

export function drawSingleSubtitle(ctx, sub, time, w, h) {
    const info = getSubtitleRenderInfo(sub, time, w, h);
    if (!info.rawText || !info.rawText.trim()) {
        sub._lastRenderBounds = null;
        return null;
    }

    ctx.save();
    try {
        ctx.globalAlpha = Math.max(0, Math.min(1, info.op));
        ctx.translate(info.x, info.y);
        if (info.rot !== 0) ctx.rotate((info.rot * Math.PI) / 180);

        ctx.font = `${info.fontStyle} ${info.fontWeight} ${info.fontSize}px '${info.font}', sans-serif`;
        ctx.textAlign = info.textAlign;
        ctx.textBaseline = 'middle';

        const maxWidth = w * 0.90; // 90% of screen width
        const lines = wrapText(ctx, info.rawText, maxWidth);
        if (lines.length === 0) {
            sub._lastRenderBounds = null;
            return null;
        }

        let maxTextW = 0;
        lines.forEach(line => {
            maxTextW = Math.max(maxTextW, ctx.measureText(line).width);
        });

        const padScale = Math.max(0.2, info.bgPadding);
        const padX = info.fontSize * 0.5 * padScale;
        const padY = info.fontSize * 0.35 * padScale;
        const lineHeight = info.fontSize * 1.3;
        const boxW = maxTextW + padX * 2;
        const boxH = ((lines.length - 1) * lineHeight + info.fontSize) + padY * 2;
        const radius = Math.min(boxH / 2, Math.max(0, info.bgRadius));

        // Store bounding box for canvas click detection & transform box sync
        sub._lastRenderBounds = {
            x: info.x,
            y: info.y,
            boxW,
            boxH,
            posX: info.posX,
            posY: info.posY,
            scale: info.scale,
            rotation: info.rot
        };

        // 1. Draw Background Pill (if enabled)
        if (info.showBg && info.bgColor && info.bgColor !== 'transparent') {
            ctx.save();
            if (info.bgOpacity < 1) {
                ctx.globalAlpha = ctx.globalAlpha * info.bgOpacity;
            }
            ctx.fillStyle = info.bgColor;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, radius);
            } else {
                ctx.rect(-boxW / 2, -boxH / 2, boxW, boxH);
            }
            ctx.fill();
            ctx.restore();
        }

        // 2. Draw Shadows & Text Stroke
        let startY = lines.length > 1 ? -((lines.length - 1) * lineHeight) / 2 : 0;
        let textOffsetX = 0;
        if (info.textAlign === 'left') textOffsetX = -boxW / 2 + padX;
        else if (info.textAlign === 'right') textOffsetX = boxW / 2 - padX;

        // Stroke / Outline
        if (info.showStroke && info.strokeWidth > 0) {
            ctx.save();
            ctx.strokeStyle = info.strokeColor;
            ctx.lineWidth = Math.max(1, info.strokeWidth);
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            lines.forEach((line, i) => {
                ctx.strokeText(line, textOffsetX, startY + i * lineHeight);
            });
            ctx.restore();
        }

        // Shadow & Fill
        if (info.showShadow && info.shadowBlur > 0) {
            ctx.save();
            ctx.shadowColor = info.shadowColor;
            ctx.shadowBlur = info.shadowBlur;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = info.shadowOffsetY;
            ctx.fillStyle = info.textColor;
            lines.forEach((line, i) => {
                ctx.fillText(line, textOffsetX, startY + i * lineHeight);
            });
            ctx.restore();
        } else {
            // Normal text fill
            ctx.fillStyle = info.textColor;
            lines.forEach((line, i) => {
                ctx.fillText(line, textOffsetX, startY + i * lineHeight);
            });
        }

        return sub._lastRenderBounds;
    } finally {
        ctx.restore();
    }
}

function drawSubtitles(ctx, time, w, h) {
    (state.subtitleTracks || []).forEach(sub => {
        if (time < sub.startTime || time > sub.endTime) {
            sub._lastRenderBounds = null;
            return;
        }

        try {
            drawSingleSubtitle(ctx, sub, time, w, h);
        } catch (e) {
            console.warn('[CupCat] Subtitle render error:', e.message);
        }
    });
}

export function drawTextOverlayItem(ctx, overlay, time, w, h) {
    if (!overlay.text || !overlay.text.trim()) {
        overlay._lastRenderBounds = null;
        return;
    }

    const kf = typeof _getInterpolatedKeyframe === 'function' ? _getInterpolatedKeyframe(overlay, time) : {};
    let posX = kf.x !== undefined ? kf.x : (overlay.posX !== undefined ? overlay.posX : 50);
    let posY = kf.y !== undefined ? kf.y : (overlay.posY !== undefined ? overlay.posY : 50);
    let scale = (kf.scale !== undefined ? kf.scale : ((overlay.scale !== undefined ? overlay.scale : 100) / 100));
    let rot = kf.rotation !== undefined ? kf.rotation : (overlay.rotation || 0);
    let op = (kf.opacity !== undefined ? kf.opacity : ((overlay.opacity !== undefined ? overlay.opacity : 100) / 100));

    if (!overlay.keyframes || overlay.keyframes.length === 0) {
        if (overlay.posY === undefined) {
            if (overlay.position === 'top') posY = 12;
            else if (overlay.position === 'center') posY = 50;
            else posY = 88;
        }
        if (overlay.posX === undefined) posX = 50;
    }

    const fontScale = Math.min(w, h) / 360;
    const x = (posX / 100) * w;
    const y = (posY / 100) * h;
    const fontSize = Math.max(8, (overlay.fontSize || 36) * scale * fontScale);
    const fontFamily = overlay.font || 'Inter';

    ctx.save();
    try {
        ctx.globalAlpha = Math.max(0, Math.min(1, op));
        ctx.translate(x, y);
        if (rot !== 0) ctx.rotate((rot * Math.PI) / 180);

        ctx.font = `700 ${fontSize}px '${fontFamily}', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Text shadow
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 8 * fontScale;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 2 * fontScale;

        // Stroke for better readability
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = Math.max(1, 2 * fontScale);

        const maxWidth = w * 0.85;
        const lines = wrapText(ctx, overlay.text || '', maxWidth);
        const lineHeight = fontSize * 1.2;
        let startY = lines.length > 1 ? -((lines.length - 1) * lineHeight) / 2 : 0;

        let maxLineW = 0;
        lines.forEach(l => {
            maxLineW = Math.max(maxLineW, ctx.measureText(l).width);
        });

        overlay._lastRenderBounds = {
            x, y,
            boxW: maxLineW + 24 * fontScale,
            boxH: (lines.length * lineHeight) + 16 * fontScale,
            posX, posY,
            scale: scale * 100,
            rotation: rot
        };

        lines.forEach((line, i) => {
            ctx.strokeText(line, 0, startY + i * lineHeight);
            ctx.fillStyle = overlay.color || '#ffffff';
            ctx.fillText(line, 0, startY + i * lineHeight);
        });
    } finally {
        ctx.restore();
    }
}

/**
 * Draws text overlays on Canvas.
 */
function drawTextOverlays(ctx, time, w, h) {
    (state.textOverlays || []).forEach(overlay => {
        try {
            if (time < overlay.startTime || time > overlay.endTime) {
                overlay._lastRenderBounds = null;
                return;
            }
            drawTextOverlayItem(ctx, overlay, time, w, h);
        } catch (e) {
            console.warn('[CupCat] Text render error:', e.message);
        }
    });
}

/**
 * Draws PiP overlays (video/images/stickers) on Canvas.
 */
function drawOverlays(ctx, time, w, h) {
    state.overlayTracks.forEach(ovl => {
        const inRange = time >= ovl.startTime && time <= ovl.endTime;
        if (!inRange) {
            ovl._lastRenderBounds = null;
            return;
        }

        const kf = _getInterpolatedKeyframe(ovl, time);
        const scaleVal = kf.scale !== undefined ? kf.scale : (ovl.scale || 30) / 100;
        const opacityVal = kf.opacity !== undefined ? kf.opacity : ((ovl.opacity !== undefined ? ovl.opacity : 100) / 100);
        const posX = kf.x !== undefined ? kf.x : (ovl.posX !== undefined ? ovl.posX : 50);
        const posY = kf.y !== undefined ? kf.y : (ovl.posY !== undefined ? ovl.posY : 50);
        const rot = kf.rotation !== undefined ? kf.rotation : (ovl.rotation || 0);

        const x = (posX / 100) * w;
        const y = (posY / 100) * h;

        // 1. Direct Emoji Sticker Drawing (100% vector crisp & ultra fast)
        if (ovl.isSticker && ovl.emoji) {
            const fontScale = Math.min(w, h) / 360;
            const emojiSize = Math.max(16, (scaleVal * 160) * fontScale);

            ovl._lastRenderBounds = {
                x, y,
                boxW: emojiSize * 1.2,
                boxH: emojiSize * 1.2,
                posX, posY,
                scale: scaleVal * 100,
                rotation: rot
            };

            ctx.save();
            try {
                ctx.globalAlpha = Math.max(0, Math.min(1, opacityVal));
                ctx.translate(x, y);
                if (rot !== 0) ctx.rotate((rot * Math.PI) / 180);
                ctx.font = `${emojiSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(ovl.emoji, 0, 0);
            } finally {
                ctx.restore();
            }
            return;
        }

        // 2. Image / Video Overlay
        if (!ovl._previewEl && ovl.objectUrl) {
            if (ovl.isImage) {
                const img = new Image();
                img.src = ovl.objectUrl;
                ovl._previewEl = img;
            } else {
                const vid = document.createElement('video');
                vid.src = ovl.objectUrl;
                vid.muted = true;
                vid.playsInline = true;
                vid.preload = 'auto';
                ovl._previewEl = vid;
            }
        }

        const source = ovl._previewEl;
        if (!source) return;

        let srcW, srcH;
        if (source instanceof HTMLVideoElement) {
            srcW = source.videoWidth;
            srcH = source.videoHeight;
        } else {
            srcW = source.naturalWidth || source.width || 100;
            srcH = source.naturalHeight || source.height || 100;
        }
        if (!srcW || !srcH) return;

        const drawW = w * scaleVal;
        const drawH = drawW * (srcH / srcW);

        ovl._lastRenderBounds = {
            x, y,
            boxW: drawW,
            boxH: drawH,
            posX, posY,
            scale: scaleVal * 100,
            rotation: rot
        };

        try {
            ctx.save();
            try {
                ctx.globalAlpha = Math.max(0, Math.min(1, opacityVal));
                ctx.translate(x, y);
                if (rot !== 0) ctx.rotate((rot * Math.PI) / 180);

                ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
            } finally {
                ctx.restore();
            }
        } catch (e) {
            console.warn('[CupCat] Overlay render error:', e.message);
        }
    });
}

/**
 * Main function for rendering a single frame.
 * Called on every requestAnimationFrame during playback,
 * or once when updating the preview.
 *
 * @param {number} time — playhead position on the timeline (seconds)
 */
export async function renderScene(time, canvas = state.dom.mainCanvas, ctx = state.dom.mainCtx) {
    if (!canvas || !ctx) return;

    // Both mainCanvas and fsCanvas use DPR scaling for crisp Retina rendering.
    // Export canvases don't have the DPR transform, so use their actual pixel dimensions.
    const isDprScaled = canvas === state.dom.mainCanvas || (canvas && canvas.id === 'cupcat-fs-canvas');
    const dpr = isDprScaled ? (window.devicePixelRatio || 1) : 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    if (w === 0 || h === 0) return;

    // 1. Clear the canvas
    ctx.clearRect(0, 0, w, h);

    const isMainEditorCanvas = canvas === state.dom.mainCanvas;

    // Anti-flicker: while video source is loading, draw the held frame
    // so the user sees the previous frame instead of a poster / black flash
    if (isMainEditorCanvas && state._holdingFrame && state._heldFrameCanvas) {
        try {
            const hc = state._heldFrameCanvas;
            const vAspect = hc.width / hc.height;
            const cAspect = w / h;
            // Cover-fit to match drawMediaFrame and the DOM <video> object-fit: cover
            if (vAspect > cAspect) { dh = h; dw = h * vAspect; dx = (w - dw) / 2; dy = 0; }
            else { dw = w; dh = w / vAspect; dx = 0; dy = (h - dh) / 2; }
            ctx.drawImage(hc, dx, dy, dw, dh);
        } catch (_) {}
    }

    // 2. For Export and Fullscreen canvases (where there is no underlying DOM <video> element),
    // render the base media frame (video or image) with filters and transformations.
    if (!isMainEditorCanvas) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);

        const clip = getCurrentClipAtTime(time);
        if (clip) {
            let source = clip.isImage ? state.dom.previewImg : state.dom.previewVideo;
            ctx.save();
            const filterStr = buildCanvasFilter(clip);
            if (filterStr !== 'none') {
                ctx.filter = filterStr;
            }
            applyCanvasTransform(ctx, clip, w, h);

            if (clip.antigravity && typeof window !== 'undefined') {
                try {
                    const { getSegmentationMask, particleEngine } = await import('./antigravity.js');
                    const mask = await getSegmentationMask(source);
                    if (mask) {
                        particleEngine.activate();
                        const offscreenCanvas = document.createElement('canvas');
                        offscreenCanvas.width = w;
                        offscreenCanvas.height = h;
                        const offCtx = offscreenCanvas.getContext('2d');
                        drawMediaFrame(offCtx, source, w, h, clip);
                        const maskImageData = new ImageData(mask.data, mask.width, mask.height);
                        const maskBitmap = await createImageBitmap(maskImageData);

                        ctx.save();
                        ctx.filter = 'blur(8px)';
                        drawMediaFrame(ctx, source, w, h, clip);
                        ctx.restore();

                        ctx.save();
                        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
                        ctx.fillRect(-w, -h, w * 2, h * 2);
                        ctx.restore();

                        particleEngine.draw(ctx, w, h);

                        const maskCanvas = document.createElement('canvas');
                        maskCanvas.width = w;
                        maskCanvas.height = h;
                        const maskCtx = maskCanvas.getContext('2d');
                        let mDrawW, mDrawH, mOffsetX, mOffsetY;
                        const srcAspect = mask.width / mask.height;
                        const dstAspect = w / h;
                        if (srcAspect > dstAspect) {
                            mDrawH = h;
                            mDrawW = h * srcAspect;
                            mOffsetX = (w - mDrawW) / 2;
                            mOffsetY = 0;
                        } else {
                            mDrawW = w;
                            mDrawH = w / srcAspect;
                            mOffsetX = 0;
                            mOffsetY = (h - mDrawH) / 2;
                        }
                        maskCtx.drawImage(maskBitmap, mOffsetX, mOffsetY, mDrawW, mDrawH);
                        offCtx.globalCompositeOperation = 'destination-in';
                        offCtx.drawImage(maskCanvas, 0, 0);
                        ctx.drawImage(offscreenCanvas, -w / 2, -h / 2);
                    } else {
                        drawMediaFrame(ctx, source, w, h, clip);
                    }
                } catch (_) {
                    drawMediaFrame(ctx, source, w, h, clip);
                }
            } else {
                drawMediaFrame(ctx, source, w, h, clip);
            }
            ctx.restore();
        }
    }

    // 3. Draw overlays (PiP & stickers)
    drawOverlays(ctx, time, w, h);

    // 6. Draw subtitles — with background box
    try {
        drawSubtitles(ctx, time, w, h);
    } catch (e) {
        console.warn('[CupCat] drawSubtitles error:', e.message);
    }

    // 7. Draw text overlays — topmost layer
    drawTextOverlays(ctx, time, w, h);
}

/**
 * Initializes Canvas: gets the element, creates 2D context,
 * sets initial dimensions.
 */
export function initCanvas() {
    const canvasEl = document.getElementById('cupcat-main-canvas');
    if (!canvasEl) return false;

    const ctx = canvasEl.getContext('2d');
    if (!ctx) {
        // Canvas 2D not supported — fallback to DOM
        state.useCanvasRenderer = false;
        return false;
    }

    state.dom.mainCanvas = canvasEl;
    state.dom.mainCtx = ctx;

    // Set Canvas dimensions
    syncCanvasSize();

    return true;
}

/**
 * Synchronizes the physical Canvas dimensions (width/height attributes)
 * with the #cupcat-canvas container dimensions and canvasAspect.
 * Accounts for devicePixelRatio for sharpness on Retina displays.
 */
export function syncCanvasSize() {
    const canvas = state.dom.mainCanvas;
    if (!canvas) return;

    const container = document.getElementById('cupcat-canvas');
    if (!container) return;

    const dpr = window.devicePixelRatio || 1;
    const displayW = container.clientWidth;
    const displayH = container.clientHeight;

    // Physical Canvas size (for sharpness)
    canvas.width = Math.round(displayW * dpr);
    canvas.height = Math.round(displayH * dpr);

    // CSS Canvas size (fills the container)
    canvas.style.width = displayW + 'px';
    canvas.style.height = displayH + 'px';

    // Scale context for Retina
    const ctx = state.dom.mainCtx;
    if (ctx && dpr !== 1) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
}
