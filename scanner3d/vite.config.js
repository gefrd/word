import { defineConfig } from 'vite';
import { readFileSync } from 'fs';

// The no-sheet worker loads the ONNX runtime .wasm from the same jsDelivr
// URL transformers.js uses, so both AI modes share one cached copy.
const TF_VERSION = JSON.parse(readFileSync(new URL('./node_modules/@huggingface/transformers/package.json', import.meta.url))).version;

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
    define: { __TRANSFORMERS_VERSION__: JSON.stringify(TF_VERSION) },
    plugins: [dropUnusedOrtWasm],
    worker: { format: 'es', plugins: () => [dropUnusedOrtWasm] },
    // Готовый сканер кладём в public/scan3d главного сайта → kivu.site/scan3d/
    build: { target: 'es2020', chunkSizeWarningLimit: 2000, outDir: '../public/scan3d', emptyOutDir: true },
    // NO_HMR=1 for automated tests: editing files must not reload the test page
    server: { fs: { allow: ['.'] }, hmr: process.env.NO_HMR ? false : undefined },
});
