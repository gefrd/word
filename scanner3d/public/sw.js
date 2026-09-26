// Offline support: cache the app shell on first visit and keep AI model /
// runtime downloads (Hugging Face, jsDelivr) in a separate cache so the
// Photo → 3D mode works without internet after the first run.
const APP = 'k3d-app-v1';
const RUNTIME = 'k3d-runtime-v1';

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(APP).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest', './icon.svg', './demo.glb'])).catch(() => {}));
    self.skipWaiting();
});
self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![APP, RUNTIME].includes(k)).map((k) => caches.delete(k)))));
    self.clients.claim();
});
self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    const heavy = /huggingface\.co|hf\.co|cdn\.jsdelivr\.net|cdn-lfs/.test(url.host);
    if (heavy) {
        // cache-first: models and wasm never change for a given URL
        e.respondWith(caches.open(RUNTIME).then(async (c) => {
            const hit = await c.match(req);
            if (hit) return hit;
            const res = await fetch(req);
            if (res.ok) c.put(req, res.clone());
            return res;
        }));
        return;
    }
    if (url.origin === location.origin) {
        // stale-while-revalidate for the app itself
        e.respondWith(caches.open(APP).then(async (c) => {
            const hit = await c.match(req);
            const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
            return hit || net;
        }));
    }
});
