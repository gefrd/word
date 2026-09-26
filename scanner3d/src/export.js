// Model export: GLB (for AR / 3D viewers / games), STL (3D printing),
// OBJ (+ vertex colours). Scan units are millimetres with Z up; glTF and
// USDZ want metres with Y up, which also gives AR the object's real size.

import * as THREE from 'three';

/** three.js mesh in glTF conventions (metres, Y up). */
export function buildMesh(model) {
    const { positions, indices, colors } = model;
    const p = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
        p[i] = positions[i] / 1000;
        p[i + 1] = positions[i + 2] / 1000;
        p[i + 2] = -positions[i + 1] / 1000;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    if (colors) {
        // Scans are sampled in sRGB; glTF vertex colours are linear.
        const lin = new Float32Array(colors.length);
        for (let i = 0; i < colors.length; i++) lin[i] = srgbToLinear(colors[i]);
        g.setAttribute('color', new THREE.BufferAttribute(lin, 3));
    }
    if (model.uvs) g.setAttribute('uv', new THREE.BufferAttribute(model.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
        vertexColors: !!colors,
        map: model.texture || null,
        roughness: 0.75,
        metalness: 0,
        side: model.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = model.name || 'Kivu3DScan';
    return mesh;
}

function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export async function exportGLB(mesh) {
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    const buf = await exporter.parseAsync(mesh, { binary: true });
    return new Blob([buf], { type: 'model/gltf-binary' });
}

export async function exportUSDZ(mesh) {
    const { USDZExporter } = await import('three/examples/jsm/exporters/USDZExporter.js');
    const scene = new THREE.Scene();
    scene.add(mesh.clone());
    const arr = await new USDZExporter().parseAsync(scene);
    return new Blob([arr], { type: 'model/vnd.usdz+zip' });
}

/** Binary STL in millimetres, Z up (what slicers expect). */
export function exportSTL(model) {
    const { positions, indices } = model;
    const nt = indices.length / 3;
    const buf = new ArrayBuffer(84 + nt * 50);
    const dv = new DataView(buf);
    const header = 'Kivu 3D Scan (mm)';
    for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
    dv.setUint32(80, nt, true);
    let o = 84;
    for (let t = 0; t < nt; t++) {
        const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        for (const v of [nx, ny, nz]) { dv.setFloat32(o, v, true); o += 4; }
        for (const p of [a, b, c]) for (let k = 0; k < 3; k++) { dv.setFloat32(o, positions[p + k], true); o += 4; }
        o += 2;
    }
    return new Blob([buf], { type: 'model/stl' });
}

/** OBJ with per-vertex colours (MeshLab / Blender extension), millimetres. */
export function exportOBJ(model) {
    const { positions, indices, colors } = model;
    const lines = ['# Kivu 3D Scan (units: mm, Z up)'];
    for (let i = 0; i < positions.length; i += 3) {
        let l = `v ${positions[i].toFixed(2)} ${positions[i + 1].toFixed(2)} ${positions[i + 2].toFixed(2)}`;
        if (colors) l += ` ${colors[i].toFixed(3)} ${colors[i + 1].toFixed(3)} ${colors[i + 2].toFixed(3)}`;
        lines.push(l);
    }
    for (let i = 0; i < indices.length; i += 3) lines.push(`f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}`);
    return new Blob([lines.join('\n')], { type: 'text/plain' });
}

export function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 20000);
}
