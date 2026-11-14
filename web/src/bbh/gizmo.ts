// A small 3D sketch of where the slice sits: the orbital plane, the orbital
// axis (+z), the binary at its current angle, and the slice plane with an
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

export function drawGizmo(canvas: HTMLCanvasElement, slice: SliceConfig, heavyAngle: number): void {
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

  // Orbital plane (circle) and orbital axis.
  const circle: Vec3[] = Array.from({ length: 48 }, (_, i) => {
    const a = (2 * Math.PI * i) / 48;
    return [Math.cos(a), Math.sin(a), 0];
  });
  poly(circle, "rgba(154,163,178,0.12)", "rgba(154,163,178,0.5)");
  line([0, 0, -1.05], [0, 0, 1.25], "rgba(154,163,178,0.7)");
  ctx.fillStyle = "#9aa3b2";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillText("z", ...offset(P([0, 0, 1.3]), 3, 0));

  // The binary: heavier hole closer to the centre.
  const dot = (p: Vec3, r: number) => {
    ctx.beginPath();
    ctx.arc(...P(p), r, 0, 2 * Math.PI);
    ctx.fillStyle = "#eceff7";
    ctx.fill();
  };
  const c = Math.cos(heavyAngle), s = Math.sin(heavyAngle);
  dot([0.12 * c, 0.12 * s, 0], 2.6);
  dot([-0.36 * c, -0.36 * s, 0], 1.8);

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
