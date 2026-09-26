// src/modules/tools/offline.js
// Kivu Super App — Offline Direct Communication & File Sharing

const OFFLINE_APK_DOWNLOAD_URL = '/downloads/kivu-offline.apk';
const STORAGE_KEY_OFFLINE_STATUS = 'kivu_offline_service_installed';

/**
 * Attempt to launch the native Kivu Offline APK
 * Uses a hidden anchor tag with Android Intent URI — NEVER uses window.location.href
 * (window.location.href breaks PWA navigation and sends user to launcher)
 * @param {Function} onFailed - Callback if app is not installed / not opened
 */
export function launchKivuOfflineApp(onFailed) {
    const isAndroid = /android/i.test(navigator.userAgent);
    
    if (!isAndroid) {
        if (onFailed) onFailed();
        return;
    }

    if (window.showToast) {
        window.showToast("Opening Kivu Offline...", false);
    }

    let appOpened = false;
    const markOpened = () => { appOpened = true; };
    
    // Track if app opened by detecting page blur/visibility change
    window.addEventListener('blur', markOpened, { once: true });
    const visHandler = () => { if (document.hidden) appOpened = true; };
    document.addEventListener('visibilitychange', visHandler, { once: true });

    // 1. Custom URI scheme via hidden iframe (Fastest on Android WebViews/PWAs)
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = 'kivuoffline://open';
    document.body.appendChild(iframe);
    setTimeout(() => iframe.remove(), 500);

    // 2. Android Intent format via anchor tag
    const intentUrl = 'intent://open#Intent;scheme=kivuoffline;package=com.kivu.offline;end';
    const a = document.createElement('a');
    a.href = intentUrl;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 100);

    // If app didn't open within 2 seconds, show fallback modal
    setTimeout(() => {
        window.removeEventListener('blur', markOpened);
        document.removeEventListener('visibilitychange', visHandler);
        if (!appOpened && !document.hidden) {
            if (onFailed) onFailed();
        }
    }, 2000);
}

/**
 * Initialize and open the Offline Tool
 * ALWAYS shows the modal — launch is handled by clicking the <a> button inside the modal.
 * Never uses window.location.href for intent:// URLs (that breaks PWA navigation).
 */
export async function init(docId = null, forceModal = false) {
    renderOfflineModal(false);
}

/**
 * Render and display the Offline Tool modal
 */
function renderOfflineModal(launchFailed = false) {
    // Remove existing modal if any
    const existing = document.getElementById('offline-modal');
    if (existing) existing.remove();

    let isInstalled = localStorage.getItem(STORAGE_KEY_OFFLINE_STATUS) === 'true';

    // Build intent URL for the launch button href
    const launchIntentUrl = 'intent://open#Intent;scheme=kivuoffline;package=com.kivu.offline;S.browser_fallback_url=' + encodeURIComponent('about:blank') + ';end';

    const modalHtml = `
    <div id="offline-modal" class="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4" style="background:rgba(15,23,42,0.82);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);animation:kvOffFadeIn .25s ease;">
        <style>
            @keyframes kvOffFadeIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes kvOffSlideUp { from { opacity: 0; transform: translateY(24px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
            @keyframes kvOffPulse {
                0% { transform: scale(0.95); opacity: 0.8; }
                50% { transform: scale(1.15); opacity: 0.25; }
                100% { transform: scale(1.3); opacity: 0; }
            }

            .kv-off-card {
                animation: kvOffSlideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
                background: linear-gradient(165deg, #1e293b 0%, #0f172a 100%);
                border: 1px solid rgba(148, 163, 184, 0.18);
            }

            .kv-off-glow-icon {
                position: relative;
            }
            .kv-off-glow-icon::before {
                content: '';
                position: absolute;
                inset: -6px;
                border-radius: 50%;
                background: radial-gradient(circle, rgba(56, 189, 248, 0.45) 0%, rgba(99, 102, 241, 0) 70%);
                animation: kvOffPulse 2.5s infinite ease-out;
                z-index: 0;
            }

            .kv-off-btn-primary {
                background: linear-gradient(135deg, #38bdf8 0%, #2563eb 100%);
                box-shadow: 0 4px 18px rgba(37, 99, 235, 0.4);
                transition: transform 0.15s ease, filter 0.15s ease, box-shadow 0.15s ease;
            }
            .kv-off-btn-primary:active {
                transform: scale(0.97);
            }

            .kv-off-btn-launch {
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                box-shadow: 0 4px 18px rgba(16, 185, 129, 0.4);
                transition: transform 0.15s ease, filter 0.15s ease, box-shadow 0.15s ease;
            }
            .kv-off-btn-launch:active {
                transform: scale(0.97);
            }

            .kv-off-btn-secondary {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.15);
                color: #e2e8f0;
                transition: all 0.15s ease;
            }
            .kv-off-btn-secondary:active {
                transform: scale(0.97);
                background: rgba(255, 255, 255, 0.14);
            }

            .kv-off-step-badge {
                width: 24px;
                height: 24px;
                border-radius: 50%;
                background: rgba(56, 189, 248, 0.2);
                color: #38bdf8;
                border: 1px solid rgba(56, 189, 248, 0.4);
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
                font-weight: 800;
                flex-shrink: 0;
            }
        </style>

        <div class="kv-off-card w-full max-w-md rounded-3xl p-5 sm:p-6 text-white relative shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
            
            <!-- Background Decorative Grid Glow -->
            <div style="position:absolute;top:-60px;right:-60px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,rgba(56,189,248,0.2) 0%,transparent 70%);pointer-events:none;"></div>
            <div style="position:absolute;bottom:-60px;left:-60px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,rgba(99,102,241,0.15) 0%,transparent 70%);pointer-events:none;"></div>

            <!-- Top Bar -->
            <div class="flex items-center justify-between mb-3 relative z-10">
                <button id="kv-off-close-btn" class="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-slate-300 hover:text-white transition-all">
                    <i class="fas fa-arrow-left text-sm"></i>
                    <span class="text-xs font-bold">Back</span>
                </button>
                <div class="flex items-center gap-2">
                    <span id="kv-off-status-dot" class="inline-block w-2.5 h-2.5 rounded-full ${isInstalled ? 'bg-emerald-400' : 'bg-sky-400 animate-pulse'}"></span>
                    <span id="kv-off-status-title" class="text-xs font-extrabold uppercase tracking-wider text-slate-300">
                        ${isInstalled ? 'Offline Service Installed' : 'Offline Communication'}
                    </span>
                </div>
            </div>

            <!-- Launch Failed Banner if applicable -->
            ${launchFailed ? `
            <div class="mb-3 p-3 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2.5 relative z-10">
                <i class="fas fa-info-circle text-sm mt-0.5 shrink-0 text-amber-400"></i>
                <div class="leading-relaxed">
                    Kivu Offline is not installed or was removed. Download the APK below and tap to install.
                </div>
            </div>` : ''}

            <!-- Scrollable Content -->
            <div class="overflow-y-auto no-scrollbar space-y-4 pr-0.5 relative z-10 flex-1">
                
                <!-- Hero Header -->
                <div class="text-center py-2">
                    <div class="kv-off-glow-icon w-20 h-20 mx-auto rounded-3xl flex items-center justify-center shadow-xl mb-3" style="background: linear-gradient(135deg, #334155 0%, #1e293b 100%); border: 2px solid rgba(148,163,184,0.3);">
                        <i class="fas fa-circle-nodes text-3xl text-sky-400 relative z-10"></i>
                    </div>
                    <h2 class="text-xl sm:text-2xl font-black text-white tracking-tight mb-1">
                        Kivu Offline
                    </h2>
                    <p class="text-xs sm:text-sm text-slate-300 leading-relaxed max-w-xs mx-auto">
                        Direct connection and file sharing between nearby phones without internet, mobile towers, or SIM data.
                    </p>
                </div>

                <!-- Main Integration Card -->
                <div class="rounded-2xl p-4 bg-slate-800/70 border border-slate-700/60 shadow-inner">
                    <div class="flex items-start gap-3">
                        <div class="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0 mt-0.5">
                            <i class="fas fa-satellite-dish text-lg"></i>
                        </div>
                        <div class="flex-1 min-w-0">
                            <h3 class="text-sm font-bold text-white mb-0.5">Built for Kivu Super App</h3>
                            <p class="text-[12px] text-slate-300 leading-snug">
                                Installs directly on your phone. Whenever you tap the <strong>Offline</strong> button, Kivu Offline opens automatically to connect nearby devices.
                            </p>
                        </div>
                    </div>

                    <!-- Progress Bar (hidden by default) -->
                    <div id="kv-off-progress-wrap" class="hidden mt-3 pt-3 border-t border-slate-700/60">
                        <div class="flex justify-between text-[11px] font-semibold text-slate-300 mb-1">
                            <span id="kv-off-progress-label">Downloading APK (6.5 MB)...</span>
                            <span id="kv-off-progress-pct" class="text-sky-400">0%</span>
                        </div>
                        <div class="w-full h-2 rounded-full bg-slate-900 overflow-hidden">
                            <div id="kv-off-progress-bar" class="h-full bg-gradient-to-r from-sky-400 to-blue-600 rounded-full transition-all duration-300" style="width: 0%;"></div>
                        </div>
                    </div>
                </div>

                <!-- Instructions / Steps -->
                <div class="rounded-2xl p-4 bg-slate-900/60 border border-slate-800 space-y-3">
                    <div class="text-[11px] font-extrabold uppercase text-slate-400 tracking-wider">How It Works</div>
                    
                    <div class="flex items-center gap-3">
                        <div class="kv-off-step-badge">1</div>
                        <div class="text-xs text-slate-300 leading-tight">
                            Download the APK file (6.5 MB) to your device.
                        </div>
                    </div>
                    
                    <div class="flex items-center gap-3">
                        <div class="kv-off-step-badge">2</div>
                        <div class="text-xs text-slate-300 leading-tight">
                            Tap the downloaded file and install the app.
                        </div>
                    </div>
                    
                    <div class="flex items-center gap-3">
                        <div class="kv-off-step-badge">3</div>
                        <div class="text-xs text-slate-300 leading-tight">
                            Tap <strong>Open Kivu Offline</strong> below or in Kivu tools anytime.
                        </div>
                    </div>
                </div>

            </div>

            <!-- Action Buttons -->
            <div class="pt-4 border-t border-slate-800 mt-2 space-y-2 relative z-10 shrink-0">
                <!-- Launch App Button (uses Android Intent URI with scheme matching) -->
                <a id="kv-off-launch-btn" href="${launchIntentUrl}" class="kv-off-btn-launch w-full py-3.5 px-4 rounded-2xl text-white font-bold text-sm flex items-center justify-center gap-2.5 cursor-pointer no-underline text-center shadow-lg ${isInstalled ? '' : 'hidden'}">
                    <i class="fas fa-rocket text-base"></i>
                    <span>Open Kivu Offline App</span>
                </a>

                <!-- Download Button -->
                <a id="kv-off-download-btn" href="${OFFLINE_APK_DOWNLOAD_URL}" download="kivu-offline.apk" class="${isInstalled ? 'kv-off-btn-secondary' : 'kv-off-btn-primary'} w-full py-3.5 px-4 rounded-2xl font-bold text-sm flex items-center justify-center gap-2.5 cursor-pointer no-underline text-center">
                    <i class="fas fa-download text-base"></i>
                    <span id="kv-off-dl-text">${isInstalled ? 'Re-Download Offline APK (6.5 MB)' : 'Download Offline App (6.5 MB)'}</span>
                </a>

                <!-- Quick Toggle Status Button -->
                <button id="kv-off-status-toggle" class="kv-off-btn-secondary w-full py-2.5 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 text-slate-300">
                    <i class="fas fa-check-circle ${isInstalled ? 'text-emerald-400' : 'text-slate-400'}"></i>
                    <span id="kv-off-status-btn-text">${isInstalled ? 'Installed on this phone' : 'Mark as Installed'}</span>
                </button>
            </div>

        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = document.getElementById('offline-modal');
    const closeBtn = document.getElementById('kv-off-close-btn');
    const launchBtn = document.getElementById('kv-off-launch-btn');
    const downloadBtn = document.getElementById('kv-off-download-btn');
    const dlText = document.getElementById('kv-off-dl-text');
    const statusToggle = document.getElementById('kv-off-status-toggle');
    const statusBtnText = document.getElementById('kv-off-status-btn-text');
    const statusDot = document.getElementById('kv-off-status-dot');
    const statusTitle = document.getElementById('kv-off-status-title');
    const progressWrap = document.getElementById('kv-off-progress-wrap');
    const progressBar = document.getElementById('kv-off-progress-bar');
    const progressPct = document.getElementById('kv-off-progress-pct');
    const progressLabel = document.getElementById('kv-off-progress-label');

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

    // Launch button click handler — track if app actually opened
    launchBtn.addEventListener('click', (e) => {
        if (window.showToast) {
            window.showToast("Opening Kivu Offline...", false);
        }
        
        let appOpened = false;
        const markOpened = () => { appOpened = true; };
        window.addEventListener('blur', markOpened, { once: true });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) appOpened = true;
        }, { once: true });

        setTimeout(() => {
            if (!appOpened && !document.hidden) {
                if (window.showToast) {
                    window.showToast("If Kivu Offline didn't open, please install the APK first.", true);
                }
            }
        }, 2500);
    });

    // Handle Download APK with progress indicator
    downloadBtn.addEventListener('click', () => {
        localStorage.setItem(STORAGE_KEY_OFFLINE_STATUS, 'true');
        progressWrap.classList.remove('hidden');
        progressLabel.innerText = 'Downloading APK (6.5 MB)...';

        let pct = 0;
        const interval = setInterval(() => {
            pct += 20;
            if (pct > 100) pct = 100;
            progressBar.style.width = pct + '%';
            progressPct.innerText = pct + '%';

            if (pct >= 100) {
                clearInterval(interval);
                progressLabel.innerText = '✅ APK Downloaded! Tap downloaded file to install, then tap Open Kivu Offline.';
                
                // Switch UI to installed state
                launchBtn.classList.remove('hidden');
                downloadBtn.className = 'kv-off-btn-secondary w-full py-3 px-4 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 cursor-pointer no-underline text-center text-slate-300';
                dlText.innerText = 'Re-Download Offline APK';
                statusDot.className = 'inline-block w-2.5 h-2.5 rounded-full bg-emerald-400';
                statusTitle.innerText = 'Offline Service Installed';
                statusBtnText.innerText = 'Installed on this phone';
                statusToggle.querySelector('i').className = 'fas fa-check-circle text-emerald-400';

                if (window.showToast) {
                    window.showToast("APK downloaded! Install the file, then open Kivu Offline.", false);
                }
            }
        }, 150);
    });

    // Toggle Installed status
    statusToggle.addEventListener('click', () => {
        const current = localStorage.getItem(STORAGE_KEY_OFFLINE_STATUS) === 'true';
        const next = !current;
        localStorage.setItem(STORAGE_KEY_OFFLINE_STATUS, next ? 'true' : 'false');
        
        statusBtnText.innerText = next ? 'Installed on this phone' : 'Mark as Installed';
        statusToggle.querySelector('i').className = `fas fa-check-circle ${next ? 'text-emerald-400' : 'text-slate-400'}`;
        statusDot.className = `inline-block w-2.5 h-2.5 rounded-full ${next ? 'bg-emerald-400' : 'bg-sky-400 animate-pulse'}`;
        statusTitle.innerText = next ? 'Offline Service Installed' : 'Offline Communication';

        if (next) {
            launchBtn.classList.remove('hidden');
            downloadBtn.className = 'kv-off-btn-secondary w-full py-3 px-4 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 cursor-pointer no-underline text-center text-slate-300';
            dlText.innerText = 'Re-Download Offline APK';
        } else {
            launchBtn.classList.add('hidden');
            downloadBtn.className = 'kv-off-btn-primary w-full py-3.5 px-4 rounded-2xl text-white font-bold text-sm flex items-center justify-center gap-2.5 cursor-pointer no-underline text-center';
            dlText.innerText = 'Download Offline App (6.5 MB)';
        }

        if (window.showToast) {
            window.showToast(next ? "Status: Marked as Installed" : "Status reset", false);
        }
    });
}
