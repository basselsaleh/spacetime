// Shared GLSL for the strain shaders (slice.frag, volume.frag): the
// NRSur7dq4 mode table, the mode sum and the color map. Prepended to each
// shader's own source by scene3d.ts / volume.ts (three.js RawShaderMaterial;
// three prepends "#version 300 es").
//
// The table holds the coprecessing frame R (rows 0-1, a quaternion), the
// orbital phase Φ (row 2) and the modes H_lm in the co-orbital frame (rows
// 3…). For a direction n, with n_c = R⁻¹n at polar angle θ_c and azimuth φ_c:
//   r·(h₊ − i h×) = e^{−2iγ} Σ_lm H_lm(t − r) ₋₂Y_lm(θ_c, φ_c − Φ)   (LAL convention),
// where γ is the angle from the inertial θ̂ to the coprecessing θ̂ at n, toward
// φ̂. This mirrors `ModeTable::strain_rows` in crates/physics/src/mode_table.rs;
// the ?selftest page compares the two.
precision highp float;
precision highp int;
precision highp sampler2D;

#define MAX_ROWS 24
#define FRAME_ROWS 3
#define PI 3.141592653589793
#define TAU 6.283185307179586

uniform sampler2D u_table;    // RG32F: rows 0-1 quaternion (w,x),(y,z); row 2 (Φ mod 2π, 0); then (Re H, Im H)
uniform int u_width;          // table texture width in texels
uniform int u_samples;        // samples per row
uniform int u_rows;           // mode rows
uniform float u_t0;           // time of sample 0, M
uniform float u_dt;           // sample spacing, M
uniform ivec2 u_lm[MAX_ROWS]; // (l, m) of each mode row
// RG32F, u_thetaSamples × mode rows: (₋₂Y_{l,m}(θ, 0), 0), θ ∈ [0, π].
uniform sampler2D u_harmonics;
uniform int u_thetaSamples;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 conj2(vec2 a) { return vec2(a.x, -a.y); }
// z^m for |z| = 1 and |m| ≤ 8 (negative m via the conjugate).
vec2 cpowUnit(vec2 z, int m) {
  vec2 b = m < 0 ? conj2(z) : z;
  int k = m < 0 ? -m : m;
  vec2 r = vec2(1.0, 0.0);
  for (int j = 0; j < 8; j++) {
    if (j >= k) break;
    r = cmul(r, b);
  }
  return r;
}

vec2 texel(int row, int i) {
  int idx = row * u_samples + i;
  return texelFetch(u_table, ivec2(idx % u_width, idx / u_width), 0).rg;
}

// Harmonic coefficient for one mode row at polar angle theta (linear in θ).
float harmonic(int row, float theta) {
  float x = theta / PI * float(u_thetaSamples - 1);
  int j = min(int(floor(x)), u_thetaSamples - 2);
  float f = x - float(j);
  float a = texelFetch(u_harmonics, ivec2(j, row), 0).r;
  float b = texelFetch(u_harmonics, ivec2(j + 1, row), 0).r;
  return mix(a, b, f);
}

// Rotation matrix of a unit quaternion (w, x, y, z): v_ref = M v.
mat3 quatMatrix(vec4 q) {
  float w = q.x, x = q.y, y = q.z, z = q.w;
  // GLSL matrices are column-major.
  return mat3(
    1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
    2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
    2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y));
}

// Polar angle, e^{iφ} and θ̂ of a unit vector (φ = 0 on the axis). atan(y, 0)
// is legal GLSL but some GPU backends mishandle it, so z = 0 is taken directly.
void sphericalBasis(vec3 n, out float theta, out vec2 e, out vec3 thetaHat) {
  float rho = length(n.xy);
  e = rho > 0.0 ? n.xy / rho : vec2(1.0, 0.0);
  theta = n.z == 0.0 ? 0.5 * PI : atan(rho, n.z);
  thetaHat = vec3(n.z * e, -rho);
}

// r·(h₊ − i h×) at retarded time tRet in the direction of n (unit length),
// from the first `rows` mode rows; valid = false outside the data.
vec2 strainRows(float tRet, vec3 n, int rows, out bool valid) {
  float x = (tRet - u_t0) / u_dt;
  valid = x >= 0.0 && x <= float(u_samples - 1);
  if (!valid) return vec2(0.0);
  int i = min(int(floor(x)), u_samples - 2);
  float f = x - float(i);

  vec4 q = normalize(vec4(mix(texel(0, i), texel(0, i + 1), f), mix(texel(1, i), texel(1, i + 1), f)));
  float p0 = texel(2, i).x;
  float dp = texel(2, i + 1).x - p0;
  if (dp < -PI) dp += TAU;  // unwrap across the mod-2π cut
  float phase = p0 + f * dp;
  // Reduce to [−π, π): keeps GPU trig in its accurate range.
  phase -= TAU * floor(phase / TAU + 0.5);

  mat3 R = quatMatrix(q);
  float thetaC, thetaI;
  vec2 eC, eI;
  vec3 thatC, thatI;
  sphericalBasis(transpose(R) * n, thetaC, eC, thatC);
  sphericalBasis(n, thetaI, eI, thatI);
  vec3 phihatI = vec3(-eI.y, eI.x, 0.0);
  vec3 t = R * thatC;
  vec2 g = vec2(dot(t, thatI), -dot(t, phihatI));
  vec2 polar = cmul(g, g);  // e^{−2iγ}
  vec2 eCo = cmul(eC, vec2(cos(phase), -sin(phase)));

  vec2 sum = vec2(0.0);
  for (int k = 0; k < MAX_ROWS; k++) {
    if (k >= rows) break;
    vec2 h = mix(texel(FRAME_ROWS + k, i), texel(FRAME_ROWS + k, i + 1), f);
    sum += harmonic(k, thetaC) * cmul(h, cpowUnit(eCo, u_lm[k].y));
  }
  return cmul(sum, polar);
}

// r·(h₊ − i h×) from every mode in the table.
vec2 strain(float tRet, vec3 n, out bool valid) {
  return strainRows(tRet, n, u_rows, valid);
}

// Color map: an RGBA8 lookup table from s = −1 (left) to +1 (right), built
// in look.ts, after a saturation curve x/√(1+x²). The curve saturates gently
// (more slowly than tanh), so the brightening toward merger stays visible.
uniform sampler2D u_lut;

float saturateStrain(float x) {
  return x * inversesqrt(1.0 + x * x);
}

// Palette color at s ∈ [−1, 1] (texel centers at the ends).
vec3 paletteColor(float s) {
  float u = (0.5 + 0.5 * s) * (255.0 / 256.0) + 0.5 / 256.0;
  return texture(u_lut, vec2(u, 0.5)).rgb;
}

vec3 diverging(float v) {
  float a = saturateStrain(abs(v));
  return paletteColor(v < 0.0 ? -a : a);
}

// Distance, polar angle (from +z, the orbital angular momentum) and azimuth of p.
// atan(y, 0) is legal GLSL but some GPU backends mishandle it; the orbital
// plane (z = 0 exactly) is the common case, so take it directly.
void sphericalAngles(vec3 p, out float r, out float theta, out float phi) {
  r = length(p);
  theta = p.z == 0.0 ? 0.5 * PI : atan(length(p.xy), p.z);
  phi = atan(p.y, p.x);
}
