#version 300 es
// Orbital-plane gravitational-wave strain from the NRHybSur3dq8 modes.
//
// Each pixel is a point in the orbital plane (θ = π/2) at distance r and angle φ
// from the source. It shows r·h₊ at retarded time t − r, where
//   h₊ − i h× = (1/r) Σ_lm h_lm(t − r) ₋₂Y_lm(θ, φ).
// The waveform table layout and arithmetic mirror `ModeTable::strain` in
// crates/physics/src/mode_table.rs, which the self-test compares against.
precision highp float;
precision highp int;
precision highp sampler2D;

#define MAX_ROWS 16
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
// Per row: (₋₂Y_{l,m}(π/2, 0), (−1)^l ₋₂Y_{l,−m}(π/2, 0)); y = 0 for m = 0.
uniform vec2 u_coef[MAX_ROWS];

uniform vec2 u_resolution;    // pixels
uniform vec2 u_center;        // view centre, M
uniform float u_halfWidth;    // half the view width, M
uniform float u_time;         // coordinate time at the source, M
uniform float u_scale;        // colour units per r·h (1/peak × gain)
uniform float u_maskRadius;   // near zone: far-zone formula not valid inside, M
uniform bool u_raw;           // self-test: output raw (r·h₊, r·h×, valid)

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

// r·(h₊ − i h×) at retarded time tRet and azimuth phi; valid = false outside the data.
vec2 strain(float tRet, float phi, out bool valid) {
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
    vec2 eimphi = cpow(eiphi, m);
    sum += cmul(h, u_coef[k].x * eimphi);
    if (m != 0) sum += cmul(conj2(h), u_coef[k].y * conj2(eimphi));
  }
  return sum;
}

// Diverging map: h₊ < 0 blue, 0 near-black, h₊ > 0 orange. Saturates smoothly
// (tanh), so the brightening toward merger stays visible at any gain.
vec3 diverging(float v) {
  float a = tanh(abs(v));
  vec3 mid = vec3(0.06, 0.07, 0.10);
  vec3 neg = vec3(0.30, 0.58, 1.00);
  vec3 pos = vec3(1.00, 0.60, 0.22);
  return mix(mid, v < 0.0 ? neg : pos, a);
}

void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 p = u_center + (v_uv * 2.0 - 1.0) * vec2(u_halfWidth, u_halfWidth / aspect);
  float r = length(p);
  float phi = atan(p.y, p.x);

  bool valid;
  vec2 h = strain(u_time - r, phi, valid);

  if (u_raw) {
    outColor = vec4(h.x, -h.y, valid ? 1.0 : 0.0, 1.0);
    return;
  }

  vec3 background = vec3(0.035, 0.04, 0.055);
  vec3 color = valid ? diverging(h.x * u_scale) : background;
  // Near zone: fade to background where the far-zone formula does not apply.
  float mask = smoothstep(0.75 * u_maskRadius, u_maskRadius, r);
  color = mix(background, color, mask);
  // Faint ring marking the near-zone boundary.
  float ring = 1.0 - smoothstep(0.0, 1.5 * u_halfWidth / u_resolution.x, abs(r - u_maskRadius));
  color = mix(color, vec3(0.55, 0.6, 0.7), 0.35 * ring);
  outColor = vec4(color, 1.0);
}
