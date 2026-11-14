// Gravitational-wave strain on a slice plane through the source, from the
// NRHybSur3dq8 modes. Drawn on a plane mesh in the 3D scene (three.js
// RawShaderMaterial; three prepends "#version 300 es").
//
// Each fragment is a 3D point at distance r, polar angle θ (from the orbital
// angular momentum, +z) and azimuth φ. It shows r·h₊ or r·h× at retarded time
// t − r, where h₊ − i h× = (1/r) Σ_lm h_lm(t − r) ₋₂Y_lm(θ, φ) (LAL convention).
// The slice is spanned by u_axisU and u_axisV: the orbital plane is (x̂, ŷ), the
// side view (x̂, ẑ), and any tilt in between is a genuine slice too.
//
// The waveform-table arithmetic mirrors `ModeTable::strain` in
// crates/physics/src/mode_table.rs; the ?selftest page compares the two.
precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 vWorld;
out vec4 outColor;

#define MAX_ROWS 16
#define PI 3.141592653589793
#define TAU 6.283185307179586
#define FOUR_PI 12.566370614359172

uniform sampler2D u_table;    // RG32F: row 0 (A22, φ22 mod 4π); others (Re H, Im H)
uniform int u_width;          // table texture width in texels
uniform int u_samples;        // samples per row
uniform int u_rows;
uniform float u_t0;           // time of sample 0, M
uniform float u_dt;           // sample spacing, M
uniform ivec2 u_lm[MAX_ROWS];
// RG32F, u_thetaSamples × rows: (₋₂Y_{l,m}(θ, 0), (−1)^l ₋₂Y_{l,−m}(θ, 0)), θ ∈ [0, π].
uniform sampler2D u_harmonics;
uniform int u_thetaSamples;

uniform vec3 u_axisU;         // in-slice unit vector (screen right in the flat view)
uniform vec3 u_axisV;         // in-slice unit vector ⟂ u_axisU (screen up in the flat view)
uniform int u_component;      // 0: h₊, 1: h×

uniform float u_time;         // coordinate time at the source, M
uniform float u_scale;        // colour units per r·h (1/peak × gain)
uniform float u_maskRadius;   // near zone: far-zone formula not valid inside, M
uniform bool u_raw;           // self-test: output raw (r·h₊, r·h×, valid)
uniform float u_opacity;      // < 1 for a secondary plane in the 3D view
// When the camera looks straight at the slice (flat view, self-test), take the
// slice position from the pixel itself, exactly; otherwise interpolate it.
uniform bool u_screenMapped;
uniform vec2 u_resolution;    // drawing-buffer pixels
uniform vec2 u_center;        // slice coordinates at the view centre, M
uniform float u_halfWidth;    // half the view width, M

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 conj2(vec2 a) { return vec2(a.x, -a.y); }
vec2 cpow(vec2 z, int m) {
  vec2 r = vec2(1.0, 0.0);
  for (int k = 0; k < 8; k++) {
    if (k >= m) break;
    r = cmul(r, z);
  }
  return r;
}

vec2 texel(int row, int i) {
  int idx = row * u_samples + i;
  return texelFetch(u_table, ivec2(idx % u_width, idx / u_width), 0).rg;
}

// Harmonic coefficients for one row at polar angle theta (linear in θ).
vec2 harmonics(int row, float theta) {
  float x = theta / PI * float(u_thetaSamples - 1);
  int j = min(int(floor(x)), u_thetaSamples - 2);
  float f = x - float(j);
  vec2 a = texelFetch(u_harmonics, ivec2(j, row), 0).rg;
  vec2 b = texelFetch(u_harmonics, ivec2(j + 1, row), 0).rg;
  return mix(a, b, f);
}

// r·(h₊ − i h×) at retarded time tRet in direction (theta, phi); valid = false outside the data.
vec2 strain(float tRet, float theta, float phi, out bool valid) {
  float x = (tRet - u_t0) / u_dt;
  valid = x >= 0.0 && x <= float(u_samples - 1);
  if (!valid) return vec2(0.0);
  int i = min(int(floor(x)), u_samples - 2);
  float f = x - float(i);

  vec2 s0 = texel(0, i);
  vec2 s1 = texel(0, i + 1);
  float dp = s1.y - s0.y;
  if (dp < -TAU) dp += FOUR_PI;  // unwrap across the mod-4π cut
  float amp22 = mix(s0.x, s1.x, f);
  // Reduce to [−π, π): exact (period 2π) and keeps GPU trig in its accurate range.
  float halfPhase = 0.5 * (s0.y + f * dp);
  halfPhase -= TAU * floor(halfPhase / TAU + 0.5);
  vec2 rot = vec2(cos(halfPhase), -sin(halfPhase));  // e^{−iφ22/2}
  vec2 eiphi = vec2(cos(phi), sin(phi));

  vec2 sum = vec2(0.0);
  for (int k = 0; k < MAX_ROWS; k++) {
    if (k >= u_rows) break;
    int m = u_lm[k].y;
    vec2 h = k == 0
      ? amp22 * cpow(rot, 2)
      : cmul(mix(texel(k, i), texel(k, i + 1), f), cpow(rot, m));
    vec2 y = harmonics(k, theta);
    vec2 eimphi = cpow(eiphi, m);
    sum += cmul(h, y.x * eimphi);
    if (m != 0) sum += cmul(conj2(h), y.y * conj2(eimphi));
  }
  return sum;
}

// Diverging map: negative blue, 0 near-black, positive orange. Saturates
// smoothly (tanh), so the brightening toward merger stays visible at any gain.
vec3 diverging(float v) {
  float a = tanh(abs(v));
  vec3 mid = vec3(0.06, 0.07, 0.10);
  vec3 neg = vec3(0.30, 0.58, 1.00);
  vec3 pos = vec3(1.00, 0.60, 0.22);
  return mix(mid, v < 0.0 ? neg : pos, a);
}

void main() {
  // Slice coordinates. Interpolated positions carry rasterizer snapping error
  // (1/256 px), so the flat view maps pixels to the slice directly.
  vec2 q;
  if (u_screenMapped) {
    float aspect = u_resolution.x / u_resolution.y;
    q = u_center + (gl_FragCoord.xy / u_resolution * 2.0 - 1.0) * vec2(u_halfWidth, u_halfWidth / aspect);
  } else {
    q = vec2(dot(vWorld, u_axisU), dot(vWorld, u_axisV));
  }
  // Rebuild the point on the slice, so the orbital plane has z = 0 exactly.
  vec3 p3 = q.x * u_axisU + q.y * u_axisV;
  float r = length(p3);
  // atan(y, 0) is legal GLSL but some GPU backends mishandle it; the orbital
  // plane (z = 0 exactly) is the common case, so take it directly.
  float theta = p3.z == 0.0 ? 0.5 * PI : atan(length(p3.xy), p3.z);
  float phi = atan(p3.y, p3.x);

  bool valid;
  vec2 h = strain(u_time - r, theta, phi, valid);
  float hplus = h.x;
  float hcross = -h.y;

  if (u_raw) {
    outColor = vec4(hplus, hcross, valid ? 1.0 : 0.0, 1.0);
    return;
  }

  vec3 background = vec3(0.035, 0.04, 0.055);
  float value = u_component == 0 ? hplus : hcross;
  vec3 color = valid ? diverging(value * u_scale) : background;
  // Near zone: fade to background where the far-zone formula does not apply.
  float mask = smoothstep(0.75 * u_maskRadius, u_maskRadius, r);
  color = mix(background, color, mask);
  // Faint ring marking the near-zone boundary (width from screen derivatives).
  float aa = max(fwidth(r), 1e-4);
  float ring = 1.0 - smoothstep(0.0, 1.5 * aa, abs(r - u_maskRadius));
  color = mix(color, vec3(0.55, 0.6, 0.7), 0.35 * ring);
  outColor = vec4(color, u_opacity);
}
