// Curvature app: embedding diagrams of curved spatial slices (plan: curvature.md
// on the dev branch). The equatorial slice of a black hole's space (Flamm's
// paraboloid), the Einstein–Rosen bridge, or a uniform-density star, each as a
// surface in R³ with the same lengths, drawn as a well.
//
// Lengths are shown in units of the mass M, except for the star, which is shown
// in units of its radius R so that its mass can vary under a ball of fixed size.
// The physics is always computed in M: the star's radius is R/M = 1/(M/R).
//
// URL options: ?s=schwarzschild|bridge|star, ?m=<star mass M/R>, ?nostar,
// ?grid=cartesian|polar|proper, ?rmax=<view radius, in M or R>, ?probe=<r, in M
// or R> (&lower for the bridge's lower sheet), ?selftest.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { BUCHDAHL, type Slice, profile, radiusAtCirc, schwarzschild, star } from "./embedding";
import { runCurvatureSelfTest } from "./selftest";
import { type GridStyle, Sheet, type SheetSpec, curvatureScale } from "./sheet";
import { StarGlow } from "./star";

type Spacetime = "schwarzschild" | "bridge" | "star";
type Unit = "M" | "R";
const SPACETIMES: Spacetime[] = ["schwarzschild", "bridge", "star"];
const GRIDS: GridStyle[] = ["cartesian", "polar", "proper"];
/** View radius range and default, per unit of length. */
const VIEW: Record<Unit, { min: number; max: number; def: number }> = {
  M: { min: 6, max: 150, def: 30 },
  R: { min: 2, max: 50, def: 5 },
};
// The star's mass in units of its radius, M/R: up to Buchdahl's limit 4/9.
const MASS_MIN = 0.01;
const MASS_MAX = 1 / BUCHDAHL;
const MASS_DEFAULT = 1 / 6; // about a neutron star's
const VIEW_DIR = new THREE.Vector3(0, -1, 0.62).normalize();
// The bridge from nearly side-on, at the throat's level: the camera sits between
// the two sheets, so both show, joined at the throat like an hourglass.
const BRIDGE_DIR = new THREE.Vector3(0, -1, 0.25).normalize();
const HORIZON_COLOR = 0xeceff7;
const STAR_COLOR = 0xffc552;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const SUPERSCRIPT: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
const pow10 = (e: number) => `10${String(e).replace(/./g, (c) => SUPERSCRIPT[c])}`;
/** −5.8 × 10⁻⁴ */
function sci(x: number): string {
  const [m, e] = x.toExponential(1).split("e");
  return `${m.replace("-", "−")} × ${pow10(Number(e))}`;
}
const fmt = (x: number) => (x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : x.toFixed(0));

/** A log-scale slider mapping [lo, hi] to 0–1000; the range can change. */
function logSlider(input: HTMLInputElement, lo: number, hi: number) {
  return {
    range(l: number, h: number) {
      lo = l;
      hi = h;
    },
    set: (x: number) => (input.value = String((1000 * Math.log(x / lo)) / Math.log(hi / lo))),
    get: () => lo * Math.pow(hi / lo, Number(input.value) / 1000),
  };
}

async function main() {
  const status = $("status");
  const url = new URLSearchParams(window.location.search);

  if (url.has("selftest")) {
    const r = await runCurvatureSelfTest();
    const e = (v: [number, number, number]) => v.map((x) => x.toExponential(1)).join(" / ");
    const verdict =
      `SELFTEST ${r.pass ? "PASS" : "FAIL"}: embedding over ${r.samples} radii (black hole, 3 stars), worst relative error ` +
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
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5e3); // clipping set by fitCamera
  camera.up.set(0, 0, 1);

  const sheet = new Sheet();
  const glow = new StarGlow();
  scene.add(sheet.group, glow.group);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.rotateSpeed = 0.6;

  // --- State, from the URL ---
  const pick = <T extends string>(key: string, options: T[]) => (options.includes(url.get(key) as T) ? (url.get(key) as T) : options[0]);
  const clamp = (key: string, lo: number, hi: number, fallback: number) =>
    url.has(key) ? Math.min(Math.max(Number(url.get(key)) || fallback, lo), hi) : fallback;
  let spacetime = pick("s", SPACETIMES);
  let grid = pick("grid", GRIDS);
  let mass = clamp("m", MASS_MIN, MASS_MAX, MASS_DEFAULT);
  let showStar = !url.has("nostar");
  const unitName = (): Unit => (spacetime === "star" ? "R" : "M");
  /** The displayed unit of length, in M. */
  const unit = () => (spacetime === "star" ? 1 / mass : 1);
  /** View radius in the displayed unit, kept per unit so switching back restores it. */
  const view: Record<Unit, number> = { M: VIEW.M.def, R: VIEW.R.def };
  {
    const v = VIEW[unitName()];
    view[unitName()] = clamp("rmax", v.min, v.max, v.def);
  }
  /** The view radius in M, for the sheet. */
  const rMax = () => view[unitName()] * unit();
  /** Probe radius in the displayed unit. */
  let probe: { r: number; lower: boolean } | null = url.has("probe")
    ? { r: Number(url.get("probe")), lower: url.has("lower") }
    : null;

  const writeUrl = () => {
    const u = new URL(window.location.href);
    const put = (key: string, value: string | null) => (value === null ? u.searchParams.delete(key) : u.searchParams.set(key, value));
    const star = spacetime === "star";
    put("s", spacetime !== "schwarzschild" ? spacetime : null);
    put("m", star && mass !== MASS_DEFAULT ? mass.toFixed(3) : null);
    put("nostar", star && !showStar ? "" : null);
    put("grid", grid !== "cartesian" ? grid : null);
    const v = view[unitName()];
    put("rmax", v !== VIEW[unitName()].def ? String(v) : null);
    put("probe", probe ? probe.r.toFixed(2) : null);
    put("lower", probe?.lower ? "" : null);
    history.replaceState(null, "", u);
  };

  const sliceOf = (): Slice => (spacetime === "star" ? star(1 / mass) : schwarzschild);
  const specOf = (): SheetSpec =>
    spacetime === "star"
      ? { slice: star(1 / mass), mirror: false, mark: { r: 1 / mass, color: STAR_COLOR }, unit: 1 / mass }
      : { slice: schwarzschild, mirror: spacetime === "bridge", mark: { r: 2, color: HORIZON_COLOR }, unit: 1 };

  // Orbit limits and clipping planes in proportion to the sheet, whose size in M
  // ranges over a factor of ~1000 (a light star's radius is 100 M).
  const fitCamera = () => {
    controls.minDistance = 0.1 * sheet.rim;
    controls.maxDistance = 12 * sheet.rim;
    camera.near = 0.003 * sheet.rim;
    camera.far = 200 * sheet.rim;
    camera.updateProjectionMatrix();
  };

  // Frame the well with the sheet fading into the distance beyond it: the camera
  // looks at a point partway down the well from 3.7 view radii away. The bridge
  // is framed on its throat, from the side, 3.2 view radii away.
  const frame = () => {
    const bridge = spacetime === "bridge";
    controls.target.set(0, 0, bridge ? -sheet.depth : -0.45 * sheet.depth);
    const dist = bridge ? 3.2 : 3.7;
    camera.position.copy(controls.target).addScaledVector(bridge ? BRIDGE_DIR : VIEW_DIR, dist * sheet.rim);
    fitCamera();
  };

  // --- Probe ---
  const probeInfo = $("probe");
  const showProbe = () => {
    const s = sliceOf();
    const u = unit();
    if (probe && (!(probe.r * u > s.inner) || probe.r * u > sheet.rFar || (probe.lower && spacetime !== "bridge"))) {
      probe = null;
      writeUrl();
    }
    if (!probe) {
      sheet.setProbe(null);
      probeInfo.textContent = "Click the sheet to measure it there.";
      return;
    }
    const r = probe.r * u;
    const p = profile(s, [s.inner, r]);
    const [circ, height, dist, k] = [p.circ[1], p.height[1], p.distance[1], p.curvature[1]];
    sheet.setProbe({ circ, height, lower: probe.lower });
    // In flat space, circles of these two circumferences would be this far apart.
    const flat = circ - p.circ[0];
    const where =
      spacetime === "star" ? (r <= 1 / mass ? " (inside the star)" : " (outside the star)") : probe.lower ? " (lower sheet)" : "";
    const edge = spacetime === "star" ? "center" : spacetime === "bridge" ? "throat" : "horizon";
    const n = unitName();
    const ku = k * u * u;
    probeInfo.innerHTML =
      `<strong>Circle at r = ${fmt(r / u)} ${n}</strong>${where}\n` +
      `Circumference ${fmt((2 * Math.PI * circ) / u)} ${n} (2π × ${fmt(circ / u)} ${n})\n` +
      `Distance to the ${edge} ${fmt(dist / u)} ${n} (flat space: ${fmt(flat / u)} ${n})\n` +
      `Curvature K = ${ku > 0 ? "+" : ""}${sci(ku)} / ${n}²`;
  };

  // --- Building ---
  const rebuild = () => {
    sheet.build(specOf(), rMax());
    glow.group.visible = spacetime === "star" && showStar;
    // The star rests at the bottom of its bowl, the center of its slice.
    if (spacetime === "star") glow.place(1 / mass, sheet.drawnHeight(0));
    showProbe();
  };
  // Rebuild after `change`, scaling the camera and target with the sheet to keep
  // the view. For the star's mass this keeps the ball the same size on screen.
  const rescale = (change: () => void) => {
    const oldDepth = sheet.depth;
    const oldRim = sheet.rim;
    change();
    rebuild();
    const offset = camera.position.clone().sub(controls.target).multiplyScalar(sheet.rim / oldRim);
    controls.target.set(0, 0, controls.target.z * (sheet.depth / oldDepth));
    camera.position.copy(controls.target).add(offset);
    fitCamera();
  };
  sheet.grid = grid;
  rebuild();
  frame();

  // --- Controls ---
  const toggle = (id: string, key: string, current: () => string, choose: (v: string) => void) => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(`#${id} button`)];
    const sync = () => {
      for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset[key] === current()));
    };
    for (const b of buttons) {
      b.addEventListener("click", () => {
        choose(b.dataset[key]!);
        sync();
        writeUrl();
      });
    }
    sync();
  };

  const viewInput = $<HTMLInputElement>("rmax");
  const viewSlider = logSlider(viewInput, VIEW.M.min, VIEW.M.max);
  const viewLabel = $("rmax-value");
  const fmtView = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} ${unitName()}`;
  const syncView = () => {
    const v = VIEW[unitName()];
    viewSlider.range(v.min, v.max);
    viewSlider.set(view[unitName()]);
    viewLabel.textContent = fmtView(view[unitName()]);
  };

  const starOnly = [...document.querySelectorAll<HTMLElement>(".star-only")];
  const aboutParas = [...document.querySelectorAll<HTMLElement>("#about p[data-about]")];
  const kUnit = $("k-unit");
  const syncSpacetime = () => {
    for (const el of starOnly) el.hidden = spacetime !== "star";
    for (const el of aboutParas) el.hidden = !el.dataset.about!.split(" ").includes(spacetime);
    kUnit.textContent = `1/${unitName()}²`;
    syncView();
  };
  toggle("spacetime", "s", () => spacetime, (v) => {
    if (v === spacetime) return;
    const oldUnit = unitName();
    spacetime = v as Spacetime;
    if (unitName() !== oldUnit) probe = null; // its radius was in the other unit
    syncSpacetime();
    rebuild();
    frame();
  });
  syncSpacetime();

  toggle("grid", "grid", () => grid, (v) => {
    grid = v as GridStyle;
    sheet.grid = grid;
  });

  viewInput.addEventListener("input", () => {
    const raw = viewSlider.get();
    const v = raw < 10 ? Math.round(raw * 10) / 10 : Math.round(raw);
    viewLabel.textContent = fmtView(v);
    if (v !== view[unitName()]) {
      rescale(() => (view[unitName()] = v));
      writeUrl();
    }
  });

  const massInput = $<HTMLInputElement>("mass");
  const massSlider = logSlider(massInput, MASS_MIN, MASS_MAX);
  const massLabel = $("mass-value");
  massSlider.set(mass);
  massLabel.textContent = mass.toFixed(3);
  massInput.addEventListener("input", () => {
    // The top of the slider is exactly Buchdahl's limit.
    const m = massInput.value === "1000" ? MASS_MAX : Math.round(massSlider.get() * 1000) / 1000;
    massLabel.textContent = m.toFixed(3);
    if (m !== mass) {
      rescale(() => (mass = m));
      writeUrl();
    }
  });

  const starBox = $<HTMLInputElement>("show-star");
  starBox.checked = showStar;
  starBox.addEventListener("change", () => {
    showStar = starBox.checked;
    glow.group.visible = spacetime === "star" && showStar;
    writeUrl();
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
    probe = {
      r: radiusAtCirc(sheet.profile, Math.hypot(hit.point.x, hit.point.y)) / unit(),
      lower: spacetime === "bridge" && hit.point.z < sheet.drawnHeight(0),
    };
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
    glow.update(camera);
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
