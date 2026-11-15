// The embedded sheet as a three.js mesh: a polar mesh in (u, φ) with
// r = r₊ + u² out to the framed radius, so triangles stay even where the
// sheet turns vertical at the horizon, then log-spaced rings out to
// FAR × that radius. Past the framed radius the sheet fades into the
// background, so it seems to carry on, flattening, out of view.
// Drawn as a well: the framed radius at z = 0, the horizon lowest.

import * as THREE from "three";
import { type Profile, type Slice, profile } from "./embedding";
import fragmentShader from "./shaders/sheet.frag?raw";
import vertexShader from "./shaders/sheet.vert?raw";

const RINGS = 240; // samples from the horizon to the framed radius
const OUTER_RINGS = 120; // samples from there out to FAR × it
// The sheet extends to FAR × the framed radius, fading out from FADE_START × it.
// Flamm's paraboloid flattens only in slope (z grows like √r), so a much larger
// FAR would make the far sheet rise above the camera.
const FAR = 4;
const FADE_START = 1;
const SEGMENTS = 256; // around the axis

export type GridStyle = "cartesian" | "polar" | "proper";
const GRID_INDEX: Record<GridStyle, number> = { cartesian: 0, polar: 1, proper: 2 };

/** Curvature color scale: tint ∝ sign(K) log(1 + |K|/K0), full at |K| = KMAX. */
export const K0 = 1e-5;
export const KMAX = 0.2;
export const curvatureScale = (k: number) => (Math.sign(k) * Math.log1p(Math.abs(k) / K0)) / Math.log1p(KMAX / K0);

const cssValue = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const css = (name: string) => new THREE.Color(cssValue(name));

/** A 1–2–5 step near `x`. */
function niceStep(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

export class Sheet {
  readonly group = new THREE.Group();
  readonly material: THREE.RawShaderMaterial;
  mesh: THREE.Mesh | null = null;
  /** The profile on the mesh's rings, out to the far edge, for the probe. */
  profile!: Profile;
  /** Height of the framed radius above the horizon; the sheet is drawn shifted down by this. */
  depth = 0;
  /** The framed radius (coordinate r) and the far edge. */
  rMax = 0;
  rFar = 0;
  /** Circumferential radius at the framed radius. */
  rim = 0;
  private horizonRing: THREE.LineLoop | null = null;
  private probeRing: THREE.LineLoop | null = null;
  private readonly ringMaterial = new THREE.LineBasicMaterial({ color: 0xeceff7 });
  private readonly probeMaterial = new THREE.LineBasicMaterial({ color: css("--accent") });

  constructor(readonly slice: Slice) {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      side: THREE.DoubleSide,
      // Push the sheet back a little so lines drawn on it (horizon, probe) win the depth test.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      uniforms: {
        u_eye: { value: new THREE.Vector3() },
        u_grid: { value: 0 },
        u_spacing: { value: 2 },
        u_curvature: { value: true },
        u_k0: { value: K0 },
        u_kmax: { value: KMAX },
        u_fade: { value: new THREE.Vector2(1, 2) },
        u_base: { value: new THREE.Color(0x2a3550) },
        u_neg: { value: css("--neg") },
        u_pos: { value: css("--accent") },
        u_line: { value: new THREE.Color(0xdfe5f2) },
        // The raw shader writes colors unconverted, so the background goes in as its
        // sRGB values (read as if linear) to match the renderer's clear color exactly.
        u_bg: { value: new THREE.Color().setStyle(cssValue("--bg"), THREE.LinearSRGBColorSpace) },
      },
    });
  }

  set grid(style: GridStyle) {
    this.material.uniforms.u_grid.value = GRID_INDEX[style];
  }

  set curvature(on: boolean) {
    this.material.uniforms.u_curvature.value = on;
  }

  /** Height of the drawn sheet at coordinate radius r (from a profile value). */
  drawnHeight(height: number): number {
    return height - this.depth;
  }

  /** Rebuilds the sheet, framing radius `rMax` and extending, fading, to FAR × it. */
  build(rMax: number) {
    const s = this.slice;
    const uMax = Math.sqrt(rMax - s.horizon);
    const radii = Array.from({ length: RINGS + 1 }, (_, i) => s.horizon + (uMax * i / RINGS) ** 2);
    for (let i = 1; i <= OUTER_RINGS; i++) radii.push(rMax * Math.pow(FAR, i / OUTER_RINGS));
    const rings = radii.length;
    const p = profile(s, radii);
    this.profile = p;
    this.rMax = rMax;
    this.rFar = radii[rings - 1];
    this.rim = p.circ[RINGS];
    this.depth = p.height[RINGS];
    this.material.uniforms.u_spacing.value = niceStep(rMax / 15);
    (this.material.uniforms.u_fade.value as THREE.Vector2).set(FADE_START * this.rim, p.circ[rings - 1]);

    const n = rings * SEGMENTS;
    const pos = new Float32Array(3 * n);
    const coord = new Float32Array(2 * n);
    const dist = new Float32Array(n);
    const k = new Float32Array(n);
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < SEGMENTS; j++) {
        const phi = (2 * Math.PI * j) / SEGMENTS;
        const c = Math.cos(phi);
        const sn = Math.sin(phi);
        const v = i * SEGMENTS + j;
        pos.set([p.circ[i] * c, p.circ[i] * sn, p.height[i] - this.depth], 3 * v);
        coord.set([p.r[i] * c, p.r[i] * sn], 2 * v);
        dist[v] = p.distance[i];
        k[v] = p.curvature[i];
      }
    }
    const index: number[] = [];
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < SEGMENTS; j++) {
        const a = i * SEGMENTS + j;
        const b = i * SEGMENTS + ((j + 1) % SEGMENTS);
        index.push(a, a + SEGMENTS, b, b, a + SEGMENTS, b + SEGMENTS);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("aCoord", new THREE.BufferAttribute(coord, 2));
    geometry.setAttribute("aDist", new THREE.BufferAttribute(dist, 1));
    geometry.setAttribute("aK", new THREE.BufferAttribute(k, 1));
    geometry.setIndex(index);
    geometry.computeVertexNormals();

    this.clear();
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.group.add(this.mesh);

    // The horizon: where the sheet ends, turned vertical.
    this.horizonRing = this.ring(p.circ[0], -this.depth, this.ringMaterial);
    this.group.add(this.horizonRing);
  }

  /** Marks the circle through coordinate radius r (null hides it). */
  setProbe(at: { circ: number; height: number } | null) {
    if (this.probeRing) {
      this.group.remove(this.probeRing);
      this.probeRing.geometry.dispose();
      this.probeRing = null;
    }
    if (at) {
      this.probeRing = this.ring(at.circ, this.drawnHeight(at.height), this.probeMaterial);
      this.group.add(this.probeRing);
    }
  }

  update(camera: THREE.Camera) {
    (this.material.uniforms.u_eye.value as THREE.Vector3).copy(camera.position);
  }

  private ring(radius: number, z: number, material: THREE.LineBasicMaterial): THREE.LineLoop {
    const pts: number[] = [];
    for (let j = 0; j < SEGMENTS; j++) {
      const phi = (2 * Math.PI * j) / SEGMENTS;
      pts.push(radius * Math.cos(phi), radius * Math.sin(phi), z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineLoop(g, material);
  }

  private clear() {
    for (const obj of [this.mesh, this.horizonRing]) {
      if (obj) {
        this.group.remove(obj);
        obj.geometry.dispose();
      }
    }
  }
}
