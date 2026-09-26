// src/modules/tools/cupcat/index.js
// CupCat Video Editor — Native Engine Download & Kivu Super App Integration

const CUPCAT_APK_DOWNLOAD_URL = 'https://assets.kivu.site/cupcat.apk';
const STORAGE_KEY_CUPCAT_STATUS = 'kivu_cupcat_installed';

/**
 * Initialize and open the CupCat Video Editor modal.
 * ALWAYS shows the modal — launch is handled by clicking the <a> button inside the modal.
 * Never uses window.location.href for intent:// URLs (that breaks PWA navigation).
 */
export async function init(docId = null, forceModal = false) {
    renderCupCatModal(docId);
}

/**
 * Render and display the CupCat Video Editor modal
 */
function renderCupCatModal(docId = null) {
    const existing = document.getElementById('cupcat-apk-modal');
    if (existing) existing.remove();

    let isInstalled = localStorage.getItem(STORAGE_KEY_CUPCAT_STATUS) === 'true';

    // Build intent URL for the launch button href
    const launchIntentUrl = 'intent://open#Intent;scheme=cupcat;package=com.kivu.cupcat;S.browser_fallback_url=' + encodeURIComponent('about:blank') + ';end';

    const modalHtml = `
    <div id="cupcat-apk-modal" class="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4" style="background:rgba(15,23,42,0.82);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);animation:kvCcFadeIn .25s ease;">
        <style>
            @keyframes kvCcFadeIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes kvCcSlideUp { from { opacity: 0; transform: translateY(24px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
            @keyframes kvCcPulse {
                0% { transform: scale(0.95); opacity: 0.8; }
                50% { transform: scale(1.15); opacity: 0.25; }
                100% { transform: scale(1.3); opacity: 0; }
            }

            .kv-cc-card {
                animation: kvCcSlideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
                background: linear-gradient(165deg, #1e293b 0%, #0f172a 100%);
                border: 1px solid rgba(148, 163, 184, 0.18);
            }

            .kv-cc-glow-icon {
                position: relative;
            }
            .kv-cc-glow-icon::before {
                content: '';
                position: absolute;
                inset: -6px;
                border-radius: 50%;
                background: radial-gradient(circle, rgba(244, 114, 182, 0.45) 0%, rgba(168, 85, 247, 0) 70%);
                animation: kvCcPulse 2.5s infinite ease-out;
                z-index: 0;
            }

            .kv-cc-btn-primary {
                background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%);
                box-shadow: 0 4px 18px rgba(236, 72, 153, 0.4);
                transition: transform 0.15s ease, filter 0.15s ease, box-shadow 0.15s ease;
            }
            .kv-cc-btn-primary:active {
                transform: scale(0.97);
            }

            .kv-cc-btn-launch {
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                box-shadow: 0 4px 18px rgba(16, 185, 129, 0.4);
                transition: transform 0.15s ease, filter 0.15s ease, box-shadow 0.15s ease;
            }
            .kv-cc-btn-launch:active {
                transform: scale(0.97);
            }

            .kv-cc-btn-secondary {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.15);
                color: #e2e8f0;
                transition: all 0.15s ease;
            }
            .kv-cc-btn-secondary:active {
                transform: scale(0.97);
                background: rgba(255, 255, 255, 0.14);
            }

            .kv-cc-step-badge {
                width: 24px;
                height: 24px;
                border-radius: 50%;
                background: rgba(244, 114, 182, 0.2);
                color: #f472b6;
                border: 1px solid rgba(244, 114, 182, 0.4);
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
                font-weight: 800;
                flex-shrink: 0;
            }
        </style>

        <div class="kv-cc-card w-full max-w-md rounded-3xl p-5 sm:p-6 text-white relative shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
            
            <!-- Background Decorative Grid Glow -->
            <div style="position:absolute;top:-60px;right:-60px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,rgba(244,114,182,0.2) 0%,transparent 70%);pointer-events:none;"></div>
            <div style="position:absolute;bottom:-60px;left:-60px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,rgba(168,85,247,0.15) 0%,transparent 70%);pointer-events:none;"></div>

            <!-- Top Bar -->
            <div class="flex items-center justify-between mb-3 relative z-10">
                <button id="kv-cc-close-btn" class="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-slate-300 hover:text-white transition-all">
                    <i class="fas fa-arrow-left text-sm"></i>
                    <span class="text-xs font-bold">Back</span>
                </button>
                <div class="flex items-center gap-2">
                    <span id="kv-cc-status-dot" class="inline-block w-2.5 h-2.5 rounded-full ${isInstalled ? 'bg-emerald-400' : 'bg-pink-400 animate-pulse'}"></span>
                    <span id="kv-cc-status-title" class="text-xs font-extrabold uppercase tracking-wider text-slate-300">
                        ${isInstalled ? 'Video Editor Engine Ready' : 'Video Editor Engine'}
                    </span>
                </div>
            </div>



            <!-- Scrollable Content -->
            <div class="overflow-y-auto no-scrollbar space-y-4 pr-0.5 relative z-10 flex-1">
                
                <!-- Hero Header -->
                <div class="text-center py-2">
                    <div class="kv-cc-glow-icon w-20 h-20 mx-auto rounded-3xl flex items-center justify-center shadow-xl mb-3" style="background: linear-gradient(135deg, #f472b6 0%, #a855f7 100%); border: 2px solid rgba(244,114,182,0.4);">
                        <i class="fas fa-video text-3xl text-white relative z-10"></i>
                    </div>
                    <h2 class="text-xl sm:text-2xl font-black text-white tracking-tight mb-1">
                        CupCat Video Editor
                    </h2>
                    <p class="text-xs sm:text-sm text-slate-300 leading-relaxed max-w-xs mx-auto">
                        Professional video editing, keyframes, transitions, and fast export — 100% free with no watermark.
                    </p>
                </div>

                <!-- Main Integration Card -->
                <div class="rounded-2xl p-4 bg-slate-800/70 border border-slate-700/60 shadow-inner">
                    <div class="flex items-start gap-3">
                        <div class="w-10 h-10 rounded-xl bg-pink-500/10 border border-pink-500/30 flex items-center justify-center text-pink-400 shrink-0 mt-0.5">
                            <i class="fas fa-film text-lg"></i>
                        </div>
                        <div class="flex-1 min-w-0">
                            <h3 class="text-sm font-bold text-white mb-0.5">Built for Kivu Super App</h3>
                            <p class="text-[12px] text-slate-300 leading-snug">
                                Installs on your phone with native hardware acceleration. Whenever you tap <strong>CupCat</strong>, the full editor opens immediately.
                            </p>
                        </div>
                    </div>

                    <!-- Progress Bar (hidden by default) -->
                    <div id="kv-cc-progress-wrap" class="hidden mt-3 pt-3 border-t border-slate-700/60">
                        <div class="flex justify-between text-[11px] font-semibold text-slate-300 mb-1">
                            <span id="kv-cc-progress-label">Downloading APK (70 MB)...</span>
                            <span id="kv-cc-progress-pct" class="text-pink-400">0%</span>
                        </div>
                        <div class="w-full h-2 rounded-full bg-slate-900 overflow-hidden">
                            <div id="kv-cc-progress-bar" class="h-full bg-gradient-to-r from-pink-400 to-purple-600 rounded-full transition-all duration-300" style="width: 0%;"></div>
                        </div>
                    </div>
                </div>

                <!-- Instructions / Steps -->
                <div class="rounded-2xl p-4 bg-slate-900/60 border border-slate-800 space-y-3">
                    <div class="text-[11px] font-extrabold uppercase text-slate-400 tracking-wider">How It Works</div>
                    
                    <div class="flex items-center gap-3">
                        <div class="kv-cc-step-badge">1</div>
                        <div class="text-xs text-slate-300 leading-tight">
                            Download the CupCat APK (70 MB) to your phone.
                        </div>
                    </div>
                    
                    <div class="flex items-center gap-3">
                        <div class="kv-cc-step-badge">2</div>
                        <div class="text-xs text-slate-300 leading-tight">
                            Tap the downloaded file and install the application.
                        </div>
                    </div>
                    
                    <div class="flex items-center gap-3">
                        <div class="kv-cc-step-badge">3</div>
                        <div class="text-xs text-slate-300 leading-tight">
                            Tap <strong>Open CupCat</strong> below or in Kivu tools anytime.
                        </div>
                    </div>
                </div>

            </div>

            <!-- Action Buttons -->
            <div class="pt-4 border-t border-slate-800 mt-2 space-y-2 relative z-10 shrink-0">
                <!-- Launch Web Editor Button (Works on iOS, Mac, PC, and directly in browser) -->
                <button id="kv-cc-web-btn" class="w-full py-3.5 px-4 rounded-2xl text-white font-bold text-sm flex items-center justify-center gap-2.5 cursor-pointer text-center shadow-lg transition-all active:scale-[0.98]" style="background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);">
                    <i class="fas fa-globe text-base"></i>
                    <span>Open Web Editor (Browser / iOS)</span>
                </button>

                <!-- Launch App Button (uses Android Intent URI with scheme matching) -->
                <a id="kv-cc-launch-btn" href="${launchIntentUrl}" class="kv-cc-btn-launch w-full py-3 px-4 rounded-2xl text-white font-bold text-xs flex items-center justify-center gap-2 cursor-pointer no-underline text-center shadow-lg ${isInstalled ? '' : 'hidden'}">
                    <i class="fas fa-play text-sm"></i>
                    <span>Open Native Android App</span>
                </a>

                <!-- Download Button -->
                <button id="kv-cc-download-btn" class="${isInstalled ? 'kv-cc-btn-secondary' : 'kv-cc-btn-secondary'} w-full py-3 px-4 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 cursor-pointer no-underline text-center text-slate-300">
                    <i class="fas fa-download text-sm"></i>
                    <span id="kv-cc-dl-text">${isInstalled ? 'Re-Download CupCat APK (60 MB)' : 'Download Android APK (60 MB)'}</span>
                </button>

                <!-- Quick Toggle Status Button -->
                <button id="kv-cc-status-toggle" class="kv-cc-btn-secondary w-full py-2 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 text-slate-400">
                    <i class="fas fa-check-circle ${isInstalled ? 'text-emerald-400' : 'text-slate-500'}"></i>
                    <span id="kv-cc-status-btn-text">${isInstalled ? 'Installed on this phone' : 'Mark as Installed'}</span>
                </button>
            </div>

        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = document.getElementById('cupcat-apk-modal');
    const closeBtn = document.getElementById('kv-cc-close-btn');
    const webBtn = document.getElementById('kv-cc-web-btn');
    const launchBtn = document.getElementById('kv-cc-launch-btn');
    const downloadBtn = document.getElementById('kv-cc-download-btn');
    const dlText = document.getElementById('kv-cc-dl-text');
    const statusToggle = document.getElementById('kv-cc-status-toggle');
    const statusBtnText = document.getElementById('kv-cc-status-btn-text');
    const statusDot = document.getElementById('kv-cc-status-dot');
    const statusTitle = document.getElementById('kv-cc-status-title');
    const progressWrap = document.getElementById('kv-cc-progress-wrap');
    const progressBar = document.getElementById('kv-cc-progress-bar');
    const progressPct = document.getElementById('kv-cc-progress-pct');
    const progressLabel = document.getElementById('kv-cc-progress-label');

    // Close logic — return to tools hub
    const closeModal = () => {
        modal.classList.add('opacity-0');
        setTimeout(() => {
            modal.remove();
            // Ensure tools module is visible (navigate back to tools)
            const toolsModule = document.getElementById('module-tools');
            if (toolsModule) toolsModule.classList.remove('hidden');
        }, 200);
    };

    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Web Editor Button Click -> dynamically import and initialize the Web Editor
    if (webBtn) {
        webBtn.addEventListener('click', () => {
            modal.classList.add('opacity-0');
            setTimeout(async () => {
                modal.remove();
                if (window.showToast) {
                    window.showToast("Opening Web Video Editor...", false);
                }
                try {
                    const { init: initEditor } = await import('./editor.js');
                    await initEditor(docId);
                } catch (err) {
                    console.error("Failed to load Web Video Editor:", err);
                    if (window.showToast) {
                        window.showToast("Failed to open Web Editor. Please try again.", true);
                    }
                }
            }, 200);
        });
    }

    // Launch button click handler — track if app actually opened
    launchBtn.addEventListener('click', (e) => {
        if (window.showToast) {
            window.showToast("Opening CupCat Video Editor...", false);
        }
        
        // Ensure robust deep-linking across browser modes and standalone PWA
        try {
            const isAndroid = /android/i.test(navigator.userAgent);
            if (isAndroid) {
                setTimeout(() => {
                    const iframe = document.createElement('iframe');
                    iframe.style.display = 'none';
                    iframe.src = 'cupcat://open';
                    document.body.appendChild(iframe);
                    setTimeout(() => iframe.remove(), 1000);
                }, 100);
            }
        } catch (_) {}

        let appOpened = false;
        const markOpened = () => { appOpened = true; };
        window.addEventListener('blur', markOpened, { once: true });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) appOpened = true;
        }, { once: true });

        setTimeout(() => {
            if (!appOpened && !document.hidden) {
                if (window.showToast) {
                    window.showToast("If CupCat didn't open, please install the APK first.", true);
                }
            }
        }, 2500);
    });

    // Handle Download APK with REAL progress via fetch + ReadableStream
    let isDownloading = false;
    downloadBtn.addEventListener('click', async () => {
        if (isDownloading) return;
        isDownloading = true;

        progressWrap.classList.remove('hidden');
        progressLabel.innerText = 'Connecting...';
        progressBar.style.width = '0%';
        progressPct.innerText = '0%';
        downloadBtn.disabled = true;
        downloadBtn.style.opacity = '0.5';
        downloadBtn.style.pointerEvents = 'none';
        dlText.innerText = 'Downloading...';

        try {
            const response = await fetch(CUPCAT_APK_DOWNLOAD_URL);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const contentLength = response.headers.get('Content-Length');
            const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
            const totalMB = totalBytes ? (totalBytes / (1024 * 1024)).toFixed(0) : '~60';

            const reader = response.body.getReader();
            const chunks = [];
            let receivedBytes = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                chunks.push(value);
                receivedBytes += value.length;

                const receivedMB = (receivedBytes / (1024 * 1024)).toFixed(1);
                if (totalBytes) {
                    const pct = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
                    progressBar.style.width = pct + '%';
                    progressPct.innerText = pct + '%';
                    progressLabel.innerText = `Downloading APK — ${receivedMB} / ${totalMB} MB`;
                } else {
                    // No content-length header — show downloaded MB only
                    progressLabel.innerText = `Downloading APK — ${receivedMB} MB...`;
                    progressBar.style.width = '60%'; // indeterminate
                }
            }

            // Combine chunks into blob
            const blob = new Blob(chunks, { type: 'application/vnd.android.package-archive' });
            const blobUrl = URL.createObjectURL(blob);

            // Trigger the actual download of the blob
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = 'cupcat.apk';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();

            // Clean up after a short delay
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(blobUrl);
            }, 5000);

            // NOW mark as downloaded/installed
            progressBar.style.width = '100%';
            progressPct.innerText = '100%';
            progressLabel.innerText = '✅ APK Downloaded! Tap the notification to install, then tap Open CupCat.';

            localStorage.setItem(STORAGE_KEY_CUPCAT_STATUS, 'true');

            // Switch UI to installed state
            launchBtn.classList.remove('hidden');
            downloadBtn.className = 'kv-cc-btn-secondary w-full py-3 px-4 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 cursor-pointer no-underline text-center text-slate-300';
            dlText.innerText = 'Re-Download CupCat APK';
            statusDot.className = 'inline-block w-2.5 h-2.5 rounded-full bg-emerald-400';
            statusTitle.innerText = 'Video Editor Engine Ready';
            statusBtnText.innerText = 'Installed on this phone';
            statusToggle.querySelector('i').className = 'fas fa-check-circle text-emerald-400';

            if (window.showToast) {
                window.showToast("APK downloaded! Tap the file notification to install.", false);
            }
        } catch (err) {
            console.error('[CupCat] APK download failed:', err);
            progressLabel.innerText = '❌ Download failed. Check internet and try again.';
            progressBar.style.width = '0%';
            progressPct.innerText = '';
            dlText.innerText = 'Retry Download APK';
            if (window.showToast) {
                window.showToast("Download failed: " + (err.message || "Network error"), true);
            }
        } finally {
            isDownloading = false;
            downloadBtn.disabled = false;
            downloadBtn.style.opacity = '';
            downloadBtn.style.pointerEvents = '';
        }
    });

    // Toggle Installed status
    statusToggle.addEventListener('click', () => {
        const current = localStorage.getItem(STORAGE_KEY_CUPCAT_STATUS) === 'true';
        const next = !current;
        localStorage.setItem(STORAGE_KEY_CUPCAT_STATUS, next ? 'true' : 'false');
        
        statusBtnText.innerText = next ? 'Installed on this phone' : 'Mark as Installed';
        statusToggle.querySelector('i').className = `fas fa-check-circle ${next ? 'text-emerald-400' : 'text-slate-400'}`;
        statusDot.className = `inline-block w-2.5 h-2.5 rounded-full ${next ? 'bg-emerald-400' : 'bg-pink-400 animate-pulse'}`;
        statusTitle.innerText = next ? 'Video Editor Engine Ready' : 'Video Editor Engine';

        if (next) {
            launchBtn.classList.remove('hidden');
            downloadBtn.className = 'kv-cc-btn-secondary w-full py-3 px-4 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 cursor-pointer no-underline text-center text-slate-300';
            dlText.innerText = 'Re-Download CupCat APK';
        } else {
            launchBtn.classList.add('hidden');
            downloadBtn.className = 'kv-cc-btn-primary w-full py-3.5 px-4 rounded-2xl text-white font-bold text-sm flex items-center justify-center gap-2.5 cursor-pointer no-underline text-center';
            dlText.innerText = 'Download Video Editor APK (70 MB)';
        }

        if (window.showToast) {
            window.showToast(next ? "Status: CupCat marked as Installed" : "Status reset", false);
        }
    });
}
