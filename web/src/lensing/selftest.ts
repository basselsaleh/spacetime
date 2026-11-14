// ?selftest: the GPU ray tracer's escape directions against the Rust reference
// for every pixel of a few views: at spin 0 the exact quadrature
// (crates/physics/src/geodesic.rs), with spin the fine-step Mino-time tracer
// (crates/physics/src/kerr.rs, itself checked against a Kerr–Schild
// Hamiltonian integration). ?lensbench: GPU time of the pass at a few
// resolutions and spins.

import * as THREE from "three";
import { rayMatrix } from "../common/rays";
import type { Lens } from "./lens";
import { shadowEdge, shadowExtent } from "./shadow";

const W = 64;
const H = 40;
const TOLERANCE = 1e-3; // rad
const B_CRIT = 3 * Math.sqrt(3);
// Rays this close to the critical curve wind around the photon orbits, where
// float32 error grows without bound; they are skipped. At spin 0: within 2% of
// the critical impact parameter. With spin: within 2% of the shadow's size of
// its exact edge.
const CRITICAL_BAND = 0.02;
const EDGE_POINTS = 1000;

interface View {
  eye: [number, number, number];
  fov: number;
  /** Point looked at (default: the hole). */
  target?: [number, number, number];
  /** Camera up (default +z, the spin axis). */
  up?: [number, number, number];
  /** a/M (default 0). */
  spin?: number;
  /** Use the Kerr integrator at spin 0. */
  kerr?: boolean;
}

/** Camera at distance r and inclination `incl` (degrees from the spin axis), azimuth −80°. */
const at = (r: number, incl: number): [number, number, number] => {
  const t = (incl * Math.PI) / 180;
  const p = (-80 * Math.PI) / 180;
  return [r * Math.sin(t) * Math.cos(p), r * Math.sin(t) * Math.sin(p), r * Math.cos(t)];
};

const SCHWARZSCHILD_VIEWS: View[] = [
  { eye: [0, -20, 3], fov: 60 }, // the default view
  { eye: [7, 4, -3], fov: 75 }, // close in
  // Just outside the photon sphere, looking sideways: the shadow fills ~80° of
  // the view and the escaping rays have wound close to the photon sphere.
  { eye: [3.4, 0.6, 0.5], fov: 90, target: [2.8, 4.0, 0.5] },
  { eye: [60, 40, 30], fov: 30 }, // far away, narrow
];

const VIEWS: View[] = [
  ...SCHWARZSCHILD_VIEWS,
  // The same, through the Kerr integrator at spin 0.
  ...SCHWARZSCHILD_VIEWS.map((v) => ({ ...v, kerr: true })),
  ...[0.5, 0.998].flatMap((spin): View[] => [
    { eye: [0, 0, 40], fov: 40, up: [0, 1, 0], spin }, // on the spin axis
    { eye: at(40, 17), fov: 40, spin }, // the M87 viewing angle
    { eye: at(40, 90), fov: 40, spin }, // equatorial: the D-shape
    { eye: at(5, 90), fov: 90, spin }, // equatorial, close in: strong frame dragging
    { eye: [3.4, 0.6, 0.5], fov: 90, target: [2.8, 4.0, 0.5], spin }, // close, looking sideways
  ]),
];

function camera(v: View, aspect: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(v.fov, aspect, 0.1, 1e4);
  c.up.set(...(v.up ?? [0, 0, 1]));
  c.position.set(...v.eye);
  c.lookAt(...(v.target ?? [0, 0, 0]));
  c.updateMatrixWorld();
  return c;
}

export interface LensSelfTest {
  pass: boolean;
  worst: number;
  perView: { label: string; worst: number }[];
  rays: number;
  skipped: number;
  mismatches: number;
  /** Largest difference (rad) between the readout's shadow size (shadow.ts) and the Rust edge's. */
  readoutError: number;
}

/** Shadow width and height from shadow.ts vs from the Rust edge, for the views with spin. */
function readoutError(wasm: { lensShadowEdge(cam: Float64Array, a: number, n: number): Float64Array }): number {
  let worst = 0;
  for (const v of VIEWS) {
    if (!v.spin) continue;
    const ts = shadowExtent(shadowEdge(v.eye, v.spin, EDGE_POINTS), v.eye);
    const rs = shadowExtent(wasm.lensShadowEdge(Float64Array.from(v.eye), v.spin, EDGE_POINTS), v.eye);
    worst = Math.max(worst, Math.abs(ts.width - rs.width), Math.abs(ts.height - rs.height));
  }
  return worst;
}

function viewLabel(v: View): string {
  return v.spin ? `a${v.spin}` : v.kerr ? "K0" : "S0";
}

export async function runLensSelfTest(renderer: THREE.WebGLRenderer, lens: Lens): Promise<LensSelfTest> {
  const wasm = await import("../wasm/spacetime_wasm.js");
  await wasm.default();
  if (!renderer.extensions.has("EXT_color_buffer_float")) throw new Error("Self-test needs EXT_color_buffer_float");
  let worst = 0;
  let rays = 0;
  let skipped = 0;
  let mismatches = 0;
  const perView: { label: string; worst: number }[] = [];
  for (const v of VIEWS) {
    const cam = camera(v, W / H);
    lens.spin = v.spin ?? 0;
    lens.forceKerr = v.kerr ?? false;
    const gpu = lens.renderRaw(renderer, cam, W, H);
    lens.spin = 0;
    lens.forceKerr = false;
    // The same rays the shader builds (pixel centers; row 0 at the bottom).
    const basis = rayMatrix(cam);
    const dirs = new Float64Array(W * H * 3);
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const d = new THREE.Vector3(((px + 0.5) / W) * 2 - 1, ((py + 0.5) / H) * 2 - 1, 1).applyMatrix3(basis).normalize();
        dirs.set([d.x, d.y, d.z], 3 * (py * W + px));
      }
    }
    const spin = v.spin ?? 0;
    const eyeArr = Float64Array.from(v.eye);
    const cpu = spin > 0 ? wasm.lensKerrEscapeDirections(eyeArr, spin, dirs) : wasm.lensEscapeDirections(eyeArr, dirs);
    const nearCritical = spin > 0 ? nearEdge(wasm.lensShadowEdge(eyeArr, spin, EDGE_POINTS), v.eye) : nearBCrit(v.eye);
    let viewWorst = 0;
    for (let k = 0; k < W * H; k++) {
      if (nearCritical(dirs[3 * k], dirs[3 * k + 1], dirs[3 * k + 2])) {
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
    perView.push({ label: viewLabel(v), worst: viewWorst });
    worst = Math.max(worst, viewWorst);
  }
  const readout = readoutError(wasm);
  return {
    // The edge's ends (where the photons' polar motion vanishes) take a square root of a
    // number near zero, so rounding (1e-16) shows up as ~1e-8 rad; the readout shows 0.1°.
    pass: mismatches === 0 && rays > 0 && worst < TOLERANCE && readout < 1e-7,
    worst,
    perView,
    rays,
    skipped,
    mismatches,
    readoutError: readout,
  };
}

type Test = (x: number, y: number, z: number) => boolean;

/** Spin 0: whether a ray's impact parameter is within the band of the critical one. */
function nearBCrit(eye: [number, number, number]): Test {
  const e = new THREE.Vector3(...eye);
  const r0 = e.length();
  const n = e.clone().normalize();
  const d = new THREE.Vector3();
  return (x, y, z) => {
    const sinPsi = d.set(x, y, z).cross(n).length();
    const b = (r0 * sinPsi) / Math.sqrt(1 - 2 / r0);
    return Math.abs(b - B_CRIT) < CRITICAL_BAND * B_CRIT;
  };
}

/** With spin: whether a ray is within the band (a fraction of the shadow's size) of the exact edge. */
function nearEdge(edge: Float64Array, eye: [number, number, number]): Test {
  const c = new THREE.Vector3(...eye).normalize().negate();
  let size = 0;
  for (let i = 0; i < edge.length; i += 3) {
    size = Math.max(size, Math.acos(Math.min(1, c.x * edge[i] + c.y * edge[i + 1] + c.z * edge[i + 2])));
  }
  const cosBand = Math.cos(CRITICAL_BAND * size);
  return (x, y, z) => {
    for (let i = 0; i < edge.length; i += 3) {
      if (x * edge[i] + y * edge[i + 1] + z * edge[i + 2] > cosBand) return true;
    }
    return false;
  };
}

export function runLensBenchmark(renderer: THREE.WebGLRenderer, lens: Lens, cssW: number, cssH: number): string {
  const cam = camera(SCHWARZSCHILD_VIEWS[0], cssW / cssH);
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  lens.pass.fixedScale = true;
  const out: string[] = [];
  const cases = [
    { label: "a=0 planar", spin: 0, kerr: false },
    { label: "a=0 Kerr", spin: 0, kerr: true },
    { label: "a=0.5", spin: 0.5, kerr: false },
    { label: "a=0.998", spin: 0.998, kerr: false },
  ];
  for (const c of cases) {
    lens.spin = c.spin;
    lens.forceKerr = c.kerr;
    const times: string[] = [];
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
      times.push(`${Math.round(cssW * scale)}×${Math.round(cssH * scale)} ${((performance.now() - start) / n).toFixed(1)} ms`);
    }
    out.push(`${c.label}: ${times.join(", ")}`);
  }
  lens.spin = 0;
  lens.forceKerr = false;
  return `LENSBENCH ${out.join("; ")}`;
}
