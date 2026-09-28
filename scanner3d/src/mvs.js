// Dense depth on the phone's GPU (WebGPU): plane-sweep multi-view stereo.
//
// For every pixel of a reference photo, try many depths; at each depth
// project a small 5×5 patch into 4 neighbouring photos and compare
// (zero-mean normalised cross-correlation). The depth where the photos agree
// is the surface. The camera positions are already known, so the depth is
// metric (unlike an AI depth map) and hollows the silhouettes can't see —
// the inside of a cup, the gap between a toy's arm and its body — appear.
//
// Only runs where WebGPU exists (Chrome on most Androids, Safari on iOS 26+);
// elsewhere the scan simply skips this step.

const WGSL = /* wgsl */`
struct Params { W: u32, H: u32, D: u32, nN: u32, half: i32, minTex: f32, p0: f32, p1: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> refImg: array<f32>;
@group(0) @binding(2) var<storage, read> nImg: array<f32>;
@group(0) @binding(3) var<storage, read> cams: array<f32>;   // per neighbour: H (9) + e (3)
@group(0) @binding(4) var<storage, read> range: array<vec2<f32>>; // per pixel near/far depth, 0 = skip
@group(0) @binding(5) var<storage, read_write> outBuf: array<vec4<f32>>;

fn sampleN(n: u32, u: f32, v: f32) -> f32 {
    let W = P.W; let H = P.H;
    if (u < 0.0 || v < 0.0 || u > f32(W) - 1.001 || v > f32(H) - 1.001) { return -1.0; }
    let x0 = u32(floor(u)); let y0 = u32(floor(v));
    let fx = u - f32(x0); let fy = v - f32(y0);
    let base = n * W * H + y0 * W + x0;
    let a = nImg[base]; let b = nImg[base + 1u]; let c = nImg[base + W]; let d = nImg[base + W + 1u];
    return (a * (1.0 - fx) + b * fx) * (1.0 - fy) + (c * (1.0 - fx) + d * fx) * fy;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= P.W || y >= P.H) { return; }
    let idx = y * P.W + x;
    let rg = range[idx];
    let hw = P.half;
    if (rg.x <= 0.0 || i32(x) < hw || i32(y) < hw || i32(x) >= i32(P.W) - hw || i32(y) >= i32(P.H) - hw) { outBuf[idx] = vec4<f32>(0.0, 2.0, 2.0, 0.0); return; }
    // reference patch statistics
    var sr = 0.0; var srr = 0.0; var cnt = 0.0;
    for (var dy = -hw; dy <= hw; dy++) { for (var dx = -hw; dx <= hw; dx++) {
        let v = refImg[u32(i32(y) + dy) * P.W + u32(i32(x) + dx)]; sr += v; srr += v * v; cnt += 1.0;
    } }
    let mr = sr / cnt; let vr = srr / cnt - mr * mr;
    if (vr < P.minTex) { outBuf[idx] = vec4<f32>(0.0, 2.0, 2.0, 0.0); return; } // no texture: can't tell
    var best = 9.0; var bestD = 0.0; var second = 9.0; var bestK = -10;
    let inN = 1.0 / rg.x; let inF = 1.0 / rg.y;
    for (var k = 0u; k < P.D; k++) {
        let depth = 1.0 / mix(inN, inF, (f32(k) + 0.5) / f32(P.D));
        var costs: array<f32, 4>;
        for (var n = 0u; n < P.nN; n++) {
            let o = n * 12u;
            var sn = 0.0; var snn = 0.0; var srn = 0.0; var ok = true;
            for (var dy = -hw; dy <= hw; dy++) { for (var dx = -hw; dx <= hw; dx++) {
                let px = f32(i32(x) + dx); let py = f32(i32(y) + dy);
                let hx = cams[o] * px + cams[o + 1u] * py + cams[o + 2u];
                let hy = cams[o + 3u] * px + cams[o + 4u] * py + cams[o + 5u];
                let hz = cams[o + 6u] * px + cams[o + 7u] * py + cams[o + 8u];
                let qx = depth * hx + cams[o + 9u]; let qy = depth * hy + cams[o + 10u]; let qz = depth * hz + cams[o + 11u];
                if (qz <= 0.0) { ok = false; }
                let s = sampleN(n, qx / qz, qy / qz);
                if (s < 0.0) { ok = false; }
                let rv = refImg[u32(i32(y) + dy) * P.W + u32(i32(x) + dx)];
                sn += s; snn += s * s; srn += rv * s;
            } }
            if (!ok) { costs[n] = 2.0; continue; }
            let mn = sn / cnt; let vn = snn / cnt - mn * mn;
            let cov = srn / cnt - mr * mn;
            costs[n] = 1.0 - cov / sqrt(max(vr * vn, 1e-8));
        }
        // robust: mean of the better half of the neighbours (occlusions)
        for (var i = 0u; i < P.nN; i++) { for (var j = i + 1u; j < P.nN; j++) { if (costs[j] < costs[i]) { let t = costs[i]; costs[i] = costs[j]; costs[j] = t; } } }
        let nUse = max(1u, (P.nN + 1u) / 2u);
        var c = 0.0;
        for (var i = 0u; i < nUse; i++) { c += costs[i]; }
        c = c / f32(nUse);
        if (c < best) {
            if (abs(i32(k) - bestK) > 2) { second = best; }
            best = c; bestD = depth; bestK = i32(k);
        } else if (c < second && abs(i32(k) - bestK) > 2) { second = c; }
    }
    outBuf[idx] = vec4<f32>(bestD, best, second, 0.0);
}
`;

let device = null, pipeline = null;

export async function gpuAvailable() {
    try {
        if (!self.navigator || !navigator.gpu) return false;
        const a = await navigator.gpu.requestAdapter();
        return !!a;
    } catch (_) { return false; }
}

async function getDevice() {
    if (device) return device;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no GPU adapter');
    device = await adapter.requestDevice();
    device.lost.then(() => { device = null; pipeline = null; });
    pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: 'main' } });
    return device;
}

export function releaseGPU() { if (device) { try { device.destroy(); } catch (_) {} } device = null; pipeline = null; }

const mul3 = (A, B) => { const C = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; return C; };
const tr3 = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const mv3 = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
const centre = (v) => mv3(tr3(v.R), v.t).map(x => -x);

/** Neighbours of each view: others that look at the object from 5–40° away. */
export function pickNeighbours(views, target, k = 4) {
    const C = views.map(centre);
    const dir = C.map(c => { const d = [c[0] - target[0], c[1] - target[1], c[2] - target[2]], l = Math.hypot(...d); return d.map(x => x / l); });
    return views.map((_, i) => views.map((__, j) => {
        if (i === j) return null;
        const a = Math.acos(Math.max(-1, Math.min(1, dir[i][0] * dir[j][0] + dir[i][1] * dir[j][1] + dir[i][2] * dir[j][2]))) * 180 / Math.PI;
        return a >= 5 && a <= 40 ? [Math.abs(a - 15), j] : null;
    }).filter(Boolean).sort((a, b) => a[0] - b[0]).slice(0, k).map(e => e[1]));
}

/**
 * Plane-sweep depth for one reference view.
 *   ref:   { R, t, f, width, height, grey (Float32 W×H, 0..1) }
 *   nbrs:  same for up to 4 neighbours (same size)
 *   range: Float32Array W×H×2 (near, far per pixel; 0 = skip)
 * Returns { depth, cost, ratio } (Float32Array W×H each; depth 0 = none).
 */
export async function planeSweep(ref, nbrs, range, opts = {}) {
    const dev = await getDevice();
    const W = ref.width, H = ref.height, D = opts.planes || 80, nN = Math.min(4, nbrs.length);
    const f = ref.f, cx = W / 2, cy = H / 2;
    const K = [f, 0, cx, 0, f, cy, 0, 0, 1], Ki = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
    const camData = new Float32Array(4 * 12);
    const nImg = new Float32Array(Math.max(1, nN) * W * H);
    for (let n = 0; n < nN; n++) {
        const nb = nbrs[n];
        const Rrel = mul3(nb.R, tr3(ref.R));
        const trel = [0, 1, 2].map(k => nb.t[k] - mv3(Rrel, ref.t)[k]);
        const Hm = mul3(mul3(K, Rrel), Ki), e = mv3(K, trel);
        camData.set([...Hm, ...e], n * 12);
        nImg.set(nb.grey, n * W * H);
    }
    const params = new ArrayBuffer(32);
    new Uint32Array(params, 0, 4).set([W, H, D, nN]);
    new Int32Array(params, 16, 1)[0] = opts.half ?? 2;
    new Float32Array(params, 20, 3).set([opts.minTexture ?? 0.0004, 0, 0]);
    const buf = (data, usage) => {
        const b = dev.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
        dev.queue.writeBuffer(b, 0, data);
        return b;
    };
    const S = GPUBufferUsage.STORAGE;
    const bufs = [
        buf(params, GPUBufferUsage.UNIFORM), buf(ref.grey, S), buf(nImg, S), buf(camData, S), buf(range, S),
        dev.createBuffer({ size: W * H * 16, usage: S | GPUBufferUsage.COPY_SRC }),
    ];
    const read = dev.createBuffer({ size: W * H * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bind = dev.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: bufs.map((b, i) => ({ binding: i, resource: { buffer: b } })) });
    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
    pass.end();
    enc.copyBufferToBuffer(bufs[5], 0, read, 0, W * H * 16);
    dev.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    for (const b of [...bufs, read]) b.destroy();
    const depth = new Float32Array(W * H), cost = new Float32Array(W * H), ratio = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) { depth[i] = out[4 * i]; cost[i] = out[4 * i + 1]; ratio[i] = out[4 * i + 2] > 0 ? out[4 * i + 1] / out[4 * i + 2] : 1; }
    return { depth, cost, ratio };
}

/** Keep depths that are confident and that at least `minAgree` neighbour depth maps confirm. */
export function consistencyFilter(maps, views, nbrLists, opts = {}) {
    const tol = opts.tol ?? 0.012, maxCost = opts.maxCost ?? 0.5, maxRatio = opts.maxRatio ?? 0.9, minAgree = opts.minAgree ?? 1;
    return maps.map((m, r) => {
        if (!m) return null;
        const v = views[r], W = v.width, H = v.height, f = v.f;
        const out = new Float32Array(W * H);
        const Rt = tr3(v.R);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x, z = m.depth[i];
            if (!(z > 0) || m.cost[i] > maxCost || m.ratio[i] > maxRatio) continue;
            // world point
            const Xc = [(x - W / 2) / f * z, (y - H / 2) / f * z, z];
            const Xw = mv3(Rt, [Xc[0] - v.t[0], Xc[1] - v.t[1], Xc[2] - v.t[2]]);
            let agree = 0;
            for (const n of nbrLists[r]) {
                const mn = maps[n], vn = views[n];
                if (!mn) continue;
                const q = mv3(vn.R, Xw), zn = q[2] + vn.t[2];
                if (zn <= 0) continue;
                const u = Math.round(vn.f * (q[0] + vn.t[0]) / zn + W / 2), w = Math.round(vn.f * (q[1] + vn.t[1]) / zn + H / 2);
                if (u < 0 || w < 0 || u >= W || w >= H) continue;
                const dn = mn.depth[w * W + u];
                if (dn > 0 && Math.abs(dn - zn) < tol * zn) agree++;
            }
            if (agree >= minAgree) out[i] = z;
        }
        return out;
    });
}
