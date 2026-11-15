// Embedding diagrams: a slice dl² = dr²/f(r) + R(r)² dφ² drawn as a surface of
// revolution in R³ with the same lengths. Mirrors crates/physics/src/embedding.rs
// (see there for the math); ?selftest compares the two.

/** A spatial slice with an inner edge at a horizon (f = 0 there). */
export interface Slice {
  /** f = 1/g_rr. */
  f(r: number): number;
  df(r: number): number;
  /** Circumferential radius R(r) and its derivatives. */
  circ(r: number): number;
  dcirc(r: number): number;
  d2circ(r: number): number;
  /** Horizon radius r₊. */
  horizon: number;
}

/** Schwarzschild (M = 1): f = 1 − 2/r, R = r. Its embedding is Flamm's paraboloid. */
export const schwarzschild: Slice = {
  f: (r) => 1 - 2 / r,
  df: (r) => 2 / (r * r),
  circ: (r) => r,
  dcirc: () => 1,
  d2circ: () => 0,
  horizon: 2,
};

export interface Profile {
  r: Float64Array;
  /** Circumferential radius: distance from the axis in R³. */
  circ: Float64Array;
  /** Height above the horizon (0 there), increasing outward. */
  height: Float64Array;
  /** Proper radial distance from the horizon. */
  distance: Float64Array;
  /** Gaussian curvature K (1/M²). */
  curvature: Float64Array;
}

// 8-point Gauss–Legendre on [−1, 1] (positive half).
const GL_X = [0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363];
const GL_W = [0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];
/** Largest sub-interval in u = √(r − r₊). */
const MAX_DU = 0.05;

/** Gaussian curvature K = −(R′ f′/2 + R″ f)/R. */
export function gaussianCurvature(s: Slice, r: number): number {
  return -(s.dcirc(r) * s.df(r) / 2 + s.d2circ(r) * s.f(r)) / s.circ(r);
}

/** Samples the embedding at `radii` (increasing, each ≥ the horizon). Throws if not embeddable. */
export function profile(s: Slice, radii: ArrayLike<number>): Profile {
  const n = radii.length;
  const rh = s.horizon;
  const out: Profile = {
    r: Float64Array.from(radii),
    circ: new Float64Array(n),
    height: new Float64Array(n),
    distance: new Float64Array(n),
    curvature: new Float64Array(n),
  };
  let z = 0;
  let d = 0;
  let u0 = 0;
  for (let i = 0; i < n; i++) {
    const r = radii[i];
    if (!(r >= rh) || (i > 0 && r < radii[i - 1])) throw new Error("radii must be increasing and outside the horizon");
    const u1 = Math.sqrt(r - rh);
    // No sub-intervals for a repeated radius or the horizon itself (0 × ∞ at u = 0).
    const m = Math.ceil((u1 - u0) / MAX_DU);
    const h = m > 0 ? (u1 - u0) / m : 0;
    for (let k = 0; k < m; k++) {
      const mid = u0 + (k + 0.5) * h;
      for (let j = 0; j < 4; j++) {
        for (const u of [mid - (GL_X[j] * h) / 2, mid + (GL_X[j] * h) / 2]) {
          const rr = rh + u * u;
          const f = s.f(rr);
          const dr = s.dcirc(rr);
          const excess = 1 - f * dr * dr;
          if (excess < 0) throw new Error(`not embeddable in R³ at r = ${rr}`);
          const invSqrtF = 1 / Math.sqrt(f);
          // Same operation order as the Rust, so the two agree to rounding.
          const dz = 2 * u * Math.sqrt(excess) * invSqrtF;
          const dd = 2 * u * invSqrtF;
          z += ((GL_W[j] * h) / 2) * dz;
          d += ((GL_W[j] * h) / 2) * dd;
        }
      }
    }
    u0 = u1;
    out.circ[i] = s.circ(r);
    out.height[i] = z;
    out.distance[i] = d;
    out.curvature[i] = gaussianCurvature(s, r);
  }
  return out;
}

/** Coordinate radius at circumferential radius `rho`, by interpolating a profile (R increasing). */
export function radiusAtCirc(p: Profile, rho: number): number {
  const c = p.circ;
  if (rho <= c[0]) return p.r[0];
  const last = c.length - 1;
  if (rho >= c[last]) return p.r[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid] <= rho) lo = mid;
    else hi = mid;
  }
  const t = (rho - c[lo]) / (c[hi] - c[lo]);
  return p.r[lo] + t * (p.r[hi] - p.r[lo]);
}
