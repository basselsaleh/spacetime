# Black hole lensing app: plan

Nov 13, 2026 · @Bassel · **steps 0 and 1 done**, merged to `main` (PR #3). Step 2 is next.

A second app in this repository, alongside the binary black hole (BBH) wave visualizer ([bbh.md](bbh.md)).

## Goal

A 3D scene with distant stars, galaxies and other light sources in the background and a black hole in front of them. The user orbits the camera around the hole and watches how light from behind it is bent:

- the shadow
- the Einstein ring when a source lines up behind the hole
- secondary and higher-order images
- the photon ring
- the whole sky distorting as the camera moves

As with the BBH app: faithful to general relativity, beautiful, interactive, and opens from a link.

## Approach: exact ray tracing

Every pixel's light ray is traced **backwards** from the camera as a null geodesic of the black hole spacetime, until it either:

- **crosses the horizon:** the pixel is black (the shadow), or
- **escapes to large radius:** the pixel takes the color of the background sky in the ray's final direction.

This needs no thin-lens or weak-field approximation. The only approximations are:

- numerical integration of each ray
- background sources treated as infinitely far away
- the camera being a static observer (stage 1; see open questions)

All the lensing features listed under Goal fall out of this one calculation.

### Stage 1 physics: Schwarzschild (no spin)

Light around a non-spinning hole stays in the plane containing the hole, the camera and the initial ray. Each ray reduces to the orbit equation

```
d²u/dφ² = 3Mu² − u,    u = 1/r
```

- **Initial conditions.** The pixel's direction makes an angle ψ with the outward radial direction in the camera's local frame. For a static observer at radius r₀, the impact parameter is b = r₀ sin ψ / √(1 − 2M/r₀). Then u = 1/r₀ and du/dφ = −u √(1 − 2M/r₀) cot ψ (the square-root factor was missing from the first draft of this plan).
- **Termination.** The ray escapes when u ≤ 0, and is captured when u ≥ 1/(2M).
- **Final direction.** The ray's direction at infinity is the initial direction rotated within its plane by the accumulated φ. It's looked up on the sky.
- **Step control.** Steps in φ shrink near the photon sphere (r = 3M), where rays can wind around several times. A step cap ends the rare rays that never resolve; those pixels are drawn as part of the photon ring.

Known results that become tests:

- horizon at 2M, photon sphere at 3M, critical impact parameter b_c = 3√3 M
- weak-field deflection 4M/b
- exact deflection angle, from the standard integral (computed independently in Rust)
- shadow angular radius seen by a static observer at r₀: sin α = (b_c / r₀) √(1 − 2M/r₀)

### Stage 3 physics: Kerr (spin)

A spinning hole has no planar reduction.

- **Integration.** The shader integrates the full null geodesic equations. The likely formulation is Hamiltonian in Boyer–Lindquist or Kerr–Schild coordinates, using the constants of motion (energy, angular momentum about the axis, Carter constant).
- **Camera.** It becomes a zero-angular-momentum observer.
- **New visuals.** The shadow becomes asymmetric (D-shaped at high spin), and frame dragging skews the lensed sky.
- **Tests:**
  - spin → 0 reproduces Schwarzschild
  - the shadow outline matches the analytic critical curve from spherical photon orbits (Bardeen; from memory, to verify)
  - the constants of motion are conserved along each ray

### The sky

The background is a "celestial sphere" at infinity, sampled by direction:

- **Procedural first.** A starfield with a range of brightnesses and colors, plus a few galaxy-like smudges and nebula-like glows. It is generated in the shader or baked into a cube map. Free, sharp at any zoom, and no licensing questions.
- **Reference grid** (optional). A latitude–longitude grid that makes the distortion easy to read; good for teaching.
- **Real all-sky star map** (optional, later). Only after checking its license, as was done for the surrogate data.

**Aliasing is the main rendering risk.** Near the photon ring, a single pixel's ray bundle covers a huge patch of sky, so point-like stars sparkle and flicker. Mitigations, in order:

1. supersampling near the ring
2. ray differentials (track the bundle's spread and blur the sky lookup to match)
3. temporal accumulation

## How it fits in the repository

Turn `web/` into a multi-page Vite site with two apps sharing common code. Rust stays one physics crate and one wasm crate.

```
plans/
  bbh.md, lensing.md          one plan per app
crates/physics/src/
  (BBH modules unchanged)
  geodesic.rs                 Schwarzschild null geodesics: reference integrator, deflection, shadow
  kerr.rs                     stage 3
crates/physics/tests/
  geodesic.rs                 analytic limits and exact-deflection checks
crates/wasm/src/lib.rs        BBH bindings + lensing references for the GPU self-test
web/
  index.html                  landing page linking both apps
  bbh/index.html              the BBH app (moved from web/index.html)
  lensing/index.html          the lensing app
  src/common/                 shared: rayMatrix, adaptive reduced-resolution pass, orbit camera,
                              panel styles, self-test harness
  src/bbh/                    the current web/src files, moved
  src/lensing/                main.ts (page, orbit camera, sliders), lens.ts (pass), selftest.ts,
                              shaders/lens.frag (ray tracer), shaders/sky.glsl (procedural sky)
  vite.config.ts              multi-page build inputs
```

- **One npm project, one build, one CI job.** CI needs no changes beyond what the build already does.
- **What's reused.** The lensing renderer is structurally the BBH volume pass with a different shader: full-screen ray per pixel built from the camera basis (accurate in float32), reduced resolution adapted to frame rate, and compositing.
- **Rust's role.** CPU reference geodesics for the tests and the GPU self-test, as the mode-table reference does for the BBH shaders. The browser may need no wasm for lensing in stage 1 except in the self-test.
- **BBH URLs move** from `/` to `/bbh/` (for example `/bbh/?q=3&3d`). The repo is private and not deployed, so nothing external breaks.

## Stages

### Step 0: repository reorganization (done)

- Multi-page Vite config (`web/vite.config.ts`), landing page (`web/index.html`), BBH moved under `web/bbh/` and `web/src/bbh/`, and a placeholder `web/lensing/index.html`.
- Shared code in `web/src/common/`: `rays.ts` (`rayMatrix`), `reducedPass.ts` (the adaptive reduced-resolution full-screen pass and composite, extracted from the BBH volume) and `theme.css`.
- Deferred to step 1, when there's a second user: an orbit-camera helper and a generic self-test harness.
- The BBH data file stays in `web/public/` (the Rust tests read it there). The page fetches it relative to itself (`../nrhybsur3dq8.stsur`), so the build works at any URL prefix.
- README and `plans/bbh.md` paths updated.
- **Result:** the BBH app behaves exactly as before. Its self-test passes with unchanged numbers (worst 4.4e-4) in both the production build and the dev server.

The `web/src/common/` entry in the repository layout above lists only what exists so far.

### Step 1: Schwarzschild lensing of a procedural sky

- `geodesic.rs` reference integrator with tests (the analytic limits above).
- Lensing fragment shader in the shared reduced-resolution pass. Procedural sky. Orbit camera with camera distance (in M) as an explicit control.
- **GPU self-test:** a raw mode where the shader outputs each pixel's escape direction (or a capture flag), compared with the Rust reference per pixel.
- Performance measured like the BBH `?volbench`.

**Done (Nov 13, 2026).**

- **Rust reference** (`crates/physics/src/geodesic.rs`): two independent methods.
  - `sweep_quadrature`: the integral of du/√f. The turning-point singularity is removed with u = u₁ − w², which is exact because f is cubic. On the observer side the limit comes from f(u₀), known exactly, not from u₁ − u₀: for a tangential ray that difference loses all precision (it caused a 7e-8 error before the fix).
  - `sweep_ode`: RK4 on the second-order equation, with a Hermite-interpolated escape point, as the shader does.
- **Rust tests** (`crates/physics/tests/geodesic.rs`):
  - the two methods agree to 1e-11 over r₀ = 3.5–100 M
  - weak-field deflection 4/b + 15π/(4b²) to 1e-4 relative at b = 10³–10⁴
  - capture exactly at b_c, at the shadow-edge angle
  - winding grows as b → b_c
  - escape directions stay in the ray's plane and bend toward the hole
- **Shader** (`web/src/lensing/shaders/lens.frag`): RK4 in φ with step min(0.02, ½u/|du/dφ|), floored at 0.002 for near-radial rays. Rays inside the shadow are rejected analytically, and rays still unresolved after 1000 steps (the photon ring) are drawn black.
- **Procedural sky** (`sky.glsl`), evaluated per pixel with no texture:
  - three star layers on a seamless 3D grid; stars are widened to at least ~1 pixel with their brightness preserved
  - a galactic band with dust lanes, and faint nebulae
  - three galaxies, one directly behind the hole as seen from the default camera, so the Einstein ring shows on load
- **App** (`/lensing/`): orbit camera around the hole, a distance slider (logarithmic, 3.5–300 M, kept in sync with scroll-zoom), a field-of-view slider (20–140°: close in the shadow covers most of the sky) and a shadow-radius readout. URL options: `?r=`, `?fov=`, `?selftest`, `?lensbench`.
- **GPU self-test** (`?selftest`): the escape direction of every pixel in 4 views (default, close, just outside the photon sphere looking sideways, far and narrow) vs the Rust quadrature. Worst error 3.3e-5 rad over 9750 rays. Rays within 2% of b_c are skipped (490), and capture/escape must agree everywhere else. The Rust reference loads via wasm only on the self-test page.
- **Checks against known results in the image:** at 60 M the Einstein ring of the galaxy behind the hole sits at 15.3°, against √(4M/r) = 14.8°. The shadow-radius readout uses the exact formula.
- **Performance** (Apple M4, `?lensbench`): 720×407 3.7 ms, 1440×813 11.2 ms, 2880×1626 (full retina) 38.9 ms. The pass adapts between 0.35× and the device-pixel ratio.

### Step 2: sky and teaching aids

- Reference grid option, and a lensed ⇄ unlensed toggle.
- Overlays: shadow outline, photon ring, Einstein-ring radius for a chosen source.
- Anti-aliasing near the photon ring.
- Possibly a real star map (license permitting).

### Step 3: Kerr

- Spin slider, full geodesic integration, zero-angular-momentum observer, Kerr reference integrator and tests.

### Maybe later

- Thin accretion disk with gravitational redshift and Doppler beaming. Not requested, but it's natural once rays are traced.
- A moving camera (orbiting or falling in), with aberration.
- Lensing combined with the BBH app (for example the remnant black hole).

## Conventions

- Geometric units, G = c = 1, with the black hole mass M = 1: lengths and distances are in M. A physical mass only rescales the scene, so the mass control can be cosmetic (a label in km or solar radii).
- The spin axis (for Kerr) is +z, matching the BBH app's orbital axis.
- Sky directions are fixed in the black hole's rest frame. The camera moves; the sky does not.

## Risks

- **Aliasing near the photon ring** (see The sky).
- **Precision.** Rays that skim the photon sphere are sensitive to float32 error. Small errors there only reorder which sky point a winding ray lands on. That is visually harmless, but it limits the GPU-vs-CPU tolerance near b_c, so the self-test should exclude a thin band around it, as the BBH self-test does at boundaries.
- **Kerr cost.** Full geodesics may need several hundred steps per pixel. Budget it with the shared adaptive resolution, and fall back to fewer steps far from the hole.

## Open questions

- [x] Camera model for stage 1: a static observer at 3.5–300 M (outside the photon sphere, so the planar escape logic holds). An orbiting or falling camera remains a "maybe later".
- [ ] Sky: procedural only, or also a real star map? Which one, and under what license?
- [x] Integration variable and step control for the GPU, Schwarzschild: RK4 in φ, step min(0.02, ½u/|du/dφ|) ≥ 0.002; 3.3e-5 rad worst against the reference.
- [ ] Kerr formulation: Boyer–Lindquist (singular at the horizon, fine for rays that stop there) or Kerr–Schild (regular)? Prototype both.
- [ ] Should the lensing app and the BBH app share one URL-parameter and panel style, or diverge?

## References

From memory, to verify before citing:

- Luminet, "Image of a spherical black hole with thin accretion disk", A&A 75, 228 (1979): the classic ray-traced Schwarzschild image.
- Bardeen (1973), the Kerr shadow ("Timelike and null geodesics in the Kerr metric").
- James, von Tunzelmann, Franklin & Thorne, "Gravitational lensing by spinning black holes in astrophysics, and in the movie Interstellar", Class. Quantum Grav. 32, 065001 (2015): camera model, ray bundles and anti-aliasing near the photon ring.
- Chandrasekhar, *The Mathematical Theory of Black Holes* (1983): geodesics in Schwarzschild and Kerr.
