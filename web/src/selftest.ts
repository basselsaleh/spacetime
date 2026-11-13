// Renders raw strain values off-screen and compares them with the Rust CPU
// reference (`ModeTable::strain`). Run by opening the page with ?selftest.

import type { StrainView, ViewState } from "./strainView";
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
  // Inspiral, merger near the source, and the merger burst further out.
  const frames: ViewState[] = [
    { centerX: 0, centerY: 0, halfWidth: 400, time: -2500, gain: 1, maskRadius: 0, discs: new Float32Array(12) },
    { centerX: 0, centerY: 0, halfWidth: 60, time: 20, gain: 1, maskRadius: 0, discs: new Float32Array(12) },
    { centerX: 150, centerY: -80, halfWidth: 200, time: 250, gain: 1, maskRadius: 0, discs: new Float32Array(12) },
  ];
  for (const f of frames) {
    let frameWorst = 0;
    view.draw(f, W, H, true);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, pixels);
    const aspect = W / H;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const k = 4 * (py * W + px);
        const x = f.centerX + (((px + 0.5) / W) * 2 - 1) * f.halfWidth;
        const y = f.centerY + (((py + 0.5) / H) * 2 - 1) * (f.halfWidth / aspect);
        const [hp, hc] = w.table.strain(Math.PI / 2, Math.atan2(y, x), f.time - Math.hypot(x, y));
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
