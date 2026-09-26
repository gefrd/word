import { state } from '../state.js';
import { generateId, getTotalDuration } from '../utils.js';
import { pushHistory } from '../history.js';
import { updateOverlayPreview } from './overlay.js';

// Late bindings
let renderTimeline = () => {};
let updatePreview = () => {};
let updatePreviewAtTime = (...args) => {};
let updateKeyframeDiamondButton = () => {};
let updateCanvasTransformBox = () => {};
let saveDocument = () => {};

export function setStickersCallbacks(cbs) {
    if (cbs.renderTimeline) renderTimeline = cbs.renderTimeline;
    if (cbs.updatePreview) updatePreview = cbs.updatePreview;
    if (cbs.updatePreviewAtTime) updatePreviewAtTime = cbs.updatePreviewAtTime;
    if (cbs.updateKeyframeDiamondButton) updateKeyframeDiamondButton = cbs.updateKeyframeDiamondButton;
    if (cbs.updateCanvasTransformBox) updateCanvasTransformBox = cbs.updateCanvasTransformBox;
    if (cbs.saveDocument) saveDocument = cbs.saveDocument;
}

const STICKER_SETS = {
    popular: ['🔥', '✨', '🚀', '💯', '❤️', '😍', '😂', '🎉', '🌟', '💥', '👍', '👏', '🥳', '😎', '⚡', '🤩', '💎', '👑', '🌈', '🍕', '🐱', '🐶', '🎵', '🏆'],
    vlog: ['🎙️', '📹', '🎬', '📸', '🎧', '🔔', '💬', '👀', '💡', '👉', '👇', '➡️', '⬅️', '🎯', '📍', '⭐', '❤️', '🔥'],
    badges: ['🥇', '🥈', '🥉', '⭐', '🌟', '💫', '🎖️', '🏅', '🏆', '🎯', '🔥', '💥', '💯', '🆗', '🆒', '🆕', '🆓', '🔝', '🆙', '🏷️', '💎', '🚀'],
    fun: ['🥳', '😎', '🤪', '🤡', '🤖', '👾', '👻', '🍕', '🍔', '🍟', '🍿', '🍦', '🍩', '🍫', '⚽', '🎮', '🚀', '🎸', '🦄', '🐱', '🐶', '🦊']
};

export function createEmojiDataUrl(emoji) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.font = '180px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, 128, 140);
    return canvas.toDataURL('image/png');
}

export function openStickersModal() {
    const modal = document.getElementById('cupcat-stickers-modal');
    if (modal) modal.style.display = 'flex';
    populateStickerGrid('popular');
}

export function closeStickersModal() {
    const modal = document.getElementById('cupcat-stickers-modal');
    if (modal) modal.style.display = 'none';
}

export function populateStickerGrid(cat) {
    const grid = document.getElementById('cupcat-stickers-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const list = STICKER_SETS[cat] || STICKER_SETS.popular;
    list.forEach(emoji => {
        const btn = document.createElement('button');
        btn.style.cssText = `
            font-size: 30px; padding: 12px 6px; border-radius: 12px;
            background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
            cursor: pointer; display: flex; align-items: center; justify-content: center;
            transition: all 0.15s ease; user-select: none;
        `;
        btn.innerHTML = emoji;
        btn.addEventListener('mouseenter', () => {
            btn.style.background = 'rgba(255,193,7,0.2)';
            btn.style.borderColor = '#ffb300';
            btn.style.transform = 'scale(1.15)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = 'rgba(255,255,255,0.05)';
            btn.style.borderColor = 'rgba(255,255,255,0.1)';
            btn.style.transform = 'scale(1)';
        });
        btn.addEventListener('click', () => {
            addStickerToTimeline(emoji);
            closeStickersModal();
        });
        grid.appendChild(btn);
    });
}

export function addStickerToTimeline(emoji) {
    pushHistory();
    const dur = 4;
    const startTime = state.playheadTime;
    const endTime = Math.max(startTime + 1, (getTotalDuration() > 0 ? Math.min(getTotalDuration(), startTime + dur) : startTime + dur));

    const newSticker = {
        id: generateId(),
        name: `Sticker ${emoji}`,
        isImage: true,
        isSticker: true,
        emoji: emoji,
        objectUrl: createEmojiDataUrl(emoji),
        startTime: startTime,
        endTime: endTime,
        posX: 50,
        posY: 50,
        scale: 30,
        opacity: 100,
        rotation: 0,
        keyframes: []
    };

    state.overlayTracks.push(newSticker);
    state.selectedOverlayId = newSticker.id;
    state.selectedClipId = null;
    state.selectedAudioId = null;
    state.selectedTextId = null;
    state.selectedSubtitleId = null;

    renderTimeline();
    if (!state.isPlaying) {
        updatePreviewAtTime(state.playheadTime);
    } else {
        updateOverlayPreview();
    }
    updateKeyframeDiamondButton();
    updateCanvasTransformBox();
    saveDocument();
    if (window.showToast) window.showToast(`Added sticker ${emoji}`, false);
}
