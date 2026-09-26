// src/modules/tools/qr.js
// Universal Offline-First QR Studio for Kivu Super App
// High-performance, fully customizable QR builder with modular element toggles & rich color palette

let qrCodeInstance = null;
let QRCodeStyling = null;
let debounceTimer = null;
let currentLogoData = null;
let activeContentType = 'link';
let selectedColor = '#111827';
let selectedDotStyle = 'rounded';
let selectedCornerStyle = 'extra-rounded';

// Extended curated color palettes grouped by shade
const PALETTE_GROUPS = [
    {
        title: 'Dark & Neutrals',
        colors: ['#000000', '#111827', '#1e293b', '#334155', '#475569', '#64748b', '#78716c']
    },
    {
        title: 'Deep & Royal Blues',
        colors: ['#1e3a8a', '#1d4ed8', '#2563eb', '#3b82f6', '#0284c7', '#0369a1', '#1e40af']
    },
    {
        title: 'Teals & Cyans',
        colors: ['#0f766e', '#0d9488', '#14b8a6', '#0891b2', '#06b6d4', '#0e7490', '#115e59']
    },
    {
        title: 'Emerald & Forest Greens',
        colors: ['#047857', '#059669', '#10b981', '#15803d', '#16a34a', '#22c55e', '#4d7c0f']
    },
    {
        title: 'Purples & Indigos',
        colors: ['#312e81', '#4338ca', '#4f46e5', '#6d28d9', '#7c3aed', '#8b5cf6', '#9333ea']
    },
    {
        title: 'Magentas & Roses',
        colors: ['#831843', '#9d174d', '#be185d', '#db2777', '#ec4899', '#e11d48', '#f43f5e']
    },
    {
        title: 'Crimsons & Reds',
        colors: ['#7f1d1d', '#991b1b', '#b91c1c', '#dc2626', '#ef4444', '#f87171', '#c2410c']
    },
    {
        title: 'Ambers, Corals & Golds',
        colors: ['#78350f', '#92400e', '#b45309', '#d97706', '#f59e0b', '#ea580c', '#f97316']
    }
];

// Preset icon SVGs converted to Data URLs for instant logo embedding
const PRESET_LOGOS = {
    link: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23111827"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>`,
    wifi: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23111827"><path d="M12 4C7.31 4 3.07 5.9 0 8.98L12 21 24 8.98A16.88 16.88 0 0 0 12 4zm0 2.9c3.8 0 7.24 1.45 9.87 3.86L12 18.66 2.13 10.76C4.76 8.35 8.2 6.9 12 6.9z"/></svg>`,
    user: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23111827"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
    card: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23111827"><path d="M20 4H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/></svg>`,
    cafe: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23111827"><path d="M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 5h-2V5h2v3zM2 19h20v2H2z"/></svg>`,
    shop: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23111827"><path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/></svg>`,
    star: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23111827"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`,
    phone: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23111827"><path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 0 0-1.01.24l-2.2 2.2a15.053 15.053 0 0 1-6.59-6.59l2.2-2.21a.96.96 0 0 0 .25-1A11.36 11.36 0 0 1 8.5 4c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1 0 9.39 7.61 17 17 17 .55 0 1-.45 1-1v-3.5c0-.55-.45-1-1-1z"/></svg>`,
    email: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23111827"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>`,
    map: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23111827"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>`
};

function getSvgDataUrl(svgString, color = '#111827') {
    const coloredSvg = svgString.replace(/%23[0-9a-fA-F]{6}|%23111827|fill="[^"]*"/g, `fill="${color}"`);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(coloredSvg)}`;
}

// Clean up memory and instance on close
function closeQRGenerator() {
    if (debounceTimer) clearTimeout(debounceTimer);
    qrCodeInstance = null;
    currentLogoData = null;
    const el = document.getElementById('module-qr-generator');
    if (el) el.remove();
}

// Client-side image downscaler to prevent OOM on budget mobile devices
function resizeImageToThumbnail(file, maxSize = 140) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > maxSize) {
                        height = Math.round((height * maxSize) / width);
                        width = maxSize;
                    }
                } else {
                    if (height > maxSize) {
                        width = Math.round((width * maxSize) / height);
                        height = maxSize;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/png', 0.9));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export async function init(docId) {
    // Fast loading overlay
    const loadingHtml = `
    <div id="qr-loading-overlay" style="position:fixed;inset:0;background:rgba(255,255,255,0.95);z-index:100000;display:flex;flex-direction:column;align-items:center;justify-content:center;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);">
        <i class="fas fa-spinner fa-spin text-3xl mb-3" style="font-size:28px;color:#0d9488;"></i>
        <span style="font-size:12px;font-weight:700;color:#334155;letter-spacing:0.05em;text-transform:uppercase;">Loading QR Engine...</span>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', loadingHtml);

    try {
        let mod = null;
        try {
            mod = await import('qr-code-styling');
        } catch (importErr) {
            console.warn('Dynamic import of qr-code-styling failed:', importErr);
        }
        QRCodeStyling = mod?.default?.default || mod?.default || mod || (typeof window !== 'undefined' ? window.QRCodeStyling : null);
        if (typeof QRCodeStyling !== 'function' && typeof window !== 'undefined' && typeof window.QRCodeStyling === 'function') {
            QRCodeStyling = window.QRCodeStyling;
        }
        if (typeof QRCodeStyling !== 'function' && typeof document !== 'undefined') {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/qr-code-styling@1.9.2/lib/qr-code-styling.js';
                script.onload = () => {
                    QRCodeStyling = window.QRCodeStyling;
                    resolve();
                };
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }
    } catch (err) {
        console.error('QR Engine failed to load:', err);
        if (window.showToast) window.showToast('Failed to load QR Engine.', true);
        document.getElementById('qr-loading-overlay')?.remove();
        return;
    }

    document.getElementById('qr-loading-overlay')?.remove();

    // Reset state
    qrCodeInstance = null;
    currentLogoData = null;
    activeContentType = 'link';
    selectedColor = '#111827';
    selectedDotStyle = 'rounded';
    selectedCornerStyle = 'extra-rounded';

    // Remove existing if any
    const existing = document.getElementById('module-qr-generator');
    if (existing) existing.remove();

    // Build Palette Modal HTML with Categorized Swatches
    let paletteGroupsHtml = '';
    PALETTE_GROUPS.forEach(group => {
        paletteGroupsHtml += `
        <div style="margin-bottom:12px;">
            <div style="font-size:11px;font-weight:700;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em;">${group.title}</div>
            <div style="display:grid;grid-template-columns:repeat(7, 1fr);gap:6px;">
                ${group.colors.map(hex => `
                    <button type="button" class="qr-modal-color-swatch" data-hex="${hex}" style="height:38px;border-radius:10px;background:${hex};border:2px solid transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.1);transition:transform 0.15s, border-color 0.15s;" title="${hex}">
                    </button>
                `).join('')}
            </div>
        </div>`;
    });

    const uiHtml = `
    <div id="module-qr-generator" class="qr-studio-root select-none" style="position:fixed;inset:0;background-color:#f8fafc !important;z-index:99999;display:flex;flex-direction:column;overflow:hidden;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        
        <!-- SCOPED STYLES -->
        <style>
            .qr-studio-root {
                --primary: #0d9488;
                --primary-dark: #0f766e;
                --border-color: #e2e8f0;
                --bg-card: #ffffff;
                --bg-input: #f8fafc;
            }
            .qr-header-bar {
                height: 56px;
                background: #ffffff;
                border-bottom: 1px solid #e2e8f0;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 16px;
                flex-shrink: 0;
                box-shadow: 0 1px 3px rgba(0,0,0,0.03);
            }
            .qr-card-box {
                background: #ffffff;
                border-radius: 20px;
                border: 1px solid #e2e8f0;
                box-shadow: 0 2px 8px rgba(0,0,0,0.04);
                padding: 16px;
                transition: all 0.2s ease;
            }
            .qr-section-title {
                font-size: 11px;
                font-weight: 800;
                color: #64748b;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 10px;
            }
            .qr-type-pill {
                padding: 7px 14px;
                border-radius: 12px;
                font-size: 12px;
                font-weight: 600;
                display: inline-flex;
                align-items: center;
                gap: 6px;
                border: 1px solid #e2e8f0;
                background: #f8fafc;
                color: #475569;
                cursor: pointer;
                transition: all 0.15s ease;
                white-space: nowrap;
                flex-shrink: 0;
            }
            .qr-type-pill.active {
                background: #0d9488;
                color: #ffffff;
                border-color: #0d9488;
                box-shadow: 0 2px 6px rgba(13,148,136,0.3);
            }
            .qr-type-pill:active {
                transform: scale(0.96);
            }
            .qr-input-field {
                width: 100%;
                background: #f8fafc;
                border: 1px solid #cbd5e1;
                border-radius: 12px;
                padding: 10px 14px;
                font-size: 13px;
                color: #0f172a;
                outline: none;
                transition: border-color 0.15s, box-shadow 0.15s;
                box-sizing: border-box;
            }
            .qr-input-field:focus {
                border-color: #0d9488;
                background: #ffffff;
                box-shadow: 0 0 0 3px rgba(13,148,136,0.15);
            }
            .qr-toggle-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 0;
                cursor: pointer;
            }
            .qr-toggle-label {
                font-size: 13px;
                font-weight: 600;
                color: #1e293b;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .qr-switch {
                position: relative;
                display: inline-block;
                width: 42px;
                height: 24px;
                flex-shrink: 0;
            }
            .qr-switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            .qr-slider {
                position: absolute;
                cursor: pointer;
                top: 0; left: 0; right: 0; bottom: 0;
                background-color: #cbd5e1;
                transition: .2s;
                border-radius: 24px;
            }
            .qr-slider:before {
                position: absolute;
                content: "";
                height: 18px;
                width: 18px;
                left: 3px;
                bottom: 3px;
                background-color: white;
                transition: .2s;
                border-radius: 50%;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2);
            }
            .qr-switch input:checked + .qr-slider {
                background-color: #0d9488;
            }
            .qr-switch input:checked + .qr-slider:before {
                transform: translateX(18px);
            }
            .qr-color-dot {
                width: 34px;
                height: 34px;
                border-radius: 10px;
                border: 2px solid transparent;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: transform 0.15s, border-color 0.15s;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }
            .qr-color-dot.active {
                border-color: #0d9488;
                transform: scale(1.08);
            }
            .qr-style-btn {
                padding: 8px 12px;
                border-radius: 10px;
                border: 1px solid #e2e8f0;
                background: #f8fafc;
                font-size: 12px;
                font-weight: 600;
                color: #475569;
                text-align: center;
                cursor: pointer;
                transition: all 0.15s;
            }
            .qr-style-btn.active {
                background: #0f172a;
                color: #ffffff;
                border-color: #0f172a;
            }
            .qr-icon-chip {
                width: 36px;
                height: 36px;
                border-radius: 10px;
                border: 1px solid #e2e8f0;
                background: #f8fafc;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: all 0.15s;
                flex-shrink: 0;
                font-size: 15px;
                color: #334155;
            }
            .qr-icon-chip.active {
                background: #0d9488;
                color: #ffffff;
                border-color: #0d9488;
                box-shadow: 0 2px 6px rgba(13,148,136,0.3);
            }
            /* Preview composite container */
            #qr-composite-preview {
                transition: all 0.25s ease;
            }
            #qr-composite-preview.frame-standee {
                background: #ffffff;
                border: 1px solid #e2e8f0;
                border-radius: 20px;
                box-shadow: 0 10px 25px -5px rgba(0,0,0,0.06), 0 8px 10px -6px rgba(0,0,0,0.03);
                padding: 20px 16px;
            }
            #qr-composite-preview.frame-minimal {
                background: #ffffff;
                border: 1px solid #cbd5e1;
                border-radius: 14px;
                box-shadow: none;
                padding: 12px;
            }
            #qr-composite-preview.frame-none {
                background: transparent;
                border: none;
                box-shadow: none;
                padding: 0;
            }
            .qr-scrollbar-none::-webkit-scrollbar { display: none; }
            .qr-scrollbar-none { -ms-overflow-style: none; scrollbar-width: none; }
            
            /* Modal Animation */
            @keyframes qrSlideUp {
                from { transform: translateY(100%); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
            .qr-modal-content {
                animation: qrSlideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            }
        </style>

        <!-- TOP APP BAR -->
        <div class="qr-header-bar">
            <button id="close-qr-btn" style="width:38px;height:38px;border-radius:50%;background:#f1f5f9;border:none;color:#1e293b;display:flex;align-items:center;justify-content:center;cursor:pointer;" aria-label="Back">
                <i class="fas fa-arrow-left" style="font-size:15px;"></i>
            </button>
            <div style="text-align:center;">
                <h1 style="font-size:16px;font-weight:800;color:#0f172a;margin:0;line-height:1.2;">QR Studio</h1>
                <p style="font-size:11px;color:#64748b;margin:0;font-weight:500;">Customizable &amp; Offline Generator</p>
            </div>
            <div style="width:38px;"></div>
        </div>

        <!-- MAIN SCROLLABLE BODY -->
        <div class="flex-1 overflow-y-auto qr-scrollbar-none" style="padding:14px;display:flex;flex-direction:column;gap:14px;padding-bottom:90px;">
            
            <!-- ═══════ LIVE PREVIEW CARD ═══════ -->
            <div class="qr-card-box" style="display:flex;flex-direction:column;align-items:center;background:#ffffff;">
                <div id="qr-composite-preview" class="frame-standee" style="width:100%;max-width:280px;display:flex;flex-direction:column;align-items:center;text-align:center;box-sizing:border-box;">
                    
                    <!-- Card Title -->
                    <h2 id="qr-preview-title" style="font-size:15px;font-weight:800;color:#0f172a;margin:0 0 6px 0;word-break:break-word;width:100%;display:none;"></h2>
                    
                    <!-- Card Subtitle -->
                    <p id="qr-preview-subtitle" style="font-size:11px;font-weight:500;color:#64748b;margin:0 0 10px 0;word-break:break-word;width:100%;display:none;"></p>
                    
                    <!-- QR Render Canvas Holder -->
                    <div id="qr-canvas-container" style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;background:#ffffff;border-radius:12px;overflow:hidden;">
                        <!-- Canvas renders here -->
                    </div>

                    <!-- Card Footer Badge -->
                    <div id="qr-preview-footer" style="margin-top:10px;padding-top:8px;border-top:1px solid #f1f5f9;font-size:11px;font-weight:600;color:#64748b;display:flex;align-items:center;justify-content:center;gap:5px;width:100%;">
                        <i class="fas fa-qrcode" style="color:#0d9488;"></i>
                        <span id="qr-preview-footer-text">Scan with Camera or QR Scanner</span>
                    </div>
                </div>

                <!-- QUICK ACTIONS -->
                <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;width:100%;max-width:280px;">
                    <button id="qr-btn-share" style="height:42px;background:#0d9488;border:none;color:#ffffff;font-size:12px;font-weight:700;border-radius:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;box-shadow:0 2px 6px rgba(13,148,136,0.3);">
                        <i class="fas fa-share-alt"></i> Share
                    </button>
                    <button id="qr-btn-download-png" style="height:42px;background:#0f172a;border:none;color:#ffffff;font-size:12px;font-weight:700;border-radius:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;box-shadow:0 2px 6px rgba(15,23,42,0.2);">
                        <i class="fas fa-download"></i> PNG
                    </button>
                    <button id="qr-btn-download-svg" style="height:42px;background:#f1f5f9;border:1px solid #cbd5e1;color:#1e293b;font-size:12px;font-weight:700;border-radius:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
                        <i class="fas fa-file-code"></i> SVG
                    </button>
                </div>
            </div>

            <!-- ═══════ 1. CONTENT TYPE SELECTOR ═══════ -->
            <div class="qr-card-box">
                <div class="qr-section-title">
                    <span>1. QR Content Type</span>
                    <span id="qr-active-type-label" style="color:#0d9488;font-weight:700;">Link / URL</span>
                </div>

                <!-- Horizontal Type Pills -->
                <div class="flex overflow-x-auto qr-scrollbar-none" style="display:flex;gap:8px;padding-bottom:8px;margin-bottom:12px;">
                    <button type="button" class="qr-type-pill active" data-type="link">
                        <i class="fas fa-link"></i> Link
                    </button>
                    <button type="button" class="qr-type-pill" data-type="text">
                        <i class="fas fa-align-left"></i> Text
                    </button>
                    <button type="button" class="qr-type-pill" data-type="wifi">
                        <i class="fas fa-wifi"></i> Wi-Fi
                    </button>
                    <button type="button" class="qr-type-pill" data-type="contact">
                        <i class="fas fa-address-card"></i> Contact (vCard)
                    </button>
                    <button type="button" class="qr-type-pill" data-type="phone">
                        <i class="fas fa-phone"></i> Phone
                    </button>
                    <button type="button" class="qr-type-pill" data-type="sms">
                        <i class="fas fa-comment-dots"></i> SMS
                    </button>
                    <button type="button" class="qr-type-pill" data-type="email">
                        <i class="fas fa-envelope"></i> Email
                    </button>
                    <button type="button" class="qr-type-pill" data-type="payment">
                        <i class="fas fa-credit-card"></i> Payment Requisites
                    </button>
                    <button type="button" class="qr-type-pill" data-type="location">
                        <i class="fas fa-map-marker-alt"></i> Location
                    </button>
                    <button type="button" class="qr-type-pill" data-type="custom">
                        <i class="fas fa-code"></i> Raw Payload
                    </button>
                </div>

                <!-- DYNAMIC CONTENT FORMS -->
                <!-- A. Link / URL -->
                <div id="form-type-link" class="qr-type-form" style="display:flex;flex-direction:column;gap:8px;">
                    <input type="url" id="input-link-url" class="qr-input-field" value="https://kivu.site" placeholder="https://yourwebsite.com or profile link">
                </div>

                <!-- B. Plain Text -->
                <div id="form-type-text" class="qr-type-form" style="display:none;flex-direction:column;gap:8px;">
                    <textarea id="input-text-content" class="qr-input-field" rows="3" placeholder="Enter any text, instructions, memo, or promo code..."></textarea>
                </div>

                <!-- C. Wi-Fi -->
                <div id="form-type-wifi" class="qr-type-form" style="display:none;flex-direction:column;gap:8px;">
                    <input type="text" id="input-wifi-ssid" class="qr-input-field" placeholder="Network Name (SSID) e.g. Office_Guest">
                    <div style="display:flex;gap:8px;">
                        <input type="text" id="input-wifi-pass" class="qr-input-field" style="flex:1;" placeholder="Wi-Fi Password">
                        <select id="input-wifi-auth" class="qr-input-field" style="width:110px;flex-shrink:0;">
                            <option value="WPA">WPA/WPA2</option>
                            <option value="WEP">WEP</option>
                            <option value="nopass">Open (No Pass)</option>
                        </select>
                    </div>
                    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#64748b;cursor:pointer;margin-top:2px;">
                        <input type="checkbox" id="input-wifi-hidden" style="accent-color:#0d9488;"> Hidden Network
                    </label>
                </div>

                <!-- D. Contact Card (vCard) -->
                <div id="form-type-contact" class="qr-type-form" style="display:none;flex-direction:column;gap:8px;">
                    <div style="display:flex;gap:8px;">
                        <input type="text" id="input-contact-fn" class="qr-input-field" style="flex:1;" placeholder="Full Name (e.g. John Doe)">
                        <input type="tel" id="input-contact-phone" class="qr-input-field" style="flex:1;" placeholder="Phone Number">
                    </div>
                    <div style="display:flex;gap:8px;">
                        <input type="email" id="input-contact-email" class="qr-input-field" style="flex:1;" placeholder="Email address">
                        <input type="text" id="input-contact-org" class="qr-input-field" style="flex:1;" placeholder="Company / Org">
                    </div>
                    <div style="display:flex;gap:8px;">
                        <input type="text" id="input-contact-title" class="qr-input-field" style="flex:1;" placeholder="Job Title / Role">
                        <input type="url" id="input-contact-url" class="qr-input-field" style="flex:1;" placeholder="Website">
                    </div>
                    <input type="text" id="input-contact-addr" class="qr-input-field" placeholder="Physical Address / City">
                </div>

                <!-- E. Phone Call -->
                <div id="form-type-phone" class="qr-type-form" style="display:none;flex-direction:column;gap:8px;">
                    <input type="tel" id="input-phone-num" class="qr-input-field" placeholder="+250 788 123 456">
                </div>

                <!-- F. SMS Message -->
                <div id="form-type-sms" class="qr-type-form" style="display:none;flex-direction:column;gap:8px;">
                    <input type="tel" id="input-sms-num" class="qr-input-field" placeholder="Recipient Phone Number">
                    <textarea id="input-sms-body" class="qr-input-field" rows="2" placeholder="Pre-filled SMS text message (optional)..."></textarea>
                </div>

                <!-- G. Email -->
                <div id="form-type-email" class="qr-type-form" style="display:none;flex-direction:column;gap:8px;">
                    <input type="email" id="input-email-to" class="qr-input-field" placeholder="Recipient Email (e.g. info@company.com)">
                    <input type="text" id="input-email-subject" class="qr-input-field" placeholder="Subject line">
                    <textarea id="input-email-body" class="qr-input-field" rows="2" placeholder="Email body message (optional)..."></textarea>
                </div>

                <!-- H. Universal Payment Requisites -->
                <div id="form-type-payment" class="qr-type-form" style="display:none;flex-direction:column;gap:8px;">
                    <input type="text" id="input-pay-account" class="qr-input-field" placeholder="Account Number / Phone / Merchant Code">
                    <div style="display:flex;gap:8px;">
                        <input type="text" id="input-pay-name" class="qr-input-field" style="flex:1;" placeholder="Recipient / Business Name">
                        <input type="text" id="input-pay-amount" class="qr-input-field" style="width:110px;flex-shrink:0;" placeholder="Amount (Opt)">
                    </div>
                    <input type="text" id="input-pay-note" class="qr-input-field" placeholder="Payment Reference / Note (e.g. Order #104)">
                </div>

                <!-- I. Location -->
                <div id="form-type-location" class="qr-type-form" style="display:none;flex-direction:column;gap:8px;">
                    <div style="display:flex;gap:8px;">
                        <input type="text" id="input-loc-lat" class="qr-input-field" style="flex:1;" placeholder="Latitude (e.g. -1.9441)">
                        <input type="text" id="input-loc-lng" class="qr-input-field" style="flex:1;" placeholder="Longitude (e.g. 30.0619)">
                    </div>
                    <input type="text" id="input-loc-query" class="qr-input-field" placeholder="Or Search Address / Place Name">
                </div>

                <!-- J. Custom Payload -->
                <div id="form-type-custom" class="qr-type-form" style="display:none;flex-direction:column;gap:8px;">
                    <textarea id="input-custom-payload" class="qr-input-field" rows="3" placeholder="Enter custom raw payload, URI scheme, or JSON..."></textarea>
                </div>
            </div>

            <!-- ═══════ 2. CHOOSE WHAT YOU NEED (ELEMENT TOGGLES) ═══════ -->
            <div class="qr-card-box">
                <div class="qr-section-title">
                    <span>2. Card Elements &amp; Toggles</span>
                    <span style="font-size:10px;color:#64748b;font-weight:600;">Choose what to show</span>
                </div>

                <div style="display:flex;flex-direction:column;gap:10px;">
                    
                    <!-- Toggle 1: Card Title -->
                    <div style="border-bottom:1px solid #f1f5f9;padding-bottom:10px;">
                        <div class="qr-toggle-row">
                            <span class="qr-toggle-label">
                                <i class="fas fa-heading" style="color:#0d9488;font-size:12px;"></i> Include Header Title
                            </span>
                            <label class="qr-switch">
                                <input type="checkbox" id="toggle-card-title">
                                <span class="qr-slider"></span>
                            </label>
                        </div>
                        <div id="wrapper-card-title" style="display:none;margin-top:6px;">
                            <input type="text" id="input-card-title" class="qr-input-field" placeholder="e.g. Scan to Connect / Welcome / Menu">
                        </div>
                    </div>

                    <!-- Toggle 2: Card Subtitle / Description -->
                    <div style="border-bottom:1px solid #f1f5f9;padding-bottom:10px;">
                        <div class="qr-toggle-row">
                            <span class="qr-toggle-label">
                                <i class="fas fa-quote-left" style="color:#6366f1;font-size:12px;"></i> Include Subtitle / Note
                            </span>
                            <label class="qr-switch">
                                <input type="checkbox" id="toggle-card-subtitle">
                                <span class="qr-slider"></span>
                            </label>
                        </div>
                        <div id="wrapper-card-subtitle" style="display:none;margin-top:6px;">
                            <input type="text" id="input-card-subtitle" class="qr-input-field" placeholder="e.g. Free High-Speed Wi-Fi / Official Contact">
                        </div>
                    </div>

                    <!-- Toggle 3: Center Icon / Logo -->
                    <div style="border-bottom:1px solid #f1f5f9;padding-bottom:10px;">
                        <div class="qr-toggle-row">
                            <span class="qr-toggle-label">
                                <i class="fas fa-icons" style="color:#f59e0b;font-size:12px;"></i> Include Center Icon / Logo
                            </span>
                            <label class="qr-switch">
                                <input type="checkbox" id="toggle-center-logo">
                                <span class="qr-slider"></span>
                            </label>
                        </div>
                        
                        <div id="wrapper-center-logo" style="display:none;flex-direction:column;gap:8px;margin-top:6px;">
                            <!-- Preset icon chips -->
                            <div style="font-size:11px;font-weight:700;color:#64748b;">Choose Preset Icon:</div>
                            <div class="flex overflow-x-auto qr-scrollbar-none" style="display:flex;gap:6px;padding-bottom:4px;">
                                <div class="qr-icon-chip active" data-preset-icon="link" title="Link"><i class="fas fa-link"></i></div>
                                <div class="qr-icon-chip" data-preset-icon="wifi" title="Wi-Fi"><i class="fas fa-wifi"></i></div>
                                <div class="qr-icon-chip" data-preset-icon="user" title="Contact"><i class="fas fa-user"></i></div>
                                <div class="qr-icon-chip" data-preset-icon="card" title="Payment"><i class="fas fa-credit-card"></i></div>
                                <div class="qr-icon-chip" data-preset-icon="cafe" title="Cafe / Food"><i class="fas fa-coffee"></i></div>
                                <div class="qr-icon-chip" data-preset-icon="shop" title="Shop"><i class="fas fa-shopping-bag"></i></div>
                                <div class="qr-icon-chip" data-preset-icon="phone" title="Phone"><i class="fas fa-phone"></i></div>
                                <div class="qr-icon-chip" data-preset-icon="email" title="Email"><i class="fas fa-envelope"></i></div>
                                <div class="qr-icon-chip" data-preset-icon="map" title="Location"><i class="fas fa-map-marker-alt"></i></div>
                                <div class="qr-icon-chip" data-preset-icon="star" title="Star"><i class="fas fa-star"></i></div>
                            </div>

                            <!-- Custom image upload -->
                            <div style="font-size:11px;font-weight:700;color:#64748b;margin-top:4px;">Or Upload Custom Logo:</div>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <label style="flex:1;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:12px;padding:8px 12px;font-size:12px;font-weight:600;color:#475569;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;">
                                    <i class="fas fa-image" style="color:#94a3b8;"></i>
                                    <span id="qr-logo-filename" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Select Image File</span>
                                    <input type="file" id="qr-input-logo" accept="image/png, image/jpeg, image/svg+xml" style="display:none;">
                                </label>
                                <button id="qr-clear-logo" style="width:36px;height:36px;border-radius:10px;background:#fee2e2;border:1px solid #fecaca;color:#dc2626;display:none;align-items:center;justify-content:center;cursor:pointer;">
                                    <i class="fas fa-times"></i>
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- Toggle 4: Scan Instructions Footer -->
                    <div style="border-bottom:1px solid #f1f5f9;padding-bottom:10px;">
                        <div class="qr-toggle-row">
                            <span class="qr-toggle-label">
                                <i class="fas fa-camera" style="color:#ec4899;font-size:12px;"></i> Include Footer Prompt
                            </span>
                            <label class="qr-switch">
                                <input type="checkbox" id="toggle-card-footer" checked>
                                <span class="qr-slider"></span>
                            </label>
                        </div>
                        <div id="wrapper-card-footer" style="display:block;margin-top:6px;">
                            <input type="text" id="input-card-footer" class="qr-input-field" value="Scan with Camera or QR Scanner" placeholder="Footer prompt text">
                        </div>
                    </div>

                    <!-- Card Frame Theme -->
                    <div>
                        <div class="qr-section-title" style="margin-bottom:8px;">Card Frame Presentation</div>
                        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
                            <button type="button" class="qr-style-btn active qr-frame-btn" data-frame="standee">
                                <i class="fas fa-id-card block mb-1"></i> Standee Card
                            </button>
                            <button type="button" class="qr-style-btn qr-frame-btn" data-frame="minimal">
                                <i class="fas fa-square block mb-1"></i> Minimal
                            </button>
                            <button type="button" class="qr-style-btn qr-frame-btn" data-frame="none">
                                <i class="fas fa-qrcode block mb-1"></i> QR Only
                            </button>
                        </div>
                    </div>

                </div>
            </div>

            <!-- ═══════ 3. STYLING & DESIGN THEMES ═══════ -->
            <div class="qr-card-box">
                <div class="qr-section-title">
                    <span>3. Colors &amp; Pattern Style</span>
                    <span id="qr-color-name-badge" style="font-size:11px;font-weight:700;color:#0d9488;text-transform:none;">#111827</span>
                </div>

                <!-- Color Palette -->
                <div style="margin-bottom:14px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                        <label style="font-size:11px;font-weight:700;color:#64748b;margin:0;">Color Theme</label>
                        <button type="button" id="btn-open-palette-text" style="font-size:11px;font-weight:700;color:#0d9488;background:none;border:none;cursor:pointer;padding:0;display:flex;align-items:center;gap:4px;">
                            <i class="fas fa-palette"></i> All Colors...
                        </button>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <button type="button" class="qr-color-dot active" style="background:#111827;" data-color="#111827" title="Classic Black">
                            <i class="fas fa-check" style="font-size:11px;color:#ffffff;"></i>
                        </button>
                        <button type="button" class="qr-color-dot" style="background:#0f766e;" data-color="#0f766e" title="Teal Emerald"></button>
                        <button type="button" class="qr-color-dot" style="background:#4338ca;" data-color="#4338ca" title="Royal Indigo"></button>
                        <button type="button" class="qr-color-dot" style="background:#1e3a8a;" data-color="#1e3a8a" title="Midnight Navy"></button>
                        <button type="button" class="qr-color-dot" style="background:#6d28d9;" data-color="#6d28d9" title="Purple"></button>
                        <button type="button" class="qr-color-dot" style="background:#b91c1c;" data-color="#b91c1c" title="Crimson"></button>
                        <button type="button" class="qr-color-dot" style="background:#b45309;" data-color="#b45309" title="Bronze Amber"></button>
                        <button type="button" class="qr-color-dot" style="background:#15803d;" data-color="#15803d" title="Forest Green"></button>
                        
                        <!-- Open Color Palette Button -->
                        <button type="button" id="btn-open-palette" class="qr-color-dot" style="background:linear-gradient(135deg,#f43f5e 0%,#8b5cf6 50%,#06b6d4 100%);position:relative;cursor:pointer;border:2px solid transparent;" title="Open All Colors Palette">
                            <i class="fas fa-palette" style="font-size:13px;color:#ffffff;text-shadow:0 1px 2px rgba(0,0,0,0.4);"></i>
                        </button>
                    </div>
                </div>

                <!-- Pattern / Dot Style -->
                <div style="margin-bottom:12px;">
                    <label style="font-size:11px;font-weight:700;color:#64748b;display:block;margin-bottom:8px;">Dot Pattern</label>
                    <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:5px;">
                        <button type="button" class="qr-style-btn active qr-dot-btn" data-dot="rounded">Rounded</button>
                        <button type="button" class="qr-style-btn qr-dot-btn" data-dot="dots">Dots</button>
                        <button type="button" class="qr-style-btn qr-dot-btn" data-dot="classy">Classy</button>
                        <button type="button" class="qr-style-btn qr-dot-btn" data-dot="extra-rounded">Smooth</button>
                        <button type="button" class="qr-style-btn qr-dot-btn" data-dot="square">Square</button>
                    </div>
                </div>

                <!-- Corner Shapes -->
                <div>
                    <label style="font-size:11px;font-weight:700;color:#64748b;display:block;margin-bottom:8px;">Corner Squares</label>
                    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:6px;">
                        <button type="button" class="qr-style-btn active qr-corner-btn" data-corner="extra-rounded">Extra-Rounded</button>
                        <button type="button" class="qr-style-btn qr-corner-btn" data-corner="dot">Circular</button>
                        <button type="button" class="qr-style-btn qr-corner-btn" data-corner="square">Square</button>
                    </div>
                </div>

            </div>

        </div>

        <!-- ═══════ FULL COLOR PALETTE POPUP MODAL / BOTTOM SHEET ═══════ -->
        <div id="qr-color-palette-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:100001;display:none;align-items:flex-end;justify-content:center;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);">
            <div class="qr-modal-content" style="background:#ffffff;border-radius:24px 24px 0 0;width:100%;max-width:440px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 -10px 40px rgba(0,0,0,0.25);overflow:hidden;">
                
                <!-- Modal Header -->
                <div style="padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;background:#ffffff;">
                    <div style="display:flex;align-items:center;gap:10px;">
                        <div id="modal-active-swatch-box" style="width:28px;height:28px;border-radius:8px;background:${selectedColor};border:1px solid #cbd5e1;box-shadow:0 1px 3px rgba(0,0,0,0.1);"></div>
                        <div>
                            <h3 style="font-size:15px;font-weight:800;color:#0f172a;margin:0;">Select QR Color</h3>
                            <span id="modal-active-hex-text" style="font-size:11px;font-weight:600;color:#64748b;">${selectedColor}</span>
                        </div>
                    </div>
                    <button type="button" id="btn-close-palette-modal" style="width:34px;height:34px;border-radius:50%;background:#f1f5f9;border:none;color:#64748b;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <!-- Modal Body: Scrollable Swatches -->
                <div class="flex-1 overflow-y-auto qr-scrollbar-none" style="padding:16px 20px;display:flex;flex-direction:column;gap:14px;">
                    
                    <!-- Custom Hex Input & Wheel -->
                    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:12px;display:flex;flex-direction:column;gap:8px;">
                        <label style="font-size:11px;font-weight:700;color:#475569;">Custom Hex Color Code</label>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <div style="position:relative;flex:1;">
                                <span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);font-weight:700;color:#94a3b8;font-size:13px;">#</span>
                                <input type="text" id="modal-custom-hex-input" value="111827" maxlength="6" class="qr-input-field" style="padding-left:26px;font-family:monospace;font-weight:700;text-transform:uppercase;" placeholder="111827">
                            </div>
                            <!-- Native Color Picker Picker Trigger -->
                            <label style="width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,#f43f5e,#8b5cf6,#06b6d4);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;box-shadow:0 2px 6px rgba(0,0,0,0.15);" title="Open Color Wheel">
                                <i class="fas fa-eye-dropper" style="color:#ffffff;font-size:14px;text-shadow:0 1px 2px rgba(0,0,0,0.3);"></i>
                                <input type="color" id="modal-native-color-picker" value="${selectedColor}" style="position:absolute;opacity:0;width:0;height:0;">
                            </label>
                        </div>
                    </div>

                    <!-- Palette Groups -->
                    ${paletteGroupsHtml}

                </div>

                <!-- Modal Footer / Apply Button -->
                <div style="padding:14px 20px;border-top:1px solid #e2e8f0;background:#ffffff;">
                    <button type="button" id="btn-apply-palette" style="width:100%;height:46px;background:#0d9488;border:none;color:#ffffff;font-size:14px;font-weight:700;border-radius:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 12px rgba(13,148,136,0.35);">
                        <i class="fas fa-check"></i> Apply Color
                    </button>
                </div>

            </div>
        </div>

    </div>
    `;

    document.body.insertAdjacentHTML('beforeend', uiHtml);

    // DOM Element References
    const closeBtn = document.getElementById('close-qr-btn');
    const container = document.getElementById('qr-canvas-container');
    const previewContainer = document.getElementById('qr-composite-preview');
    const previewTitle = document.getElementById('qr-preview-title');
    const previewSubtitle = document.getElementById('qr-preview-subtitle');
    const previewFooter = document.getElementById('qr-preview-footer');
    const previewFooterText = document.getElementById('qr-preview-footer-text');
    
    const activeTypeLabel = document.getElementById('qr-active-type-label');
    const typePills = document.querySelectorAll('.qr-type-pill');
    
    // Toggles
    const toggleTitle = document.getElementById('toggle-card-title');
    const wrapperTitle = document.getElementById('wrapper-card-title');
    const inputCardTitle = document.getElementById('input-card-title');

    const toggleSubtitle = document.getElementById('toggle-card-subtitle');
    const wrapperSubtitle = document.getElementById('wrapper-card-subtitle');
    const inputCardSubtitle = document.getElementById('input-card-subtitle');

    const toggleLogo = document.getElementById('toggle-center-logo');
    const wrapperLogo = document.getElementById('wrapper-center-logo');
    const iconChips = document.querySelectorAll('.qr-icon-chip');
    const inputLogoFile = document.getElementById('qr-input-logo');
    const labelLogoFilename = document.getElementById('qr-logo-filename');
    const btnClearLogo = document.getElementById('qr-clear-logo');

    const toggleFooter = document.getElementById('toggle-card-footer');
    const wrapperFooter = document.getElementById('wrapper-card-footer');
    const inputCardFooter = document.getElementById('input-card-footer');

    const frameBtns = document.querySelectorAll('.qr-frame-btn');
    const colorDots = document.querySelectorAll('.qr-color-dot');
    const colorNameBadge = document.getElementById('qr-color-name-badge');
    const dotBtns = document.querySelectorAll('.qr-dot-btn');
    const cornerBtns = document.querySelectorAll('.qr-corner-btn');

    // Palette Modal DOM Elements
    const paletteModal = document.getElementById('qr-color-palette-modal');
    const btnOpenPalette = document.getElementById('btn-open-palette');
    const btnOpenPaletteText = document.getElementById('btn-open-palette-text');
    const btnClosePaletteModal = document.getElementById('btn-close-palette-modal');
    const btnApplyPalette = document.getElementById('btn-apply-palette');
    const modalActiveSwatch = document.getElementById('modal-active-swatch-box');
    const modalActiveHexText = document.getElementById('modal-active-hex-text');
    const modalHexInput = document.getElementById('modal-custom-hex-input');
    const modalNativePicker = document.getElementById('modal-native-color-picker');
    const modalColorSwatches = document.querySelectorAll('.qr-modal-color-swatch');

    const btnShare = document.getElementById('qr-btn-share');
    const btnDownloadPng = document.getElementById('qr-btn-download-png');
    const btnDownloadSvg = document.getElementById('qr-btn-download-svg');

    let activePresetIcon = 'link';
    let isCustomLogoUploaded = false;

    // Calculate Universal QR Payload Data
    function getPayloadData() {
        switch (activeContentType) {
            case 'link': {
                let url = (document.getElementById('input-link-url')?.value || '').trim();
                if (!url) return 'https://kivu.site';
                if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) {
                    url = 'https://' + url;
                }
                return url;
            }
            case 'text': {
                const text = (document.getElementById('input-text-content')?.value || '').trim();
                return text || 'Kivu Super App';
            }
            case 'wifi': {
                const ssid = (document.getElementById('input-wifi-ssid')?.value || '').trim() || 'Kivu_WiFi';
                const pass = (document.getElementById('input-wifi-pass')?.value || '').trim();
                const auth = document.getElementById('input-wifi-auth')?.value || 'WPA';
                const hidden = document.getElementById('input-wifi-hidden')?.checked ? 'true' : 'false';
                return `WIFI:S:${ssid};T:${auth};P:${pass};H:${hidden};;`;
            }
            case 'contact': {
                const fn = (document.getElementById('input-contact-fn')?.value || '').trim() || 'Contact';
                const phone = (document.getElementById('input-contact-phone')?.value || '').trim();
                const email = (document.getElementById('input-contact-email')?.value || '').trim();
                const org = (document.getElementById('input-contact-org')?.value || '').trim();
                const title = (document.getElementById('input-contact-title')?.value || '').trim();
                const url = (document.getElementById('input-contact-url')?.value || '').trim();
                const addr = (document.getElementById('input-contact-addr')?.value || '').trim();

                let vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${fn}`;
                if (org) vcard += `\nORG:${org}`;
                if (title) vcard += `\nTITLE:${title}`;
                if (phone) vcard += `\nTEL;TYPE=CELL:${phone}`;
                if (email) vcard += `\nEMAIL:${email}`;
                if (url) vcard += `\nURL:${url}`;
                if (addr) vcard += `\nADR:;;${addr};;;;`;
                vcard += `\nEND:VCARD`;
                return vcard;
            }
            case 'phone': {
                const phone = (document.getElementById('input-phone-num')?.value || '').trim();
                return phone ? `tel:${phone}` : 'tel:+250788000000';
            }
            case 'sms': {
                const phone = (document.getElementById('input-sms-num')?.value || '').trim();
                const body = (document.getElementById('input-sms-body')?.value || '').trim();
                return `SMSTO:${phone}:${body}`;
            }
            case 'email': {
                const to = (document.getElementById('input-email-to')?.value || '').trim();
                const sub = encodeURIComponent((document.getElementById('input-email-subject')?.value || '').trim());
                const body = encodeURIComponent((document.getElementById('input-email-body')?.value || '').trim());
                return `mailto:${to}?subject=${sub}&body=${body}`;
            }
            case 'payment': {
                const acc = (document.getElementById('input-pay-account')?.value || '').trim();
                const name = (document.getElementById('input-pay-name')?.value || '').trim();
                const amt = (document.getElementById('input-pay-amount')?.value || '').trim();
                const note = (document.getElementById('input-pay-note')?.value || '').trim();

                let lines = [];
                if (name) lines.push(`Payee: ${name}`);
                if (acc) lines.push(`Account/Number: ${acc}`);
                if (amt) lines.push(`Amount: ${amt}`);
                if (note) lines.push(`Reference: ${note}`);

                return lines.length > 0 ? lines.join('\n') : 'Account: 123456789';
            }
            case 'location': {
                const lat = (document.getElementById('input-loc-lat')?.value || '').trim();
                const lng = (document.getElementById('input-loc-lng')?.value || '').trim();
                const query = (document.getElementById('input-loc-query')?.value || '').trim();

                if (lat && lng) return `geo:${lat},${lng}`;
                if (query) return `https://maps.google.com/?q=${encodeURIComponent(query)}`;
                return `geo:-1.9441,30.0619`;
            }
            case 'custom': {
                return (document.getElementById('input-custom-payload')?.value || '').trim() || 'Custom Payload';
            }
            default:
                return 'https://kivu.site';
        }
    }

    // Determine current Logo source
    function getCurrentLogoSource() {
        if (!toggleLogo.checked) return null;
        if (isCustomLogoUploaded && currentLogoData) return currentLogoData;
        if (activePresetIcon && PRESET_LOGOS[activePresetIcon]) {
            return getSvgDataUrl(PRESET_LOGOS[activePresetIcon], selectedColor);
        }
        return null;
    }

    // High performance QR render
    function renderQR() {
        const qrData = getPayloadData();
        const logoSrc = getCurrentLogoSource();

        const options = {
            width: 200,
            height: 200,
            type: 'canvas',
            data: qrData,
            image: logoSrc,
            dotsOptions: {
                color: selectedColor,
                type: selectedDotStyle
            },
            backgroundOptions: {
                color: '#ffffff'
            },
            cornersSquareOptions: {
                type: selectedCornerStyle,
                color: selectedColor
            },
            cornersDotOptions: {
                type: selectedCornerStyle === 'dot' ? 'dot' : 'square',
                color: selectedColor
            },
            qrOptions: {
                errorCorrectionLevel: logoSrc ? 'H' : 'Q'
            },
            imageOptions: {
                crossOrigin: 'anonymous',
                margin: 4,
                imageSize: 0.28
            }
        };

        if (typeof QRCodeStyling !== 'function') {
            QRCodeStyling = (typeof window !== 'undefined' ? window.QRCodeStyling : null) || (QRCodeStyling?.default);
        }

        if (typeof QRCodeStyling === 'function') {
            if (!qrCodeInstance) {
                container.innerHTML = '';
                qrCodeInstance = new QRCodeStyling(options);
                qrCodeInstance.append(container);
            } else {
                qrCodeInstance.update(options);
            }
        } else {
            console.warn('QRCodeStyling not available to render');
        }

        // Update Card Preview Elements Visibility & Content
        if (toggleTitle.checked && inputCardTitle.value.trim()) {
            previewTitle.innerText = inputCardTitle.value.trim();
            previewTitle.style.display = 'block';
        } else {
            previewTitle.style.display = 'none';
        }

        if (toggleSubtitle.checked && inputCardSubtitle.value.trim()) {
            previewSubtitle.innerText = inputCardSubtitle.value.trim();
            previewSubtitle.style.display = 'block';
        } else {
            previewSubtitle.style.display = 'none';
        }

        if (toggleFooter.checked && inputCardFooter.value.trim()) {
            previewFooterText.innerText = inputCardFooter.value.trim();
            previewFooter.style.display = 'flex';
        } else {
            previewFooter.style.display = 'none';
        }
    }

    function triggerUpdate() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(renderQR, 80);
    }

    // Set Color Function: Updates Active Color across UI & QR Code
    function applyNewColor(hex) {
        if (!hex) return;
        if (!hex.startsWith('#')) hex = '#' + hex;
        selectedColor = hex;

        // Update badge
        if (colorNameBadge) colorNameBadge.innerText = hex.toUpperCase();

        // Update modal preview
        if (modalActiveSwatch) modalActiveSwatch.style.backgroundColor = hex;
        if (modalActiveHexText) modalActiveHexText.innerText = hex.toUpperCase();
        if (modalHexInput) modalHexInput.value = hex.replace('#', '').toUpperCase();
        if (modalNativePicker) modalNativePicker.value = hex;

        // Update quick color dots on main panel
        let matchedQuickDot = false;
        colorDots.forEach(dot => {
            if (dot.dataset.color && dot.dataset.color.toLowerCase() === hex.toLowerCase()) {
                dot.classList.add('active');
                dot.innerHTML = '<i class="fas fa-check" style="font-size:11px;color:#ffffff;"></i>';
                matchedQuickDot = true;
            } else if (dot.dataset.color) {
                dot.classList.remove('active');
                dot.innerHTML = '';
            }
        });

        // If custom color not in quick dots, mark rainbow button as active
        if (!matchedQuickDot && btnOpenPalette) {
            btnOpenPalette.classList.add('active');
        } else if (btnOpenPalette) {
            btnOpenPalette.classList.remove('active');
        }

        // Update modal swatches active state
        modalColorSwatches.forEach(swatch => {
            if (swatch.dataset.hex.toLowerCase() === hex.toLowerCase()) {
                swatch.style.borderColor = '#0d9488';
                swatch.style.transform = 'scale(1.1)';
                swatch.innerHTML = '<i class="fas fa-check" style="font-size:12px;color:#ffffff;text-shadow:0 1px 2px rgba(0,0,0,0.5);"></i>';
            } else {
                swatch.style.borderColor = 'transparent';
                swatch.style.transform = 'scale(1)';
                swatch.innerHTML = '';
            }
        });

        triggerUpdate();
    }

    // Open & Close Palette Modal Handlers
    function openPaletteModal() {
        if (!paletteModal) return;
        paletteModal.style.display = 'flex';
        applyNewColor(selectedColor);
    }

    function closePaletteModal() {
        if (!paletteModal) return;
        paletteModal.style.display = 'none';
    }

    if (btnOpenPalette) btnOpenPalette.addEventListener('click', openPaletteModal);
    if (btnOpenPaletteText) btnOpenPaletteText.addEventListener('click', openPaletteModal);
    if (btnClosePaletteModal) btnClosePaletteModal.addEventListener('click', closePaletteModal);
    if (btnApplyPalette) btnApplyPalette.addEventListener('click', closePaletteModal);

    // Close on backdrop click
    if (paletteModal) {
        paletteModal.addEventListener('click', (e) => {
            if (e.target === paletteModal) closePaletteModal();
        });
    }

    // Swatch click in modal
    modalColorSwatches.forEach(swatch => {
        swatch.addEventListener('click', () => {
            const hex = swatch.dataset.hex;
            applyNewColor(hex);
        });
    });

    // Custom Hex input in modal
    if (modalHexInput) {
        modalHexInput.addEventListener('input', (e) => {
            let val = e.target.value.replace(/[^0-9a-fA-F]/g, '');
            if (val.length === 6 || val.length === 3) {
                applyNewColor('#' + val);
            }
        });
    }

    // Native color picker input in modal
    if (modalNativePicker) {
        modalNativePicker.addEventListener('input', (e) => {
            applyNewColor(e.target.value);
        });
    }

    // Quick Color Dots on Main Screen
    colorDots.forEach(dot => {
        if (dot.dataset.color) {
            dot.addEventListener('click', () => {
                applyNewColor(dot.dataset.color);
            });
        }
    });

    // Content Type Switching
    typePills.forEach(pill => {
        pill.addEventListener('click', () => {
            typePills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');

            activeContentType = pill.dataset.type;
            activeTypeLabel.innerText = pill.innerText.trim();

            // Switch forms
            document.querySelectorAll('.qr-type-form').forEach(f => f.style.display = 'none');
            const targetForm = document.getElementById(`form-type-${activeContentType}`);
            if (targetForm) targetForm.style.display = 'flex';

            // Auto-sync preset logo if toggle is active & user hasn't uploaded custom
            if (toggleLogo.checked && !isCustomLogoUploaded) {
                const matchingPreset = ['link', 'wifi', 'phone', 'email', 'card'].includes(activeContentType) 
                    ? (activeContentType === 'card' ? 'card' : activeContentType) 
                    : (activeContentType === 'contact' ? 'user' : 'link');

                iconChips.forEach(chip => {
                    if (chip.dataset.presetIcon === matchingPreset) {
                        iconChips.forEach(c => c.classList.remove('active'));
                        chip.classList.add('active');
                        activePresetIcon = matchingPreset;
                    }
                });
            }

            triggerUpdate();
        });
    });

    // Toggle 1: Card Title
    toggleTitle.addEventListener('change', () => {
        wrapperTitle.style.display = toggleTitle.checked ? 'block' : 'none';
        triggerUpdate();
    });
    inputCardTitle.addEventListener('input', triggerUpdate);

    // Toggle 2: Card Subtitle
    toggleSubtitle.addEventListener('change', () => {
        wrapperSubtitle.style.display = toggleSubtitle.checked ? 'block' : 'none';
        triggerUpdate();
    });
    inputCardSubtitle.addEventListener('input', triggerUpdate);

    // Toggle 3: Center Logo
    toggleLogo.addEventListener('change', () => {
        wrapperLogo.style.display = toggleLogo.checked ? 'flex' : 'none';
        triggerUpdate();
    });

    // Preset Icon Selection
    iconChips.forEach(chip => {
        chip.addEventListener('click', () => {
            iconChips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            activePresetIcon = chip.dataset.presetIcon;
            isCustomLogoUploaded = false;
            triggerUpdate();
        });
    });

    // Custom Logo File Upload
    inputLogoFile.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            labelLogoFilename.innerText = file.name;
            btnClearLogo.style.display = 'flex';
            currentLogoData = await resizeImageToThumbnail(file, 140);
            isCustomLogoUploaded = true;
            iconChips.forEach(c => c.classList.remove('active'));
            triggerUpdate();
        } catch (err) {
            console.error('Failed to process custom logo:', err);
            if (window.showToast) window.showToast('Could not load logo image', true);
        }
    });

    btnClearLogo.addEventListener('click', () => {
        isCustomLogoUploaded = false;
        currentLogoData = null;
        inputLogoFile.value = '';
        labelLogoFilename.innerText = 'Select Image File';
        btnClearLogo.style.display = 'none';
        
        // Reactivate first preset
        if (iconChips[0]) {
            iconChips[0].classList.add('active');
            activePresetIcon = iconChips[0].dataset.presetIcon;
        }
        triggerUpdate();
    });

    // Toggle 4: Footer
    toggleFooter.addEventListener('change', () => {
        wrapperFooter.style.display = toggleFooter.checked ? 'block' : 'none';
        triggerUpdate();
    });
    inputCardFooter.addEventListener('input', triggerUpdate);

    // Frame Style Selector
    frameBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            frameBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const frame = btn.dataset.frame;
            previewContainer.className = `frame-${frame}`;
        });
    });

    // Dot Pattern Selector
    dotBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            dotBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedDotStyle = btn.dataset.dot;
            triggerUpdate();
        });
    });

    // Corner Style Selector
    cornerBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            cornerBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedCornerStyle = btn.dataset.corner;
            triggerUpdate();
        });
    });

    // Listen to all inputs across all forms
    const allInputIds = [
        'input-link-url', 'input-text-content', 'input-wifi-ssid', 'input-wifi-pass', 'input-wifi-auth', 'input-wifi-hidden',
        'input-contact-fn', 'input-contact-phone', 'input-contact-email', 'input-contact-org', 'input-contact-title', 'input-contact-url', 'input-contact-addr',
        'input-phone-num', 'input-sms-num', 'input-sms-body', 'input-email-to', 'input-email-subject', 'input-email-body',
        'input-pay-account', 'input-pay-name', 'input-pay-amount', 'input-pay-note', 'input-loc-lat', 'input-loc-lng', 'input-loc-query', 'input-custom-payload'
    ];
    allInputIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', triggerUpdate);
            el.addEventListener('change', triggerUpdate);
        }
    });

    // High-Resolution Composite Card Generator for PNG/Share
    async function createCompositeBlob() {
        if (!qrCodeInstance) return null;
        const qrRawBlob = await qrCodeInstance.getRawData('png');
        if (!qrRawBlob) return null;

        const hasTitle = toggleTitle.checked && inputCardTitle.value.trim();
        const hasSubtitle = toggleSubtitle.checked && inputCardSubtitle.value.trim();
        const hasFooter = toggleFooter.checked && inputCardFooter.value.trim();
        const titleText = hasTitle ? inputCardTitle.value.trim() : '';
        const subtitleText = hasSubtitle ? inputCardSubtitle.value.trim() : '';
        const footerText = hasFooter ? inputCardFooter.value.trim() : '';

        return new Promise((resolve) => {
            const img = new Image();
            const url = URL.createObjectURL(qrRawBlob);
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                const qrSize = 600;
                const padding = 50;
                let headerHeight = 0;
                if (titleText) headerHeight += 50;
                if (subtitleText) headerHeight += 35;
                const footerHeight = footerText ? 60 : 10;

                canvas.width = qrSize + (padding * 2);
                canvas.height = qrSize + headerHeight + footerHeight + (padding * 2);

                // Background
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                // Subtle Card Border
                ctx.strokeStyle = '#e2e8f0';
                ctx.lineWidth = 4;
                ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);

                let currentY = padding + 20;

                // Title
                if (titleText) {
                    ctx.fillStyle = '#0f172a';
                    ctx.font = 'bold 32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(titleText, canvas.width / 2, currentY);
                    currentY += 40;
                }

                // Subtitle
                if (subtitleText) {
                    ctx.fillStyle = '#64748b';
                    ctx.font = '500 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(subtitleText, canvas.width / 2, currentY);
                    currentY += 30;
                }

                // Draw QR Code
                const qrY = headerHeight > 0 ? (padding + headerHeight + 10) : padding;
                ctx.drawImage(img, padding, qrY, qrSize, qrSize);

                // Footer Prompt
                if (footerText) {
                    const footerY = canvas.height - padding - 15;
                    ctx.fillStyle = '#64748b';
                    ctx.font = '600 18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(footerText, canvas.width / 2, footerY);
                }

                URL.revokeObjectURL(url);
                canvas.toBlob((blob) => resolve(blob), 'image/png', 0.95);
            };
            img.src = url;
        });
    }

    // Share Button
    btnShare.addEventListener('click', async () => {
        try {
            const blob = await createCompositeBlob();
            if (!blob) return;

            const file = new File([blob], 'kivu-qr.png', { type: 'image/png' });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({
                    files: [file],
                    title: inputCardTitle.value.trim() || 'QR Code',
                    text: inputCardSubtitle.value.trim() || 'Scannable QR Code'
                });
            } else {
                const link = document.createElement('a');
                link.download = 'kivu-qr.png';
                link.href = URL.createObjectURL(blob);
                link.click();
                if (window.showToast) window.showToast('QR Code saved');
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('Share error:', err);
                if (window.showToast) window.showToast('Could not share QR Code', true);
            }
        }
    });

    // Save PNG
    btnDownloadPng.addEventListener('click', async () => {
        try {
            const blob = await createCompositeBlob();
            if (!blob) return;
            const link = document.createElement('a');
            link.download = 'kivu-qr.png';
            link.href = URL.createObjectURL(blob);
            link.click();
            if (window.showToast) window.showToast('QR Code PNG downloaded');
        } catch (err) {
            console.error('PNG download error:', err);
            if (window.showToast) window.showToast('Error saving PNG', true);
        }
    });

    // Save SVG
    btnDownloadSvg.addEventListener('click', async () => {
        try {
            if (!qrCodeInstance) return;
            await qrCodeInstance.download({ extension: 'svg', name: 'kivu-qr' });
            if (window.showToast) window.showToast('QR Code SVG downloaded');
        } catch (err) {
            console.error('SVG download error:', err);
            if (window.showToast) window.showToast('Error saving SVG', true);
        }
    });

    // Close Button
    closeBtn.addEventListener('click', closeQRGenerator);

    // Initial render
    renderQR();
}