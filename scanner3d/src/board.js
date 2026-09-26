// Marker sheet ("scan mat") definition.
//
// An A4 page with 10 ArUco markers (ARUCO_MIP_36h12) around the border and an
// empty area in the middle for the object. Every marker has a known position,
// so each video frame that sees a few markers tells us exactly where the
// camera was. Units are millimetres.
//
// World frame: origin at the sheet centre, +X to the right, +Y towards the top
// edge of the page, +Z up out of the paper (towards the camera).

import { AR } from './vendor/aruco.js';

export const SHEET_W = 210;
export const SHEET_H = 297;
export const MARKER_MM = 32;
const MARGIN = 8;

// Top-left corners of each marker on the page (page coords: x right, y down).
const COLS = [MARGIN, (SHEET_W - MARKER_MM) / 2, SHEET_W - MARGIN - MARKER_MM];
const ROWS = [MARGIN, 91, 174, SHEET_H - MARGIN - MARKER_MM];
const PLACEMENT = [
    [COLS[0], ROWS[0]], [COLS[1], ROWS[0]], [COLS[2], ROWS[0]],
    [COLS[2], ROWS[1]], [COLS[2], ROWS[2]],
    [COLS[2], ROWS[3]], [COLS[1], ROWS[3]], [COLS[0], ROWS[3]],
    [COLS[0], ROWS[2]], [COLS[0], ROWS[1]],
];
// Ids chosen from the dictionary (0..249); spread out for distinct patterns.
const IDS = [3, 17, 29, 41, 58, 66, 79, 88, 101, 115];

export const MARKERS = PLACEMENT.map(([x, y], i) => ({ id: IDS[i], x, y }));
const BY_ID = new Map(MARKERS.map(m => [m.id, m]));

// Free area in the middle where the object goes (page coords).
export const OBJECT_AREA = {
    x0: MARGIN + MARKER_MM + 4,
    y0: MARGIN + MARKER_MM + 4,
    x1: SHEET_W - MARGIN - MARKER_MM - 4,
    y1: SHEET_H - MARGIN - MARKER_MM - 4,
};

export function pageToWorld(px, py) {
    return [px - SHEET_W / 2, SHEET_H / 2 - py, 0];
}

/**
 * World coordinates of a marker's 4 corners, in the order js-aruco reports
 * detected corners: top-left, top-right, bottom-right, bottom-left of the
 * marker as printed.
 */
export function markerWorldCorners(id) {
    const m = BY_ID.get(id);
    if (!m) return null;
    const s = MARKER_MM;
    return [
        pageToWorld(m.x, m.y),
        pageToWorld(m.x + s, m.y),
        pageToWorld(m.x + s, m.y + s),
        pageToWorld(m.x, m.y + s),
    ];
}

export function isBoardMarker(id) {
    return BY_ID.has(id);
}

let dict = null;
function markerBits(id) {
    if (!dict) dict = new AR.Dictionary('ARUCO_MIP_36h12');
    return dict.codeList[id]; // 36-char string of '0'/'1', row-major, 1 = white
}

/**
 * Draw the sheet onto a 2D canvas context at `pxPerMm` resolution.
 * Used for printing, for showing it on another screen, and as the
 * "expected appearance" when separating the object from the paper.
 */
export function drawBoard(ctx, pxPerMm, opts = {}) {
    const W = Math.round(SHEET_W * pxPerMm);
    const H = Math.round(SHEET_H * pxPerMm);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    const cell = MARKER_MM / 8;
    for (const m of MARKERS) {
        const bits = markerBits(m.id);
        ctx.fillStyle = '#000';
        ctx.fillRect(m.x * pxPerMm, m.y * pxPerMm, MARKER_MM * pxPerMm, MARKER_MM * pxPerMm);
        ctx.fillStyle = '#fff';
        for (let r = 0; r < 6; r++) {
            for (let c = 0; c < 6; c++) {
                if (bits[r * 6 + c] === '1') {
                    // Slight overdraw avoids hairline gaps between white cells.
                    ctx.fillRect(
                        (m.x + (c + 1) * cell) * pxPerMm - 0.25,
                        (m.y + (r + 1) * cell) * pxPerMm - 0.25,
                        cell * pxPerMm + 0.5,
                        cell * pxPerMm + 0.5,
                    );
                }
            }
        }
    }
    if (opts.guides) {
        const a = OBJECT_AREA;
        ctx.strokeStyle = '#c8c8c8';
        ctx.lineWidth = Math.max(1, 0.4 * pxPerMm);
        ctx.setLineDash([3 * pxPerMm, 3 * pxPerMm]);
        ctx.strokeRect(a.x0 * pxPerMm, a.y0 * pxPerMm, (a.x1 - a.x0) * pxPerMm, (a.y1 - a.y0) * pxPerMm);
        ctx.setLineDash([]);
        const cx = SHEET_W / 2 * pxPerMm, cy = SHEET_H / 2 * pxPerMm, r = 6 * pxPerMm;
        ctx.beginPath();
        ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
        ctx.stroke();
        ctx.fillStyle = '#9a9a9a';
        ctx.font = `${3.2 * pxPerMm}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('Kivu 3D Scan — print at 100% (A4)', cx, (OBJECT_AREA.y0 + 6) * pxPerMm);
        ctx.fillText('10 cm', cx, (OBJECT_AREA.y1 - 3) * pxPerMm);
        // 10 cm scale bar to check the print size
        const y = (OBJECT_AREA.y1 - 8) * pxPerMm;
        ctx.fillStyle = '#9a9a9a';
        ctx.fillRect(cx - 50 * pxPerMm, y, 100 * pxPerMm, 0.8 * pxPerMm);
    }
    return { width: W, height: H };
}

/** Sheet as a standalone SVG string (vector — sharp at any print size). */
export function boardSVG() {
    const cell = MARKER_MM / 8;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}mm" height="${SHEET_H}mm" viewBox="0 0 ${SHEET_W} ${SHEET_H}">`;
    s += `<rect width="${SHEET_W}" height="${SHEET_H}" fill="#fff"/>`;
    for (const m of MARKERS) {
        const bits = markerBits(m.id);
        s += `<rect x="${m.x}" y="${m.y}" width="${MARKER_MM}" height="${MARKER_MM}" fill="#000"/>`;
        for (let r = 0; r < 6; r++) {
            for (let c = 0; c < 6; c++) {
                if (bits[r * 6 + c] === '1') {
                    s += `<rect x="${m.x + (c + 1) * cell}" y="${m.y + (r + 1) * cell}" width="${cell + 0.02}" height="${cell + 0.02}" fill="#fff"/>`;
                }
            }
        }
    }
    const a = OBJECT_AREA;
    s += `<rect x="${a.x0}" y="${a.y0}" width="${a.x1 - a.x0}" height="${a.y1 - a.y0}" fill="none" stroke="#ccc" stroke-width="0.4" stroke-dasharray="3 3"/>`;
    s += `<rect x="${SHEET_W / 2 - 50}" y="${a.y1 - 8}" width="100" height="0.8" fill="#999"/>`;
    s += `<text x="${SHEET_W / 2}" y="${a.y1 - 3}" font-size="3.2" text-anchor="middle" fill="#999" font-family="sans-serif">10 cm</text>`;
    s += `<text x="${SHEET_W / 2}" y="${a.y0 + 6}" font-size="3.2" text-anchor="middle" fill="#999" font-family="sans-serif">Kivu 3D Scan · print at 100% on A4 · object goes here</text>`;
    s += '</svg>';
    return s;
}
