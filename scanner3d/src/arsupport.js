// Can this phone do the AR scan? (kept tiny: the home screen loads it, the
// AR code itself with three.js loads only when the scan starts)

export async function arCaptureSupported() {
    try { return !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')); } catch (_) { return false; }
}

/**
 * Inside an <iframe> without allow="xr-spatial-tracking" WebXR is blocked,
 * although the phone could do it: then the AR scan opens as a full page.
 */
export function arBlockedByFrame() {
    let framed = false;
    try { framed = window.top !== window.self; } catch (_) { framed = true; }
    if (!framed || !navigator.xr || !/Android/i.test(navigator.userAgent)) return false;
    const fp = document.permissionsPolicy || document.featurePolicy;
    return !(fp && fp.allowsFeature && fp.allowsFeature('xr-spatial-tracking'));
}
