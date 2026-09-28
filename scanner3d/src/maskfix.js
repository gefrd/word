// Cleaning up the AI object masks before the no-sheet reconstruction.
//
// RMBG is trained on product photos. On real scans it sometimes takes the
// table (low views) or the stool the object turns on as part of the
// "product". Two fixes, both cheap:
//   1. masks much bigger than the others / touching the picture edges are
//      redone on a crop around where the object is in the good frames;
//   2. with a still camera (turntable video), pixels that stay the same over
//      the whole turn can't be the turning object: they get no vote.

const FG = 110;

/** Area, bounding box (normalised 0..1) and edge contact of a soft mask. */
export function maskStats(prob, w, h) {
    let n = 0, x0 = w, y0 = h, x1 = -1, y1 = -1, border = 0, borderN = 0;
    for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
            const on = prob[y * w + x] >= FG;
            const edge = x < 4 || y < 4 || x >= w - 5 || y >= h - 5;
            if (edge) { borderN++; if (on) border++; }
            if (!on) continue;
            n++;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
    }
    const area = n / (Math.ceil(w / 2) * Math.ceil(h / 2));
    return { area, border: border / Math.max(1, borderN), box: x1 < 0 ? null : [x0 / w, y0 / h, (x1 + 2) / w, (y1 + 2) / h] };
}

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

/**
 * Decide which masks look wrong and where the object usually is.
 * Returns { bad: Set(index), box: [x0,y0,x1,y1] normalised crop for redoing }.
 */
export function planMaskFixes(stats) {
    const good = stats.map((s, i) => [s, i]).filter(([s]) => s.box && s.area > 0.003 && s.area < 0.45 && s.border < 0.08);
    const areas = good.map(([s]) => s.area);
    const medArea = areas.length ? median(areas) : 0.15;
    const bad = new Set();
    stats.forEach((s, i) => {
        if (!s.box || s.area < 0.003) { bad.add(i); return; }
        if (s.area > Math.max(0.45, 2.2 * medArea) || s.border > 0.15) bad.add(i);
    });
    // where the object is: median box of the good frames (or the middle of
    // the picture, where people keep what they film), grown a little
    let box = [0.15, 0.1, 0.85, 0.95];
    if (good.length >= 3) {
        const b = [0, 1, 2, 3].map(k => median(good.map(([s]) => s.box[k])));
        const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
        const hw = Math.min(0.5, (b[2] - b[0]) * 0.75 + 0.04), hh = Math.min(0.5, (b[3] - b[1]) * 0.75 + 0.04);
        box = [Math.max(0, cx - hw), Math.max(0, cy - hh), Math.min(1, cx + hw), Math.min(1, cy + hh)];
    }
    return { bad, box, medArea, good: good.length };
}

/**
 * Still camera? Compare small grey frames outside the (grown) object masks:
 * a turntable video barely changes there, a walk-around changes everywhere.
 */
export function isStillCamera(greys, probs, w, h, sw, sh) {
    if (greys.length < 4) return false;
    const diffs = [];
    for (let k = 1; k < greys.length; k++) {
        let s = 0, n = 0;
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
            const px = Math.min(w - 1, Math.floor((x + 0.5) * w / sw)), py = Math.min(h - 1, Math.floor((y + 0.5) * h / sh));
            if (probs[k][py * w + px] >= 30 || probs[k - 1][py * w + px] >= 30) continue;
            const i = y * sw + x;
            s += Math.abs(greys[k][i] - greys[k - 1][i]); n++;
        }
        if (n > 50) diffs.push(s / n);
    }
    return diffs.length >= 3 && median(diffs) < 4;
}

/**
 * Turntable: flags (1 = no vote) for pixels inside the mask that match the
 * median image of the whole turn — the stool, the table, a hand's shadow…
 * Returns one Uint8Array per frame at w×h.
 */
export function staticPixels(greys, probs, w, h, sw, sh) {
    const n = greys.length, med = new Uint8Array(sw * sh), col = new Uint8Array(n);
    for (let i = 0; i < sw * sh; i++) {
        for (let k = 0; k < n; k++) col[k] = greys[k][i];
        med[i] = median(col);
    }
    return greys.map((g, k) => {
        const flags = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            const sy = Math.min(sh - 1, Math.floor(y * sh / h));
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (probs[k][i] < FG) continue;
                const si = sy * sw + Math.min(sw - 1, Math.floor(x * sw / w));
                if (Math.abs(g[si] - med[si]) < 7) flags[i] = 1;
            }
        }
        return flags;
    });
}

/** Small grey copy (sw×sh) of an RGBA frame. */
export function smallGrey(rgba, w, h, sw, sh) {
    const g = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        let s = 0, c = 0;
        const x0 = Math.floor(x * w / sw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / sw));
        const y0 = Math.floor(y * h / sh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / sh));
        for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) { const j = (yy * w + xx) * 4; s += rgba[j] * 0.3 + rgba[j + 1] * 0.59 + rgba[j + 2] * 0.11; c++; }
        g[y * sw + x] = s / Math.max(1, c);
    }
    return g;
}
