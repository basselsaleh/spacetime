// Slice geometry shared by the scene, controls, probe and self-test: a slice is
// a plane through the source, with 2D coordinates (M) along its two axes.

/** State shared by every view. */
export interface SceneState {
  time: number; // M
  gain: number;
  maskRadius: number; // M
  /** Heavier, lighter, remnant: [x, y, radius, opacity] × 3, in M. */
  discs: Float32Array;
}

/** Per-view pan/zoom, in the slice's own 2D coordinates (M). */
export interface Camera {
  centerX: number;
  centerY: number;
  halfWidth: number;
}

/**
 * A plane through the source. Screen-right is the in-plane direction at
 * `azimuth`; screen-up is tilted from the orbital plane towards +z by `tilt`
 * (0: top view of the orbital plane, π/2: side view with +z up).
 */
export interface SliceConfig {
  tilt: number; // rad
  azimuth: number; // rad
  component: "plus" | "cross";
}

export type Vec3 = [number, number, number];

/** Unit vectors along screen-right and screen-up, and the slice normal. */
export function sliceAxes(slice: SliceConfig): { u: Vec3; v: Vec3; n: Vec3 } {
  const [ca, sa] = [Math.cos(slice.azimuth), Math.sin(slice.azimuth)];
  const [cb, sb] = [Math.cos(slice.tilt), Math.sin(slice.tilt)];
  const u: Vec3 = [ca, sa, 0];
  const v: Vec3 = [-sa * cb, ca * cb, sb];
  const n: Vec3 = [sa * sb, -ca * sb, cb]; // u × v
  return { u, v, n };
}

/** 3D point at slice coordinates (x, y). */
export function sliceTo3D(slice: SliceConfig, x: number, y: number): Vec3 {
  const { u, v } = sliceAxes(slice);
  return [x * u[0] + y * v[0], x * u[1] + y * v[1], x * u[2] + y * v[2]];
}

/** Slice coordinates of a 3D point, and its signed distance from the slice. */
export function sliceFrom3D(slice: SliceConfig, p: Vec3): { x: number; y: number; offset: number } {
  const { u, v, n } = sliceAxes(slice);
  const dot = (a: Vec3) => a[0] * p[0] + a[1] * p[1] + a[2] * p[2];
  return { x: dot(u), y: dot(v), offset: dot(n) };
}

/** Maps a pixel position (CSS px, origin top-left) to slice coordinates. */
export function pixelToSlice(camera: Camera, px: number, py: number, w: number, h: number) {
  const aspect = w / h;
  return {
    x: camera.centerX + ((px / w) * 2 - 1) * camera.halfWidth,
    y: camera.centerY + (1 - (py / h) * 2) * (camera.halfWidth / aspect),
  };
}

/** Inverse of `pixelToSlice`. */
export function sliceToPixel(camera: Camera, x: number, y: number, w: number, h: number) {
  const aspect = w / h;
  return {
    px: (((x - camera.centerX) / camera.halfWidth + 1) / 2) * w,
    py: ((1 - (y - camera.centerY) / (camera.halfWidth / aspect)) / 2) * h,
  };
}
