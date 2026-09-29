// AR scan (Android Chrome with ARCore, WebXR "immersive-ar"):
//   1. aim at the floor/table, tap: a box appears there — the field;
//   2. size it with the sliders so the object fits inside, tap Start;
//   3. walk around: a ring of sectors on the floor turns green as each side
//      is captured; frames are taken automatically with the phone's own
//      tracked position (real millimetres), so nothing has to be guessed;
//   4. Done → the frames + poses + box go to the worker.
//
// Needs the WebXR "camera-access" feature (Chrome 107+ on ARCore phones).
// iPhones have no WebXR AR in Safari: the normal no-sheet scan is used there.

import * as THREE from 'three';
import { xrPoseToObject, xrIntrinsics } from './markerless.js';
export { arCaptureSupported, arBlockedByFrame } from './arsupport.js';

const SECTORS = 24;
const MIN_FRAMES = 16, MAX_FRAMES = 44;

/**
 * @param overlay  DOM element shown over the camera (dom-overlay)
 * @param cb       { onState(state), onFrame(blob, meta), onEnd(result) }
 * @returns { session, start(), finish(), setSize(w, d, h) }
 */
export async function startARCapture(overlay, cb = {}) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    document.body.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.04, 0.05, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    reticle.matrixAutoUpdate = false; reticle.visible = false;
    scene.add(reticle);
    // the field: a wire box, bottom on the floor
    const boxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
    const box = new THREE.LineSegments(boxGeo, new THREE.LineBasicMaterial({ color: 0xff8a3d }));
    box.visible = false;
    scene.add(box);
    const size = { w: 0.3, d: 0.3, h: 0.3 };
    // coverage ring: sectors on the floor around the box
    const ring = new THREE.Group();
    const sectorMats = [];
    for (let k = 0; k < SECTORS; k++) {
        const a0 = k / SECTORS * Math.PI * 2, a1 = (k + 0.9) / SECTORS * Math.PI * 2;
        const g = new THREE.RingGeometry(1, 1.12, 4, 1, a0, a1 - a0).rotateX(-Math.PI / 2);
        const m = new THREE.MeshBasicMaterial({ color: 0x777777, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
        sectorMats.push(m);
        ring.add(new THREE.Mesh(g, m));
    }
    ring.visible = false;
    scene.add(ring);

    let session;
    try {
        session = await navigator.xr.requestSession('immersive-ar', {
            requiredFeatures: ['hit-test'],
            optionalFeatures: ['dom-overlay', 'camera-access'],
            domOverlay: { root: overlay },
        });
    } catch (err) {
        renderer.dispose(); renderer.domElement.remove();
        throw err;
    }
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    const enabled = session.enabledFeatures || [];
    const cameraAccess = enabled.includes('camera-access');
    // no DOM overlay (some browsers): taps drive it — place, start, finish
    const domOverlay = enabled.includes('dom-overlay');
    const viewerSpace = await session.requestReferenceSpace('viewer');
    const hitSource = await session.requestHitTestSource({ space: viewerSpace });
    // taps on the overlay's own buttons must not place the box
    // (the overlay root itself fills the screen: only its panels/buttons count)
    overlay.addEventListener('beforexrselect', (e) => {
        if (e.target !== overlay && e.target.closest && e.target.closest('button, input, label, .ar-panel')) e.preventDefault();
    });

    let state = cameraAccess ? 'place' : 'nocamera';
    let floor = null;             // AR world point, metres
    const cells = new Map();      // sector:band → count
    let frames = 0, lastShot = 0, lastPose = null, lastTime = 0, busy = false, fb = null;
    const emit = (extra = {}) => cb.onState && cb.onState({ state, frames, covered: cells.size, sectors: SECTORS * 2, domOverlay, canFinish: frames >= MIN_FRAMES, ...extra });
    emit();

    const controller = renderer.xr.getController(0);
    controller.addEventListener('select', () => {
        if (!domOverlay && state === 'size') { api.start(); return; }
        if (!domOverlay && state === 'scan') { if (frames >= MIN_FRAMES) api.finish(); return; }
        if (state !== 'place' && state !== 'size') return;
        if (!reticle.visible) return;
        const p = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
        floor = [p.x, p.y, p.z];
        box.position.copy(p); ring.position.copy(p);
        box.visible = true;
        applySize();
        state = 'size';
        emit();
    });
    scene.add(controller);

    function applySize() {
        box.scale.set(size.w, size.h, size.d);
        const r = Math.hypot(size.w, size.d) / 2 + 0.06;
        ring.scale.set(r, 1, r);
    }

    /** Read the current camera image (RGBA, top row first). */
    function grabCamera(frame, view) {
        const binding = renderer.xr.getBinding();
        const tex = binding.getCameraImage(view.camera);
        const w = view.camera.width, h = view.camera.height;
        const gl = renderer.getContext();
        if (!fb) fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const px = new Uint8ClampedArray(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        renderer.resetState();
        // GL rows start at the bottom
        const row = w * 4, tmp = new Uint8ClampedArray(row);
        for (let y = 0; y < h >> 1; y++) {
            const a = y * row, b = (h - 1 - y) * row;
            tmp.set(px.subarray(a, a + row)); px.copyWithin(a, b, b + row); px.set(tmp, b);
        }
        return { px, w, h };
    }

    async function encode(px, w, h, longSide = 1280) {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
        const s = Math.min(1, longSide / Math.max(w, h));
        let out = c;
        if (s < 1) { out = document.createElement('canvas'); out.width = Math.round(w * s); out.height = Math.round(h * s); out.getContext('2d').drawImage(c, 0, 0, out.width, out.height); }
        const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', 0.9));
        return { blob, width: out.width };
    }

    renderer.setAnimationLoop((time, frame) => {
        if (!frame) return;
        const ref = renderer.xr.getReferenceSpace();
        if (state === 'place' || state === 'size') {
            const hits = frame.getHitTestResults(hitSource);
            if (hits.length) { reticle.visible = true; reticle.matrix.fromArray(hits[0].getPose(ref).transform.matrix); }
            else reticle.visible = false;
        } else reticle.visible = false;
        if (state === 'scan' && !busy) {
            const pose = frame.getViewerPose(ref);
            if (pose && !pose.emulatedPosition) {
                const view = pose.views[0];
                const cam = view.transform.position;
                // where is the camera around the box? (object frame: x, −z, y up)
                const cx = cam.x - floor[0], cz = cam.z - floor[2], cy = cam.y - floor[1] - size.h / 2;
                const dist = Math.hypot(cx, cy, cz);
                const az = Math.atan2(-cz, cx), el = Math.atan2(cy, Math.hypot(cx, cz)) * 180 / Math.PI;
                const sector = ((Math.floor((az + Math.PI) / (2 * Math.PI) * SECTORS) % SECTORS) + SECTORS) % SECTORS;
                const band = el < 30 ? 0 : 1;
                const key = sector + ':' + band;
                // speed (blur): how far the camera moved since the last frame
                const now = time;
                let speed = 0;
                if (lastPose) speed = Math.hypot(cam.x - lastPose.x, cam.y - lastPose.y, cam.z - lastPose.z) / Math.max(0.016, (now - lastTime) / 1000);
                lastPose = { x: cam.x, y: cam.y, z: cam.z }; lastTime = now;
                // is the box in the picture?
                const proj = view.projectionMatrix;
                const P = new THREE.Matrix4().fromArray(proj).multiply(new THREE.Matrix4().fromArray(view.transform.inverse.matrix));
                const c = new THREE.Vector3(floor[0], floor[1] + size.h / 2, floor[2]).applyMatrix4(P);
                const inView = Math.abs(c.x) < 0.7 && Math.abs(c.y) < 0.7;
                let hint = 'arWalk';
                if (dist < 0.15 || dist > 1.5) hint = dist < 0.15 ? 'arTooClose' : 'arTooFar';
                else if (!inView) hint = 'arAim';
                else if (speed > 0.35) hint = 'arSlow';
                else if (frames >= MAX_FRAMES) hint = 'arFull';
                else if ((cells.get(key) || 0) < 1 && now - lastShot > 350) {
                    busy = true; lastShot = now;
                    const shot = grabCamera(frame, view);
                    const K = xrIntrinsics(proj, shot.w, shot.h);
                    const obj = xrPoseToObject(view.transform.matrix, floor);
                    cells.set(key, (cells.get(key) || 0) + 1);
                    sectorMats[sector].color.set(cells.has(sector + ':0') && cells.has(sector + ':1') ? 0x4cc38a : 0xc9d65a);
                    encode(shot.px, shot.w, shot.h).then(({ blob, width }) => {
                        frames++;
                        cb.onFrame && cb.onFrame(blob, { pose: obj, f: K.f * width / shot.w, imageWidth: width });
                        emit({ hint: 'arGot' });
                        // every side covered: done by itself (tap-driven mode has no Done button)
                        if (!domOverlay && cells.size >= SECTORS * 2 - 4) api.finish();
                    }).finally(() => { busy = false; });
                    hint = 'arGot';
                }
                emit({ hint, elevation: el });
            }
        }
        renderer.render(scene, camera);
    });

    let ended = false;
    session.addEventListener('end', () => {
        ended = true;
        renderer.setAnimationLoop(null);
        hitSource.cancel && hitSource.cancel();
        renderer.dispose();
        renderer.domElement.remove();
        cb.onEnd && cb.onEnd({ state, frames });
    });

    const api = {
        session, domOverlay,
        setSize(w, d, h) { size.w = w; size.d = d; size.h = h; applySize(); },
        start() { if (state !== 'size') return; state = 'scan'; ring.visible = true; emit(); },
        /** The box in the object frame (mm, floor at z = 0, centred). */
        box() { return { x0: -size.w * 500, x1: size.w * 500, y0: -size.d * 500, y1: size.d * 500, z0: 0, z1: size.h * 1000 }; },
        finish() { state = 'done'; emit(); if (!ended) session.end().catch(() => {}); },
        cancel() { state = 'cancel'; if (!ended) session.end().catch(() => {}); },
        get frames() { return frames; },
        get state() { return state; },
    };
    return api;
}
