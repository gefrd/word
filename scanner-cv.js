// src/modules/tools/scanner-cv.js
// Image maths for the Kivu Pro Scanner. Pure functions, no DOM, no globals —
// so the exact same code runs on the main thread (live preview) and inside the
// Web Worker (full-resolution export).
//
// Everything here is written around the integral-image trick: once you have the
// summed-area table you can take the mean of ANY rectangle in constant time,
// which makes both the shadow removal and the adaptive threshold O(pixels)
// instead of O(pixels x window). That is what keeps it usable on a 2 GB phone.

/* ================================================================== */
/* 1. Basic conversions                                                */
/* ================================================================== */

export function toGray(rgba, w, h) {
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
        // Integer approximation of 0.299/0.587/0.114 — no float maths per pixel.
        gray[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    }
    return gray;
}

// Summed-area table, (w+1) x (h+1) so the border needs no special-casing.
// Max value is 255 * 2400 * 3200 which still fits an unsigned 32-bit int.
export function integralImage(gray, w, h) {
    const iw = w + 1;
    const sat = new Uint32Array(iw * (h + 1));
    for (let y = 0; y < h; y++) {
        let rowSum = 0;
        const src = y * w;
        const cur = (y + 1) * iw;
        const prev = y * iw;
        for (let x = 0; x < w; x++) {
            rowSum += gray[src + x];
            sat[cur + x + 1] = sat[prev + x + 1] + rowSum;
        }
    }
    return sat;
}

// Mean of the rectangle clamped to the image, in constant time.
function rectMean(sat, w, h, x0, y0, x1, y1) {
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > w - 1) x1 = w - 1;
    if (y1 > h - 1) y1 = h - 1;
    const iw = w + 1;
    const a = sat[y0 * iw + x0];
    const b = sat[y0 * iw + x1 + 1];
    const c = sat[(y1 + 1) * iw + x0];
    const d = sat[(y1 + 1) * iw + x1 + 1];
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    return area > 0 ? (d - b - c + a) / area : 0;
}

// Box blur via the integral image: cost is independent of the radius, which is
// what lets us use a huge radius for the background estimate.
export function boxBlur(gray, w, h, radius) {
    const sat = integralImage(gray, w, h);
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            out[row + x] = rectMean(sat, w, h, x - radius, y - radius, x + radius, y + radius);
        }
    }
    return out;
}

/* ================================================================== */
/* 2. Shadow removal (division normalisation)                          */
/* ================================================================== */

// Estimates the illumination by heavily blurring the image, then divides it out.
// This removes a gradient shadow mathematically instead of hiding it behind a
// contrast boost — the difference you actually see on a page lit from one side.
export function estimateBackground(gray, w, h) {
    const radius = Math.max(8, Math.round(Math.max(w, h) / 14));
    return boxBlur(gray, w, h, radius);
}

// Percentile of a 256-bin histogram, used to pick black/white points robustly
// (a single blown-out pixel must not define "white").
function percentile(hist, total, frac) {
    let acc = 0;
    const target = total * frac;
    for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= target) return v;
    }
    return 255;
}

export function otsuThreshold(gray) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];

    let sumB = 0, wB = 0, best = 0, thr = 127;
    for (let v = 0; v < 256; v++) {
        wB += hist[v];
        if (wB === 0) continue;
        const wF = total - wB;
        if (wF === 0) break;
        sumB += v * hist[v];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; thr = v; }
    }
    return thr;
}

/* ================================================================== */
/* 3. Document detection                                               */
/* ================================================================== */

// Flood-fills the binary mask and returns the largest region, preferring one
// that covers the centre of the frame (that is where people aim the document).
function largestRegion(mask, w, h) {
    const labels = new Int32Array(w * h).fill(-1);
    const stack = new Int32Array(w * h);
    let best = null;
    let current = 0;

    for (let start = 0; start < mask.length; start++) {
        if (mask[start] === 0 || labels[start] !== -1) continue;
        let sp = 0;
        stack[sp++] = start;
        labels[start] = current;
        let count = 0;
        let minX = w, maxX = 0, minY = h, maxY = 0;
        const border = [];

        while (sp > 0) {
            const p = stack[--sp];
            const x = p % w;
            const y = (p - x) / w;
            count++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            let isBorder = false;
            // 4-neighbourhood: cheaper than 8 and enough for solid paper blobs.
            if (x > 0)     { const n = p - 1; if (mask[n]) { if (labels[n] === -1) { labels[n] = current; stack[sp++] = n; } } else isBorder = true; } else isBorder = true;
            if (x < w - 1) { const n = p + 1; if (mask[n]) { if (labels[n] === -1) { labels[n] = current; stack[sp++] = n; } } else isBorder = true; } else isBorder = true;
            if (y > 0)     { const n = p - w; if (mask[n]) { if (labels[n] === -1) { labels[n] = current; stack[sp++] = n; } } else isBorder = true; } else isBorder = true;
            if (y < h - 1) { const n = p + w; if (mask[n]) { if (labels[n] === -1) { labels[n] = current; stack[sp++] = n; } } else isBorder = true; } else isBorder = true;

            if (isBorder) border.push(x, y);
        }

        if (!best || count > best.count) {
            best = { count, border, minX, maxX, minY, maxY };
        }
        current++;
    }
    return best;
}

function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

// Andrew's monotone chain.
export function convexHull(points) {
    if (points.length < 4) return points.slice();
    const pts = points.slice().sort((p, q) => (p.x - q.x) || (p.y - q.y));
    const lower = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
}

function polygonArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
        const p = pts[i], q = pts[(i + 1) % n];
        a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
}

// Keeps only the vertices that carry the shape, so the quad search stays cheap.
function simplifyHull(hull, maxVertices = 14) {
    let pts = hull;
    if (pts.length <= maxVertices) return pts;
    // Drop the vertices whose removal changes the area the least, one at a time.
    pts = pts.slice();
    while (pts.length > maxVertices) {
        let worstIdx = 0;
        let worstLoss = Infinity;
        for (let i = 0; i < pts.length; i++) {
            const prev = pts[(i - 1 + pts.length) % pts.length];
            const next = pts[(i + 1) % pts.length];
            const loss = Math.abs(cross(prev, pts[i], next)) / 2;
            if (loss < worstLoss) { worstLoss = loss; worstIdx = i; }
        }
        pts.splice(worstIdx, 1);
    }
    return pts;
}

function angleAt(a, b, c) {
    const v1x = a.x - b.x, v1y = a.y - b.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
    if (!n1 || !n2) return 0;
    let cosv = (v1x * v2x + v1y * v2y) / (n1 * n2);
    cosv = Math.max(-1, Math.min(1, cosv));
    return Math.acos(cosv) * 180 / Math.PI;
}

// Largest-area quadrilateral among the hull vertices. After simplification the
// brute force is at most C(14,4) = 1001 combinations, i.e. free.
function bestQuad(hull) {
    const n = hull.length;
    if (n < 4) return null;
    let best = null, bestArea = 0;
    for (let i = 0; i < n - 3; i++) {
        for (let j = i + 1; j < n - 2; j++) {
            for (let k = j + 1; k < n - 1; k++) {
                for (let l = k + 1; l < n; l++) {
                    const quad = [hull[i], hull[j], hull[k], hull[l]];
                    const area = polygonArea(quad);
                    if (area > bestArea) { bestArea = area; best = quad; }
                }
            }
        }
    }
    return best;
}

// Orders four arbitrary points as top-left, top-right, bottom-right, bottom-left.
export function sortCorners(pts) {
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    // Sorting by angle around the centroid gives a consistent winding, then we
    // rotate the list so it starts at the top-left-most point.
    const withAngle = pts.map((p) => ({ p, a: Math.atan2(p.y - cy, p.x - cx) }));
    withAngle.sort((u, v) => u.a - v.a);
    const ordered = withAngle.map((o) => o.p);
    let startIdx = 0, bestScore = Infinity;
    for (let i = 0; i < 4; i++) {
        const score = ordered[i].x + ordered[i].y;
        if (score < bestScore) { bestScore = score; startIdx = i; }
    }
    return [
        ordered[startIdx],
        ordered[(startIdx + 1) % 4],
        ordered[(startIdx + 2) % 4],
        ordered[(startIdx + 3) % 4]
    ];
}

/**
 * Finds the document quadrilateral in a small grayscale frame.
 * Returns corners in the coordinate space of that frame, or null.
 *
 * Honest limitation: a white sheet on a white table has no edge to find. No
 * scanner solves this, which is why manual corners stay the primary path.
 */
export function detectDocument(gray, w, h) {
    // 1. Flatten the lighting first, otherwise a global threshold splits the
    //    image by "lit vs shadowed" instead of "paper vs table".
    const bg = estimateBackground(gray, w, h);
    const flat = new Uint8ClampedArray(w * h);
    for (let i = 0; i < flat.length; i++) {
        const b = bg[i] || 1;
        flat[i] = Math.min(255, (gray[i] * 160) / b);
    }

    // 2. Paper is the bright side of the split.
    const thr = otsuThreshold(flat);
    const mask = new Uint8Array(w * h);
    let bright = 0;
    for (let i = 0; i < mask.length; i++) {
        if (flat[i] > thr) { mask[i] = 1; bright++; }
    }
    // A mask covering nearly everything means there was no contrast at all.
    if (bright < mask.length * 0.06 || bright > mask.length * 0.985) return null;

    const region = largestRegion(mask, w, h);
    if (!region || region.count < mask.length * 0.10) return null;

    const border = [];
    for (let i = 0; i < region.border.length; i += 2) {
        border.push({ x: region.border[i], y: region.border[i + 1] });
    }
    if (border.length < 8) return null;

    const hull = simplifyHull(convexHull(border));
    const quad = bestQuad(hull);
    if (!quad) return null;

    const corners = sortCorners(quad);
    const area = polygonArea(corners);
    if (area < w * h * 0.10 || area > w * h * 0.999) return null;

    // Reject shapes that cannot be a rectangle seen through a lens. The range is
    // deliberately wide (40-140 degrees) because steep angles are legitimate.
    for (let i = 0; i < 4; i++) {
        const ang = angleAt(corners[(i + 3) % 4], corners[i], corners[(i + 1) % 4]);
        if (ang < 40 || ang > 140) return null;
    }
    // The quad must actually explain the region it came from, otherwise we are
    // fitting a box around something shaped like a hand or a shadow.
    if (area < region.count * 0.75) return null;

    return corners;
}

// Variance of the Laplacian: low value means the frame is blurry. Used to stop
// auto-capture from firing while the phone is still moving.
export function sharpnessScore(gray, w, h) {
    let mean = 0, count = 0;
    const step = 2; // sampling every other pixel is plenty and twice as fast
    const values = [];
    for (let y = step; y < h - step; y += step) {
        for (let x = step; x < w - step; x += step) {
            const p = y * w + x;
            const lap = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - w] - gray[p + w];
            values.push(lap);
            mean += lap;
            count++;
        }
    }
    if (!count) return 0;
    mean /= count;
    let variance = 0;
    for (let i = 0; i < values.length; i++) {
        const d = values[i] - mean;
        variance += d * d;
    }
    return variance / count;
}

/* ================================================================== */
/* 4. Perspective correction                                           */
/* ================================================================== */

// Gaussian elimination with partial pivoting for the 8x8 homography system.
function solveLinear(A, b, n) {
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
        }
        if (Math.abs(A[pivot][col]) < 1e-12) return null; // degenerate quad
        if (pivot !== col) {
            const tmpRow = A[pivot]; A[pivot] = A[col]; A[col] = tmpRow;
            const tmpVal = b[pivot]; b[pivot] = b[col]; b[col] = tmpVal;
        }
        const inv = 1 / A[col][col];
        for (let r = col + 1; r < n; r++) {
            const f = A[r][col] * inv;
            if (!f) continue;
            for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
            b[r] -= f * b[col];
        }
    }
    const x = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) {
        let sum = b[r];
        for (let c = r + 1; c < n; c++) sum -= A[r][c] * x[c];
        x[r] = sum / A[r][r];
    }
    return x;
}

/**
 * Homography mapping the OUTPUT rectangle (0,0)-(outW,outH) onto the four
 * corners picked on the photo. Solving in this direction means the warp does a
 * backward lookup per output pixel and never leaves holes in the result.
 */
export function homographyRectToQuad(outW, outH, quad) {
    const src = [
        { x: 0, y: 0 },
        { x: outW, y: 0 },
        { x: outW, y: outH },
        { x: 0, y: outH }
    ];
    // Two rows per corner, interleaved to match b: u-row then v-row.
    const A = [];
    const b = new Float64Array(8);
    for (let i = 0; i < 4; i++) {
        const { x, y } = src[i];
        const u = quad[i].x, v = quad[i].y;
        A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
        b[i * 2] = u;
        A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
        b[i * 2 + 1] = v;
    }
    const h = solveLinear(A, b, 8);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Recovers the TRUE width/height ratio of the rectangle from its projection.
 *
 * Averaging the side lengths (the obvious approach) is wrong under perspective:
 * on a realistic photo of an A4 sheet it lands ~6% off, which is a visible
 * stretch. This solves it properly instead.
 *
 * The maths: a rectangle is a parallelogram, so in camera coordinates
 * M1 + M3 = M2 + M4. Writing the four image points with unknown depths and
 * imposing that identity gives the depth ratios in closed form — and because
 * they come out as ratios of triple products, they can be computed straight from
 * pixel coordinates without knowing the focal length. The two side vectors must
 * then be perpendicular, which pins down the focal length, and once that is
 * known their lengths give the ratio.
 *
 * Assumes the principal point is the image centre and square pixels. Both hold
 * closely enough on phone cameras.
 *
 * @param {Array} quad ordered [topLeft, topRight, bottomRight, bottomLeft]
 * @returns {number|null} width/height, or null when the view is too close to
 *          straight-on for the focal length to be observable (in which case the
 *          averaged side lengths are already correct).
 */
export function estimateAspectRatio(quad, imgWidth, imgHeight) {
    if (!quad || quad.length !== 4 || !imgWidth || !imgHeight) return null;
    const u0 = imgWidth / 2;
    const v0 = imgHeight / 2;

    // Homogeneous image points.
    const m = quad.map((p) => [p.x, p.y, 1]);
    const [m1, m2, m3, m4] = m;

    const cross = (a, b) => [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
    ];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    const c34 = cross(m3, m4);
    const c23 = cross(m2, m3);
    const d2 = dot(m2, c34);
    const d4 = dot(m4, c23);
    if (Math.abs(d2) < 1e-9 || Math.abs(d4) < 1e-9) return null;

    // Relative depths of corners 2 and 4 with corner 1 fixed at 1.
    const l2 = dot(m1, c34) / d2;
    const l4 = dot(m1, c23) / d4;

    // The two edge directions leaving corner 1, still in pixel space.
    const n2 = [l2 * m2[0] - m1[0], l2 * m2[1] - m1[1], l2 * m2[2] - m1[2]];
    const n4 = [l4 * m4[0] - m1[0], l4 * m4[1] - m1[1], l4 * m4[2] - m1[2]];

    const a2 = n2[0] - n2[2] * u0, b2 = n2[1] - n2[2] * v0;
    const a4 = n4[0] - n4[2] * u0, b4 = n4[1] - n4[2] * v0;

    const denom = n2[2] * n4[2];
    // Near-frontal shot: both edges lie in the image plane, the focal length has
    // no effect, and the simple averaged estimate is already right.
    if (Math.abs(denom) < 1e-7) return null;

    const f2 = -(a2 * a4 + b2 * b4) / denom;
    // A negative or absurd focal length means the four points are not a plausible
    // projection of a rectangle — usually a mis-detection or a hand-dragged quad.
    if (!isFinite(f2) || f2 <= 0) return null;
    const f = Math.sqrt(f2);
    const diag = Math.hypot(imgWidth, imgHeight);
    if (f < diag * 0.25 || f > diag * 12) return null;

    const len2 = Math.sqrt(a2 * a2 + b2 * b2 + f2 * n2[2] * n2[2]);
    const len4 = Math.sqrt(a4 * a4 + b4 * b4 + f2 * n4[2] * n4[2]);
    if (!isFinite(len2) || !isFinite(len4) || len4 < 1e-9) return null;

    const ratio = len2 / len4;
    // Guard against wild results from a degenerate quad.
    if (!isFinite(ratio) || ratio < 0.05 || ratio > 20) return null;
    return ratio;
}

/**
 * Output size for the flattened page.
 *
 * When the source dimensions are supplied the true aspect ratio is recovered
 * from the perspective; otherwise it falls back to the mean of opposite side
 * lengths, which keeps receipts as receipts and cards as cards but is a few
 * percent off on a steeply angled shot.
 */
export function estimateOutputSize(quad, maxDim, srcWidth = 0, srcHeight = 0) {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const avgW = Math.max(1, (d(quad[0], quad[1]) + d(quad[3], quad[2])) / 2);
    const avgH = Math.max(1, (d(quad[0], quad[3]) + d(quad[1], quad[2])) / 2);

    let w = avgW;
    let h = avgH;

    const ratio = estimateAspectRatio(quad, srcWidth, srcHeight);
    if (ratio) {
        // Keep the pixel count the averaged estimate implies, so detail is
        // neither invented nor thrown away, and only fix the proportions.
        const area = avgW * avgH;
        h = Math.sqrt(area / ratio);
        w = h * ratio;
    }

    if (maxDim) {
        const scale = Math.min(1, maxDim / Math.max(w, h));
        w *= scale;
        h *= scale;
    }
    return { width: Math.max(8, Math.round(w)), height: Math.max(8, Math.round(h)) };
}

/**
 * Backward-mapped perspective warp with bilinear sampling.
 * srcRGBA: Uint8ClampedArray of the source image, quad in source pixels.
 */
export function warpPerspective(srcRGBA, sw, sh, quad, outW, outH) {
    const H = homographyRectToQuad(outW, outH, quad);
    if (!H) return null;
    const out = new Uint8ClampedArray(outW * outH * 4);
    const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;

    for (let y = 0; y < outH; y++) {
        // Incremental evaluation across the row: three multiply-adds per pixel.
        let nx = h0 * 0 + h1 * y + h2;
        let ny = h3 * 0 + h4 * y + h5;
        let nz = h6 * 0 + h7 * y + h8;
        let o = y * outW * 4;

        for (let x = 0; x < outW; x++, o += 4) {
            const iz = nz !== 0 ? 1 / nz : 0;
            const sx = nx * iz;
            const sy = ny * iz;
            nx += h0; ny += h3; nz += h6;

            if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
                // Outside the photo: white, so a slightly generous quad produces
                // clean paper margins instead of black torn edges.
                out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255;
                continue;
            }

            const x0 = sx | 0, y0 = sy | 0;
            const x1 = x0 + 1 < sw ? x0 + 1 : x0;
            const y1 = y0 + 1 < sh ? y0 + 1 : y0;
            const fx = sx - x0, fy = sy - y0;
            const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
            const w01 = (1 - fx) * fy, w11 = fx * fy;
            const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
            const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;

            out[o]     = srcRGBA[i00]     * w00 + srcRGBA[i10]     * w10 + srcRGBA[i01]     * w01 + srcRGBA[i11]     * w11;
            out[o + 1] = srcRGBA[i00 + 1] * w00 + srcRGBA[i10 + 1] * w10 + srcRGBA[i01 + 1] * w01 + srcRGBA[i11 + 1] * w11;
            out[o + 2] = srcRGBA[i00 + 2] * w00 + srcRGBA[i10 + 2] * w10 + srcRGBA[i01 + 2] * w01 + srcRGBA[i11 + 2] * w11;
            out[o + 3] = 255;
        }
    }
    return { data: out, width: outW, height: outH };
}

/* ================================================================== */
/* 5. Filters                                                          */
/* ================================================================== */

function buildToneLUT(brightness = 0, contrast = 0) {
    // brightness/contrast are -100..100 sliders.
    const lut = new Uint8ClampedArray(256);
    const c = contrast / 100;
    const factor = c >= 0 ? 1 / Math.max(0.02, 1 - c) : 1 + c;
    const b = (brightness / 100) * 96;
    for (let v = 0; v < 256; v++) {
        lut[v] = (v - 128) * factor + 128 + b;
    }
    return lut;
}

function applyTone(rgba, lut) {
    for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = lut[rgba[i]];
        rgba[i + 1] = lut[rgba[i + 1]];
        rgba[i + 2] = lut[rgba[i + 2]];
    }
}

/**
 * Magic Color — what makes a photo look like a scan.
 *  1. divide out the estimated illumination (shadows disappear, not merely fade)
 *  2. stretch to a robust black/white point from the histogram
 *  3. mild unsharp mask so small text stays crisp
 * Chroma is preserved because the gain is applied per channel, which keeps blue
 * pen and coloured stamps intact instead of washing them to grey.
 */
export function applyMagicColor(rgba, w, h, opts = {}) {
    const gray = toGray(rgba, w, h);
    const bg = estimateBackground(gray, w, h);

    // Step 1 + 2: normalise, and collect the histogram of the result in one pass.
    const norm = new Uint8ClampedArray(w * h);
    const hist = new Uint32Array(256);
    for (let p = 0; p < norm.length; p++) {
        const b = bg[p] || 1;
        const v = (gray[p] * 255) / b;
        const nv = v > 255 ? 255 : v;
        norm[p] = nv;
        hist[nv | 0]++;
    }

    const total = norm.length;
    let black = percentile(hist, total, 0.02);
    let white = percentile(hist, total, 0.97);
    // Guard against a blank page, where a narrow range would amplify pure noise.
    if (white - black < 40) { black = Math.max(0, white - 40); }
    const scale = 255 / Math.max(1, white - black);

    // Blur radius 1 gives us the high-frequency detail for the unsharp mask.
    const detailBase = boxBlur(norm, w, h, 1);
    const sharpen = opts.sharpen !== undefined ? opts.sharpen : 0.55;

    for (let p = 0, i = 0; p < norm.length; p++, i += 4) {
        let target = (norm[p] - black) * scale;
        if (sharpen) target += (norm[p] - detailBase[p]) * sharpen;
        if (target < 0) target = 0; else if (target > 255) target = 255;

        // Per-channel gain relative to the original luminance keeps the hue.
        const lum = gray[p] || 1;
        const gain = target / lum;
        rgba[i] = rgba[i] * gain;
        rgba[i + 1] = rgba[i + 1] * gain;
        rgba[i + 2] = rgba[i + 2] * gain;
        rgba[i + 3] = 255;
    }

    if (opts.brightness || opts.contrast) applyTone(rgba, buildToneLUT(opts.brightness, opts.contrast));
    return rgba;
}

/**
 * Adaptive black & white (Bradley-Roth). The threshold is the local mean of a
 * window around each pixel, so one half of the page being darker no longer
 * turns it solid black the way a single global threshold does.
 */
export function applyAdaptiveBW(rgba, w, h, opts = {}) {
    const gray = toGray(rgba, w, h);
    const bg = estimateBackground(gray, w, h);
    const flat = new Uint8ClampedArray(w * h);
    for (let p = 0; p < flat.length; p++) {
        const b = bg[p] || 1;
        const v = (gray[p] * 235) / b;
        flat[p] = v > 255 ? 255 : v;
    }

    const sat = integralImage(flat, w, h);
    const radius = Math.max(6, Math.round(Math.max(w, h) / 40));
    // Slider nudges the aggressiveness: darker text vs cleaner background.
    const bias = 1 - (0.15 + (opts.contrast || 0) / 600 - (opts.brightness || 0) / 400);

    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            const p = row + x;
            const mean = rectMean(sat, w, h, x - radius, y - radius, x + radius, y + radius);
            const v = flat[p] < mean * bias ? 0 : 255;
            const i = p * 4;
            rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
        }
    }
    return rgba;
}

export function applyGrayscale(rgba, w, h, opts = {}) {
    const gray = toGray(rgba, w, h);
    const bg = estimateBackground(gray, w, h);
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
        const b = bg[p] || 1;
        let v = (gray[p] * 245) / b;
        if (v > 255) v = 255;
        rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
    }
    if (opts.brightness || opts.contrast) applyTone(rgba, buildToneLUT(opts.brightness, opts.contrast));
    return rgba;
}

export function applyOriginal(rgba, w, h, opts = {}) {
    if (opts.brightness || opts.contrast) applyTone(rgba, buildToneLUT(opts.brightness, opts.contrast));
    return rgba;
}

export function applyFilterToPixels(rgba, w, h, filter, opts = {}) {
    switch (filter) {
        case 'magic':     return applyMagicColor(rgba, w, h, opts);
        case 'bw':        return applyAdaptiveBW(rgba, w, h, opts);
        case 'grayscale': return applyGrayscale(rgba, w, h, opts);
        default:          return applyOriginal(rgba, w, h, opts);
    }
}

/* ================================================================== */
/* 6. Rotation                                                         */
/* ================================================================== */

// Rotates raw pixels by a multiple of 90 degrees without touching the DOM,
// so the worker can do it too.
export function rotatePixels(rgba, w, h, degrees) {
    const deg = ((degrees % 360) + 360) % 360;
    if (deg === 0) return { data: rgba, width: w, height: h };
    const swap = deg === 90 || deg === 270;
    const ow = swap ? h : w;
    const oh = swap ? w : h;
    const out = new Uint8ClampedArray(ow * oh * 4);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            // Output dimensions are swapped for 90/270, so every index below is
            // expressed in output space (ow x oh), never in source space.
            let ox, oy;
            if (deg === 90)       { ox = ow - 1 - y; oy = x; }
            else if (deg === 180) { ox = ow - 1 - x; oy = oh - 1 - y; }
            else                  { ox = y;          oy = oh - 1 - x; }
            const si = (y * w + x) * 4;
            const di = (oy * ow + ox) * 4;
            out[di] = rgba[si];
            out[di + 1] = rgba[si + 1];
            out[di + 2] = rgba[si + 2];
            out[di + 3] = 255;
        }
    }
    return { data: out, width: ow, height: oh };
}
