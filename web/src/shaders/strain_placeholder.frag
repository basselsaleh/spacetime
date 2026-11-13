#version 300 es
// STEP 0 PLACEHOLDER. Equatorial-plane pattern of a single (2,2) mode with
// constant frequency: r·h+ ∝ cos(2φ − ω(t − r)). Units of M. Replaced in step 2
// by the real mode sum sampled from the waveform texture.
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform vec2 u_resolution;   // canvas size in pixels
uniform float u_halfWidth;   // half the view width, in M
uniform float u_time;        // coordinate time, in M
uniform float u_omega22;     // (2,2) angular frequency, from Rust
uniform float u_innerRadius; // far-zone formula masked inside this radius

// Diverging map: squeezed (blue) ↔ 0 (dark) ↔ stretched (orange).
vec3 diverging(float x) {
  x = clamp(x, -1.0, 1.0);
  vec3 neg = vec3(0.27, 0.55, 1.0);
  vec3 pos = vec3(1.0, 0.58, 0.22);
  vec3 mid = vec3(0.05, 0.06, 0.09);
  return x < 0.0 ? mix(mid, neg, -x) : mix(mid, pos, x);
}

void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 pos = (v_uv * 2.0 - 1.0) * vec2(u_halfWidth, u_halfWidth / aspect);
  float r = length(pos);
  float phi = atan(pos.y, pos.x);

  float tRet = u_time - r;
  float rh = cos(2.0 * phi - u_omega22 * tRet);

  // Fade out where the wave-zone formula is not valid.
  float mask = smoothstep(u_innerRadius * 0.6, u_innerRadius, r);
  outColor = vec4(diverging(rh * mask), 1.0);
}
