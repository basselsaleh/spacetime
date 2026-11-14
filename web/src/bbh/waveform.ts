// Evaluates the NRSur7dq4 surrogate for one binary and prepares everything the
// views need: the packed mode table, harmonic table, orbits and timing info.
//
// Spins are set at the start of the model's data (t ≈ −4300 M), relative to
// the orbit there: tilt from the orbital angular momentum L̂, azimuth from the
// direction to the heavier hole. The display frame puts the total angular
// momentum J on +z, so a precessing orbit's L̂ circles the vertical axis.

import { WaveformModel, type BinaryTrack, type ModeTableData } from "../wasm/spacetime_wasm.js";

/** A spin: dimensionless magnitude, tilt from L̂ and azimuth, in degrees. */
export interface Spin {
  mag: number;
  tilt: number;
  azimuth: number;
}

export interface BinaryParams {
  q: number;
  /** Heavier hole. */
  spin1: Spin;
  /** Lighter hole. */
  spin2: Spin;
}

type Vec3 = [number, number, number];
const RAD = Math.PI / 180;

/** Spin vector in the co-orbital frame at the start of the data. */
export function spinVector(s: Spin): Vec3 {
  const t = s.tilt * RAD;
  const a = s.azimuth * RAD;
  return [s.mag * Math.sin(t) * Math.cos(a), s.mag * Math.sin(t) * Math.sin(a), s.mag * Math.cos(t)];
}

/** Inverse of `spinVector`, magnitude clamped to the model's range. */
export function spinFromVector([x, y, z]: Vec3): Spin {
  const mag = Math.hypot(x, y, z);
  if (mag === 0) return { mag: 0, tilt: 0, azimuth: 0 };
  const azimuth = Math.hypot(x, y) > 1e-9 ? (((Math.atan2(y, x) / RAD) % 360) + 360) % 360 : 0;
  return { mag: Math.min(mag, PARAM_RANGE.chi), tilt: Math.acos(z / mag) / RAD, azimuth };
}

/** True when every spin is along ±L̂ (or zero): no precession. */
export function isAligned(p: BinaryParams): boolean {
  const ok = (s: Spin) => s.mag < 1e-6 || s.tilt < 1e-6 || s.tilt > 180 - 1e-6;
  return ok(p.spin1) && ok(p.spin2);
}

export interface PreparedWaveform {
  params: BinaryParams;
  table: ModeTableData;
  tableData: Float32Array;
  /** Flat [l0, m0, l1, m1, ...] of the mode rows, in (l, ±m) groups, strongest first. */
  rows: Int32Array;
  /** Mode rows forming the three strongest groups (the volume sums only these). */
  volumeRows: number;
  /** θ-dependence of the harmonics, RG × thetaSamples × rows. */
  harmonics: Float32Array;
  thetaSamples: number;
  /** Black holes over time (positions, spins, orbital axis) and remnant properties. */
  binary: BinaryTrack;
  /** No precession (aligned or zero spins). */
  aligned: boolean;
  /** Color-scale unit: peak r·|h₊| in the plane from the (2,2) mode. */
  peak: number;
  /** Twice the orbital frequency (≈ ω₂₂) at each sample, for the near-zone radius. */
  omega22: Float64Array;
  t0: number;
  dt: number;
  tEnd: number;
  evaluateMs: number;
}

export const TABLE_WIDTH = 2048; // WebGL2 guarantees at least this texture size
export const THETA_SAMPLES = 1025; // odd, so θ = π/2 is sampled exactly
const SAMPLE_DT = 1; // M

/** NRSur7dq4's trained range: q ≤ 4, |χ| ≤ 0.8. */
export const PARAM_RANGE = { q: [1, 4] as const, chi: 0.8 };
export const DEFAULT_PARAMS: BinaryParams = {
  q: 3,
  spin1: { mag: 0.6, tilt: 0, azimuth: 0 },
  spin2: { mag: 0.2, tilt: 0, azimuth: 0 },
};

export async function loadModel(): Promise<WaveformModel> {
  // web/public/ is served at the site root; this page lives one level down (/bbh/).
  // Relative to the page, so the build works at any URL prefix (base: "./").
  const response = await fetch(new URL("../nrsur7dq4.stsur", document.baseURI));
  if (!response.ok) throw new Error(`Waveform data: HTTP ${response.status}`);
  return new WaveformModel(new Uint8Array(await response.arrayBuffer()));
}

export function prepare(model: WaveformModel, params: BinaryParams): PreparedWaveform {
  const [tMin] = model.timeRange;
  const tStart = Math.ceil(tMin) + 1;
  const start = performance.now();
  const chiA = new Float64Array(spinVector(params.spin1));
  const chiB = new Float64Array(spinVector(params.spin2));
  const frame = model.displayFrame(params.q, chiA, chiB);
  const wf = model.evaluate(params.q, chiA, chiB, frame, tStart, SAMPLE_DT);
  const evaluateMs = performance.now() - start;

  const table = wf.modeTable(TABLE_WIDTH);
  const binary = wf.binary();
  const prepared: PreparedWaveform = {
    params,
    table,
    tableData: table.data(),
    rows: Int32Array.from(table.rows()),
    volumeRows: table.leadingRows,
    harmonics: table.harmonicTable(THETA_SAMPLES),
    thetaSamples: THETA_SAMPLES,
    binary,
    aligned: isAligned(params),
    peak: wf.equatorialPeak22(),
    omega22: Float64Array.from(wf.omega22()),
    t0: table.t0,
    dt: table.dt,
    tEnd: table.t0 + table.dt * (table.samples - 1),
    evaluateMs,
  };
  wf.free();
  return prepared;
}

/** Releases the wasm-side memory of a prepared waveform. */
export function release(w: PreparedWaveform): void {
  w.table.free();
  w.binary.free();
}

/**
 * Radius inside which the far-zone (wave-zone) formula is not valid at source
 * time t: the larger of the reduced wavelength 1/ω₂₂ and twice the orbital
 * separation estimated from Kepler's law, a ≈ (2/ω₂₂)^{2/3}. After the peak,
 * ω₂₂ is held at its peak value.
 */
export function nearZoneRadius(w: PreparedWaveform, t: number): number {
  const iPeak = Math.round(-w.t0 / w.dt);
  const i = Math.min(Math.max(Math.round((t - w.t0) / w.dt), 0), iPeak);
  const omega = Math.max(w.omega22[i], 1e-3);
  return Math.max(1 / omega, 2 * Math.pow(2 / omega, 2 / 3));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Reads ?q=&chi1=&chi2= from the URL, clamped to the model's range. A spin is
 * either one number (aligned with L̂; negative means anti-aligned) or x,y,z in
 * the co-orbital frame at the start of the data (z along L̂, x toward the
 * heavier hole).
 */
export function paramsFromUrl(): BinaryParams {
  const url = new URLSearchParams(window.location.search);
  const q = Number(url.get("q"));
  const spin = (key: string, fallback: Spin): Spin => {
    const raw = url.get(key);
    if (raw === null) return fallback;
    const v = raw.split(",").map(Number);
    if (!v.every(Number.isFinite)) return fallback;
    if (v.length === 1) return spinFromVector([0, 0, v[0]]);
    if (v.length === 3) return spinFromVector(v as Vec3);
    return fallback;
  };
  return {
    q: url.has("q") && Number.isFinite(q) ? clamp(q, ...PARAM_RANGE.q) : DEFAULT_PARAMS.q,
    spin1: spin("chi1", DEFAULT_PARAMS.spin1),
    spin2: spin("chi2", DEFAULT_PARAMS.spin2),
  };
}

/** URL value for a spin: one number when aligned, else x,y,z. */
export function spinToUrl(s: Spin): string {
  const [x, y, z] = spinVector(s);
  if (s.mag < 1e-6) return "0";
  if (s.tilt < 1e-6 || s.tilt > 180 - 1e-6) return z.toFixed(2);
  return [x, y, z].map((c) => c.toFixed(3)).join(",");
}
