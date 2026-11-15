// Curvature app: embedding diagrams of curved spatial slices (plan: curvature.md
// on the dev branch). Flamm's paraboloid: the equatorial slice of Schwarzschild
// space as a surface in R³ with the same lengths, drawn as a well.
// URL options: ?grid=cartesian|polar|proper, ?rmax=<outer radius in M>, ?probe=<r in M>, ?selftest.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { profile, radiusAtCirc, schwarzschild } from "./embedding";
import { runCurvatureSelfTest } from "./selftest";
import { type GridStyle, Sheet, curvatureScale } from "./sheet";

const R_MIN = 6; // M; smallest outer radius
const R_MAX = 150;
const R_DEFAULT = 30;
const GRIDS: GridStyle[] = ["cartesian", "polar", "proper"];
const VIEW_DIR = new THREE.Vector3(0, -1, 0.62).normalize();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const SUPERSCRIPT: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
const pow10 = (e: number) => `10${String(e).replace(/./g, (c) => SUPERSCRIPT[c])}`;
/** −5.8 × 10⁻⁴ */
function sci(x: number): string {
  const [m, e] = x.toExponential(1).split("e");
  return `${m.replace("-", "−")} × ${pow10(Number(e))}`;
}
const fmt = (x: number) => (x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : x.toFixed(0));

async function main() {
  const status = $("status");
  const url = new URLSearchParams(window.location.search);

  if (url.has("selftest")) {
    const r = await runCurvatureSelfTest();
    const e = (v: [number, number, number]) => v.map((x) => x.toExponential(1)).join(" / ");
    const verdict =
      `SELFTEST ${r.pass ? "PASS" : "FAIL"}: embedding over ${r.samples} radii, worst relative error ` +
      `(height / distance / curvature) vs Rust ${e(r.vsRust)}, vs closed forms ${e(r.vsClosed)}`;
    document.title = verdict;
    status.textContent = verdict;
    status.classList.toggle("error", !r.pass);
    return;
  }

  const canvas = $<HTMLCanvasElement>("view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x090a0e);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5e3);
  camera.up.set(0, 0, 1);

  const sheet = new Sheet(schwarzschild);
  scene.add(sheet.group);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.rotateSpeed = 0.6;

  // --- State, from the URL ---
  let grid: GridStyle = GRIDS.includes(url.get("grid") as GridStyle) ? (url.get("grid") as GridStyle) : "cartesian";
  let rMax = url.has("rmax") ? Math.min(Math.max(Number(url.get("rmax")) || R_DEFAULT, R_MIN), R_MAX) : R_DEFAULT;
  const probe0 = Number(url.get("probe"));
  let probeR: number | null = probe0 > schwarzschild.horizon ? probe0 : null;

  const writeUrl = () => {
    const u = new URL(window.location.href);
    if (grid !== "cartesian") u.searchParams.set("grid", grid);
    else u.searchParams.delete("grid");
    if (rMax !== R_DEFAULT) u.searchParams.set("rmax", String(Math.round(rMax)));
    else u.searchParams.delete("rmax");
    if (probeR !== null) u.searchParams.set("probe", probeR.toFixed(2));
    else u.searchParams.delete("probe");
    history.replaceState(null, "", u);
  };

  const rim = () => sheet.rim;

  // Frame the well with the sheet fading into the distance beyond it: the camera
  // looks at a point partway down the well from 3.7 view radii away.
  const frame = () => {
    controls.target.set(0, 0, -0.45 * sheet.depth);
    camera.position.copy(controls.target).addScaledVector(VIEW_DIR, 3.7 * rim());
    controls.minDistance = 3;
    controls.maxDistance = 12 * rMax;
  };

  // --- Probe ---
  const probeInfo = $("probe");
  const showProbe = () => {
    if (probeR === null || probeR > sheet.rFar) {
      if (probeR !== null) {
        probeR = null;
        writeUrl();
      }
      sheet.setProbe(null);
      probeInfo.textContent = "Click the sheet to measure it there.";
      return;
    }
    const r = probeR;
    const p = profile(schwarzschild, [schwarzschild.horizon, r]);
    const [circ, height, dist, k] = [p.circ[1], p.height[1], p.distance[1], p.curvature[1]];
    sheet.setProbe({ circ, height });
    // In flat space, circles of these two circumferences would be this far apart.
    const flat = circ - p.circ[0];
    probeInfo.innerHTML =
      `<strong>Circle at r = ${fmt(r)} M</strong>\n` +
      `Circumference ${fmt(2 * Math.PI * circ)} M (2π × ${fmt(circ)} M)\n` +
      `Distance to the horizon ${fmt(dist)} M (flat space: ${fmt(flat)} M)\n` +
      `Curvature K = ${sci(k)} / M²`;
  };

  // --- Building ---
  const rebuild = () => {
    sheet.build(rMax);
    showProbe();
  };
  // A new outer radius: rebuild, and scale the camera and target with the sheet to keep the view.
  const rescale = (next: number) => {
    const oldDepth = sheet.depth;
    const oldRim = rim();
    rMax = next;
    rebuild();
    const offset = camera.position.clone().sub(controls.target).multiplyScalar(rim() / oldRim);
    controls.target.set(0, 0, controls.target.z * (sheet.depth / oldDepth));
    camera.position.copy(controls.target).add(offset);
    controls.maxDistance = 12 * rMax;
  };
  sheet.grid = grid;
  rebuild();
  frame();

  // --- Controls ---
  const gridButtons = [...document.querySelectorAll<HTMLButtonElement>("#grid button")];
  const syncGrid = () => {
    for (const b of gridButtons) b.setAttribute("aria-pressed", String(b.dataset.grid === grid));
    sheet.grid = grid;
  };
  for (const b of gridButtons) {
    b.addEventListener("click", () => {
      grid = b.dataset.grid as GridStyle;
      syncGrid();
      writeUrl();
    });
  }
  syncGrid();

  const rSlider = $<HTMLInputElement>("rmax");
  const rLabel = $("rmax-value");
  const toSlider = (r: number) => (1000 * Math.log(r / R_MIN)) / Math.log(R_MAX / R_MIN);
  const fromSlider = (v: number) => R_MIN * Math.pow(R_MAX / R_MIN, v / 1000);
  rSlider.value = String(toSlider(rMax));
  rLabel.textContent = `${Math.round(rMax)} M`;
  rSlider.addEventListener("input", () => {
    const r = Math.round(fromSlider(Number(rSlider.value)));
    rLabel.textContent = `${r} M`;
    if (r !== rMax) {
      rescale(r);
      writeUrl();
    }
  });

  const legend = $("legend");
  const curvatureBox = $<HTMLInputElement>("curvature");
  curvatureBox.addEventListener("change", () => {
    sheet.curvature = curvatureBox.checked;
    legend.hidden = !curvatureBox.checked;
  });

  // Legend: the bar is linear in the tint, so ticks sit where curvatureScale puts them.
  {
    const u = sheet.material.uniforms;
    const base = u.u_base.value as THREE.Color;
    const end = (c: THREE.Color) => `#${base.clone().lerp(c, 0.85).getHexString()}`;
    legend.querySelector<HTMLElement>(".bar")!.style.background =
      `linear-gradient(to right, ${end(u.u_neg.value)}, #${base.getHexString()} 50%, ${end(u.u_pos.value)})`;
    const ticks = legend.querySelector<HTMLElement>(".ticks")!;
    for (const [k, label] of [
      [-0.1, `−${pow10(-1)}`],
      [-1e-3, `−${pow10(-3)}`],
      [0, "0"],
      [1e-3, pow10(-3)],
      [0.1, pow10(-1)],
    ] as const) {
      const span = document.createElement("span");
      span.textContent = label;
      span.style.left = `${50 + 50 * curvatureScale(k)}%`;
      ticks.append(span);
    }
  }

  canvas.addEventListener("dblclick", frame);

  // A click (not a drag) on the sheet places the probe.
  const raycaster = new THREE.Raycaster();
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || !sheet.mesh) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(sheet.mesh)[0];
    if (!hit) return;
    probeR = radiusAtCirc(sheet.profile, Math.hypot(hit.point.x, hit.point.y));
    showProbe();
    writeUrl();
  });

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  };
  renderer.setAnimationLoop(() => {
    resize();
    controls.update();
    sheet.update(camera);
    renderer.render(scene, camera);
  });
  status.textContent = "";
}

main().catch((err) => {
  const status = $("status");
  status.textContent = err instanceof Error ? err.message : String(err);
  status.classList.add("error");
  console.error(err);
});
