// A full-screen shader pass rendered at reduced resolution into an offscreen
// target, then upsampled and composited over the screen (premultiplied alpha).
// The resolution adapts to the frame rate. Used by the BBH strain volume; the
// lensing renderer is meant to reuse it.

import * as THREE from "three";

/** Vertex shader for a full-screen triangle (`fullscreenTriangle`), with vUv in [0, 1]². */
export const FULLSCREEN_VERTEX = /* glsl */ `
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

/** One triangle covering the screen. */
export function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return g;
}

export interface ReducedPassOptions {
  /** Starting resolution, as a fraction of the canvas's CSS pixels. */
  scale?: number;
  scaleMin?: number;
  scaleMax?: number;
}

export class ReducedPass {
  /** Render resolution as a fraction of the canvas's CSS pixels; adapted to the frame rate. */
  scale: number;
  /** Disables the frame-rate adaptation (benchmarks). */
  fixedScale = false;
  private readonly scaleMin: number;
  private readonly scaleMax: number;
  private readonly passScene = new THREE.Scene();
  private readonly compositeScene = new THREE.Scene();
  private readonly composite: THREE.RawShaderMaterial;
  private readonly dummyCamera = new THREE.OrthographicCamera();
  private target: THREE.WebGLRenderTarget | null = null;
  private frameMs = 16;
  private lastFrame = 0;
  private lastAdapt = 0;

  /** `material` must use FULLSCREEN_VERTEX (GLSL 3) and output premultiplied alpha. */
  constructor(material: THREE.RawShaderMaterial, options: ReducedPassOptions = {}) {
    this.scale = options.scale ?? 0.5;
    this.scaleMin = options.scaleMin ?? 0.3;
    this.scaleMax = options.scaleMax ?? 1.0;
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
      [this.passScene, material],
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

  /** Lowers the resolution when frames are slow, raises it when they keep up with the display. */
  private adapt(now: number) {
    if (this.fixedScale) return;
    if (this.lastFrame > 0) {
      const dt = Math.min(now - this.lastFrame, 100);
      this.frameMs += 0.1 * (dt - this.frameMs);
    }
    this.lastFrame = now;
    if (now - this.lastAdapt < 500) return;
    this.lastAdapt = now;
    if (this.frameMs > 24) this.scale = Math.max(this.scaleMin, this.scale * 0.85);
    else if (this.frameMs < 18) this.scale = Math.min(this.scaleMax, this.scale * 1.08);
  }

  /**
   * Renders the pass at reduced resolution and composites it over whatever is
   * already on screen. `prepare(w, h)` is called with the target size first, to
   * set size-dependent uniforms (e.g. u_resolution).
   */
  render(
    renderer: THREE.WebGLRenderer,
    cssW: number,
    cssH: number,
    opacity: number,
    prepare: (w: number, h: number) => void,
  ) {
    this.adapt(performance.now());
    const w = Math.max(1, Math.round(cssW * this.scale));
    const h = Math.max(1, Math.round(cssH * this.scale));
    const target = this.ensureTarget(w, h);
    prepare(w, h);

    const clear = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.passScene, this.dummyCamera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, clearAlpha);

    this.composite.uniforms.u_tex.value = target.texture;
    this.composite.uniforms.u_opacity.value = opacity;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.compositeScene, this.dummyCamera);
    renderer.autoClear = autoClear;
  }

  /** Self-tests: renders the pass into a w × h float target and reads the RGBA values back. */
  renderRaw(renderer: THREE.WebGLRenderer, w: number, h: number): Float32Array {
    const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, format: THREE.RGBAFormat });
    renderer.setRenderTarget(target);
    renderer.render(this.passScene, this.dummyCamera);
    const pixels = new Float32Array(w * h * 4);
    renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
    renderer.setRenderTarget(null);
    target.dispose();
    return pixels;
  }
}
