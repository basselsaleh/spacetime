// Curvature app: embedding diagrams of curved spatial slices (plan: curvature.md on the dev branch).
// Step 0 scaffold: a flat placeholder sheet with grid lines and an orbit camera. Step 1 replaces
// the sheet with Flamm's paraboloid.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const EXTENT = 30; // M; half-width of the sheet
const DEFAULT_POS = new THREE.Vector3(0, -48, 30);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function main() {
  const status = $("status");
  const canvas = $<HTMLCanvasElement>("view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x090a0e);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e3);
  camera.up.set(0, 0, 1); // +z up, as in the other apps
  camera.position.copy(DEFAULT_POS);

  // Placeholder: flat space, a square grid in the x–y plane (1 line per 2 M).
  const grid = new THREE.GridHelper(2 * EXTENT, EXTENT, 0x48537a, 0x2c3346);
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.minDistance = 5;
  controls.maxDistance = 200;
  canvas.addEventListener("dblclick", () => {
    camera.position.copy(DEFAULT_POS);
    controls.target.set(0, 0, 0);
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
    renderer.render(scene, camera);
  });
  status.textContent = "";
}

try {
  main();
} catch (e) {
  const status = $("status");
  status.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
  status.classList.add("error");
}
