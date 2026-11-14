// Renders raw strain values off-screen and compares them with the Rust CPU
// reference (`ModeTable::strain`). Run by opening the page with ?selftest.

import * as THREE from "three";
import type { SpacetimeScene } from "./scene3d";
import { sliceTo3D, type Camera, type SliceConfig } from "./slice";
import type { PreparedWaveform } from "./waveform";

export interface SelfTestResult {
  pass: boolean;
  worst: number; // max |GPU − CPU| / peak over all pixels and frames
  perFrame: number[];
  pixels: number;
}

const TOLERANCE = 2e-3;
const W = 64;
const H = 40;

interface Frame {
  time: number;
  view: Camera;
  slice: SliceConfig;
}

const plane: SliceConfig = { tilt: 0, azimuth: 0, component: "plus" };
const vertical: SliceConfig = { tilt: Math.PI / 2, azimuth: 0.7, component: "plus" };
const tilted: SliceConfig = { tilt: 0.6, azimuth: -1.1, component: "plus" };

// Inspiral, merger near the source, the burst further out; then vertical and tilted slices.
const FRAMES: Frame[] = [
  { time: -2500, view: { centerX: 0, centerY: 0, halfWidth: 400 }, slice: plane },
  { time: 20, view: { centerX: 0, centerY: 0, halfWidth: 60 }, slice: plane },
  { time: 250, view: { centerX: 150, centerY: -80, halfWidth: 200 }, slice: plane },
  { time: -1800, view: { centerX: 0, centerY: 0, halfWidth: 300 }, slice: vertical },
  { time: 120, view: { centerX: -40, centerY: 30, halfWidth: 150 }, slice: vertical },
  { time: -400, view: { centerX: 30, centerY: -20, halfWidth: 250 }, slice: tilted },
];

// Volume view: strain at each pixel ray's closest approach to the source, from
// two viewpoints (checks the ray set-up and the shared mode sum off the slices).
const VOLUME_FRAMES: { time: number; eye: [number, number, number] }[] = [
  { time: -400, eye: [500, -650, 420] },
  { time: 80, eye: [-60, 120, 300] },
];

export function runSelfTest(scene: SpacetimeScene, w: PreparedWaveform): SelfTestResult {
  if (!scene.renderer.extensions.has("EXT_color_buffer_float")) {
    throw new Error("Self-test needs EXT_color_buffer_float");
  }
  let worst = 0;
  let count = 0;
  const perFrame: number[] = [];
  for (const f of FRAMES) {
    const pixels = scene.renderRaw(f.time, f.slice, f.view, W, H);
    let frameWorst = 0;
    const aspect = W / H;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const k = 4 * (py * W + px);
        // Pixel centers of the orthographic view (row 0 is the bottom row).
        const sx = f.view.centerX + (((px + 0.5) / W) * 2 - 1) * f.view.halfWidth;
        const sy = f.view.centerY + (((py + 0.5) / H) * 2 - 1) * (f.view.halfWidth / aspect);
        const [x3, y3, z3] = sliceTo3D(f.slice, sx, sy);
        const r = Math.hypot(x3, y3, z3);
        const [hp, hc] = r > 0 ? w.table.strain(x3, y3, z3, f.time - r) : [NaN, NaN];
        const cpuValid = Number.isFinite(hp);
        if (cpuValid !== (pixels[k + 2] === 1)) continue; // boundary pixel, rounding
        if (!cpuValid) continue;
        const err = Math.max(Math.abs(pixels[k] - hp), Math.abs(pixels[k + 1] - hc)) / w.peak;
        frameWorst = Math.max(frameWorst, err);
        count++;
      }
    }
    perFrame.push(frameWorst);
    worst = Math.max(worst, frameWorst);
  }
  const ray = new THREE.Raycaster();
  for (const f of VOLUME_FRAMES) {
    const { pixels, camera } = scene.volume.renderRaw(scene.renderer, f.time, new THREE.Vector3(...f.eye), W, H);
    let frameWorst = 0;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const k = 4 * (py * W + px);
        ray.setFromCamera(new THREE.Vector2(((px + 0.5) / W) * 2 - 1, ((py + 0.5) / H) * 2 - 1), camera);
        const o = ray.ray.origin;
        const d = ray.ray.direction;
        const m = o.clone().addScaledVector(d, -o.dot(d));
        const r = m.length();
        const [hp, hc] = w.table.strain(m.x, m.y, m.z, f.time - r);
        if (!Number.isFinite(hp) || pixels[k + 2] !== 1) continue;
        const err = Math.max(Math.abs(pixels[k] - hp), Math.abs(pixels[k + 1] - hc)) / w.peak;
        frameWorst = Math.max(frameWorst, err);
        count++;
      }
    }
    perFrame.push(frameWorst);
    worst = Math.max(worst, frameWorst);
  }
  return { pass: count > 0 && worst < TOLERANCE, worst, perFrame, pixels: count };
}

/**
 * ?volbench: GPU time of the volume ray march at a few resolutions (a 1-pixel
 * read after each frame forces the GPU to finish). Uses a 3D view of t = -40 M.
 */
export function runVolumeBenchmark(scene: SpacetimeScene, w: PreparedWaveform, cssW: number, cssH: number): string {
  const camera = new THREE.PerspectiveCamera(40, cssW / cssH, 1, 1e5);
  camera.up.set(0, 0, 1);
  camera.position.set(500, -650, 520);
  camera.lookAt(0, 0, 0);
  const px = new Uint8Array(4);
  const gl = scene.renderer.getContext();
  const results: string[] = [];
  const lead = w.volumeRows;
  const configs: [number, number][] = [
    [2, 0.75],
    [lead, 0.5],
    [lead, 0.75],
    [lead, 1.0],
    [w.rows.length / 2, 0.75],
  ];
  for (const [rows, scale] of configs) {
    scene.volume.material.uniforms.u_volumeRows.value = rows;
    const frame = { time: -40, scale: 1.5 / w.peak, maskRadius: 10, component: 0 as const, radius: 360, opacity: 1 };
    const run = () => {
      scene.volume.pass.scale = scale;
      scene.volume.render(scene.renderer, camera, cssW, cssH, frame);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    for (let k = 0; k < 3; k++) run(); // warm up
    const n = 20;
    const start = performance.now();
    for (let k = 0; k < n; k++) run();
    const ms = (performance.now() - start) / n;
    results.push(`${rows} modes ${Math.round(cssW * scale)}×${Math.round(cssH * scale)}: ${ms.toFixed(1)} ms`);
  }
  scene.volume.material.uniforms.u_volumeRows.value = lead;
  return `VOLBENCH ${results.join(", ")}`;
}
