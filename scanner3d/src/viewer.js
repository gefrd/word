// 3D viewer with touch orbit, plus three AR paths:
//  1. WebXR immersive-ar with hit-test (Android Chrome + ARCore, e.g. Pixel)
//  2. AR Quick Look via USDZ (iPhone / iPad Safari)
//  3. "AR-lite": camera feed + gyroscope-driven overlay — works on any phone
//     with a camera, including ones without ARCore.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { exportUSDZ } from './export.js';

export class Viewer {
    constructor(container) {
        this.container = container;
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.shadowMap.enabled = true;
        container.appendChild(this.renderer.domElement);
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(40, 1, 0.005, 50);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.autoRotate = true;
        this.controls.autoRotateSpeed = 1.2;
        this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(1, 2, 1.5); key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        this.key = key;
        this.scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.5);
        fill.position.set(-1.5, 0.8, -1);
        this.scene.add(fill);
        this.ground = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.ShadowMaterial({ opacity: 0.25 }));
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.receiveShadow = true;
        this.scene.add(this.ground);
        this.object = null;
        this._resize = () => this.resize();
        window.addEventListener('resize', this._resize);
        this.resize();
        this.running = true;
        this.renderer.setAnimationLoop(() => {
            if (!this.running) return;
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        });
    }

    resize() {
        const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
        this.renderer.setSize(w, h, false);
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    setObject(mesh) {
        if (this.object) {
            this.scene.remove(this.object);
            this.object.geometry.dispose();
            this.object.material.dispose();
        }
        this.object = mesh;
        mesh.castShadow = true;
        this.scene.add(mesh);
        mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z) * 0.75 || 0.1;
        this.ground.scale.setScalar(radius * 3);
        this.ground.position.set(center.x, box.min.y, center.z);
        this.controls.target.copy(center);
        this.camera.position.set(center.x + radius * 1.8, center.y + radius * 1.2, center.z + radius * 2.2);
        this.camera.near = radius / 100; this.camera.far = radius * 100;
        this.camera.updateProjectionMatrix();
        this.key.position.set(center.x + radius * 2, center.y + radius * 4, center.z + radius * 3);
        this.key.target.position.copy(center);
        this.key.shadow.camera.left = this.key.shadow.camera.bottom = -radius * 2;
        this.key.shadow.camera.right = this.key.shadow.camera.top = radius * 2;
        this.key.shadow.camera.updateProjectionMatrix();
        this.controls.autoRotate = true;
        return { size };
    }

    dispose() {
        this.running = false;
        this.renderer.setAnimationLoop(null);
        window.removeEventListener('resize', this._resize);
        if (this.object) { this.object.geometry.dispose(); this.object.material.dispose(); }
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }
}

// ---------- AR capability detection ----------

export async function arSupport() {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let webxr = false;
    try { webxr = !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')); } catch (_) { webxr = false; }
    const quickLook = isIOS && (() => { const a = document.createElement('a'); return a.relList && a.relList.supports && a.relList.supports('ar'); })();
    const camera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    return { webxr, quickLook: !!quickLook, lite: camera, isIOS };
}

// ---------- iOS AR Quick Look ----------

export async function openQuickLook(mesh) {
    const blob = await exportUSDZ(mesh);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.rel = 'ar';
    a.href = url;
    // Quick Look requires the anchor to contain an image element.
    a.appendChild(document.createElement('img'));
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
}

// ---------- WebXR AR (Android ARCore) ----------

export async function startWebXR(mesh, overlayRoot, onEnd) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x666677, 2));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2); dl.position.set(0.5, 1, 0.3); scene.add(dl);

    const obj = mesh.clone();
    obj.visible = false;
    scene.add(obj);
    // Reticle shows where the object will be placed.
    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.04, 0.05, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    reticle.matrixAutoUpdate = false; reticle.visible = false;
    scene.add(reticle);

    const session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay'],
        domOverlay: overlayRoot ? { root: overlayRoot } : undefined,
    });
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
    const viewerSpace = await session.requestReferenceSpace('viewer');
    const hitSource = await session.requestHitTestSource({ space: viewerSpace });
    const controller = renderer.xr.getController(0);
    controller.addEventListener('select', () => {
        if (!reticle.visible) return;
        obj.position.setFromMatrixPosition(reticle.matrix);
        obj.visible = true;
    });
    scene.add(controller);

    renderer.setAnimationLoop((t, frame) => {
        if (frame) {
            const hits = frame.getHitTestResults(hitSource);
            const ref = renderer.xr.getReferenceSpace();
            if (hits.length) {
                const pose = hits[0].getPose(ref);
                reticle.visible = true;
                reticle.matrix.fromArray(pose.transform.matrix);
            } else reticle.visible = false;
        }
        renderer.render(scene, camera);
    });
    session.addEventListener('end', () => {
        renderer.setAnimationLoop(null);
        hitSource.cancel && hitSource.cancel();
        renderer.dispose();
        renderer.domElement.remove();
        obj.geometry && obj.geometry !== mesh.geometry && obj.geometry.dispose();
        onEnd && onEnd();
    });
    return session;
}

// ---------- AR-lite (any phone) ----------

/**
 * Camera feed with the model floating in front of it. The phone's gyroscope
 * turns the virtual camera so the object stays put as you look around (3-DoF,
 * no surface tracking). Drag to rotate, pinch to resize.
 */
export async function startARLite(mesh, root, onEnd) {
    const wrap = document.createElement('div');
    wrap.className = 'arlite';
    const video = document.createElement('video');
    video.playsInline = true; video.muted = true; video.autoplay = true;
    wrap.appendChild(video);
    root.appendChild(wrap);
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
        wrap.remove();
        throw new Error('Camera permission is needed for AR.');
    }
    video.srcObject = stream;
    await video.play().catch(() => {});

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    wrap.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 20);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.8));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2); dl.position.set(0.3, 1, 0.6); scene.add(dl);

    const obj = mesh.clone();
    obj.geometry.computeBoundingBox();
    const bb = obj.geometry.boundingBox, size = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
    const holder = new THREE.Group();
    obj.position.set(-c.x, -bb.min.y, -c.z);
    holder.add(obj);
    // soft contact shadow
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(Math.max(size.x, size.z) * 0.7, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
    holder.add(shadow);
    const dist = Math.max(0.35, Math.max(size.x, size.y, size.z) * 3);
    holder.position.set(0, -0.15 * dist, -dist); // in front of the viewer, a bit below eye level
    scene.add(holder);

    const resize = () => {
        const w = wrap.clientWidth, h = wrap.clientHeight;
        renderer.setSize(w, h);
        camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);

    // Gyroscope → camera orientation (world-locked object).
    const q0 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // look out the back of the phone
    const euler = new THREE.Euler();
    const qScreen = new THREE.Quaternion();
    const zee = new THREE.Vector3(0, 0, 1);
    let baseYaw = null, orientation = null;
    const onOrient = (e) => { if (e.alpha != null) orientation = e; };
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try { await DeviceOrientationEvent.requestPermission(); } catch (_) {}
    }
    window.addEventListener('deviceorientation', onOrient);

    // Touch: one finger rotates the object, two fingers scale it.
    let last = null, pinch = null, scale = 1;
    const el = renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => { last = { x: e.clientX }; });
    el.addEventListener('pointermove', (e) => {
        if (!last || pinch) return;
        holder.rotation.y += (e.clientX - last.x) * 0.01;
        last = { x: e.clientX };
    });
    el.addEventListener('pointerup', () => { last = null; });
    el.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = { d: dist2(e), s: scale }; }, { passive: true });
    el.addEventListener('touchmove', (e) => { if (pinch && e.touches.length === 2) { scale = Math.min(4, Math.max(0.25, pinch.s * dist2(e) / pinch.d)); holder.scale.setScalar(scale); } }, { passive: true });
    el.addEventListener('touchend', () => { pinch = null; }, { passive: true });

    renderer.setAnimationLoop(() => {
        if (orientation) {
            const a = THREE.MathUtils.degToRad(orientation.alpha || 0);
            const b = THREE.MathUtils.degToRad(orientation.beta || 0);
            const g = THREE.MathUtils.degToRad(orientation.gamma || 0);
            const so = THREE.MathUtils.degToRad((screen.orientation && screen.orientation.angle) || window.orientation || 0);
            euler.set(b, a, -g, 'YXZ');
            camera.quaternion.setFromEuler(euler);
            camera.quaternion.multiply(q0);
            camera.quaternion.multiply(qScreen.setFromAxisAngle(zee, -so));
            // Place the object where the phone was pointing when AR started.
            if (baseYaw === null) {
                baseYaw = a;
                const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
                dir.y = 0; dir.normalize();
                holder.position.set(dir.x * dist, -0.25 * dist, dir.z * dist);
                holder.lookAt(0, holder.position.y, 0);
            }
        }
        renderer.render(scene, camera);
    });

    const stop = () => {
        renderer.setAnimationLoop(null);
        window.removeEventListener('resize', resize);
        window.removeEventListener('deviceorientation', onOrient);
        stream.getTracks().forEach(t => t.stop());
        renderer.dispose();
        wrap.remove();
        onEnd && onEnd();
    };
    const close = document.createElement('button');
    close.className = 'arlite-close';
    close.textContent = '✕';
    close.onclick = stop;
    wrap.appendChild(close);
    const hint = document.createElement('div');
    hint.className = 'arlite-hint';
    hint.dataset.i18n = 'arliteHint';
    wrap.appendChild(hint);
    return { stop, hint };
}

function dist2(e) {
    const a = e.touches[0], b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
}
