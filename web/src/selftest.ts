// Renders raw strain values off-screen and compares them with the Rust CPU
// reference (`ModeTable::strain`). Run by opening the page with ?selftest.

import { sliceTo3D, type Camera, type SceneState, type SliceConfig, type StrainView } from "./strainView";
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
  camera: Camera;
  slice: SliceConfig;
}

const plane: SliceConfig = { tilt: 0, azimuth: 0, component: "plus" };
const vertical: SliceConfig = { tilt: Math.PI / 2, azimuth: 0.7, component: "plus" };
const tilted: SliceConfig = { tilt: 0.6, azimuth: -1.1, component: "plus" };

// Inspiral, merger near the source, the burst further out; then vertical and tilted slices.
const FRAMES: Frame[] = [
  { time: -2500, camera: { centerX: 0, centerY: 0, halfWidth: 400 }, slice: plane },
  { time: 20, camera: { centerX: 0, centerY: 0, halfWidth: 60 }, slice: plane },
  { time: 250, camera: { centerX: 150, centerY: -80, halfWidth: 200 }, slice: plane },
  { time: -1800, camera: { centerX: 0, centerY: 0, halfWidth: 300 }, slice: vertical },
  { time: 120, camera: { centerX: -40, centerY: 30, halfWidth: 150 }, slice: vertical },
  { time: -400, camera: { centerX: 30, centerY: -20, halfWidth: 250 }, slice: tilted },
];

export function runSelfTest(
  gl: WebGL2RenderingContext,
  view: StrainView,
  w: PreparedWaveform,
): SelfTestResult {
  if (!gl.getExtension("EXT_color_buffer_float")) {
    throw new Error("Self-test needs EXT_color_buffer_float");
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  const pixels = new Float32Array(W * H * 4);
  let worst = 0;
  let count = 0;
  const perFrame: number[] = [];
  for (const f of FRAMES) {
    const scene: SceneState = { time: f.time, gain: 1, maskRadius: 0, discs: new Float32Array(12) };
    view.draw(scene, f.camera, f.slice, W, H, true);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, pixels);
    let frameWorst = 0;
    const aspect = W / H;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const k = 4 * (py * W + px);
        // Same pixel-centre mapping as the shader (row 0 is the bottom row here).
        const sx = f.camera.centerX + (((px + 0.5) / W) * 2 - 1) * f.camera.halfWidth;
        const sy = f.camera.centerY + (((py + 0.5) / H) * 2 - 1) * (f.camera.halfWidth / aspect);
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
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(tex);
  return { pass: count > 0 && worst < TOLERANCE, worst, perFrame, pixels: count };
}
