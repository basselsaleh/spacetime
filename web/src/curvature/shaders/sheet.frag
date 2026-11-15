// Grid lines drawn per pixel from the slice's coordinates, anti-aliased with
// screen-space derivatives, over a lit sheet optionally tinted by its
// Gaussian curvature K on a symmetric log scale.
precision highp float;

uniform vec3 u_eye;
uniform int u_grid;         // 0: Cartesian x, y; 1: polar r, φ; 2: polar, circles at equal proper distance
uniform float u_spacing;    // line spacing in M (major lines every 5)
uniform bool u_curvature;   // tint by K
uniform float u_k0;         // the log scale's linear width
uniform float u_kmax;       // |K| at full tint
uniform vec3 u_base;
uniform vec3 u_neg;
uniform vec3 u_pos;
uniform vec3 u_line;

in vec3 vWorld;
in vec3 vNormal;
in vec2 vCoord;
in float vDist;
in float vK;
out vec4 outColor;

const float PI = 3.14159265358979;
const float ANGLE = PI / 12.0; // radial lines every 15° (major every 45°)

// Coverage of the nearest line of a family v = k · spacing, given v's change per pixel.
// Lines fade out where they'd crowd closer than a few pixels apart.
float lineCoverage(float v, float spacing, float fw) {
  float d = abs(fract(v / spacing - 0.5) - 0.5) * spacing;
  float w = 0.5 * fw;
  float line = 1.0 - smoothstep(w, w + fw, d);
  return line * (1.0 - smoothstep(0.15 * spacing, 0.4 * spacing, fw));
}

float family(float v, float spacing, float fw, float majorEvery) {
  return max(0.6 * lineCoverage(v, spacing, fw), lineCoverage(v, spacing * majorEvery, fw));
}

void main() {
  float x = vCoord.x;
  float y = vCoord.y;
  float grid;
  if (u_grid == 0) {
    grid = max(family(x, u_spacing, fwidth(x), 5.0), family(y, u_spacing, fwidth(y), 5.0));
  } else {
    float r = length(vCoord);
    // φ's change per pixel without atan's jump at ±π: dφ = (x dy − y dx)/r².
    float fwPhi = (abs(x * dFdx(y) - y * dFdx(x)) + abs(x * dFdy(y) - y * dFdy(x))) / (r * r);
    float radial = family(atan(y, x), ANGLE, fwPhi, 3.0);
    float circles = u_grid == 1 ? family(r, u_spacing, fwidth(r), 5.0) : family(vDist, u_spacing, fwidth(vDist), 5.0);
    grid = max(radial, circles);
  }

  vec3 base = u_base;
  if (u_curvature) {
    float t = sign(vK) * log(1.0 + abs(vK) / u_k0) / log(1.0 + u_kmax / u_k0);
    base = mix(u_base, vK < 0.0 ? u_neg : u_pos, 0.85 * clamp(abs(t), 0.0, 1.0));
  }

  vec3 n = normalize(vNormal);
  vec3 v = normalize(u_eye - vWorld);
  vec3 light = normalize(vec3(0.35, -0.5, 1.0));
  float shade = 0.3 + 0.4 * abs(dot(n, light)) + 0.35 * abs(dot(n, v));

  vec3 color = mix(base * shade, u_line, 0.8 * grid);
  outColor = vec4(color, 1.0);
}
