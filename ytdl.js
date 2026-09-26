// src/modules/tools/ytdl.js
// Video Downloader — YouTube, TikTok, Instagram

export async function init(docId = null) {
    if (document.getElementById('ytdl-modal')) {
        return;
    }

    const modalHtml = `
    <div id="ytdl-modal" class="fixed inset-0 z-[100] flex items-center justify-center pt-safe pb-safe px-4" style="background:rgba(17,24,39,0.7); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); animation: ytdlFadeIn 0.3s ease;">
        <style>
            @keyframes ytdlFadeIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes ytdlSlideUp { from { opacity: 0; transform: translateY(20px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
            .ytdl-modal-card { animation: ytdlSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) both; }
            .ytdl-chip { display:inline-flex; align-items:center; gap:5px; padding:5px 12px; border-radius:20px; font-size:12px; font-weight:700; border:1px solid; }
            .ytdl-chip.yt { background:#fef2f2; border-color:#fecaca; color:#dc2626; }
            .ytdl-chip.tt { background:#fdf2f8; border-color:#fbcfe8; color:#db2777; }
            .ytdl-chip.ig { background:linear-gradient(135deg,#fdf2f8,#f5f3ff); border-color:#e9d5ff; color:#9333ea; }
            .ytdl-input-wrap { position:relative; }
            .ytdl-input-wrap .link-icon { position:absolute; top:50%; left:14px; transform:translateY(-50%); color:#a78bfa; pointer-events:none; font-size:14px; }
            .ytdl-input {
                width:100%; padding:14px 16px 14px 40px; background:#f9fafb; border:1.5px solid #e5e7eb;
                border-radius:14px; font-size:14px; font-weight:500; color:#1f2937; outline:none;
                transition: border-color 0.2s, box-shadow 0.2s;
            }
            .ytdl-input::placeholder { color:#9ca3af; }
            .ytdl-input:focus { border-color:#8b5cf6; box-shadow:0 0 0 3px rgba(139,92,246,0.15); }
            .ytdl-format-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
            .ytdl-format-option { position:relative; cursor:pointer; }
            .ytdl-format-option input { position:absolute; opacity:0; pointer-events:none; }
            .ytdl-format-card {
                padding:16px 12px; background:#f9fafb; border:1.5px solid #e5e7eb; border-radius:14px;
                display:flex; flex-direction:column; align-items:center; gap:8px; color:#6b7280;
                transition: all 0.2s ease; text-align:center;
            }
            .ytdl-format-card:active { transform:scale(0.95); }
            .ytdl-format-option input:checked + .ytdl-format-card {
                border-color:#8b5cf6; background:#f5f3ff; color:#7c3aed;
            }
            .ytdl-format-card .icon { font-size:22px; }
            .ytdl-format-card .label { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; }
            #ytdl-status { display:none; border-radius:14px; padding:12px; font-size:13px; font-weight:500; }
            #ytdl-status.show { display:block; }
            #ytdl-status.error { background:#fef2f2; color:#dc2626; }
            #ytdl-status.loading { background:#eff6ff; color:#2563eb; }
            #ytdl-status.success { background:#f0fdf4; color:#15803d; }
            .ytdl-dl-btn {
                width:100%; padding:14px; border:none; border-radius:14px; font-size:15px; font-weight:700;
                color:white; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px;
                background: linear-gradient(135deg, #8b5cf6, #6366f1);
                box-shadow: 0 4px 14px rgba(99,102,241,0.4);
                transition: all 0.2s ease;
            }
            .ytdl-dl-btn:hover { filter: brightness(1.05); }
            .ytdl-dl-btn:active { transform:scale(0.96); }
            .ytdl-dl-btn:disabled { opacity:0.7; cursor:not-allowed; }
            .ytdl-dl-btn.success-btn {
                background: linear-gradient(135deg, #22c55e, #16a34a);
                box-shadow: 0 4px 14px rgba(22,163,74,0.4);
            }
            #ytdl-detected { display:none; margin-left:4px; font-size:12px; font-weight:600; }
        </style>
        <div class="ytdl-modal-card w-full" style="max-width:420px; background:white; border-radius:24px; box-shadow:0 25px 50px rgba(0,0,0,0.25); overflow:hidden; display:flex; flex-direction:column;">
            
            <!-- Header -->
            <div style="height:56px; background:linear-gradient(135deg,#8b5cf6,#6366f1); display:flex; align-items:center; justify-content:space-between; padding:0 20px; color:white; position:relative; overflow:hidden; flex-shrink:0;">
                <div style="position:absolute; top:-50%; right:-10%; width:120px; height:120px; border-radius:50%; background:rgba(255,255,255,0.1);"></div>
                <div style="display:flex; align-items:center; gap:12px; position:relative; z-index:1;">
                    <div style="width:32px; height:32px; border-radius:50%; background:rgba(255,255,255,0.2); display:flex; align-items:center; justify-content:center;">
                        <i class="fas fa-download" style="font-size:14px;"></i>
                    </div>
                    <span style="font-weight:700; font-size:17px; letter-spacing:-0.02em;">Video Downloader</span>
                </div>
                <button id="ytdl-close-btn" style="width:32px; height:32px; border-radius:50%; border:none; background:transparent; color:white; cursor:pointer; display:flex; align-items:center; justify-content:center; position:relative; z-index:1; transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='transparent'">
                    <i class="fas fa-times" style="font-size:14px;"></i>
                </button>
            </div>

            <!-- Body -->
            <div style="padding:24px; display:flex; flex-direction:column; gap:20px; overflow-y:auto; max-height:70vh;">
                
                <!-- Platform Chips -->
                <div style="display:flex; flex-direction:column; gap:8px;">
                    <label style="font-size:13px; font-weight:600; color:#374151; margin-left:2px;">Supported Platforms</label>
                    <div style="display:flex; gap:8px; flex-wrap:wrap;">
                        <span class="ytdl-chip yt"><i class="fab fa-youtube"></i> YouTube</span>
                        <span class="ytdl-chip tt"><i class="fab fa-tiktok"></i> TikTok</span>
                        <span class="ytdl-chip ig"><i class="fab fa-instagram"></i> Instagram</span>
                    </div>
                </div>

                <!-- URL Input -->
                <div style="display:flex; flex-direction:column; gap:6px;">
                    <label style="font-size:13px; font-weight:600; color:#374151; margin-left:2px;">Paste URL</label>
                    <div class="ytdl-input-wrap">
                        <i class="fas fa-link link-icon"></i>
                        <input type="text" id="ytdl-url" class="ytdl-input" placeholder="https://youtube.com/watch?v=... or TikTok/Instagram link">
                    </div>
                    <div id="ytdl-detected"></div>
                </div>

                <!-- Format -->
                <div style="display:flex; flex-direction:column; gap:8px;">
                    <label style="font-size:13px; font-weight:600; color:#374151; margin-left:2px;">Format</label>
                    <div class="ytdl-format-grid">
                        <label class="ytdl-format-option">
                            <input type="radio" name="ytdl-format" value="video" checked>
                            <div class="ytdl-format-card">
                                <i class="fas fa-video icon"></i>
                                <span class="label">Video (MP4)</span>
                            </div>
                        </label>
                        <label class="ytdl-format-option">
                            <input type="radio" name="ytdl-format" value="audio">
                            <div class="ytdl-format-card">
                                <i class="fas fa-music icon"></i>
                                <span class="label">Audio (MP3)</span>
                            </div>
                        </label>
                    </div>
                </div>

                <!-- Status Area -->
                <div id="ytdl-status"></div>

            </div>

            <!-- Footer -->
            <div style="padding:16px 24px 20px; border-top:1px solid #f3f4f6; background:#f9fafb; flex-shrink:0;">
                <button id="ytdl-download-btn" class="ytdl-dl-btn">
                    <i class="fas fa-download"></i>
                    <span>Generate Link</span>
                </button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = document.getElementById('ytdl-modal');
    const closeBtn = document.getElementById('ytdl-close-btn');
    const dlBtn = document.getElementById('ytdl-download-btn');
    const urlInput = document.getElementById('ytdl-url');
    const statusDiv = document.getElementById('ytdl-status');
    const detectedDiv = document.getElementById('ytdl-detected');

    function closeModal() {
        modal.style.opacity = '0';
        modal.style.transition = 'opacity 0.25s';
        setTimeout(() => modal.remove(), 250);
    }

    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Platform detection
    const platformConfig = {
        youtube:   { icon: 'fab fa-youtube',   color: '#dc2626', label: 'YouTube' },
        tiktok:    { icon: 'fab fa-tiktok',    color: '#db2777', label: 'TikTok' },
        instagram: { icon: 'fab fa-instagram', color: '#9333ea', label: 'Instagram' },
    };

    function detectPlatform(url) {
        const lower = url.toLowerCase();
        if (lower.includes('youtube.com/') || lower.includes('youtu.be/')) return 'youtube';
        if (lower.includes('tiktok.com/') || lower.includes('vm.tiktok.com/')) return 'tiktok';
        if (lower.includes('instagram.com/') || lower.includes('instagr.am/')) return 'instagram';
        return null;
    }

    urlInput.addEventListener('input', () => {
        const platform = detectPlatform(urlInput.value.trim());
        if (platform && platformConfig[platform]) {
            const cfg = platformConfig[platform];
            detectedDiv.style.display = 'block';
            detectedDiv.style.color = cfg.color;
            detectedDiv.innerHTML = `<i class="${cfg.icon}" style="margin-right:4px;"></i> ${cfg.label} detected`;
        } else {
            detectedDiv.style.display = 'none';
        }
    });

    function showStatus(msg, type = 'loading') {
        statusDiv.className = `show ${type}`;
        const icon = type === 'error' ? 'fa-exclamation-circle' : type === 'success' ? 'fa-check-circle' : 'fa-spinner fa-spin';
        statusDiv.innerHTML = `<i class="fas ${icon}" style="margin-right:8px;"></i>${msg}`;
    }

    function hideStatus() {
        statusDiv.className = '';
    }

    dlBtn.addEventListener('click', async () => {
        const url = urlInput.value.trim();
        if (!url) {
            showStatus('Please enter a valid URL', 'error');
            return;
        }

        const platform = detectPlatform(url);
        if (!platform) {
            showStatus('Unsupported URL. Use YouTube, TikTok, or Instagram links.', 'error');
            return;
        }

        const format = document.querySelector('input[name="ytdl-format"]:checked').value;
        const isAudioOnly = format === 'audio';

        dlBtn.disabled = true;
        dlBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processing...`;
        showStatus(`Fetching ${platformConfig[platform].label} download link...`);

        try {
            if (!window.sb) throw new Error("Database client not initialized");
            const { data: { session } } = await window.sb.auth.getSession();
            if (!session) {
                throw new Error("You must be logged in to use this tool.");
            }

            const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
            const res = await fetch(`${supabaseUrl}/functions/v1/ytdl-proxy`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ url, isAudioOnly })
            });

            const data = await res.json();

            if (!res.ok) {
                if (res.status === 429) {
                    throw new Error(data.error || "Daily limit exceeded.");
                }
                throw new Error(data.error || "Failed to process. Try another link.");
            }
            
            if (data.status === 'error' || !data.url) {
                throw new Error(data.text || "Failed to get download link");
            }

            // Success
            showStatus('Ready to download!', 'success');

            dlBtn.innerHTML = `<i class="fas fa-external-link-alt"></i> Open Download`;
            dlBtn.className = 'ytdl-dl-btn success-btn';
            
            const newDlBtn = dlBtn.cloneNode(true);
            dlBtn.parentNode.replaceChild(newDlBtn, dlBtn);
            newDlBtn.disabled = false;
            
            newDlBtn.addEventListener('click', () => {
                window.open(data.url, '_blank');
                saveToDocuments(url, format, platform);
            });

        } catch (err) {
            console.error(err);
            showStatus(err.message, 'error');
            
            dlBtn.disabled = false;
            dlBtn.innerHTML = `<i class="fas fa-download"></i> Try Again`;
        }
    });

    function saveToDocuments(url, format, platform) {
        const platformLabels = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };
        const docId = 'ytdl_' + Date.now();
        const meta = {
            id: docId,
            title: `${platformLabels[platform] || 'Video'} ${format === 'audio' ? 'Audio' : 'Video'}`,
            type: 'ytdl',
            url: url,
            updatedAt: Date.now()
        };
        
        const idx = localStorage.getItem('kivu_docs_index');
        let docs = idx ? JSON.parse(idx) : [];
        docs.push(meta);
        localStorage.setItem('kivu_docs_index', JSON.stringify(docs));
        localStorage.setItem('kivu_doc_' + docId, JSON.stringify({ url, format, platform }));

        if (window.renderMyDocuments) {
            window.renderMyDocuments();
        }
    }
}
