// Photo texture for the scanned mesh: instead of one colour per vertex
// (blurry), every triangle gets the pixels of the photo that sees it best —
// straight on, close, not hidden. Neighbouring triangles that chose the same
// photo form a "chart"; each chart is a crop of that photo, packed into one
// texture atlas (a projective texture atlas).
//
// Streams one photo at a time, so memory stays small on 2 GB phones.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function camCentre(R, t) {
    return [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
}

/** Project the mesh vertices into a view (pixels at width×height). */
function projectAll(pos, v, width, height) {
    const n = pos.length / 3, uv = new Float32Array(n * 2), z = new Float32Array(n);
    const { R, t } = v, f = v.f * width / v.width;
    for (let i = 0; i < n; i++) {
        const X = pos[3 * i], Y = pos[3 * i + 1], Z = pos[3 * i + 2];
        const zc = R[6] * X + R[7] * Y + R[8] * Z + t[2];
        z[i] = zc;
        uv[2 * i] = f * (R[0] * X + R[1] * Y + R[2] * Z + t[0]) / zc + width / 2;
        uv[2 * i + 1] = f * (R[3] * X + R[4] * Y + R[5] * Z + t[1]) / zc + height / 2;
    }
    return { uv, z };
}

/** Depth buffer of the mesh in one view (small software rasteriser). */
function depthBuffer(idx, p, W, H) {
    const zb = new Float32Array(W * H).fill(Infinity);
    const { uv, z } = p;
    for (let k = 0; k < idx.length; k += 3) {
        const a = idx[k], b = idx[k + 1], c = idx[k + 2];
        if (z[a] <= 1 || z[b] <= 1 || z[c] <= 1) continue;
        const ax = uv[2 * a], ay = uv[2 * a + 1], bx = uv[2 * b], by = uv[2 * b + 1], cx = uv[2 * c], cy = uv[2 * c + 1];
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(area) < 1e-9 || x1 < x0 || y1 < y0) continue;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
            const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;
            const zz = w0 * z[a] + w1 * z[b] + w2 * z[c];
            const i = y * W + x;
            if (zz < zb[i]) zb[i] = zz;
        }
    }
    return zb;
}

/**
 * @param mesh   { positions, indices, normals, colors } (object frame, mm)
 * @param views  [{ R, t, f, width, height }] (f in pixels at width×height)
 * @param getFrame(k, longSide) → { rgba, width, height }
 * @returns { positions, indices, uvs, atlas: { data, width, height }, charts, textured }
 */
export async function bakeTexture(mesh, views, getFrame, opts = {}) {
    const report = opts.onProgress || (() => {});
    const { positions: pos, indices: idx, colors } = mesh;
    const nt = idx.length / 3;
    const S = opts.atlasSize || 2048, srcSide = opts.srcSide || 1280;
    // --- 1. per-triangle best view (straight on × close × visible)
    const ZW = 256;
    const tn = new Float32Array(nt * 3), tc = new Float32Array(nt * 3);
    for (let k = 0; k < nt; k++) {
        const a = idx[3 * k] * 3, b = idx[3 * k + 1] * 3, c = idx[3 * k + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        tn[3 * k] = nx / l; tn[3 * k + 1] = ny / l; tn[3 * k + 2] = nz / l;
        tc[3 * k] = (pos[a] + pos[b] + pos[c]) / 3; tc[3 * k + 1] = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3; tc[3 * k + 2] = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    }
    const score = new Float32Array(nt * views.length);
    views.forEach((v, vi) => {
        const zh = Math.round(ZW * v.height / v.width);
        const p = projectAll(pos, v, ZW, zh);
        const zb = depthBuffer(idx, p, ZW, zh);
        const C = camCentre(v.R, v.t);
        const fz = v.f * ZW / v.width;
        for (let k = 0; k < nt; k++) {
            const d = [C[0] - tc[3 * k], C[1] - tc[3 * k + 1], C[2] - tc[3 * k + 2]];
            const dl = Math.hypot(d[0], d[1], d[2]);
            const facing = dot([tn[3 * k], tn[3 * k + 1], tn[3 * k + 2]], d) / dl;
            if (facing < 0.35) continue;  // grazing views stretch the pixels
            let vis = 0;
            for (let q = 0; q < 3; q++) {
                const i = idx[3 * k + q];
                const x = p.uv[2 * i], y = p.uv[2 * i + 1];
                if (!(x >= 1 && y >= 1 && x < ZW - 1 && y < zh - 1)) { vis = -9; break; }
                const zz = zb[(y | 0) * ZW + (x | 0)];
                // a few mm of slack: the rasteriser is coarse
                if (p.z[i] <= zz + Math.max(3, p.z[i] * 0.012)) vis++;
            }
            if (vis < 3) continue;
            // straight on and close = more real pixels on the triangle
            score[k * views.length + vi] = facing * facing * facing * (fz / dl);
        }
        report('texture', 0.3 * (vi + 1) / views.length);
    });
    const best = new Int32Array(nt).fill(-1);
    for (let k = 0; k < nt; k++) {
        let bs = 0;
        for (let vi = 0; vi < views.length; vi++) { const s = score[k * views.length + vi]; if (s > bs) { bs = s; best[k] = vi; } }
    }
    // --- 2. smooth the choice: fewer, bigger charts = fewer seams
    const edgeMap = new Map(), nbr = Array.from({ length: nt }, () => []);
    for (let k = 0; k < nt; k++) for (let q = 0; q < 3; q++) {
        const a = idx[3 * k + q], b = idx[3 * k + (q + 1) % 3];
        const key = a < b ? a * 4194304 + b : b * 4194304 + a;
        const o = edgeMap.get(key);
        if (o === undefined) edgeMap.set(key, k); else { nbr[k].push(o); nbr[o].push(k); }
    }
    for (let it = 0; it < 3; it++) {
        for (let k = 0; k < nt; k++) {
            if (best[k] < 0) continue;
            const cnt = new Map();
            for (const o of nbr[k]) if (best[o] >= 0) cnt.set(best[o], (cnt.get(best[o]) || 0) + 1);
            let mv = best[k], mc = 0;
            for (const [v, c] of cnt) if (c > mc) { mc = c; mv = v; }
            if (mv !== best[k] && mc >= 2 && score[k * views.length + mv] >= 0.6 * score[k * views.length + best[k]]) best[k] = mv;
        }
    }
    // --- 3. charts: connected triangles with the same photo
    const chartOf = new Int32Array(nt).fill(-1);
    const charts = [];
    for (let k = 0; k < nt; k++) {
        if (chartOf[k] >= 0 || best[k] < 0) continue;
        const id = charts.length, stack = [k], tris = [];
        chartOf[k] = id;
        while (stack.length) {
            const q = stack.pop(); tris.push(q);
            for (const o of nbr[q]) if (chartOf[o] < 0 && best[o] === best[k]) { chartOf[o] = id; stack.push(o); }
        }
        charts.push({ view: best[k], tris });
    }
    // chart rectangles in source-photo pixels
    const srcSize = views.map(v => ({ w: Math.round(v.width * srcSide / Math.max(v.width, v.height)), h: Math.round(v.height * srcSide / Math.max(v.width, v.height)) }));
    const proj = new Map();
    const projOf = (vi) => { if (!proj.has(vi)) proj.set(vi, projectAll(pos, views[vi], srcSize[vi].w, srcSize[vi].h)); return proj.get(vi); };
    for (const ch of charts) {
        const p = projOf(ch.view);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const k of ch.tris) for (let q = 0; q < 3; q++) {
            const i = idx[3 * k + q];
            x0 = Math.min(x0, p.uv[2 * i]); x1 = Math.max(x1, p.uv[2 * i]); y0 = Math.min(y0, p.uv[2 * i + 1]); y1 = Math.max(y1, p.uv[2 * i + 1]);
        }
        const pad = 2;
        ch.rx = Math.floor(x0) - pad; ch.ry = Math.floor(y0) - pad;
        ch.rw = Math.ceil(x1) - ch.rx + pad; ch.rh = Math.ceil(y1) - ch.ry + pad;
    }
    // --- 4. pack the rectangles (shelves), shrinking all of them if needed
    const FALLBACK = 64; // bottom strip for triangles no photo sees (vertex colours)
    const pack = (scale) => {
        const order = charts.map((c, i) => i).sort((a, b) => charts[b].rh - charts[a].rh);
        let x = 0, y = 0, shelf = 0;
        for (const i of order) {
            const c = charts[i], w = Math.max(3, Math.ceil(c.rw * scale)) + 2, h = Math.max(3, Math.ceil(c.rh * scale)) + 2;
            if (w > S) return false;
            if (x + w > S) { x = 0; y += shelf; shelf = 0; }
            if (y + h > S - FALLBACK) return false;
            c.ax = x + 1; c.ay = y + 1; c.as = scale;
            x += w; shelf = Math.max(shelf, h);
        }
        return true;
    };
    let lo = 0.05, hi = 1;
    if (!pack(1)) {
        for (let it = 0; it < 14; it++) { const mid = (lo + hi) / 2; if (pack(mid)) lo = mid; else hi = mid; }
        pack(lo);
    }
    // --- 5. copy pixels, one photo at a time
    const atlas = new Uint8ClampedArray(S * S * 4);
    const used = new Uint8Array(S * S);
    const byView = new Map();
    charts.forEach((c) => { if (!byView.has(c.view)) byView.set(c.view, []); byView.get(c.view).push(c); });
    let done = 0;
    for (const [vi, list] of byView) {
        const fr = await getFrame(vi, srcSide);
        const { rgba, width: W, height: H } = fr;
        const sx = W / srcSize[vi].w, sy = H / srcSize[vi].h;
        const gain = opts.gains ? opts.gains[vi] : [1, 1, 1];
        const pv = projOf(vi);
        const sampleAt = (u, v) => {
            const x0 = Math.max(0, Math.min(W - 2, u | 0)), y0 = Math.max(0, Math.min(H - 2, v | 0)), i = (y0 * W + x0) * 4;
            return [rgba[i], rgba[i + 1], rgba[i + 2]];
        };
        for (const c of list) {
            // level this patch to the smooth multi-photo vertex colours, so
            // patches from photos with other exposure/shade don't show seams
            const ratios = [[], [], []];
            const seen = new Set();
            for (const k of c.tris) for (let q = 0; q < 3; q++) {
                const i = idx[3 * k + q];
                if (seen.has(i) || colors[3 * i] < 0) continue;
                seen.add(i);
                const px = sampleAt(pv.uv[2 * i] * sx, pv.uv[2 * i + 1] * sy);
                for (let ch = 0; ch < 3; ch++) if (px[ch] * gain[ch] > 8) ratios[ch].push(colors[3 * i + ch] * 255 / (px[ch] * gain[ch]));
            }
            const lvl = ratios.map(r => { if (r.length < 3) return 1; r.sort((a, b) => a - b); return Math.min(1.6, Math.max(0.6, r[r.length >> 1])); });
            const g2 = [gain[0] * lvl[0], gain[1] * lvl[1], gain[2] * lvl[2]];
            const w = Math.ceil(c.rw * c.as), h = Math.ceil(c.rh * c.as);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const u = (c.rx + (x + 0.5) / c.as) * sx - 0.5, v = (c.ry + (y + 0.5) / c.as) * sy - 0.5;
                if (u < 0 || v < 0 || u > W - 1.001 || v > H - 1.001) continue;
                const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, i = (y0 * W + x0) * 4;
                const o = ((c.ay + y) * S + c.ax + x) * 4;
                for (let ch = 0; ch < 3; ch++) {
                    const val = (rgba[i + ch] * (1 - fx) + rgba[i + 4 + ch] * fx) * (1 - fy) + (rgba[i + W * 4 + ch] * (1 - fx) + rgba[i + W * 4 + 4 + ch] * fx) * fy;
                    atlas[o + ch] = val * g2[ch];
                }
                atlas[o + 3] = 255;
                used[(c.ay + y) * S + c.ax + x] = 1;
            }
        }
        report('texture', 0.3 + 0.6 * (++done) / byView.size);
    }
    // --- 6. new mesh: vertices duplicated per chart (each has its own UVs)
    const outPos = [], outUV = [], outIdx = [];
    const remap = new Map();
    const fbTris = [];
    for (let k = 0; k < nt; k++) {
        const c = chartOf[k] >= 0 ? charts[chartOf[k]] : null;
        if (!c) { fbTris.push(k); continue; }
        const p = projOf(c.view);
        for (let q = 0; q < 3; q++) {
            const i = idx[3 * k + q], key = chartOf[k] * 4194304 + i;
            let ni = remap.get(key);
            if (ni === undefined) {
                ni = outPos.length / 3;
                remap.set(key, ni);
                outPos.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
                const ax = c.ax + (p.uv[2 * i] - c.rx) * c.as, ay = c.ay + (p.uv[2 * i + 1] - c.ry) * c.as;
                outUV.push(ax / S, 1 - ay / S);
            }
            outIdx.push(ni);
        }
    }
    // triangles no photo sees: a 2×2 cell of their vertex colour each
    const cells = Math.floor(S / 2);
    fbTris.forEach((k, n) => {
        const cx = (n % cells) * 2, cy = S - FALLBACK + Math.floor(n / cells) * 2;
        if (cy >= S - 1) return;
        let r = 0, g = 0, b = 0;
        for (let q = 0; q < 3; q++) { const i = idx[3 * k + q]; r += colors[3 * i]; g += colors[3 * i + 1]; b += colors[3 * i + 2]; }
        for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
            const o = ((cy + yy) * S + cx + xx) * 4;
            atlas[o] = r / 3 * 255; atlas[o + 1] = g / 3 * 255; atlas[o + 2] = b / 3 * 255; atlas[o + 3] = 255;
            used[(cy + yy) * S + cx + xx] = 1;
        }
        for (let q = 0; q < 3; q++) {
            const i = idx[3 * k + q];
            outIdx.push(outPos.length / 3);
            outPos.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
            outUV.push((cx + 1) / S, 1 - (cy + 1) / S);
        }
    });
    // --- 7. bleed chart borders outwards (no dark seams from filtering/mipmaps)
    for (let pass = 0; pass < 3; pass++) {
        const add = [];
        for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
            const i = y * S + x;
            if (used[i]) continue;
            for (const j of [i - 1, i + 1, i - S, i + S]) if (used[j]) { add.push(i, j); break; }
        }
        for (let q = 0; q < add.length; q += 2) { const i = add[q], j = add[q + 1]; atlas.copyWithin(i * 4, j * 4, j * 4 + 4); used[i] = 1; }
    }
    report('texture', 1);
    return {
        positions: Float32Array.from(outPos), indices: Uint32Array.from(outIdx), uvs: Float32Array.from(outUV),
        atlas: { data: atlas, width: S, height: S }, charts: charts.length, textured: 1 - fbTris.length / nt,
    };
}

/**
 * Per-photo colour gains so all photos agree on the object's colour
 * (phones change exposure and white balance while you walk around).
 * frames: small RGBA frames; masks: { mask, width, height } with FOREGROUND = 2.
 */
export function viewGains(frames, masks) {
    const med = (a) => { const s = Float32Array.from(a).sort(); return s.length ? s[s.length >> 1] : 1; };
    const meds = frames.map((fr, k) => {
        const { rgba, width: w, height: h } = fr, m = masks[k];
        const r = [], g = [], b = [];
        for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
            const mi = Math.min(m.height - 1, Math.floor(y * m.height / h)) * m.width + Math.min(m.width - 1, Math.floor(x * m.width / w));
            if (m.mask[mi] !== 2) continue;
            const i = (y * w + x) * 4; r.push(rgba[i]); g.push(rgba[i + 1]); b.push(rgba[i + 2]);
        }
        return [med(r), med(g), med(b)];
    });
    const all = [0, 1, 2].map(c => med(meds.map(m => m[c])));
    return meds.map(m => [0, 1, 2].map(c => Math.min(1.5, Math.max(0.67, all[c] / Math.max(1, m[c])))));
}
