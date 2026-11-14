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

type SpinKey = "spin1" | "spin2";
type Field = "mag" | "tilt" | "azimuth";
const FIELDS: { field: Field; min: number; max: number; step: number; format: (v: number) => string }[] = [
  { field: "mag", min: 0, max: PARAM_RANGE.chi, step: 0.05, format: (v) => v.toFixed(2) },
  { field: "tilt", min: 0, max: 180, step: 5, format: (v) => `${v.toFixed(0)}°` },
  { field: "azimuth", min: 0, max: 355, step: 5, format: (v) => `${v.toFixed(0)}°` },
];

/**
 * Parameter sliders: q, and each spin as magnitude, tilt from L̂ and azimuth
 * (from the direction to the heavier hole). `onChange` fires (at most once
 * per frame) while dragging. Tilt and azimuth are disabled while the
 * magnitude is zero, azimuth also while the tilt is 0° or 180°.
 */
export function setupParams(
  initial: BinaryParams,
  defaults: BinaryParams,
  onChange: (p: BinaryParams) => void,
): void {
  const q = $<HTMLInputElement>("param-q");
  const qLabel = $<HTMLSpanElement>("param-q-value");
  q.min = String(PARAM_RANGE.q[0]);
  q.max = String(PARAM_RANGE.q[1]);
  const spinInputs = (["spin1", "spin2"] as SpinKey[]).map((key, n) =>
    FIELDS.map((f) => {
      const input = $<HTMLInputElement>(`param-chi${n + 1}-${f.field}`);
      input.min = String(f.min);
      input.max = String(f.max);
      input.step = String(f.step);
      return { key, ...f, input, label: $<HTMLSpanElement>(`param-chi${n + 1}-${f.field}-value`) };
    }),
  );
  const all = spinInputs.flat();

  const read = (): BinaryParams => {
    const spin = (k: SpinKey) => {
      const get = (field: Field) => Number(all.find((x) => x.key === k && x.field === field)!.input.value);
      return { mag: get("mag"), tilt: get("tilt"), azimuth: get("azimuth") };
    };
    return { q: Number(q.value), spin1: spin("spin1"), spin2: spin("spin2") };
  };
  const write = (p: BinaryParams) => {
    q.value = String(p.q);
    qLabel.textContent = p.q.toFixed(1);
    for (const x of all) {
      const v = p[x.key][x.field];
      x.input.value = String(v);
      x.label.textContent = x.format(v);
    }
    for (const row of spinInputs) {
      const mag = Number(row[0].input.value);
      const tilt = Number(row[1].input.value);
      row[1].input.disabled = mag === 0;
      row[2].input.disabled = mag === 0 || tilt === 0 || tilt === 180;
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
  for (const input of [q, ...all.map((x) => x.input)]) input.addEventListener("input", schedule);
  $<HTMLButtonElement>("param-reset").addEventListener("click", () => {
    write(defaults);
    schedule();
  });
}
