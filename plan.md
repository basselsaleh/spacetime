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

The app evaluates the **NRHybSur3dq8** numerical-relativity surrogate live (Varma et al. 2019). It is trained directly on NR simulations hybridized with PN/EOB inspirals, covers aligned spins with q ≤ 8 and |χ| ≤ 0.8, and includes 11 modes up to l = 5. The evaluator is written in Rust and reads a trimmed data file (about 2.3 MB) that an offline Python tool cuts from the public model (213 MB), keeping the last ~10,000 M. One evaluation takes about 1 ms in wasm.

**Why not IMRPhenomT (decided Nov 13, 2026).** Its fit coefficients are published only in a supplementary Mathematica package, and the only complete implementation is GPL code in LALSimulation, which clashes with this MIT repo. The surrogate is more faithful (it is NR-based), its code (gwsurrogate) is MIT, and its data is CC BY 4.0, which requires the on-screen credit the app shows.

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
| 5. Validation mode | Reference | Overlays the app's result on NR / reference data | None. This is the check on every other layer. Tests against gwsurrogate run from day one | 1 (tests), 2 (in-app) |

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
- **Rendering: WebGL2 via three.js (since Phase 3 stage 1).** The strain field is evaluated per pixel by a custom shader on slice planes in a 3D scene. WebGL2 runs in every browser today. WebGPU is needed only if the volume view or geodesic ray tracing (Layer 4) demands it.
- **Data flow.** When parameters change, Rust generates h\_lm(t) once (about 1 ms). The result is uploaded as a float texture in the surrogate's co-orbital form: A₂₂ and φ₂₂, plus each other mode as H\_lm = h\_lm e^{i m φ₂₂/2}. These vary slowly and interpolate cleanly; the shader rotates back with h\_lm = H\_lm e^{−i m φ₂₂/2}. Each frame, the shader only does texture lookups and the mode sum.
- **Offline pipeline: Python, managed with `uv`.** gwsurrogate exports the trimmed model and generates golden waveforms for the Rust tests. sxs provides NR data for validation mode; lalsuite is kept for cross-checks.

## Repo layout

```
crates/physics/      Rust: waveform (NRHybSur3dq8 evaluator), orbits, harmonics, remnant fits
crates/wasm/         Thin wasm-bindgen layer over crates/physics (no logic of its own)
web/                 TypeScript + Vite app; shaders in web/src/shaders/*.glsl
tools/               Python (uv project): surrogate export, golden-data generation, NR reference tables
web/public/          Static data served to the app, incl. the trimmed surrogate (nrhybsur3dq8.stsur)
tests/golden/        Small reference files committed for the Rust tests
```

## Roadmap

**Phase 1: 2D wave-zone MVP.** Already a striking, GR-faithful app.

- **Step 0: Scaffold.**
  - Set up the layout above.
  - CI runs `cargo test`, `clippy`, the wasm build and the web build. No deployment while the repo is private.
  - Done when: a Vite page loads the wasm module, calls a Rust function and draws a shader-filled canvas locally.
- **Step 1: Waveform engine.** Done Nov 13, 2026.
  - NRHybSur3dq8 evaluator in Rust: Gaussian-process node fits, empirical-interpolation basis, TaylorT3 phase, natural cubic splines, co-orbital → inertial rotation.
  - Interface: `Surrogate::evaluate(Params { q, chi1, chi2 }, t_start, dt) -> Waveform { t0, dt, amp22, phase22, coorbital }`, with `Waveform::h(l, m, i)` for inertial modes (m < 0 by symmetry).
  - Units: total mass M = 1, t = 0 at the waveform peak. Frame: the surrogate's raw frame (heavier hole on +x at t = −1000 M).
  - `tools/export_surrogate.py` trims the model; `tools/gen_golden.py` writes gwsurrogate output for 7 parameter sets across the trained range.
  - Result: every mode matches gwsurrogate to within 2e-7 of the peak strain (tolerance 1e-6), which is at the level of the reference's own interpolation noise.
  - Remnant mass and spin were moved to step 3 (they are not part of this surrogate).
- **Step 2: Orbital-plane view.** Built Nov 13, 2026; 60 fps at 1080p still to be confirmed on real hardware.
  - Mode table: RG32F texture, 2048 texels wide (WebGL2's guaranteed minimum), read with texelFetch and interpolated by hand. φ₂₂ is stored mod 4π (exact for every e^{−imφ₂₂/2}) to keep GPU trig accurate.
  - A fragment shader evaluates the full 11-mode sum at retarded time t − r, fades out the near zone (radius max(1/ω₂₂, 2 × Kepler separation)), and colours r·h₊ ÷ peak × gain on a tanh-saturating diverging scale.
  - Controls: pan, zoom, play, pause, scrub, speed, gain; URL options `?q=&chi1=&chi2=`, `?t=`, `?zoom=`, `?paused`.
  - Tests:
    - spin-weighted harmonics match LAL to 1e-12
    - h× = 0 in the orbital plane to 1e-12 (from the harmonics and mode symmetry together)
    - the GPU table matches the exact mode sum to 1e-6 at samples and 1e-3 between them
    - `?selftest` compares GPU pixels with the Rust CPU reference: 3.6e-4 of peak on the Apple GPU (Metal), 1.2e-3 under SwiftShader; tolerance 2e-3
- **Step 3: Orbits and remnant.** Done Nov 13, 2026.
  - Remnant: NRSur3dq8Remnant fits (mass, spin, recoil kick) from the same Zenodo record (CC BY 4.0), embedded in the same data file and evaluated by the same Rust GPR code. Matches surfinBH to 1e-10.
  - Heavier hole's angle Φ(t) = (φ₂₂(t) − φ₂₂(−1000 M))/2: the surrogate frame puts it on +x at t = −1000 M. Separation from the 2PN harmonic-coordinate r(ω), non-spinning. Discs are horizon-sized, r₊ = m(1 + √(1 − χ²)), with a few pixels minimum so they stay visible. The holes cross-fade into the remnant over [−20, +5] M, and the remnant then drifts with its kick.
  - **Convention finding.** The surrogate, like LAL, uses the LAL polarisation convention, which flips the overall sign of h relative to Blanchet/Kidder. So h₊ = ½(h_φφ − h_θθ) in the orbital plane, and h₊ is largest along the binary axis. Checked against LAL's PN modes in both conventions: only the LAL convention makes the (2,2), (2,1) and (3,3) modes agree on where the heavier hole is.
  - Tests:
    - wave arms follow the binary axis at the retarded time to 0.01 rad
    - the heavier hole's angle matches LAL PN to within 0.25 rad, compared modulo 2π so a swap of the holes fails; the observed offset of ~0.15 rad is the PN tail ambiguity between orbital and wave phase
- **Step 4: Side slice, probe, chirp plot, parameters.** Built Nov 13, 2026.
  - Layout: the orbital plane is the main view; a side column holds the vertical slice (h₊/h× toggle), the probe ring and the chirp plot. Below 900 px wide, the column stacks under the main view.
  - One shader serves both slices. The harmonics' θ-dependence is an RG32F lookup texture (1025 samples, θ = π/2 exact), and horizons are drawn as the slice's cross-section of each horizon sphere.
  - Probe: click either view. The ring shows ξ → ξ + ½hξ in the (φ̂, −θ̂) basis, exaggerated with a smooth saturation. The chirp plot shows h₊ and h× received at the probe against retarded time, with a playhead at t − r.
  - Parameter sliders regenerate the waveform, orbits and remnant live, and update the URL.
  - Tests: harmonic table exact at θ = π/2 and within 1e-4 between samples; `?selftest` now includes two vertical-slice frames (both polarisations), worst 4.4e-4 of peak on Metal.
  - Size: 180 KB of wasm plus the 2.28 MB data file (1.7 MB gzipped), so loading is dominated by the data file: well under 3 s on broadband, and slower on mobile data. Hosting is decided when the repo goes public.
  - Deferred to Phase 2: audio (needs a physical-mass control).
- **Step 4b: Single view with an animated top ⇄ side swap.** Built Nov 13, 2026, after review.
  - One main view instead of two unequal ones. The slice is the plane spanned by x̂ and cos β ŷ + sin β ẑ: β = 0 is the top view, 90° the side view, and every β in between is a genuine slice. "Swap" eases β over 1.4 s, so the transition shows the real field as the cutting plane rotates. A tilt slider allows any β; a small 3D sketch shows the orbital plane, the binary, the slice and the viewing direction.
  - The h₊/h× toggle is always available; choosing h× in the top view shows the blank field with a caption explaining the mirror symmetry.
  - Horizons the slice cuts are drawn solid (true cross-section); holes off the slice are drawn as faint outlines.
  - Playback ends once the merger burst has left the visible area (depends on zoom) instead of 3000 M after the ringdown, and loops from t = −2500 M by default.
  - The shader takes θ = π/2 directly when z = 0: ANGLE on Metal mishandled atan(y, 0) there, which the self-test caught (orbital-plane frames failed at O(1) error). The self-test now also covers a tilted slice.

**Phase 2: Depth without new risk.**

- Far-zone tendex and vortex lines drawn on the slices
- In-app validation mode overlaying NR data
- Audio
- Slice azimuth control (tilt is done in step 4b)

**Phase 3: 3D. Decided Nov 14, 2026: go, before Phase 2, so tendex/vortex lines can be built directly in 3D.**

Order: 3D scene → tendex/vortex lines as 3D curves (weak-field quadrupole solution) → volume view → ray-traced lensing (Phase 4).

- **Stage 1: 3D scene with flat field surfaces.** Built Nov 14, 2026 (branch `step-5-3d-scene`).
  - three.js (r181) on WebGL2. The strain shader now runs on plane meshes (RawShaderMaterial), so any slice can be placed in space. Black holes and the probe are spheres: solid where visible, a faint outline where hidden behind a slice (depth test, ghost pass). Guides: the orbital axis and the outline of the orbital plane.
  - One perspective camera for both views. Flat view: 1° field of view from far away, looking straight at the slice; a perspective view of a plane perpendicular to the line of sight is an exact scaling, so this matches the 2D app. 3D view: 40° orbit camera with +z up (OrbitControls). Switching is a 1.6 s dolly zoom (logarithmic field-of-view interpolation, quaternion slerp, distance chosen to keep the slice framed).
  - In 3D, a translucent orbital plane can accompany a tilted slice. Clicking a slice places the probe (ray cast).
  - Precision: in the flat view and the self-test, slice coordinates come from the pixel position, not interpolated vertex positions. Rasterizers snap vertices to 1/256 px, which in the self-test's 64×40 images moved points by ~0.05 M and raised the GPU−CPU error to 2.5e-3. With the exact mapping the self-test is unchanged from step 4b (worst 4.4e-4).
  - Size: three.js brings the JavaScript bundle to 542 KB (141 KB gzipped). WebGPU is still not needed; revisit for the volume view or ray tracing.
- **Stage 2:** tendex and vortex lines as 3D curves.
- **Stage 3:** volume view, where wavefronts appear as glowing shells.

**Phase 4: Near zone.**

- Ray-traced black hole shadows and lensing through an approximate metric
- Near-zone tendex lines
- Merger horizon shapes

Each later phase adds physics nearer the black holes, where the approximations grow, so the riskiest work comes last. Phase 3 is an explicit decision point, not a commitment.

## Open questions, risks and references

**Open questions**

- [x] Which waveform source ships first? NRHybSur3dq8 surrogate, evaluated in Rust from a trimmed data file (IMRPhenomT ruled out on licensing; see Core approach).
- [x] Remnant mass and spin for step 3: NRSur3dq8Remnant fits (same data record and licence as the waveform).
- [x] How wide a parameter range at launch? Aligned spins only.
- [x] 2D or 3D first? 2D first; 3D is a Phase 3 decision.
- [ ] Retarded time: plain t − r, or the tortoise coordinate r\*? Phase 1 uses t − r. The difference, 2M ln(r/2M − 1), is a slowly growing delay (~8 M at r = 100 M, ~12 M at 1000 M). It shifts where the pattern sits relative to the holes by that much retarded time, which is within the near-zone ambiguity. Revisit with the near zone.
- [ ] Which near-zone metric (Phase 4): superposed boosted Kerr–Schild or a PN near-zone metric? Prototype both and compare against NR.
- [ ] How to show merger-phase horizons (Phase 4): keyframed NR horizon shapes, or a fade to the remnant?

**Risks**

- **Waveform accuracy.** Everything rests on it. Mitigation: golden tests against gwsurrogate (in place, passing).
- **Data licensing.** The surrogate data is CC BY 4.0. Mitigation: the attribution string travels inside the data file and is shown in the app.
- **Parameter range.** The surrogate is only trained for q ≤ 8, |χ| ≤ 0.8; the evaluator refuses values outside that.
- **Phase conventions.** Sign and offset mismatches between orbits and waves. Mitigation: the retarded-lag and LAL-PN orientation tests in step 3, which caught the Blanchet-vs-LAL polarisation sign.
- **Later phases:** stitching the near zone to the wave zone, 32-bit precision for light paths that skim a horizon, and performance of the ray tracing on mid-range GPUs.

**References** (from memory; verify before citing)

- Varma et al., "Surrogate model of hybridized numerical relativity binary black hole waveforms", Phys. Rev. D 99, 064045 (2019), arXiv:1812.07865 (journal and arXiv numbers verified against gwsurrogate); data doi:10.5281/zenodo.3348115
- Bohn et al., "What does a binary black hole merger look like?" (2015): the reference for ray-traced merger imagery
- Owen et al., "Frame-dragging vortexes and tidal tendexes attached to colliding black holes" (PRL 2011)
- Nichols et al., "Visualizing spacetime curvature via frame-drag vortexes and tidal tendexes" (PRD 2011)
- The SXS waveform catalog, the NRSur surrogate models, and the IMRPhenom and EOB waveform families
