// Tendex and vortex lines for the 3D view: field lines of the tidal tensor E
// (stretching and squeezing families) and the frame-drag tensor B (two twist
// directions), traced in Rust/wasm (`TendexField.trace`) and drawn as fat lines.
//
// Seeds are fixed in space, so a line evolves smoothly as the field changes.
// Brightness is log-scaled r·|λ| (the 1/r far-zone fall-off removed, like the
// strain colours), normalised by the peak far-zone value and the gain; lines
// fade in just outside the near zone, where they stop.

import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { tendexSeeds, type TendexField } from "./wasm/spacetime_wasm.js";

export type LineKind = "stretch" | "squeeze" | "vortex";

interface FamilySpec {
  kind: LineKind;
  field: 0 | 1; // 0: E (tidal), 1: B (frame-drag)
  family: 0 | 1; // 0: smallest eigenvalue, 1: largest
  color: [number, number, number];
  seeds: number;
  salt: number;
}

const FAMILIES: FamilySpec[] = [
  { kind: "stretch", field: 0, family: 0, color: [1.0, 0.36, 0.22], seeds: 110, salt: 1 },
  { kind: "squeeze", field: 0, family: 1, color: [0.3, 0.58, 1.0], seeds: 90, salt: 2 },
  { kind: "vortex", field: 1, family: 1, color: [0.35, 0.95, 0.55], seeds: 60, salt: 3 },
  { kind: "vortex", field: 1, family: 0, color: [0.8, 0.45, 1.0], seeds: 60, salt: 4 },
];

const STEPS = 24; // RK4 steps each way from a seed
const STEP_SCALE = 0.6; // step = STEP_SCALE · (1 + r/30) M
const SEED_R_MIN = 5; // M
const DECADES = 2.2; // brightness spans this many decades of r·|λ| below the peak

class Family {
  readonly mesh: LineSegments2;
  private readonly material: LineMaterial;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private seeds: Float32Array = new Float32Array(0);
  private seedsFor = -1;

  constructor(readonly spec: FamilySpec) {
    const capacity = spec.seeds * 2 * STEPS;
    this.positions = new Float32Array(capacity * 6);
    this.colors = new Float32Array(capacity * 6);
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(this.positions);
    geometry.setColors(this.colors);
    geometry.instanceCount = 0;
    this.material = new LineMaterial({
      vertexColors: true,
      linewidth: 1.8, // CSS px
      transparent: true,
    });
    this.mesh = new LineSegments2(geometry, this.material);
    this.mesh.frustumCulled = false; // the buffers change every frame
    this.mesh.renderOrder = 4;
  }

  /** Retraces the lines at time `t` and refills the buffers. */
  update(field: TendexField, t: number, rMin: number, rMax: number, gain: number) {
    if (this.seedsFor !== rMax) {
      this.seeds = tendexSeeds(this.spec.seeds, SEED_R_MIN, rMax, this.spec.salt);
      this.seedsFor = rMax;
    }
    const seg = field.trace(t, this.spec.field, this.spec.family, this.seeds, rMin, rMax, STEPS, STEP_SCALE);
    const n = Math.min(seg.length / 8, this.positions.length / 6);
    const norm = gain / Math.max(field.farScale, 1e-30);
    const [cr, cg, cb] = this.spec.color;
    for (let s = 0; s < n; s++) {
      for (let e = 0; e < 2; e++) {
        const src = 8 * s + 4 * e;
        const dst = 6 * s + 3 * e;
        const x = seg[src];
        const y = seg[src + 1];
        const z = seg[src + 2];
        const r = Math.hypot(x, y, z);
        const level = Math.log10(Math.max(r * Math.abs(seg[src + 3]) * norm, 1e-30)) / DECADES + 1;
        const fade = smoothstep(rMin, 1.4 * rMin, r) * (1 - smoothstep(0.85 * rMax, rMax, r));
        const b = (0.3 + 0.7 * Math.min(Math.max(level, 0), 1)) * (0.25 + 0.75 * fade);
        this.positions[dst] = x;
        this.positions[dst + 1] = y;
        this.positions[dst + 2] = z;
        this.colors[dst] = cr * b;
        this.colors[dst + 1] = cg * b;
        this.colors[dst + 2] = cb * b;
      }
    }
    const geometry = this.mesh.geometry;
    for (const name of ["instanceStart", "instanceColorStart"]) {
      (geometry.attributes[name] as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
    }
    geometry.instanceCount = n;
  }

  setView(resolution: THREE.Vector2, opacity: number) {
    this.material.resolution.copy(resolution);
    this.material.opacity = opacity;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

export class TendexLines {
  readonly group = new THREE.Group();
  private readonly families = FAMILIES.map((f) => new Family(f));
  /** Which kinds of line to draw. */
  readonly enabled: Record<LineKind, boolean> = { stretch: false, squeeze: false, vortex: false };
  private field: TendexField | null = null;
  private traced = "";
  /** Time spent tracing on the last retrace, ms. */
  lastMs = 0;

  constructor() {
    for (const f of this.families) this.group.add(f.mesh);
  }

  setField(field: TendexField) {
    this.field?.free();
    this.field = field;
    this.traced = "";
  }

  /**
   * Retraces the visible families if anything they depend on changed, and sets
   * their opacity (for the flat ⇄ 3D cross-fade).
   */
  update(t: number, rMin: number, rMax: number, gain: number, resolution: THREE.Vector2, opacity: number) {
    this.group.visible = opacity > 0.001 && this.field !== null;
    if (!this.group.visible || !this.field) return;
    for (const f of this.families) {
      const on = this.enabled[f.spec.kind];
      f.mesh.visible = on;
      f.setView(resolution, opacity);
    }
    const key = [t.toFixed(2), rMin.toFixed(2), rMax.toFixed(1), gain, ...this.families.map((f) => f.mesh.visible)].join();
    if (key === this.traced) return;
    this.traced = key;
    const start = performance.now();
    for (const f of this.families) if (f.mesh.visible) f.update(this.field, t, rMin, rMax, gain);
    this.lastMs = performance.now() - start;
  }
}
