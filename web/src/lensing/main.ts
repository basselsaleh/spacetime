// Black hole lensing app: an orbit camera around a black hole in front of a
// procedural sky, every pixel ray-traced exactly (lens.ts).
// URL options: ?r=<distance in M>, ?fov=<degrees>, ?a=<spin a/M>, ?selftest, ?lensbench.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Lens } from "./lens";
import { runLensBenchmark, runLensSelfTest } from "./selftest";
import { horizonRadius, shadowEdge, shadowExtent } from "./shadow";

const R_MIN = 3.5; // M; outside the photon sphere (r = 3) at spin 0, and the ergosphere (r ≤ 2) at any spin
const SPIN_MAX = 0.998; // Thorne's limit
const R_MAX = 300;
const R_DEFAULT = 40;
const DEFAULT_DIR = new THREE.Vector3(0, -20, 3).normalize();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const deg = (rad: number) => (rad * 180) / Math.PI;

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
      `over ${r.rays} rays, ${r.skipped} near-critical skipped, ${r.mismatches} capture mismatches, ` +
      `shadow readout vs Rust ${r.readoutError.toExponential(1)} rad ` +
      `(per view: ${r.perView.map((e) => `${e.label} ${e.worst.toExponential(1)}`).join(", ")})`;
    document.title = verdict;
    status.textContent = verdict;
    status.classList.toggle("error", !r.pass);
    return;
  }

  let spin = url.has("a") ? Math.min(Math.max(Number(url.get("a")) || 0, 0), SPIN_MAX) : 0;
  lens.spin = spin;

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
  // Spin slider (a/M in thousandths), kept in the URL as ?a= (left out at 0).
  const spinSlider = $<HTMLInputElement>("spin");
  const spinLabel = $("spin-value");
  spinSlider.value = String(Math.round(spin * 1000));
  spinSlider.addEventListener("input", () => {
    spin = Number(spinSlider.value) / 1000;
    lens.spin = spin;
    const u = new URL(window.location.href);
    if (spin > 0) u.searchParams.set("a", spin.toFixed(3));
    else u.searchParams.delete("a");
    history.replaceState(null, "", u);
  });
  canvas.addEventListener("dblclick", () => {
    camera.position.copy(DEFAULT_DIR).multiplyScalar(R_DEFAULT);
    controls.target.set(0, 0, 0);
  });

  const info = $("shadow-info");
  // The readout's shadow size, recomputed only when the camera or spin moves.
  let readoutKey = "";
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
    spinLabel.textContent = spin.toFixed(3);
    const eye: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z];
    const key = `${eye.map((v) => v.toFixed(3)).join()},${spin}`;
    if (key !== readoutKey) {
      readoutKey = key;
      const rPlus = horizonRadius(spin);
      const { width, height } = shadowExtent(shadowEdge(eye, spin, 400), eye);
      info.textContent =
        `Shadow ${deg(width).toFixed(1)}° wide × ${deg(height).toFixed(1)}° tall\n` +
        `Horizon radius ${rPlus.toFixed(3)} M · ${(r / rPlus).toFixed(1)} of them away`;
    }

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
