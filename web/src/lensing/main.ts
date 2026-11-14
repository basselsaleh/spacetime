// Black hole lensing app: an orbit camera around a Schwarzschild black hole in
// front of a procedural sky, every pixel ray-traced exactly (lens.ts).
// URL options: ?r=<distance in M>, ?fov=<degrees>, ?selftest, ?lensbench.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Lens } from "./lens";
import { runLensBenchmark, runLensSelfTest } from "./selftest";

const R_MIN = 3.5; // M; the camera must stay outside the photon sphere (r = 3)
const R_MAX = 300;
const R_DEFAULT = 20;
const DEFAULT_DIR = new THREE.Vector3(0, -20, 3).normalize();
const B_CRIT = 3 * Math.sqrt(3);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Angular radius of the shadow for a static observer at r (> 3). */
function shadowRadius(r: number): number {
  return Math.asin((B_CRIT / r) * Math.sqrt(1 - 2 / r));
}

async function main() {
  const status = $("status");
  const canvas = $<HTMLCanvasElement>("view");
  const url = new URLSearchParams(window.location.search);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000);
  const lens = new Lens(dpr);

  if (url.has("selftest")) {
    const r = await runLensSelfTest(renderer, lens);
    const verdict =
      `SELFTEST ${r.pass ? "PASS" : "FAIL"}: max escape-direction error = ${r.worst.toExponential(2)} rad ` +
      `over ${r.rays} rays, ${r.skipped} near-critical skipped (per view: ${r.perView.map((e) => e.toExponential(1)).join(", ")})`;
    document.title = verdict;
    status.textContent = verdict;
    status.classList.toggle("error", !r.pass);
    return;
  }

  const fov0 = url.has("fov") ? Math.min(Math.max(Number(url.get("fov")), 20), 140) : 60;
  const camera = new THREE.PerspectiveCamera(fov0, 1, 0.1, 1e4);
  camera.up.set(0, 0, 1);
  const r0 = url.has("r") ? Math.min(Math.max(Number(url.get("r")), R_MIN), R_MAX) : R_DEFAULT;
  camera.position.copy(DEFAULT_DIR).multiplyScalar(r0);
  camera.lookAt(0, 0, 0);

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  };
  resize();

  if (url.has("lensbench")) {
    const verdict = runLensBenchmark(renderer, lens, canvas.clientWidth, canvas.clientHeight);
    document.title = verdict;
    status.textContent = verdict;
    return;
  }

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.enablePan = false;
  controls.minDistance = R_MIN;
  controls.maxDistance = R_MAX;
  controls.rotateSpeed = 0.6;
  // Zooming moves the camera (changes the distance), which is what changes the lensing.
  controls.zoomSpeed = 0.8;

  // Distance slider, logarithmic, kept in sync with zooming.
  const slider = $<HTMLInputElement>("distance");
  const label = $("distance-value");
  const toSlider = (r: number) => (1000 * Math.log(r / R_MIN)) / Math.log(R_MAX / R_MIN);
  const fromSlider = (v: number) => R_MIN * Math.pow(R_MAX / R_MIN, v / 1000);
  slider.addEventListener("input", () => {
    const r = fromSlider(Number(slider.value));
    camera.position.setLength(r);
  });
  const fovSlider = $<HTMLInputElement>("fov");
  const fovLabel = $("fov-value");
  fovSlider.value = String(camera.fov);
  fovSlider.addEventListener("input", () => {
    camera.fov = Number(fovSlider.value);
    camera.updateProjectionMatrix();
  });
  canvas.addEventListener("dblclick", () => {
    camera.position.copy(DEFAULT_DIR).multiplyScalar(R_DEFAULT);
    controls.target.set(0, 0, 0);
  });

  const info = $("shadow-info");
  let frames = 0;
  let since = performance.now();
  const frame = () => {
    resize();
    controls.update();
    lens.render(renderer, camera, canvas.clientWidth, canvas.clientHeight);

    const r = camera.position.length();
    if (document.activeElement !== slider) slider.value = String(toSlider(r));
    label.textContent = `${r < 10 ? r.toFixed(2) : r.toFixed(1)} M`;
    fovLabel.textContent = `${Math.round(camera.fov)}°`;
    const shadowDeg = (shadowRadius(r) * 180) / Math.PI;
    info.textContent = `Shadow radius ${shadowDeg.toFixed(1)}° (${(r / 2).toFixed(1)} horizon radii away)`;

    frames++;
    const now = performance.now();
    if (now - since > 1000) {
      const rw = Math.round(canvas.clientWidth * lens.pass.scale);
      const rh = Math.round(canvas.clientHeight * lens.pass.scale);
      status.textContent = `${((frames * 1000) / (now - since)).toFixed(0)} fps · ${rw}×${rh}`;
      frames = 0;
      since = now;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  const status = $("status");
  status.textContent = err instanceof Error ? err.message : String(err);
  status.classList.add("error");
  console.error(err);
});
