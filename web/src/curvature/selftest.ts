// ?selftest: the app's TypeScript embedding (embedding.ts) against the Rust
// reference (crates/physics/src/embedding.rs, through wasm) and against the
// closed forms: Flamm's paraboloid (also the bridge's sheets), and the
// uniform-density star at its smallest (Buchdahl's limit), a neutron-star-like
// and a large radius. Radii run from the inner edge out to 100 M.

import { BUCHDAHL, type Slice, profile, schwarzschild, star } from "./embedding";

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

const flammHeight = (r: number) => Math.sqrt(8 * (r - 2));
const flammDistance = (r: number) => Math.sqrt(r * (r - 2)) + 2 * Math.log(Math.sqrt(r / 2) + Math.sqrt(r / 2 - 1));

/** Closed forms [height, distance, K] for the star of radius rs (spherical cap inside, Flamm outside). */
function starClosed(rs: number, r: number): [number, number, number] {
  const a2 = (rs * rs * rs) / 2;
  const a = Math.sqrt(a2);
  const cap = (x: number) => a - Math.sqrt(a2 - x * x);
  const arc = (x: number) => a * Math.asin(x / a);
  if (r <= rs) return [cap(r), arc(r), 2 / (rs * rs * rs)];
  return [cap(rs) + flammHeight(r) - flammHeight(rs), arc(rs) + flammDistance(r) - flammDistance(rs), -1 / (r * r * r)];
}

interface Case {
  name: string;
  param: number;
  slice: Slice;
  closed: (r: number) => [number, number, number];
}

const CASES: Case[] = [
  { name: "schwarzschild", param: 0, slice: schwarzschild, closed: (r) => [flammHeight(r), flammDistance(r), -1 / (r * r * r)] },
  ...[BUCHDAHL, 6, 20].map((rs) => ({ name: "star", param: rs, slice: star(rs), closed: (r: number) => starClosed(rs, r) })),
];

export async function runCurvatureSelfTest(): Promise<SelfTestResult> {
  const wasm = await import("../wasm/spacetime_wasm.js");
  await wasm.default();

  const vsRust: [number, number, number] = [0, 0, 0];
  const vsClosed: [number, number, number] = [0, 0, 0];
  let samples = 0;
  for (const c of CASES) {
    // Uniform in √(r − r_in) like the app's mesh, plus a few round radii (and a star's surface).
    const rIn = c.slice.inner;
    const n = 400;
    const radii = Array.from({ length: n + 1 }, (_, i) => rIn + (100 - rIn) * (i / n) ** 2);
    radii.push(3, 6, 10, 30, 60, ...c.slice.breaks);
    radii.sort((a, b) => a - b);

    const ts = profile(c.slice, radii);
    const rust = wasm.curvatureProfile(c.name, c.param, Float64Array.from(radii));
    const m = radii.length;
    samples += m;
    for (let i = 0; i < m; i++) {
      vsRust[0] = Math.max(vsRust[0], rel(ts.height[i], rust[i], 1));
      vsRust[1] = Math.max(vsRust[1], rel(ts.distance[i], rust[m + i], 1));
      vsRust[2] = Math.max(vsRust[2], rel(ts.curvature[i], rust[2 * m + i], 0));
      const [z, d, k] = c.closed(radii[i]);
      vsClosed[0] = Math.max(vsClosed[0], rel(ts.height[i], z, 1));
      vsClosed[1] = Math.max(vsClosed[1], rel(ts.distance[i], d, 1));
      vsClosed[2] = Math.max(vsClosed[2], rel(ts.curvature[i], k, 0));
    }
  }
  const pass = [...vsRust, ...vsClosed].every((e) => e < TOLERANCE);
  return { pass, vsRust, vsClosed, samples };
}
