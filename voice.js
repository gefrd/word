// src/modules/tools/voice.js
// Kivu Super App - AI Voice & Audio-to-Text Transcriber
// 100% Focused Speech-to-Text Studio: Live Recording STT + Offline Whisper File Transcription + AI Smart Formatting

const VOICE_STORAGE_KEY_PREFIX = 'kivu_doc_';
const VOICE_DOCS_INDEX = 'kivu_docs_index';
const DB_NAME = 'kivu_voice_db';
const STORE_NAME = 'voice_docs';

// ── State Management ──
let currentDocId = null;
let mediaRecorder = null;
let audioChunks = [];
let currentAudioBlob = null;
let audioUrl = null;
let isRecording = false;
let isPaused = false;
let startTime = 0;
let elapsedBeforePause = 0;
let timerInterval = null;
let activeStream = null;

let audioCtx = null;
let analyserNode = null;
let visualizerAnimFrame = null;

// Custom Audio Player State
let audioPlayerEl = null;
let isPlayingAudio = false;
let currentPlaybackSpeed = 1.0;

// Live Speech Recognition (Web Speech API)
let speechRecognizer = null;
let isLiveTranscribing = false;
let committedTranscript = '';
let interimTranscript = '';
let speechLang = 'en-US';
let shouldRestartRecognizer = false;

// Whisper Worker State
let whisperWorker = null;
let isWhisperLoading = false;
let isWhisperTranscribing = false;

// ── Scoped Styles Injection ──
function injectVoiceStyles() {
    if (document.getElementById('voice-transcriber-styles')) return;
    const style = document.createElement('style');
    style.id = 'voice-transcriber-styles';
    style.textContent = `
        #voice-editor-modal {
            position: fixed !important;
            inset: 0 !important;
            z-index: 100000 !important;
            background: #f8fafc !important;
            color: #0f172a !important;
            display: flex !important;
            flex-direction: column !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
            overflow: hidden !important;
            box-sizing: border-box !important;
        }
        #voice-editor-modal * {
            box-sizing: border-box !important;
            -webkit-tap-highlight-color: transparent !important;
        }

        .vt-header {
            height: 56px;
            background: #ffffff;
            border-bottom: 1px solid #e2e8f0;
            padding: 0 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-shrink: 0;
            z-index: 20;
        }
        .vt-header-title-input {
            border: none;
            background: transparent;
            font-size: 16px;
            font-weight: 700;
            color: #0f172a;
            outline: none;
            width: 100%;
            padding: 4px 6px;
            border-radius: 6px;
        }
        .vt-header-title-input:focus {
            background: #f1f5f9;
        }

        .vt-body-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            max-width: 520px;
            margin: 0 auto;
            width: 100%;
            display: flex;
            flex-direction: column;
            gap: 14px;
            padding-bottom: 32px;
        }

        .vt-card {
            background: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 20px;
            padding: 16px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.04);
        }

        .vt-timer-display {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 36px;
            font-weight: 800;
            color: #1e293b;
            letter-spacing: -0.02em;
            margin: 2px 0;
        }
        .vt-timer-display.recording {
            color: #dc2626;
            animation: vtPulse 1.5s infinite alternate;
        }

        @keyframes vtPulse {
            0% { opacity: 1; transform: scale(1); }
            100% { opacity: 0.85; transform: scale(1.02); }
        }

        .vt-btn-primary {
            padding: 14px;
            background: linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%);
            color: #ffffff;
            font-size: 14px;
            font-weight: 700;
            border: none;
            border-radius: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            cursor: pointer;
            box-shadow: 0 3px 10px rgba(79,70,229,0.25);
            transition: transform 0.1s;
        }
        .vt-btn-primary:active {
            transform: scale(0.98);
        }

        .vt-btn-secondary {
            padding: 14px;
            background: #ffffff;
            color: #1e293b;
            font-size: 14px;
            font-weight: 700;
            border: 1px solid #e2e8f0;
            border-radius: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            cursor: pointer;
            box-shadow: 0 1px 2px rgba(0,0,0,0.03);
            transition: transform 0.1s, background 0.15s;
        }
        .vt-btn-secondary:active {
            transform: scale(0.98);
            background: #f8fafc;
        }

        .vt-badge {
            font-size: 10px;
            font-weight: 700;
            padding: 3px 8px;
            border-radius: 9999px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        .vt-badge-ready { background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; }
        .vt-badge-rec { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
        .vt-badge-paused { background: #fffbeb; color: #d97706; border: 1px solid #fde68a; }

        .vt-ai-chip {
            padding: 8px 12px;
            background: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 700;
            color: #334155;
            display: flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
            transition: all 0.12s;
        }
        .vt-ai-chip:active {
            transform: scale(0.96);
            background: #f1f5f9;
        }

        .vt-speed-btn {
            padding: 3px 7px;
            font-size: 11px;
            font-weight: 600;
            background: #f1f5f9;
            color: #475569;
            border: none;
            border-radius: 6px;
            cursor: pointer;
        }
        .vt-speed-btn.active {
            background: #4f46e5;
            color: #ffffff;
            font-weight: 700;
        }
    `;
    document.head.appendChild(style);
}

// ── IndexedDB Storage ──
function getDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveAudioToIDB(id, blob) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.put({ id, data: blob });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.error('[Voice] IDB save error:', e);
    }
}

async function getAudioFromIDB(id) {
    try {
        const db = await getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result ? req.result.data : null);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        console.error('[Voice] IDB read error:', e);
        return null;
    }
}

function getDocsIndex() {
    try {
        const idx = localStorage.getItem(VOICE_DOCS_INDEX);
        return idx ? JSON.parse(idx) : [];
    } catch (e) {
        return [];
    }
}

function updateDocsIndex(id, title, duration = 0, snippet = '') {
    const idx = getDocsIndex();
    const existing = idx.find(d => d.id === id);
    if (existing) {
        existing.title = title;
        if (duration) existing.duration = duration;
        if (snippet) existing.snippet = snippet;
        existing.updatedAt = new Date().toISOString();
    } else {
        idx.push({
            id,
            title,
            type: 'voice',
            duration: duration || 0,
            snippet: snippet || '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    }
    localStorage.setItem(VOICE_DOCS_INDEX, JSON.stringify(idx));
}

// ── Helpers ──
function formatTime(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
    const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function getSupportedMimeType() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/aac',
        'audio/ogg;codecs=opus'
    ];
    for (const type of candidates) {
        if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
}

function setAudioUrl(url) {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = url;
}

// ── Web Audio & Visualizer ──
function initAudioContext() {
    if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
            audioCtx = new AudioContextClass();
        }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

function startVisualizer(stream) {
    initAudioContext();
    if (!audioCtx) return;

    try {
        analyserNode = audioCtx.createAnalyser();
        analyserNode.fftSize = 64;
        analyserNode.smoothingTimeConstant = 0.8;

        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyserNode);

        const canvas = document.getElementById('voice-visualizer-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        const bufferLength = analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            if (!isRecording) {
                drawIdleVisualizer(canvas, ctx);
                return;
            }

            visualizerAnimFrame = requestAnimationFrame(draw);
            analyserNode.getByteFrequencyData(dataArray);

            const width = canvas.width;
            const height = canvas.height;
            ctx.clearRect(0, 0, width, height);

            const barCount = 20;
            const barWidth = Math.max(3, (width / barCount) - 4);
            const step = Math.floor(bufferLength / barCount);

            for (let i = 0; i < barCount; i++) {
                const value = dataArray[i * step] || 0;
                const percent = Math.min(1, Math.max(0.1, value / 255));
                const barHeight = Math.max(6, percent * (height * 0.85));

                const x = i * (barWidth + 4) + (width - (barCount * (barWidth + 4))) / 2;
                const y = (height - barHeight) / 2;

                const grad = ctx.createLinearGradient(0, y, 0, y + barHeight);
                if (isPaused) {
                    grad.addColorStop(0, '#f59e0b');
                    grad.addColorStop(1, '#d97706');
                } else {
                    grad.addColorStop(0, '#4f46e5');
                    grad.addColorStop(1, '#06b6d4');
                }

                ctx.fillStyle = grad;
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(x, y, barWidth, barHeight, 3);
                else ctx.rect(x, y, barWidth, barHeight);
                ctx.fill();
            }
        };

        draw();
    } catch (err) {
        console.warn('[Voice] Visualizer error:', err);
    }
}

function drawIdleVisualizer(canvas, ctx) {
    if (!canvas || !ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const barCount = 18;
    const barWidth = Math.max(3, (width / barCount) - 4);

    for (let i = 0; i < barCount; i++) {
        const x = i * (barWidth + 4) + (width - (barCount * (barWidth + 4))) / 2;
        const wave = Math.sin((i / barCount) * Math.PI);
        const barHeight = 8 + (wave * 12);
        const y = (height - barHeight) / 2;

        ctx.fillStyle = '#e2e8f0';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, barWidth, barHeight, 3);
        else ctx.rect(x, y, barWidth, barHeight);
        ctx.fill();
    }
}

function stopVisualizer() {
    if (visualizerAnimFrame) {
        cancelAnimationFrame(visualizerAnimFrame);
        visualizerAnimFrame = null;
    }
    const canvas = document.getElementById('voice-visualizer-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        drawIdleVisualizer(canvas, ctx);
    }
}

// ── Continuous Speech Recognition (Live Microphone STT) ──
function startLiveRecognition(modalEl, lang = 'en-US') {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        updateRecognitionStatus('STT not supported (type notes directly)', 'gray');
        return;
    }

    speechLang = lang;
    shouldRestartRecognizer = true;

    try {
        if (speechRecognizer) {
            try { speechRecognizer.abort(); } catch (_) {}
        }

        speechRecognizer = new SpeechRecognition();
        speechRecognizer.continuous = true;
        speechRecognizer.interimResults = true;
        speechRecognizer.lang = lang;

        speechRecognizer.onstart = () => {
            isLiveTranscribing = true;
            updateRecognitionStatus('Transcribing speech live...', 'emerald');
        };

        speechRecognizer.onresult = (event) => {
            interimTranscript = '';
            let newFinalChunk = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                const item = event.results[i];
                if (item.isFinal) {
                    newFinalChunk += item[0].transcript + ' ';
                } else {
                    interimTranscript += item[0].transcript;
                }
            }

            if (newFinalChunk) {
                committedTranscript = (committedTranscript + ' ' + newFinalChunk).trim();
            }

            renderTranscript(modalEl);
        };

        speechRecognizer.onerror = (e) => {
            if (e.error === 'not-allowed') {
                shouldRestartRecognizer = false;
                updateRecognitionStatus('Microphone blocked', 'red');
            } else if (e.error !== 'no-speech') {
                updateRecognitionStatus(`Speech notice: ${e.error}`, 'amber');
            }
        };

        speechRecognizer.onend = () => {
            isLiveTranscribing = false;
            if (isRecording && !isPaused && shouldRestartRecognizer) {
                try { speechRecognizer.start(); } catch (_) {}
            } else if (!isRecording) {
                updateRecognitionStatus('Ready', 'gray');
            }
        };

        speechRecognizer.start();
    } catch (err) {
        console.warn('[Voice] Speech recognition init error:', err);
    }
}

function stopLiveRecognition() {
    shouldRestartRecognizer = false;
    if (speechRecognizer) {
        try { speechRecognizer.stop(); } catch (_) {}
        speechRecognizer = null;
    }
    isLiveTranscribing = false;
}

function updateRecognitionStatus(text, color = 'gray') {
    const badge = document.getElementById('stt-status-badge');
    if (!badge) return;
    badge.textContent = text;
    if (color === 'emerald') {
        badge.style.background = '#ecfdf5';
        badge.style.color = '#059669';
        badge.style.border = '1px solid #a7f3d0';
    } else if (color === 'amber') {
        badge.style.background = '#fffbeb';
        badge.style.color = '#d97706';
        badge.style.border = '1px solid #fde68a';
    } else if (color === 'red') {
        badge.style.background = '#fef2f2';
        badge.style.color = '#dc2626';
        badge.style.border = '1px solid #fecaca';
    } else {
        badge.style.background = '#f1f5f9';
        badge.style.color = '#64748b';
        badge.style.border = '1px solid #e2e8f0';
    }
}

function renderTranscript(modalEl) {
    const textarea = modalEl.querySelector('#transcription-text');
    const interimEl = modalEl.querySelector('#interim-transcript-preview');
    const wordCountEl = modalEl.querySelector('#transcript-word-count');

    if (textarea) {
        textarea.value = committedTranscript;
    }

    if (interimEl) {
        if (interimTranscript) {
            interimEl.textContent = '… ' + interimTranscript;
            interimEl.style.display = 'block';
        } else {
            interimEl.textContent = '';
            interimEl.style.display = 'none';
        }
    }

    if (wordCountEl) {
        const fullText = (committedTranscript + ' ' + interimTranscript).trim();
        const words = fullText ? fullText.split(/\s+/).length : 0;
        wordCountEl.textContent = `${words} words • ${fullText.length} chars`;
    }
}

// ── Audio File Resampling for Whisper ──
async function decodeAudioFileTo16kMono(file) {
    const arrayBuffer = await file.arrayBuffer();
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
    
    // Resample to 16000Hz mono
    const targetSampleRate = 16000;
    const offlineCtx = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * targetSampleRate), targetSampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const resampled = await offlineCtx.startRendering();
    tempCtx.close();
    return resampled.getChannelData(0);
}

// ── Transcribe Uploaded Audio File ──
async function transcribeAudioFile(file, modalEl) {
    const statusBox = modalEl.querySelector('#transcribe-file-status');
    const statusText = modalEl.querySelector('#transcribe-status-text');
    const langSelect = modalEl.querySelector('#voice-lang-select');
    const selectedLang = langSelect ? langSelect.value : 'en-US';

    if (statusBox) statusBox.style.display = 'flex';
    if (statusText) statusText.textContent = 'Decoding audio file...';

    // 1. Try Gemini API first if configured (super fast cloud audio transcription)
    const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (geminiKey && geminiKey !== 'your_gemini_key_here') {
        try {
            if (statusText) statusText.textContent = 'Transcribing with Gemini AI...';
            const base64Audio = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(file);
            });

            const model = 'gemini-1.5-flash';
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { inline_data: { mime_type: file.type || 'audio/mp3', data: base64Audio } },
                            { text: "Transcribe this audio recording verbatim. Output only the transcribed spoken text without commentary." }
                        ]
                    }]
                })
            });

            if (res.ok) {
                const data = await res.json();
                const text = data.candidates[0].content.parts[0].text.trim();
                committedTranscript = text;
                interimTranscript = '';
                renderTranscript(modalEl);
                if (statusBox) statusBox.style.display = 'none';
                if (window.showToast) window.showToast('Audio file transcribed successfully!', false);
                saveRecording(modalEl, true);
                return;
            }
        } catch (err) {
            console.warn('[Voice] Cloud STT error, trying in-browser Whisper:', err);
        }
    }

    // 2. In-Browser Whisper Transcription (Web Worker)
    try {
        if (statusText) statusText.textContent = 'Resampling audio to 16kHz...';
        const pcmData = await decodeAudioFileTo16kMono(file);

        if (!whisperWorker) {
            if (statusText) statusText.textContent = 'Loading Whisper AI model (first time only)...';
            whisperWorker = new Worker('/voice-worker.js', { type: 'module' });
        }

        whisperWorker.onmessage = (e) => {
            const { type, data, result, error, status } = e.data;
            if (type === 'progress' && data && data.progress) {
                if (statusText) statusText.textContent = `Loading AI: ${Math.round(data.progress)}%`;
            } else if (type === 'status') {
                if (statusText) statusText.textContent = status || 'Transcribing...';
            } else if (type === 'result' && result) {
                committedTranscript = result.text ? result.text.trim() : '';
                interimTranscript = '';
                renderTranscript(modalEl);
                if (statusBox) statusBox.style.display = 'none';
                if (window.showToast) window.showToast('Audio transcribed successfully!', false);
                saveRecording(modalEl, true);
            } else if (type === 'error') {
                console.warn('[Whisper Worker Error]:', error);
                fallbackFileTranscription(modalEl);
            }
        };

        whisperWorker.onerror = (err) => {
            console.warn('[Whisper Worker Failed]:', err);
            fallbackFileTranscription(modalEl);
        };

        if (statusText) statusText.textContent = 'Transcribing audio speech...';
        whisperWorker.postMessage({
            type: 'transcribe',
            audio: pcmData,
            language: selectedLang
        });

    } catch (e) {
        console.error('[Voice] Audio file transcription error:', e);
        fallbackFileTranscription(modalEl);
    }
}

function fallbackFileTranscription(modalEl) {
    const statusBox = modalEl.querySelector('#transcribe-file-status');
    if (statusBox) statusBox.style.display = 'none';
    if (window.showToast) window.showToast('Audio loaded in player. Type notes directly or use live recording.', false);
}

// ── Recording Lifecycle ──
async function startRecording(modalEl) {
    try {
        initAudioContext();
        activeStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });

        const mimeType = getSupportedMimeType();
        mediaRecorder = new MediaRecorder(activeStream, mimeType ? { mimeType } : undefined);
        audioChunks = [];
        currentAudioBlob = null;

        mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
            if (activeStream) {
                activeStream.getTracks().forEach(t => t.stop());
                activeStream = null;
            }
            stopLiveRecognition();
            stopVisualizer();

            if (!audioChunks.length) return;

            const actualType = mediaRecorder.mimeType || 'audio/webm';
            currentAudioBlob = new Blob(audioChunks, { type: actualType });
            setAudioUrl(URL.createObjectURL(currentAudioBlob));

            if (document.body.contains(modalEl)) {
                setupCustomPlayer(modalEl, audioUrl);
                modalEl.querySelector('#btn-save').disabled = false;
                modalEl.querySelector('#player-card').style.display = 'block';
                modalEl.querySelector('#export-card').style.display = 'block';
                resetRecordUI(modalEl);
                saveRecording(modalEl, true);
            }
        };

        mediaRecorder.start(1000);
        isRecording = true;
        isPaused = false;
        startTime = Date.now();
        elapsedBeforePause = 0;

        clearInterval(timerInterval);
        timerInterval = setInterval(() => updateTimer(modalEl), 250);

        startVisualizer(activeStream);

        const langSelect = modalEl.querySelector('#voice-lang-select');
        const selectedLang = langSelect ? langSelect.value : 'en-US';
        startLiveRecognition(modalEl, selectedLang);

        // Update UI
        modalEl.querySelector('#record-idle-controls').style.display = 'none';
        modalEl.querySelector('#record-active-controls').style.display = 'flex';
        const timerEl = modalEl.querySelector('#voice-timer');
        timerEl.classList.add('recording');
        const indicator = modalEl.querySelector('#rec-status-indicator');
        indicator.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:#ef4444;display:inline-block;margin-right:4px;"></span> RECORDING';
        indicator.className = 'vt-badge vt-badge-rec';

    } catch (e) {
        console.error('[Voice] Mic error:', e);
        if (window.showToast) window.showToast('Microphone access denied or not supported', true);
        resetRecordUI(modalEl);
    }
}

function pauseRecording(modalEl) {
    if (!mediaRecorder || !isRecording) return;
    const pauseBtn = modalEl.querySelector('#btn-pause-rec');
    const indicator = modalEl.querySelector('#rec-status-indicator');
    if (!isPaused) {
        mediaRecorder.pause();
        isPaused = true;
        elapsedBeforePause += Math.floor((Date.now() - startTime) / 1000);
        pauseBtn.innerHTML = '<i class="fas fa-play" style="color:#059669;"></i> <span>Resume</span>';
        pauseBtn.style.background = '#ecfdf5';
        pauseBtn.style.color = '#059669';
        indicator.innerHTML = 'PAUSED';
        indicator.className = 'vt-badge vt-badge-paused';
    } else {
        mediaRecorder.resume();
        isPaused = false;
        startTime = Date.now();
        pauseBtn.innerHTML = '<i class="fas fa-pause" style="color:#d97706;"></i> <span>Pause</span>';
        pauseBtn.style.background = '#fffbeb';
        pauseBtn.style.color = '#d97706';
        indicator.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:#ef4444;display:inline-block;margin-right:4px;"></span> RECORDING';
        indicator.className = 'vt-badge vt-badge-rec';
    }
}

function stopRecording(modalEl) {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        isPaused = false;
        clearInterval(timerInterval);
    }
    stopLiveRecognition();
    stopVisualizer();
}

function discardRecording(modalEl) {
    if (!isRecording && !currentAudioBlob) return;
    if (confirm('Discard this recording?')) {
        if (isRecording) {
            shouldRestartRecognizer = false;
            if (activeStream) {
                activeStream.getTracks().forEach(t => t.stop());
                activeStream = null;
            }
            if (mediaRecorder) {
                try { mediaRecorder.onstop = null; mediaRecorder.stop(); } catch (_) {}
            }
            isRecording = false;
            isPaused = false;
            clearInterval(timerInterval);
            stopLiveRecognition();
            stopVisualizer();
        }
        audioChunks = [];
        currentAudioBlob = null;
        if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
        if (audioPlayerEl) {
            audioPlayerEl.pause();
            audioPlayerEl.src = '';
        }
        committedTranscript = '';
        interimTranscript = '';
        renderTranscript(modalEl);
        resetRecordUI(modalEl);
        modalEl.querySelector('#player-card').style.display = 'none';
        modalEl.querySelector('#export-card').style.display = 'none';
        modalEl.querySelector('#voice-timer').textContent = '00:00';
        if (window.showToast) window.showToast('Recording discarded', false);
    }
}

function updateTimer(modalEl) {
    if (!isRecording || isPaused) return;
    if (!document.body.contains(modalEl)) {
        stopRecording(modalEl);
        return;
    }
    const elapsed = elapsedBeforePause + Math.floor((Date.now() - startTime) / 1000);
    const timerEl = modalEl.querySelector('#voice-timer');
    if (timerEl) timerEl.textContent = formatTime(elapsed);

    if (elapsed >= 600) {
        if (window.showToast) window.showToast('Max recording limit (10 min) reached', false);
        stopRecording(modalEl);
    }
}

function resetRecordUI(modalEl) {
    modalEl.querySelector('#record-idle-controls').style.display = 'flex';
    modalEl.querySelector('#record-active-controls').style.display = 'none';
    const timerEl = modalEl.querySelector('#voice-timer');
    timerEl.classList.remove('recording');
    const indicator = modalEl.querySelector('#rec-status-indicator');
    indicator.innerHTML = '<i class="fas fa-circle" style="font-size:7px;color:#94a3b8;margin-right:4px;"></i> READY';
    indicator.className = 'vt-badge vt-badge-ready';
}

// ── Custom Audio Waveform Player ──
function setupCustomPlayer(modalEl, src) {
    if (!audioPlayerEl) {
        audioPlayerEl = new Audio();
    }
    audioPlayerEl.src = src;
    audioPlayerEl.playbackRate = currentPlaybackSpeed;
    isPlayingAudio = false;

    const playBtn = modalEl.querySelector('#btn-play-pause');
    const playIcon = modalEl.querySelector('#play-pause-icon');
    const scrubber = modalEl.querySelector('#player-scrubber');
    const curTimeEl = modalEl.querySelector('#player-current-time');
    const durTimeEl = modalEl.querySelector('#player-duration-time');

    audioPlayerEl.onloadedmetadata = () => {
        if (durTimeEl) durTimeEl.textContent = formatTime(audioPlayerEl.duration || 0);
        if (curTimeEl) curTimeEl.textContent = '00:00';
        if (scrubber) {
            scrubber.value = 0;
            scrubber.max = Math.floor(audioPlayerEl.duration || 0);
        }
    };

    audioPlayerEl.onended = () => {
        isPlayingAudio = false;
        if (playIcon) playIcon.className = 'fas fa-play';
        if (scrubber) scrubber.value = 0;
        if (curTimeEl) curTimeEl.textContent = '00:00';
    };

    audioPlayerEl.ontimeupdate = () => {
        if (curTimeEl) curTimeEl.textContent = formatTime(audioPlayerEl.currentTime);
        if (scrubber && !scrubber.matches(':active')) {
            scrubber.value = Math.floor(audioPlayerEl.currentTime);
        }
    };

    if (playBtn) {
        playBtn.onclick = () => {
            if (!audioPlayerEl.src) return;
            if (audioPlayerEl.paused) {
                audioPlayerEl.play().then(() => {
                    isPlayingAudio = true;
                    if (playIcon) playIcon.className = 'fas fa-pause';
                }).catch(err => console.warn('Play blocked:', err));
            } else {
                audioPlayerEl.pause();
                isPlayingAudio = false;
                if (playIcon) playIcon.className = 'fas fa-play';
            }
        };
    }

    if (scrubber) {
        scrubber.oninput = (e) => {
            if (audioPlayerEl) {
                audioPlayerEl.currentTime = parseFloat(e.target.value);
                if (curTimeEl) curTimeEl.textContent = formatTime(audioPlayerEl.currentTime);
            }
        };
    }

    const btnSkipBack = modalEl.querySelector('#btn-skip-back');
    const btnSkipForward = modalEl.querySelector('#btn-skip-forward');
    if (btnSkipBack) {
        btnSkipBack.onclick = () => {
            if (audioPlayerEl) audioPlayerEl.currentTime = Math.max(0, audioPlayerEl.currentTime - 5);
        };
    }
    if (btnSkipForward) {
        btnSkipForward.onclick = () => {
            if (audioPlayerEl) audioPlayerEl.currentTime = Math.min(audioPlayerEl.duration || 999, audioPlayerEl.currentTime + 5);
        };
    }

    modalEl.querySelectorAll('.vt-speed-btn').forEach(btn => {
        btn.onclick = () => {
            const speed = parseFloat(btn.dataset.speed);
            currentPlaybackSpeed = speed;
            if (audioPlayerEl) audioPlayerEl.playbackRate = speed;
            modalEl.querySelectorAll('.vt-speed-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        };
    });
}

// ── Smart AI Actions (Polish, Summary, Tasks, Translate) ──
async function handleSmartAiAction(actionType, modalEl) {
    const rawText = modalEl.querySelector('#transcription-text').value.trim();
    if (!rawText) {
        if (window.showToast) window.showToast('Please record speech or enter text first', true);
        return;
    }

    const aiOutputBox = modalEl.querySelector('#ai-result-box');
    const aiOutputText = modalEl.querySelector('#ai-result-text');
    const aiSpinner = modalEl.querySelector('#ai-loading-spinner');
    const aiTitle = modalEl.querySelector('#ai-result-title');

    aiOutputBox.style.display = 'block';
    aiOutputText.style.display = 'none';
    aiSpinner.style.display = 'flex';

    let prompt = '';
    let actionTitle = 'AI Result';

    if (actionType === 'polish') {
        actionTitle = '🪄 Formatted & Polished Transcript';
        prompt = `You are a professional audio transcript editor. Polish this voice transcript: remove filler words (um, uh, like), fix grammar, add proper punctuation and neat paragraph formatting:\n"""${rawText}"""`;
    } else if (actionType === 'summary') {
        actionTitle = '📋 Key Summary & Bullet Points';
        prompt = `Create a clear bullet-point summary of key highlights and main points from this spoken voice transcript:\n"""${rawText}"""`;
    } else if (actionType === 'tasks') {
        actionTitle = '✅ Action Items & To-Dos';
        prompt = `Extract all tasks, action items, and to-dos from this voice transcript. Format with [ ] checkboxes:\n"""${rawText}"""`;
    } else if (actionType === 'translate') {
        const langSelect = modalEl.querySelector('#voice-lang-select');
        const langName = langSelect ? langSelect.options[langSelect.selectedIndex].text : 'English';
        actionTitle = `🌐 Translation (${langName})`;
        prompt = `Translate the following voice transcript accurately into ${langName}. Preserve meaning and natural tone:\n"""${rawText}"""`;
    }

    if (aiTitle) aiTitle.textContent = actionTitle;

    try {
        let result = '';
        const deepseekKey = import.meta.env.VITE_DEEPSEEK_API_KEY;
        const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;

        if (deepseekKey && deepseekKey !== 'your_deepseek_key_here') {
            const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deepseekKey}` },
                body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 1200 })
            });
            if (res.ok) {
                const data = await res.json();
                result = data.choices[0].message.content.trim();
            }
        } else if (geminiKey && geminiKey !== 'your_gemini_key_here') {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });
            if (res.ok) {
                const data = await res.json();
                result = data.candidates[0].content.parts[0].text.trim();
            }
        }

        // Instant offline rule-based fallback
        if (!result) {
            await new Promise(r => setTimeout(r, 500));
            if (actionType === 'polish') {
                result = rawText
                    .replace(/\b(um+|uh+|err+|like,\s*|you know,\s*|ah+)\b/gi, '')
                    .replace(/\s{2,}/g, ' ')
                    .replace(/(^\s*|\.\s+|\?\s+|\!\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase())
                    .trim();
                if (!/[.!?]$/.test(result)) result += '.';
            } else if (actionType === 'summary') {
                const sentences = rawText.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 8);
                result = sentences.length ? sentences.slice(0, 4).map(s => `• ${s.trim()}`).join('\n') : '• Audio note recorded.';
            } else if (actionType === 'tasks') {
                result = `[ ] Review voice transcript\n[ ] Follow up on discussed items`;
            } else {
                result = `[Translated Transcript]:\n\n${rawText}`;
            }
        }

        aiSpinner.style.display = 'none';
        aiOutputText.style.display = 'block';
        aiOutputText.value = result;
        if (window.showToast) window.showToast('AI analysis complete!', false);

    } catch (e) {
        console.error('[AI Error]:', e);
        aiSpinner.style.display = 'none';
        aiOutputText.style.display = 'block';
        aiOutputText.value = 'AI processing encountered an error. Please try again.';
    }
}

// ── Save & Storage ──
async function saveRecording(modalEl, isAutoSave = false) {
    const isEditing = !!currentDocId;
    const titleInput = modalEl.querySelector('#voice-doc-title');
    const title = (titleInput && titleInput.value.trim()) ? titleInput.value.trim() : 'Voice Memo';
    const transcriptText = modalEl.querySelector('#transcription-text').value || '';
    const docId = currentDocId || ('voice_' + Date.now());

    try {
        if (currentAudioBlob) {
            await saveAudioToIDB(docId, currentAudioBlob);
        }

        const duration = audioPlayerEl ? Math.floor(audioPlayerEl.duration || 0) : 0;
        const snippet = transcriptText.slice(0, 100);

        localStorage.setItem(VOICE_STORAGE_KEY_PREFIX + docId, JSON.stringify({
            id: docId,
            title: title,
            type: 'voice',
            transcript: transcriptText,
            duration: duration,
            updatedAt: new Date().toISOString()
        }));

        currentDocId = docId;
        updateDocsIndex(docId, title, duration, snippet);

        const saveBadge = modalEl.querySelector('#save-status-badge');
        if (saveBadge) {
            saveBadge.innerHTML = '<i class="fas fa-check" style="color:#059669;"></i> Saved';
            saveBadge.style.color = '#059669';
            saveBadge.style.background = '#ecfdf5';
            saveBadge.style.borderColor = '#a7f3d0';
            setTimeout(() => {
                if (saveBadge) {
                    saveBadge.innerHTML = 'Auto-Saved';
                    saveBadge.style.color = '#64748b';
                    saveBadge.style.background = '#f1f5f9';
                    saveBadge.style.borderColor = '#e2e8f0';
                }
            }, 2500);
        }

        if (!isAutoSave && window.showToast) {
            window.showToast(isEditing ? 'Saved!' : 'Recording saved to My Documents!', false);
        }
    } catch (e) {
        console.error('[Voice] Save error:', e);
        if (!isAutoSave && window.showToast) window.showToast('Storage error', true);
    }
}

// ── Export & Share ──
async function shareToWhatsApp(modalEl) {
    const title = modalEl.querySelector('#voice-doc-title').value || 'Voice Memo';
    const transcript = modalEl.querySelector('#transcription-text').value || '';
    const textToShare = `🎙️ *${title}*\n\n${transcript ? '📝 *Transcript & Notes:*\n' + transcript : ''}\n\n— Created with Kivu AI Voice`;
    const waUrl = `https://wa.me/?text=${encodeURIComponent(textToShare)}`;
    window.open(waUrl, '_blank');
}

function downloadAudioFile(modalEl) {
    if (!currentAudioBlob) {
        if (window.showToast) window.showToast('No audio recording to download', true);
        return;
    }
    const title = modalEl.querySelector('#voice-doc-title').value || 'Voice_Memo';
    const ext = currentAudioBlob.type.includes('mp4') ? 'm4a' : 'webm';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(currentAudioBlob);
    a.download = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function exportNoteAsText(modalEl) {
    const title = modalEl.querySelector('#voice-doc-title').value || 'Voice_Memo';
    const transcript = modalEl.querySelector('#transcription-text').value || '';
    const content = `${title}\nDate: ${new Date().toLocaleString()}\n\nTRANSCRIPT & NOTES:\n${transcript}\n`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    if (window.showToast) window.showToast('Text note exported!', false);
}

function copyTranscript(modalEl) {
    const transcript = modalEl.querySelector('#transcription-text').value || '';
    if (!transcript) {
        if (window.showToast) window.showToast('No text to copy', true);
        return;
    }
    navigator.clipboard.writeText(transcript).then(() => {
        if (window.showToast) window.showToast('Transcript copied to clipboard!', false);
    });
}

// ── Main Init ──
export async function init(docId = null) {
    const existingModal = document.getElementById('voice-editor-modal');
    if (existingModal) {
        stopRecording(existingModal);
        existingModal.remove();
    }

    injectVoiceStyles();

    audioChunks = [];
    currentAudioBlob = null;
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
    currentDocId = docId || null;
    committedTranscript = '';
    interimTranscript = '';
    isRecording = false;
    isPaused = false;

    const modalHtml = `
        <div id="voice-editor-modal">
            
            <!-- TOP APP BAR -->
            <div class="vt-header">
                <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
                    <button id="btn-back" style="width:36px;height:36px;border-radius:50%;background:transparent;border:none;color:#475569;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;" aria-label="Back">
                        <i class="fas fa-arrow-left"></i>
                    </button>
                    <div style="display:flex;align-items:center;gap:4px;flex:1;min-width:0;">
                        <input type="text" id="voice-doc-title" value="Voice Memo" class="vt-header-title-input" placeholder="Memo Title...">
                        <i class="fas fa-pen" style="font-size:10px;color:#94a3b8;flex-shrink:0;"></i>
                    </div>
                </div>

                <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:8px;">
                    <span id="save-status-badge" class="vt-badge vt-badge-ready">Auto-Saved</span>
                    <button id="btn-save" style="padding:6px 14px;background:#4f46e5;color:#ffffff;font-weight:700;font-size:12px;border:none;border-radius:10px;display:flex;align-items:center;gap:6px;cursor:pointer;box-shadow:0 1px 3px rgba(79,70,229,0.3);">
                        <i class="fas fa-check"></i> <span>Save</span>
                    </button>
                </div>
            </div>

            <!-- MAIN FOCUSED FLOW -->
            <div class="vt-body-container">
                
                <!-- 1. RECORD & AUDIO CARD -->
                <div class="vt-card" style="display:flex;flex-direction:column;align-items:center;gap:10px;">
                    
                    <!-- Language & Status Bar -->
                    <div style="width:100%;display:flex;align-items:center;justify-content:space-between;">
                        <span id="rec-status-indicator" class="vt-badge vt-badge-ready">
                            <i class="fas fa-circle" style="font-size:7px;color:#94a3b8;margin-right:4px;"></i> READY
                        </span>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <i class="fas fa-globe" style="font-size:12px;color:#94a3b8;"></i>
                            <select id="voice-lang-select" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:3px 8px;font-size:11px;font-weight:600;color:#334155;outline:none;">
                                <option value="auto">🌐 Auto-Detect</option>
                                <option value="en-US">English</option>
                                <option value="sw-KE">Kiswahili</option>
                                <option value="fr-FR">Français</option>
                                <option value="rw-RW">Kinyarwanda</option>
                                <option value="es-ES">Español</option>
                                <option value="ar-SA">العربية</option>
                                <option value="zh-CN">中文</option>
                                <option value="pt-BR">Português</option>
                                <option value="de-DE">Deutsch</option>
                            </select>
                        </div>
                    </div>

                    <!-- Visualizer Canvas -->
                    <div style="width:100%;height:64px;display:flex;align-items:center;justify-content:center;">
                        <canvas id="voice-visualizer-canvas" width="340" height="64" style="width:100%;height:100%;"></canvas>
                    </div>

                    <!-- Digital Timer -->
                    <div id="voice-timer" class="vt-timer-display">00:00</div>

                    <!-- STT live badge -->
                    <div>
                        <span id="stt-status-badge" class="vt-badge vt-badge-ready">
                            Speech-to-Text Transcriber Active
                        </span>
                    </div>

                    <!-- Action Controls -->
                    <div style="width:100%;margin-top:6px;">
                        <!-- State 1: IDLE -->
                        <div id="record-idle-controls" style="display:grid;grid-template-columns:1.6fr 1.2fr;gap:10px;width:100%;">
                            <button id="btn-start-rec" class="vt-btn-primary">
                                <i class="fas fa-microphone" style="font-size:16px;"></i>
                                <span>Record Voice</span>
                            </button>
                            <label class="vt-btn-secondary" title="Upload Audio File">
                                <i class="fas fa-file-audio" style="color:#4f46e5;font-size:16px;"></i>
                                <span>Import Audio</span>
                                <input type="file" id="upload-audio-file-input" accept="audio/*" style="display:none;">
                            </label>
                        </div>

                        <!-- State 2: RECORDING ACTIVE -->
                        <div id="record-active-controls" style="display:none;align-items:center;gap:8px;width:100%;">
                            <button id="btn-discard-rec" style="width:48px;height:48px;background:#f1f5f9;color:#64748b;border:none;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;" title="Discard">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                            <button id="btn-pause-rec" style="flex:1;height:48px;background:#fffbeb;color:#d97706;border:1px solid #fde68a;border-radius:14px;display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:700;cursor:pointer;">
                                <i class="fas fa-pause"></i>
                                <span>Pause</span>
                            </button>
                            <button id="btn-finish-rec" style="flex:1.2;height:48px;background:#dc2626;color:#ffffff;border:none;border-radius:14px;display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 3px 10px rgba(220,38,38,0.3);">
                                <i class="fas fa-stop"></i>
                                <span>Finish & Transcribe</span>
                            </button>
                        </div>
                    </div>

                    <!-- File Transcription Status (Shown when file is processing) -->
                    <div id="transcribe-file-status" style="display:none;width:100%;background:#eef2ff;border:1px solid #e0e7ff;border-radius:12px;padding:10px 14px;align-items:center;gap:10px;margin-top:6px;">
                        <i class="fas fa-spinner fa-spin" style="color:#4f46e5;font-size:16px;"></i>
                        <span id="transcribe-status-text" style="font-size:12px;font-weight:600;color:#4f46e5;">Transcribing audio file...</span>
                    </div>

                </div>

                <!-- 2. AUDIO PLAYER CARD (Shown when audio exists) -->
                <div id="player-card" class="vt-card" style="display:none;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                        <span style="font-size:12px;font-weight:700;color:#334155;display:flex;align-items:center;gap:6px;">
                            <i class="fas fa-play-circle" style="color:#4f46e5;"></i> Audio Preview
                        </span>
                        <div style="display:flex;align-items:center;gap:4px;">
                            <button class="vt-speed-btn active" data-speed="1">1x</button>
                            <button class="vt-speed-btn" data-speed="1.25">1.25x</button>
                            <button class="vt-speed-btn" data-speed="1.5">1.5x</button>
                            <button class="vt-speed-btn" data-speed="2">2x</button>
                        </div>
                    </div>

                    <!-- Scrubber -->
                    <div style="display:flex;flex-direction:column;gap:4px;">
                        <input type="range" id="player-scrubber" min="0" max="100" value="0" step="0.1" style="width:100%;height:6px;background:#e2e8f0;border-radius:6px;appearance:none;cursor:pointer;accent-color:#4f46e5;">
                        <div style="display:flex;justify-content:space-between;font-family:monospace;font-size:11px;color:#94a3b8;padding:0 2px;">
                            <span id="player-current-time">00:00</span>
                            <span id="player-duration-time">00:00</span>
                        </div>
                    </div>

                    <!-- Play/Pause & Skip Buttons -->
                    <div style="display:flex;align-items:center;justify-content:center;gap:16px;margin-top:8px;">
                        <button id="btn-skip-back" style="width:36px;height:36px;border-radius:50%;background:#f1f5f9;color:#334155;border:none;display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer;" title="-5s">
                            <i class="fas fa-undo"></i>
                        </button>
                        <button id="btn-play-pause" style="width:44px;height:44px;border-radius:50%;background:#4f46e5;color:#ffffff;border:none;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;box-shadow:0 3px 10px rgba(79,70,229,0.35);" title="Play">
                            <i id="play-pause-icon" class="fas fa-play"></i>
                        </button>
                        <button id="btn-skip-forward" style="width:36px;height:36px;border-radius:50%;background:#f1f5f9;color:#334155;border:none;display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer;" title="+5s">
                            <i class="fas fa-redo"></i>
                        </button>
                    </div>
                </div>

                <!-- 3. TRANSCRIPTION & NOTES (THE HERO SECTION) -->
                <div class="vt-card" style="display:flex;flex-direction:column;gap:10px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f1f5f9;padding-bottom:8px;">
                        <div style="display:flex;align-items:center;gap:6px;">
                            <span style="width:7px;height:7px;border-radius:50%;background:#4f46e5;display:inline-block;"></span>
                            <span style="font-size:13px;font-weight:700;color:#1e293b;">Transcription & Notes</span>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span id="transcript-word-count" style="font-size:10px;font-weight:600;color:#94a3b8;">0 words</span>
                            <button id="btn-copy-transcript" style="background:none;border:none;color:#4f46e5;font-size:11px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:4px;">
                                <i class="fas fa-copy"></i> Copy
                            </button>
                        </div>
                    </div>

                    <!-- Interim live preview bubble -->
                    <div id="interim-transcript-preview" style="display:none;font-size:12px;font-style:italic;color:#4f46e5;background:#eef2ff;padding:8px 12px;border-radius:10px;border:1px solid #e0e7ff;"></div>

                    <!-- Main Editable Transcript -->
                    <textarea id="transcription-text" rows="6" style="width:100%;font-size:14px;color:#1e293b;background:transparent;border:none;resize:none;outline:none;line-height:1.6;font-family:inherit;" placeholder="Spoken words and voice transcription will appear here in real-time. You can also type or edit notes directly..."></textarea>
                    
                    <div style="display:flex;align-items:center;justify-content:space-between;padding-top:6px;border-top:1px solid #f1f5f9;">
                        <button id="btn-clear-transcript" style="background:none;border:none;color:#94a3b8;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:4px;">
                            <i class="fas fa-eraser"></i> Clear text
                        </button>
                    </div>
                </div>

                <!-- 4. SMART AI ASSISTANT CHIPS -->
                <div class="vt-card" style="display:flex;flex-direction:column;gap:10px;">
                    <div style="font-size:12px;font-weight:700;color:#334155;display:flex;align-items:center;gap:6px;">
                        <i class="fas fa-wand-magic-sparkles" style="color:#ec4899;"></i> <span>AI Transcript Tools:</span>
                    </div>

                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                        <button class="vt-ai-chip" data-action="polish">
                            <i class="fas fa-wand-magic-sparkles" style="color:#db2777;"></i>
                            <span>AI Polish Text</span>
                        </button>
                        <button class="vt-ai-chip" data-action="summary">
                            <i class="fas fa-list-check" style="color:#7c3aed;"></i>
                            <span>Smart Summary</span>
                        </button>
                        <button class="vt-ai-chip" data-action="tasks">
                            <i class="fas fa-check-double" style="color:#059669;"></i>
                            <span>Action Items</span>
                        </button>
                        <button class="vt-ai-chip" data-action="translate">
                            <i class="fas fa-language" style="color:#2563eb;"></i>
                            <span>AI Translate</span>
                        </button>
                    </div>

                    <!-- AI Result Output (Shown on demand) -->
                    <div id="ai-result-box" style="display:none;background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:12px;margin-top:6px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;border-bottom:1px solid #e2e8f0;padding-bottom:6px;">
                            <span id="ai-result-title" style="font-size:12px;font-weight:700;color:#4f46e5;">AI Result</span>
                            <button id="btn-apply-ai-to-memo" style="font-size:11px;font-weight:700;color:#4f46e5;background:none;border:none;cursor:pointer;">
                                Insert into Notes ↑
                            </button>
                        </div>
                        <div id="ai-loading-spinner" style="display:none;padding:16px;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:#4f46e5;">
                            <i class="fas fa-spinner fa-spin" style="font-size:18px;"></i>
                            <span style="font-size:11px;color:#64748b;">Analyzing transcript with AI...</span>
                        </div>
                        <textarea id="ai-result-text" rows="5" style="display:none;width:100%;background:transparent;border:none;resize:none;outline:none;font-size:13px;color:#1e293b;line-height:1.5;font-family:inherit;"></textarea>
                    </div>
                </div>

                <!-- 5. EXPORT & SHARE -->
                <div id="export-card" class="vt-card" style="display:flex;flex-direction:column;gap:10px;">
                    <div style="font-size:12px;font-weight:700;color:#334155;">Export & Share</div>
                    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;">
                        <button id="btn-share-whatsapp" style="padding:10px;background:#059669;color:#ffffff;border:none;border-radius:12px;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;">
                            <i class="fab fa-whatsapp" style="font-size:13px;"></i> WhatsApp
                        </button>
                        <button id="btn-download-audio" style="padding:10px;background:#f1f5f9;color:#1e293b;border:1px solid #e2e8f0;border-radius:12px;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;">
                            <i class="fas fa-download" style="color:#64748b;"></i> Audio
                        </button>
                        <button id="btn-export-text" style="padding:10px;background:#f1f5f9;color:#1e293b;border:1px solid #e2e8f0;border-radius:12px;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;">
                            <i class="fas fa-file-lines" style="color:#64748b;"></i> Note .txt
                        </button>
                    </div>
                </div>

            </div>

        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modalEl = document.getElementById('voice-editor-modal');

    // Initialize visualizer canvas with idle state
    const canvas = modalEl.querySelector('#voice-visualizer-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        drawIdleVisualizer(canvas, ctx);
    }

    // ── Events Binding ──
    modalEl.querySelector('#btn-back').addEventListener('click', () => {
        stopRecording(modalEl);
        if (audioPlayerEl) audioPlayerEl.pause();
        if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
        modalEl.remove();
        if (window.renderMyDocuments) window.renderMyDocuments();
    });

    // Recording Controls
    modalEl.querySelector('#btn-start-rec').addEventListener('click', () => startRecording(modalEl));
    modalEl.querySelector('#btn-pause-rec').addEventListener('click', () => pauseRecording(modalEl));
    modalEl.querySelector('#btn-finish-rec').addEventListener('click', () => stopRecording(modalEl));
    modalEl.querySelector('#btn-discard-rec').addEventListener('click', () => discardRecording(modalEl));

    // Save & Copy
    modalEl.querySelector('#btn-save').addEventListener('click', () => saveRecording(modalEl, false));
    modalEl.querySelector('#btn-copy-transcript').addEventListener('click', () => copyTranscript(modalEl));
    modalEl.querySelector('#btn-clear-transcript').addEventListener('click', () => {
        if (confirm('Clear transcript text?')) {
            committedTranscript = '';
            interimTranscript = '';
            renderTranscript(modalEl);
        }
    });

    // Share & Export
    modalEl.querySelector('#btn-share-whatsapp').addEventListener('click', () => shareToWhatsApp(modalEl));
    modalEl.querySelector('#btn-download-audio').addEventListener('click', () => downloadAudioFile(modalEl));
    modalEl.querySelector('#btn-export-text').addEventListener('click', () => exportNoteAsText(modalEl));

    // AI Action Chips
    modalEl.querySelectorAll('.vt-ai-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            if (action) handleSmartAiAction(action, modalEl);
        });
    });

    // Apply AI output back into transcript
    modalEl.querySelector('#btn-apply-ai-to-memo').addEventListener('click', () => {
        const resultText = modalEl.querySelector('#ai-result-text').value;
        if (!resultText) return;
        committedTranscript = resultText;
        interimTranscript = '';
        renderTranscript(modalEl);
        if (window.showToast) window.showToast('Inserted into Notes!', false);
    });

    // Upload & Auto-Transcribe Audio File
    const uploadInput = modalEl.querySelector('#upload-audio-file-input');
    if (uploadInput) {
        uploadInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            if (isRecording) stopRecording(modalEl);
            currentAudioBlob = file;
            setAudioUrl(URL.createObjectURL(file));

            setupCustomPlayer(modalEl, audioUrl);
            modalEl.querySelector('#player-card').style.display = 'block';
            modalEl.querySelector('#export-card').style.display = 'block';
            modalEl.querySelector('#btn-save').disabled = false;
            
            const titleInput = modalEl.querySelector('#voice-doc-title');
            if (titleInput && (titleInput.value === 'Voice Memo' || !titleInput.value)) {
                titleInput.value = file.name.replace(/\.[^/.]+$/, '');
            }

            // Automatically trigger transcription for the uploaded audio file!
            await transcribeAudioFile(file, modalEl);
            e.target.value = '';
        });
    }

    // Load existing document if docId was passed
    if (docId) {
        try {
            const raw = localStorage.getItem(VOICE_STORAGE_KEY_PREFIX + docId);
            if (raw) {
                const parsed = JSON.parse(raw);
                currentDocId = docId;
                modalEl.querySelector('#voice-doc-title').value = parsed.title || 'Voice Memo';
                committedTranscript = parsed.transcript || '';
                interimTranscript = '';
                renderTranscript(modalEl);

                const audioData = await getAudioFromIDB(docId);
                const audioSource = audioData || parsed.audioBase64;

                if (audioSource) {
                    if (audioSource instanceof Blob) {
                        currentAudioBlob = audioSource;
                        setAudioUrl(URL.createObjectURL(audioSource));
                    } else {
                        setAudioUrl(audioSource);
                    }
                    setupCustomPlayer(modalEl, audioUrl);
                    modalEl.querySelector('#player-card').style.display = 'block';
                    modalEl.querySelector('#export-card').style.display = 'block';
                    modalEl.querySelector('#btn-save').disabled = false;
                }
            }
        } catch (e) {
            console.error('[Voice] Document load error:', e);
        }
    }
}