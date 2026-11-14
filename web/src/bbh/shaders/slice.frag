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
// The mode table, mode sum and colour map are in strain.glsl, prepended to this.

in vec3 vWorld;
out vec4 outColor;

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
uniform vec3 u_nearColor;     // fill inside the near zone (sRGB)


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
  float r, theta, phi;
  sphericalAngles(p3, r, theta, phi);

  bool valid;
  vec2 h = strain(u_time - r, theta, phi, valid);
  float hplus = h.x;
  float hcross = -h.y;

  if (u_raw) {
    outColor = vec4(hplus, hcross, valid ? 1.0 : 0.0, 1.0);
    return;
  }

  float value = u_component == 0 ? hplus : hcross;
  // Outside the data (before the waveform starts or after the ringdown): zero strain.
  vec3 color = valid ? diverging(value * u_scale) : paletteColor(0.0);
  // Near zone: fade to its own fill where the far-zone formula does not apply.
  float mask = smoothstep(0.75 * u_maskRadius, u_maskRadius, r);
  color = mix(u_nearColor, color, mask);
  // Faint ring marking the near-zone boundary (width from screen derivatives).
  float aa = max(fwidth(r), 1e-4);
  float ring = 1.0 - smoothstep(0.0, 1.5 * aa, abs(r - u_maskRadius));
  color = mix(color, vec3(0.55, 0.6, 0.7), 0.35 * ring);
  outColor = vec4(color, u_opacity);
}
