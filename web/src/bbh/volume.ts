// Volume view (3D): ray-marches the strain through a sphere around the source
// (shaders/volume.frag) in a reduced-resolution pass (common/reducedPass.ts)
// that is upsampled and composited over the scene.

import * as THREE from "three";
import { rayMatrix } from "../common/rays";
import { FULLSCREEN_VERTEX, ReducedPass } from "../common/reducedPass";
import strainGlsl from "./shaders/strain.glsl?raw";
import volumeMain from "./shaders/volume.frag?raw";

const STEPS = 128;
const VOLUME_ROWS = 3; // (2,2) and the two strongest other modes (the table orders rows by peak amplitude)
const DENSITY = 0.035; // per M at full saturation
const SHARPNESS = 8;
const AXIS_CONE = (8 * Math.PI) / 180;

export interface VolumeFrame {
  time: number;
  scale: number; // colour units per r·h
  maskRadius: number;
  component: 0 | 1;
  radius: number;
  opacity: number;
}

export class Volume {
  readonly material: THREE.RawShaderMaterial;
  readonly pass: ReducedPass;
  private frame = 0;

  constructor(uniforms: Record<string, THREE.IUniform>) {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: `${strainGlsl}\n${volumeMain}`,
      uniforms: {
        ...uniforms,
        u_eye: { value: new THREE.Vector3() },
        u_rayBasis: { value: new THREE.Matrix3() },
        u_resolution: { value: new THREE.Vector2(1, 1) },
        u_radius: { value: 100 },
        u_steps: { value: STEPS },
        u_volumeRows: { value: VOLUME_ROWS },
        u_component: { value: 0 },
        u_time: { value: 0 },
        u_scale: { value: 1 },
        u_maskRadius: { value: 0 },
        u_density: { value: DENSITY },
        u_sharpness: { value: SHARPNESS },
        u_axisCone: { value: AXIS_CONE },
        u_jitter: { value: 0 },
        u_raw: { value: false },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.pass = new ReducedPass(this.material);
  }

  private setCamera(camera: THREE.PerspectiveCamera, w: number, h: number) {
    const u = this.material.uniforms;
    (u.u_eye.value as THREE.Vector3).copy(camera.position);
    (u.u_rayBasis.value as THREE.Matrix3).copy(rayMatrix(camera));
    (u.u_resolution.value as THREE.Vector2).set(w, h);
  }

  /** Ray-marches and composites over whatever is already on screen. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, cssW: number, cssH: number, f: VolumeFrame) {
    const u = this.material.uniforms;
    u.u_time.value = f.time;
    u.u_scale.value = f.scale;
    u.u_maskRadius.value = f.maskRadius;
    u.u_component.value = f.component;
    u.u_radius.value = f.radius;
    u.u_raw.value = false;
    u.u_jitter.value = (this.frame++ * 0.618034) % 1;
    this.pass.render(renderer, cssW, cssH, f.opacity, (w, h) => this.setCamera(camera, w, h));
  }

  /**
   * Self-test support: raw (r·h₊, r·h×, valid) at each pixel ray's closest
   * approach to the source, for a perspective camera at `eye` looking at it.
   */
  renderRaw(renderer: THREE.WebGLRenderer, time: number, eye: THREE.Vector3, w: number, h: number) {
    const camera = new THREE.PerspectiveCamera(40, w / h, 1, 1e5);
    camera.up.set(0, 0, 1);
    camera.position.copy(eye);
    camera.lookAt(0, 0, 0);
    this.setCamera(camera, w, h);
    const u = this.material.uniforms;
    u.u_time.value = time;
    u.u_raw.value = true;
    const pixels = this.pass.renderRaw(renderer, w, h);
    u.u_raw.value = false;
    return { pixels, camera };
  }
}
