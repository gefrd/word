// Vector PDF of the scan mat (A4), written by hand: the sheet is only
// rectangles and a little text, so no PDF library is needed.

import { MARKERS, MARKER_MM, SHEET_W, SHEET_H, OBJECT_AREA } from './board.js';
import { AR } from './vendor/aruco.js';

const PT = 72 / 25.4; // points per millimetre

export function sheetPDF() {
    const dict = new AR.Dictionary('ARUCO_MIP_36h12');
    const H = SHEET_H * PT;
    const ops = [];
    const rect = (x, y, w, h) => ops.push(`${(x * PT).toFixed(3)} ${(H - (y + h) * PT).toFixed(3)} ${(w * PT).toFixed(3)} ${(h * PT).toFixed(3)} re f`);
    const cell = MARKER_MM / 8;
    for (const m of MARKERS) {
        ops.push('0 g');
        rect(m.x, m.y, MARKER_MM, MARKER_MM);
        ops.push('1 g');
        const bits = dict.codeList[m.id];
        for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
            if (bits[r * 6 + c] === '1') rect(m.x + (c + 1) * cell, m.y + (r + 1) * cell, cell + 0.01, cell + 0.01);
        }
    }
    // dashed object area + 10 cm scale bar
    const a = OBJECT_AREA;
    ops.push('0.8 G 0.4 w [3 3] 0 d');
    ops.push(`${(a.x0 * PT).toFixed(2)} ${(H - a.y1 * PT).toFixed(2)} ${((a.x1 - a.x0) * PT).toFixed(2)} ${((a.y1 - a.y0) * PT).toFixed(2)} re S`);
    ops.push('[] 0 d 0.6 g');
    rect(SHEET_W / 2 - 50, a.y1 - 8, 100, 0.8);
    const text = (x, y, size, s) => ops.push(`BT /F1 ${size} Tf ${(x * PT).toFixed(2)} ${(H - y * PT).toFixed(2)} Td (${s}) Tj ET`);
    text(SHEET_W / 2 - 7, a.y1 - 3, 9, '10 cm');
    text(a.x0 + 3, a.y0 + 6, 9, 'Kivu 3D Scan  -  print at 100% (no "fit to page")  -  put the object here');
    const content = ops.join('\n');

    const objs = [];
    objs.push('<< /Type /Catalog /Pages 2 0 R >>');
    objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${(SHEET_W * PT).toFixed(2)} ${H.toFixed(2)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    let out = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new Blob([out], { type: 'application/pdf' });
}
