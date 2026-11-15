// The embedded sheet: positions in R³ come from the profile (sheet.ts); the
// slice's own coordinates ride along for the grid lines and the coloring.
precision highp float;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;

in vec3 position;
in vec3 normal;
in vec2 aCoord; // coordinate Cartesian x = r cos φ, y = r sin φ
in float aDist; // proper radial distance from the horizon
in float aK;    // Gaussian curvature

out vec3 vWorld;
out vec3 vNormal;
out vec2 vCoord;
out float vDist;
out float vK;

void main() {
  vWorld = position; // the sheet's model matrix is the identity
  vNormal = normal;
  vCoord = aCoord;
  vDist = aDist;
  vK = aK;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
