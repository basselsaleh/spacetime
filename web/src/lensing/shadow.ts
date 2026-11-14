// The exact edge of a Kerr black hole's shadow (M = 1, spin a along +z) seen by
// a zero-angular-momentum camera, from the spherical photon orbits (Bardeen
// 1973). A port of `kerr::shadow_edge` (crates/physics/src/kerr.rs); the
// self-test compares the two.

type Vec3 = [number, number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Outer horizon radius r₊ = 1 + √(1 − a²). */
export function horizonRadius(a: number): number {
  return 1 + Math.sqrt(1 - a * a);
}

/** The camera's frame: BL radius, cos θ, sin θ and the flat-map axes r̂, θ̂, φ̂. */
function frame(cam: Vec3) {
  const [x, y, z] = cam;
  const rho = Math.hypot(x, y);
  const r = Math.hypot(rho, z);
  const st = rho / r;
  const ct = z / r;
  const [cp, sp] = rho > 0 ? [x / rho, y / rho] : [1, 0];
  return {
    r,
    ct,
    st,
    er: [st * cp, st * sp, ct] as Vec3,
    eth: [ct * cp, ct * sp, -st] as Vec3,
    eph: [-sp, cp, 0] as Vec3,
  };
}

/** Pixel directions (unit vectors, scene axes) around the shadow's edge, about `n` of them. */
export function shadowEdge(cam: Vec3, a: number, n: number): Vec3[] {
  const f = frame(cam);
  const r0 = f.r;
  const mu0 = f.ct;
  const center: Vec3 = [-f.er[0], -f.er[1], -f.er[2]];
  const circle = (sinRadius: number): Vec3[] => {
    const cr = Math.sqrt(1 - sinRadius * sinRadius);
    const out: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n;
      const c = Math.cos(t);
      const s = Math.sin(t);
      out.push([0, 1, 2].map((j) => cr * center[j] + sinRadius * (c * f.eth[j] + s * f.eph[j])) as Vec3);
    }
    return out;
  };
  // Zero-angular-momentum observer at (r0, θ0).
  const sigma = r0 * r0 + a * a * mu0 * mu0;
  const delta = r0 * r0 - 2 * r0 + a * a;
  const r2a2 = r0 * r0 + a * a;
  const bigA = r2a2 * r2a2 - a * a * delta * (1 - mu0 * mu0);
  const alpha = Math.sqrt((sigma * delta) / bigA);
  const omega = (2 * a * r0) / bigA;
  const varpiOverSin = Math.sqrt(bigA / sigma);

  if (a < 1e-9) return circle((Math.sqrt(27) / r0) * Math.sqrt(1 - 2 / r0));

  const orbit = (rp: number) => {
    const l = (rp * rp * (3 - rp) - a * a * (rp + 1)) / (a * (rp - 1));
    const q = (rp ** 3 * (4 * a * a - rp * (rp - 3) ** 2)) / (a * a * (rp - 1) ** 2);
    return { l, q };
  };
  const photonOrbit = (x: number) => 2 * (1 + Math.cos((2 / 3) * Math.acos(x)));
  const rpro = photonOrbit(-a);
  const rret = photonOrbit(a);

  if (f.st < 1e-9) {
    // Only L = 0 photons reach the axis.
    let lo = rpro;
    let hi = rret;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      if (mid * mid * (3 - mid) - a * a * (mid + 1) > 0) lo = mid;
      else hi = mid;
    }
    const { q } = orbit(0.5 * (lo + hi));
    return circle(Math.sqrt(delta * (q + a * a)) / (r0 * r0 + a * a));
  }

  const st2 = 1 - mu0 * mu0;
  // Θ(θ0) ≥ 0: photons of that orbit reach the camera's latitude.
  const reaches = (rp: number) => {
    const { l, q } = orbit(rp);
    return q + a * a * mu0 * mu0 - (l * l * mu0 * mu0) / st2;
  };
  const point = (rp: number, sign: number): Vec3 => {
    const { l, q } = orbit(rp);
    const theta = Math.max(reaches(rp), 0);
    const eLoc = (1 - omega * l) / alpha;
    const np = l / (f.st * varpiOverSin * eLoc);
    const nt = (sign * Math.sqrt(theta)) / (Math.sqrt(sigma) * eLoc);
    const bigR = (r0 * r0 + a * a - a * l) ** 2 - delta * (q + (l - a) ** 2);
    const nr = (Math.sign(r0 - rp) * Math.sqrt(Math.max(bigR, 0) / (sigma * delta))) / eLoc;
    // The arriving photon moves along n; the pixel looks along −n.
    return [0, 1, 2].map((j) => -(nr * f.er[j] + nt * f.eth[j] + np * f.eph[j])) as Vec3;
  };
  // The orbits that reach the camera form one interval of radii: find its ends.
  const scan = 4000;
  const at = (i: number) => rpro + ((rret - rpro) * i) / scan;
  let first = -1;
  let last = -1;
  for (let i = 0; i <= scan; i++) {
    if (reaches(at(i)) >= 0) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return [];
  const refine = (inside: number, outside: number) => {
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (inside + outside);
      if (reaches(mid) >= 0) inside = mid;
      else outside = mid;
    }
    return inside;
  };
  const r1 = first === 0 ? rpro : refine(at(first), at(first - 1));
  const r2 = last === scan ? rret : refine(at(last), at(last + 1));
  const m = Math.floor(n / 2);
  const rps: number[] = [];
  for (let i = 0; i <= m; i++) rps.push(r1 + (r2 - r1) * 0.5 * (1 - Math.cos((Math.PI * i) / m)));
  return [...rps.map((rp) => point(rp, 1)), ...rps.reverse().map((rp) => point(rp, -1))];
}

/**
 * The shadow's angular width (across the spin axis, along φ̂) and height
 * (along it, along θ̂), in radians, measured from the direction to the hole.
 */
export function shadowExtent(edge: ArrayLike<number> | Vec3[], cam: Vec3): { width: number; height: number } {
  const f = frame(cam);
  const center: Vec3 = [-f.er[0], -f.er[1], -f.er[2]];
  const points: Vec3[] = Array.isArray(edge) && Array.isArray(edge[0]) ? (edge as Vec3[]) : [];
  if (points.length === 0) {
    const flat = edge as ArrayLike<number>;
    for (let i = 0; i + 2 < flat.length; i += 3) points.push([flat[i], flat[i + 1], flat[i + 2]]);
  }
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const d of points) {
    const c = dot(d, center);
    const x = Math.atan2(dot(d, f.eph), c);
    const y = Math.atan2(dot(d, f.eth), c);
    xMin = Math.min(xMin, x);
    xMax = Math.max(xMax, x);
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
  }
  return { width: xMax - xMin, height: yMax - yMin };
}
