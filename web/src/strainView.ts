// WebGL2 renderer for a strain slice (orbital plane or vertical slice).

import { createProgram } from "./gl";
import vertexSource from "./shaders/fullscreen.vert?raw";
import fragmentSource from "./shaders/strain.frag?raw";
import type { PreparedWaveform } from "./waveform";

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

export interface SliceConfig {
  kind: "plane" | "vertical";
  /** Azimuth of the vertical slice, rad. */
  azimuth: number;
  component: "plus" | "cross";
}

const MAX_ROWS = 16;

export class StrainView {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly table: WebGLTexture;
  private readonly harmonics: WebGLTexture;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private waveform: PreparedWaveform | null = null;

  constructor(readonly gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, vertexSource, fragmentSource);
    this.vao = gl.createVertexArray();
    this.table = gl.createTexture();
    this.harmonics = gl.createTexture();
    for (const name of [
      "u_table", "u_width", "u_samples", "u_rows", "u_t0", "u_dt", "u_lm",
      "u_harmonics", "u_thetaSamples", "u_slice", "u_azimuth", "u_component",
      "u_resolution", "u_center", "u_halfWidth", "u_time", "u_scale", "u_maskRadius",
      "u_raw", "u_discs", "u_minDiscRadius",
    ]) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }
  }

  private upload(tex: WebGLTexture, width: number, height: number, data: Float32Array) {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, width, height, 0, gl.RG, gl.FLOAT, data);
    // RG32F is not filterable in WebGL2; the shader uses texelFetch only.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Uploads a new waveform. */
  setWaveform(w: PreparedWaveform): void {
    const { gl } = this;
    const rows = w.rows.length / 2;
    if (rows > MAX_ROWS) throw new Error(`Too many modes for the shader: ${rows}`);
    this.upload(this.table, w.table.width, w.table.height, w.tableData);
    this.upload(this.harmonics, w.thetaSamples, rows, w.harmonics);

    gl.useProgram(this.program);
    gl.uniform1i(this.u.u_table, 0);
    gl.uniform1i(this.u.u_harmonics, 1);
    gl.uniform1i(this.u.u_width, w.table.width);
    gl.uniform1i(this.u.u_samples, w.table.samples);
    gl.uniform1i(this.u.u_rows, rows);
    gl.uniform1i(this.u.u_thetaSamples, w.thetaSamples);
    gl.uniform1f(this.u.u_t0, w.t0);
    gl.uniform1f(this.u.u_dt, w.dt);
    gl.uniform2iv(this.u.u_lm, w.rows);
    this.waveform = w;
  }

  /** Draws into the currently bound framebuffer of size width × height. */
  draw(
    scene: SceneState,
    camera: Camera,
    slice: SliceConfig,
    width: number,
    height: number,
    raw = false,
  ): void {
    const { gl } = this;
    if (!this.waveform) return;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.table);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.harmonics);
    gl.uniform1i(this.u.u_slice, slice.kind === "plane" ? 0 : 1);
    gl.uniform1f(this.u.u_azimuth, slice.azimuth);
    gl.uniform1i(this.u.u_component, slice.component === "plus" ? 0 : 1);
    gl.uniform2f(this.u.u_resolution, width, height);
    gl.uniform2f(this.u.u_center, camera.centerX, camera.centerY);
    gl.uniform1f(this.u.u_halfWidth, camera.halfWidth);
    gl.uniform1f(this.u.u_time, scene.time);
    gl.uniform1f(this.u.u_scale, scene.gain / this.waveform.peak);
    gl.uniform1f(this.u.u_maskRadius, scene.maskRadius);
    gl.uniform1i(this.u.u_raw, raw ? 1 : 0);
    gl.uniform4fv(this.u.u_discs, scene.discs);
    gl.uniform1f(this.u.u_minDiscRadius, (2.5 * camera.halfWidth) / (0.5 * width));
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
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
