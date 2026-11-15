// The star as a glowing ball resting in its bowl: radius r_s, so from above it
// covers exactly the part of the sheet that is the star's interior. A marker of
// where the star is, not part of the geometry: the sheet itself is the slice of
// space, inside the star and out.

import * as THREE from "three";

const SURFACE_VERT = /* glsl */ `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 modelMatrix;
in vec3 position;
in vec3 normal;
out vec3 vNormal;
out vec3 vWorld;
void main() {
  vNormal = normal; // a sphere at the origin of its own frame, translated only
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Limb-darkened: white-yellow at the center of the disk, deep orange at its edge.
const SURFACE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 u_eye;
in vec3 vNormal;
in vec3 vWorld;
out vec4 outColor;
void main() {
  float mu = abs(dot(normalize(vNormal), normalize(u_eye - vWorld)));
  vec3 core = vec3(1.0, 0.96, 0.78);
  vec3 limb = vec3(1.0, 0.55, 0.12);
  outColor = vec4(mix(limb, core, pow(mu, 0.6)), 1.0);
}`;

/** A soft radial glow texture: flat out to the star's edge, then falling off. */
function glowTexture(edge: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255, 210, 120, 0.55)");
  grad.addColorStop(edge, "rgba(255, 190, 90, 0.45)");
  grad.addColorStop(Math.min(edge + 0.2, 0.95), "rgba(255, 150, 50, 0.12)");
  grad.addColorStop(1, "rgba(255, 140, 40, 0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const HALO = 3; // halo diameter in star diameters

export class StarGlow {
  readonly group = new THREE.Group();
  private readonly surface: THREE.Mesh;
  private readonly halo: THREE.Sprite;
  private readonly material: THREE.RawShaderMaterial;

  constructor() {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      uniforms: { u_eye: { value: new THREE.Vector3() } },
    });
    this.surface = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.material);
    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(1 / HALO),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        // Drawn over the sheet, so the glow isn't sliced where its plane cuts the bowl.
        depthTest: false,
      }),
    );
    this.halo.renderOrder = 1;
    this.group.add(this.surface, this.halo);
  }

  /** A ball of radius `radius` resting on the point (0, 0, zBottom). */
  place(radius: number, zBottom: number) {
    this.group.position.set(0, 0, zBottom + radius);
    this.surface.scale.setScalar(radius);
    this.halo.scale.setScalar(2 * HALO * radius);
  }

  update(camera: THREE.Camera) {
    (this.material.uniforms.u_eye.value as THREE.Vector3).copy(camera.position);
  }
}
