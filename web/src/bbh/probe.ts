// The probe: a point in space where a ring of free test particles shows the
// wave's stretching and squeezing, plus the strain-versus-time (chirp) plot
// an observer at that point receives.

import type { PreparedWaveform } from "./waveform";

export interface ProbePoint {
  x: number;
  y: number;
  z: number;
}

const RING_PARTICLES = 24;
const RING_MAX_STRETCH = 0.6; // h at saturation; the ring deforms by ±h/2 = ±30%
const CHIRP_WINDOW = 3000; // M of retarded time shown before the end of the data
const COLORS = { plus: "#eceff7", cross: "#c08cff", grid: "#2a3042", playhead: "rgba(230, 232, 238, 0.55)" };

export class Probe {
  point: ProbePoint = { x: 200, y: 0, z: 0 };
  private series: Float64Array | null = null;

  constructor(
    private readonly ring: HTMLCanvasElement,
    private readonly chirp: HTMLCanvasElement,
    private readonly info: HTMLElement,
  ) {}

  get r() {
    return Math.hypot(this.point.x, this.point.y, this.point.z);
  }
  get theta() {
    return Math.atan2(Math.hypot(this.point.x, this.point.y), this.point.z);
  }
  get phi() {
    return Math.atan2(this.point.y, this.point.x);
  }

  set(p: ProbePoint) {
    this.point = p;
    this.series = null;
  }

  /** Call when the waveform changes. */
  invalidate() {
    this.series = null;
  }

  private ensureSeries(w: PreparedWaveform): Float64Array {
    this.series ??= w.table.strainSeries(this.point.x, this.point.y, this.point.z);
    return this.series;
  }

  /** (r·h₊, r·h×)/peak at the probe at coordinate time t, or null outside the data. */
  private sample(w: PreparedWaveform, t: number): [number, number] | null {
    const s = this.ensureSeries(w);
    const x = (t - this.r - w.t0) / w.dt;
    const n = s.length / 2;
    if (!(x >= 0 && x <= n - 1)) return null;
    const i = Math.min(Math.floor(x), n - 2);
    const f = x - i;
    const lerp = (k: number) => s[2 * i + k] + f * (s[2 * (i + 1) + k] - s[2 * i + k]);
    return [lerp(0) / w.peak, lerp(1) / w.peak];
  }

  draw(w: PreparedWaveform, t: number, gain: number) {
    const h = this.sample(w, t) ?? [0, 0];
    this.drawRing(h, gain);
    this.drawChirp(w, t);
    const deg = (a: number) => ((a * 180) / Math.PI).toFixed(0);
    this.info.innerHTML =
      `r = ${this.r.toFixed(0)} M, θ = ${deg(this.theta)}°, φ = ${deg(this.phi)}°<br>` +
      `<span style="color:${COLORS.plus}">h₊ ${fmt(h[0])}</span> · ` +
      `<span style="color:${COLORS.cross}">h× ${fmt(h[1])}</span> <span class="muted">(r·h ÷ peak)</span>`;
  }

  private drawRing([hp, hc]: [number, number], gain: number) {
    const { ctx, w, h } = prepare2d(this.ring);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.3;
    // Exaggerate, saturating smoothly; the same factor on h₊ and h× keeps the pattern exact.
    const mag = Math.hypot(hp, hc);
    const k = mag > 0 ? (RING_MAX_STRETCH * Math.tanh(gain * mag)) / mag : 0;
    const [ap, ac] = [k * hp, k * hc];

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.stroke();
    // Axes: horizontal = φ̂ (around the source), vertical = −θ̂ (toward +z).
    ctx.beginPath();
    ctx.moveTo(cx - R * 1.45, cy);
    ctx.lineTo(cx + R * 1.45, cy);
    ctx.moveTo(cx, cy - R * 1.45);
    ctx.lineTo(cx, cy + R * 1.45);
    ctx.stroke();

    // Displacement ξ → ξ + ½ h ξ with h = [[h₊, h×], [h×, −h₊]] in (φ̂, −θ̂).
    ctx.fillStyle = COLORS.plus;
    for (let i = 0; i < RING_PARTICLES; i++) {
      const a = (2 * Math.PI * i) / RING_PARTICLES;
      const u = Math.cos(a);
      const v = Math.sin(a);
      const du = 0.5 * (ap * u + ac * v);
      const dv = 0.5 * (ac * u - ap * v);
      ctx.beginPath();
      ctx.arc(cx + R * (u + du), cy - R * (v + dv), 3, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.fillStyle = "#9aa3b2";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("φ̂", w - 6, cy - 6);
    ctx.textAlign = "left";
    ctx.fillText("−θ̂", cx + 6, 14);
  }

  private drawChirp(w: PreparedWaveform, t: number) {
    const s = this.ensureSeries(w);
    const { ctx, w: W, h: H } = prepare2d(this.chirp);
    const n = s.length / 2;
    const tA = Math.max(w.t0, w.tEnd - CHIRP_WINDOW);
    const tB = w.tEnd;
    const X = (tr: number) => ((tr - tA) / (tB - tA)) * W;
    const Y = (v: number) => H / 2 - v * (H / 2 - 6) * 0.9;

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.moveTo(X(0), 0);
    ctx.lineTo(X(0), H);
    ctx.stroke();

    const iA = Math.max(0, Math.floor((tA - w.t0) / w.dt));
    // Draw at most ~2 points per pixel.
    const stride = Math.max(1, Math.floor((n - iA) / (2 * W)));
    for (const [k, color] of [[1, COLORS.cross], [0, COLORS.plus]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (let i = iA; i < n; i += stride) {
        const tr = w.t0 + i * w.dt;
        const px = X(tr);
        const py = Y(s[2 * i + k] / w.peak);
        if (i === iA) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // Playhead: the retarded time t − r currently arriving at the probe.
    const tr = t - this.r;
    if (tr >= tA && tr <= tB) {
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(X(tr), 0);
      ctx.lineTo(X(tr), H);
      ctx.stroke();
    }
    ctx.fillStyle = "#9aa3b2";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`t − r = ${tA.toFixed(0)} M`, 4, H - 4);
    ctx.textAlign = "right";
    ctx.fillText("peak (0 M)", X(0) - 4, 12);
    ctx.fillText(`${tB.toFixed(0)} M`, W - 4, H - 4);
  }
}

function fmt(v: number) {
  return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(3);
}

function prepare2d(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
