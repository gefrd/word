// Synthetic scene for the no-sheet (markerless) scan tests: a textured
// object on a wooden table in a room — no marker sheet anywhere.
//   ?obj=sneaker|toy|bottle   which object
//   ?plain=1                  plain untextured object (expected to fail)
// Exposes:
//   renderWalk(n, opts)       frames from a hand-held walk-around (2 loops)
//   renderTurntable(n, opts)  static camera, object turning on a stool
//   recordVideo(mode, opts)   the same as a WebM video (base64)
//   gtInside(points)          ground-truth occupancy (object frame, mm, z up)
// Every frame comes with its ground-truth pose in the object frame and
// (optionally) the true object mask.
import * as THREE from 'three';

const params = new URLSearchParams(location.search);
const OBJ = params.get('obj') || 'sneaker';
const PLAIN = params.get('plain') === '1';
const NOSHADOW = params.get('noshadow') === '1';
let W = 1280, H = 720;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.shadowMap.enabled = !NOSHADOW;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// deterministic random
let seed = 1234567;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 100000) / 100000; };

function noiseTexture(base, n, size = 512, opts = {}) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d');
    x.fillStyle = base; x.fillRect(0, 0, size, size);
    for (let i = 0; i < n; i++) {
        const h = Math.floor(rnd() * 360), l = 25 + rnd() * 50;
        x.fillStyle = `hsla(${h},${opts.sat ?? 60}%,${l}%,${0.5 + rnd() * 0.5})`;
        const kind = rnd();
        const px = rnd() * size, py = rnd() * size, r = 4 + rnd() * (opts.maxR || 26);
        x.beginPath();
        if (kind < 0.4) x.arc(px, py, r, 0, Math.PI * 2);
        else if (kind < 0.7) x.rect(px, py, r * 1.6, r * 0.7);
        else { x.font = `bold ${Math.round(r * 1.5)}px sans-serif`; x.fillText('KIVU3D'[Math.floor(rnd() * 6)], px, py); continue; }
        x.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    return tex;
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb8b0a4);

// room: walls with posters so the background is not empty
const wallMat = new THREE.MeshStandardMaterial({ map: noiseTexture('#cfc6b8', 120, 512, { sat: 30, maxR: 60 }), roughness: 1 });
wallMat.map.repeat.set(3, 1);
const room = new THREE.Mesh(new THREE.CylinderGeometry(2200, 2200, 2400, 32, 1, true), wallMat);
room.material.side = THREE.BackSide; room.rotation.x = Math.PI / 2; room.position.z = 700;
scene.add(room);

// table
const tc = document.createElement('canvas'); tc.width = tc.height = 512;
const tx = tc.getContext('2d'); tx.fillStyle = '#7a5c3e'; tx.fillRect(0, 0, 512, 512);
for (let i = 0; i < 3000; i++) { tx.fillStyle = `rgba(${40 + rnd() * 60},${25 + rnd() * 40},10,0.35)`; tx.fillRect(rnd() * 512, rnd() * 512, 30 + rnd() * 80, 2); }
const tableTex = new THREE.CanvasTexture(tc); tableTex.wrapS = tableTex.wrapT = THREE.RepeatWrapping; tableTex.repeat.set(4, 4); tableTex.colorSpace = THREE.SRGBColorSpace;
const table = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshStandardMaterial({ map: tableTex, roughness: 0.9 }));
table.position.z = -0.5; table.receiveShadow = true; scene.add(table);
// a few things on the table (never part of the model)
for (let i = 0; i < 5; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(50, 70, 40 + i * 12), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(i / 5, 0.5, 0.5) }));
    const a = i / 5 * Math.PI * 2 + 0.5; b.position.set(Math.cos(a) * 420, Math.sin(a) * 460, 20 + i * 6); b.castShadow = true; scene.add(b);
}

// ---------------- objects (object frame: mm, z up, standing on z = 0) --------------
const objects = new THREE.Group();
const mat = (base, n, rep = 1) => {
    if (PLAIN) return new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6 });
    const m = new THREE.MeshStandardMaterial({ map: noiseTexture(base, n), roughness: 0.7 });
    m.map.repeat.set(rep, rep);
    return m;
};
function add(geo, material, pos, rot = [0, 0, 0], scale = [1, 1, 1]) {
    // boxes: a different texture on each face (a real box never repeats one
    // picture on all six sides)
    if (geo.type === 'BoxGeometry' && !PLAIN && material.map) {
        const base = '#' + material.map.image.getContext('2d').getImageData(1, 1, 1, 1).data.slice(0, 3).reduce((a, v) => a + v.toString(16).padStart(2, '0'), '');
        material = Array.from({ length: 6 }, () => mat(base, 260));
    }
    const m = new THREE.Mesh(geo, material);
    m.position.set(...pos); m.rotation.set(...rot); m.scale.set(...scale);
    m.castShadow = true; m.receiveShadow = true;
    objects.add(m);
    return m;
}
if (OBJ === 'sneaker') {
    // sole + upper (squashed capsule) + heel + tongue: about 260 × 100 × 110 mm
    add(new THREE.BoxGeometry(260, 96, 24), mat('#f2efe9', 260), [0, 0, 12]);
    add(new THREE.SphereGeometry(1, 40, 24), mat('#2d6cdf', 320), [10, 0, 44], [0, 0, 0], [118, 46, 40]);
    add(new THREE.CylinderGeometry(40, 44, 70, 32), mat('#d63a3a', 260), [-80, 0, 70], [Math.PI / 2, 0, 0]);
    add(new THREE.BoxGeometry(60, 50, 20), mat('#f0c419', 200), [-30, 0, 95], [0, 0.5, 0]);
} else if (OBJ === 'toy') {
    add(new THREE.BoxGeometry(80, 55, 90), mat('#f39c12', 300), [0, 0, 70]);
    add(new THREE.SphereGeometry(32, 32, 16), mat('#3498db', 260), [0, 0, 145]);
    add(new THREE.CylinderGeometry(10, 10, 80, 16), mat('#e74c3c', 150), [-55, 0, 75], [Math.PI / 2, 0, 0]);
    add(new THREE.CylinderGeometry(10, 10, 80, 16), mat('#e74c3c', 150), [55, 0, 75], [Math.PI / 2, 0, 0]);
    add(new THREE.CylinderGeometry(12, 12, 25, 16), mat('#2c3e50', 120), [-20, 0, 12.5], [Math.PI / 2, 0, 0]);
    add(new THREE.CylinderGeometry(12, 12, 25, 16), mat('#2c3e50', 120), [20, 0, 12.5], [Math.PI / 2, 0, 0]);
} else if (OBJ === 'mug') {
    // open cup (a real hollow) with a handle: Ø 80 mm, 95 mm tall
    const prof = [[0, 0], [40, 0], [40, 95], [35, 95], [35, 7], [0, 7]].map(([r, z]) => new THREE.Vector2(r, z));
    add(new THREE.LatheGeometry(prof, 64), mat('#e8c547', 380), [0, 0, 0], [Math.PI / 2, 0, 0]);
    add(new THREE.TorusGeometry(22, 6, 16, 40, Math.PI), mat('#e8c547', 120), [38, 0, 50], [Math.PI / 2, 0, -Math.PI / 2]);
} else {
    // bottle: body + shoulder + neck + cap, label texture
    add(new THREE.CylinderGeometry(38, 38, 150, 40), mat('#3aa655', 400, 1), [0, 0, 75], [Math.PI / 2, 0, 0]);
    add(new THREE.SphereGeometry(38, 40, 20), mat('#3aa655', 200), [0, 0, 150]);
    add(new THREE.CylinderGeometry(14, 14, 45, 24), mat('#3aa655', 100), [0, 0, 200], [Math.PI / 2, 0, 0]);
    add(new THREE.CylinderGeometry(16, 16, 18, 24), mat('#c0392b', 80), [0, 0, 230], [Math.PI / 2, 0, 0]);
}
scene.add(objects);

// turntable stool (static top under the object, only in turntable mode)
const stoolMat = new THREE.MeshStandardMaterial({ map: noiseTexture('#6d4c33', 80, 256, { sat: 20, maxR: 14 }), roughness: 0.8 });
const stool = new THREE.Group();
const top = new THREE.Mesh(new THREE.CylinderGeometry(190, 190, 30, 48), stoolMat); top.rotation.x = Math.PI / 2; top.position.z = -15.5; top.receiveShadow = true; stool.add(top);
const leg = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 420, 16), stoolMat); leg.rotation.x = Math.PI / 2; leg.position.z = -240; stool.add(leg);
stool.visible = false; scene.add(stool);

scene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(-300, 200, 700); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -400, right: 400, top: 400, bottom: -400, near: 10, far: 3000 });
scene.add(sun);

const camera = new THREE.PerspectiveCamera(50, W / H, 10, 8000);
camera.up.set(0, 0, 1);

function setSize(w, h, f) {
    W = w; H = h;
    renderer.setSize(w, h);
    camera.aspect = w / h; camera.fov = 2 * Math.atan(h / 2 / f) * 180 / Math.PI; camera.updateProjectionMatrix();
}

/** OpenCV-style pose of the camera w.r.t. the object frame. */
function cvPose() {
    camera.updateMatrixWorld(); objects.updateMatrixWorld();
    // object → camera = V · M_obj
    const M = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, objects.matrixWorld);
    const m = M.elements;
    const R = [m[0], m[4], m[8], -m[1], -m[5], -m[9], -m[2], -m[6], -m[10]];
    const t = [m[12], -m[13], -m[14]];
    return { R, t };
}

// Object-only mask render: object white, everything else black.
const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
function maskURL() {
    const bg = scene.background, saved = [];
    scene.background = new THREE.Color(0x000000);
    scene.traverse(o => { if (o.isMesh || o.isLight) { saved.push([o, o.visible]); if (!objects.children.includes(o)) o.visible = false; } });
    const mats = objects.children.map(o => o.material);
    // (array materials are restored below as well)
    objects.children.forEach(o => { o.material = white; o.visible = true; });
    renderer.shadowMap.enabled = false;
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    objects.children.forEach((o, i) => { o.material = mats[i]; });
    saved.forEach(([o, v]) => { o.visible = v; });
    scene.background = bg; renderer.shadowMap.enabled = !NOSHADOW;
    return url;
}

// True depth of the object (mm along the view axis) packed in 24 bits;
// background = 0. Used to imitate a monocular depth network in tests.
const depthMat = new THREE.ShaderMaterial({
    vertexShader: 'varying float vz; void main() { vec4 p = modelViewMatrix * vec4(position, 1.0); vz = -p.z; gl_Position = projectionMatrix * p; }',
    fragmentShader: 'varying float vz; void main() { float v = clamp(vz / 4000.0, 0.0, 1.0) * 16777215.0; float r = floor(v / 65536.0); float g = floor((v - r * 65536.0) / 256.0); float b = v - r * 65536.0 - g * 256.0; gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0); }',
});
depthMat.toneMapped = false;
// all = true: the whole scene (table, clutter) like a phone's depth sensor sees it
function depthURL(all = false) {
    const bg = scene.background, saved = [];
    scene.background = new THREE.Color(0x000000);
    scene.traverse(o => { if (o.isMesh || o.isLight) { saved.push([o, o.visible]); if (!all && !objects.children.includes(o)) o.visible = false; } });
    const drawn = [];
    scene.traverse(o => { if (o.isMesh && (all ? o.visible : objects.children.includes(o))) drawn.push(o); });
    const mats = drawn.map(o => o.material);
    drawn.forEach(o => { o.material = depthMat; o.visible = true; });
    const oe = renderer.outputColorSpace; renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.shadowMap.enabled = false;
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    renderer.outputColorSpace = oe;
    drawn.forEach((o, i) => { o.material = mats[i]; });
    saved.forEach(([o, v]) => { o.visible = v; });
    scene.background = bg; renderer.shadowMap.enabled = !NOSHADOW;
    return url;
}

function walkCamera(u, loops, opts) {
    // u in [0,1): position along the walk; loops at different heights
    const k = Math.min(loops.length - 1, Math.floor(u * loops.length));
    const el = loops[k] * Math.PI / 180;
    const az = u * loops.length * Math.PI * 2 + 0.4;
    const d = (opts.dist || 440) + 25 * Math.sin(u * 17);
    const ctrZ = opts.lookZ ?? 55;
    camera.position.set(d * Math.cos(el) * Math.cos(az), d * Math.cos(el) * Math.sin(az), ctrZ + d * Math.sin(el));
    camera.lookAt(Math.sin(u * 23) * 14, Math.cos(u * 19) * 14, ctrZ);
    camera.rotateZ(Math.sin(u * 11) * 0.05);
}

function turntableCamera(u, opts) {
    const el = (opts.elevation ?? 28) * Math.PI / 180, d = opts.dist || 470, ctrZ = opts.lookZ ?? 55;
    camera.position.set(0, -d * Math.cos(el), ctrZ + d * Math.sin(el));
    camera.lookAt(0, 0, ctrZ);
    objects.rotation.z = u * Math.PI * 2;
    if (params.get('lightrot') === '1') {
        const a = u * Math.PI * 2;
        sun.position.set(-300 * Math.cos(a) - 200 * Math.sin(a), -300 * Math.sin(a) + 200 * Math.cos(a), 700);
    }
}

window.renderWalk = (n = 30, opts = {}) => {
    setSize(opts.w || 1280, opts.h || 720, opts.f || 1000);
    stool.visible = false; table.visible = true; objects.rotation.z = 0;
    const out = [];
    for (let i = 0; i < n; i++) {
        walkCamera(i / n, opts.loops || [25, 45], opts);
        renderer.render(scene, camera);
        out.push({ url: renderer.domElement.toDataURL('image/jpeg', 0.9), ...cvPose(), mask: opts.masks ? maskURL() : null, depth: opts.depthIdx && (opts.depthIdx === 'all' || opts.depthIdx.includes(i)) ? depthURL(!!opts.depthAll) : null });
    }
    return { frames: out, f: opts.f || 1000, width: W, height: H };
};

window.renderTurntable = (n = 30, opts = {}) => {
    setSize(opts.w || 1280, opts.h || 720, opts.f || 1000);
    stool.visible = true; table.visible = true;
    const out = [];
    for (let i = 0; i < n; i++) {
        turntableCamera(i / n, opts);
        renderer.render(scene, camera);
        out.push({ url: renderer.domElement.toDataURL('image/jpeg', 0.9), ...cvPose(), mask: opts.masks ? maskURL() : null, depth: opts.depthIdx && (opts.depthIdx === 'all' || opts.depthIdx.includes(i)) ? depthURL(!!opts.depthAll) : null });
    }
    objects.rotation.z = 0; stool.visible = false;
    return { frames: out, f: opts.f || 1000, width: W, height: H };
};

// Record a video like a phone would (portrait 720×1280 for walk, landscape for turntable).
window.recordVideo = async (mode = 'walk', opts = {}) => {
    const w = opts.w || (mode === 'walk' ? 720 : 1280), h = opts.h || (mode === 'walk' ? 1280 : 720), f = opts.f || 1000;
    setSize(w, h, f);
    stool.visible = mode === 'turntable';
    const stream = renderer.domElement.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 5e6 });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start();
    const seconds = opts.seconds || 30, fps = opts.fps || 8, n = seconds * fps;
    const gt = [];
    for (let i = 0; i < n; i++) {
        const u = i / n;
        if (mode === 'walk') walkCamera(u, opts.loops || [25, 45], opts); else turntableCamera(u, opts);
        renderer.render(scene, camera);
        gt.push({ time: i / fps, ...cvPose() });
        track.requestFrame();
        await new Promise(r => setTimeout(r, 1000 / fps));
    }
    rec.stop(); await new Promise(r => { rec.onstop = r; });
    objects.rotation.z = 0; stool.visible = false;
    const blob = new Blob(chunks, { type: 'video/webm' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192));
    return { b64: btoa(s), gt, f, width: w, height: h };
};

// Ground-truth occupancy in the object frame (raycast parity).
const ray = new THREE.Raycaster();
window.gtInside = (pts) => {
    objects.rotation.z = 0; objects.updateMatrixWorld(true);
    const setSide = (side) => objects.traverse(o => { if (o.material) [].concat(o.material).forEach(m => { m.side = side; }); });
    setSide(THREE.DoubleSide);
    const dir = new THREE.Vector3(0.123, 0.456, 0.88).normalize();
    // inside the union of the parts: odd hit count for at least one part
    const r = pts.map(p => { ray.set(new THREE.Vector3(p[0], p[1], p[2]), dir); return objects.children.some(o => ray.intersectObject(o, false).length % 2 === 1); });
    setSide(THREE.FrontSide);
    return r;
};
window.gtBox = () => { objects.rotation.z = 0; const b = new THREE.Box3().setFromObject(objects); return [b.min.toArray(), b.max.toArray()]; };
window.ready = true;
