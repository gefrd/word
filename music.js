import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import RecordPlugin from 'wavesurfer.js/dist/plugins/record.esm.js';
import { encodeMp3 } from './mp3-encoder.js';

let wavesurfer = null;
let regions = null;
let record = null;
let currentDocId = null;
const DB_NAME = 'kivu_music_db';
const STORE_NAME = 'music_docs';

// State management (optimized for low RAM)
let currentBlob = null;
let originalBlob = null;
let undoStack = [];
let redoStack = [];
const MAX_UNDO = 3; // Reduced to 3 to prevent OOM crash on 2GB RAM phones
let currentZoom = 20; // px per second

let docMetadata = {
    title: 'Untitled Audio',
    speed: 1,
    gain: 0,
    voiceBoost: false
};

export async function init(docId = null) {
    cleanup();

    currentDocId = docId || ('doc_' + Date.now());
    docMetadata = {
        title: 'Voice_' + new Date().toISOString().slice(0, 10),
        speed: 1,
        gain: 0,
        voiceBoost: false
    };

    const ui = buildUI();
    document.body.insertAdjacentHTML('beforeend', ui);
    injectStyles();

    wavesurfer = WaveSurfer.create({
        container: '#music-waveform',
        waveColor: '#7c3aed',
        progressColor: '#a78bfa',
        cursorColor: '#ffffff',
        barWidth: 2,
        barRadius: 2,
        barGap: 1,
        height: 110,
        minPxPerSec: currentZoom,
        responsive: true,
        backend: 'WebAudio',
        autoCenter: true
    });

    regions = wavesurfer.registerPlugin(RegionsPlugin.create());
    record = wavesurfer.registerPlugin(RecordPlugin.create({
        renderRecordedAudio: false
    }));

    if (docId) {
        await loadDocument(docId);
    }

    bindEvents();

    setTimeout(() => {
        const modal = document.getElementById('music-editor-modal');
        if (modal) modal.style.transform = 'translateY(0)';
    }, 10);
}

function injectStyles() {
    if (document.getElementById('music-studio-styles')) return;
    const style = document.createElement('style');
    style.id = 'music-studio-styles';
    style.textContent = `
        #music-editor-modal * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        
        .m-btn {
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 14px;
            padding: 12px 8px;
            color: white;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 6px;
            font-size: 12px;
            touch-action: manipulation;
            transition: transform 0.1s, background 0.15s;
        }
        .m-btn:active { transform: scale(0.96); background: rgba(124,58,237,0.25); }
        .m-btn:disabled { opacity: 0.35; pointer-events: none; }
        
        .m-btn-primary {
            background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
            border: none;
            color: white;
        }
        
        .m-chip {
            padding: 7px 12px;
            border-radius: 20px;
            background: rgba(255,255,255,0.07);
            border: 1px solid rgba(255,255,255,0.12);
            color: #d1d5db;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            white-space: nowrap;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .m-chip.active {
            background: rgba(124,58,237,0.3);
            border-color: #a78bfa;
            color: #fff;
        }
        
        .m-round-btn {
            width: 44px;
            height: 44px;
            border-radius: 50%;
            border: none;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            font-size: 15px;
            touch-action: manipulation;
        }
        
        .m-recording-anim {
            animation: m-pulse 1.2s infinite;
        }
        @keyframes m-pulse {
            0% { box-shadow: 0 0 0 0 rgba(239,68,68,0.7); }
            70% { box-shadow: 0 0 0 12px rgba(239,68,68,0); }
            100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
        }
    `;
    document.head.appendChild(style);
}

function buildUI() {
    return `
    <div id="music-editor-modal" style="position:fixed;inset:0;background:#0d0d16;color:#f3f4f6;z-index:100000;display:flex;flex-direction:column;overflow:hidden;transform:translateY(100%);transition:transform 0.3s cubic-bezier(0.16,1,0.3,1);font-family:system-ui,-apple-system,sans-serif;">
        
        <!-- Header -->
        <div style="height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;background:#161626;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;">
            <div style="display:flex;align-items:center;gap:6px;">
                <button id="music-back-btn" class="m-round-btn" style="background:rgba(255,255,255,0.08);color:white;width:38px;height:38px;">
                    <i class="fas fa-arrow-left"></i>
                </button>
                <button id="music-undo-btn" class="m-round-btn" style="background:transparent;color:#9ca3af;width:34px;height:34px;" disabled title="Undo">
                    <i class="fas fa-undo"></i>
                </button>
                <button id="music-redo-btn" class="m-round-btn" style="background:transparent;color:#9ca3af;width:34px;height:34px;" disabled title="Redo">
                    <i class="fas fa-redo"></i>
                </button>
            </div>
            
            <input id="music-title" type="text" value="${escapeHtml(docMetadata.title)}" style="background:transparent;border:none;color:white;text-align:center;font-size:15px;font-weight:600;outline:none;width:45%;"/>
            
            <button id="music-save-btn" style="padding:7px 14px;border-radius:18px;background:#7c3aed;border:none;color:white;font-weight:600;font-size:13px;display:flex;align-items:center;gap:5px;cursor:pointer;">
                <i class="fas fa-save"></i> Save
            </button>
        </div>

        <!-- Scrollable Body -->
        <div style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:14px;">
            
            <!-- Waveform Card -->
            <div style="background:#171728;border-radius:20px;padding:14px;border:1px solid rgba(255,255,255,0.06);position:relative;">
                
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span id="music-time" style="font-family:monospace;font-size:13px;color:#a78bfa;">00:00.0 / 00:00.0</span>
                    <!-- Waveform Zoom Controls -->
                    <div style="display:flex;gap:4px;align-items:center;">
                        <button id="music-zoom-out" class="m-round-btn" style="width:28px;height:28px;background:rgba(255,255,255,0.08);color:white;font-size:11px;">
                            <i class="fas fa-search-minus"></i>
                        </button>
                        <button id="music-zoom-in" class="m-round-btn" style="width:28px;height:28px;background:rgba(255,255,255,0.08);color:white;font-size:11px;">
                            <i class="fas fa-search-plus"></i>
                        </button>
                    </div>
                </div>

                <div id="music-waveform" style="width:100%;min-height:110px;border-radius:8px;overflow:hidden;background:rgba(0,0,0,0.2);"></div>

                <!-- Empty State -->
                <div id="music-empty-state" style="position:absolute;inset:40px 14px 70px 14px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;pointer-events:none;">
                    <i class="fas fa-microphone-alt" style="font-size:28px;color:rgba(167,139,250,0.4);"></i>
                    <span style="color:rgba(255,255,255,0.4);font-size:13px;">Tap Record or Import an audio file</span>
                </div>

                <!-- Transport Bar -->
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;gap:8px;">
                    <label style="background:rgba(255,255,255,0.08);padding:9px 12px;border-radius:14px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer;">
                        <i class="fas fa-folder-open"></i> Import
                        <input type="file" id="music-import" accept="audio/*" style="display:none;"/>
                    </label>

                    <div style="display:flex;gap:10px;align-items:center;">
                        <button id="music-stop-btn" class="m-round-btn" style="background:rgba(255,255,255,0.1);color:white;">
                            <i class="fas fa-stop"></i>
                        </button>
                        <button id="music-play-btn" class="m-round-btn" style="width:52px;height:52px;background:#ffffff;color:#7c3aed;font-size:20px;box-shadow:0 4px 16px rgba(124,58,237,0.4);">
                            <i class="fas fa-play" style="margin-left:3px;"></i>
                        </button>
                        <button id="music-record-btn" class="m-round-btn" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.5);color:#ef4444;">
                            <i class="fas fa-microphone"></i>
                        </button>
                    </div>

                    <button id="music-share-btn" style="background:#25D366;border:none;padding:9px 12px;border-radius:14px;color:white;font-size:12px;font-weight:600;display:flex;align-items:center;gap:5px;cursor:pointer;">
                        <i class="fab fa-whatsapp" style="font-size:15px;"></i> Share
                    </button>
                </div>
            </div>

            <!-- 1-Tap Presets (80/20 Rule) -->
            <div>
                <div style="font-size:11px;color:#9ca3af;font-weight:700;text-transform:uppercase;margin-bottom:8px;letter-spacing:0.5px;">Quick Presets</div>
                <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;">
                    <button id="preset-status-30s" class="m-chip">
                        <i class="fas fa-clock" style="color:#60a5fa;"></i> Status (30s)
                    </button>
                    <button id="preset-voice-clarity" class="m-chip">
                        <i class="fas fa-magic" style="color:#fbbf24;"></i> Voice Boost
                    </button>
                    <button id="preset-fade-both" class="m-chip">
                        <i class="fas fa-sliders-h" style="color:#a78bfa;"></i> Smooth Fade
                    </button>
                    <button id="preset-speed-toggle" class="m-chip">
                        <i class="fas fa-forward" style="color:#34d399;"></i> <span id="speed-chip-val">Speed: 1x</span>
                    </button>
                </div>
            </div>

            <!-- Action Grid (Editing & Export) -->
            <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;">
                <button id="music-trim-btn" class="m-btn">
                    <i class="fas fa-crop-alt" style="color:#a78bfa;font-size:18px;"></i>
                    <span>Trim Region</span>
                </button>
                <button id="music-cut-btn" class="m-btn">
                    <i class="fas fa-cut" style="color:#f87171;font-size:18px;"></i>
                    <span>Delete Part</span>
                </button>
                <button id="music-normalize-btn" class="m-btn">
                    <i class="fas fa-volume-up" style="color:#fbbf24;font-size:18px;"></i>
                    <span>Loud Max</span>
                </button>
            </div>

            <!-- Direct Downloads / Formats -->
            <div style="background:#171728;border-radius:16px;padding:12px;border:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between;">
                <div style="display:flex;flex-direction:column;">
                    <span style="font-size:13px;font-weight:600;color:#fff;">Save to Device</span>
                    <span style="font-size:11px;color:#9ca3af;">Lightweight MP3 / WAV</span>
                </div>
                <div style="display:flex;gap:8px;">
                    <button id="music-export-mp3-btn" class="m-btn" style="padding:8px 14px;flex-direction:row;gap:6px;background:rgba(96,165,250,0.15);border-color:rgba(96,165,250,0.3);color:#93c5fd;">
                        <i class="fas fa-file-audio"></i> MP3 (Light)
                    </button>
                    <button id="music-export-wav-btn" class="m-btn" style="padding:8px 14px;flex-direction:row;gap:6px;background:rgba(255,255,255,0.05);">
                        <i class="fas fa-download"></i> WAV
                    </button>
                </div>
            </div>

        </div>

        <!-- Non-blocking Loading Indicator -->
        <div id="music-loading" style="display:none;position:absolute;inset:0;background:rgba(13,13,22,0.85);backdrop-filter:blur(4px);z-index:50;flex-direction:column;align-items:center;justify-content:center;gap:12px;">
            <div style="width:36px;height:36px;border:3px solid rgba(167,139,250,0.2);border-top-color:#a78bfa;border-radius:50%;animation:m-spin 0.7s linear infinite;"></div>
            <span id="music-loading-text" style="color:#c4b5fd;font-size:13px;font-weight:500;">Processing audio...</span>
        </div>
        <style>@keyframes m-spin { to { transform: rotate(360deg); } }</style>
    </div>`;
}

function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function bindEvents() {
    document.getElementById('music-back-btn').addEventListener('click', closeEditor);
    document.getElementById('music-save-btn').addEventListener('click', async () => {
        await saveDocument();
        const btn = document.getElementById('music-save-btn');
        btn.innerHTML = '<i class="fas fa-check"></i> Saved';
        setTimeout(() => btn.innerHTML = '<i class="fas fa-save"></i> Save', 1200);
    });
    document.getElementById('music-title').addEventListener('input', (e) => docMetadata.title = e.target.value);

    // Undo / Redo
    document.getElementById('music-undo-btn').addEventListener('click', performUndo);
    document.getElementById('music-redo-btn').addEventListener('click', performRedo);

    // Zoom Controls
    document.getElementById('music-zoom-in').addEventListener('click', () => {
        currentZoom = Math.min(currentZoom + 20, 150);
        wavesurfer.zoom(currentZoom);
    });
    document.getElementById('music-zoom-out').addEventListener('click', () => {
        currentZoom = Math.max(currentZoom - 20, 10);
        wavesurfer.zoom(currentZoom);
    });

    // Playback
    document.getElementById('music-play-btn').addEventListener('click', () => {
        if (!wavesurfer.getDuration()) return;
        wavesurfer.playPause();
    });
    document.getElementById('music-stop-btn').addEventListener('click', () => wavesurfer.stop());

    wavesurfer.on('play', () => {
        const btn = document.getElementById('music-play-btn');
        if (btn) btn.innerHTML = '<i class="fas fa-pause"></i>';
    });
    wavesurfer.on('pause', () => {
        const btn = document.getElementById('music-play-btn');
        if (btn) btn.innerHTML = '<i class="fas fa-play" style="margin-left:3px;"></i>';
    });

    // Time & Empty State
    const formatTime = (sec) => {
        if (!sec || !isFinite(sec)) return '00:00.0';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        const ms = Math.floor((sec % 1) * 10);
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`;
    };

    wavesurfer.on('timeupdate', (t) => {
        const el = document.getElementById('music-time');
        if (el) el.textContent = `${formatTime(t)} / ${formatTime(wavesurfer.getDuration())}`;
    });
    wavesurfer.on('ready', () => {
        const empty = document.getElementById('music-empty-state');
        if (empty) empty.style.display = 'none';
        regions.clearRegions();
    });

    // Region drag selection
    regions.enableDragSelection({ color: 'rgba(167, 139, 250, 0.35)' });

    // Recording
    let isRecording = false;
    const recBtn = document.getElementById('music-record-btn');
    recBtn.addEventListener('click', async () => {
        if (isRecording) {
            record.stopRecording();
            recBtn.innerHTML = '<i class="fas fa-microphone"></i>';
            recBtn.classList.remove('m-recording-anim');
            isRecording = false;
        } else {
            try {
                await record.startRecording();
                isRecording = true;
                recBtn.innerHTML = '<i class="fas fa-stop"></i>';
                recBtn.classList.add('m-recording-anim');
            } catch (err) {
                alert('Microphone access denied.');
            }
        }
    });

    record.on('record-end', (blob) => {
        originalBlob = blob;
        currentBlob = blob;
        wavesurfer.loadBlob(blob);
    });

    // Import
    document.getElementById('music-import').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            originalBlob = file;
            currentBlob = file;
            wavesurfer.loadBlob(file);
            if (docMetadata.title.startsWith('Voice_') || docMetadata.title === 'Untitled Audio') {
                docMetadata.title = file.name.replace(/\.[^/.]+$/, '');
                document.getElementById('music-title').value = docMetadata.title;
            }
        }
    });

    // Cut & Trim
    document.getElementById('music-trim-btn').addEventListener('click', async () => {
        const reg = regions.getRegions()[0];
        if (!reg) return alert('Drag on the waveform to select a region first.');
        pushUndo();
        await processBufferOperation('trim', reg.start, reg.end);
        reg.remove();
    });

    document.getElementById('music-cut-btn').addEventListener('click', async () => {
        const reg = regions.getRegions()[0];
        if (!reg) return alert('Drag on the waveform to select a region first.');
        pushUndo();
        await processBufferOperation('cut', reg.start, reg.end);
        reg.remove();
    });

    // 1-Tap Presets
    document.getElementById('preset-status-30s').addEventListener('click', () => {
        const dur = wavesurfer.getDuration();
        if (!dur) return;
        regions.clearRegions();
        regions.addRegion({
            start: 0,
            end: Math.min(30, dur),
            color: 'rgba(96, 165, 250, 0.4)'
        });
        if (window.showToast) window.showToast('Selected first 30 seconds for WhatsApp Status');
    });

    document.getElementById('preset-voice-clarity').addEventListener('click', async () => {
        if (!currentBlob) return alert('Load or record audio first.');
        pushUndo();
        await applyVoiceClarity();
    });

    document.getElementById('preset-fade-both').addEventListener('click', async () => {
        if (!currentBlob) return alert('Load audio first.');
        pushUndo();
        await applyFades(1.5, 2.0);
    });

    const speedSteps = [1, 1.25, 1.5, 2];
    document.getElementById('preset-speed-toggle').addEventListener('click', () => {
        let idx = speedSteps.indexOf(docMetadata.speed);
        idx = (idx + 1) % speedSteps.length;
        docMetadata.speed = speedSteps[idx];
        wavesurfer.setPlaybackRate(docMetadata.speed);
        document.getElementById('speed-chip-val').textContent = `Speed: ${docMetadata.speed}x`;
    });

    document.getElementById('music-normalize-btn').addEventListener('click', async () => {
        if (!currentBlob) return alert('Load audio first.');
        pushUndo();
        await normalizeAudio();
    });

    // Sharing & Exports
    document.getElementById('music-share-btn').addEventListener('click', shareToWhatsApp);
    document.getElementById('music-export-mp3-btn').addEventListener('click', () => exportAudio('mp3'));
    document.getElementById('music-export-wav-btn').addEventListener('click', () => exportAudio('wav'));
}

// === Audio Buffer Operations (Native WebAudio, Zero Extra Libraries) ===

async function decodeBlobNative(blob) {
    const arrayBuf = await blob.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
        return await ctx.decodeAudioData(arrayBuf);
    } finally {
        ctx.close();
    }
}

async function processBufferOperation(operation, startTime, endTime) {
    const originalBuffer = wavesurfer.getDecodedData();
    if (!originalBuffer) return;

    showLoading(operation === 'trim' ? 'Trimming...' : 'Cutting...');
    try {
        const sr = originalBuffer.sampleRate;
        const startSample = Math.floor(startTime * sr);
        const endSample = Math.floor(endTime * sr);
        const channels = originalBuffer.numberOfChannels;

        let newLength = operation === 'trim' 
            ? (endSample - startSample) 
            : (originalBuffer.length - (endSample - startSample));

        if (newLength <= 0) return;

        const offCtx = new OfflineAudioContext(channels, newLength, sr);
        const newBuffer = offCtx.createBuffer(channels, newLength, sr);

        for (let ch = 0; ch < channels; ch++) {
            const src = originalBuffer.getChannelData(ch);
            const dst = newBuffer.getChannelData(ch);

            if (operation === 'trim') {
                for (let i = startSample; i < endSample; i++) dst[i - startSample] = src[i];
            } else {
                let dstIdx = 0;
                for (let i = 0; i < startSample; i++) dst[dstIdx++] = src[i];
                for (let i = endSample; i < originalBuffer.length; i++) dst[dstIdx++] = src[i];
            }
        }

        const newBlob = bufferToWav(newBuffer);
        currentBlob = newBlob;
        originalBlob = newBlob;
        await wavesurfer.loadBlob(newBlob);
    } catch (err) {
        console.error('Edit error:', err);
    } finally {
        hideLoading();
    }
}

// Native Speech Clarity: Highpass filter (cuts mic rumble <90Hz) + Dynamic Compression + Normalization
async function applyVoiceClarity() {
    const srcBuffer = wavesurfer.getDecodedData();
    if (!srcBuffer) return;

    showLoading('Enhancing speech clarity...');
    try {
        const offCtx = new OfflineAudioContext(srcBuffer.numberOfChannels, srcBuffer.length, srcBuffer.sampleRate);
        const source = offCtx.createBufferSource();
        source.buffer = srcBuffer;

        // Highpass Filter (removes wind/table/pocket rumble)
        const filter = offCtx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 90;

        // Vocal Presence Boost (around 2.5kHz)
        const presence = offCtx.createBiquadFilter();
        presence.type = 'peaking';
        presence.frequency.value = 2500;
        presence.gain.value = 3.5;

        // Compressor (levels quiet and loud voice parts)
        const compressor = offCtx.createDynamicsCompressor();
        compressor.threshold.value = -20;
        compressor.ratio.value = 3.5;

        source.connect(filter);
        filter.connect(presence);
        presence.connect(compressor);
        compressor.connect(offCtx.destination);

        source.start(0);
        const renderedBuffer = await offCtx.startRendering();

        const newBlob = bufferToWav(renderedBuffer);
        currentBlob = newBlob;
        await wavesurfer.loadBlob(newBlob);
        if (window.showToast) window.showToast('Voice clarity enhanced!');
    } catch (e) {
        console.error(e);
    } finally {
        hideLoading();
    }
}

async function normalizeAudio() {
    const buffer = wavesurfer.getDecodedData();
    if (!buffer) return;

    showLoading('Maximizing volume...');
    try {
        let maxPeak = 0;
        const channels = buffer.numberOfChannels;
        for (let ch = 0; ch < channels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
                const val = Math.abs(data[i]);
                if (val > maxPeak) maxPeak = val;
            }
        }

        if (maxPeak === 0 || maxPeak >= 0.98) {
            hideLoading();
            if (window.showToast) window.showToast('Audio is already at optimal loudness.');
            return;
        }

        const gain = 0.98 / maxPeak;
        const offCtx = new OfflineAudioContext(channels, buffer.length, buffer.sampleRate);
        const newBuf = offCtx.createBuffer(channels, buffer.length, buffer.sampleRate);

        for (let ch = 0; ch < channels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = newBuf.getChannelData(ch);
            for (let i = 0; i < src.length; i++) dst[i] = src[i] * gain;
        }

        const newBlob = bufferToWav(newBuf);
        currentBlob = newBlob;
        await wavesurfer.loadBlob(newBlob);
        if (window.showToast) window.showToast(`Boosted by +${(20 * Math.log10(gain)).toFixed(1)} dB`);
    } finally {
        hideLoading();
    }
}

async function applyFades(fadeInSec, fadeOutSec) {
    const buffer = wavesurfer.getDecodedData();
    if (!buffer) return;

    showLoading('Applying smooth fades...');
    try {
        const sr = buffer.sampleRate;
        const len = buffer.length;
        const inSamples = Math.min(Math.floor(fadeInSec * sr), len);
        const outSamples = Math.min(Math.floor(fadeOutSec * sr), len);
        const outStart = len - outSamples;
        const channels = buffer.numberOfChannels;

        const offCtx = new OfflineAudioContext(channels, len, sr);
        const newBuf = offCtx.createBuffer(channels, len, sr);

        for (let ch = 0; ch < channels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = newBuf.getChannelData(ch);
            for (let i = 0; i < len; i++) {
                let g = 1.0;
                if (i < inSamples) g *= (i / inSamples);
                if (i >= outStart) g *= ((len - i) / outSamples);
                dst[i] = src[i] * g;
            }
        }

        const newBlob = bufferToWav(newBuf);
        currentBlob = newBlob;
        await wavesurfer.loadBlob(newBlob);
    } finally {
        hideLoading();
    }
}

// Fast In-Memory WAV Encoder
function bufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1;
    const bitDepth = 16;
    const blockAlign = numChannels * 2;
    const byteRate = sampleRate * blockAlign;
    const dataSize = buffer.length * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    const chData = [];
    for (let c = 0; c < numChannels; c++) chData.push(buffer.getChannelData(c));

    for (let i = 0; i < buffer.length; i++) {
        for (let c = 0; c < numChannels; c++) {
            let sample = Math.max(-1, Math.min(1, chData[c][i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
            offset += 2;
        }
    }
    return new Blob([view], { type: 'audio/wav' });
}

// === Direct WhatsApp / System Share ===
async function shareToWhatsApp() {
    if (!currentBlob) return alert('No audio to share.');

    const filename = `${docMetadata.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.mp3`;
    showLoading('Preparing audio for WhatsApp...');

    try {
        const mp3Blob = await getMp3Blob(64); // 64 kbps mono is ultralight for WhatsApp
        const file = new File([mp3Blob], filename, { type: 'audio/mp3' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({
                title: docMetadata.title,
                text: 'Shared from Kivu Audio Studio',
                files: [file]
            });
        } else {
            // Fallback download if Web Share API files is unavailable
            downloadBlob(mp3Blob, filename);
            if (window.showToast) window.showToast('Audio downloaded! Ready to attach in WhatsApp.');
        }
    } catch (e) {
        if (e.name !== 'AbortError') alert('Sharing failed: ' + e.message);
    } finally {
        hideLoading();
    }
}

// === MP3 & WAV Export ===
async function getMp3Blob(kbps = 128) {
    // Mono halves the file size, which matters for sharing over mobile data.
    return encodeMp3(wavesurfer.getDecodedData(), kbps);
}

async function exportAudio(format) {
    if (!currentBlob) return alert('No audio to export.');
    const safeTitle = docMetadata.title.replace(/[^a-zA-Z0-9_-]/g, '_');

    if (format === 'wav') {
        downloadBlob(currentBlob, `${safeTitle}.wav`);
    } else {
        showLoading('Encoding lightweight MP3...');
        try {
            const mp3Blob = await getMp3Blob(128);
            downloadBlob(mp3Blob, `${safeTitle}.mp3`);
        } finally {
            hideLoading();
        }
    }
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 150);
}

// === RAM Protection & Undo/Redo ===
function pushUndo() {
    if (currentBlob) {
        undoStack.push(currentBlob);
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack = [];
        updateUndoBtns();
    }
}

async function performUndo() {
    if (undoStack.length === 0) return;
    redoStack.push(currentBlob);
    currentBlob = undoStack.pop();
    await wavesurfer.loadBlob(currentBlob);
    updateUndoBtns();
}

async function performRedo() {
    if (redoStack.length === 0) return;
    undoStack.push(currentBlob);
    currentBlob = redoStack.pop();
    await wavesurfer.loadBlob(currentBlob);
    updateUndoBtns();
}

function updateUndoBtns() {
    const u = document.getElementById('music-undo-btn');
    const r = document.getElementById('music-redo-btn');
    if (u) u.disabled = undoStack.length === 0;
    if (r) r.disabled = redoStack.length === 0;
}

function showLoading(txt) {
    const l = document.getElementById('music-loading');
    const t = document.getElementById('music-loading-text');
    if (l) l.style.display = 'flex';
    if (t) t.textContent = txt;
}
function hideLoading() {
    const l = document.getElementById('music-loading');
    if (l) l.style.display = 'none';
}

// === Storage & Clean Lifecycle ===
function openDB() {
    return new Promise((res, rej) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
}

async function saveDocument() {
    try {
        if (currentBlob) {
            const db = await openDB();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(currentBlob, currentDocId);
        }
        localStorage.setItem('kivu_doc_' + currentDocId, JSON.stringify(docMetadata));

        const idx = localStorage.getItem('kivu_docs_index');
        let docs = idx ? JSON.parse(idx) : [];
        const entry = docs.find(d => d.id === currentDocId);
        if (entry) {
            entry.title = docMetadata.title;
            entry.updatedAt = Date.now();
        } else {
            docs.push({ id: currentDocId, type: 'music', title: docMetadata.title, updatedAt: Date.now() });
        }
        localStorage.setItem('kivu_docs_index', JSON.stringify(docs));
    } catch (e) {
        console.error('Save failed', e);
    }
}

async function loadDocument(docId) {
    try {
        const metaStr = localStorage.getItem('kivu_doc_' + docId);
        if (metaStr) {
            docMetadata = JSON.parse(metaStr);
            const titleEl = document.getElementById('music-title');
            if (titleEl) titleEl.value = docMetadata.title;
        }
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(docId);
        req.onsuccess = () => {
            if (req.result) {
                currentBlob = req.result;
                originalBlob = req.result;
                wavesurfer.loadBlob(req.result);
            }
        };
    } catch (e) {
        console.error('Load failed', e);
    }
}

function cleanup() {
    if (record) {
        try { record.stopRecording(); } catch (e) {}
    }
    if (wavesurfer) {
        try { wavesurfer.destroy(); } catch (e) {}
        wavesurfer = null;
    }
    const modal = document.getElementById('music-editor-modal');
    if (modal) modal.remove();
    undoStack = [];
    redoStack = [];
    currentBlob = null;
    originalBlob = null;
}

async function closeEditor() {
    await saveDocument();
    cleanup();
    const styles = document.getElementById('music-studio-styles');
    if (styles) styles.remove();
    if (window.renderMyDocuments) window.renderMyDocuments();
}