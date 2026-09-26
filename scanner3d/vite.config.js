import { defineConfig } from 'vite';

// Relative base: the built app works from any folder (e.g. kivu.site/scan3d/)
// and from a PWA/APK WebView.
export default defineConfig({
    base: './',
    worker: { format: 'es' },
    build: { target: 'es2020', chunkSizeWarningLimit: 2000 },
    server: { fs: { allow: ['.'] } },
});
