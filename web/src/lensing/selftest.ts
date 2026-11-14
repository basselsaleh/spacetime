// ?selftest: the GPU ray tracer's escape directions against the Rust reference
// (exact quadrature, crates/physics/src/geodesic.rs) for every pixel of a few
// views. ?lensbench: GPU time of the pass at a few resolutions.

import * as THREE from "three";
import { rayMatrix } from "../common/rays";
import type { Lens } from "./lens";

const W = 64;
const H = 40;
const TOLERANCE = 1e-3; // rad
const B_CRIT = 3 * Math.sqrt(3);
// Rays this close to the critical impact parameter wind around the photon
// sphere, where float32 error grows without bound; they are skipped.
const CRITICAL_BAND = 0.02;

interface View {
  eye: [number, number, number];
  fov: number;
  /** Point looked at (default: the hole). */
  target?: [number, number, number];
}

const VIEWS: View[] = [
  { eye: [0, -20, 3], fov: 60 }, // the default view
  { eye: [7, 4, -3], fov: 75 }, // close in
  // Just outside the photon sphere, looking sideways: the shadow fills ~80° of
  // the view and the escaping rays have wound close to the photon sphere.
  { eye: [3.4, 0.6, 0.5], fov: 90, target: [2.8, 4.0, 0.5] },
  { eye: [60, 40, 30], fov: 30 }, // far away, narrow
];

function camera(v: View, aspect: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(v.fov, aspect, 0.1, 1e4);
  c.up.set(0, 0, 1);
  c.position.set(...v.eye);
  c.lookAt(...(v.target ?? [0, 0, 0]));
  c.updateMatrixWorld();
  return c;
}

export interface LensSelfTest {
  pass: boolean;
  worst: number;
  perView: number[];
  rays: number;
  skipped: number;
}

export async function runLensSelfTest(renderer: THREE.WebGLRenderer, lens: Lens): Promise<LensSelfTest> {
  const wasm = await import("../wasm/spacetime_wasm.js");
  await wasm.default();
  if (!renderer.extensions.has("EXT_color_buffer_float")) throw new Error("Self-test needs EXT_color_buffer_float");
  let worst = 0;
  let rays = 0;
  let skipped = 0;
  let mismatches = 0;
  const perView: number[] = [];
  for (const v of VIEWS) {
    const cam = camera(v, W / H);
    const gpu = lens.renderRaw(renderer, cam, W, H);
    // The same rays the shader builds (pixel centres; row 0 at the bottom).
    const basis = rayMatrix(cam);
    const dirs = new Float64Array(W * H * 3);
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const d = new THREE.Vector3(((px + 0.5) / W) * 2 - 1, ((py + 0.5) / H) * 2 - 1, 1).applyMatrix3(basis).normalize();
        dirs.set([d.x, d.y, d.z], 3 * (py * W + px));
      }
    }
    const cpu = wasm.lensEscapeDirections(Float64Array.from(v.eye), dirs);
    const eye = new THREE.Vector3(...v.eye);
    const r0 = eye.length();
    const n = eye.clone().normalize();
    let viewWorst = 0;
    for (let k = 0; k < W * H; k++) {
      const d = new THREE.Vector3(dirs[3 * k], dirs[3 * k + 1], dirs[3 * k + 2]);
      const sinPsi = d.clone().cross(n).length();
      const b = (r0 * sinPsi) / Math.sqrt(1 - 2 / r0);
      if (Math.abs(b - B_CRIT) < CRITICAL_BAND * B_CRIT) {
        skipped++;
        continue;
      }
      const gEsc = gpu[4 * k + 3] > 0.5;
      const cEsc = cpu[4 * k + 3] > 0.5;
      rays++;
      if (gEsc !== cEsc) {
        mismatches++;
        continue;
      }
      if (!gEsc) continue;
      const dot = gpu[4 * k] * cpu[4 * k] + gpu[4 * k + 1] * cpu[4 * k + 1] + gpu[4 * k + 2] * cpu[4 * k + 2];
      const len = Math.hypot(gpu[4 * k], gpu[4 * k + 1], gpu[4 * k + 2]);
      const err = Math.acos(Math.min(1, Math.max(-1, dot / len)));
      viewWorst = Math.max(viewWorst, err);
    }
    perView.push(viewWorst);
    worst = Math.max(worst, viewWorst);
  }
  return { pass: mismatches === 0 && rays > 0 && worst < TOLERANCE, worst: mismatches > 0 ? Infinity : worst, perView, rays, skipped };
}

export function runLensBenchmark(renderer: THREE.WebGLRenderer, lens: Lens, cssW: number, cssH: number): string {
  const cam = camera(VIEWS[0], cssW / cssH);
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  lens.pass.fixedScale = true;
  const out: string[] = [];
  for (const scale of [0.5, 1, 2]) {
    lens.pass.scale = scale;
    const run = () => {
      lens.render(renderer, cam, cssW, cssH);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    for (let k = 0; k < 3; k++) run();
    const n = 20;
    const start = performance.now();
    for (let k = 0; k < n; k++) run();
    out.push(`${Math.round(cssW * scale)}×${Math.round(cssH * scale)}: ${((performance.now() - start) / n).toFixed(1)} ms`);
  }
  return `LENSBENCH ${out.join(", ")}`;
}
