#version 300 es
// Gravitational-wave strain on a 2D slice through the source, from the
// NRHybSur3dq8 modes.
//
// Each pixel is a 3D point at distance r, polar angle θ (from the orbital
// angular momentum, +z) and azimuth φ. It shows r·h₊ or r·h× at retarded time
// t − r, where h₊ − i h× = (1/r) Σ_lm h_lm(t − r) ₋₂Y_lm(θ, φ) (LAL convention).
// Slices: 0 = orbital plane seen from +z (x right, y up); 1 = vertical plane
// through the z-axis at azimuth u_azimuth (horizontal = in-plane direction,
// vertical = +z).
//
// The waveform-table arithmetic mirrors `ModeTable::strain` in
// crates/physics/src/mode_table.rs; the ?selftest page compares the two.
precision highp float;
precision highp int;
precision highp sampler2D;

#define MAX_ROWS 16
#define PI 3.141592653589793
#define TAU 6.283185307179586
#define FOUR_PI 12.566370614359172

in vec2 v_uv;
out vec4 outColor;

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

uniform int u_slice;          // 0: orbital plane; 1: vertical slice
uniform float u_azimuth;      // vertical slice's azimuth, rad
uniform int u_component;      // 0: h₊, 1: h×

uniform vec2 u_resolution;    // pixels
uniform vec2 u_center;        // view centre in slice coordinates, M
uniform float u_halfWidth;    // half the view width, M
uniform float u_time;         // coordinate time at the source, M
uniform float u_scale;        // colour units per r·h (1/peak × gain)
uniform float u_maskRadius;   // near zone: far-zone formula not valid inside, M
uniform bool u_raw;           // self-test: output raw (r·h₊, r·h×, valid)
// Heavier hole, lighter hole, remnant: (x, y, horizon radius, opacity), in M; z = 0.
uniform vec4 u_discs[3];
uniform float u_minDiscRadius; // M; keeps discs visible when zoomed out

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
  float aspect = u_resolution.x / u_resolution.y;
  vec2 q = u_center + (v_uv * 2.0 - 1.0) * vec2(u_halfWidth, u_halfWidth / aspect);

  // 3D point and its spherical angles.
  vec3 p3;
  float theta;
  float phi;
  if (u_slice == 0) {
    p3 = vec3(q, 0.0);
    theta = 0.5 * PI;
    phi = atan(q.y, q.x);
  } else {
    vec2 dir = vec2(cos(u_azimuth), sin(u_azimuth));
    p3 = vec3(q.x * dir, q.y);
    theta = atan(abs(q.x), q.y);
    phi = q.x >= 0.0 ? u_azimuth : u_azimuth + PI;
  }
  float r = length(p3);

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
  // Faint ring marking the near-zone boundary.
  float px = u_halfWidth / (0.5 * u_resolution.x);  // M per pixel
  float ring = 1.0 - smoothstep(0.0, 1.5 * px, abs(r - u_maskRadius));
  color = mix(color, vec3(0.55, 0.6, 0.7), 0.35 * ring);

  // Black holes: where the slice cuts each horizon sphere, a black disc with a
  // thin bright rim (in the orbital plane, the full horizon).
  for (int k = 0; k < 3; k++) {
    vec4 d = u_discs[k];
    if (d.w <= 0.0) continue;
    float radius = max(d.z, u_minDiscRadius);
    float dist = length(p3 - vec3(d.xy, 0.0));
    float inside = 1.0 - smoothstep(radius - px, radius + px, dist);
    float rim = 1.0 - smoothstep(0.0, 1.5 * px, abs(dist - radius));
    color = mix(color, vec3(0.0), inside * d.w);
    color = mix(color, vec3(0.92, 0.94, 1.0), 0.8 * rim * d.w);
  }
  outColor = vec4(color, 1.0);
}
