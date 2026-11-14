// Black hole lensing: traces each pixel's light ray backwards from the camera
// through the Schwarzschild spacetime (M = 1) and shows the sky where it ends
// up, or black if it falls in. sky.glsl is prepended to this.
//
// The camera is a static observer at r0 = |u_eye| > 3 (outside the photon
// sphere); pixel directions are taken in its local frame, with axes along the
// coordinate directions. A ray stays in the plane of the radial direction n̂
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

void main() {
  vec2 ndc = gl_FragCoord.xy / u_resolution * 2.0 - 1.0;
  vec3 d = normalize(u_rayBasis * vec3(ndc, 1.0));
  vec3 s;
  int fate = trace(u_eye, d, s);
  if (u_raw) {
    outColor = vec4(s, float(fate));
    return;
  }
  vec3 col = fate == 1 ? sky(s, u_pixelAngle) : vec3(0.0);
  outColor = vec4(col, 1.0);
}
