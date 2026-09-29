// Unit test: WebXR camera pose → object frame (xrPoseToObject).
import { xrPoseToObject, xrIntrinsics } from '../src/markerless.js';
const sub = (a, b) => a.map((v, i) => v - b[i]), nrm = (a) => { const l = Math.hypot(...a); return a.map(v => v / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
let fails = 0;
for (const [eye, target, floor] of [[[0.4, 0.3, 0.2], [0.05, 0.1, -0.02], [0.05, 0, -0.02]], [[-0.3, 0.45, -0.35], [0.1, 0.12, 0.1], [0.1, 0.0, 0.1]]]) {
    // WebXR camera looks down −z, y up: columns = right, up, back
    const back = nrm(sub(eye, target)), right = nrm(cross([0, 1, 0], back)), up = cross(back, right);
    const m = [...right, 0, ...up, 0, ...back, 0, ...eye, 1]; // column-major
    const { R, t } = xrPoseToObject(m, floor);
    const proj = [1.5, 0, 0, 0, 0, 1.5 * 16 / 9, 0, 0, 0, 0, -1, -1, 0, 0, -0.02, 0];
    const W = 720, H = 1280, K = xrIntrinsics(proj, W, H);
    const P = (X) => { const x = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0], y = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1], z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2]; return [K.f * x / z + W / 2, K.f * y / z + H / 2, z]; };
    // target in object frame (mm): x, −z, y relative to the floor point
    const Xo = [(target[0] - floor[0]) * 1000, -(target[2] - floor[2]) * 1000, (target[1] - floor[1]) * 1000];
    const c = P(Xo), top = P([Xo[0], Xo[1], Xo[2] + 50]);
    const dist = Math.hypot(...sub(eye, target)) * 1000;
    const ok = Math.abs(c[0] - W / 2) < 0.5 && Math.abs(c[1] - H / 2) < 0.5 && Math.abs(c[2] - dist) < 0.5 && top[1] < c[1];
    console.log(ok ? 'ok ' : 'FAIL', 'centre', c.map(v => v.toFixed(1)).join(','), 'depth', dist.toFixed(1), '| 5 cm higher appears above:', top[1] < c[1]);
    if (!ok) fails++;
}
process.exit(fails ? 1 : 0);
