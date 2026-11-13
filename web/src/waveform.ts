// Evaluates the surrogate for one binary and prepares everything the strain
// view needs: the packed mode table, harmonic coefficients and timing info.

import { swshTheta, WaveformModel, type ModeTableData } from "./wasm/spacetime_wasm.js";

export interface BinaryParams {
  q: number;
  chi1: number;
  chi2: number;
}

export interface PreparedWaveform {
  params: BinaryParams;
  table: ModeTableData;
  /** Flat [l0, m0, l1, m1, ...]; row 0 is (2,2). */
  rows: Int32Array;
  /** Per row: [Y_{l,m}(π/2,0), (−1)^l Y_{l,−m}(π/2,0)] flattened. */
  coefficients: Float32Array;
  /** Colour-scale unit: peak r·|h₊| in the plane from the (2,2) mode. */
  peak: number;
  /** ω₂₂(t) at each sample, for the near-zone radius. */
  omega22: Float64Array;
  t0: number;
  dt: number;
  tEnd: number;
  evaluateMs: number;
}

export const TABLE_WIDTH = 2048; // WebGL2 guarantees at least this texture size
const SAMPLE_DT = 1; // M

export async function loadModel(): Promise<WaveformModel> {
  const response = await fetch(`${import.meta.env.BASE_URL}nrhybsur3dq8.stsur`);
  if (!response.ok) throw new Error(`Waveform data: HTTP ${response.status}`);
  return new WaveformModel(new Uint8Array(await response.arrayBuffer()));
}

export function prepare(model: WaveformModel, params: BinaryParams): PreparedWaveform {
  const [tMin] = model.timeRange;
  const tStart = Math.ceil(tMin) + 1;
  const start = performance.now();
  const wf = model.evaluate(params.q, params.chi1, params.chi2, tStart, SAMPLE_DT);
  const evaluateMs = performance.now() - start;

  const table = wf.modeTable(TABLE_WIDTH);
  const rows = Int32Array.from(table.rows());
  const coefficients = new Float32Array(rows.length);
  for (let k = 0; k < rows.length / 2; k++) {
    const l = rows[2 * k];
    const m = rows[2 * k + 1];
    const parity = l % 2 === 0 ? 1 : -1;
    coefficients[2 * k] = swshTheta(-2, l, m, Math.PI / 2);
    coefficients[2 * k + 1] = m === 0 ? 0 : parity * swshTheta(-2, l, -m, Math.PI / 2);
  }
  const prepared: PreparedWaveform = {
    params,
    table,
    rows,
    coefficients,
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

/** Reads ?q=&chi1=&chi2= from the URL, with defaults. */
export function paramsFromUrl(): BinaryParams {
  const url = new URLSearchParams(window.location.search);
  const num = (key: string, fallback: number) => {
    const v = Number(url.get(key));
    return url.has(key) && Number.isFinite(v) ? v : fallback;
  };
  return { q: num("q", 3), chi1: num("chi1", 0.6), chi2: num("chi2", 0.2) };
}
