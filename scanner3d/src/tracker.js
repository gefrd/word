// Marker detection → 2D/3D correspondences → camera pose.

import { AR } from './vendor/aruco.js';
import { markerWorldCorners, isBoardMarker } from './board.js';
import { solvePose, projectPoint } from './geometry.js';

let detector = null;
function getDetector() {
    // Hamming tolerance 4 (of 12) keeps false positives on busy tables rare.
    if (!detector) detector = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12', maxHammingDistance: 4 });
    return detector;
}

/**
 * Detect board markers in an RGBA image. `scale` maps detection-image pixels
 * back to full-resolution pixels (detection can run on a downscaled copy for
 * speed on slow phones).
 */
export function detectMarkers(imageData, scale = 1) {
    const found = getDetector().detect(imageData);
    const world = [], image = [], ids = [];
    for (const m of found) {
        if (!isBoardMarker(m.id)) continue;
        const wc = markerWorldCorners(m.id);
        for (let k = 0; k < 4; k++) {
            world.push(wc[k]);
            image.push([m.corners[k].x * scale, m.corners[k].y * scale]);
        }
        ids.push(m.id);
    }
    return { ids, world, image };
}

/**
 * Pose from correspondences with outlier-marker rejection: if one marker's
 * corners disagree strongly (mis-detection, motion blur), drop it and retry.
 */
export function poseFromDetections(det, f, width, height) {
    if (det.ids.length < 2) return null;
    const cx = width / 2, cy = height / 2;
    let world = det.world, image = det.image, ids = det.ids;
    for (let round = 0; round < 3; round++) {
        const pose = solvePose(world, image, f, cx, cy);
        if (!pose) return null;
        // per-marker error
        const errs = ids.map((_, i) => {
            let e = 0;
            for (let k = 0; k < 4; k++) {
                const p = projectPoint(pose.R, pose.t, f, cx, cy, world[i * 4 + k]);
                e += Math.hypot(p[0] - image[i * 4 + k][0], p[1] - image[i * 4 + k][1]);
            }
            return e / 4;
        });
        const worst = errs.indexOf(Math.max(...errs));
        const tol = Math.max(3, 0.004 * Math.max(width, height));
        if (errs[worst] <= tol || ids.length <= 2) {
            return { ...pose, markers: ids.length, maxMarkerErr: errs[worst] };
        }
        world = world.filter((_, j) => Math.floor(j / 4) !== worst);
        image = image.filter((_, j) => Math.floor(j / 4) !== worst);
        ids = ids.filter((_, i) => i !== worst);
    }
    return null;
}

/** Azimuth (deg, 0..360) and elevation (deg) of the camera around the sheet centre. */
export function viewAngles(pose) {
    const { R, t } = pose;
    const C = [
        -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
        -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
        -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
    ];
    const az = (Math.atan2(C[1], C[0]) * 180 / Math.PI + 360) % 360;
    const el = Math.atan2(C[2], Math.hypot(C[0], C[1])) * 180 / Math.PI;
    return { az, el, dist: Math.hypot(C[0], C[1], C[2]), C };
}
