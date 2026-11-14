// The 3D scene: the strain slice as a plane, tendex/vortex lines, black holes
// and the probe as spheres, and one perspective camera that serves both the
// flat view and the 3D view.
//
// Flat view: the strain on a slice. The camera looks straight at it with a 1°
// field of view from far away, which is indistinguishable from an orthographic
// view, so the picture matches the 2D app. 3D view: tendex and vortex lines,
// with a 40° orbit camera and +z (the orbital axis) up. Switching is a dolly
// zoom (the field of view and the camera's orientation are interpolated while
// the distance keeps the slice framed) with the slice cross-fading into the lines.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import sliceVertex from "./shaders/slice.vert?raw";
import sliceFragment from "./shaders/slice.frag?raw";
import { sliceAxes, sliceTo3D, type Camera, type SceneState, type SliceConfig, type Vec3 } from "./slice";
import { TendexLines } from "./tendex";
import type { PreparedWaveform } from "./waveform";

export type ViewMode = "flat" | "3d";

const MAX_ROWS = 16;
const FLAT_FOV = 1; // degrees
const ORBIT_FOV = 40; // degrees
const ORBIT_ELEVATION = (55 * Math.PI) / 180; // camera angle from the slice normal in 3D
const TRANSITION_MS = 1600;
const BACKGROUND = 0x090a0e;
const Z_UP = new THREE.Vector3(0, 0, 1);
const LINES_EXTENT = 0.6; // tendex/vortex lines fill this fraction of the framed region

/** A camera pose: orientation, the point looked at, and the half-height framed there. */
interface Pose {
  quaternion: THREE.Quaternion;
  target: THREE.Vector3;
  halfHeight: number;
  fov: number;
}

const sphereVertex = /* glsl */ `
  varying vec3 vNormalView;
  varying vec3 vPosView;
  void main() {
    vec4 pv = modelViewMatrix * vec4(position, 1.0);
    vPosView = pv.xyz;
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * pv;
  }
`;

/**
 * A core (black for horizons, `color` for markers) with a bright rim
 * (Fresnel-like); `ghost` draws only a faint rim.
 */
function sphereMaterial(color: THREE.Color, ghost: boolean, solidCore: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { u_opacity: { value: 1 }, u_color: { value: color } },
    vertexShader: sphereVertex,
    fragmentShader: /* glsl */ `
      uniform float u_opacity;
      uniform vec3 u_color;
      varying vec3 vNormalView;
      varying vec3 vPosView;
      void main() {
        float facing = abs(dot(normalize(vNormalView), normalize(-vPosView)));
        float rim = pow(1.0 - facing, 3.0);
        ${ghost
          ? "gl_FragColor = vec4(u_color, 0.4 * rim * u_opacity);"
          : solidCore
            ? "gl_FragColor = vec4(u_color * (0.75 + 0.25 * facing), u_opacity);"
            : "gl_FragColor = vec4(mix(vec3(0.0), u_color, 0.9 * rim), u_opacity);"}
      }
    `,
    transparent: true,
    depthWrite: !ghost,
    depthFunc: ghost ? THREE.GreaterDepth : THREE.LessEqualDepth,
  });
}

/** A sphere drawn solid where visible and as a faint outline where hidden. */
class Ball {
  readonly group = new THREE.Group();
  private readonly solid: THREE.ShaderMaterial;
  private readonly ghost: THREE.ShaderMaterial;

  constructor(geometry: THREE.SphereGeometry, color: THREE.Color, solidCore = false) {
    this.solid = sphereMaterial(color, false, solidCore);
    this.ghost = sphereMaterial(color, true, solidCore);
    const solid = new THREE.Mesh(geometry, this.solid);
    const ghost = new THREE.Mesh(geometry, this.ghost);
    solid.renderOrder = 2;
    ghost.renderOrder = 3;
    this.group.add(solid, ghost);
  }

  set(position: Vec3, radius: number, opacity: number) {
    this.group.visible = opacity > 0.001;
    this.group.position.set(...position);
    this.group.scale.setScalar(radius);
    this.solid.uniforms.u_opacity.value = opacity;
    this.ghost.uniforms.u_opacity.value = opacity;
  }
}

function sliceUniforms(): Record<string, THREE.IUniform> {
  return {
    u_table: { value: null },
    u_width: { value: 0 },
    u_samples: { value: 0 },
    u_rows: { value: 0 },
    u_t0: { value: 0 },
    u_dt: { value: 1 },
    u_lm: { value: new Int32Array(2 * MAX_ROWS) },
    u_harmonics: { value: null },
    u_thetaSamples: { value: 2 },
    u_axisU: { value: new THREE.Vector3(1, 0, 0) },
    u_axisV: { value: new THREE.Vector3(0, 1, 0) },
    u_component: { value: 0 },
    u_time: { value: 0 },
    u_scale: { value: 1 },
    u_maskRadius: { value: 0 },
    u_raw: { value: false },
    u_opacity: { value: 1 },
    u_screenMapped: { value: false },
    u_resolution: { value: new THREE.Vector2(1, 1) },
    u_center: { value: new THREE.Vector2() },
    u_halfWidth: { value: 1 },
  };
}

function dataTexture(data: Float32Array, width: number, height: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, width, height, THREE.RGFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** Places a unit plane mesh (PlaneGeometry 2×2) on a slice with half-size `extent`. */
function placePlane(mesh: THREE.Mesh, slice: SliceConfig, extent: number) {
  const { u, v, n } = sliceAxes(slice);
  mesh.matrix.makeBasis(new THREE.Vector3(...u), new THREE.Vector3(...v), new THREE.Vector3(...n));
  mesh.matrix.scale(new THREE.Vector3(extent, extent, 1));
  mesh.matrixWorldNeedsUpdate = true;
}

export class SpacetimeScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(FLAT_FOV, 1, 1, 1e6);
  private readonly scene = new THREE.Scene();
  private readonly controls: OrbitControls;
  private readonly mainPlane: THREE.Mesh;
  private readonly mainMaterial: THREE.RawShaderMaterial;
  /** Tendex and vortex lines (3D view). */
  readonly lines = new TendexLines();
  private readonly holes: Ball[];
  private readonly probeBall: Ball;
  private readonly guides = new THREE.Group();
  private textures: THREE.DataTexture[] = [];
  private peak = 1;
  private extent = 600; // half-size of the slice planes, M
  private transition: { from: Pose; to: ViewMode; start: number } | null = null;
  mode: ViewMode = "flat";

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(BACKGROUND);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.mainMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: sliceVertex,
      fragmentShader: sliceFragment,
      uniforms: sliceUniforms(),
      side: THREE.DoubleSide,
    });
    this.mainPlane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mainMaterial);
    this.mainPlane.matrixAutoUpdate = false;
    this.scene.add(this.mainPlane, this.lines.group);

    const sphere = new THREE.SphereGeometry(1, 48, 24);
    const white = new THREE.Color(0.92, 0.94, 1.0);
    this.holes = [new Ball(sphere, white), new Ball(sphere, white), new Ball(sphere, white)];
    this.probeBall = new Ball(sphere, new THREE.Color(1.0, 0.8, 0.45), true);
    for (const b of [...this.holes, this.probeBall]) this.scene.add(b.group);

    // Guides for the 3D view: the orbital axis and the outline of the orbital plane.
    const line = new THREE.LineBasicMaterial({ color: 0x5b6478, transparent: true, opacity: 0.8 });
    const axis = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1)]);
    const circle = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 129 }, (_, i) => {
        const a = (2 * Math.PI * i) / 128;
        return new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
      }),
    );
    this.guides.add(new THREE.Line(axis, line), new THREE.Line(circle, line));
    this.scene.add(this.guides);

    this.camera.up.copy(Z_UP); // OrbitControls orbits around camera.up, fixed at construction
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
  }

  setWaveform(w: PreparedWaveform): void {
    for (const t of this.textures) t.dispose();
    const rows = w.rows.length / 2;
    if (rows > MAX_ROWS) throw new Error(`Too many modes for the shader: ${rows}`);
    const table = dataTexture(w.tableData, w.table.width, w.table.height);
    const harmonics = dataTexture(w.harmonics, w.thetaSamples, rows);
    this.textures = [table, harmonics];
    const lm = new Int32Array(2 * MAX_ROWS);
    lm.set(w.rows);
    this.lines.setField(w.tendex);
    {
      const u = this.mainMaterial.uniforms;
      u.u_table.value = table;
      u.u_harmonics.value = harmonics;
      u.u_width.value = w.table.width;
      u.u_samples.value = w.table.samples;
      u.u_rows.value = rows;
      u.u_thetaSamples.value = w.thetaSamples;
      u.u_t0.value = w.t0;
      u.u_dt.value = w.dt;
      u.u_lm.value = lm;
    }
    this.peak = w.peak;
  }

  /**
   * Starts an animated switch between the flat and 3D views. Entering 3D keeps
   * the current flat framing as the size of the slice planes.
   */
  setMode(mode: ViewMode, flat: Camera): void {
    if (mode === this.mode && !this.transition) return;
    if (mode === "3d") this.extent = this.flatExtent(flat);
    this.controls.enabled = false;
    this.transition = { from: this.currentPose(), to: mode, start: performance.now() };
    this.mode = mode;
  }

  /** Animates the 3D camera back to its default pose. */
  resetOrbit(): void {
    if (this.mode !== "3d") return;
    this.controls.enabled = false;
    this.transition = { from: this.currentPose(), to: "3d", start: performance.now() };
  }

  get transitioning(): boolean {
    return this.transition !== null;
  }

  private aspect(): number {
    return this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1);
  }

  private flatExtent(flat: Camera): number {
    const aspect = this.aspect();
    return 1.05 * (Math.hypot(flat.halfWidth, flat.halfWidth / aspect) + Math.hypot(flat.centerX, flat.centerY));
  }

  private lastTarget = new THREE.Vector3();

  private currentPose(): Pose {
    const target = this.mode === "3d" && !this.transition ? this.controls.target.clone() : this.lastTarget.clone();
    const distance = this.camera.position.distanceTo(target);
    return {
      quaternion: this.camera.quaternion.clone(),
      target,
      halfHeight: distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2),
      fov: this.camera.fov,
    };
  }

  /** Camera looking straight at the slice, framing the flat view. */
  private flatPose(flat: Camera, slice: SliceConfig): Pose {
    const { n, v } = sliceAxes(slice);
    const target = new THREE.Vector3(...sliceTo3D(slice, flat.centerX, flat.centerY));
    return {
      quaternion: lookQuaternion(new THREE.Vector3(...n), new THREE.Vector3(...v)),
      target,
      halfHeight: flat.halfWidth / this.aspect(),
      fov: FLAT_FOV,
    };
  }

  /** Default 3D pose: tilted away from the slice normal towards +z, +z up. */
  private orbitPose(slice: SliceConfig): Pose {
    const { n, v } = sliceAxes(slice);
    const nn = new THREE.Vector3(...n);
    // Tilt towards the part of +z perpendicular to the normal; for the top view, towards −v.
    const towards = Z_UP.clone().addScaledVector(nn, -Z_UP.dot(nn));
    if (towards.lengthSq() < 1e-6) towards.set(...v).negate();
    towards.normalize();
    const dir = nn.multiplyScalar(Math.cos(ORBIT_ELEVATION)).addScaledVector(towards, Math.sin(ORBIT_ELEVATION));
    if (dir.z < 0) dir.z = -dir.z; // stay above the orbital plane
    return {
      quaternion: lookQuaternion(dir.normalize(), Z_UP),
      // Centred on the source, framing the region filled by the field lines.
      target: new THREE.Vector3(0, 0, 0),
      halfHeight: LINES_EXTENT * this.extent * 1.25,
      fov: ORBIT_FOV,
    };
  }

  private applyPose(p: Pose) {
    const distance = p.halfHeight / Math.tan(THREE.MathUtils.degToRad(p.fov) / 2);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(p.quaternion);
    this.camera.position.copy(p.target).addScaledVector(back, distance);
    this.camera.quaternion.copy(p.quaternion);
    this.camera.fov = p.fov;
    this.lastTarget.copy(p.target);
    const reach = this.extent * 1.5 + p.target.length();
    this.camera.near = Math.max(0.05, distance - reach);
    this.camera.far = distance + reach;
    this.camera.updateProjectionMatrix();
  }

  /** Updates every object for this frame and renders. */
  render(scene: SceneState, slice: SliceConfig, flat: Camera, probe: Vec3): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(h, 1);

    // Camera, and how far the view is from flat (0, slice) to 3D (1, lines).
    let blend = this.mode === "3d" ? 1 : 0;
    if (this.transition) {
      // Same clock as `start`; requestAnimationFrame timestamps can lag it.
      const u = Math.min(Math.max((performance.now() - this.transition.start) / TRANSITION_MS, 0), 1);
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      const to = this.transition.to === "flat" ? this.flatPose(flat, slice) : this.orbitPose(slice);
      const from = this.transition.from;
      // Interpolate the field of view logarithmically so the dolly zoom feels even.
      const fov = Math.exp(Math.log(from.fov) + (Math.log(to.fov) - Math.log(from.fov)) * e);
      this.applyPose({
        quaternion: from.quaternion.clone().slerp(to.quaternion, e),
        target: from.target.clone().lerp(to.target, e),
        halfHeight: from.halfHeight + (to.halfHeight - from.halfHeight) * e,
        fov,
      });
      blend = this.transition.to === "3d" ? e : 1 - e;
      if (u >= 1) {
        this.transition = null;
        if (this.mode === "3d") {
          this.controls.target.copy(to.target);
          this.controls.enabled = true;
        }
      }
    } else if (this.mode === "flat") {
      this.extent = this.flatExtent(flat);
      this.applyPose(this.flatPose(flat, slice));
    } else {
      this.controls.update();
      const distance = this.camera.position.distanceTo(this.controls.target);
      const reach = this.extent * 1.5 + this.controls.target.length();
      this.camera.near = Math.max(0.05, distance - reach);
      this.camera.far = distance + reach;
      this.camera.updateProjectionMatrix();
    }

    // The slice (flat view), fading out towards 3D.
    placePlane(this.mainPlane, slice, this.extent);
    this.mainPlane.visible = blend < 0.999;
    const mat = this.mainMaterial;
    mat.transparent = blend > 0;
    mat.depthWrite = blend === 0;
    {
      const axes = sliceAxes(slice);
      const u = mat.uniforms;
      (u.u_axisU.value as THREE.Vector3).set(...axes.u);
      (u.u_axisV.value as THREE.Vector3).set(...axes.v);
      u.u_component.value = slice.component === "plus" ? 0 : 1;
      u.u_time.value = scene.time;
      u.u_scale.value = scene.gain / this.peak;
      u.u_maskRadius.value = scene.maskRadius;
      u.u_raw.value = false;
      u.u_opacity.value = 1 - blend;
    }
    // Tendex/vortex lines (3D view), fading in.
    const resolution = this.renderer.getSize(new THREE.Vector2());
    this.lines.update(scene.time, scene.maskRadius, LINES_EXTENT * this.extent, scene.gain, resolution, blend);
    // Exact pixel-to-slice mapping while the camera looks straight at the main slice.
    const flatNow = this.mode === "flat" && !this.transition;
    const mu = this.mainMaterial.uniforms;
    mu.u_screenMapped.value = flatNow;
    this.renderer.getDrawingBufferSize(mu.u_resolution.value as THREE.Vector2);
    (mu.u_center.value as THREE.Vector2).set(flat.centerX, flat.centerY);
    mu.u_halfWidth.value = flat.halfWidth;
    this.guides.visible = blend > 0;
    this.guides.scale.setScalar(LINES_EXTENT * this.extent);

    // Black holes and probe, at least a few pixels across.
    const pxWorld = (p: THREE.Vector3) =>
      (2 * this.camera.position.distanceTo(p) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / Math.max(h, 1);
    const d = scene.discs;
    this.holes.forEach((ball, k) => {
      const p = new THREE.Vector3(d[4 * k], d[4 * k + 1], 0);
      ball.set([p.x, p.y, 0], Math.max(d[4 * k + 2], 2.5 * pxWorld(p)), d[4 * k + 3]);
    });
    const pp = new THREE.Vector3(...probe);
    this.probeBall.set(probe, 5 * pxWorld(pp), 1);

    this.renderer.render(this.scene, this.camera);
  }

  /** The 3D point on the slice under a canvas pixel (CSS px), in the flat view; otherwise null. */
  pick(px: number, py: number): Vec3 | null {
    if (this.mode !== "flat" || this.transition) return null;
    const ndc = new THREE.Vector2((px / this.canvas.clientWidth) * 2 - 1, 1 - (py / this.canvas.clientHeight) * 2);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    this.mainPlane.updateMatrixWorld(true);
    const hit = ray.intersectObject(this.mainPlane, false)[0];
    return hit ? [hit.point.x, hit.point.y, hit.point.z] : null;
  }

  /**
   * Self-test support: renders raw (r·h₊, r·h×, valid) for a slice into a float
   * target with an orthographic camera looking straight at it.
   */
  renderRaw(time: number, slice: SliceConfig, view: Camera, width: number, height: number): Float32Array {
    const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType, format: THREE.RGBAFormat });
    const aspect = width / height;
    const hw = view.halfWidth;
    const hh = hw / aspect;
    const ortho = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 0.1, 1e5);
    const pose = this.flatPose(view, slice);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(pose.quaternion);
    ortho.position.copy(pose.target).addScaledVector(back, 1e4);
    ortho.quaternion.copy(pose.quaternion);
    ortho.updateMatrixWorld();

    const raw = new THREE.Scene();
    const mesh = new THREE.Mesh(this.mainPlane.geometry, this.mainMaterial);
    mesh.matrixAutoUpdate = false;
    placePlane(mesh, slice, 2 * (Math.hypot(hw, hh) + Math.hypot(view.centerX, view.centerY)));
    raw.add(mesh);
    const u = this.mainMaterial.uniforms;
    const axes = sliceAxes(slice);
    (u.u_axisU.value as THREE.Vector3).set(...axes.u);
    (u.u_axisV.value as THREE.Vector3).set(...axes.v);
    u.u_time.value = time;
    u.u_raw.value = true;
    u.u_screenMapped.value = true;
    (u.u_resolution.value as THREE.Vector2).set(width, height);
    (u.u_center.value as THREE.Vector2).set(view.centerX, view.centerY);
    u.u_halfWidth.value = view.halfWidth;

    this.renderer.setRenderTarget(target);
    this.renderer.render(raw, ortho);
    const out = new Float32Array(width * height * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, width, height, out);
    this.renderer.setRenderTarget(null);
    u.u_raw.value = false;
    u.u_screenMapped.value = false;
    target.dispose();
    return out;
  }
}

/** Orientation of a camera looking along −`back`, with `up` as close to screen-up as possible. */
function lookQuaternion(back: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  const m = new THREE.Matrix4().lookAt(back, new THREE.Vector3(0, 0, 0), up);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
