// src/modules/tools/converter.js
// Universal Offline File Converter 2.0 for Kivu Super App
// 100% Client-side, Low-RAM Optimized, Zero Server Dependency

import { encodeMp3 } from './mp3-encoder.js';
import { readDocx, docxBlocksToMarkdown } from './docx-reader.js';
import { getDeviceProfile } from './device-profile.js';

const STORAGE_INDEX_KEY = 'kivu_docs_index';
const STORAGE_PREFIX = 'kivu_doc_';

// Lazy loaded library instances
let _pdfLib = null;
let _pdfjsLib = null;
let _xlsxLib = null;
let _jszipLib = null;

async function getPdfLib() {
    if (!_pdfLib) {
        _pdfLib = await import('pdf-lib');
    }
    return _pdfLib;
}

async function getPdfJs() {
    if (!_pdfjsLib) {
        const pdfjs = await import('pdfjs-dist');
        try {
            pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
        } catch (e) {
            console.warn('pdfjs worker initialization fallback:', e);
        }
        _pdfjsLib = pdfjs;
    }
    return _pdfjsLib;
}

async function getXlsxLib() {
    if (!_xlsxLib) {
        _xlsxLib = (typeof window !== 'undefined' && window.XLSX)
            ? window.XLSX
            : await import('xlsx').then(m => m.default || m).catch(() => null);
    }
    return _xlsxLib;
}

async function getJSZip() {
    if (!_jszipLib) {
        _jszipLib = (typeof window !== 'undefined' && window.JSZip)
            ? window.JSZip
            : await import('jszip').then(m => m.default || m).catch(() => null);
    }
    return _jszipLib;
}

// Module State
let currentDocId = null;
let selectedCategory = 'image'; // 'image' | 'pdf' | 'doc' | 'sheet' | '3d' | 'audio' | 'video' | 'archive'
let currentFile = null;
let currentFilesList = []; // For batch/archive mode
let targetFormat = 'webp';
let compressionQuality = 0.82;
let targetPreset = 'whatsapp'; // 'whatsapp' (Compact) | 'balanced' (Standard) | 'original' (Max)
let lastConvertedBlob = null;
let lastConvertedFileName = '';

// ==========================================
// FILE READING HELPERS
// ==========================================

export function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        if (!file) return reject(new Error('No file provided'));
        if (file instanceof ArrayBuffer) return resolve(file);
        if (file.buffer instanceof ArrayBuffer) return resolve(file.buffer);
        if (typeof file === 'string') {
            const enc = new TextEncoder();
            return resolve(enc.encode(file).buffer);
        }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Failed to read file as ArrayBuffer'));
        reader.readAsArrayBuffer(file);
    });
}

export function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        if (!file) return reject(new Error('No file provided'));
        if (typeof file === 'string') return resolve(file);
        if (file instanceof ArrayBuffer) {
            const dec = new TextDecoder('utf-8');
            return resolve(dec.decode(file));
        }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Failed to read file as text'));
        reader.readAsText(file);
    });
}

function loadImage(file) {
    return new Promise((resolve, reject) => {
        if (typeof HTMLImageElement !== 'undefined' && file instanceof HTMLImageElement) {
            return resolve(file);
        }
        if (typeof Image === 'undefined') {
            return resolve({ naturalWidth: 800, naturalHeight: 600, width: 800, height: 600, src: '' });
        }

        const img = new Image();
        const objectUrl = (file instanceof Blob || file instanceof File) ? URL.createObjectURL(file) : null;

        img.onload = () => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            resolve(img);
        };
        img.onerror = (err) => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            reject(new Error('Failed to load image element'));
        };

        if (objectUrl) {
            img.src = objectUrl;
        } else if (typeof file === 'string') {
            img.src = file;
        } else {
            reject(new Error('Unsupported image input format'));
        }
    });
}

function canvasToBlob(canvas, targetMime, quality = 0.82) {
    return new Promise((resolve, reject) => {
        if (canvas && canvas.toBlob) {
            canvas.toBlob(
                (blob) => blob ? resolve(blob) : reject(new Error('Canvas failed to produce image data')),
                targetMime,
                quality
            );
        } else if (canvas && canvas.toDataURL) {
            try {
                const dataUrl = canvas.toDataURL(targetMime, quality);
                const byteString = atob(dataUrl.split(',')[1]);
                const bytes = new Uint8Array(byteString.length);
                for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
                resolve(new Blob([bytes], { type: targetMime }));
            } catch (err) {
                reject(err);
            }
        } else {
            reject(new Error('Canvas encoding unavailable'));
        }
    });
}

function getMaxDimensionForPreset(preset) {
    switch (preset) {
        case 'whatsapp':
            return 1280; // Compact: Fast mobile chat & low memory
        case 'balanced':
            return 1920; // Standard: Full HD
        case 'original':
        default:
            return 2560; // Max Lossless: High resolution
    }
}

// ==========================================
// 1. IMAGE CONVERSION PIPELINE
// ==========================================
export async function convertImage(file, format = 'webp', options = {}) {
    const quality = options.quality !== undefined ? options.quality : compressionQuality;
    const preset = options.preset || targetPreset;
    const fmt = format ? format.toLowerCase() : 'webp';

    // --- Image to PDF via pdf-lib ---
    if (fmt === 'pdf') {
        try {
            const pdfLib = await getPdfLib();
            const pdfDoc = await pdfLib.PDFDocument.create();

            const img = await loadImage(file);
            const maxDim = getMaxDimensionForPreset(preset);

            let srcW = img.naturalWidth || img.width || 800;
            let srcH = img.naturalHeight || img.height || 600;
            let targetW = srcW;
            let targetH = srcH;

            if (srcW > maxDim || srcH > maxDim) {
                if (srcW > srcH) {
                    targetW = maxDim;
                    targetH = Math.round((srcH * maxDim) / srcW);
                } else {
                    targetH = maxDim;
                    targetW = Math.round((srcW * maxDim) / srcH);
                }
            }

            const canvas = document.createElement('canvas');
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, targetW, targetH);
            ctx.drawImage(img, 0, 0, targetW, targetH);

            let embeddedImage = null;
            try {
                const jpegBlob = await canvasToBlob(canvas, 'image/jpeg', quality);
                const jpegBuffer = await readFileAsArrayBuffer(jpegBlob);
                embeddedImage = await pdfDoc.embedJpg(jpegBuffer);
            } catch (embedErr) {
                console.warn('Direct JPEG embed fallback:', embedErr.message);
            }

            // A4 page setup (595.28 x 841.89 points)
            const a4Width = 595.28;
            const a4Height = 841.89;
            const margin = 20;
            const usableWidth = a4Width - (margin * 2);
            const usableHeight = a4Height - (margin * 2);

            const imgRatio = targetW / targetH;
            let renderW = usableWidth;
            let renderH = usableWidth / imgRatio;

            if (renderH > usableHeight) {
                renderH = usableHeight;
                renderW = usableHeight * imgRatio;
            }

            const page = pdfDoc.addPage([a4Width, a4Height]);
            const xOffset = margin + (usableWidth - renderW) / 2;
            const yOffset = margin + (usableHeight - renderH) / 2;

            if (embeddedImage) {
                page.drawImage(embeddedImage, {
                    x: xOffset,
                    y: yOffset,
                    width: renderW,
                    height: renderH
                });
            } else {
                const font = await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica);
                page.drawText('Converted Image Document', {
                    x: 40,
                    y: 800,
                    size: 14,
                    font: font
                });
            }

            canvas.width = 0;
            canvas.height = 0;

            const pdfBytes = await pdfDoc.save();
            return new Blob([pdfBytes], { type: 'application/pdf' });
        } catch (e) {
            console.error('pdf-lib Image to PDF failed:', e);
            throw new Error('Image to PDF conversion failed: ' + (e && e.message ? e.message : e));
        }
    }

    // --- Image to ICO (Favicon generation) ---
    if (fmt === 'ico') {
        const img = await loadImage(file);
        const iconSizes = [16, 32, 48];
        const pngBlobs = [];

        for (const s of iconSizes) {
            const canvas = document.createElement('canvas');
            canvas.width = s;
            canvas.height = s;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, s, s);
            const blob = await canvasToBlob(canvas, 'image/png');
            pngBlobs.push({ size: s, blob, buffer: await readFileAsArrayBuffer(blob) });
            canvas.width = 0;
            canvas.height = 0;
        }

        // Build valid ICO binary format container
        const numImages = pngBlobs.length;
        const headerLength = 6 + (16 * numImages);
        let currentOffset = headerLength;

        const totalLength = headerLength + pngBlobs.reduce((acc, p) => acc + p.buffer.byteLength, 0);
        const icoBuffer = new ArrayBuffer(totalLength);
        const view = new DataView(icoBuffer);

        // ICO Header
        view.setUint16(0, 0, true); // Reserved
        view.setUint16(2, 1, true); // Type: 1 = ICO
        view.setUint16(4, numImages, true);

        // Directory Entries
        for (let i = 0; i < numImages; i++) {
            const entryOffset = 6 + (i * 16);
            const p = pngBlobs[i];
            view.setUint8(entryOffset, p.size); // Width
            view.setUint8(entryOffset + 1, p.size); // Height
            view.setUint8(entryOffset + 2, 0); // Palette count
            view.setUint8(entryOffset + 3, 0); // Reserved
            view.setUint16(entryOffset + 4, 1, true); // Color planes
            view.setUint16(entryOffset + 6, 32, true); // Bits per pixel
            view.setUint32(entryOffset + 8, p.buffer.byteLength, true); // Size
            view.setUint32(entryOffset + 12, currentOffset, true); // Offset

            new Uint8Array(icoBuffer, currentOffset, p.buffer.byteLength).set(new Uint8Array(p.buffer));
            currentOffset += p.buffer.byteLength;
        }

        return new Blob([icoBuffer], { type: 'image/x-icon' });
    }

    // --- Image to SVG (Wrapped vector container) ---
    if (fmt === 'svg') {
        const img = await loadImage(file);
        const w = img.naturalWidth || img.width || 800;
        const h = img.naturalHeight || img.height || 600;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/png');
        canvas.width = 0;
        canvas.height = 0;

        const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <image width="${w}" height="${h}" xlink:href="${dataUrl}"/>
</svg>`;
        return new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    }

    // --- Standard Raster Formats (WEBP / JPG / PNG) ---
    let targetMime = 'image/webp';
    if (fmt === 'jpg' || fmt === 'jpeg') targetMime = 'image/jpeg';
    else if (fmt === 'png') targetMime = 'image/png';
    else if (fmt === 'webp') targetMime = 'image/webp';

    const img = await loadImage(file);
    const maxDim = getMaxDimensionForPreset(preset);

    let srcW = img.naturalWidth || img.width || 800;
    let srcH = img.naturalHeight || img.height || 600;
    let targetW = srcW;
    let targetH = srcH;

    if (srcW > maxDim || srcH > maxDim) {
        if (srcW > srcH) {
            targetW = maxDim;
            targetH = Math.round((srcH * maxDim) / srcW);
        } else {
            targetH = maxDim;
            targetW = Math.round((srcW * maxDim) / srcH);
        }
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Canvas context unavailable');
    }

    if (targetMime === 'image/jpeg') {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const resultBlob = await canvasToBlob(canvas, targetMime, quality);
    canvas.width = 0;
    canvas.height = 0;
    return resultBlob;
}

// ==========================================
// 2. PDF CONVERSION PIPELINE (PDF -> Images, DOCX, TXT, HTML)
// ==========================================
export async function convertPdf(file, format = 'jpg', options = {}) {
    const fmt = format ? format.toLowerCase() : 'jpg';

    // PDF to Image (JPG, PNG, WEBP)
    if (fmt === 'jpg' || fmt === 'jpeg' || fmt === 'png' || fmt === 'webp') {
        try {
            const pdfjsLib = await getPdfJs();
            const arrayBuffer = await readFileAsArrayBuffer(file);
            const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
            const pdf = await loadingTask.promise;

            if (pdf.numPages === 0) {
                throw new Error('PDF has no pages');
            }

            const targetMime = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');
            const ext = fmt === 'jpeg' ? 'jpg' : fmt;
            // Pages are rendered one at a time into a single canvas to keep
            // peak memory low on 2 GB phones.
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const renderPage = async (n) => {
                const page = await pdf.getPage(n);
                const viewport = page.getViewport({ scale: getDeviceProfile().pdfRenderScale });
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                if (targetMime === 'image/jpeg') {
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                }
                await page.render({ canvasContext: ctx, viewport }).promise;
                page.cleanup();
                return canvasToBlob(canvas, targetMime, options.quality || 0.85);
            };

            try {
                if (pdf.numPages === 1) return await renderPage(1);

                // Multi-page PDF: every page as an image, bundled in a ZIP
                const JSZipMod = await getJSZip();
                if (!JSZipMod) throw new Error('ZIP engine could not be loaded');
                const zip = new JSZipMod();
                const pad = String(pdf.numPages).length;
                for (let n = 1; n <= pdf.numPages; n++) {
                    if (options.onProgress) options.onProgress(n / pdf.numPages);
                    zip.file(`page-${String(n).padStart(pad, '0')}.${ext}`, await renderPage(n));
                }
                return await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' });
            } finally {
                canvas.width = 0;
                canvas.height = 0;
                pdf.destroy();
            }
        } catch (e) {
            console.error('PDF to Image failed:', e);
            throw new Error('Failed to convert PDF to Image: ' + (e && e.message ? e.message : e));
        }
    }

    // PDF to DOCX / TXT / HTML text extraction
    if (fmt === 'docx' || fmt === 'txt' || fmt === 'html') {
        try {
            const pdfjsLib = await getPdfJs();
            const arrayBuffer = await readFileAsArrayBuffer(file);
            const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
            const pdf = await loadingTask.promise;
            let fullText = '';
            let htmlContent = '';

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ');
                fullText += `--- Page ${i} ---\n` + pageText + '\n\n';
                htmlContent += `<h3>Page ${i}</h3><p>${pageText.replace(/\n/g, '<br>')}</p><hr/>`;
            }

            if (fmt === 'txt') {
                return new Blob([fullText], { type: 'text/plain;charset=utf-8;' });
            }

            if (fmt === 'html') {
                const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Converted PDF</title><style>body{font-family:sans-serif;padding:20px;max-width:800px;margin:auto;line-height:1.6;}</style></head><body>${htmlContent}</body></html>`;
                return new Blob([fullHtml], { type: 'text/html;charset=utf-8;' });
            }

            const htmlToDocxMod = (typeof window !== 'undefined' && window.htmlToDocx)
                ? window.htmlToDocx
                : await import('html-to-docx').then(m => m.default || m).catch(() => null);

            if (htmlToDocxMod) {
                const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${htmlContent}</body></html>`;
                const docxBlob = await htmlToDocxMod(fullHtml, null, { title: file.name || 'document' });
                if (docxBlob) return docxBlob;
            }

            return new Blob([fullText], { type: 'application/msword;charset=utf-8;' });
        } catch (e) {
            console.error('PDF to DOCX/Text failed:', e);
            throw new Error('Failed to extract text from PDF: ' + (e && e.message ? e.message : e));
        }
    }

    throw new Error(`Unsupported target format for PDF: ${fmt}`);
}

// ==========================================
// 3. DOCUMENT CONVERSION PIPELINE (TXT/MD/DOCX/HTML)
// ==========================================

// --- Text to PDF ---
// Markdown-ish text -> [{ text, style: 'h1'|'h2'|'h3'|'p'|'li'|'gap' }]
function markdownToBlocks(md) {
    const stripInline = (t) => t.replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1').replace(/`([^`]+)`/g, '$1');
    return String(md).replace(/\r\n?/g, '\n').split('\n').map((line) => {
        const l = line.replace(/\t/g, '    ');
        if (!l.trim()) return { text: '', style: 'gap' };
        let m;
        if ((m = l.match(/^(#{1,3})\s+(.*)$/))) return { text: stripInline(m[2]), style: 'h' + m[1].length };
        if ((m = l.match(/^\s*[-*]\s+(.*)$/))) return { text: '• ' + stripInline(m[1]), style: 'li' };
        return { text: stripInline(l), style: 'p' };
    });
}

const PDF_BLOCK_STYLES = {
    h1: { size: 18, bold: true, before: 6, after: 8 },
    h2: { size: 14, bold: true, before: 4, after: 6 },
    h3: { size: 12, bold: true, before: 3, after: 4 },
    p: { size: 10.5, bold: false, before: 0, after: 2 },
    li: { size: 10.5, bold: false, before: 0, after: 2 },
    gap: { size: 10.5, bold: false, before: 0, after: 0 },
};

function wrapText(text, maxWidth, measure) {
    const out = [];
    for (const para of text.split('\n')) {
        const words = para.split(/(\s+)/);
        let line = '';
        for (const w of words) {
            const candidate = line + w;
            if (!line || measure(candidate.trimEnd()) <= maxWidth) {
                line = candidate;
                continue;
            }
            out.push(line.trimEnd());
            line = w.trimStart();
            // Break single words longer than a line (URLs, IDs)
            while (line && measure(line) > maxWidth) {
                let cut = line.length - 1;
                while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut--;
                out.push(line.slice(0, cut));
                line = line.slice(cut);
            }
        }
        out.push(line.trimEnd());
    }
    return out;
}

async function textBlocksToPdf(blocks) {
    const pdfLib = await getPdfLib();
    const pdfDoc = await pdfLib.PDFDocument.create();
    const font = await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(pdfLib.StandardFonts.HelveticaBold);

    // Standard PDF fonts only cover Western European characters. For other
    // scripts (Amharic, Arabic, emoji...) render pages with the phone's own
    // fonts on a canvas so no text is lost.
    const allText = blocks.map(b => b.text.replace(/\n/g, ' ')).join(' ');
    try {
        font.encodeText(allText);
        boldFont.encodeText(allText);
    } catch (_) {
        return textBlocksToPdfViaCanvas(pdfLib, pdfDoc, blocks);
    }

    const pageSize = [595.28, 841.89]; // A4
    const margin = 48;
    const maxWidth = pageSize[0] - margin * 2;
    let page = pdfDoc.addPage(pageSize);
    let y = pageSize[1] - margin;
    for (const block of blocks) {
        const st = PDF_BLOCK_STYLES[block.style] || PDF_BLOCK_STYLES.p;
        const f = st.bold ? boldFont : font;
        const lineHeight = st.size * 1.45;
        if (block.style === 'gap') { y -= lineHeight * 0.6; continue; }
        y -= st.before;
        for (const line of wrapText(block.text, maxWidth, (t) => f.widthOfTextAtSize(t, st.size))) {
            if (y - lineHeight < margin) {
                page = pdfDoc.addPage(pageSize);
                y = pageSize[1] - margin;
            }
            y -= lineHeight;
            if (line) page.drawText(line, { x: margin, y: y + (lineHeight - st.size) / 2, size: st.size, font: f, color: pdfLib.rgb(0.1, 0.1, 0.12) });
        }
        y -= st.after;
    }
    const pdfBytes = await pdfDoc.save();
    return new Blob([pdfBytes], { type: 'application/pdf' });
}

async function textBlocksToPdfViaCanvas(pdfLib, pdfDoc, blocks) {
    const pageSize = [595.28, 841.89];
    const scale = 2; // ~144 DPI: sharp text, moderate memory on low-end phones
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(pageSize[0] * scale);
    canvas.height = Math.round(pageSize[1] * scale);
    const ctx = canvas.getContext('2d');
    const margin = 48 * scale;
    const maxWidth = canvas.width - margin * 2;
    const family = 'system-ui, -apple-system, "Noto Sans", "Noto Sans Ethiopic", "Noto Sans Arabic", sans-serif';

    const startPage = () => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#1a1a1f';
        ctx.textBaseline = 'top';
        return margin;
    };
    const flushPage = async () => {
        const blob = await canvasToBlob(canvas, 'image/jpeg', 0.85);
        const img = await pdfDoc.embedJpg(await blob.arrayBuffer());
        pdfDoc.addPage(pageSize).drawImage(img, { x: 0, y: 0, width: pageSize[0], height: pageSize[1] });
    };

    let y = startPage();
    let pageDirty = false;
    for (const block of blocks) {
        const st = PDF_BLOCK_STYLES[block.style] || PDF_BLOCK_STYLES.p;
        const size = st.size * scale;
        const lineHeight = size * 1.5;
        if (block.style === 'gap') { y += lineHeight * 0.6; continue; }
        ctx.font = `${st.bold ? 'bold ' : ''}${size}px ${family}`;
        y += st.before * scale;
        for (const line of wrapText(block.text, maxWidth, (t) => ctx.measureText(t).width)) {
            if (y + lineHeight > canvas.height - margin) {
                await flushPage();
                pageDirty = false;
                y = startPage();
                ctx.font = `${st.bold ? 'bold ' : ''}${size}px ${family}`;
            }
            ctx.fillText(line, margin, y);
            pageDirty = true;
            y += lineHeight;
        }
        y += st.after * scale;
    }
    if (pageDirty || pdfDoc.getPageCount() === 0) await flushPage();
    canvas.width = canvas.height = 0;
    const pdfBytes = await pdfDoc.save();
    return new Blob([pdfBytes], { type: 'application/pdf' });
}

// Lightweight Markdown to HTML renderer
function markdownToHtml(mdText) {
    let html = mdText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Headings
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Bold and Italic
    html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');

    // Code blocks
    html = html.replace(/```([\s\S]*?)```/gim, '<pre><code>$1</code></pre>');
    html = html.replace(/`([^`]+)`/gim, '<code>$1</code>');

    // Blockquotes
    html = html.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');

    // Lists
    html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');
    html = html.replace(/^\* (.*$)/gim, '<li>$1</li>');

    // Paragraphs
    html = html.replace(/\n\n/gim, '</p><p>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<p><\/p>/gim, '');
    return html;
}

// HTML to Markdown helper
function htmlToMarkdown(htmlText) {
    let md = htmlText
        .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
        .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
        .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
        .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
        .replace(/<b>(.*?)<\/b>/gi, '**$1**')
        .replace(/<em>(.*?)<\/em>/gi, '*$1*')
        .replace(/<i>(.*?)<\/i>/gi, '*$1*')
        .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
        .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
        .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
        .replace(/<br\s*[\/]?>/gi, '\n')
        .replace(/<hr\s*[\/]?>/gi, '\n---\n')
        .replace(/<[^>]+>/g, '');
    return md.trim();
}

export async function convertDocument(file, format = 'pdf', options = {}) {
    const fmt = format ? format.toLowerCase() : 'pdf';
    const fileName = (file && file.name) ? file.name.toLowerCase() : '';
    const isMd = fileName.endsWith('.md') || (typeof file === 'string' && (file.startsWith('#') || file.includes('**')));
    const isHtml = fileName.endsWith('.html') || fileName.endsWith('.htm') || (typeof file === 'string' && file.trim().startsWith('<'));
    const isText = fileName.endsWith('.txt') || (file && file.type === 'text/plain') || typeof file === 'string';
    const isDocx = fileName.endsWith('.docx') || (file && file.type && file.type.includes('wordprocessingml'));

    if (fileName.endsWith('.doc') && !isDocx) {
        throw new Error('Old .doc files are not supported. Open it in Word or Google Docs and save as .docx first.');
    }
    if (isDocx && (fmt === 'docx')) {
        return file;
    }

    if (isDocx || isMd || isHtml || isText || typeof file === 'string') {
        // DOCX is converted to Markdown so it flows through the same text pipeline.
        const rawContent = isDocx ? docxBlocksToMarkdown(await readDocx(await readFileAsArrayBuffer(file))) : await readFileAsText(file);

        // Markdown <-> HTML
        if (fmt === 'html' || fmt === 'htm') {
            const htmlBody = isHtml ? rawContent : markdownToHtml(rawContent);
            const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${fileName || 'Document'}</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:30px auto;padding:0 20px;line-height:1.6;color:#1e293b;}h1,h2,h3{color:#0f172a;}code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-family:monospace;}pre{background:#0f172a;color:#f8fafc;padding:16px;border-radius:8px;overflow-x:auto;}</style></head><body>${htmlBody}</body></html>`;
            return new Blob([fullHtml], { type: 'text/html;charset=utf-8;' });
        }

        if (fmt === 'md' || fmt === 'markdown') {
            const mdResult = isHtml ? htmlToMarkdown(rawContent) : rawContent;
            return new Blob([mdResult], { type: 'text/markdown;charset=utf-8;' });
        }

        if (fmt === 'txt') {
            const plain = isHtml ? htmlToMarkdown(rawContent) : (isDocx ? rawContent.replace(/^#{1,3} /gm, '') : rawContent);
            return new Blob([plain], { type: 'text/plain;charset=utf-8;' });
        }

        // Text / MD / HTML / DOCX to PDF
        if (fmt === 'pdf') {
            try {
                const markdown = isHtml ? htmlToMarkdown(rawContent) : rawContent;
                return await textBlocksToPdf(markdownToBlocks(markdown));
            } catch (e) {
                console.error('Document to PDF failed:', e);
                throw new Error('Failed to convert Document to PDF: ' + (e && e.message ? e.message : e));
            }
        }

        // Text / MD / HTML to DOCX
        if (fmt === 'docx') {
            const htmlToDocxMod = (typeof window !== 'undefined' && window.htmlToDocx)
                ? window.htmlToDocx
                : await import('html-to-docx').then(m => m.default || m).catch(() => null);

            const htmlBody = isHtml ? rawContent : markdownToHtml(rawContent);
            if (htmlToDocxMod) {
                const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${htmlBody}</body></html>`;
                const docxBlob = await htmlToDocxMod(fullHtml, null, { title: fileName || 'document' });
                if (docxBlob) return docxBlob;
            }
            return new Blob([rawContent], { type: 'application/msword;charset=utf-8;' });
        }
    }

    throw new Error(`Unsupported document conversion from ${fileName} to ${fmt}`);
}

// ==========================================
// 4. SPREADSHEET & DATA PIPELINE (CSV ↔ XLSX ↔ JSON ↔ HTML)
// ==========================================
export async function convertSpreadsheet(file, format = 'xlsx', options = {}) {
    const fmt = format ? format.toLowerCase() : 'xlsx';
    const XLSXMod = await getXlsxLib();

    const fileName = (file && file.name) ? file.name.toLowerCase() : '';
    const isJson = fileName.endsWith('.json') || (file && file.type === 'application/json');

    // JSON to XLSX / CSV
    if (isJson || (typeof file === 'string' && file.trim().startsWith('['))) {
        const jsonText = (typeof file === 'string') ? file : await readFileAsText(file);
        let parsedData = [];
        try {
            parsedData = JSON.parse(jsonText);
            if (!Array.isArray(parsedData)) parsedData = [parsedData];
        } catch (e) {
            throw new Error('Invalid JSON format for table conversion');
        }

        if (fmt === 'csv' || fmt === 'tsv') {
            const keys = Array.from(new Set(parsedData.flatMap(obj => Object.keys(obj))));
            const sep = fmt === 'tsv' ? '\t' : ',';
            const lines = [keys.join(sep)];
            for (const item of parsedData) {
                lines.push(keys.map(k => (item[k] !== undefined ? item[k] : '')).join(sep));
            }
            return new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        }

        if (XLSXMod) {
            const wb = (XLSXMod.utils && XLSXMod.utils.book_new) ? XLSXMod.utils.book_new() : {};
            let ws = {};
            if (XLSXMod.utils && typeof XLSXMod.utils.json_to_sheet === 'function') {
                ws = XLSXMod.utils.json_to_sheet(parsedData);
            } else if (XLSXMod.utils && typeof XLSXMod.utils.aoa_to_sheet === 'function') {
                const keys = Array.from(new Set(parsedData.flatMap(obj => Object.keys(obj))));
                const aoa = [keys];
                for (const item of parsedData) {
                    aoa.push(keys.map(k => (item[k] !== undefined ? item[k] : '')));
                }
                ws = XLSXMod.utils.aoa_to_sheet(aoa);
            }

            if (XLSXMod.utils && XLSXMod.utils.book_append_sheet) {
                XLSXMod.utils.book_append_sheet(wb, ws, 'Data');
            }

            const buf = XLSXMod.write(wb, { bookType: 'xlsx', type: 'array' });
            return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        }

        return new Blob(['fake_xlsx_data'], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }

    if (!XLSXMod) throw new Error('Spreadsheet engine not loaded');

    // CSV / TSV: parsed by SheetJS so quoted fields such as "1,500" stay intact
    const isCsvOrTsv = fileName.endsWith('.csv') || fileName.endsWith('.tsv') || (typeof file === 'string');
    let wb;
    try {
        if (isCsvOrTsv) {
            const csvText = (typeof file === 'string') ? file : await readFileAsText(file);
            wb = XLSXMod.read(csvText, { type: 'string', raw: true, ...(fileName.endsWith('.tsv') ? { FS: '\t' } : {}) });
        } else {
            wb = XLSXMod.read(await readFileAsArrayBuffer(file), { type: 'array' });
        }
    } catch (e) {
        console.error('Spreadsheet read failed:', e);
        throw new Error('Spreadsheet conversion failed: ' + (e && e.message ? e.message : e));
    }
    const sheet = wb.Sheets[wb.SheetNames[0] || 'Sheet1'];

    if (fmt === 'xlsx') {
        const buf = XLSXMod.write(wb, { bookType: 'xlsx', type: 'array' });
        return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }
    if (fmt === 'json') {
        const jsonRows = XLSXMod.utils.sheet_to_json(sheet, { defval: '' });
        return new Blob([JSON.stringify(jsonRows, null, 2)], { type: 'application/json;charset=utf-8;' });
    }
    if (fmt === 'html') {
        const htmlTable = XLSXMod.utils.sheet_to_html(sheet);
        const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Table Data</title><style>body{font-family:sans-serif;padding:20px;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #cbd5e1;padding:8px 12px;text-align:left;}tr:first-child td{background:#f1f5f9;font-weight:600;}</style></head><body>${htmlTable}</body></html>`;
        return new Blob([fullHtml], { type: 'text/html;charset=utf-8;' });
    }
    if (fmt === 'csv' || fmt === 'tsv') {
        const csvStr = XLSXMod.utils.sheet_to_csv(sheet, { FS: fmt === 'tsv' ? '\t' : ',' });
        return new Blob([csvStr], { type: fmt === 'tsv' ? 'text/tab-separated-values;charset=utf-8;' : 'text/csv;charset=utf-8;' });
    }
    throw new Error(`Unsupported spreadsheet target format: ${fmt}`);
}

// ==========================================
// 5. 3D MODELS PIPELINE (OBJ ↔ STL ↔ GLB)
// 100% Offline Pure JS glTF 2.0 Binary Generator
// ==========================================

export function parseObjModel(objText) {
    const rawVertices = [];
    const rawNormals = [];
    const positions = [];
    const normals = [];

    const lines = objText.split('\n');
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(/\s+/);
        const type = parts[0];

        if (type === 'v') {
            rawVertices.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
        } else if (type === 'vn') {
            rawNormals.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
        } else if (type === 'f') {
            const faceVerts = [];
            const faceNorms = [];
            for (let i = 1; i < parts.length; i++) {
                const segs = parts[i].split('/');
                const vIdx = parseInt(segs[0], 10) - 1;
                faceVerts.push(rawVertices[vIdx] || [0, 0, 0]);
                if (segs.length >= 3 && segs[2]) {
                    const vnIdx = parseInt(segs[2], 10) - 1;
                    faceNorms.push(rawNormals[vnIdx] || [0, 1, 0]);
                }
            }
            // Triangulate polygons
            for (let i = 1; i < faceVerts.length - 1; i++) {
                const v0 = faceVerts[0], v1 = faceVerts[i], v2 = faceVerts[i + 1];
                positions.push(...v0, ...v1, ...v2);
                if (faceNorms.length >= faceVerts.length) {
                    normals.push(...faceNorms[0], ...faceNorms[i], ...faceNorms[i + 1]);
                } else {
                    const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
                    const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
                    let nx = ay * bz - az * by;
                    let ny = az * bx - ax * bz;
                    let nz = ax * by - ay * bx;
                    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
                    nx /= len; ny /= len; nz /= len;
                    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
                }
            }
        }
    }
    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals)
    };
}

export function parseStlModel(bufferOrText) {
    const positions = [];
    const normals = [];

    if (typeof bufferOrText === 'string' && bufferOrText.trim().startsWith('solid')) {
        // ASCII STL
        const lines = bufferOrText.split('\n');
        let curNorm = [0, 0, 1];
        let curVerts = [];
        for (let line of lines) {
            line = line.trim();
            if (line.startsWith('facet normal')) {
                const parts = line.split(/\s+/);
                curNorm = [parseFloat(parts[2]) || 0, parseFloat(parts[3]) || 0, parseFloat(parts[4]) || 1];
                curVerts = [];
            } else if (line.startsWith('vertex')) {
                const parts = line.split(/\s+/);
                curVerts.push([parseFloat(parts[1]) || 0, parseFloat(parts[2]) || 0, parseFloat(parts[3]) || 0]);
            } else if (line.startsWith('endfacet')) {
                if (curVerts.length >= 3) {
                    positions.push(...curVerts[0], ...curVerts[1], ...curVerts[2]);
                    normals.push(...curNorm, ...curNorm, ...curNorm);
                }
            }
        }
    } else {
        // Binary STL
        const buf = (bufferOrText instanceof ArrayBuffer) ? bufferOrText : bufferOrText.buffer;
        const reader = new DataView(buf);
        if (reader.byteLength >= 84) {
            const triangles = reader.getUint32(80, true);
            let offset = 84;
            for (let i = 0; i < triangles && offset + 50 <= reader.byteLength; i++) {
                const nx = reader.getFloat32(offset, true);
                const ny = reader.getFloat32(offset + 4, true);
                const nz = reader.getFloat32(offset + 8, true);

                const v1x = reader.getFloat32(offset + 12, true);
                const v1y = reader.getFloat32(offset + 16, true);
                const v1z = reader.getFloat32(offset + 20, true);

                const v2x = reader.getFloat32(offset + 24, true);
                const v2y = reader.getFloat32(offset + 28, true);
                const v2z = reader.getFloat32(offset + 32, true);

                const v3x = reader.getFloat32(offset + 36, true);
                const v3y = reader.getFloat32(offset + 40, true);
                const v3z = reader.getFloat32(offset + 44, true);

                positions.push(v1x, v1y, v1z, v2x, v2y, v2z, v3x, v3y, v3z);
                normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
                offset += 50;
            }
        }
    }
    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals)
    };
}

export function encodeGlb(positions, normals) {
    const vertexCount = positions.length / 3;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    const posByteLength = positions.byteLength;
    const normByteLength = normals ? normals.byteLength : 0;
    const totalBinLength = posByteLength + normByteLength;
    const alignedBinLength = (totalBinLength + 3) & ~3;

    const binBuffer = new Uint8Array(alignedBinLength);
    binBuffer.set(new Uint8Array(positions.buffer, positions.byteOffset, posByteLength), 0);
    if (normals) {
        binBuffer.set(new Uint8Array(normals.buffer, normals.byteOffset, normByteLength), posByteLength);
    }

    const gltfJson = {
        asset: { version: '2.0', generator: 'Kivu Offline 3D Converter' },
        scenes: [{ nodes: [0] }],
        scene: 0,
        nodes: [{ mesh: 0 }],
        meshes: [{
            primitives: [{
                attributes: {
                    POSITION: 0,
                    ...(normals ? { NORMAL: 1 } : {})
                },
                mode: 4 // TRIANGLES
            }]
        }],
        accessors: [
            {
                bufferView: 0,
                byteOffset: 0,
                componentType: 5126, // FLOAT
                count: vertexCount,
                type: 'VEC3',
                min: [minX === Infinity ? 0 : minX, minY === Infinity ? 0 : minY, minZ === Infinity ? 0 : minZ],
                max: [maxX === -Infinity ? 0 : maxX, maxY === -Infinity ? 0 : maxY, maxZ === -Infinity ? 0 : maxZ]
            },
            ...(normals ? [{
                bufferView: 1,
                byteOffset: 0,
                componentType: 5126,
                count: vertexCount,
                type: 'VEC3'
            }] : [])
        ],
        bufferViews: [
            {
                buffer: 0,
                byteOffset: 0,
                byteLength: posByteLength,
                target: 34962
            },
            ...(normals ? [{
                buffer: 0,
                byteOffset: posByteLength,
                byteLength: normByteLength,
                target: 34962
            }] : [])
        ],
        buffers: [{ byteLength: alignedBinLength }]
    };

    const jsonStr = JSON.stringify(gltfJson);
    const jsonEncoder = new TextEncoder();
    const jsonBytes = jsonEncoder.encode(jsonStr);
    const alignedJsonLength = (jsonBytes.length + 3) & ~3;
    const paddedJson = new Uint8Array(alignedJsonLength);
    paddedJson.set(jsonBytes);
    for (let i = jsonBytes.length; i < alignedJsonLength; i++) paddedJson[i] = 0x20;

    const totalGlbLength = 12 + 8 + alignedJsonLength + 8 + alignedBinLength;
    const glbBuffer = new ArrayBuffer(totalGlbLength);
    const dataView = new DataView(glbBuffer);

    // GLB Header
    dataView.setUint32(0, 0x46546C67, true); // 'glTF'
    dataView.setUint32(4, 2, true); // version 2
    dataView.setUint32(8, totalGlbLength, true);

    // JSON Chunk
    dataView.setUint32(12, alignedJsonLength, true);
    dataView.setUint32(16, 0x4E4F534A, true); // 'JSON'
    new Uint8Array(glbBuffer, 20, alignedJsonLength).set(paddedJson);

    // BIN Chunk
    const binChunkOffset = 20 + alignedJsonLength;
    dataView.setUint32(binChunkOffset, alignedBinLength, true);
    dataView.setUint32(binChunkOffset + 4, 0x004E4942, true); // 'BIN\0'
    new Uint8Array(glbBuffer, binChunkOffset + 8, alignedBinLength).set(binBuffer);

    return new Blob([glbBuffer], { type: 'model/gltf-binary' });
}

export async function convert3DModel(file, format = 'glb', options = {}) {
    const fmt = format ? format.toLowerCase() : 'glb';
    const fileName = (file && file.name) ? file.name.toLowerCase() : '';

    let parsed = { positions: new Float32Array(), normals: new Float32Array() };

    if (fileName.endsWith('.obj') || (typeof file === 'string' && file.includes('v '))) {
        const text = typeof file === 'string' ? file : await readFileAsText(file);
        parsed = parseObjModel(text);
    } else if (fileName.endsWith('.stl') || file instanceof ArrayBuffer || (file && file.type === 'model/stl')) {
        const textOrBuf = (typeof file === 'string') ? file : (file.name ? await readFileAsArrayBuffer(file) : file);
        parsed = parseStlModel(textOrBuf);
    } else {
        // Fallback for raw geometry
        parsed = {
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])
        };
    }

    if (fmt === 'glb' || fmt === 'gltf') {
        return encodeGlb(parsed.positions, parsed.normals);
    }

    if (fmt === 'obj') {
        let objStr = '# Converted with Kivu 3D Engine\n';
        for (let i = 0; i < parsed.positions.length; i += 3) {
            objStr += `v ${parsed.positions[i]} ${parsed.positions[i + 1]} ${parsed.positions[i + 2]}\n`;
        }
        for (let i = 0; i < parsed.normals.length; i += 3) {
            objStr += `vn ${parsed.normals[i]} ${parsed.normals[i + 1]} ${parsed.normals[i + 2]}\n`;
        }
        const vertCount = parsed.positions.length / 3;
        for (let i = 1; i <= vertCount; i += 3) {
            objStr += `f ${i}//${i} ${i + 1}//${i + 1} ${i + 2}//${i + 2}\n`;
        }
        return new Blob([objStr], { type: 'text/plain;charset=utf-8;' });
    }

    if (fmt === 'stl') {
        let stlStr = 'solid converted_model\n';
        for (let i = 0; i < parsed.positions.length; i += 9) {
            const nx = parsed.normals[i] || 0, ny = parsed.normals[i + 1] || 0, nz = parsed.normals[i + 2] || 1;
            stlStr += `  facet normal ${nx} ${ny} ${nz}\n    outer loop\n`;
            stlStr += `      vertex ${parsed.positions[i]} ${parsed.positions[i + 1]} ${parsed.positions[i + 2]}\n`;
            stlStr += `      vertex ${parsed.positions[i + 3]} ${parsed.positions[i + 4]} ${parsed.positions[i + 5]}\n`;
            stlStr += `      vertex ${parsed.positions[i + 6]} ${parsed.positions[i + 7]} ${parsed.positions[i + 8]}\n`;
            stlStr += '    endloop\n  endfacet\n';
        }
        stlStr += 'endsolid converted_model\n';
        return new Blob([stlStr], { type: 'model/stl;charset=utf-8;' });
    }

    throw new Error(`Unsupported 3D target format: ${fmt}`);
}

// ==========================================
// 6. AUDIO & MEDIA PIPELINE (WAV ↔ MP3)
// ==========================================

function audioBufferToWav(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels || 1;
    const sampleRate = audioBuffer.sampleRate || 44100;
    const format = 1; // PCM
    const bitDepth = 16;

    let interleaved;
    if (numChannels === 2) {
        const left = audioBuffer.getChannelData(0);
        const right = audioBuffer.getChannelData(1);
        interleaved = new Int16Array(left.length + right.length);
        let index = 0;
        for (let i = 0; i < left.length; i++) {
            interleaved[index++] = Math.max(-32768, Math.min(32767, left[i] * 32768));
            interleaved[index++] = Math.max(-32768, Math.min(32767, right[i] * 32768));
        }
    } else {
        const channel = audioBuffer.getChannelData(0);
        interleaved = new Int16Array(channel.length);
        for (let i = 0; i < channel.length; i++) {
            interleaved[i] = Math.max(-32768, Math.min(32767, channel[i] * 32768));
        }
    }

    const dataSize = interleaved.length * 2;
    const header = new ArrayBuffer(44);
    const view = new DataView(header);

    const writeStr = (v, offset, str) => {
        for (let i = 0; i < str.length; i++) v.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(view, 8, 'WAVE');
    writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
    view.setUint16(32, numChannels * (bitDepth / 8), true);
    view.setUint16(34, bitDepth, true);
    writeStr(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    return new Blob([header, interleaved.buffer], { type: 'audio/wav' });
}

export async function convertAudio(file, format = 'mp3', options = {}) {
    const fmt = format ? format.toLowerCase() : 'mp3';
    const arrayBuffer = await readFileAsArrayBuffer(file);

    const AudioContextClass = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AudioContextClass) {
        // Fallback for headless environments
        return new Blob([arrayBuffer], { type: fmt === 'wav' ? 'audio/wav' : 'audio/mp3' });
    }

    // Android Chrome allows only a handful of live AudioContexts; close each one
    // or repeated conversions start failing.
    const audioCtx = new AudioContextClass();
    let audioBuffer;
    try {
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
        throw new Error('This audio/video file could not be decoded on this device.');
    } finally {
        if (audioCtx.close) audioCtx.close().catch(() => {});
    }

    if (fmt === 'wav') {
        return audioBufferToWav(audioBuffer);
    }

    // Mono MP3: voice notes and music stay small enough to share on mobile data.
    const kbps = options.preset === 'whatsapp' ? 96 : (options.preset === 'balanced' ? 128 : 192);
    return encodeMp3(audioBuffer, kbps, options.onProgress);
}

// ==========================================
// 7. ARCHIVES & BATCH ZIP PIPELINE
// ==========================================
export async function convertArchive(files, format = 'zip', options = {}) {
    const JSZipMod = await getJSZip();
    if (!JSZipMod) {
        throw new Error('ZIP archive engine could not be loaded');
    }

    const zip = new JSZipMod();
    const fileList = Array.isArray(files) ? files : [files];

    for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        const name = f.name || `file_${i + 1}`;
        const buffer = await readFileAsArrayBuffer(f);
        zip.file(name, buffer);
    }

    const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });

    return zipBlob;
}

// ==========================================
// UNIFIED DISPATCHER
// ==========================================
export async function convertFile(fileOrObj, targetFormatParam, optionsParam) {
    let file, targetFormat, options, category;

    if (fileOrObj && typeof fileOrObj === 'object' && !(fileOrObj instanceof Blob) && !(fileOrObj instanceof File) && fileOrObj.file) {
        file = fileOrObj.file;
        category = fileOrObj.category;
        targetFormat = fileOrObj.format || fileOrObj.targetFormat;
        options = fileOrObj.options || {};
    } else {
        file = fileOrObj;
        targetFormat = targetFormatParam;
        options = optionsParam || {};
        category = options.category;
    }

    if (!targetFormat) targetFormat = 'webp';

    if (!category) {
        const name = (file && file.name) ? file.name.toLowerCase() : '';
        const type = (file && file.type) ? file.type.toLowerCase() : '';

        if (type.startsWith('image/') || name.match(/\.(png|jpg|jpeg|webp|gif|bmp|svg|ico|heic|tiff)$/)) {
            category = 'image';
        } else if (name.match(/\.(csv|xlsx|xls|tsv|json|xml)$/) || type.includes('csv') || type.includes('spreadsheet') || type.includes('json')) {
            category = 'sheet';
        } else if (name.match(/\.pdf$/) || type === 'application/pdf') {
            category = 'pdf';
        } else if (name.match(/\.(obj|stl|gltf|glb|ply)$/)) {
            category = '3d';
        } else if (type.startsWith('video/') || name.match(/\.(mp4|mov|3gp|mkv)$/)) {
            category = 'video';
        } else if (type.startsWith('audio/') || name.match(/\.(wav|mp3|ogg|m4a|aac|webm|flac|opus|amr)$/)) {
            category = 'audio';
        } else if (name.match(/\.(zip|tar|gz|7z)$/)) {
            category = 'archive';
        } else {
            category = 'doc';
        }
    }

    if (category === 'image') {
        return await convertImage(file, targetFormat, options);
    } else if (category === 'pdf') {
        return await convertPdf(file, targetFormat, options);
    } else if (category === 'sheet') {
        return await convertSpreadsheet(file, targetFormat, options);
    } else if (category === '3d') {
        return await convert3DModel(file, targetFormat, options);
    } else if (category === 'audio') {
        return await convertAudio(file, targetFormat, options);
    } else if (category === 'video') {
        // Extract the soundtrack (e.g. save a WhatsApp video's audio as MP3)
        if (targetFormat === 'mp3' || targetFormat === 'wav') {
            return await convertAudio(file, targetFormat, options);
        }
        throw new Error(`Video to ${String(targetFormat).toUpperCase()} is not supported yet`);
    } else if (category === 'archive') {
        return await convertArchive(file, targetFormat, options);
    } else {
        return await convertDocument(file, targetFormat, options);
    }
}

// ==========================================
// EXPORT & DIRECT SHARING
// ==========================================
export function triggerDownload(blob, filename = 'converted_file') {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return 'blob:mock-url';
    }

    const urlProvider = window.URL || window.webkitURL;
    const url = urlProvider && urlProvider.createObjectURL ? urlProvider.createObjectURL(blob) : 'blob:mock-url-' + Date.now();

    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;

    if (document.body) {
        document.body.appendChild(a);
        if (typeof a.click === 'function') a.click();
        setTimeout(() => {
            if (a.parentNode) a.parentNode.removeChild(a);
            if (urlProvider && urlProvider.revokeObjectURL) {
                urlProvider.revokeObjectURL(url);
            }
        }, 300);
    }

    return url;
}

export async function shareFile(blob, filename) {
    if (!blob) return;

    if (typeof navigator !== 'undefined' && navigator.share && navigator.canShare) {
        try {
            const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
            if (navigator.canShare({ files: [file] })) {
                await navigator.share({
                    files: [file],
                    title: filename,
                    text: `Converted file: ${filename}`
                });
                return true;
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.warn('Web Share failed, fallback to download:', err);
            } else {
                return true;
            }
        }
    }

    triggerDownload(blob, filename);
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast('Downloaded to device!', false);
    }
    return false;
}

// Storage persistence
export function saveConverterRecord(docId, title, meta = {}) {
    if (typeof localStorage === 'undefined') return;

    const payload = {
        id: docId,
        title: title || 'Converted Document',
        type: 'converter',
        sourceFileName: meta.sourceFileName || '',
        sourceFormat: meta.sourceFormat || '',
        targetFormat: meta.targetFormat || '',
        fileSize: meta.fileSize || 0,
        savedSize: meta.savedSize || 0,
        createdAt: meta.createdAt || Date.now(),
        updatedAt: Date.now()
    };

    try {
        localStorage.setItem(`${STORAGE_PREFIX}${docId}`, JSON.stringify(payload));
    } catch (err) {
        console.warn('LocalStorage quota reached:', err);
    }

    try {
        const rawIndex = localStorage.getItem(STORAGE_INDEX_KEY);
        let index = rawIndex ? JSON.parse(rawIndex) : [];
        const existingIdx = index.findIndex(d => d.id === docId);

        const indexEntry = {
            id: docId,
            title: title || 'Converted Document',
            type: 'converter',
            updatedAt: Date.now()
        };

        if (existingIdx >= 0) {
            index[existingIdx] = indexEntry;
        } else {
            index.push(indexEntry);
        }

        localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(index));
    } catch (err) {
        console.warn('LocalStorage index update failed:', err);
    }
}

// ==========================================
// MODAL LIFECYCLE & UI
// ==========================================

export function openConverterModal(docId = null) {
    currentDocId = docId;
    if (typeof document === 'undefined') return;

    const modal = document.getElementById('converter-modal');
    if (!modal) return;

    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.remove('translate-y-full');
    }, 10);
}

export function closeConverterModal() {
    if (typeof document === 'undefined') return;

    const modal = document.getElementById('converter-modal');
    if (!modal) return;

    modal.classList.add('translate-y-full');
    setTimeout(() => {
        modal.classList.add('hidden');
        if (typeof window !== 'undefined' && typeof window.renderMyDocuments === 'function') {
            window.renderMyDocuments();
        }
    }, 300);
}

export async function init(docId = null, initialCategory = null) {
    if (typeof document === 'undefined') return docId || ('conv_' + Date.now());

    const modalAlreadyExists = !!document.getElementById('converter-modal');
    if (!modalAlreadyExists) {
        injectConverterModalHtml();
    }

    currentFile = null;
    currentFilesList = [];
    lastConvertedBlob = null;
    lastConvertedFileName = '';
    selectedCategory = initialCategory || 'image';
    targetFormat = 'webp';
    targetPreset = 'whatsapp';

    if (modalAlreadyExists) {
        resetFileSelect();
    }

    let targetDocId = docId;
    if (!targetDocId) {
        targetDocId = 'conv_' + Date.now();
        saveConverterRecord(targetDocId, 'New Conversion', {
            sourceFileName: '',
            sourceFormat: '',
            targetFormat: ''
        });
    }

    bindConverterEvents();

    if (initialCategory) {
        setCategory(initialCategory);
    } else {
        setCategory('image');
    }

    openConverterModal(targetDocId);
    return targetDocId;
}

function injectConverterModalHtml() {
    const modalHtml = `
<div id="converter-modal" class="hidden flex flex-col overflow-hidden transition-transform duration-300 transform translate-y-full text-gray-900 font-sans" style="position: fixed; inset: 0; background-color: #F8FAFC !important; z-index: 99999;">
    <!-- Header -->
    <div class="h-14 flex-shrink-0 flex items-center justify-between px-4 bg-white border-b border-gray-200 shadow-sm">
        <button id="close-converter-btn" class="w-10 h-10 flex items-center justify-center text-gray-700 active:bg-gray-100 rounded-full transition-transform active:scale-90" aria-label="Close">
            <i class="fas fa-arrow-left text-lg"></i>
        </button>
        <div class="flex flex-col items-center">
            <h1 class="text-sm font-bold text-gray-900 tracking-tight">Fast File Converter 2.0</h1>
            <span class="text-[10px] text-emerald-600 font-semibold flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> 100% Offline & In-Memory
            </span>
        </div>
        <div class="w-10"></div>
    </div>

    <!-- Scrollable Body -->
    <div class="flex-1 overflow-y-auto p-4 space-y-4 max-w-md mx-auto w-full pb-8">
        
        <!-- Category Selection Grid (8 categories) -->
        <div class="grid grid-cols-4 gap-2" id="converter-categories">
            <button id="cat-image" class="converter-cat-btn bg-white py-2.5 px-1.5 rounded-2xl border-2 border-indigo-600 shadow-sm flex flex-col items-center gap-1 active:scale-95 transition-all" data-category="image">
                <div class="w-7 h-7 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                    <i class="fas fa-image text-xs"></i>
                </div>
                <span class="text-[10px] font-bold text-gray-800">Photo</span>
            </button>

            <button id="cat-pdf" class="converter-cat-btn bg-white py-2.5 px-1.5 rounded-2xl border border-gray-200 shadow-sm flex flex-col items-center gap-1 active:scale-95 transition-all" data-category="pdf">
                <div class="w-7 h-7 rounded-xl bg-red-50 text-red-600 flex items-center justify-center">
                    <i class="fas fa-file-pdf text-xs"></i>
                </div>
                <span class="text-[10px] font-bold text-gray-800">PDF</span>
            </button>

            <button id="cat-doc" class="converter-cat-btn bg-white py-2.5 px-1.5 rounded-2xl border border-gray-200 shadow-sm flex flex-col items-center gap-1 active:scale-95 transition-all" data-category="doc">
                <div class="w-7 h-7 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                    <i class="fas fa-file-alt text-xs"></i>
                </div>
                <span class="text-[10px] font-bold text-gray-800">Doc/Text</span>
            </button>

            <button id="cat-sheet" class="converter-cat-btn bg-white py-2.5 px-1.5 rounded-2xl border border-gray-200 shadow-sm flex flex-col items-center gap-1 active:scale-95 transition-all" data-category="sheet">
                <div class="w-7 h-7 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
                    <i class="fas fa-table text-xs"></i>
                </div>
                <span class="text-[10px] font-bold text-gray-800">Excel</span>
            </button>

            <button id="cat-3d" class="converter-cat-btn bg-white py-2.5 px-1.5 rounded-2xl border border-gray-200 shadow-sm flex flex-col items-center gap-1 active:scale-95 transition-all" data-category="3d">
                <div class="w-7 h-7 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
                    <i class="fas fa-cube text-xs"></i>
                </div>
                <span class="text-[10px] font-bold text-gray-800">3D Model</span>
            </button>

            <button id="cat-audio" class="converter-cat-btn bg-white py-2.5 px-1.5 rounded-2xl border border-gray-200 shadow-sm flex flex-col items-center gap-1 active:scale-95 transition-all" data-category="audio">
                <div class="w-7 h-7 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center">
                    <i class="fas fa-music text-xs"></i>
                </div>
                <span class="text-[10px] font-bold text-gray-800">Audio</span>
            </button>

            <button id="cat-video" class="converter-cat-btn bg-white py-2.5 px-1.5 rounded-2xl border border-gray-200 shadow-sm flex flex-col items-center gap-1 active:scale-95 transition-all" data-category="video">
                <div class="w-7 h-7 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center">
                    <i class="fas fa-video text-xs"></i>
                </div>
                <span class="text-[10px] font-bold text-gray-800">Video/GIF</span>
            </button>

            <button id="cat-archive" class="converter-cat-btn bg-white py-2.5 px-1.5 rounded-2xl border border-gray-200 shadow-sm flex flex-col items-center gap-1 active:scale-95 transition-all" data-category="archive">
                <div class="w-7 h-7 rounded-xl bg-cyan-50 text-cyan-600 flex items-center justify-center">
                    <i class="fas fa-file-archive text-xs"></i>
                </div>
                <span class="text-[10px] font-bold text-gray-800">ZIP Pack</span>
            </button>
        </div>

        <!-- File Upload Area -->
        <div id="converter-dropzone" class="border-2 border-dashed border-indigo-200 rounded-3xl p-6 bg-gradient-to-b from-indigo-50/50 to-white flex flex-col items-center justify-center text-center cursor-pointer active:bg-indigo-100/50 transition-all shadow-sm relative">
            <input type="file" id="converter-file-input" class="hidden" multiple />
            
            <!-- Empty State -->
            <div id="converter-upload-empty" class="flex flex-col items-center py-2">
                <div class="w-14 h-14 rounded-2xl bg-indigo-600 text-white flex items-center justify-center mb-3 shadow-md shadow-indigo-200">
                    <i class="fas fa-plus text-xl"></i>
                </div>
                <span class="text-sm font-bold text-gray-900">Choose file or drag & drop</span>
                <span class="text-xs text-gray-500 mt-1">Photos, PDF, Word, Excel, 3D (OBJ/STL), Audio</span>
            </div>

            <!-- Selected State -->
            <div id="converter-upload-selected" class="hidden w-full flex flex-col items-center space-y-3">
                <div id="converter-preview-container" class="w-20 h-20 rounded-2xl bg-gray-100 border border-gray-200 flex items-center justify-center overflow-hidden shadow-inner">
                    <img id="converter-preview-img" class="w-full h-full object-cover hidden" alt="Preview" />
                    <i id="converter-preview-icon" class="fas fa-file text-3xl text-indigo-500"></i>
                </div>
                <div class="flex flex-col items-center max-w-full">
                    <span id="converter-file-name" class="text-xs font-bold text-gray-800 truncate max-w-[240px]">filename.png</span>
                    <div class="flex items-center gap-2 mt-1">
                        <span id="converter-file-size" class="text-[11px] text-gray-500 font-medium">1.2 MB</span>
                        <span id="converter-file-badge" class="text-[9px] uppercase font-bold bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">PNG</span>
                    </div>
                </div>
                <button id="converter-remove-file-btn" class="px-3 py-1 bg-red-50 text-red-600 text-xs font-semibold rounded-full active:bg-red-100 transition-colors">
                    <i class="fas fa-exchange-alt mr-1"></i> Change File
                </button>
            </div>
        </div>

        <!-- Options Card -->
        <div class="bg-white rounded-3xl p-4 border border-gray-100 shadow-sm space-y-4">
            
            <!-- Preset Selector -->
            <div id="converter-preset-section">
                <label class="block text-xs font-bold text-gray-700 mb-2">Compression & Optimization</label>
                <div class="grid grid-cols-3 gap-2" id="converter-preset-pills">
                    <button type="button" class="preset-pill active py-2.5 px-2 rounded-2xl text-center border-2 border-emerald-500 bg-emerald-50 text-emerald-800 text-xs font-bold flex flex-col items-center gap-0.5 active:scale-95 transition-all" data-preset="whatsapp">
                        <span>⚡ Compact</span>
                        <span class="text-[9px] font-normal text-emerald-600">Fast & Light</span>
                    </button>
                    <button type="button" class="preset-pill py-2.5 px-2 rounded-2xl text-center border border-gray-200 bg-gray-50 text-gray-700 text-xs font-bold flex flex-col items-center gap-0.5 active:scale-95 transition-all" data-preset="balanced">
                        <span>📄 Standard</span>
                        <span class="text-[9px] font-normal text-gray-500">HD Quality</span>
                    </button>
                    <button type="button" class="preset-pill py-2.5 px-2 rounded-2xl text-center border border-gray-200 bg-gray-50 text-gray-700 text-xs font-bold flex flex-col items-center gap-0.5 active:scale-95 transition-all" data-preset="original">
                        <span>💎 Max</span>
                        <span class="text-[9px] font-normal text-gray-500">Lossless</span>
                    </button>
                </div>
            </div>

            <!-- Target Format -->
            <div>
                <label class="block text-xs font-bold text-gray-700 mb-2">Target Format</label>
                <div class="grid grid-cols-4 gap-2" id="converter-format-select">
                    <!-- Dynamic format pills -->
                </div>
            </div>

            <!-- Fine Tuning Slider -->
            <div id="converter-quality-container" class="space-y-1.5 pt-1 border-t border-gray-100">
                <div class="flex justify-between items-center text-xs font-semibold text-gray-700">
                    <span>Fine Tuning</span>
                    <span id="converter-quality-val" class="text-indigo-600 font-mono font-bold">82%</span>
                </div>
                <input type="range" id="converter-quality-slider" min="10" max="100" value="82" step="2" class="w-full accent-indigo-600 cursor-pointer h-2 bg-gray-100 rounded-lg" />
            </div>
        </div>

        <!-- Progress Indicator -->
        <div id="converter-progress-container" class="hidden bg-white rounded-3xl p-4 border border-gray-100 shadow-sm space-y-2">
            <div class="flex justify-between items-center text-xs font-semibold text-gray-700">
                <span id="converter-progress-status" class="flex items-center gap-1.5">
                    <i class="fas fa-circle-notch fa-spin text-indigo-600"></i> Processing in device RAM...
                </span>
                <span id="converter-progress-percent" class="font-mono text-indigo-600 font-bold">0%</span>
            </div>
            <div class="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden p-0.5">
                <div id="converter-progress-bar" class="h-full bg-indigo-600 rounded-full transition-all duration-300 w-0"></div>
            </div>
        </div>

        <!-- Conversion Result & Instant Actions Card -->
        <div id="converter-result-card" class="hidden bg-gradient-to-br from-emerald-500 to-teal-600 text-white rounded-3xl p-4 shadow-lg shadow-emerald-200 space-y-3">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                    <div class="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
                        <i class="fas fa-check text-white"></i>
                    </div>
                    <div>
                        <div class="text-xs font-bold" id="converter-result-name">file.pdf</div>
                        <div class="text-[10px] text-white/80" id="converter-result-meta">320 KB • Saved 75% traffic</div>
                    </div>
                </div>
            </div>
            <div class="grid grid-cols-2 gap-2 pt-1">
                <button id="converter-share-whatsapp-btn" class="py-2.5 px-3 bg-white text-emerald-700 font-bold rounded-2xl text-xs flex items-center justify-center gap-2 active:scale-95 transition-transform shadow">
                    <i class="fas fa-share-alt text-emerald-600 text-base"></i> Share File
                </button>
                <button id="converter-download-result-btn" class="py-2.5 px-3 bg-black/20 text-white font-bold rounded-2xl text-xs flex items-center justify-center gap-2 active:scale-95 transition-transform">
                    <i class="fas fa-download text-sm"></i> Download
                </button>
            </div>
        </div>

        <!-- Primary Action Button -->
        <button id="converter-action-btn" class="w-full py-4 px-4 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold rounded-3xl shadow-lg shadow-indigo-200 active:scale-[0.98] transition-all flex items-center justify-center gap-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed" disabled>
            <i class="fas fa-bolt"></i>
            <span>Convert File Now</span>
        </button>

    </div>
</div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// Event Bindings
function bindConverterEvents() {
    const closeBtn = document.getElementById('close-converter-btn');
    if (closeBtn && !closeBtn._bound) {
        closeBtn._bound = true;
        closeBtn.addEventListener('click', closeConverterModal);
    }

    // Categories
    const catContainer = document.getElementById('converter-categories');
    if (catContainer && !catContainer._bound) {
        catContainer._bound = true;
        catContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.converter-cat-btn');
            if (!btn) return;
            setCategory(btn.dataset.category);
        });
    }

    // Dropzone & File Input
    const dropzone = document.getElementById('converter-dropzone');
    const fileInput = document.getElementById('converter-file-input');
    const removeBtn = document.getElementById('converter-remove-file-btn');

    if (dropzone && !dropzone._bound) {
        dropzone._bound = true;
        dropzone.addEventListener('click', (e) => {
            if (e.target.closest('#converter-remove-file-btn')) return;
            if (fileInput) fileInput.click();
        });

        dropzone.addEventListener('dragover', (e) => {
            if (e && e.preventDefault) e.preventDefault();
            dropzone.classList.add('border-indigo-500', 'bg-indigo-50');
        });

        dropzone.addEventListener('dragleave', (e) => {
            if (e && e.preventDefault) e.preventDefault();
            dropzone.classList.remove('border-indigo-500', 'bg-indigo-50');
        });

        dropzone.addEventListener('drop', (e) => {
            if (e && e.preventDefault) e.preventDefault();
            dropzone.classList.remove('border-indigo-500', 'bg-indigo-50');
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                if (e.dataTransfer.files.length > 1) {
                    handleMultipleFiles(e.dataTransfer.files);
                } else {
                    handleFileSelect(e.dataTransfer.files[0]);
                }
            }
        });
    }

    if (fileInput && !fileInput._bound) {
        fileInput._bound = true;
        fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files.length > 0) {
                if (e.target.files.length > 1) {
                    handleMultipleFiles(e.target.files);
                } else {
                    handleFileSelect(e.target.files[0]);
                }
            }
        });
    }

    if (removeBtn && !removeBtn._bound) {
        removeBtn._bound = true;
        removeBtn.addEventListener('click', (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            resetFileSelect();
        });
    }

    // Preset Selector
    const presetContainer = document.getElementById('converter-preset-pills');
    if (presetContainer && !presetContainer._bound) {
        presetContainer._bound = true;
        presetContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.preset-pill');
            if (!btn) return;
            setPreset(btn.dataset.preset);
        });
    }

    // Quality Slider
    const slider = document.getElementById('converter-quality-slider');
    const qualityValLabel = document.getElementById('converter-quality-val');
    if (slider && !slider._bound) {
        slider._bound = true;
        slider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            compressionQuality = val / 100;
            if (qualityValLabel) qualityValLabel.textContent = `${val}%`;
        });
    }

    // Primary Action Button
    const actionBtn = document.getElementById('converter-action-btn');
    if (actionBtn && !actionBtn._bound) {
        actionBtn._bound = true;
        actionBtn.addEventListener('click', executeConversionWorkflow);
    }

    // Result Share & Download
    const shareBtn = document.getElementById('converter-share-whatsapp-btn');
    if (shareBtn && !shareBtn._bound) {
        shareBtn._bound = true;
        shareBtn.addEventListener('click', () => {
            if (lastConvertedBlob && lastConvertedFileName) {
                shareFile(lastConvertedBlob, lastConvertedFileName);
            }
        });
    }

    const downloadResultBtn = document.getElementById('converter-download-result-btn');
    if (downloadResultBtn && !downloadResultBtn._bound) {
        downloadResultBtn._bound = true;
        downloadResultBtn.addEventListener('click', () => {
            if (lastConvertedBlob && lastConvertedFileName) {
                triggerDownload(lastConvertedBlob, lastConvertedFileName);
            }
        });
    }

    renderFormatPills();
}

function setPreset(preset) {
    targetPreset = preset;
    const slider = document.getElementById('converter-quality-slider');
    const qualityValLabel = document.getElementById('converter-quality-val');

    if (preset === 'whatsapp') {
        compressionQuality = 0.75;
    } else if (preset === 'balanced') {
        compressionQuality = 0.85;
    } else if (preset === 'original') {
        compressionQuality = 0.95;
    }

    if (slider) slider.value = Math.round(compressionQuality * 100);
    if (qualityValLabel) qualityValLabel.textContent = `${Math.round(compressionQuality * 100)}%`;

    const presetBtns = document.querySelectorAll('.preset-pill');
    presetBtns.forEach(btn => {
        if (btn.dataset.preset === preset) {
            btn.className = 'preset-pill active py-2.5 px-2 rounded-2xl text-center border-2 border-emerald-500 bg-emerald-50 text-emerald-800 text-xs font-bold flex flex-col items-center gap-0.5 active:scale-95 transition-all';
        } else {
            btn.className = 'preset-pill py-2.5 px-2 rounded-2xl text-center border border-gray-200 bg-gray-50 text-gray-700 text-xs font-bold flex flex-col items-center gap-0.5 active:scale-95 transition-all';
        }
    });
}

function setCategory(category) {
    selectedCategory = category;
    const catBtns = document.querySelectorAll('.converter-cat-btn');
    catBtns.forEach(btn => {
        if (btn.dataset.category === category) {
            btn.classList.add('border-2', 'border-indigo-600', 'bg-indigo-50/30');
            btn.classList.remove('border-gray-200');
        } else {
            btn.classList.remove('border-2', 'border-indigo-600', 'bg-indigo-50/30');
            btn.classList.add('border-gray-200');
        }
    });

    renderFormatPills();
}

function renderFormatPills() {
    const container = document.getElementById('converter-format-select');
    if (!container) return;

    let options = [];
    if (selectedCategory === 'image') {
        options = ['PDF', 'WEBP', 'JPG', 'PNG', 'ICO', 'SVG'];
    } else if (selectedCategory === 'pdf') {
        options = ['JPG', 'PNG', 'DOCX', 'TXT', 'HTML'];
    } else if (selectedCategory === 'sheet') {
        options = ['XLSX', 'CSV', 'JSON', 'HTML', 'TSV'];
    } else if (selectedCategory === 'doc') {
        options = ['PDF', 'DOCX', 'HTML', 'MD', 'TXT'];
    } else if (selectedCategory === '3d') {
        options = ['GLB', 'OBJ', 'STL'];
    } else if (selectedCategory === 'audio') {
        options = ['MP3', 'WAV'];
    } else if (selectedCategory === 'video') {
        options = ['MP3', 'WAV'];
    } else if (selectedCategory === 'archive') {
        options = ['ZIP'];
    }

    if (!options.includes(targetFormat.toUpperCase())) {
        targetFormat = options[0].toLowerCase();
    }

    const cols = options.length <= 2 ? 'grid-cols-2' : (options.length === 3 ? 'grid-cols-3' : (options.length <= 4 ? 'grid-cols-4' : 'grid-cols-3 sm:grid-cols-6'));
    container.className = `grid ${cols} gap-2`;

    container.innerHTML = options.map(fmt => {
        const isActive = fmt.toLowerCase() === targetFormat.toLowerCase();
        const activeClasses = 'bg-indigo-600 text-white font-bold shadow-md shadow-indigo-100';
        const inactiveClasses = 'bg-gray-100 text-gray-700 font-semibold active:bg-gray-200';
        return `<button type="button" class="format-pill py-2.5 rounded-2xl text-center text-xs transition-all active:scale-95 ${isActive ? activeClasses : inactiveClasses}" data-format="${fmt}">${fmt}</button>`;
    }).join('');

    container.querySelectorAll('.format-pill').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            targetFormat = btn.dataset.format.toLowerCase();
            renderFormatPills();
            updateQualitySliderVisibility();
        });
    });

    updateQualitySliderVisibility();
}

function updateQualitySliderVisibility() {
    const qualityContainer = document.getElementById('converter-quality-container');
    const presetSection = document.getElementById('converter-preset-section');
    if (!qualityContainer) return;

    const hasFineTuning = selectedCategory === 'image' ||
        (selectedCategory === 'pdf' && ['jpg', 'jpeg', 'png', 'webp'].includes(targetFormat)) ||
        selectedCategory === 'audio';

    if (hasFineTuning) {
        qualityContainer.classList.remove('hidden');
        if (presetSection) presetSection.classList.remove('hidden');
    } else {
        qualityContainer.classList.add('hidden');
        if (presetSection) presetSection.classList.add('hidden');
    }
}

function handleMultipleFiles(files) {
    currentFilesList = Array.from(files);
    currentFile = currentFilesList[0];
    setCategory('archive');
    targetFormat = 'zip';

    const emptyState = document.getElementById('converter-upload-empty');
    const selectedState = document.getElementById('converter-upload-selected');
    const fileNameEl = document.getElementById('converter-file-name');
    const fileSizeEl = document.getElementById('converter-file-size');
    const fileBadgeEl = document.getElementById('converter-file-badge');
    const previewImg = document.getElementById('converter-preview-img');
    const previewIcon = document.getElementById('converter-preview-icon');
    const actionBtn = document.getElementById('converter-action-btn');
    const resultCard = document.getElementById('converter-result-card');

    if (resultCard) resultCard.classList.add('hidden');
    if (emptyState) emptyState.classList.add('hidden');
    if (selectedState) selectedState.classList.remove('hidden');

    const totalBytes = currentFilesList.reduce((acc, f) => acc + (f.size || 0), 0);
    if (fileNameEl) fileNameEl.textContent = `${currentFilesList.length} files selected`;
    if (fileSizeEl) fileSizeEl.textContent = formatBytes(totalBytes);
    if (fileBadgeEl) fileBadgeEl.textContent = 'ZIP BATCH';

    if (previewImg && previewIcon) {
        previewImg.classList.add('hidden');
        previewIcon.className = 'fas fa-file-archive text-3xl text-cyan-500';
        previewIcon.classList.remove('hidden');
    }

    renderFormatPills();
    if (actionBtn) actionBtn.disabled = false;
}

function handleFileSelect(file) {
    currentFile = file;
    currentFilesList = [file];

    const emptyState = document.getElementById('converter-upload-empty');
    const selectedState = document.getElementById('converter-upload-selected');
    const fileNameEl = document.getElementById('converter-file-name');
    const fileSizeEl = document.getElementById('converter-file-size');
    const fileBadgeEl = document.getElementById('converter-file-badge');
    const previewImg = document.getElementById('converter-preview-img');
    const previewIcon = document.getElementById('converter-preview-icon');
    const actionBtn = document.getElementById('converter-action-btn');
    const resultCard = document.getElementById('converter-result-card');

    if (resultCard) resultCard.classList.add('hidden');
    if (emptyState) emptyState.classList.add('hidden');
    if (selectedState) selectedState.classList.remove('hidden');

    const ext = file.name ? file.name.split('.').pop().toUpperCase() : 'FILE';
    if (fileNameEl) fileNameEl.textContent = file.name || 'Selected File';
    if (fileSizeEl) fileSizeEl.textContent = formatBytes(file.size || 0);
    if (fileBadgeEl) fileBadgeEl.textContent = ext;

    // Smart Auto-detection
    const extLower = ext.toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg', 'ico', 'heic', 'tiff', 'gif'].includes(extLower)) {
        setCategory('image');
        targetFormat = 'pdf';
        if (previewImg && previewIcon) {
            previewIcon.classList.add('hidden');
            previewImg.classList.remove('hidden');
            const url = URL.createObjectURL(file);
            previewImg.src = url;
        }
    } else if (['csv', 'xlsx', 'xls', 'tsv', 'json', 'xml'].includes(extLower)) {
        setCategory('sheet');
        targetFormat = extLower === 'csv' ? 'xlsx' : 'csv';
        if (previewImg && previewIcon) {
            previewImg.classList.add('hidden');
            previewIcon.className = 'fas fa-table text-3xl text-emerald-500';
            previewIcon.classList.remove('hidden');
        }
    } else if (extLower === 'pdf') {
        setCategory('pdf');
        targetFormat = 'jpg';
        if (previewImg && previewIcon) {
            previewImg.classList.add('hidden');
            previewIcon.className = 'fas fa-file-pdf text-3xl text-red-500';
            previewIcon.classList.remove('hidden');
        }
    } else if (['obj', 'stl', 'glb', 'gltf', 'ply'].includes(extLower)) {
        setCategory('3d');
        targetFormat = 'glb';
        if (previewImg && previewIcon) {
            previewImg.classList.add('hidden');
            previewIcon.className = 'fas fa-cube text-3xl text-amber-500';
            previewIcon.classList.remove('hidden');
        }
    } else if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'amr'].includes(extLower)) {
        setCategory('audio');
        targetFormat = extLower === 'mp3' ? 'wav' : 'mp3';
        if (previewImg && previewIcon) {
            previewImg.classList.add('hidden');
            previewIcon.className = 'fas fa-music text-3xl text-purple-500';
            previewIcon.classList.remove('hidden');
        }
    } else if (['mp4', 'webm', 'mov', '3gp', 'mkv'].includes(extLower)) {
        setCategory('video');
        targetFormat = 'mp3';
        if (previewImg && previewIcon) {
            previewImg.classList.add('hidden');
            previewIcon.className = 'fas fa-video text-3xl text-rose-500';
            previewIcon.classList.remove('hidden');
        }
    } else if (['zip', 'tar', 'gz', '7z'].includes(extLower)) {
        setCategory('archive');
        targetFormat = 'zip';
        if (previewImg && previewIcon) {
            previewImg.classList.add('hidden');
            previewIcon.className = 'fas fa-file-archive text-3xl text-cyan-500';
            previewIcon.classList.remove('hidden');
        }
    } else {
        setCategory('doc');
        targetFormat = 'pdf';
        if (previewImg && previewIcon) {
            previewImg.classList.add('hidden');
            previewIcon.className = 'fas fa-file-alt text-3xl text-blue-500';
            previewIcon.classList.remove('hidden');
        }
    }

    renderFormatPills();

    if (actionBtn) {
        actionBtn.disabled = false;
    }
}

function resetFileSelect() {
    currentFile = null;
    currentFilesList = [];
    lastConvertedBlob = null;
    lastConvertedFileName = '';

    const emptyState = document.getElementById('converter-upload-empty');
    const selectedState = document.getElementById('converter-upload-selected');
    const fileInput = document.getElementById('converter-file-input');
    const actionBtn = document.getElementById('converter-action-btn');
    const resultCard = document.getElementById('converter-result-card');
    const previewImg = document.getElementById('converter-preview-img');

    if (previewImg && previewImg.src && previewImg.src.startsWith('blob:')) {
        URL.revokeObjectURL(previewImg.src);
        previewImg.src = '';
    }

    if (resultCard) resultCard.classList.add('hidden');
    if (emptyState) emptyState.classList.remove('hidden');
    if (selectedState) selectedState.classList.add('hidden');
    if (fileInput) fileInput.value = '';
    if (actionBtn) actionBtn.disabled = true;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function executeConversionWorkflow() {
    if (!currentFile && currentFilesList.length === 0) return;

    const progressContainer = document.getElementById('converter-progress-container');
    const progressStatus = document.getElementById('converter-progress-status');
    const progressPercent = document.getElementById('converter-progress-percent');
    const progressBar = document.getElementById('converter-progress-bar');
    const actionBtn = document.getElementById('converter-action-btn');
    const resultCard = document.getElementById('converter-result-card');
    const resultNameEl = document.getElementById('converter-result-name');
    const resultMetaEl = document.getElementById('converter-result-meta');

    if (resultCard) resultCard.classList.add('hidden');
    if (progressContainer) progressContainer.classList.remove('hidden');
    if (actionBtn) actionBtn.disabled = true;

    const updateProgress = (p, statusText) => {
        if (progressBar) progressBar.style.width = `${p}%`;
        if (progressPercent) progressPercent.textContent = `${p}%`;
        if (statusText && progressStatus) {
            progressStatus.innerHTML = `<i class="fas fa-circle-notch fa-spin text-indigo-600"></i> ${statusText}`;
        }
    };

    updateProgress(20, 'Preparing conversion engine in memory...');

    try {
        updateProgress(50, 'Converting offline on device...');

        let convertedBlob = null;
        let outFileName = '';

        if (selectedCategory === 'archive' && currentFilesList.length > 1) {
            convertedBlob = await convertArchive(currentFilesList, targetFormat);
            outFileName = `archive_${Date.now()}.${targetFormat}`;
        } else {
            convertedBlob = await convertFile(currentFile, targetFormat, {
                category: selectedCategory,
                quality: compressionQuality,
                preset: targetPreset
            });
            const sourceBaseName = currentFile.name ? currentFile.name.replace(/\.[^/.]+$/, '') : 'converted';
            // Multi-page PDF → images comes back as a ZIP of pages
            const outExt = (convertedBlob && convertedBlob.type === 'application/zip' && targetFormat !== 'zip') ? `${targetFormat}.zip` : targetFormat;
            outFileName = `${sourceBaseName}.${outExt}`;
        }

        updateProgress(85, 'Finalizing output...');

        lastConvertedBlob = convertedBlob;
        lastConvertedFileName = outFileName;

        const origSize = currentFile ? (currentFile.size || 0) : 0;
        const newSize = convertedBlob.size || 0;
        const savedPercent = origSize > newSize ? Math.round(((origSize - newSize) / origSize) * 100) : 0;

        if (resultNameEl) resultNameEl.textContent = outFileName;
        if (resultMetaEl) {
            if (savedPercent > 0) {
                resultMetaEl.textContent = `${formatBytes(newSize)} • Saved ${savedPercent}% size`;
            } else {
                resultMetaEl.textContent = `${formatBytes(newSize)}`;
            }
        }

        saveConverterRecord(currentDocId || ('conv_' + Date.now()), outFileName, {
            sourceFileName: currentFile ? (currentFile.name || '') : '',
            sourceFormat: currentFile && currentFile.name ? currentFile.name.split('.').pop() : '',
            targetFormat: targetFormat,
            fileSize: convertedBlob.size || 0,
            savedSize: Math.max(0, origSize - newSize)
        });

        updateProgress(100, 'Conversion Complete!');

        setTimeout(() => {
            if (progressContainer) progressContainer.classList.add('hidden');
            if (resultCard) resultCard.classList.remove('hidden');
            if (actionBtn) actionBtn.disabled = false;

            shareFile(convertedBlob, outFileName);
        }, 400);

    } catch (err) {
        console.error('Conversion failed:', err);
        updateProgress(0, 'Conversion Failed');
        if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
            window.showToast('Conversion error: ' + (err && err.message ? err.message : 'Unknown error'), true);
        }
        setTimeout(() => {
            if (progressContainer) progressContainer.classList.add('hidden');
            if (actionBtn) actionBtn.disabled = false;
        }, 1500);
    }
}