// Volume view (3D): ray-marches the strain through a sphere around the source
// (shaders/volume.frag) into a reduced-resolution target, then upsamples and
// composites it over the scene. The resolution adapts to the frame rate.

import * as THREE from "three";
import strainGlsl from "./shaders/strain.glsl?raw";
import volumeMain from "./shaders/volume.frag?raw";

const FULLSCREEN_VERTEX = /* glsl */ `
  in vec3 position;
  out vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D u_tex;
  uniform float u_opacity;
  in vec2 vUv;
  out vec4 outColor;
  void main() {
    outColor = texture(u_tex, vUv) * u_opacity;  // premultiplied alpha
  }
`;

const STEPS = 128;
const VOLUME_ROWS = 3; // (2,2) and the two strongest other modes (the table orders rows by peak amplitude)
const DENSITY = 0.035; // per M at full saturation
const SHARPNESS = 8;
const AXIS_CONE = (8 * Math.PI) / 180;
const SCALE_MIN = 0.3; // fraction of the canvas's CSS-pixel resolution
const SCALE_MAX = 1.0;

/** One triangle covering the screen. */
function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return g;
}

/**
 * Maps (ndc.x, ndc.y, 1) to the world direction of the ray through that point
 * of a perspective camera's view (see u_rayBasis in volume.frag). Built from the
 * camera's basis and field of view, not by unprojecting, to stay accurate in float32.
 */
export function rayMatrix(camera: THREE.PerspectiveCamera): THREE.Matrix3 {
  camera.updateMatrixWorld();
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(tanY * camera.aspect);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(tanY);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  return new THREE.Matrix3().set(right.x, up.x, forward.x, right.y, up.y, forward.y, right.z, up.z, forward.z);
}

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
  private readonly composite: THREE.RawShaderMaterial;
  private readonly marchScene = new THREE.Scene();
  private readonly compositeScene = new THREE.Scene();
  private readonly dummyCamera = new THREE.OrthographicCamera();
  private target: THREE.WebGLRenderTarget | null = null;
  private frame = 0;
  /** Render resolution as a fraction of the canvas's CSS pixels; adapted to the frame rate. */
  scale = 0.5;
  private frameMs = 16;
  private lastFrame = 0;
  private lastAdapt = 0;

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
    this.composite = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      uniforms: { u_tex: { value: null }, u_opacity: { value: 1 } },
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthTest: false,
      depthWrite: false,
    });
    const tri = fullscreenTriangle();
    for (const [scene, mat] of [
      [this.marchScene, this.material],
      [this.compositeScene, this.composite],
    ] as const) {
      const mesh = new THREE.Mesh(tri, mat);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
  }

  private ensureTarget(w: number, h: number): THREE.WebGLRenderTarget {
    if (!this.target || this.target.width !== w || this.target.height !== h) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
    }
    return this.target;
  }

  /** Adapts the resolution: lower when frames are slow, higher when they keep up with the display. */
  /** Disables the frame-rate adaptation (benchmarks). */
  fixedScale = false;

  private adapt(now: number) {
    if (this.fixedScale) return;
    if (this.lastFrame > 0) {
      const dt = Math.min(now - this.lastFrame, 100);
      this.frameMs += 0.1 * (dt - this.frameMs);
    }
    this.lastFrame = now;
    if (now - this.lastAdapt < 500) return;
    this.lastAdapt = now;
    if (this.frameMs > 24) this.scale = Math.max(SCALE_MIN, this.scale * 0.85);
    else if (this.frameMs < 18) this.scale = Math.min(SCALE_MAX, this.scale * 1.08);
  }

  private setCamera(camera: THREE.PerspectiveCamera, w: number, h: number) {
    const u = this.material.uniforms;
    (u.u_eye.value as THREE.Vector3).copy(camera.position);
    (u.u_rayBasis.value as THREE.Matrix3).copy(rayMatrix(camera));
    (u.u_resolution.value as THREE.Vector2).set(w, h);
  }

  /** Ray-marches and composites over whatever is already on screen. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, cssW: number, cssH: number, f: VolumeFrame) {
    const now = performance.now();
    this.adapt(now);
    const w = Math.max(1, Math.round(cssW * this.scale));
    const h = Math.max(1, Math.round(cssH * this.scale));
    const target = this.ensureTarget(w, h);
    this.setCamera(camera, w, h);
    const u = this.material.uniforms;
    u.u_time.value = f.time;
    u.u_scale.value = f.scale;
    u.u_maskRadius.value = f.maskRadius;
    u.u_component.value = f.component;
    u.u_radius.value = f.radius;
    u.u_raw.value = false;
    u.u_jitter.value = (this.frame++ * 0.618034) % 1;

    const clear = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.marchScene, this.dummyCamera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, clearAlpha);

    this.composite.uniforms.u_tex.value = target.texture;
    this.composite.uniforms.u_opacity.value = f.opacity;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.compositeScene, this.dummyCamera);
    renderer.autoClear = autoClear;
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
    const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, format: THREE.RGBAFormat });
    renderer.setRenderTarget(target);
    renderer.render(this.marchScene, this.dummyCamera);
    const pixels = new Float32Array(w * h * 4);
    renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
    renderer.setRenderTarget(null);
    target.dispose();
    u.u_raw.value = false;
    return { pixels, camera };
  }
}
