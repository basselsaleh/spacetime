// ?selftest: the app's TypeScript embedding (embedding.ts) against the Rust
// reference (crates/physics/src/embedding.rs, through wasm) and against Flamm's
// closed forms, on radii from the horizon out to 100 M.

import { profile, schwarzschild } from "./embedding";

const TOLERANCE = 1e-9;

export interface SelfTestResult {
  pass: boolean;
  /** Worst relative error vs Rust: height, distance, curvature. */
  vsRust: [number, number, number];
  /** Worst relative error vs the closed forms. */
  vsClosed: [number, number, number];
  samples: number;
}

/** |a − b| relative to max(|b|, floor). */
const rel = (a: number, b: number, floor: number) => Math.abs(a - b) / Math.max(Math.abs(b), floor);

export async function runCurvatureSelfTest(): Promise<SelfTestResult> {
  const wasm = await import("../wasm/spacetime_wasm.js");
  await wasm.default();

  // Uniform in √(r − 2) like the app's mesh, plus a few round radii.
  const n = 400;
  const radii = Array.from({ length: n + 1 }, (_, i) => 2 + 98 * (i / n) ** 2);
  for (const r of [3, 6, 10, 30, 60]) radii.push(r);
  radii.sort((a, b) => a - b);

  const ts = profile(schwarzschild, radii);
  const rust = wasm.curvatureProfile("schwarzschild", Float64Array.from(radii));
  const m = radii.length;
  const vsRust: [number, number, number] = [0, 0, 0];
  const vsClosed: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < m; i++) {
    const r = radii[i];
    vsRust[0] = Math.max(vsRust[0], rel(ts.height[i], rust[i], 1));
    vsRust[1] = Math.max(vsRust[1], rel(ts.distance[i], rust[m + i], 1));
    vsRust[2] = Math.max(vsRust[2], rel(ts.curvature[i], rust[2 * m + i], 0));
    const z = Math.sqrt(8 * (r - 2));
    const d = Math.sqrt(r * (r - 2)) + 2 * Math.log(Math.sqrt(r / 2) + Math.sqrt(r / 2 - 1));
    vsClosed[0] = Math.max(vsClosed[0], rel(ts.height[i], z, 1));
    vsClosed[1] = Math.max(vsClosed[1], rel(ts.distance[i], d, 1));
    vsClosed[2] = Math.max(vsClosed[2], rel(ts.curvature[i], -1 / (r * r * r), 0));
  }
  const pass = [...vsRust, ...vsClosed].every((e) => e < TOLERANCE);
  return { pass, vsRust, vsClosed, samples: m };
}
