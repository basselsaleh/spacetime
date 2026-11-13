# Binary black hole spacetime visualizer: project plan

Nov 12, 2026 · @Bassel · revised Nov 13, 2026 (2D-first)

## Vision and goals

Build a real-time, interactive visualization of a binary black hole system and the gravitational waves it emits. It runs in the browser and stays as faithful to general relativity as real-time rendering allows.

- **Faithful where it counts.** Every visual element is driven by real GR physics or a known, documented approximation of it. Fudges are explicit and can be measured.
- **Beautiful and intuitive.** A viewer should grasp the inspiral, merger and ringdown at a glance, then be able to dig deeper.
- **Interactive.** Users control the mass ratio, spins, time scrubbing, probe points and overlays.
- **Shareable.** Opens from a link with no install, for outreach, teaching and talks.
- **Extensible.** Binary black holes are the first example. The architecture should generalize to other extreme spacetimes later.

## Core approach

Don't solve Einstein's equations in the browser. Play back and evaluate the results of people who already solved them.

A full numerical-relativity merger takes thousands of CPU hours, but its outputs are compact, and fast, accurate models of them exist:

- **Numerical-relativity waveform catalogs**, such as SXS
- **Surrogate models**, such as the NRSur family, which interpolate NR results across parameters
- **Analytic inspiral–merger–ringdown approximants**, such as IMRPhenom and effective-one-body (EOB) models

These give the true GR strain far from the source. That strain is the backbone of the app. Everything closer in is layered on with clearly documented approximations.

The app evaluates **IMRPhenomT / IMRPhenomTHM** live: time-domain, aligned-spin phenomenological models with higher modes. They're implemented in Rust from the published papers, so any mass ratio and spin works without downloading data. Offline, Python tools (lalsuite, SXS data) produce small reference tables used as the test oracle and for validation mode.

**Licensing.** The reference implementation of IMRPhenomT lives in LALSimulation (GPL). This repo is MIT. Implement from the papers' equations and published coefficients rather than translating the LAL source. LAL is used only to generate comparison data in tests.

## Why 2D first

The cost and risk in this project live in the near zone (ray-traced lensing, near-zone metrics, horizon shapes), not in whether the picture is 2D or 3D. The wave-zone physics is a field evaluated per pixel on a surface. A 3D scene would just place those same 2D slices in space and add a camera.

- **Nothing is lost in the orbital plane.** For aligned spins, reflection symmetry makes h× vanish there, so one scalar (h+) fully describes the wave in that plane.
- **Linked 2D views teach better than one 3D view you can rotate.** Each view answers one question, and they share a clock.
- **What 3D adds later:** black hole shadows and lensed star fields, wavefronts drawn as volumetric shells, and tendex lines drawn as 3D curves. These are deferred to Phase 3 and later.
- **The 2D work carries over.** The waveform engine, mode-sum shader and orbit model are reused unchanged if the project goes 3D.

## What the user sees (Phase 1)

One screen with four linked views on a shared timeline:

1. **Orbital plane (top-down).** A field colored by h+: one color for stretched space, another for squeezed. The waves leave as a two-armed spiral that winds tighter and brightens toward merger, then a final burst rolls outward. The two holes are drawn as discs at the center and merge into one remnant disc.
2. **Side slice.** A vertical cut through the spin axis. It shows that radiation is strongest along the axis (twice the in-plane amplitude for the dominant mode), and lets you toggle between h+ and h×.
3. **Probe.** Click any point in view 1 or 2. A ring of test particles at that point deforms in the + and × patterns, with the strain at that point plotted alongside.
4. **Chirp plot.** Strain versus time with a playhead, plus optional audio.

**Display conventions (always labeled on screen):**

- The color shows r·h normalized to its peak, not raw h.
- The region inside roughly one gravitational wavelength of the source is faded out, because the far-zone formula isn't valid there.

## Physics layers

The physics splits into five layers, ordered from most faithful to most approximated. Build them in that order too.

| Layer | Fidelity | Method | Main approximations | Phase |
| --- | --- | --- | --- | --- |
| 1. Wave zone strain | Essentially exact | Sum of spin-weighted spherical harmonic modes h\_lm at retarded time t − r, falling off as 1/r, evaluated per pixel in a fragment shader on 2D slices | Valid only far from the source (inner region masked); amplitude shown as r·h, normalized | 1 |
| 2. Orbits | Very good | Derived from the waveform: orbital phase = Φ₂₂/2 + fixed offset, separation from a PN r(ω) relation, remnant mass and spin from the model's own fits | PN r(ω) breaks down near merger; switch to the remnant at peak \|h₂₂\| | 1 |
| 3. Tendex and vortex lines | Exact far out; good near in | Far zone: computed directly from the strain's second time derivative. Near zone: eigenvectors of the electric and magnetic parts of the Weyl tensor, from an approximate metric | Near-zone part depends on the approximate metric | 2 (far), 4 (near) |
| 4. Near zone: lensing and horizons | Honest approximation | GPU ray marching of light paths (null geodesics) through superposed boosted Kerr–Schild metrics or a PN near-zone metric | Metric frozen while each ray travels; merger shapes keyframed or faded to the remnant Kerr black hole | 3+ |
| 5. Validation mode | Reference | Overlays the app's result on LAL / NR data | None. This is the check on every other layer. Tests against LAL run from day one | 1 (tests), 2 (in-app) |

The far-zone strain is written as a mode sum:

```latex
h_+ - i\,h_\times = \frac{1}{r}\sum_{\ell \ge 2}\sum_{m=-\ell}^{\ell} h_{\ell m}(t - r)\; {}_{-2}Y_{\ell m}(\theta, \phi)
```

Modes: (2,±2), (2,±1), (3,±3), (4,±4), (5,±5). The negative-m modes come from symmetry: h\_{l,−m} = (−1)^l h\*\_{lm}.

Tendex and vortex lines replace the rubber-sheet picture, which is misleading. They're coordinate-invariant, and they show near-zone curvature turning smoothly into outgoing waves.

## Platform and stack

Browser only.

- **Physics core: Rust → WebAssembly.** One pure-Rust crate (f64, no GPU or web dependencies) holds the waveform model, orbit model, spherical harmonics and remnant fits. It's built with `wasm-pack` and tested on your own machine with `cargo test`.
- **Frontend: TypeScript + Vite.** Handles the UI, layout, linked views and the chirp plot.
- **Rendering: WebGL2 fragment shaders.** The strain field is evaluated per pixel. WebGL2 runs in every browser today. WebGPU is needed only if and when geodesic ray tracing (Layer 4) starts.
- **Data flow.** When parameters change, Rust generates h\_lm(t) once (target under 20 ms). The result is uploaded as a float texture: one row per mode, one column per time sample, storing (amplitude, phase), which interpolate smoothly. Each frame, the shader only does texture lookups and the mode sum.
- **Offline pipeline: Python, managed with `uv`.** lalsuite generates golden waveforms for the Rust tests. sxs provides NR data for validation mode.

## Repo layout

```
crates/physics/      Rust: waveform (IMRPhenomT/THM), orbits, harmonics, remnant fits
crates/wasm/         Thin wasm-bindgen layer over crates/physics (no logic of its own)
web/                 TypeScript + Vite app; shaders in web/src/shaders/*.glsl
tools/               Python (uv project): golden-data generation, NR reference tables
tests/golden/        Small reference files committed for the Rust tests
```

## Roadmap

**Phase 1: 2D wave-zone MVP.** Already a striking, GR-faithful app.

- **Step 0: Scaffold.**
  - Set up the layout above.
  - CI runs `cargo test`, `clippy`, the wasm build, the web build, and deploys to GitHub Pages.
  - Done when: a Vite page loads the wasm module, calls a Rust function and draws a shader-filled canvas from the deployed link.
- **Step 1: Waveform engine.**
  - Implement IMRPhenomT (the (2,2) mode) from the paper, then add the higher modes (THM).
  - Interface: `generate(q, χ1, χ2, f_start) -> ModeSet { t0, dt, modes: [(l, m, amp[], phase[])], remnant: (M_f, χ_f), t_peak }`.
  - Units: total mass M = 1, with t = 0 at peak |h₂₂|. Use LAL's sign conventions.
  - `tools/gen_golden.py` writes LAL output for q ∈ {1, 2, 4, 8} and χ ∈ {−0.8, 0, 0.8}.
  - Done when: phase error is under about 1e-3 rad, amplitude error under about 1e-4, and the remnant matches.
  - In parallel: a stub (TaylorT4 chirp + damped ringdown) unblocks the rendering work.
- **Step 2: Orbital-plane view.**
  - Upload the mode texture. A fragment shader evaluates the mode sum at retarded time, applies the inner mask and maps the result through a diverging colormap.
  - Controls: pan and zoom; play, pause, scrub and speed.
  - Tests: pixel values match a CPU evaluation of the same sum, and h× in the plane is about 0.
  - Done when: it runs at 60 fps at 1080p on an integrated GPU.
- **Step 3: Orbits and remnant.**
  - Hole positions come from the waveform phase and PN r(ω). Each disc is sized to its horizon radius. At t_peak the two blend into the remnant disc, radius M_f(1 + √(1−χ_f²)).
  - Check: the spiral arms leave the holes with the correct retarded-time lag.
- **Step 4: Side slice, probe, chirp plot, parameters.**
  - Add the side-slice view (it reuses the shader with a different slice), the probe point with its particle ring, and the chirp plot with its playhead.
  - Parameter panel: q from 1 to 8, χ1 and χ2 from −0.9 to 0.9. Changing a parameter regenerates the waveform.
  - Done when: a shareable link loads in under 3 s.

**Phase 2: Depth without new risk.**

- Far-zone tendex and vortex lines drawn on the slices
- In-app validation mode overlaying LAL / NR data
- Audio
- Arbitrary slice orientation

**Phase 3: Go/no-go on 3D.**

- If pursued: move rendering to WebGPU and place the existing slices in a 3D scene with a camera.
- Add the volume view, where wavefronts appear as glowing shells.

**Phase 4: Near zone.**

- Ray-traced black hole shadows and lensing through an approximate metric
- Near-zone tendex lines
- Merger horizon shapes

Each later phase adds physics nearer the black holes, where the approximations grow, so the riskiest work comes last. Phase 3 is an explicit decision point, not a commitment.

## Open questions, risks and references

**Open questions**

- [x] Which waveform source ships first? IMRPhenomT / IMRPhenomTHM, implemented in Rust from the papers. LAL, NR and surrogate data stay as the validation reference.
- [x] How wide a parameter range at launch? Aligned spins only.
- [x] 2D or 3D first? 2D first; 3D is a Phase 3 decision.
- [ ] Retarded time: plain t − r, or the tortoise coordinate r\*? Start with t − r and compare.
- [ ] Which near-zone metric (Phase 4): superposed boosted Kerr–Schild or a PN near-zone metric? Prototype both and compare against NR.
- [ ] How to show merger-phase horizons (Phase 4): keyframed NR horizon shapes, or a fade to the remnant?

**Risks**

- **Waveform port accuracy.** Everything rests on it. Mitigation: golden tests against LAL from day one.
- **Licensing.** GPL reference code versus this MIT repo. Mitigation: implement from the papers; use LAL only in tests.
- **Phase conventions.** Sign and offset mismatches between orbits and waves. Mitigation: the retarded-lag check in step 3.
- **Later phases:** stitching the near zone to the wave zone, 32-bit precision for light paths that skim a horizon, and performance of the ray tracing on mid-range GPUs.

**References** (from memory; verify before citing)

- Estellés et al., IMRPhenomT (2020) and IMRPhenomTHM (2021): the time-domain phenomenological waveform models
- Bohn et al., "What does a binary black hole merger look like?" (2015): the reference for ray-traced merger imagery
- Owen et al., "Frame-dragging vortexes and tidal tendexes attached to colliding black holes" (PRL 2011)
- Nichols et al., "Visualizing spacetime curvature via frame-drag vortexes and tidal tendexes" (PRD 2011)
- The SXS waveform catalog, the NRSur surrogate models, and the IMRPhenom and EOB waveform families
