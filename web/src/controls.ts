// Playback controls (play/pause, time scrubber, speed, gain) and pan/zoom.

import type { ViewState } from "./strainView";

export interface Playback {
  playing: boolean;
  speed: number; // M of coordinate time per second
  tMin: number;
  tMax: number;
}

const BASE_SPEED = 100; // M per second at ×1

export function setupControls(
  canvas: HTMLCanvasElement,
  view: ViewState,
  playback: Playback,
  defaults: ViewState,
): { sync: () => void } {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const playBtn = $<HTMLButtonElement>("play");
  const scrub = $<HTMLInputElement>("scrub");
  const timeLabel = $<HTMLSpanElement>("time");
  const speed = $<HTMLSelectElement>("speed");
  const gain = $<HTMLInputElement>("gain");
  const gainLabel = $<HTMLSpanElement>("gain-value");

  scrub.min = String(playback.tMin);
  scrub.max = String(playback.tMax);
  scrub.step = "1";

  const togglePlay = () => {
    if (!playback.playing && view.time >= playback.tMax) view.time = playback.tMin;
    playback.playing = !playback.playing;
    sync();
  };
  playBtn.addEventListener("click", togglePlay);
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && e.target === document.body) {
      e.preventDefault();
      togglePlay();
    }
  });
  scrub.addEventListener("input", () => {
    view.time = Number(scrub.value);
    sync();
  });
  speed.addEventListener("change", () => {
    playback.speed = BASE_SPEED * Number(speed.value);
  });
  playback.speed = BASE_SPEED * Number(speed.value);
  gain.addEventListener("input", () => {
    view.gain = Number(gain.value);
    sync();
  });

  // Pan with drag, zoom with wheel around the cursor, double-click to reset.
  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const u = (clientX - rect.left) / rect.width;
    const v = 1 - (clientY - rect.top) / rect.height;
    const aspect = rect.width / rect.height;
    return {
      x: view.centerX + (u * 2 - 1) * view.halfWidth,
      y: view.centerY + (v * 2 - 1) * (view.halfWidth / aspect),
    };
  };
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const perPixel = (2 * view.halfWidth) / canvas.getBoundingClientRect().width;
    view.centerX -= (e.clientX - drag.x) * perPixel;
    view.centerY += (e.clientY - drag.y) * perPixel;
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", () => (drag = null));
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const before = toWorld(e.clientX, e.clientY);
      const factor = Math.exp(e.deltaY * 0.0015);
      view.halfWidth = Math.min(Math.max(view.halfWidth * factor, 10), 6000);
      const after = toWorld(e.clientX, e.clientY);
      view.centerX += before.x - after.x;
      view.centerY += before.y - after.y;
    },
    { passive: false },
  );
  canvas.addEventListener("dblclick", () => {
    view.centerX = defaults.centerX;
    view.centerY = defaults.centerY;
    view.halfWidth = defaults.halfWidth;
  });

  function sync() {
    playBtn.textContent = playback.playing ? "Pause" : "Play";
    scrub.value = String(view.time);
    timeLabel.textContent = `t = ${view.time.toFixed(0)} M`;
    gainLabel.textContent = `×${view.gain.toFixed(1)}`;
  }
  sync();
  return { sync };
}
