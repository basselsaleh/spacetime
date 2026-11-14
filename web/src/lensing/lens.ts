// The lensing renderer: one full-screen pass (shaders/lens.frag) that traces
// every pixel's light ray through the Kerr spacetime and samples the
// procedural sky (shaders/sky.glsl). Runs in the shared adaptive-resolution
// pass (common/reducedPass.ts), up to the display's device-pixel resolution.

import * as THREE from "three";
import { rayMatrix } from "../common/rays";
import { FULLSCREEN_VERTEX, ReducedPass } from "../common/reducedPass";
import lensMain from "./shaders/lens.frag?raw";
import skyGlsl from "./shaders/sky.glsl?raw";

export class Lens {
  readonly material: THREE.RawShaderMaterial;
  readonly pass: ReducedPass;
  /** Spin a/M, in [0, 1). */
  spin = 0;
  /** Use the Kerr integrator even at spin 0 (self-test and benchmark only). */
  forceKerr = false;

  constructor(maxScale: number) {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: `${skyGlsl}\n${lensMain}`,
      uniforms: {
        u_eye: { value: new THREE.Vector3() },
        u_rayBasis: { value: new THREE.Matrix3() },
        u_resolution: { value: new THREE.Vector2(1, 1) },
        u_pixelAngle: { value: 1e-3 },
        u_raw: { value: false },
        u_spin: { value: 0 },
        u_kerr: { value: false },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.pass = new ReducedPass(this.material, { scale: 1, scaleMin: 0.35, scaleMax: maxScale });
  }

  private setCamera(camera: THREE.PerspectiveCamera, w: number, h: number) {
    const u = this.material.uniforms;
    (u.u_eye.value as THREE.Vector3).copy(camera.position);
    (u.u_rayBasis.value as THREE.Matrix3).copy(rayMatrix(camera));
    (u.u_resolution.value as THREE.Vector2).set(w, h);
    u.u_pixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / h;
    u.u_spin.value = this.spin;
    u.u_kerr.value = this.forceKerr || this.spin > 0;
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, cssW: number, cssH: number) {
    this.material.uniforms.u_raw.value = false;
    this.pass.render(renderer, cssW, cssH, 1, (w, h) => this.setCamera(camera, w, h));
  }

  /** Self-test: (sky direction xyz, escaped 0/1) per pixel for `camera`, at w × h. */
  renderRaw(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, w: number, h: number): Float32Array {
    this.setCamera(camera, w, h);
    this.material.uniforms.u_raw.value = true;
    const pixels = this.pass.renderRaw(renderer, w, h);
    this.material.uniforms.u_raw.value = false;
    return pixels;
  }
}
