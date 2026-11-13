import init, { physics_version } from "./wasm/spacetime_wasm.js";
import { createContext, resizeToDisplay } from "./gl";
import { setupCamera, setupParams, setupPlayback, type Playback } from "./controls";
import { Probe } from "./probe";
import { runSelfTest } from "./selftest";
import { StrainView, type Camera, type SceneState, type SliceConfig } from "./strainView";
import {
  DEFAULT_PARAMS,
  loadModel,
  nearZoneRadius,
  paramsFromUrl,
  prepare,
  release,
  type BinaryParams,
  type PreparedWaveform,
} from "./waveform";

const PLANE_CAMERA: Camera = { centerX: 0, centerY: 0, halfWidth: 450 };
const SLICE_CAMERA: Camera = { centerX: 0, centerY: 0, halfWidth: 300 };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main(): Promise<void> {
  const status = $("status");
  try {
    await init();
    const model = await loadModel();
    $("credit").textContent = model.attribution;
    const url = new URLSearchParams(window.location.search);

    const planeCanvas = $<HTMLCanvasElement>("view");
    const sliceCanvas = $<HTMLCanvasElement>("slice");
    const planeView = new StrainView(createContext(planeCanvas));
    const sliceView = new StrainView(createContext(sliceCanvas));
    const planeSlice: SliceConfig = { kind: "plane", azimuth: 0, component: "plus" };
    const sideSlice: SliceConfig = { kind: "vertical", azimuth: 0, component: "plus" };

    let w = prepare(model, paramsFromUrl());
    planeView.setWaveform(w);
    sliceView.setWaveform(w);

    if (url.has("selftest")) {
      const r = runSelfTest(planeView.gl, planeView, w);
      const verdict =
        `SELFTEST ${r.pass ? "PASS" : "FAIL"}: max |GPU−CPU|/peak = ${r.worst.toExponential(2)} ` +
        `over ${r.pixels} pixels (per frame: ${r.perFrame.map((e) => e.toExponential(1)).join(", ")})`;
      document.title = verdict;
      status.textContent = verdict;
      status.classList.toggle("error", !r.pass);
      console.log(verdict);
      return;
    }

    // Optional ?t=<time in M>, ?zoom=<half-width in M> and ?paused, for sharing a moment.
    const scene: SceneState = {
      time: url.has("t") ? Number(url.get("t")) : -2500,
      gain: 1.5,
      maskRadius: 0,
      discs: new Float32Array(12),
    };
    const planeCamera: Camera = {
      ...PLANE_CAMERA,
      halfWidth: url.has("zoom") ? Number(url.get("zoom")) : PLANE_CAMERA.halfWidth,
    };
    const sliceCamera: Camera = { ...SLICE_CAMERA };
    const playback: Playback = { playing: !url.has("paused"), speed: 100, ...timeRange(w) };
    const controls = setupPlayback(scene, playback);
    const probe = new Probe($("ring"), $("chirp"), $("probe-info"));

    setupCamera(planeCanvas, planeCamera, PLANE_CAMERA, (x, y) => probe.set({ x, y, z: 0 }));
    setupCamera(sliceCanvas, sliceCamera, SLICE_CAMERA, (s, z) =>
      probe.set({ x: s * Math.cos(sideSlice.azimuth), y: s * Math.sin(sideSlice.azimuth), z }),
    );
    for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-component]")) {
      btn.addEventListener("click", () => {
        sideSlice.component = btn.dataset.component as SliceConfig["component"];
        for (const b of document.querySelectorAll("[data-component]")) {
          b.setAttribute("aria-pressed", String(b === btn));
        }
      });
    }

    describe(w);
    setupParams(w.params, DEFAULT_PARAMS, (p) => {
      const next = prepare(model, p);
      planeView.setWaveform(next);
      sliceView.setWaveform(next);
      release(w);
      w = next;
      probe.invalidate();
      Object.assign(playback, timeRange(w));
      scene.time = Math.min(Math.max(scene.time, playback.tMin), playback.tMax);
      controls.sync();
      describe(w);
      writeUrl(p);
    });

    let last = performance.now();
    let fpsFrames = 0;
    let fpsSince = last;
    status.textContent = `physics v${physics_version()}`;
    const frame = (now: number) => {
      const dtWall = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (playback.playing) {
        scene.time += dtWall * playback.speed;
        if (scene.time >= playback.tMax) {
          scene.time = playback.tMax;
          playback.playing = false;
        }
        controls.sync();
      }
      scene.maskRadius = nearZoneRadius(w, scene.time);
      scene.discs.set(w.binary.state(scene.time));

      resizeToDisplay(planeCanvas);
      planeView.draw(scene, planeCamera, planeSlice, planeCanvas.width, planeCanvas.height);
      resizeToDisplay(sliceCanvas);
      sliceView.draw(scene, sliceCamera, sideSlice, sliceCanvas.width, sliceCanvas.height);
      probe.draw(w, scene.time, scene.gain);
      probe.placeMarker($("plane-marker"), planeCanvas, planeCamera, "plane", 0);
      probe.placeMarker($("slice-marker"), sliceCanvas, sliceCamera, "vertical", sideSlice.azimuth);
      updateScaleBar($("scale-bar"), $("scale-label"), planeCamera.halfWidth, planeCanvas.clientWidth);

      fpsFrames++;
      if (now - fpsSince > 1000) {
        status.textContent =
          `physics v${physics_version()} · ${((fpsFrames * 1000) / (now - fpsSince)).toFixed(0)} fps · ` +
          `main view ${planeCanvas.width}×${planeCanvas.height}`;
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

function timeRange(w: PreparedWaveform) {
  return { tMin: Math.ceil(w.t0 + 500), tMax: Math.floor(w.tEnd + 3000) };
}

function describe(w: PreparedWaveform) {
  const b = w.binary;
  $("remnant").textContent =
    `Remnant: mass ${b.remnantMass.toFixed(4)} M (${((1 - b.remnantMass) * 100).toFixed(1)}% radiated), ` +
    `spin ${b.remnantSpin.toFixed(3)}, recoil ${(b.kickSpeed * 299792.458).toFixed(0)} km/s`;
  $("eval").textContent = `waveform evaluated in ${w.evaluateMs.toFixed(1)} ms`;
}

function writeUrl(p: BinaryParams) {
  const url = new URL(window.location.href);
  url.searchParams.set("q", p.q.toFixed(2));
  url.searchParams.set("chi1", p.chi1.toFixed(2));
  url.searchParams.set("chi2", p.chi2.toFixed(2));
  history.replaceState(null, "", url);
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
