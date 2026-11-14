// Renders raw strain values off-screen and compares them with the Rust CPU
// reference (`ModeTable::strain`). Run by opening the page with ?selftest.

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
        // Pixel centres of the orthographic view (row 0 is the bottom row).
        const sx = f.view.centerX + (((px + 0.5) / W) * 2 - 1) * f.view.halfWidth;
        const sy = f.view.centerY + (((py + 0.5) / H) * 2 - 1) * (f.view.halfWidth / aspect);
        const [x3, y3, z3] = sliceTo3D(f.slice, sx, sy);
        const r = Math.hypot(x3, y3, z3);
        const theta = Math.atan2(Math.hypot(x3, y3), z3);
        const phi = Math.atan2(y3, x3);
        const [hp, hc] = w.table.strain(theta, phi, f.time - r);
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
  return { pass: count > 0 && worst < TOLERANCE, worst, perFrame, pixels: count };
}
