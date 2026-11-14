// Volume view: gravitational-wave strain throughout a sphere around the source,
// ray-marched per pixel. strain.glsl (mode table, mode sum, colour map) is
// prepended to this.
//
// Each sample along a pixel's ray is a 3D point at distance r; it carries
// r·h₊ (or r·h×) at retarded time t − r, normalised like the slices. Density
// rises steeply with |r·h| (crests and troughs), so the wave shows as glowing
// sheets: orange where h > 0, blue where h < 0. With h₊ these are the two-armed
// spiral sheets of the binary, moving outward with the wave. Samples inside the
// near zone, where the far-zone formula does not apply, are skipped.
//
// Front-to-back compositing into a premultiplied-alpha target at reduced
// resolution (volume.ts upsamples and composites it over the scene).

out vec4 outColor;

#define MAX_STEPS 256

uniform vec3 u_eye;           // camera position, M
// Ray direction (unnormalised) for NDC (x, y): screen-right and screen-up scaled
// by the half-extent of the view at unit distance, and forward.
uniform mat3 u_rayBasis;
uniform vec2 u_resolution;    // render-target pixels
uniform float u_radius;       // the volume is the sphere |p| < u_radius, M
uniform int u_steps;
uniform int u_volumeRows;     // modes in the volume's sum (the first rows: (2,2) first); the slices use all
uniform int u_component;      // 0: h₊, 1: h×
uniform float u_time;         // coordinate time at the source, M
uniform float u_scale;        // colour units per r·h (1/peak × gain)
uniform float u_maskRadius;   // near zone, M
uniform float u_density;      // opacity per M at full saturation
uniform float u_sharpness;    // density ∝ tanh(|r·h|)^u_sharpness: higher keeps only crests and troughs
uniform float u_axisCone;     // fade within this angle (rad) of the orbital axis, where h₊/h× are ill-defined
uniform float u_jitter;       // per-frame offset of the sample positions (hides banding)
uniform bool u_raw;           // self-test: raw (r·h₊, r·h×, valid) at the ray's closest approach

// Interleaved gradient noise: per-pixel sample offset in [0, 1).
float noise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
  vec2 ndc = gl_FragCoord.xy / u_resolution * 2.0 - 1.0;
  vec3 d = normalize(u_rayBasis * vec3(ndc, 1.0));
  // Work relative to the ray's closest approach to the source, m, so that a
  // distant camera costs no float precision.
  float tc = -dot(u_eye, d);
  vec3 m = u_eye + tc * d;

  if (u_raw) {
    float r, theta, phi;
    sphericalAngles(m, r, theta, phi);
    bool valid;
    vec2 h = strain(u_time - r, theta, phi, valid);
    outColor = vec4(h.x, -h.y, valid ? 1.0 : 0.0, 1.0);
    return;
  }

  float h2 = u_radius * u_radius - dot(m, m);
  if (h2 <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  float hw = sqrt(h2);
  float a0 = max(-hw, -tc);  // entry, relative to m (clipped at the camera)
  float a1 = hw;
  if (a1 <= a0) {
    outColor = vec4(0.0);
    return;
  }
  float ds = (a1 - a0) / float(u_steps);
  float jit = fract(noise(gl_FragCoord.xy) + u_jitter);
  vec3 pos = vec3(1.0, 0.60, 0.22);
  vec3 neg = vec3(0.30, 0.58, 1.0);

  vec4 acc = vec4(0.0);
  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= u_steps || acc.a > 0.97) break;
    vec3 p = m + (a0 + (float(i) + jit) * ds) * d;
    float r, theta, phi;
    sphericalAngles(p, r, theta, phi);
    float fade = smoothstep(0.75 * u_maskRadius, u_maskRadius, r) * (1.0 - smoothstep(0.85 * u_radius, u_radius, r));
    if (fade <= 0.0) continue;
    bool valid;
    vec2 h = strainRows(u_time - r, theta, phi, min(u_rows, u_volumeRows), valid);
    if (!valid) continue;
    float v = (u_component == 0 ? h.x : -h.y) * u_scale;
    float a = tanh(abs(v));
    // h₊ and h× are measured against (θ̂, φ̂), which winds around the axis: the
    // sheets meet there in a seam that is the basis, not the wave.
    float axis = smoothstep(0.5 * u_axisCone, u_axisCone, min(theta, PI - theta));
    float alpha = 1.0 - exp(-u_density * pow(a, u_sharpness) * fade * axis * ds);
    vec3 col = (v < 0.0 ? neg : pos) * (0.5 + 0.9 * a);
    acc.rgb += (1.0 - acc.a) * alpha * col;
    acc.a += (1.0 - acc.a) * alpha;
  }
  outColor = acc;
}
