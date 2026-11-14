// Procedural sky on the celestial sphere at infinity: stars in three layers, a
// Milky-Way-like band with dust lanes, faint nebulae and a few galaxies.
// `sky(d, pixelAngle)` returns the color seen in unit direction d (black hole
// rest frame, +z up); pixelAngle is the angular size of a pixel, so stars are
// never drawn smaller than about one pixel.
precision highp float;
precision highp int;

// Hashes (Dave Hoskins, "Hash without Sine").
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float valueNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * valueNoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}

// Star color from a 0..1 "temperature": red, through yellow-white, to blue-white.
vec3 starColor(float t) {
  vec3 red = vec3(1.0, 0.62, 0.42);
  vec3 white = vec3(1.0, 0.95, 0.88);
  vec3 blue = vec3(0.66, 0.78, 1.0);
  return t < 0.5 ? mix(red, white, t * 2.0) : mix(white, blue, (t - 0.5) * 2.0);
}

// One layer of stars: one candidate per cell of a 3D grid of spacing 1/n, kept
// if it lies within a thin shell around the unit sphere (seamless, no cube
// faces). Each star is a Gaussian of angular radius `size`, widened to at least
// `pixelAngle` with its total brightness preserved.
vec3 starLayer(vec3 d, float n, float keep, float gain, float size, float seed, float pixelAngle) {
  vec3 p = d * n;
  vec3 c0 = floor(p);
  float sigma = max(size, 0.6 * pixelAngle);
  float norm = (size * size) / (sigma * sigma);
  vec3 col = vec3(0.0);
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 c = c0 + vec3(x, y, z);
        if (hash13(c + seed) > keep) continue;
        vec3 q = (c + hash33(c + seed + 3.7)) / n;
        float lq = length(q);
        if (abs(lq - 1.0) > 0.5 / n) continue;
        vec3 sd = q / lq;
        float ang2 = 2.0 * max(1.0 - dot(sd, d), 0.0);
        float b = pow(hash13(c + seed + 9.1), 6.0);
        col += starColor(hash13(c + seed + 5.3)) * (gain * b * norm * exp(-ang2 / (2.0 * sigma * sigma)));
      }
    }
  }
  return col;
}

// A galaxy at direction `center`, with major/minor axes along e1/e2 (unit,
// perpendicular to center) of angular sizes a, b: a bright core, an
// exponential disk and faint two-armed spiral structure.
vec3 galaxy(vec3 d, vec3 center, vec3 e1, vec3 e2, float a, float b, vec3 tint) {
  if (dot(d, center) <= 0.0) return vec3(0.0);
  float x = dot(d, e1) / a;
  float y = dot(d, e2) / b;
  float r = sqrt(x * x + y * y);
  if (r > 6.0) return vec3(0.0);
  float th = atan(y, x);
  float arms = 0.55 + 0.45 * cos(2.0 * th - 4.0 * log(r + 0.05));
  float disk = exp(-r * 1.6) * arms;
  float core = exp(-r * r * 18.0);
  return tint * (0.55 * disk + 1.4 * core);
}

vec3 sky(vec3 d, float pixelAngle) {
  vec3 col = vec3(0.0);

  // Galactic band (a great circle with normal A), mottled, with dust lanes.
  vec3 A = normalize(vec3(0.35, -0.42, 0.84));
  float lat = dot(d, A);
  float band = exp(-lat * lat / (2.0 * 0.11 * 0.11));
  float mottle = fbm(d * 5.0);
  float dust = fbm(d * 11.0 + vec3(3.1, 1.7, 8.2));
  float lanes = 1.0 - 0.75 * smoothstep(0.5, 0.68, dust) * exp(-lat * lat / (2.0 * 0.05 * 0.05));
  col += vec3(0.62, 0.56, 0.48) * (0.22 * band * (0.35 + 0.9 * mottle) * lanes);

  // Faint colored nebulae.
  float neb = fbm(d * 2.2 + 11.0);
  col += vec3(0.55, 0.18, 0.32) * 0.10 * smoothstep(0.55, 0.8, neb);
  col += vec3(0.15, 0.32, 0.55) * 0.07 * smoothstep(0.6, 0.85, fbm(d * 2.6 - 7.0));

  // Galaxies. The first sits behind the hole as seen from the default camera
  // position (0, −20, 3), so the Einstein ring is visible on load.
  vec3 g1 = normalize(vec3(0.0, 1.0, -0.15));
  col += galaxy(d, g1, normalize(cross(g1, vec3(0.3, 0.0, 1.0))), normalize(cross(g1, cross(g1, vec3(0.3, 0.0, 1.0)))), 0.05, 0.022, vec3(1.0, 0.86, 0.68));
  vec3 g2 = normalize(vec3(-0.8, -0.3, 0.52));
  col += galaxy(d, g2, normalize(cross(g2, vec3(0.0, 0.0, 1.0))), normalize(cross(g2, cross(g2, vec3(0.0, 0.0, 1.0)))), 0.035, 0.03, vec3(0.75, 0.82, 1.0));
  vec3 g3 = normalize(vec3(0.7, 0.1, 0.71));
  col += galaxy(d, g3, normalize(cross(g3, vec3(1.0, 0.0, 0.0))), normalize(cross(g3, cross(g3, vec3(1.0, 0.0, 0.0)))), 0.02, 0.008, vec3(1.0, 0.8, 0.75));

  // Stars: few bright, more medium, many faint.
  col += starLayer(d, 26.0, 0.55, 4.0, 0.0020, 1.0, pixelAngle);
  col += starLayer(d, 70.0, 0.45, 1.3, 0.0012, 2.0, pixelAngle);
  col += starLayer(d, 180.0, 0.35, 0.5, 0.0008, 3.0, pixelAngle);

  // Soft saturation.
  return 1.0 - exp(-col * 1.4);
}
