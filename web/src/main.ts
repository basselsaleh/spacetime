import init, { physics_version } from "./wasm/spacetime_wasm.js";
import { createContext, resizeToDisplay } from "./gl";
import { setupControls, type Playback } from "./controls";
import { runSelfTest } from "./selftest";
import { StrainView, type ViewState } from "./strainView";
import { loadModel, nearZoneRadius, paramsFromUrl, prepare } from "./waveform";

const DEFAULT_VIEW: ViewState = {
  centerX: 0,
  centerY: 0,
  halfWidth: 450,
  time: -2500,
  gain: 1.5,
  maskRadius: 0,
  discs: new Float32Array(12),
};

async function main(): Promise<void> {
  const status = document.getElementById("status")!;
  try {
    await init();
    const model = await loadModel();
    document.getElementById("credit")!.textContent = model.attribution;

    const params = paramsFromUrl();
    const w = prepare(model, params);

    const canvas = document.getElementById("view") as HTMLCanvasElement;
    const gl = createContext(canvas);
    const strainView = new StrainView(gl);
    strainView.setWaveform(w);

    document.getElementById("params")!.textContent =
      `q = ${params.q}, χ₁ = ${params.chi1}, χ₂ = ${params.chi2} (aligned spins) · ` +
      `${w.rows.length / 2} co-orbital rows, ${w.table.samples} samples, evaluated in ${w.evaluateMs.toFixed(1)} ms`;
    const kickKmS = w.binary.kickSpeed * 299792.458;
    document.getElementById("remnant")!.textContent =
      `Remnant: mass ${w.binary.remnantMass.toFixed(4)} M (${((1 - w.binary.remnantMass) * 100).toFixed(1)}% radiated), ` +
      `spin ${w.binary.remnantSpin.toFixed(3)}, recoil ${kickKmS.toFixed(0)} km/s`;

    if (new URLSearchParams(window.location.search).has("selftest")) {
      const r = runSelfTest(gl, strainView, w);
      const verdict = `SELFTEST ${r.pass ? "PASS" : "FAIL"}: max |GPU−CPU|/peak = ${r.worst.toExponential(2)} over ${r.pixels} pixels (per frame: ${r.perFrame.map((e) => e.toExponential(1)).join(", ")})`;
      document.title = verdict;
      status.textContent = verdict;
      status.classList.toggle("error", !r.pass);
      console.log(verdict);
      return;
    }

    // Optional ?t=<time in M>, ?zoom=<half-width in M> and ?paused, for sharing a moment.
    const url = new URLSearchParams(window.location.search);
    const view: ViewState = {
      ...DEFAULT_VIEW,
      time: url.has("t") ? Number(url.get("t")) : DEFAULT_VIEW.time,
      halfWidth: url.has("zoom") ? Number(url.get("zoom")) : DEFAULT_VIEW.halfWidth,
    };
    const playback: Playback = {
      playing: !url.has("paused"),
      speed: 100,
      tMin: Math.ceil(w.t0 + 500),
      tMax: Math.floor(w.tEnd + 3000),
    };
    const controls = setupControls(canvas, view, playback, DEFAULT_VIEW);
    status.textContent = `physics v${physics_version()}`;
    const scaleBar = document.getElementById("scale-bar")!;
    const scaleLabel = document.getElementById("scale-label")!;

    let last = performance.now();
    let fpsFrames = 0;
    let fpsSince = last;
    const frame = (now: number) => {
      const dtWall = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (playback.playing) {
        view.time += dtWall * playback.speed;
        if (view.time >= playback.tMax) {
          view.time = playback.tMax;
          playback.playing = false;
        }
        controls.sync();
      }
      view.maskRadius = nearZoneRadius(w, view.time);
      view.discs.set(w.binary.state(view.time));

      resizeToDisplay(canvas);
      strainView.draw(view, canvas.width, canvas.height);
      updateScaleBar(scaleBar, scaleLabel, view.halfWidth, canvas.clientWidth);

      fpsFrames++;
      if (now - fpsSince > 1000) {
        status.textContent =
          `physics v${physics_version()} · ${((fpsFrames * 1000) / (now - fpsSince)).toFixed(0)} fps · ` +
          `${canvas.width}×${canvas.height}`;
        fpsFrames = 0;
        fpsSince = now;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
    status.classList.add("error");
    console.error(err);
  }
}

/** Sizes the scale bar to a round length (1, 2 or 5 × 10^k M) near 120 px. */
function updateScaleBar(bar: HTMLElement, label: HTMLElement, halfWidth: number, cssWidth: number) {
  const mPerPx = (2 * halfWidth) / cssWidth;
  const target = 120 * mPerPx;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const nice = [1, 2, 5, 10].map((k) => k * pow).filter((v) => v <= target).pop() ?? pow;
  bar.style.width = `${nice / mPerPx}px`;
  label.textContent = `${nice} M`;
}

void main();
