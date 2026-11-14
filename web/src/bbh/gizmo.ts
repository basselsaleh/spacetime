// A small 3D sketch of where the slice sits: the vertical axis (+z, the total
// angular momentum J), the orbital plane and its axis L̂ (tilted when the orbit
// precesses), the binary at its current position, and the slice plane with an
// arrow for the direction you look from.

import { sliceAxes, type SliceConfig, type Vec3 } from "./slice";

// Fixed oblique camera: elevation and azimuth of the sketch's viewpoint.
const ELEV = 0.45;
const AZIM = -0.65;

function project([x, y, z]: Vec3, scale: number, cx: number, cy: number): [number, number] {
  const ca = Math.cos(AZIM), sa = Math.sin(AZIM), ce = Math.cos(ELEV), se = Math.sin(ELEV);
  const xr = x * ca - y * sa;
  const yr = x * sa + y * ca;
  return [cx + scale * xr, cy - scale * (z * ce - yr * se)];
}

const unit = (v: Vec3): Vec3 => {
  const n = Math.hypot(...v);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** `heavy`: position of the heavier hole (any scale); `lhat`: orbital axis. */
export function drawGizmo(canvas: HTMLCanvasElement, slice: SliceConfig, heavy: Vec3, lhat: Vec3): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const scale = Math.min(w, h) * 0.36;
  const P = (p: Vec3) => project(p, scale, w / 2, h / 2 + 4);

  const poly = (pts: Vec3[], fill: string, stroke: string) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  const line = (a: Vec3, b: Vec3, color: string, width = 1) => {
    ctx.beginPath();
    ctx.moveTo(...P(a));
    ctx.lineTo(...P(b));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };

  // Orbital plane (circle ⊥ L̂), the vertical axis (J) and L̂.
  const l = unit(lhat);
  const e1 = unit(Math.abs(l[2]) < 0.9 ? cross([0, 0, 1], l) : cross([1, 0, 0], l));
  const e2 = cross(l, e1);
  const circle: Vec3[] = Array.from({ length: 48 }, (_, i) => {
    const a = (2 * Math.PI * i) / 48;
    const c = Math.cos(a), s = Math.sin(a);
    return [c * e1[0] + s * e2[0], c * e1[1] + s * e2[1], c * e1[2] + s * e2[2]];
  });
  poly(circle, "rgba(154,163,178,0.12)", "rgba(154,163,178,0.5)");
  line([0, 0, -1.05], [0, 0, 1.25], "rgba(154,163,178,0.7)");
  ctx.fillStyle = "#9aa3b2";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillText("z", ...offset(P([0, 0, 1.3]), 3, 0));
  if (Math.abs(l[2]) < 0.999) {
    line([0, 0, 0], [0.85 * l[0], 0.85 * l[1], 0.85 * l[2]], "rgba(238,241,248,0.85)", 1.2);
    ctx.fillStyle = "#eef1f8";
    ctx.fillText("L̂", ...offset(P([0.95 * l[0], 0.95 * l[1], 0.95 * l[2]]), 2, 0));
  }

  // The binary: heavier hole closer to the center.
  const dot = (p: Vec3, r: number) => {
    ctx.beginPath();
    ctx.arc(...P(p), r, 0, 2 * Math.PI);
    ctx.fillStyle = "#eceff7";
    ctx.fill();
  };
  const hd = unit(heavy);
  if (hd.some((v) => v !== 0)) {
    dot([0.12 * hd[0], 0.12 * hd[1], 0.12 * hd[2]], 2.6);
    dot([-0.36 * hd[0], -0.36 * hd[1], -0.36 * hd[2]], 1.8);
  }

  // Slice plane and the viewing direction (you look along −n).
  const { u, v, n } = sliceAxes(slice);
  const corner = (a: number, b: number): Vec3 => [
    1.1 * (a * u[0] + b * v[0]), 1.1 * (a * u[1] + b * v[1]), 1.1 * (a * u[2] + b * v[2]),
  ];
  poly([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], "rgba(176,190,216,0.14)", "rgba(176,190,216,0.8)");
  const eye: Vec3 = [1.0 * n[0], 1.0 * n[1], 1.0 * n[2]];
  line(eye, [0.35 * n[0], 0.35 * n[1], 0.35 * n[2]], "#b0bed8", 1.5);
  ctx.beginPath();
  ctx.arc(...P(eye), 3, 0, 2 * Math.PI);
  ctx.fillStyle = "#b0bed8";
  ctx.fill();
}

function offset([x, y]: [number, number], dx: number, dy: number): [number, number] {
  return [x + dx, y + dy];
}
