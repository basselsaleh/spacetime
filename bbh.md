# Binary black hole spacetime visualizer: project plan

Nov 12, 2026 · @Bassel · **Phase 5 (precession) in progress** (a record of the app as built, plus the next phase)

Other applications in this repository get their own planning documents; this one covers only the binary black hole app. Plans live on the `dev` branch (only these files, never merged into `main`), checked out as a `plans/` worktree inside the main clone: `git worktree add plans dev`.

## Status

**Phases 1 and 3 are done and public; Phase 5 (precessing spins) is in progress: step 7a done.** The original goal, visualizing gravitational waves away from the binary faithfully and beautifully, is met. Phase 5 replaces the waveform model so the spins can point in any direction and the orbit visibly precesses.

- Phase 1 (2D wave-zone app): merged, PR #1.
- Phase 3 (3D view with the ray-marched strain volume): merged, PR #2. The user reviewed the 3D view interactively and approved it.
- Phase 2 was cut. Phase 4 (the near zone) is **parked**: it may be attempted in the future (see "If this app is revisited").
- Phase 5 (precession, NRSur7dq4): planned Nov 14, 2026. Step 7a (offline prototype) done Nov 14 on `step-7a-precession-prototype` (commit `6e2276f`, local, not pushed); next is step 7b.

**Not verified by a person**

- Frame rate and the volume's adaptive resolution on hardware other than the user's (Apple M4), and the phone layout. The user chose to skip these checks.

**Branches.** All merged step branches have been deleted. `step-5b-shells` (the dropped spherical-shells experiment, never merged) is kept locally for reference.

**Decision log**

| Date | Decision | Why |
| --- | --- | --- |
| Nov 13 | 2D first; TypeScript + WebGL2 front end, Rust → wasm physics | The cost lives in the near zone, not in 2D vs 3D |
| Nov 13 | Waveforms from the **NRHybSur3dq8** surrogate, not IMRPhenomT | IMRPhenomT's coefficients are unpublished (supplementary Mathematica only); its only implementation is GPL, and this repo is MIT |
| Nov 13 | Remnant from **NRSur3dq8Remnant** | Same data record and license, same GPR format, NR-faithful |
| Nov 13 | Repo private; no GitHub Pages deployment | Private repo |
| Nov 14 | Preparing to go public: user-facing README with logo (`web/public/logo.svg`), dev details in `docs/development.md`, GitHub Pages deploy via Actions (`.github/workflows/pages.yml`), plans moved off `main` onto the plans-only `dev` branch | User wants a first public version; plans aren't user-facing but must sync across machines. Commit history keeps the personal email (user's choice). Every branch, `dev` included, is public once the repo is |
| Nov 14 | App shown as **"Gravitational waves"** (title, landing page, README); the URL stays `/bbh/` and code and this plan keep the `bbh` name | User wanted a friendlier name; chose to rename visible names only. Logo is an abstract gravity well (the user picked it from three candidates) |
| Nov 13 | One main view with an animated top ⇄ side swap, instead of two unequal views | User preferred a single view; the swap shows genuine intermediate slices |
| Nov 14 | Do 3D (Phase 3) **before** Phase 2, using three.js | Tendex and vortex lines are best built directly in 3D; vortex lines need it |
| Nov 13 | Spherical shells (stage 1b) dropped; the 3D view will be the tendex/vortex lines | A shell at fixed radius is perpendicular to the propagation direction everywhere, so it can't show waves moving (it shows each distance's received signal brightening and fading in place). h₊/h× on a sphere also have unavoidable pinwheels at the poles |
| Nov 13 | Stage 2 quadrupole: adiabatic I₂₂ = −h₂₂/ω₂₂² | Compared in the prototype: twice-integrating h₂₂ leaves a constant offset and a drifting phase; the PN orbit doesn't decay after merger; the adiabatic form is smooth through ringdown and within ~10% of the orbit estimate in the inspiral |
| Nov 13 | 3D view: ray-marched strain volume by default; tendex/vortex lines optional | User finds the lines hard to follow and expects the volume to replace them |
| Nov 13 | Volume sums the 3 strongest modes; table rows sorted by peak amplitude | Cost: on an M4, 3 modes at 550×407 take 8.5 ms, all 11 modes at that size 32 ms. The slices still use every mode |
| Nov 13 | **Tendex/vortex lines removed** (app code, Rust field and tracer, tests, golden data, prototype scripts) | User found them confusing and visually poor next to the volume, which is now the only 3D content |
| Nov 14 | Look retuned (branch `bbh-aesthetics`): Crameri **Berlin** color map, gentler x/√(1+x²) saturation, slate near-zone fill, rim + halo on horizons, small neutral ring for the probe, fainter 3D guides; gain fixed at 1.5 (slider removed) | Black horizons were lost against a black near zone, black zero-strain bands and a black page; the bright warm probe ball drew the eye and shared orange with h > 0. The user picked the settings with a temporary `?dev` panel comparing ten color maps (commit `117a614` has it) |
| Nov 13 | **BBH app finished for now; Phase 4 (near zone) parked** | The goal, waves away from the binary, is met; the near zone is the highest-risk work and may be revisited later. Future applications in this repo get their own plans |
| Nov 14 | **Phase 5: precessing spins via NRSur7dq4 (v1), replacing NRHybSur3dq8 completely** | NRHybSur3dq8 is aligned-spin only and can't be extended. Precession is more visually interesting for this app than a higher mass ratio, so the range drops from q ≤ 8 to q ≤ 4 (q ≤ 6 extrapolated) and the inspiral from ~10,000 M to 4300 M. One model, not two. v1 rather than NRSur7dq4v2 (arXiv:2609.07873: better ringdown, ℓ ≤ 5, 78 MB): smaller, validated longer; v2 is a possible follow-up |
| Nov 14 | Phase 5 display frame: **+z along J at the start of the data** (t ≈ −4300 M), L̂ there in the x–z plane | L̂ then sweeps a cone about a fixed axis. J uses the 2PN orbital angular momentum without spin terms; it only picks the axes. Check: the remnant spin comes out within ~2° of this axis |
| Nov 14 | Phase 5 spin reference: **the sliders set the spins at the start of the data** (t ≈ −4300 M), in the co-orbital frame there | gwsurrogate's default (fM_ref = 0): the ODE integrates forward only, avoiding the backward RK4/AB4 start. The loop starts at −2500 M, so the spins shown at the loop start have already precessed a little. Revisit if that confuses |
| Nov 14 | STSUR002 stores bases and polynomial coefficients as **f32**; times and the remnant as f64 | 4.24 MB instead of 6.94 MB; costs 1.3e-6 of peak in the modes and 8e-7 in the frame dynamics |
| Nov 13 | **Cut Phase 2 entirely**: no in-app NR validation overlay, no audio, no slice azimuth control. Phase numbers are kept as they were (1, 3, 4) | User doesn't want these features; validation stays as offline golden tests |

## Vision and goals

Build a real-time, interactive visualization of a binary black hole system and the gravitational waves it emits. It runs in the browser and stays as faithful to general relativity as real-time rendering allows.

- **Faithful where it counts.** Every visual element is driven by real GR physics or a known, documented approximation of it. Fudges are explicit and can be measured.
- **Beautiful and intuitive.** A viewer should grasp the inspiral, merger and ringdown at a glance, then be able to dig deeper.
- **Interactive.** Users control the mass ratio, spins, time scrubbing, probe points and overlays.
- **Shareable.** Opens from a link with no install, for outreach, teaching and talks.
- **Extensible.** Binary black holes are the first example. The architecture should generalize to other extreme spacetimes later; those applications are planned in their own documents.

## Core approach

Don't solve Einstein's equations in the browser. Play back and evaluate the results of people who already solved them.

- **Waveforms.** The app evaluates the **NRHybSur3dq8** numerical-relativity surrogate live (Varma et al. 2019). It is trained on NR simulations hybridized with PN/EOB inspirals and covers aligned spins with q ≤ 8 and |χ| ≤ 0.8.
- **Data file.** The Rust evaluator reads a trimmed data file (2.28 MB) cut offline from the public model (213 MB), keeping the last ~10,000 M. One evaluation takes about 1 ms in wasm.
- **Remnant.** Mass, spin and recoil kick come from the **NRSur3dq8Remnant** fits, which are embedded in the same file.
- **Approximations.** That strain is exact far from the source. Everything closer in (orbits, near-zone fields) is layered on with clearly documented approximations.

## What the app does

- **One main view.** A strain slice through the source: the orbital plane seen from above (tilt 0°), a side view through the orbital axis (90°), or any tilt in between.
  - "⇄" animates the tilt; a slider sets it directly.
  - h₊/h× toggle. Choosing h× in the orbital plane shows a blank field with a caption explaining the mirror symmetry.
- **Flat ⇄ 3D.** The flat view looks straight at the slice and matches the old 2D app. The 3D view is an orbit camera showing the strain volume (no slice), with the orbital axis and the outline of the orbital plane; the dolly zoom cross-fades the slice into the 3D content. Tilt and the top ⇄ side swap are flat-view controls; h₊/h× applies to both.
- **Strain volume (3D, on by default):** r·h₊ (or h×) ray-marched through a sphere (0.6 of the framed extent); density rises as tanh(|r·h|)⁸, so crests (orange) and troughs (blue) glow as sheets: for h₊ the two-armed spiral sheets, moving outward; the merger burst is an expanding shell. Near zone empty; an 8° cone around the axis faded (the h₊/h× basis is singular there). Three strongest modes; reduced resolution that adapts to the frame rate (0.3–1.0 of CSS pixels).
- **Black holes and the remnant** are horizon-sized spheres: solid where visible, a faint outline where hidden behind a slice. The remnant drifts with its recoil kick.
- **Probe** (warm sphere): click the slice (flat view) to place it. The side column shows:
  - a ring of free test particles deforming in the + and × patterns
  - h₊ and h× at the probe
  - a chirp plot of the signal received there, with a playhead
- **Controls:**
  - binary sliders (q, χ₁, χ₂) that regenerate everything live and update the URL
  - play/pause, scrubber, speed
  - loop (on by default). Playback ends once the merger burst leaves the visible area.
- **Display conventions** (labeled in the app): the color is r·h ÷ peak (2,2) value in the orbital plane × 1.5, saturated by x/√(1+x²), on the Crameri Berlin diverging map (blue < 0 < red, dark at zero). The near zone, where the far-zone formula is invalid, is filled with slate inside a faint ring. All look constants live in `look.ts`.
- **URL options** (the app is at `/bbh/`): `?q=&chi1=&chi2=`, `?t=`, `?zoom=`, `?tilt=` (degrees), `?3d`, `?paused`, `?selftest`, `?volbench` (GPU timing of the volume; needs real time, see Gotchas). Tuning: `?vdensity=` (default 0.035), `?vsharp=` (default 8).

## Physics layers

| Layer | Fidelity | Method | Main approximations | Status |
| --- | --- | --- | --- | --- |
| 1. Wave-zone strain | Essentially exact | Sum of spin-weighted spherical harmonic modes h\_lm at retarded time t − r, falling off as 1/r, evaluated per pixel in a fragment shader on slice planes | Valid only far from the source (near zone masked); shown as r·h, normalized | Done (Phase 1) |
| 2. Orbits and remnant | Very good | Orbital angle from the (2,2) phase; separation from 2PN r(ω); remnant from NRSur3dq8Remnant | PN breaks down in the last orbits (schematic there); spins ignored in r(ω) | Done (Phase 1) |
| 3. Near zone: lensing and horizons | Honest approximation | GPU ray marching of null geodesics through superposed boosted Kerr–Schild metrics or a PN near-zone metric | Metric frozen while each ray travels; merger shapes keyframed or faded | Parked (Phase 4) |
| 4. Validation | Reference | Offline golden tests against gwsurrogate, surfinBH and LAL | None | Tests in place; no in-app overlay (cut) |

The far-zone strain is a mode sum:

```latex
h_+ - i\,h_\times = \frac{1}{r}\sum_{\ell \ge 2}\sum_{m=-\ell}^{\ell} h_{\ell m}(t - r)\; {}_{-2}Y_{\ell m}(\theta, \phi)
```

The surrogate provides 11 modes with m ≥ 0: (2,2), (2,1), (2,0), (3,3), (3,2), (3,1), (3,0), (4,4), (4,3), (4,2), (5,5). The negative-m modes follow from h\_{l,−m} = (−1)^l h\*\_{lm}.

## Conventions (keep these consistent)

**Units and time**

- Geometric units with total mass M = 1; times and lengths are in M.
- t = 0 at the waveform peak.

**Frame**

- The surrogate's raw frame (gwsurrogate `do_not_align=True`): +z along the orbital angular momentum, and the heavier hole on +x at t = −1000 M.
- The orbit is counter-clockwise seen from +z.

**Mode representation**

- The (2,2) mode is h₂₂ = A₂₂ e^{−iφ₂₂}; φ₂₂ increases with time.
- Every other mode is stored in the co-orbital frame, H\_lm = h\_lm e^{i m φ₂₂/2}.

**Polarization: the LAL convention.** It has the overall sign of h flipped relative to Blanchet/Kidder.

- In the orbital plane, h₊ = ½(h\_φφ − h\_θθ): h₊ > 0 means space is stretched around the circle centered on the source and squeezed perpendicular to the plane.
- h₊ is largest along the binary axis at the retarded time.
- This was verified against LAL's PN modes in both conventions (step 3); don't "fix" it.

**Harmonics.** ₋₂Y\_lm follow LAL's `XLALSpinWeightedSphericalHarmonic` (tested to 1e-12).

**Orbits.** The heavier hole's angle is Φ(t) = (φ₂₂(t) − φ₂₂(−1000 M))/2. PN tail terms leave a ~0.15 rad ambiguity between orbital phase and wave phase.

**Retarded time** is plain t − r, not the tortoise coordinate. The difference is a slowly growing delay of ~8–12 M; see the open questions.

**Near-zone radius** at source time t is max(1/ω₂₂, 2 (2/ω₂₂)^{2/3}), with ω₂₂ held at its peak value after the merger.

## Platform and stack

Browser only.

- **Physics core: Rust → WebAssembly.**
  - `crates/physics` is pure Rust (f64, no GPU or web dependencies), tested with `cargo test`.
  - `crates/wasm` is a thin wasm-bindgen layer with no logic of its own, built with `wasm-pack`.
- **Front end: TypeScript + Vite.** Handles the UI, the probe and chirp plot (Canvas 2D), and the orientation sketch.
- **Rendering: WebGL2 via three.js r181.** Custom `RawShaderMaterial`s evaluate the strain per pixel on the slice plane and ray-march it through the volume; holes and the probe are spheres. WebGPU was not needed.
- **Data flow.**
  - When parameters change, Rust evaluates the surrogate once (about 1 ms) and packs a mode table. That's an RG32F texture, 2048 texels wide (WebGL2's guaranteed minimum): row 0 holds (A₂₂, φ₂₂ mod 4π), the other rows (Re H, Im H).
  - A second RG32F texture holds the θ-dependence of the harmonics (1025 samples, so θ = π/2 is exact).
  - Each frame the shader only does texelFetch lookups, hand interpolation and the mode sum.
- **Offline pipeline: Python, managed with `uv`.**
  - gwsurrogate and surfinBH export the trimmed model and generate golden data.
  - lalsuite provides harmonic and PN-orientation references.

## Codebase map

```
crates/physics/src/
  surrogate/        NRHybSur3dq8 + remnant evaluator: STSUR001 file format (format.rs), GPR node fits,
                    EI basis, TaylorT3 phase, splines, co-orbital → inertial (mod.rs)
  spline.rs         Natural cubic spline (matches gwsurrogate's boundary conditions)
  harmonics.rs      Spin-weighted spherical harmonics (Goldberg sum, LAL convention)
  mode_table.rs     GPU packing of a waveform; CPU reference of the shader (`strain`), harmonic θ table,
                    per-direction strain series for the probe
  binary.rs         Black-hole positions, horizon radii, merger cross-fade, kick
  newtonian.rs      Newtonian placeholder relations (step 0 leftovers)
crates/physics/tests/
  surrogate_golden.rs  modes vs gwsurrogate (tolerance 1e-6 of peak; observed 1.8e-7)
  strain.rs            harmonics vs LAL, h× = 0 in the plane, table vs exact sum, θ table, probe series
  binary.rs            remnant vs surfinBH, wave/orbit retarded lag, heavier-hole angle vs LAL PN
crates/wasm/src/lib.rs WaveformModel, WaveformData, ModeTableData, BinaryTrack bindings
web/bbh/index.html  The app's page (the site is multi-page; web/index.html is the landing page)
web/src/common/     Shared with other apps: rays.ts (rayMatrix), reducedPass.ts (adaptive reduced-resolution
                    full-screen pass + composite), theme.css
web/src/bbh/
  main.ts           Wiring: load model, scene, view panel, playback loop, URL handling
  scene3d.ts        three.js scene: slice plane, volume pass, spheres (solid + ghost pass), guides,
                    camera poses, flat ⇄ 3D dolly zoom, ray-cast picking, raw render for the self-test
  shaders/strain.glsl  Shared GLSL: mode table, mode sum (`strain`, `strainRows`), color map (LUT), angles
  look.ts           Look constants, the Berlin color map (OKLab-interpolated LUT for the shaders), legend
  shaders/slice.*   Slice shader (near-zone ring, exact pixel mapping) on plane meshes
  shaders/volume.frag  Volume ray march (front-to-back, premultiplied alpha)
  volume.ts         Volume shader uniforms and camera, on common/reducedPass.ts; raw self-test path
  slice.ts          Slice geometry: tilt/azimuth axes, slice ⇄ 3D ⇄ pixel conversions, shared types
  waveform.ts       Evaluate + pack a waveform for the views; near-zone radius; URL params
  probe.ts          Test-particle ring and chirp plot (Canvas 2D)
  controls.ts       Playback, flat-view pan/zoom/click, parameter sliders
  gizmo.ts          Orientation sketch shown in the flat view
  selftest.ts       ?selftest: GPU vs the Rust CPU reference over 6 slice frames and 2 volume frames
                    (strain at each ray's closest approach); ?volbench timings
web/public/nrhybsur3dq8.stsur   Trimmed surrogate + remnant fits (committed, 2.28 MB)
tools/              uv project: export_surrogate.py, gen_golden.py, gen_remnant_golden.py,
                    gen_harmonics_golden.py, gen_orientation_golden.py; data/ (gitignored downloads)
tests/golden/       Golden data used by the Rust tests (committed)
```

## Working conventions

**Git**

- One branch per roadmap step, created from the previous step's branch (or from `main` after a merge), e.g. `step-5-3d-scene`. Never commit a new step onto an earlier step's branch.
- Commit locally; push and open PRs only when the user asks. Never rewrite a pushed branch without asking.
- PRs go to `main` per phase or milestone; use a merge commit, not squash, to keep one commit per step.
- Repo-local git identity is the user's personal account. The remote uses the SSH host alias `github-personal`; the active `gh` account is the personal one. Don't use the user's global (work) identity.
- CI (`.github/workflows/ci.yml`) runs `cargo fmt --check`, `clippy -D warnings`, `cargo test`, the wasm build and `npm run build`. `.github/workflows/pages.yml` deploys `web/dist` to GitHub Pages on every push to `main`.

**Python**

- Only uv-managed CPython (`python-preference = "only-managed"`, 3.12). Never anaconda or pyenv.
- The user's shell exports a pyenv `VIRTUAL_ENV`, so run `env -u VIRTUAL_ENV uv run python …` in `tools/`.

**Everyday commands**

```sh
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
cd web && npm install && npm run dev        # dev server (rebuilds wasm at start only)
cd web && npm run build                     # wasm + typecheck + bundle into web/dist
```

**GPU self-test and screenshots (headless Chrome on macOS)**

```sh
cd web && npx vite preview --port 4173 &
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --use-angle=metal --enable-gpu --ignore-gpu-blocklist \
  --virtual-time-budget=8000 --dump-dom "http://localhost:4173/bbh/?selftest" | grep -o "<title>[^<]*</title>"
"$CHROME" --headless=new --use-angle=metal --enable-gpu --ignore-gpu-blocklist --window-size=1440,900 \
  --virtual-time-budget=12000 --screenshot=out.png "http://localhost:4173/bbh/?paused&t=-400&3d"
```

- The self-test must pass (tolerance 2e-3 of peak; currently 4.4e-4 on Metal).
- Use `--use-angle=metal` for the real GPU; SwiftShader's float arithmetic is less accurate (~1.2e-3).

**Regenerating data** (only if the format or the model changes): see docs/development.md. The downloads are 213 MB and 0.45 MB from Zenodo.

## Gotchas (learned the hard way)

**Rendering**

- **`atan(y, 0)` on ANGLE/Metal is wrong.** The shader takes θ = π/2 directly when z == 0. Keep that branch.
- **Rasterizer snapping.** Vertices snap to 1/256 px, so interpolated world positions are off by ~0.05 M in small images. Wherever the camera looks straight at a slice (flat view, self-test), the shader maps pixels to slice coordinates exactly (`u_screenMapped`).
- **GPU trig at large arguments.** φ₂₂ is stored mod 4π, which is exact because every e^{−imφ₂₂/2} has period 4π. The half-phase is reduced to [−π, π) before cos/sin.
- **RG32F is not filterable in WebGL2.** Always use texelFetch and interpolate by hand.

**Headless Chrome**

- `requestAnimationFrame` timestamps lag `performance.now()` under `--virtual-time-budget`. Animations must use a single clock (`performance.now()`).
- Chrome windows have a ~500 px minimum width, so screenshots narrower than that are cropped, not reflowed.
- `--virtual-time-budget` freezes `performance.now()` during synchronous work, so timings read 0. For `?volbench`, run Chrome headless in real time with `--remote-debugging-port=9333 --user-data-dir=<tmp>` and poll `curl -s localhost:9333/json` for the page title.

**Physics and data**

- **Polarization sign:** the LAL convention (see Conventions). Textbook (Blanchet/Kidder) formulas have the opposite sign of h.
- **gwsurrogate 1.2.0's C spline is wrong in the last knot interval.** Its interval search (`hunt` in `_spline_interp.cpp`) caps the upper bound at interval n − 2, so points between the last two knots are evaluated with the previous interval's cubic, extrapolated. For NRSur7dq4 resampled to a uniform grid, that affects t ∈ (99.8, 100] M, the faint ringdown tail (errors up to 1e-5 of peak). Our natural spline is correct. Golden data uses the model's own time grid to avoid it. Not yet reported upstream.
- **Spline joins:** the surrogate's time grid jumps from sparse (~65 M) to dense (0.1 M) at about −1000 M. The exporter keeps the original dense samples for 10 M past that join before coarsening to 1 M. Without that, the error near the join was 15× larger.
- **References:** only cite references you have verified. Several in this file are from memory and marked as such.

## Roadmap

**Phase 1: 2D wave-zone app. Done; merged to `main` (PR #1, Nov 14, 2026).**

- **Step 0: Scaffold.** Cargo workspace (physics + wasm crates), Vite + TypeScript app, uv tools project, CI.
- **Step 1: Waveform engine.**
  - NRHybSur3dq8 evaluator in Rust; `Surrogate::evaluate(Params, t_start, dt) -> Waveform`.
  - Matches gwsurrogate to 1.8e-7 of peak over 7 parameter sets.
  - The exporter trims the model to t ≥ −10,244 M and resamples the dense merger region to 1 M.
- **Step 2: Orbital-plane strain view.**
  - Mode table texture and a mode-sum fragment shader with the near-zone fade.
  - `?selftest` compares GPU pixels with the Rust CPU reference.
- **Step 3: Orbits and remnant.**
  - Remnant from NRSur3dq8Remnant, matching surfinBH to 1e-10.
  - Orbits derived from φ₂₂.
  - Found and documented the LAL polarization convention. Tests: wave arms trail the binary at the retarded time (0.01 rad); the heavier hole sits where LAL PN puts it, compared modulo 2π.
- **Step 4: Side slice, probe, chirp plot, live parameter sliders.**
- **Step 4b: Single main view with an animated top ⇄ side tilt.**
  - Every intermediate tilt is a genuine slice.
  - h₊/h× everywhere.
  - Playback ends when the burst leaves the view, and loops.

**Phase 2: depth without new risk. Cut** (see the decision log).

**Phase 3: 3D. Done; merged to `main` (PR #2).**

- **Stage 1: 3D scene with the strain slices placed in space.**
  - three.js r181; one perspective camera for both modes. Flat = 1° field of view, looking straight at the slice; 3D = 40° orbit camera with +z up.
  - Switching is a 1.6 s dolly zoom: logarithmic field-of-view interpolation, quaternion slerp, distance chosen to keep the slice framed.
  - Self-test unchanged from step 4b (worst 4.4e-4).
  - Bundle: 542 KB JavaScript (141 KB gzipped).
- **Stage 1b: strain on spherical shells.** Built Nov 13, 2026, then dropped (see the decision log). Kept unmerged on `step-5b-shells`. Reusable from it if needed: exact per-pixel ray–sphere intersection in the strain shader, and rays built from the camera basis (`u_rayBasis`) to avoid rasterizer snapping and float32 unprojection error.
- **Stage 2: tendex and vortex lines.** Built Nov 13, 2026 (offline sympy prototype, Rust field and tracer, 3D lines), then removed at the user's request (see the decision log). Recoverable from commits `ee8d1ae` and `d870223` on `step-6-tendex` if ever wanted.
- **Stage 3: volume view.** In WebGL2; the 3D view's only content.
  - Fragment-shader ray march of the strain through a sphere, at reduced resolution into a half-float target, upsampled and composited with premultiplied alpha over the scene. Per-pixel jitter (interleaved gradient noise, shifted each frame) hides banding.
  - Rays come from the camera basis (`rayMatrix`), relative to each ray's closest approach to the source, for float32 accuracy.
  - The strain code is shared with the slices (`shaders/strain.glsl`). Self-test: the strain at each ray's closest approach matches the CPU reference (3e-5 and 3e-4 of peak); slices unchanged at 4.4e-4.
  - GPU cost on an Apple M4 (`?volbench`, 128 steps): 3 modes 550×407 8.5 ms, 825×610 18.8 ms, 1100×813 31 ms; (2,2) alone at 825×610 8.8 ms.

**Phase 5: precessing spins. Planned** (not started; branches start from `main`).

Goal: spins in any direction, so the orbital plane and the wave pattern visibly precess. NRSur7dq4 replaces NRHybSur3dq8 completely (see the decision log).

*The model.* NRSur7dq4 (Varma et al., arXiv:1905.09300): an NR surrogate for precessing binaries, trained on q ≤ 4 and |χ₁|, |χ₂| ≤ 0.8 in any direction (gwsurrogate accepts q ≤ 6 and |χ| ≤ 1 as extrapolation). All 21 modes with ℓ ≤ 4, starting at t = −4300 M (~20 orbits). Data: `NRSur7dq4.h5`, 17.5 MB, Zenodo record 3348115 (the same CC BY 4.0 catalog as today's data), MD5 `8e033ba4e4da1534b3738ae51549fb98`. Three parts:

1. Dynamics: an ODE for the coprecessing-frame quaternion, the orbital phase and both spin vectors, on a fixed time-node grid; AB4 with an RK4 start (gwsurrogate `DynamicsSurrogate`).
2. Co-orbital waveform: empirical-interpolation basis × fits at nodes, much like the current evaluator.
3. Rotation to the inertial frame with Wigner-D matrices.

Fits are forward-stepwise polynomial basis functions (`bfOrders`, `coefs`; C kernel `eval_fit` in gwsurrogate's `precessing_utils.c`), not GPR. Fit inputs: [ln q, χ₁x, χ₁y, χ̂, χ₂x, χ₂y, χₐ], in the co-orbital frame at each node.

*Measured with gwsurrogate 1.2.0 (Nov 14, 2026):*

- One evaluation takes 3–4 ms in Python with the C extension, so live sliders stay feasible.
- Precession is clearly visible. L̂'s cone half-angle and the number of precession cycles between −2500 M (the loop start) and merger:

| Binary | Cone half-angle | Cycles |
| --- | --- | --- |
| q = 1, χ₁ = 0.8 in-plane | ~11° | 1.3 |
| q = 2, χ₁ = 0.8 in-plane | ~22° | 1.1 |
| q = 3, generic spins | ~20° | 1.15 |
| q = 4, χ₁ = 0.8 in-plane | ~36° | 0.8 |

*Steps* (each on its own branch):

- **Step 7a: offline prototype. Done** (Nov 14, branch `step-7a-precession-prototype`).
  - `tools/export_nrsur7dq4.py` writes STSUR002 (4.24 MB, 3.46 MB gzipped): a JSON header, then a u32 section (each fit term's 7 basis-function orders packed base 4), an f32 section (bases, coefficients) and an f64 section (times, remnant). The remnant GPR fits keep only training points and weights: each fit's 18.7 MB Cholesky factor `L_` is used only for error estimates. The remnant goes from 131.6 MB to 0.7 MB.
  - `tools/nrsur7dq4_ref.py`: plain-NumPy reader and evaluator of that file, **the spec for step 7b**. It covers the dynamics (3 RK4 steps over the half-nodes, then AB4, renormalizing the quaternion and spin magnitudes each step), the co-orbital modes, the Wigner-D rotation (gwsurrogate's formula with its two degenerate cases) and the remnant.
  - `tools/compare_nrsur7dq4.py`: against gwsurrogate and surfinBH over 7 binaries, 3 with a non-trivial initial frame. Modes are within 1.1e-6 of the peak |h₂₂|, the dynamics within 8e-7, and the remnant within 1e-12. With an f64 export the modes agree to 6e-14, so the f32 storage accounts for all of the difference.
  - `tools/proto_precession.py`: renders the J-frame slices, an L̂/spin plot and animations into `tools/out/`. Precession reads clearly: the top-view spiral turns lopsided and its bright side swings around, and the side view's up/down asymmetry flips. For q = 4, χ_A = 0.8 in-plane, L̂ stays 35–41° from J and goes 0.87 of the way around in the loop.
  - `tests/golden/nrsur7dq4.json` (0.81 MB), from `tools/gen_golden_nrsur7dq4.py`. It holds the raw dynamics on the 230 full nodes, 8 modes on every 10th sample of t_coorb, and the remnant at the co-orbital spins of the node nearest −100 M (how the app evaluates it; that's how surfinBH evolves spins itself).
- **Step 7b: Rust evaluator.**
  - Dynamics ODE, co-orbital surrogate and Wigner-D rotation, plus the NRSur7dq4Remnant fits.
  - Golden tests against gwsurrogate and surfinBH, at the current tolerances.
  - Remove the NRHybSur3dq8 evaluator, data and golden tests.
- **Step 7c: mode table and shaders.**
  - All 21 modes; drop the h\_{l,−m} = (−1)^l h\*\_{lm} symmetry (it fails with precession) and raise `MAX_ROWS`.
  - Rotate to inertial modes on the CPU, then keep the co-orbital storage trick: divide by a common orbital phase. Precession is slow, so the rows stay smooth at 1 M sampling.
  - Slices sum every mode, so they cost roughly twice as much; measure. The volume keeps its 3 strongest modes.
  - Self-test unchanged in method.
- **Step 7d: orbits and spins in the scene.**
  - Hole positions from the dynamics' orbital frame and phase, replacing the φ₂₂ heuristics in `binary.rs`; the separation is still from PN.
  - Spin arrows on each hole, precessing.
  - Remnant spin direction and 3D kick.
  - The near-zone radius from the orbital frequency.
- **Step 7e: controls and URL.**
  - Each spin as magnitude, tilt and azimuth, at a stated reference time or frequency.
  - q ≤ 4, |χ| ≤ 0.8 (decide whether to expose the extrapolated range).
  - New URL parameters; old `?chi1=&chi2=` links read as aligned spins.
  - Handle zooming out past the start of the data (it begins at −4300 M, so the waves in a wide frame run out).
  - Update the README and credits (NRSur7dq4 and its remnant fits replace NRHybSur3dq8 and NRSur3dq8Remnant).

**Phase 4: near zone. Parked** (not started).

- Ray-traced black hole shadows and lensing through an approximate two-black-hole metric.
- Horizon shapes during merger.

## If this app is revisited

Phase 5 (precessing spins) is next; see the roadmap. Beyond it, a future return would most likely pick up:

- **Phase 4, starting small.** Ray-trace the single remnant (Kerr) black hole after merger first: exact, contained, and it builds the ray tracer and sets the precision and speed budget. Then the two-hole metric before merger, prototyped offline against NR first (see the open questions).
- **Volume polish.** Temporal accumulation for higher resolution, depth cues, or |h| instead of h₊.
- **The unverified checks** under Status.

## Open questions, risks and references

**Open questions** (the unchecked ones are parked with Phase 4)

- [x] Waveform source: NRHybSur3dq8 (see the decision log).
- [x] Remnant: NRSur3dq8Remnant.
- [x] Parameter range: aligned spins only, q ≤ 8, |χ| ≤ 0.8 (the surrogate's trained range; the evaluator refuses values outside it). **Superseded by Phase 5:** precessing spins, q ≤ 4, |χ| ≤ 0.8.
- [x] Precession model (Phase 5): NRSur7dq4 v1, replacing NRHybSur3dq8 (see the decision log).
- [x] Remnant data (Phase 5): trimmed to 0.7 MB by dropping the GPR error-estimate data (step 7a).
- [x] Display frame (Phase 5): +z along the initial J (see the decision log).
- [x] Spin reference (Phase 5): spins set at the start of the data, t ≈ −4300 M (see the decision log).
- [x] 2D or 3D: 2D first, then 3D.
- [ ] Retarded time: plain t − r or the tortoise coordinate r\*? The difference, 2M ln(r/2M − 1), is a slowly growing delay (~8 M at r = 100 M, ~12 M at 1000 M) that shifts the pattern relative to the holes. Revisit with the near zone.
- [ ] Near-zone metric (Phase 4): superposed boosted Kerr–Schild or PN? Prototype both and compare against NR.
- [ ] Merger-phase horizons (Phase 4): keyframed NR shapes or a fade to the remnant?

**Risks**

- **Waveform accuracy.** Mitigated: golden tests against gwsurrogate.
- **Data licensing.** The surrogate and remnant data are CC BY 4.0. The attribution string travels inside the data file and is shown in the app. The code is MIT.
- **Phase conventions.** Mitigated by the step 3 tests, which caught the Blanchet-vs-LAL polarization sign.
- **Phase 4 (parked):** stitching the near zone to the wave zone, 32-bit precision for light paths that skim a horizon, and ray-tracing performance on mid-range GPUs.

**References**

Verified:

- Varma et al., "Surrogate model of hybridized numerical relativity binary black hole waveforms", Phys. Rev. D 99, 064045 (2019), arXiv:1812.07865 (journal and arXiv numbers verified against gwsurrogate). Data: doi:10.5281/zenodo.3348115 (record 3348115), CC BY 4.0.
- NRSur3dq8Remnant: Varma et al., arXiv:1809.09125 (verified against surfinBH). Data: Zenodo record 1435751, CC BY 4.0.
- NRSur7dq4 and NRSur7dq4Remnant: Varma et al., Phys. Rev. Research 1, 033015 (2019), arXiv:1905.09300 (verified against gwsurrogate's and surfinBH's catalogs). Data: Zenodo records 3348115 (waveform) and 3455886 (remnant), CC BY 4.0 (license checked on Zenodo).

From memory, to verify before citing:

- Bohn et al., "What does a binary black hole merger look like?" (2015), the reference for ray-traced merger imagery
- Blanchet, Living Rev. Rel. 17, 2 (2014), PN relations (used for the 2PN r(ω))
