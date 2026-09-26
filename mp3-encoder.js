// src/modules/tools/mp3-encoder.js
// Shared MP3 encoding for converter.js and music.js.
//
// The npm entry of lamejs 1.2.1 throws "MPEGMode is not defined" once bundled
// as an ES module, so the self-contained lame.min.js build is loaded as a
// classic <script> (it defines window.lamejs). Vite emits it as a static asset,
// so it is cached with the rest of the app and works offline.
import lameScriptUrl from 'lamejs/lame.min.js?url';

let lamePromise = null;

function loadLame() {
    if (typeof window !== 'undefined' && window.lamejs && window.lamejs.Mp3Encoder) {
        return Promise.resolve(window.lamejs);
    }
    if (!lamePromise) {
        lamePromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = lameScriptUrl;
            script.async = true;
            script.onload = () => {
                if (window.lamejs && window.lamejs.Mp3Encoder) resolve(window.lamejs);
                else reject(new Error('MP3 encoder failed to initialise'));
            };
            script.onerror = () => reject(new Error('MP3 encoder could not be loaded'));
            document.head.appendChild(script);
        }).catch((err) => {
            lamePromise = null; // allow a retry later (e.g. after reconnecting)
            throw err;
        });
    }
    return lamePromise;
}

/**
 * Encode an AudioBuffer to a mono MP3 Blob.
 * Encoding yields to the event loop regularly so the UI stays responsive on
 * low-end phones, and reports progress (0..1) through onProgress.
 */
export async function encodeMp3(audioBuffer, kbps = 128, onProgress = null) {
    const lame = await loadLame();
    const sampleRate = audioBuffer.sampleRate;
    const encoder = new lame.Mp3Encoder(1, sampleRate, kbps);
    const samples = audioBuffer.getChannelData(0);
    const chunkSize = 1152;
    const chunk = new Int16Array(chunkSize);
    const mp3Data = [];
    const chunksPerYield = 400; // ~10 s of 44.1 kHz audio between yields

    for (let i = 0, n = 0; i < samples.length; i += chunkSize, n++) {
        const len = Math.min(chunkSize, samples.length - i);
        for (let j = 0; j < len; j++) {
            const s = Math.max(-1, Math.min(1, samples[i + j]));
            chunk[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        const buf = encoder.encodeBuffer(len === chunkSize ? chunk : chunk.subarray(0, len));
        if (buf.length > 0) mp3Data.push(new Uint8Array(buf));
        if (n % chunksPerYield === chunksPerYield - 1) {
            if (onProgress) onProgress(i / samples.length);
            await new Promise((r) => setTimeout(r, 0));
        }
    }

    const end = encoder.flush();
    if (end.length > 0) mp3Data.push(new Uint8Array(end));
    if (onProgress) onProgress(1);
    return new Blob(mp3Data, { type: 'audio/mpeg' });
}
