// Playback controls, per-view pan/zoom with click-to-probe, and the binary
// parameter sliders.

import { pixelToSlice, type Camera, type SceneState } from "./strainView";
import { PARAM_RANGE, type BinaryParams } from "./waveform";

export interface Playback {
  playing: boolean;
  speed: number; // M of coordinate time per second
  tMin: number;
  tMax: number;
}

const BASE_SPEED = 100; // M per second at ×1
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function setupPlayback(scene: SceneState, playback: Playback): { sync: () => void } {
  const playBtn = $<HTMLButtonElement>("play");
  const scrub = $<HTMLInputElement>("scrub");
  const timeLabel = $<HTMLSpanElement>("time");
  const speed = $<HTMLSelectElement>("speed");
  const gain = $<HTMLInputElement>("gain");
  const gainLabel = $<HTMLSpanElement>("gain-value");

  scrub.step = "1";
  const togglePlay = () => {
    if (!playback.playing && scene.time >= playback.tMax) scene.time = playback.tMin;
    playback.playing = !playback.playing;
    sync();
  };
  playBtn.addEventListener("click", togglePlay);
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (e.code === "Space" && !["INPUT", "SELECT", "BUTTON"].includes(target.tagName)) {
      e.preventDefault();
      togglePlay();
    }
  });
  scrub.addEventListener("input", () => {
    scene.time = Number(scrub.value);
    sync();
  });
  const setSpeed = () => (playback.speed = BASE_SPEED * Number(speed.value));
  speed.addEventListener("change", setSpeed);
  setSpeed();
  gain.value = String(scene.gain);
  gain.addEventListener("input", () => {
    scene.gain = Number(gain.value);
    sync();
  });

  function sync() {
    scrub.min = String(playback.tMin);
    scrub.max = String(playback.tMax);
    playBtn.textContent = playback.playing ? "Pause" : "Play";
    scrub.value = String(scene.time);
    timeLabel.textContent = `t = ${scene.time.toFixed(0)} M`;
    gainLabel.textContent = `×${scene.gain.toFixed(1)}`;
  }
  sync();
  return { sync };
}

/**
 * Drag to pan, wheel to zoom around the cursor, double-click to reset, and a
 * click without dragging calls `onClick` with the point in slice coordinates.
 */
export function setupCamera(
  canvas: HTMLCanvasElement,
  camera: Camera,
  defaults: Camera,
  onClick: (x: number, y: number) => void,
): void {
  const local = (e: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top, w: rect.width, h: rect.height };
  };
  let drag: { x: number; y: number; moved: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const { w } = local(e);
    const perPixel = (2 * camera.halfWidth) / w;
    camera.centerX -= (e.clientX - drag.x) * perPixel;
    camera.centerY += (e.clientY - drag.y) * perPixel;
    drag.moved += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  canvas.addEventListener("pointerup", (e) => {
    if (drag && drag.moved < 4) {
      const { px, py, w, h } = local(e);
      const p = pixelToSlice(camera, px, py, w, h);
      onClick(p.x, p.y);
    }
    drag = null;
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const { px, py, w, h } = local(e);
      const before = pixelToSlice(camera, px, py, w, h);
      camera.halfWidth = Math.min(Math.max(camera.halfWidth * Math.exp(e.deltaY * 0.0015), 5), 6000);
      const after = pixelToSlice(camera, px, py, w, h);
      camera.centerX += before.x - after.x;
      camera.centerY += before.y - after.y;
    },
    { passive: false },
  );
  canvas.addEventListener("dblclick", () => Object.assign(camera, defaults));
}

/** Parameter sliders; `onChange` fires (at most once per frame) while dragging. */
export function setupParams(
  initial: BinaryParams,
  defaults: BinaryParams,
  onChange: (p: BinaryParams) => void,
): void {
  const inputs = {
    q: $<HTMLInputElement>("param-q"),
    chi1: $<HTMLInputElement>("param-chi1"),
    chi2: $<HTMLInputElement>("param-chi2"),
  };
  const labels = {
    q: $<HTMLSpanElement>("param-q-value"),
    chi1: $<HTMLSpanElement>("param-chi1-value"),
    chi2: $<HTMLSpanElement>("param-chi2-value"),
  };
  inputs.q.min = String(PARAM_RANGE.q[0]);
  inputs.q.max = String(PARAM_RANGE.q[1]);
  for (const k of ["chi1", "chi2"] as const) {
    inputs[k].min = String(PARAM_RANGE.chi[0]);
    inputs[k].max = String(PARAM_RANGE.chi[1]);
  }
  const read = (): BinaryParams => ({
    q: Number(inputs.q.value),
    chi1: Number(inputs.chi1.value),
    chi2: Number(inputs.chi2.value),
  });
  const write = (p: BinaryParams) => {
    for (const k of ["q", "chi1", "chi2"] as const) {
      inputs[k].value = String(p[k]);
      labels[k].textContent = k === "q" ? p[k].toFixed(1) : p[k].toFixed(2);
    }
  };
  write(initial);

  let pending = false;
  const schedule = () => {
    write(read());
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      onChange(read());
    });
  };
  for (const input of Object.values(inputs)) input.addEventListener("input", schedule);
  $<HTMLButtonElement>("param-reset").addEventListener("click", () => {
    write(defaults);
    schedule();
  });
}
