// src/modules/tools/scanner-pdf.js
// Real multi-page PDF export, download and sharing.
//
// The old implementation called html2pdf with `output: 'datauristring'`, which
// builds the file and then throws it away — the button did nothing. It also
// rasterised the page a second time through html2canvas, so a sharp 2400px scan
// came out as a blurry screenshot of itself. Here the JPEG bytes go straight
// into the PDF with no re-rendering at all.
//
// pdf-lib is loaded on demand: it is ~400 KB, and most sessions never export.

const MM_TO_PT = 72 / 25.4;

export const PAGE_SIZES = {
    a4:     { width: 595.28, height: 841.89, label: 'A4' },
    letter: { width: 612,    height: 792,    label: 'Letter' },
    fit:    { width: 0,      height: 0,      label: 'Fit to image' }
};

// ISO/IEC 7810 ID-1 — the size of every bank card, driving licence and national
// ID. Printed at exactly this size the copy is accepted; stretched to fill A4 it
// often is not, which is the whole reason this mode exists.
const ID_CARD_MM = { width: 85.6, height: 54 };

let pdfLibPromise = null;

function loadPdfLib() {
    if (!pdfLibPromise) {
        pdfLibPromise = import('pdf-lib').catch((err) => {
            pdfLibPromise = null;
            throw new Error('PDF engine could not be loaded. Check your connection and try again. (' + (err.message || err) + ')');
        });
    }
    return pdfLibPromise;
}

// Warms the cache so the first export is instant and works offline afterwards.
export function preloadPdfEngine() {
    return loadPdfLib().then(() => true).catch(() => false);
}

/* ------------------------------------------------------------------ */
/* Image handling                                                      */
/* ------------------------------------------------------------------ */

// Trusting blob.type is not enough — blobs restored from IndexedDB or produced
// by an older browser sometimes carry an empty or wrong type. The magic bytes
// never lie.
function sniffFormat(bytes) {
    if (bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpg';
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
    return null;
}

// Last-resort path: decode with the browser and re-encode as baseline JPEG.
// Needed for progressive JPEGs, CMYK photos and WebP, none of which pdf-lib can
// embed directly.
async function transcodeToJpeg(blob, quality = 0.85) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    // White backdrop: transparent PNG areas would otherwise turn black in JPEG.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    canvas.width = canvas.height = 0;
    if (!out) throw new Error('Could not re-encode image for PDF');
    return new Uint8Array(await out.arrayBuffer());
}

async function embedImage(pdfDoc, blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const format = sniffFormat(bytes);
    try {
        if (format === 'png') return await pdfDoc.embedPng(bytes);
        if (format === 'jpg') return await pdfDoc.embedJpg(bytes);
    } catch (_) {
        // fall through to transcoding
    }
    return pdfDoc.embedJpg(await transcodeToJpeg(blob));
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

// Page box that matches the image proportions exactly, sized so the scan sits at
// roughly `dpi` when printed. Clamped so a tiny crop does not become a stamp and
// a huge one does not become a poster.
function fitPageBox(imgW, imgH, dpi = 200) {
    let w = (imgW * 72) / dpi;
    let h = (imgH * 72) / dpi;
    const longSide = Math.max(w, h);
    const min = 200, max = 1684; // ~7 cm to A3
    const scale = longSide < min ? min / longSide : (longSide > max ? max / longSide : 1);
    return { width: w * scale, height: h * scale };
}

// Largest rectangle with the image's aspect ratio that fits the printable area.
function contain(imgW, imgH, boxW, boxH) {
    const scale = Math.min(boxW / imgW, boxH / imgH);
    return { width: imgW * scale, height: imgH * scale };
}

/* ------------------------------------------------------------------ */
/* Build                                                              */
/* ------------------------------------------------------------------ */

/**
 * Builds the PDF.
 * @param {Array<{blob: Blob, width?: number, height?: number}>} pages ordered pages
 * @param {Object} options
 *        pageSize  'a4' | 'letter' | 'fit'   (default 'a4')
 *        marginMm  printable margin in mm     (default 6)
 *        layout    'standard' | 'id-card'
 *        title     document title stored in the PDF metadata
 * @returns {Promise<Blob>}
 */
export async function buildPdf(pages, options = {}) {
    if (!pages || !pages.length) throw new Error('Nothing to export — add a page first.');

    const { PDFDocument } = await loadPdfLib();
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(options.title || 'Scanned Document');
    pdfDoc.setProducer('Kivu Scanner');
    pdfDoc.setCreationDate(new Date());

    if (options.layout === 'id-card') {
        await layoutIdCard(pdfDoc, pages, options);
    } else {
        await layoutStandard(pdfDoc, pages, options);
    }

    const bytes = await pdfDoc.save({ useObjectStreams: true });
    // Copy into a fresh ArrayBuffer: pdf-lib may hand back a view over a larger
    // buffer, and Blob would then include the trailing bytes.
    return new Blob([bytes.slice()], { type: 'application/pdf' });
}

async function layoutStandard(pdfDoc, pages, options) {
    const sizeKey = options.pageSize || 'a4';
    const marginPt = Math.max(0, (options.marginMm !== undefined ? options.marginMm : 6)) * MM_TO_PT;

    for (const page of pages) {
        const image = await embedImage(pdfDoc, page.blob);
        const imgW = image.width;
        const imgH = image.height;

        if (sizeKey === 'fit') {
            const box = fitPageBox(imgW, imgH);
            const pdfPage = pdfDoc.addPage([box.width, box.height]);
            // No margin in fit mode: the page *is* the image.
            pdfPage.drawImage(image, { x: 0, y: 0, width: box.width, height: box.height });
            continue;
        }

        const base = PAGE_SIZES[sizeKey] || PAGE_SIZES.a4;
        // Rotate the sheet to match the scan, so a landscape receipt is not
        // shrunk to a third of the page.
        const portrait = imgH >= imgW;
        const pw = portrait ? base.width : base.height;
        const ph = portrait ? base.height : base.width;
        const pdfPage = pdfDoc.addPage([pw, ph]);

        const avail = { w: pw - marginPt * 2, h: ph - marginPt * 2 };
        const drawn = contain(imgW, imgH, avail.w, avail.h);
        pdfPage.drawImage(image, {
            x: (pw - drawn.width) / 2,
            y: (ph - drawn.height) / 2,
            width: drawn.width,
            height: drawn.height
        });
    }
}

// Both sides of a card at true physical size, stacked in the upper half of A4
// with a gap — the layout copy shops and banks expect.
async function layoutIdCard(pdfDoc, pages, options) {
    const base = PAGE_SIZES[options.pageSize === 'letter' ? 'letter' : 'a4'];
    const cardW = ID_CARD_MM.width * MM_TO_PT;
    const cardH = ID_CARD_MM.height * MM_TO_PT;
    const gap = 10 * MM_TO_PT;
    const perSheet = 2;

    for (let i = 0; i < pages.length; i += perSheet) {
        const sheet = pdfDoc.addPage([base.width, base.height]);
        const slice = pages.slice(i, i + perSheet);
        const blockH = cardH * slice.length + gap * (slice.length - 1);
        // Anchor the block in the upper half, a little below the top edge.
        const topY = base.height - 25 * MM_TO_PT;
        let y = topY - cardH;
        const x = (base.width - cardW) / 2;

        for (const page of slice) {
            const image = await embedImage(pdfDoc, page.blob);
            // The card is drawn at exact ID-1 size. If the scan's aspect ratio
            // differs slightly, it is fitted inside that box rather than
            // stretched — a distorted ID is a rejected ID.
            const drawn = contain(image.width, image.height, cardW, cardH);
            sheet.drawImage(image, {
                x: x + (cardW - drawn.width) / 2,
                y: y + (cardH - drawn.height) / 2,
                width: drawn.width,
                height: drawn.height
            });
            y -= cardH + gap;
        }
        void blockH;
    }
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

export function safeFileName(title, extension) {
    const base = String(title || 'scan')
        .replace(/[\\/:*?"<>| -]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || 'scan';
    return `${base}.${extension}`;
}

// Actually saves the file. The revoke is deferred because Safari cancels an
// in-flight download if the blob URL disappears too early.
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 4000);
    return true;
}

// True only if this browser can share THIS kind of file. Checking navigator.share
// alone is what makes other apps show a share button that then throws — older
// iOS versions have share but refuse files.
export function canShareFile(file) {
    try {
        return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
    } catch (_) {
        return false;
    }
}

/**
 * Shares the blob, falling back to a download when the platform cannot share
 * files. Returns 'shared' | 'downloaded' | 'cancelled'.
 */
export async function shareOrDownload(blob, filename, shareTitle) {
    const file = new File([blob], filename, { type: blob.type });
    if (canShareFile(file)) {
        try {
            await navigator.share({ files: [file], title: shareTitle || filename });
            return 'shared';
        } catch (err) {
            // AbortError means the user closed the sheet — do not then dump a
            // file into their Downloads folder behind their back.
            if (err && err.name === 'AbortError') return 'cancelled';
        }
    }
    downloadBlob(blob, filename);
    return 'downloaded';
}
