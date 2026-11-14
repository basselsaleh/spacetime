// Black hole lensing: traces each pixel's light ray backwards from the camera
// through the Kerr spacetime (M = 1, spin u_spin along +z) and shows the sky
// where it ends up, or black if it falls in. sky.glsl is prepended to this.
//
// Pixel directions are taken in the camera's local frame, with axes along the
// coordinate directions (r̂, θ̂, φ̂ of the flat map of Boyer–Lindquist
// coordinates). Two integrators:
//
// - traceKerr (any spin; the camera is a zero-angular-momentum observer):
//   Mino-time RK4 with the angular position as a unit vector. Mirrors
//   `trace_mino` in crates/physics/src/kerr.rs, which documents the equations.
// - trace (spin 0 only; a static observer at r0 > 3, the same thing at a = 0):
//   the planar Schwarzschild sweep below. Kept as the spin-0 fast path (about
//   1.45x faster than traceKerr at a = 0, which is slightly more accurate) and
//   as a base for Schwarzschild-only features.
//
// Schwarzschild: a ray stays in the plane of the radial direction n̂
// and its initial direction; with u = 1/r and φ swept from n̂,
//   d²u/dφ² = 3u² − u,   u(0) = 1/r0,   du/dφ(0) = −u √(1 − 2u) cot ψ,
// and it escapes at u = 0 (direction cos φ n̂ + sin φ t̂) or is captured at
// u = 1/2. Mirrors `sweep_ode` in crates/physics/src/geodesic.rs; the
// ?selftest page compares the two (via the quadrature reference).

out vec4 outColor;

#define MAX_STEPS 1000
#define B_CRIT 5.196152422706632

uniform vec3 u_eye;           // camera position, M
uniform mat3 u_rayBasis;      // see common/rays.ts
uniform vec2 u_resolution;    // render-target pixels
uniform float u_pixelAngle;   // angular size of one render-target pixel, rad
uniform bool u_raw;           // self-test: output (sky direction, escaped)
uniform float u_spin;         // a/M, in [0, 1)
uniform bool u_kerr;          // use traceKerr (always when u_spin > 0)

// Root in [0, 1] of the cubic Hermite interpolant (values p0 > 0 ≥ p1, step-scaled slopes m0, m1).
float hermiteRoot(float p0, float m0, float p1, float m1) {
  float s = clamp(p0 / (p0 - p1), 0.0, 1.0);
  for (int i = 0; i < 6; i++) {
    float s2 = s * s, s3 = s2 * s;
    float p = (2.0 * s3 - 3.0 * s2 + 1.0) * p0 + (s3 - 2.0 * s2 + s) * m0 + (-2.0 * s3 + 3.0 * s2) * p1 + (s3 - s2) * m1;
    float dp = (6.0 * s2 - 6.0 * s) * p0 + (3.0 * s2 - 4.0 * s + 1.0) * m0 + (-6.0 * s2 + 6.0 * s) * p1 + (3.0 * s2 - 2.0 * s) * m1;
    if (abs(dp) < 1e-20) break;
    s = clamp(s - p / dp, 0.0, 1.0);
  }
  return s;
}

float acc(float u) { return 3.0 * u * u - u; }

// 1: escaped, with the sky direction in `dir`; 0: captured (or unresolved
// after MAX_STEPS, which only happens on the photon ring).
int trace(vec3 p, vec3 d, out vec3 dir) {
  dir = vec3(0.0);
  float r0 = length(p);
  vec3 n = p / r0;
  float c = dot(d, n);
  vec3 tang = d - c * n;
  float s = length(tang);
  if (s < 1e-7) {
    dir = n;
    return c > 0.0 ? 1 : 0;
  }
  vec3 t = tang / s;
  float u = 1.0 / r0;
  float g = sqrt(1.0 - 2.0 * u);
  if (c < 0.0 && r0 * s / g < B_CRIT) return 0;  // inside the shadow
  float du = -u * g * c / s;
  float phi = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    // Step in φ: 0.02 normally, smaller when u is heading quickly to 0 (near-radial rays).
    float h = clamp(0.5 * u / max(abs(du), 1e-6), 0.002, 0.02);
    float k1u = du, k1v = acc(u);
    float k2u = du + 0.5 * h * k1v, k2v = acc(u + 0.5 * h * k1u);
    float k3u = du + 0.5 * h * k2v, k3v = acc(u + 0.5 * h * k2u);
    float k4u = du + h * k3v, k4v = acc(u + h * k3u);
    float u1 = u + h / 6.0 * (k1u + 2.0 * k2u + 2.0 * k3u + k4u);
    float du1 = du + h / 6.0 * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);
    if (u1 >= 0.5) return 0;
    if (u1 <= 0.0) {
      float pe = phi + h * hermiteRoot(u, du * h, u1, du1 * h);
      dir = cos(pe) * n + sin(pe) * t;
      return 1;
    }
    u = u1;
    du = du1;
    phi += h;
  }
  return 0;
}

// ---- Kerr ----------------------------------------------------------------
// The ray traced is the time reverse of the arriving photon: a ray leaving
// along d around a hole of spin s = −a (see kerr.rs). Constants of that ray:
float kS, kL, kK, kC;

float kerrDrag(float u) {
  return kS * u * (2.0 - kS * kL * u) / (1.0 - 2.0 * u + kS * kS * u * u);
}

// Derivatives of (u, u′, m, m′, χ) in Mino time.
void kerrRhs(float u, float du, vec3 m, vec3 dm,
             out float fu, out float fdu, out vec3 fm, out vec3 fdm, out float fchi) {
  fu = du;
  fdu = 2.0 * kK * u * (1.0 + kK * u * u) - kC * (u - 3.0 * u * u + 2.0 * kS * kS * u * u * u);
  float cen = kS * kS * m.z * m.z + dot(dm, dm);
  fm = dm;
  fdm = -cen * m + vec3(0.0, 0.0, kS * kS * m.z);
  fchi = kerrDrag(u);
}

// SHADER_STEPS in kerr.rs: truncation error ~2e-6 rad, below float32 rounding.
#define KERR_EPS 0.04
#define KERR_FLOOR 0.004

int traceKerr(vec3 p, vec3 d, out vec3 dir) {
  dir = vec3(0.0);
  float s = -u_spin;
  float r = length(p);
  float rho = length(p.xy);
  float st = rho / r, ct = p.z / r;
  vec2 cs = rho > 0.0 ? p.xy / rho : vec2(1.0, 0.0);
  vec3 er = vec3(st * cs, ct);
  vec3 eth = vec3(ct * cs, -st);
  vec3 eph = vec3(-cs.y, cs.x, 0.0);
  float nr = dot(d, er), nt = dot(d, eth), np = dot(d, eph);
  // Zero-angular-momentum observer at (r, θ).
  float sigma = r * r + s * s * ct * ct;
  float delta = r * r - 2.0 * r + s * s;
  float r2a2 = r * r + s * s;
  float bigA = r2a2 * r2a2 - s * s * delta * (1.0 - ct * ct);
  float alpha = sqrt(sigma * delta / bigA);
  float omega = 2.0 * s * r / bigA;
  float vos = sqrt(bigA / sigma);  // circumferential radius / sin θ
  float e = alpha + omega * st * vos * np;
  float lOverSin = vos * np / e;
  float pth = sqrt(sigma) * nt / e;
  kS = s;
  kL = lOverSin * st;
  float q = pth * pth + ct * ct * (lOverSin * lOverSin - s * s);
  kK = s * s - s * kL;
  kC = q + (kL - s) * (kL - s);
  float u = 1.0 / r;
  float du = -u * u * sqrt(sigma * delta) * nr / e;
  vec3 m = er;
  vec3 dm = pth * eth + lOverSin * eph;
  float chi = 0.0;
  float uPlus = 1.0 / (1.0 + sqrt(1.0 - s * s));
  for (int i = 0; i < MAX_STEPS; i++) {
    float rate = max(length(dm), 1.0);
    float psi = kerrDrag(u);
    float h = max(min(0.5 * u / max(abs(du), 1e-30), KERR_EPS / max(rate, abs(psi))), KERR_FLOOR / rate);
    float k1u, k1du, k1chi, k2u, k2du, k2chi, k3u, k3du, k3chi, k4u, k4du, k4chi;
    vec3 k1m, k1dm, k2m, k2dm, k3m, k3dm, k4m, k4dm;
    kerrRhs(u, du, m, dm, k1u, k1du, k1m, k1dm, k1chi);
    kerrRhs(u + 0.5 * h * k1u, du + 0.5 * h * k1du, m + 0.5 * h * k1m, dm + 0.5 * h * k1dm,
            k2u, k2du, k2m, k2dm, k2chi);
    kerrRhs(u + 0.5 * h * k2u, du + 0.5 * h * k2du, m + 0.5 * h * k2m, dm + 0.5 * h * k2dm,
            k3u, k3du, k3m, k3dm, k3chi);
    kerrRhs(u + h * k3u, du + h * k3du, m + h * k3m, dm + h * k3dm, k4u, k4du, k4m, k4dm, k4chi);
    float w = h / 6.0;
    float u1 = u + w * (k1u + 2.0 * k2u + 2.0 * k3u + k4u);
    float du1 = du + w * (k1du + 2.0 * k2du + 2.0 * k3du + k4du);
    vec3 m1 = m + w * (k1m + 2.0 * k2m + 2.0 * k3m + k4m);
    vec3 dm1 = dm + w * (k1dm + 2.0 * k2dm + 2.0 * k3dm + k4dm);
    float chi1 = chi + w * (k1chi + 2.0 * k2chi + 2.0 * k3chi + k4chi);
    if (u1 >= uPlus) return 0;
    if (u1 <= 0.0) {
      float t = hermiteRoot(u, du * h, u1, du1 * h);
      float t2 = t * t, t3 = t2 * t;
      float h00 = 2.0 * t3 - 3.0 * t2 + 1.0, h10 = t3 - 2.0 * t2 + t;
      float h01 = 3.0 * t2 - 2.0 * t3, h11 = t3 - t2;
      vec3 me = normalize(h00 * m + h10 * h * dm + h01 * m1 + h11 * h * dm1);
      float ce = h00 * chi + h10 * h * psi + h01 * chi1 + h11 * h * kerrDrag(u1);
      float sc = sin(ce), cc = cos(ce);
      dir = vec3(cc * me.x - sc * me.y, sc * me.x + cc * me.y, me.z);
      return 1;
    }
    u = u1;
    du = du1;
    m = m1;
    dm = dm1;
    chi = chi1;
  }
  return 0;
}

void main() {
  vec2 ndc = gl_FragCoord.xy / u_resolution * 2.0 - 1.0;
  vec3 d = normalize(u_rayBasis * vec3(ndc, 1.0));
  vec3 s;
  int fate = u_kerr ? traceKerr(u_eye, d, s) : trace(u_eye, d, s);
  if (u_raw) {
    outColor = vec4(s, float(fate));
    return;
  }
  vec3 col = fate == 1 ? sky(s, u_pixelAngle) : vec3(0.0);
  outColor = vec4(col, 1.0);
}
