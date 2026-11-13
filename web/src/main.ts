import init, {
  newtonian_gw_omega_22,
  physics_version,
  WaveformModel,
} from "./wasm/spacetime_wasm.js";
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
    const waveformInfo = await loadWaveformModel();

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
      `Mω₂₂ = ${omega22.toFixed(4)} · λ = ${((2 * Math.PI) / omega22).toFixed(0)}M\n` +
      waveformInfo;

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

/** Loads the surrogate and times one evaluation (step 1 check; drawn in step 2). */
async function loadWaveformModel(): Promise<string> {
  const response = await fetch(`${import.meta.env.BASE_URL}nrhybsur3dq8.stsur`);
  if (!response.ok) throw new Error(`Waveform data: HTTP ${response.status}`);
  const model = new WaveformModel(new Uint8Array(await response.arrayBuffer()));
  document.getElementById("credit")!.textContent = model.attribution;

  const runs = 5;
  const start = performance.now();
  let wf = model.evaluate(2, 0.3, -0.1, -5000, 1);
  for (let i = 1; i < runs; i++) {
    wf.free();
    wf = model.evaluate(2, 0.3, -0.1, -5000, 1);
  }
  const ms = (performance.now() - start) / runs;
  const amp = wf.amp22();
  const iPeak = amp.indexOf(Math.max(...amp));
  const summary =
    `${model.model}: ${wf.length} samples, ${wf.coorbitalModes().length / 2 + 1} modes, ` +
    `evaluated in ${ms.toFixed(1)} ms · peak |h₂₂| = ${amp[iPeak].toFixed(3)} at t = ${(wf.t0 + iPeak * wf.dt).toFixed(0)}M`;
  wf.free();
  return summary;
}

void main();
