import { defineConfig } from 'vite';

// transformers.js loads the ONNX Runtime .wasm from jsDelivr at run time
// (and the service worker caches it), so the copy Vite emits from
// onnxruntime-web is never requested — drop it to keep the upload small.
const dropUnusedOrtWasm = {
    name: 'drop-unused-ort-wasm',
    generateBundle(_, bundle) {
        for (const name of Object.keys(bundle)) if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
    },
};

// Relative base: the built app works from any folder (e.g. kivu.site/scan3d/)
// and from a PWA/APK WebView.
export default defineConfig({
    base: './',
    plugins: [dropUnusedOrtWasm],
    worker: { format: 'es', plugins: () => [dropUnusedOrtWasm] },
    // Готовый сканер кладём в public/scan3d главного сайта → kivu.site/scan3d/
    build: { target: 'es2020', chunkSizeWarningLimit: 2000, outDir: '../public/scan3d', emptyOutDir: true },
    server: { fs: { allow: ['.'] } },
});
