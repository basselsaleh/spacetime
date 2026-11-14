import init, { physics_version } from "./wasm/spacetime_wasm.js";
import { setupParams, setupPlayback, setupPointer, type Playback } from "./controls";
import { drawGizmo } from "./gizmo";
import { Probe } from "./probe";
import { SpacetimeScene } from "./scene3d";
import { runSelfTest } from "./selftest";
import type { Camera, SceneState, SliceConfig } from "./slice";
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

const DEFAULT_CAMERA: Camera = { centerX: 0, centerY: 0, halfWidth: 450 };
const LOOP_START = -2500; // M
const TILT_ANIMATION_MS = 1400;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main(): Promise<void> {
  const status = $("status");
  try {
    await init();
    const model = await loadModel();
    $("credit").textContent = model.attribution;
    const url = new URLSearchParams(window.location.search);

    const canvas = $<HTMLCanvasElement>("view");
    const view = new SpacetimeScene(canvas);
    let w = prepare(model, paramsFromUrl());
    view.setWaveform(w);

    if (url.has("selftest")) {
      const r = runSelfTest(view, w);
      const verdict =
        `SELFTEST ${r.pass ? "PASS" : "FAIL"}: max |GPU−CPU|/peak = ${r.worst.toExponential(2)} ` +
        `over ${r.pixels} pixels (per frame: ${r.perFrame.map((e) => e.toExponential(1)).join(", ")})`;
      document.title = verdict;
      status.textContent = verdict;
      status.classList.toggle("error", !r.pass);
      console.log(verdict);
      return;
    }

    // Optional ?t=, ?zoom=, ?tilt=<degrees>, ?3d, ?lines=, ?paused, for sharing a moment.
    const scene: SceneState = {
      time: url.has("t") ? Number(url.get("t")) : LOOP_START,
      gain: 1.5,
      maskRadius: 0,
      discs: new Float32Array(12),
    };
    const camera: Camera = {
      ...DEFAULT_CAMERA,
      halfWidth: url.has("zoom") ? Number(url.get("zoom")) : DEFAULT_CAMERA.halfWidth,
    };
    const slice: SliceConfig = {
      tilt: url.has("tilt") ? (Number(url.get("tilt")) * Math.PI) / 180 : 0,
      azimuth: 0,
      component: "plus",
    };
    const playback: Playback = {
      playing: !url.has("paused"),
      speed: 100,
      tMin: Math.ceil(w.t0 + 500),
      tMax: endTime(w, camera, canvas),
      loop: true,
      loopStart: LOOP_START,
    };
    const controls = setupPlayback(scene, playback);
    const probe = new Probe($("ring"), $("chirp"), $("probe-info"));
    setupPointer(
      canvas,
      camera,
      () => view.mode === "flat" && !view.transitioning,
      (px, py) => {
        const p = view.pick(px, py);
        if (p) probe.set({ x: p[0], y: p[1], z: p[2] });
      },
      () => (view.mode === "flat" ? Object.assign(camera, DEFAULT_CAMERA) : view.resetOrbit()),
    );
    const viewPanel = setupViewPanel(slice, view, camera);
    // ?3d: switch after the first flat frame, so the camera animates in from the flat view.
    if (url.has("3d")) requestAnimationFrame(() => requestAnimationFrame(() => view.setMode("3d", camera)));

    describe(w);
    setupParams(w.params, DEFAULT_PARAMS, (p) => {
      const next = prepare(model, p);
      view.setWaveform(next);
      release(w);
      w = next;
      probe.invalidate();
      describe(w);
      writeUrl(p);
    });

    let last = performance.now();
    let fpsFrames = 0;
    let fpsSince = last;
    let holdUntil = 0; // brief pause at the end before looping
    status.textContent = `physics v${physics_version()}`;
    const frame = (now: number) => {
      const dtWall = Math.min((now - last) / 1000, 0.1);
      last = now;
      playback.tMin = Math.ceil(w.t0 + 500);
      playback.tMax = endTime(w, camera, canvas);
      if (playback.playing && now >= holdUntil) {
        scene.time += dtWall * playback.speed;
        if (scene.time >= playback.tMax) {
          if (playback.loop) {
            scene.time = Math.max(playback.loopStart, playback.tMin);
            holdUntil = now + 600;
          } else {
            scene.time = playback.tMax;
            playback.playing = false;
          }
        }
      }
      controls.sync();
      viewPanel.update(now);

      scene.maskRadius = nearZoneRadius(w, scene.time);
      const discs = w.binary.state(scene.time);
      scene.discs.set(discs);
      const p = probe.point;
      view.render(scene, slice, camera, [p.x, p.y, p.z]);
      probe.draw(w, scene.time, scene.gain);
      if (view.mode === "flat") {
        drawGizmo($("gizmo"), slice, Math.atan2(discs[1], discs[0]));
        updateScaleBar($("scale-bar"), $("scale-label"), camera.halfWidth, canvas.clientWidth);
      }

      fpsFrames++;
      if (now - fpsSince > 1000) {
        status.textContent =
          `physics v${physics_version()} · ${((fpsFrames * 1000) / (now - fpsSince)).toFixed(0)} fps · ` +
          `${view.renderer.domElement.width}×${view.renderer.domElement.height}` +
          (view.mode === "3d" ? ` · lines ${view.lines.lastMs.toFixed(1)} ms` : "");
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

/**
 * Playback ends shortly after the merger burst (emitted around t = 0) has left
 * the visible area, instead of a long wait over an empty screen.
 */
function endTime(w: PreparedWaveform, camera: Camera, canvas: HTMLCanvasElement): number {
  const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
  const farthest = Math.hypot(camera.halfWidth, camera.halfWidth / aspect) + Math.hypot(camera.centerX, camera.centerY);
  return Math.floor(Math.min(w.tEnd, 100) + farthest + 50);
}

/**
 * Title, polarisation toggle, top/side swap with an animated tilt, tilt slider,
 * and the flat/3D switch.
 */
function setupViewPanel(slice: SliceConfig, view: SpacetimeScene, flat: Camera) {
  const title = $("view-title");
  const caption = $("view-caption");
  const swap = $<HTMLButtonElement>("swap");
  const tiltInput = $<HTMLInputElement>("tilt");
  const tiltLabel = $("tilt-value");
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-component]");
  let anim: { from: number; to: number; start: number } | null = null;

  for (const btn of buttons) {
    btn.addEventListener("click", () => (slice.component = btn.dataset.component as SliceConfig["component"]));
  }
  swap.addEventListener("click", () => {
    const to = slice.tilt < Math.PI / 4 ? Math.PI / 2 : 0;
    anim = { from: slice.tilt, to, start: performance.now() };
  });
  tiltInput.addEventListener("input", () => {
    anim = null;
    slice.tilt = (Number(tiltInput.value) * Math.PI) / 180;
  });
  const modeBtn = $<HTMLButtonElement>("mode");
  modeBtn.addEventListener("click", () => view.setMode(view.mode === "flat" ? "3d" : "flat", flat));
  // Line families shown in 3D: stretching tendex lines by default, or ?lines=stretch,squeeze,vortex.
  const linesParam = new URLSearchParams(window.location.search).get("lines");
  if (linesParam !== null) {
    const want = new Set(linesParam.split(","));
    for (const kind of ["stretch", "squeeze", "vortex"] as const) view.lines.enabled[kind] = want.has(kind);
  }
  for (const [id, kind] of [
    ["show-stretch", "stretch"],
    ["show-squeeze", "squeeze"],
    ["show-vortex", "vortex"],
  ] as const) {
    const box = $<HTMLInputElement>(id);
    box.checked = view.lines.enabled[kind];
    box.addEventListener("change", () => (view.lines.enabled[kind] = box.checked));
  }

  return {
    update(now: number) {
      if (anim) {
        const u = Math.min((now - anim.start) / TILT_ANIMATION_MS, 1);
        const ease = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
        slice.tilt = anim.from + (anim.to - anim.from) * ease;
        if (u >= 1) anim = null;
      }
      const deg = Math.round((slice.tilt * 180) / Math.PI);
      tiltInput.value = String(deg);
      tiltLabel.textContent = `${deg}°`;
      const is3d = view.mode === "3d";
      title.textContent = is3d
        ? "3D · tendex and vortex lines"
        : deg === 0
          ? "Top view · orbital plane"
          : deg === 90
            ? "Side view · x–z plane, orbital axis up"
            : `Tilted slice · ${deg}° from the orbital plane`;
      swap.textContent = deg < 45 ? "⇄ Side view" : "⇄ Top view";
      for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.component === slice.component));
      caption.hidden = is3d || !(deg === 0 && slice.component === "cross");
      modeBtn.textContent = is3d ? "Flat view" : "3D view";
      document.body.classList.toggle("mode-3d", is3d);
    },
  };
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
