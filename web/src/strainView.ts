// WebGL2 renderer for the orbital-plane strain field.

import { createProgram } from "./gl";
import vertexSource from "./shaders/fullscreen.vert?raw";
import fragmentSource from "./shaders/strain.frag?raw";
import type { PreparedWaveform } from "./waveform";

export interface ViewState {
  centerX: number; // M
  centerY: number; // M
  halfWidth: number; // M
  time: number; // M
  gain: number;
  maskRadius: number; // M
}

const MAX_ROWS = 16;

export class StrainView {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly texture: WebGLTexture;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private waveform: PreparedWaveform | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, vertexSource, fragmentSource);
    this.vao = gl.createVertexArray();
    this.texture = gl.createTexture();
    for (const name of [
      "u_table", "u_width", "u_samples", "u_rows", "u_t0", "u_dt", "u_lm", "u_coef",
      "u_resolution", "u_center", "u_halfWidth", "u_time", "u_scale", "u_maskRadius", "u_raw",
    ]) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }
  }

  /** Uploads a new waveform table. */
  setWaveform(w: PreparedWaveform): void {
    const { gl } = this;
    const rows = w.rows.length / 2;
    if (rows > MAX_ROWS) throw new Error(`Too many modes for the shader: ${rows}`);
    const { table } = w;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, table.width, table.height, 0, gl.RG, gl.FLOAT,
      Float32Array.from(table.data()));
    // RG32F is not filterable in WebGL2; the shader uses texelFetch only.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.useProgram(this.program);
    gl.uniform1i(this.u.u_table, 0);
    gl.uniform1i(this.u.u_width, table.width);
    gl.uniform1i(this.u.u_samples, table.samples);
    gl.uniform1i(this.u.u_rows, rows);
    gl.uniform1f(this.u.u_t0, w.t0);
    gl.uniform1f(this.u.u_dt, w.dt);
    gl.uniform2iv(this.u.u_lm, w.rows);
    gl.uniform2fv(this.u.u_coef, w.coefficients);
    this.waveform = w;
  }

  /** Draws into the currently bound framebuffer of size width × height. */
  draw(view: ViewState, width: number, height: number, raw = false): void {
    const { gl } = this;
    if (!this.waveform) return;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform2f(this.u.u_resolution, width, height);
    gl.uniform2f(this.u.u_center, view.centerX, view.centerY);
    gl.uniform1f(this.u.u_halfWidth, view.halfWidth);
    gl.uniform1f(this.u.u_time, view.time);
    gl.uniform1f(this.u.u_scale, view.gain / this.waveform.peak);
    gl.uniform1f(this.u.u_maskRadius, view.maskRadius);
    gl.uniform1i(this.u.u_raw, raw ? 1 : 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
