// Offline support: cache the app shell on first visit and keep AI model /
// runtime downloads (Hugging Face, jsDelivr) in a separate cache so the
// Photo → 3D mode works without internet after the first run.
//
// v2: Cloudflare answers /scan3d/index.html with a 308 to /scan3d/. v1 cached
// that redirected response and served it to the next page load, which the
// browser refuses (white "page might be temporarily down" screen). Pages now
// go network-first and a redirected response is never cached or served.
const APP = 'k3d-app-v2';
const RUNTIME = 'k3d-runtime-v1';

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(APP).then((c) => c.addAll(['./', './manifest.webmanifest', './icon.svg', './demo.glb'])).catch(() => {}));
    self.skipWaiting();
});
self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![APP, RUNTIME].includes(k)).map((k) => caches.delete(k)))));
    self.clients.claim();
});

const cacheable = (res) => res && res.ok && !res.redirected && res.type === 'basic';

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
    if (url.origin !== location.origin) return;
    if (req.mode === 'navigate') {
        // network-first: a fresh index.html always points at existing assets
        e.respondWith(fetch(req).then((res) => {
            if (cacheable(res)) caches.open(APP).then((c) => c.put('./', res.clone()));
            return res;
        }).catch(async () => (await caches.match('./', { cacheName: APP })) || Response.error()));
        return;
    }
    // stale-while-revalidate for assets (hashed names, icons, manifest)
    e.respondWith(caches.open(APP).then(async (c) => {
        const hit = await c.match(req);
        const net = fetch(req).then((res) => { if (cacheable(res)) c.put(req, res.clone()); return res; })
            .catch(() => hit || Response.error());
        return hit || net;
    }));
});
