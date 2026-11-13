import init, { newtonian_gw_omega_22, physics_version } from "./wasm/spacetime_wasm.js";
import { createContext, createProgram, resizeToDisplay } from "./gl";
import vertexSource from "./shaders/fullscreen.vert?raw";
import fragmentSource from "./shaders/strain_placeholder.frag?raw";

// Placeholder scene parameters, all in units of total mass M.
const SEPARATION = 20; // binary separation
const HALF_WIDTH = 600; // half the visible width
const TIME_SCALE = 120; // M of coordinate time per second of wall-clock time

async function main(): Promise<void> {
  const status = document.getElementById("status")!;
  try {
    await init();

    const omega22 = newtonian_gw_omega_22(SEPARATION);
    const innerRadius = 1 / omega22; // reduced wavelength: near/far-zone boundary

    const canvas = document.getElementById("view") as HTMLCanvasElement;
    const gl = createContext(canvas);
    const program = createProgram(gl, vertexSource, fragmentSource);
    const vao = gl.createVertexArray();

    const u = (name: string) => gl.getUniformLocation(program, name);
    const uResolution = u("u_resolution");
    const uTime = u("u_time");
    gl.useProgram(program);
    gl.uniform1f(u("u_halfWidth"), HALF_WIDTH);
    gl.uniform1f(u("u_omega22"), omega22);
    gl.uniform1f(u("u_innerRadius"), innerRadius);

    status.textContent =
      `physics v${physics_version()} · a = ${SEPARATION}M · ` +
      `Mω₂₂ = ${omega22.toFixed(4)} · λ = ${((2 * Math.PI) / omega22).toFixed(0)}M`;

    const start = performance.now();
    const frame = (now: number) => {
      resizeToDisplay(canvas);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uResolution, canvas.width, canvas.height);
      gl.uniform1f(uTime, ((now - start) / 1000) * TIME_SCALE);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
    status.classList.add("error");
    console.error(err);
  }
}

void main();
