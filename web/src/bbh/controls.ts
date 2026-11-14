// Playback controls, per-view pan/zoom with click-to-probe, and the binary
// parameter sliders.

import { pixelToSlice, type Camera, type SceneState } from "./slice";
import { PARAM_RANGE, type BinaryParams } from "./waveform";

export interface Playback {
  playing: boolean;
  speed: number; // M of coordinate time per second
  tMin: number;
  /** End of playback: when the merger burst has left the visible area. */
  tMax: number;
  /** Restart from `loopStart` at the end. */
  loop: boolean;
  loopStart: number;
}

const BASE_SPEED = 100; // M per second at ×1
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function setupPlayback(scene: SceneState, playback: Playback): { sync: () => void } {
  const playBtn = $<HTMLButtonElement>("play");
  const scrub = $<HTMLInputElement>("scrub");
  const timeLabel = $<HTMLSpanElement>("time");
  const speed = $<HTMLSelectElement>("speed");
  const loop = $<HTMLInputElement>("loop");
  loop.checked = playback.loop;
  loop.addEventListener("change", () => (playback.loop = loop.checked));

  scrub.step = "1";
  const togglePlay = () => {
    if (!playback.playing && scene.time >= playback.tMax) scene.time = playback.loopStart;
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

  function sync() {
    scrub.min = String(playback.tMin);
    scrub.max = String(playback.tMax);
    playBtn.textContent = playback.playing ? "Pause" : "Play";
    scrub.value = String(scene.time);
    timeLabel.textContent = `t = ${scene.time.toFixed(0)} M`;
  }
  sync();
  return { sync };
}

/**
 * Pointer handling for the view. In the flat view: drag to pan, wheel to zoom
 * around the cursor, double-click to reset. In the 3D view the orbit controls
 * handle dragging and zooming. In both, a click without dragging calls
 * `onClick` with the pixel position (CSS px).
 */
export function setupPointer(
  canvas: HTMLCanvasElement,
  camera: Camera,
  isFlat: () => boolean,
  onClick: (px: number, py: number) => void,
  onDoubleClick: () => void,
): void {
  const local = (e: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top, w: rect.width, h: rect.height };
  };
  let drag: { x: number; y: number; moved: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (isFlat()) {
      const perPixel = (2 * camera.halfWidth) / local(e).w;
      camera.centerX -= dx * perPixel;
      camera.centerY += dy * perPixel;
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    if (drag && drag.moved < 4) {
      const { px, py } = local(e);
      onClick(px, py);
    }
    drag = null;
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!isFlat()) return;
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
  canvas.addEventListener("dblclick", onDoubleClick);
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
