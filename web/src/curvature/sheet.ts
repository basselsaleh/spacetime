// The embedded sheet as a three.js mesh: a polar mesh in (u, φ) with
// r = r_in + u² out to the framed radius (so triangles stay even where the
// sheet turns vertical at a horizon), then log-spaced rings out to FAR × that
// radius. Past the framed radius the sheet fades into the background, so it
// seems to carry on, flattening, out of view. Drawn as a well: the framed
// radius at z = 0, the inner edge lowest. For the Einstein–Rosen bridge a
// mirror copy hangs below the throat.

import * as THREE from "three";
import { type Profile, type Slice, profile } from "./embedding";
import fragmentShader from "./shaders/sheet.frag?raw";
import vertexShader from "./shaders/sheet.vert?raw";

const RINGS = 240; // samples from the inner edge to the framed radius
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

/** What to draw: a slice, whether it has a mirror sheet, and the radius to mark on it. */
export interface SheetSpec {
  slice: Slice;
  /** Add the mirror sheet below the inner edge (the bridge). */
  mirror: boolean;
  /** Ring drawn on the sheet: the horizon/throat (at the inner edge) or a star's surface. */
  mark: { r: number; color: THREE.ColorRepresentation };
  /**
   * The displayed unit of length, in M: 1 for the black hole, the star's radius
   * for the star. Grid lines fall on round numbers of it, and curvature colors
   * are of K in 1/unit².
   */
  unit: number;
}

export class Sheet {
  readonly group = new THREE.Group();
  readonly material: THREE.RawShaderMaterial;
  mesh: THREE.Mesh | null = null;
  spec!: SheetSpec;
  /** The profile on the mesh's rings, out to the far edge, for the probe. */
  profile!: Profile;
  /** Height of the framed radius above the inner edge; the sheet is drawn shifted down by this. */
  depth = 0;
  /** The framed radius (coordinate r) and the far edge. */
  rMax = 0;
  rFar = 0;
  /** Circumferential radius at the framed radius. */
  rim = 0;
  private markRing: THREE.LineLoop | null = null;
  private probeRing: THREE.LineLoop | null = null;
  private readonly probeMaterial = new THREE.LineBasicMaterial({ color: css("--accent") });

  constructor() {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      side: THREE.DoubleSide,
      // Push the sheet back a little so lines drawn on it (rings) win the depth test.
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

  /** Drawn z for a profile height: on the upper sheet, or reflected through the inner edge onto the lower. */
  drawnHeight(height: number, lower = false): number {
    return lower ? -this.depth - height : height - this.depth;
  }

  /** Rebuilds the sheet, framing radius `rMax` and extending, fading, to FAR × it. */
  build(spec: SheetSpec, rMax: number) {
    this.spec = spec;
    const s = spec.slice;
    const uMax = Math.sqrt(rMax - s.inner);
    const radii = Array.from({ length: RINGS + 1 }, (_, i) => s.inner + (uMax * i / RINGS) ** 2);
    for (let i = 1; i <= OUTER_RINGS; i++) radii.push(rMax * Math.pow(FAR, i / OUTER_RINGS));
    // A break (a star's surface) becomes two coincident rings, one with the inside
    // curvature and one with the outside, so the color jumps there sharply.
    const outsideRings: number[] = [];
    for (const b of s.breaks) {
      if (b <= s.inner || b >= radii[radii.length - 1]) continue;
      const at = radii.findIndex((r) => r > b);
      radii.splice(at, 0, b, b);
      outsideRings.push(at + 1);
    }
    const rings = radii.length;
    const rimIndex = radii.findIndex((r) => r >= rMax);
    const p = profile(s, radii);
    for (const i of outsideRings) {
      if (s.curvature) p.curvature[i] = s.curvature(radii[i] * (1 + 1e-12));
    }
    this.profile = p;
    this.rMax = rMax;
    this.rFar = radii[rings - 1];
    this.rim = p.circ[rimIndex];
    this.depth = p.height[rimIndex];
    this.material.uniforms.u_spacing.value = spec.unit * niceStep(rMax / spec.unit / 15);
    const kScale = spec.unit * spec.unit; // K in 1/M² → 1/unit²
    (this.material.uniforms.u_fade.value as THREE.Vector2).set(FADE_START * this.rim, p.circ[rings - 1]);

    const sheets = spec.mirror ? 2 : 1;
    const n = sheets * rings * SEGMENTS;
    const pos = new Float32Array(3 * n);
    const coord = new Float32Array(2 * n);
    const dist = new Float32Array(n);
    const k = new Float32Array(n);
    const index: number[] = [];
    for (let sheet = 0; sheet < sheets; sheet++) {
      const first = sheet * rings * SEGMENTS;
      for (let i = 0; i < rings; i++) {
        const z = this.drawnHeight(p.height[i], sheet === 1);
        for (let j = 0; j < SEGMENTS; j++) {
          const phi = (2 * Math.PI * j) / SEGMENTS;
          const c = Math.cos(phi);
          const sn = Math.sin(phi);
          const v = first + i * SEGMENTS + j;
          pos.set([p.circ[i] * c, p.circ[i] * sn, z], 3 * v);
          coord.set([p.r[i] * c, p.r[i] * sn], 2 * v);
          dist[v] = p.distance[i];
          k[v] = p.curvature[i] * kScale;
        }
      }
      for (let i = 0; i < rings - 1; i++) {
        for (let j = 0; j < SEGMENTS; j++) {
          const a = first + i * SEGMENTS + j;
          const b = first + i * SEGMENTS + ((j + 1) % SEGMENTS);
          index.push(a, a + SEGMENTS, b, b, a + SEGMENTS, b + SEGMENTS);
        }
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

    const mark = profile(s, [s.inner, spec.mark.r]);
    const markMaterial = new THREE.LineBasicMaterial({ color: spec.mark.color });
    this.markRing = this.ring(mark.circ[1], this.drawnHeight(mark.height[1]), markMaterial);
    this.group.add(this.markRing);
  }

  /** Marks a circle (null hides it): at a profile point, on the upper sheet or the bridge's lower one. */
  setProbe(at: { circ: number; height: number; lower: boolean } | null) {
    if (this.probeRing) {
      this.group.remove(this.probeRing);
      this.probeRing.geometry.dispose();
      this.probeRing = null;
    }
    if (at) {
      this.probeRing = this.ring(at.circ, this.drawnHeight(at.height, at.lower), this.probeMaterial);
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
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    if (this.markRing) {
      this.group.remove(this.markRing);
      this.markRing.geometry.dispose();
      (this.markRing.material as THREE.Material).dispose();
    }
  }
}
