// Synthetic scene for automated tests: the marker sheet on a table with a
// known object, rendered from a ring of viewpoints like a phone walk-around.
import * as THREE from 'three';
import { drawBoard, SHEET_W, SHEET_H } from '../src/board.js';

const W = 1280, H = 720;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6b5a4a);

// table with noisy wood-ish texture
const tc = document.createElement('canvas'); tc.width = tc.height = 512;
const tx = tc.getContext('2d'); tx.fillStyle = '#7a5c3e'; tx.fillRect(0, 0, 512, 512);
for (let i = 0; i < 3000; i++) { tx.fillStyle = `rgba(${40 + Math.random() * 60},${25 + Math.random() * 40},10,0.35)`; tx.fillRect(Math.random() * 512, Math.random() * 512, 30 + Math.random() * 80, 2); }
const tableTex = new THREE.CanvasTexture(tc); tableTex.wrapS = tableTex.wrapT = THREE.RepeatWrapping; tableTex.repeat.set(4, 4);
const table = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshStandardMaterial({ map: tableTex, roughness: 0.9 }));
table.position.z = -0.5; table.receiveShadow = true; scene.add(table);

// sheet
const bc = document.createElement('canvas');
const bctx = bc.getContext('2d');
bc.width = SHEET_W * 6; bc.height = SHEET_H * 6;
drawBoard(bctx, 6, { guides: true });
const sheetTex = new THREE.CanvasTexture(bc); sheetTex.colorSpace = THREE.SRGBColorSpace; sheetTex.anisotropy = 8;
const sheet = new THREE.Mesh(new THREE.PlaneGeometry(SHEET_W, SHEET_H), new THREE.MeshStandardMaterial({ map: sheetTex, roughness: 0.95 }));
sheet.receiveShadow = true; scene.add(sheet);

// clutter around (should never become part of the model)
for (let i = 0; i < 6; i++) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(40, 60, 30 + i * 10), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(i / 6, 0.5, 0.5) }));
  const a = i / 6 * Math.PI * 2; b.position.set(Math.cos(a) * 260, Math.sin(a) * 300, 15 + i * 5); b.castShadow = true; scene.add(b);
}

// object: a mug (cylinder + handle) with a ball on a stick — non-trivial shape
const objects = new THREE.Group();
const mugMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.5 });
const body = new THREE.Mesh(new THREE.CylinderGeometry(32, 28, 85, 48), mugMat);
body.rotation.x = Math.PI / 2; body.position.set(-5, -20, 42.5);
const handle = new THREE.Mesh(new THREE.TorusGeometry(20, 6, 16, 32, Math.PI), mugMat);
handle.rotation.set(Math.PI / 2, 0, -Math.PI / 2); handle.position.set(27, -20, 45);
const ball = new THREE.Mesh(new THREE.SphereGeometry(18, 32, 16), new THREE.MeshStandardMaterial({ color: 0x2e86de, roughness: 0.4 }));
ball.position.set(-10, 60, 18);
const cube = new THREE.Mesh(new THREE.BoxGeometry(30, 30, 30), new THREE.MeshStandardMaterial({ color: 0x27ae60 }));
cube.position.set(30, 55, 15); cube.rotation.z = 0.5;
for (const m of [body, handle, ball, cube]) { m.castShadow = true; m.receiveShadow = true; objects.add(m); }
scene.add(objects);

scene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-300, 200, 600); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -300, right: 300, top: 300, bottom: -300, near: 10, far: 2000 });
scene.add(sun);

const camera = new THREE.PerspectiveCamera(50, W / H, 10, 5000);
camera.up.set(0, 0, 1);

function cvPose(cam) {
  cam.updateMatrixWorld(); const m = cam.matrixWorldInverse.elements; // column-major
  // three camera: x right, y up, z back. OpenCV: x right, y down, z forward.
  const R = [m[0], m[4], m[8], -m[1], -m[5], -m[9], -m[2], -m[6], -m[10]];
  const t = [m[12], -m[13], -m[14]];
  return { R, t };
}

// Occupancy ground truth: is point inside the object? (raycast parity)
const ray = new THREE.Raycaster();
function inside(p) {
  ray.set(new THREE.Vector3(...p), new THREE.Vector3(0.123, 0.456, 0.88).normalize());
  const hits = ray.intersectObjects(objects.children, true);
  return hits.length % 2 === 1;
}
window.gtInside = (pts) => { objects.traverse(o => { if (o.material) o.material.side = THREE.DoubleSide; }); const r = pts.map(inside); objects.traverse(o => { if (o.material) o.material.side = THREE.FrontSide; }); return r; };

window.renderViews = (n = 24, opts = {}) => {
  const f = opts.f || 1000;
  camera.fov = 2 * Math.atan(H / 2 / f) * 180 / Math.PI; camera.updateProjectionMatrix();
  const out = [];
  for (let k = 0; k < n; k++) {
    const az = k / n * Math.PI * 2 + 0.3;
    const el = (opts.elevations || [30, 55])[k % (opts.elevations || [30, 55]).length] * Math.PI / 180;
    const d = opts.dist || 450;
    camera.position.set(d * Math.cos(el) * Math.cos(az), d * Math.cos(el) * Math.sin(az), d * Math.sin(el));
    // aim slightly off-centre like a handheld phone, plus a little roll
    camera.lookAt(Math.sin(k) * 15, Math.cos(k * 1.3) * 15, 30);
    camera.rotateZ(Math.sin(k * 0.7) * 0.08);
    renderer.render(scene, camera);
    out.push({ url: renderer.domElement.toDataURL('image/jpeg', 0.9), ...cvPose(camera), f, width: W, height: H });
  }
  return out;
};
window.ready = true;

// A single "product photo": a toy robot on a plain studio background.
window.renderProduct = () => {
  const s2 = new THREE.Scene(); s2.background = new THREE.Color(0xd9d4cc);
  s2.add(new THREE.HemisphereLight(0xffffff, 0x887766, 1.4));
  const l = new THREE.DirectionalLight(0xffffff, 2); l.position.set(-200, 300, 400); l.castShadow = true; s2.add(l);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshStandardMaterial({ color: 0xd9d4cc })); floor.receiveShadow = true; s2.add(floor);
  const robot = new THREE.Group();
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45 });
  const add = (g, m, x, y, z) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = true; robot.add(o); return o; };
  add(new THREE.BoxGeometry(70, 45, 80), mat(0xf39c12), 0, 0, 70);            // body
  add(new THREE.SphereGeometry(28, 32, 16), mat(0x3498db), 0, 0, 140);       // head
  add(new THREE.SphereGeometry(6, 16, 8), mat(0x111111), -10, -25, 145);     // eyes
  add(new THREE.SphereGeometry(6, 16, 8), mat(0x111111), 10, -25, 145);
  const arm = new THREE.CylinderGeometry(8, 8, 70, 16);
  add(arm, mat(0xe74c3c), -48, 0, 70); add(arm, mat(0xe74c3c), 48, 0, 70);
  robot.children.slice(-2).forEach(o => { o.rotation.x = Math.PI / 2; });
  const leg = new THREE.CylinderGeometry(10, 10, 30, 16);
  add(leg, mat(0x2c3e50), -18, 0, 15).rotation.x = Math.PI / 2; add(leg, mat(0x2c3e50), 18, 0, 15).rotation.x = Math.PI / 2;
  s2.add(robot);
  const cam = new THREE.PerspectiveCamera(40, 3 / 4, 10, 5000); cam.up.set(0, 0, 1);
  cam.position.set(60, -330, 170); cam.lookAt(0, 0, 85);
  renderer.setSize(768, 1024); renderer.render(s2, cam);
  const url = renderer.domElement.toDataURL('image/jpeg', 0.92);
  renderer.setSize(W, H);
  return url;
};
