// Evaluates the NRSur7dq4 surrogate for one binary and prepares everything the
// views need: the packed mode table, harmonic table, orbits and timing info.
// The sliders set aligned spins for now (spin vectors come with step 7e).

import { WaveformModel, type BinaryTrack, type ModeTableData } from "../wasm/spacetime_wasm.js";

export interface BinaryParams {
  q: number;
  chi1: number;
  chi2: number;
  /**
   * Full spin vectors (heavier, lighter), co-orbital frame at the start of the
   * data. When absent, the spins are aligned: (0, 0, chi1) and (0, 0, chi2).
   */
  spins?: { a: [number, number, number]; b: [number, number, number] };
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
  /** Black-hole disks over time and remnant properties. */
  binary: BinaryTrack;
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

export const PARAM_RANGE = { q: [1, 4], chi: [-0.8, 0.8] } as const;
export const DEFAULT_PARAMS: BinaryParams = { q: 3, chi1: 0.6, chi2: 0.2 };

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
  const chiA = new Float64Array(params.spins?.a ?? [0, 0, params.chi1]);
  const chiB = new Float64Array(params.spins?.b ?? [0, 0, params.chi2]);
  const wf = model.evaluate(params.q, chiA, chiB, new Float64Array(0), tStart, SAMPLE_DT);
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

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(Math.max(v, lo), hi);

/** Reads ?q=&chi1=&chi2= from the URL, clamped to the model's range. */
export function paramsFromUrl(): BinaryParams {
  const url = new URLSearchParams(window.location.search);
  const num = (key: string, fallback: number) => {
    const v = Number(url.get(key));
    return url.has(key) && Number.isFinite(v) ? v : fallback;
  };
  return {
    q: clamp(num("q", DEFAULT_PARAMS.q), PARAM_RANGE.q),
    chi1: clamp(num("chi1", DEFAULT_PARAMS.chi1), PARAM_RANGE.chi),
    chi2: clamp(num("chi2", DEFAULT_PARAMS.chi2), PARAM_RANGE.chi),
  };
}
