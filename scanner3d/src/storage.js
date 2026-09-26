// Saved models in IndexedDB (GLB + thumbnail). Everything stays on the phone.

const DB = 'k3d_models', STORE = 'models';

function open() {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        const req = fn(store);
        t.oncomplete = () => { db.close(); resolve(req && req.result); };
        t.onerror = () => { db.close(); reject(t.error); };
    });
}

export async function saveModel({ name, glb, thumb, kind, stats }) {
    const id = 'm_' + Date.now();
    await tx('readwrite', s => s.put({ id, name, glb, thumb, kind, stats, created: Date.now() }));
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return id;
}

export async function listModels() {
    try {
        const all = await tx('readonly', s => s.getAll());
        return (all || []).sort((a, b) => b.created - a.created);
    } catch (_) {
        return [];
    }
}

export async function getModel(id) { return tx('readonly', s => s.get(id)); }
export async function deleteModel(id) { return tx('readwrite', s => s.delete(id)); }
