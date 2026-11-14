# Black hole lensing app: plan

Nov 13, 2026 (updated Nov 14) · @Bassel · **steps 0 and 1 done**, merged to `main` (PR #3). Step 2 (Kerr) in progress: **2a done** (branch `lensing-2a-kerr-reference`), 2b next.

A second app in this repository, alongside the binary black hole (BBH) wave visualizer ([bbh.md](bbh.md)).

## Goal

A 3D scene with distant stars, galaxies and other light sources in the background and a black hole in front of them. The user orbits the camera around the hole and watches how light from behind it is bent:

- the shadow
- the Einstein ring when a source lines up behind the hole
- secondary and higher-order images
- the photon ring
- the whole sky distorting as the camera moves
- (step 3) a glowing accretion disk around the hole, lensed into the familiar "hat" shape and brighter on the side moving toward the camera

As with the BBH app: faithful to general relativity, beautiful, interactive, and opens from a link.

## Approach: exact ray tracing

Every pixel's light ray is traced **backwards** from the camera as a null geodesic of the black hole spacetime, until it either:

- **crosses the horizon:** the pixel is black (the shadow), or
- **escapes to large radius:** the pixel takes the color of the background sky in the ray's final direction, or
- **hits the accretion disk** (step 3): the pixel takes the disk's emission at the hit point, shifted by the redshift between the disk and the camera.

This needs no thin-lens or weak-field approximation. The only approximations are:

- numerical integration of each ray
- background sources treated as infinitely far away
- the camera's local frame: a static observer in step 1, a zero-angular-momentum observer in step 2 (see open questions)

All the lensing features listed under Goal fall out of this one calculation.

### Step 1 physics: Schwarzschild (no spin)

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

### Step 2 physics: Kerr (spin)

A spinning hole has no planar reduction: rays leave the plane they start in. But Kerr null geodesics still separate (Carter), and in **Mino time** the separated equations become polynomial. That gives a GPU integrator with the same character as step 1: a few smooth variables, RK4, and Hermite interpolation of the escape point. The equations below are verified by the step 2a tests.

- **Coordinates and units.** Boyer–Lindquist (r, θ, φ), M = 1, spin a ∈ [0, 0.998] along +z. Δ = r² − 2r + a², Σ = r² + a² cos²θ, horizon r₊ = 1 + √(1 − a²). The scene's Cartesian position of a point is the flat-space map of its BL coordinates, x = r sin θ cos φ and so on. At infinity BL directions are flat-space directions, so the sky lookup is unchanged.
- **Constants of motion.** Energy E = −p_t, scaled to 1; axial angular momentum L = p_φ; Carter constant Q.
- **Variables.** u = 1/r as in step 1, and μ = cos θ, which is regular at the poles. With λ the Mino time (dλ = dτ_affine / Σ):
  - **Radial:** (du/dλ)² = P(u) = (1 + (a² − aL)u²)² − u²(1 − 2u + a²u²)(Q + (L − a)²), a quartic.
  - **Polar:** (dμ/dλ)² = Θ(μ) = Q − (Q + L² − a²)μ² − a²μ⁴.
  - **Azimuthal:** dφ/dλ = L/(1 − μ²) − a + a(1 + (a² − aL)u²)/(1 − 2u + a²u²).
- **Second-order form.** The radial equation is integrated as u″ = P′(u)/2: a polynomial, so there are no square roots, no sign bookkeeping at turning points, and nothing singular at infinity (u = 0 is reached at finite λ) or at the horizon.
- **Angles without the pole (changed in 2a).** Integrating μ and φ directly would put L/(1 − μ²) in dφ/dλ, which spikes for rays passing near the spin axis. Instead the ray's angular position is a unit vector m, and frame dragging is split off as a rotation χ about z. The BL direction is R_z(χ) m, with
  - m″ = a² m_z ẑ − (a² m_z² + |m′|²) m: a particle on the unit sphere pushed along z. Its z-component reproduces the polar equation, and its azimuth advances at exactly L/(1 − μ²).
  - χ′ = Ψ(u) = a u (2 − aLu)/(1 − 2u + a²u²): the rest of dφ/dλ, a function of u alone.
  - All of it is polynomial or regular at the poles. At a = 0, χ = 0 and m moves on a great circle at speed b: step 1's planar geometry exactly.
  - u and m don't depend on χ, so χ blowing up at the horizon can't disturb capture.
- **Time reversal (found in 2a).** The pixel shows the photon *arriving* along −d, and Kerr is not time-symmetric. But t → −t maps spin a to spin −a and a ZAMO to a ZAMO, so the arriving photon's past is the future of a ray leaving along d around spin −a. Both integrators trace that forward ray. The shader will do the same, passing −a. A physical test (the flattened side faces the approaching side) checks the sign.
- **Check at a = 0.** With Q + L² = b² in the ray's plane, P(u) = 1 − b²u²(1 − 2u), which is the step 1 orbit equation: (du/dφ)² = 1/b² − u² + 2u³.
- **Camera: the zero-angular-momentum observer (ZAMO).** Static observers don't exist inside the ergosphere, and the ZAMO is the standard choice (James et al. 2015). Its frame has lapse α = √(ΣΔ/A), frame-dragging rate ω = 2ar/A and ϖ = √(A/Σ) sin θ, where A = (r² + a²)² − a²Δ sin²θ. The axes are along the BL coordinate directions, matching step 1.
- **Initial conditions.** A pixel direction (n_r, n_θ, n_φ) in the ZAMO frame, with unit local energy, gives:
  - p_φ = ϖ n_φ, E = α + ω ϖ n_φ, p_r = √(Σ/Δ) n_r and p_θ = √Σ n_θ, then everything divided by E
  - L = p_φ and Q = p_θ² + μ²(L²/(1 − μ²) − a²)
  - starting derivatives u′ = −u²√(ΣΔ) n_r / E, m = r̂ and m′ = p_θ θ̂ + (L/sin θ) φ̂, where L/sin θ = √(A/Σ) n_φ / E is regular on the axis. The second-order form needs only these, with no initial sign choices.
  - At a = 0 this reduces to step 1: u′ = −n_r and L = b.
- **Step control (as built in 2a).** With ω = max(|m′|, 1) the angular rate: h = max(min(u / 2|u′|, ε / max(ω, |Ψ|)), floor / ω), with ε = 0.02 and floor = 0.002. At a = 0 that is step 1's clamp(½u/|du/dφ|, 0.002, 0.02) in φ. The floor ignores Ψ, so rays falling in reach the horizon in finitely many steps.
- **Termination.**
  - **Escape:** u ≤ 0. Locate it by Hermite interpolation on u, then interpolate m and χ there. The sky direction is R_z(χ) m.
  - **Capture:** u ≥ 1/r₊. Regular in Mino time, so no ε-shell is needed. At high spin, escaping rays can skim the horizon: the prograde photon orbit sits within 1% of r₊ at a = 0.998.
  - **Unresolved after the step cap:** black, as in step 1.
  - Step 1's analytic shadow rejection doesn't carry over directly. A Kerr version (the ray is captured if u′ > 0 and P has no root between u and 1/r₊) is an optional speed-up, not a requirement.
- **Independent reference.** A Hamiltonian integration of the full geodesic equations in Kerr–Schild Cartesian coordinates, where the inverse metric is g^{μν} = η^{μν} − f l^μ l^ν and nothing is singular at the horizon. It shares none of the algebra above (separation, Mino time, BL), so agreement checks that algebra. The camera's BL position and ZAMO frame must be mapped into Kerr–Schild with the azimuth offset fixed so the two agree at infinity.
- **New visuals.**
  - The shadow becomes asymmetric: flattened (D-shaped at high spin) on the side where the hole's rotation moves toward the camera, and shifted away from it.
  - It stays round when viewed along the spin axis.
  - Frame dragging twists the lensed sky around the axis.
- **Analytic shadow edge** (Bardeen 1973; confirmed by the 2a tests). Spherical photon orbits at radius r_p have
  - L = (r_p²(3 − r_p) − a²(r_p + 1)) / (a(r_p − 1))
  - Q = r_p³(4a² − r_p(r_p − 3)²) / (a²(r_p − 1)²)
  - Sweeping r_p between the prograde and retrograde equatorial photon orbits, r = 2(1 + cos(⅔ arccos(∓a))), and mapping (L, Q) to the ZAMO camera's angles traces the exact shadow outline at any camera distance.

### Step 3 physics: thin accretion disk

A geometrically thin, optically thick disk in the equatorial plane (z = 0, perpendicular to the spin axis), made of gas on circular Keplerian orbits. This is the Novikov–Thorne model, and the setting of Luminet's 1979 image.

- **Extent.** From the innermost stable circular orbit (ISCO) out to a chosen outer radius r_out (default ~20 M, adjustable). Gas inside the ISCO plunges and is treated as emitting nothing. The ISCO is 6 M for Schwarzschild. In Kerr it comes from the Bardeen–Press–Teukolsky formula: M for a prograde disk at maximal spin, 9 M for retrograde.
- **Ray–disk intersection.** The disk is opaque, so the first crossing of the equatorial plane with r_in ≤ r ≤ r_out ends the ray. Rays that cross the plane inside the ISCO or outside r_out carry on. The images then follow automatically:
  - the direct image of the disk
  - the image of the far side, lifted over the shadow (the "hat" in Luminet's picture and in *Interstellar*)
  - thin higher-order images hugging the shadow
  - **Kerr integrator:** detect a sign change of cos θ (or z) between steps, then locate the crossing by Hermite interpolation, as the Schwarzschild shader already does for the escape point.
  - **Schwarzschild planar path** (if step 2 keeps it for spin 0): the ray's orbit plane meets the equatorial plane along a line, so crossings happen at known values of φ, every π apart. The crossing radius comes from interpolating u at those φ values.
- **Redshift.** The photon's conserved energy E = −p_t and axial angular momentum L = p_φ give the frequency ratio g = ν_obs / ν_em directly, with no extra integration:
  - Emitter on a circular orbit with angular velocity Ω: ν_em ∝ uᵗ (E − Ω L). In Schwarzschild Ω = √(M/r³) and uᵗ = 1/√(1 − 3M/r). In Kerr Ω = √M / (r^{3/2} + a√M), and uᵗ has a closed form (Bardeen–Press–Teukolsky; to verify).
  - Camera: ν_obs ∝ E / √(1 − 2M/r₀) for the static observer; for the ZAMO, (E − ω L)/α, where ω is the frame-dragging rate and α the lapse.
  - g combines gravitational redshift, Doppler shift and time dilation in one number. The side of the disk moving toward the camera is blueshifted and the far side redshifted.
- **Emission.** Each point of the disk radiates as a blackbody at its local temperature T(r) ∝ F(r)^{1/4}. F(r) is the Page–Thorne flux, which is zero at the ISCO, peaks a few M outside it and falls off as r⁻³. There is a closed form for Schwarzschild (as quoted by Luminet; to verify) and for Kerr (Page & Thorne 1974). Emission is isotropic; limb darkening is ignored.
- **What the camera sees.** I_ν/ν³ is invariant along a ray, so a blackbody at T looks like a blackbody at gT, and its bolometric brightness scales as g⁴. Color comes from a precomputed blackbody table: temperature → sRGB chromaticity, through the CIE color-matching functions. Brightness is g⁴ T⁴ (equivalently F) times an exposure, followed by a tone map.
- **Temperature scale.** T_max depends on the accretion rate and the mass. A real stellar-mass disk peaks in X-rays (~10⁷ K), where every blackbody looks the same blue-white. So the displayed peak temperature is a cosmetic control (default around 10⁴ K, where blueshift and redshift change the color visibly). The *ratios* of temperature and brightness across the disk stay physical.

### The sky

The background is a "celestial sphere" at infinity, sampled by direction:

- **Procedural.** A starfield with a range of brightnesses and colors, plus a few galaxy-like smudges and nebula-like glows, generated in the shader. Free, sharp at any zoom, and no licensing questions.

**Aliasing is the main rendering risk.** Near the photon ring, a single pixel's ray bundle covers a huge patch of sky, so point-like stars sparkle and flicker. No step schedules a fix yet; if it's needed, the mitigations, in order, are:

1. supersampling near the ring
2. ray differentials (track the bundle's spread and blur the sky lookup to match)
3. temporal accumulation

## How it fits in the repository

Turn `web/` into a multi-page Vite site with two apps sharing common code. Rust stays one physics crate and one wasm crate.

```
crates/physics/src/
  (BBH modules unchanged)
  geodesic.rs                 Schwarzschild null geodesics: reference integrator, deflection, shadow
  kerr.rs                     step 2: Mino-time integrator (mirrors the shader), Kerr–Schild Hamiltonian
                              reference, ZAMO frame, analytic shadow edge
  disk.rs                     step 3: ISCO, Keplerian orbits, redshift, Page–Thorne flux, reference disk hits
crates/physics/tests/
  geodesic.rs                 analytic limits and exact-deflection checks
  kerr.rs                     step 2: spin 0 vs step 1, the two Kerr methods vs each other, constants
                              of motion, shadow edge, symmetries
  disk.rs                     step 3: ISCO, redshift and flux checks
crates/wasm/src/lib.rs        BBH bindings + lensing references for the GPU self-test
web/
  index.html                  landing page linking both apps
  bbh/index.html              the BBH app (moved from web/index.html)
  lensing/index.html          the lensing app
  src/common/                 shared: rayMatrix, adaptive reduced-resolution pass, orbit camera,
                              panel styles, self-test harness
  src/bbh/                    the current web/src files, moved
  src/lensing/                main.ts (page, orbit camera, sliders), lens.ts (pass), selftest.ts,
                              shaders/lens.frag (ray tracer), shaders/sky.glsl (procedural sky),
                              shaders/disk.glsl (step 3: disk emission, blackbody table lookup)
  vite.config.ts              multi-page build inputs
```

- **One npm project, one build, one CI job.** CI needs no changes beyond what the build already does.
- **What's reused.** The lensing renderer is structurally the BBH volume pass with a different shader: full-screen ray per pixel built from the camera basis (accurate in float32), reduced resolution adapted to frame rate, and compositing.
- **Rust's role.** CPU reference geodesics for the tests and the GPU self-test, as the mode-table reference does for the BBH shaders. With Schwarzschild the browser loads wasm for lensing only in the self-test.
- **BBH URLs moved** from `/` to `/bbh/` (for example `/bbh/?q=3&3d`) in step 0, before the repo went public, so no external links broke.
- **Plans** live on the plans-only `dev` branch, checked out as the gitignored `plans/` worktree, not on `main`.
- **Deploy.** The repo is public, and the site (landing page and both apps) deploys to GitHub Pages from `main`.

## Stages

### Step 0: repository reorganization (done)

- Multi-page Vite config (`web/vite.config.ts`), landing page (`web/index.html`), BBH moved under `web/bbh/` and `web/src/bbh/`, and a placeholder `web/lensing/index.html`.
- Shared code in `web/src/common/`: `rays.ts` (`rayMatrix`), `reducedPass.ts` (the adaptive reduced-resolution full-screen pass and composite, extracted from the BBH volume) and `theme.css`.
- Deferred to step 1, when there's a second user: an orbit-camera helper and a generic self-test harness.
- The BBH data file stays in `web/public/` (the Rust tests read it there). The page fetches it relative to itself, so the build works at any URL prefix. (It was `nrhybsur3dq8.stsur` then; since BBH step 7c it is `nrsur7dq4.stsur`.)
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
- **Checks against known results in the image:** at 60 M (the default distance was 20 M then, and is 40 M now) the Einstein ring of the galaxy behind the hole sits at 15.3°, against √(4M/r) = 14.8°. The shadow-radius readout uses the exact formula.
- **Performance** (Apple M4, `?lensbench`): 720×407 3.7 ms, 1440×813 11.2 ms, 2880×1626 (full retina) 38.9 ms. The pass adapts between 0.35× and the device-pixel ratio.

### Step 2: Kerr

The physics is under "Step 2 physics" above. Split into sub-steps, each on its own stacked branch (`lensing-2a-kerr-reference`, `lensing-2b-kerr-shader`, …), as BBH Phase 5 was.

#### 2a: Rust reference and tests (no app changes)

- **`kerr.rs`:**
  - `trace_mino`: the shader's algorithm in f64 (RK4 in Mino time, same step control, Hermite escape point)
  - `trace_ks`: the Kerr–Schild Hamiltonian with an adaptive high-order integrator, tight tolerance
  - ZAMO frame and pixel → (L, Q) initial conditions
  - the analytic shadow edge mapped to camera angles
  - `escape_direction(cam, a, dir)`, mirroring the step 1 function
- **Tests** (`crates/physics/tests/kerr.rs`):
  - **spin 0:** `trace_mino` matches step 1's `sweep_quadrature` to about 1e-9 rad over step 1's ray set
  - **two methods agree:** `trace_mino` (fine step) and `trace_ks` agree on fate and escape direction to about 1e-8 rad. The grid covers spins 0, 0.5, 0.9 and 0.998, camera inclinations 0° (on the axis), 17°, 60° and 90°, and distances 3.5–300 M, and excludes near-critical rays.
  - **constants of motion:** in `trace_ks`, H = 0, E, L and Q are conserved along each ray to about 1e-10
  - **shadow edge:** rays just inside the analytic outline (by 1e-4 in angle) are captured and rays just outside escape, all around the outline, at several spins and inclinations
  - **symmetries:**
    - mirroring a ray through the equatorial plane mirrors its escape direction
    - from a camera on the spin axis, the shadow is round, with the radius the critical curve predicts
  - **frame-dragging sign:** for an equatorial camera, the shadow is flattened on the side where the hole's rotation moves toward the camera
  - **weak field** (to verify the formula first): equatorial deflection at large b matches 4/b + 15π/(4b²) ∓ 4a/b², prograde vs retrograde
- **Prototype question to settle here:** how bad the φ′ ∝ L/(1 − μ²) spike is for rays that pass close to the spin axis, in f32. If it costs too many steps or too much accuracy, integrate the sky direction's Cartesian components instead of φ, or handle the pole passage analytically. Measure it with a float32 build of `trace_mino`.

**Done (Nov 14, 2026).** Branch `lensing-2a-kerr-reference`.

- **`crates/physics/src/kerr.rs`:**
  - `trace_mino<F>`: generic over f32/f64; `SHADER_STEPS` and `REFERENCE_STEPS`
  - `trace_ks`: Kerr–Schild Hamiltonian, gradients by forward-mode dual numbers, Dormand–Prince 5(4) at tolerance 1e-12, traced to r = 10⁷
  - `escape_direction(cam, a, dir)`: `trace_mino` in f64 with the fine steps; the planned wasm reference
  - `shadow_edge(cam, a, n)`: the exact edge as pixel directions (a circle at a = 0 or on the axis)
  - ZAMO frame, BL and Kerr–Schild metrics, and the BL → Kerr–Schild Jacobian, for the tests
  - New dependency: `num-traits` (already in the tree through `num-complex`).
- **The pole question is settled by design:** the unit-vector formulation above has no 1/sin²θ anywhere, so there's no spike to measure.
- **Results** (`crates/physics/tests/kerr.rs`, 12 tests, 21 s in a debug build):
  - **Spin 0 vs step 1:** Mino 3.1e-13 rad, Kerr–Schild 7.4e-12 rad, over 124 rays.
  - **Mino vs Kerr–Schild:** worst 6.4e-11 rad over 1807 escaping rays, and 663 captured rays agree on capture. The grid is spins 0, 0.5, 0.9 and 0.998 × inclinations 0°, 17°, 60° and 90° × distances 3.5, 20 and 300 M. 26 rays within 2% of the edge are skipped.
  - **Constants of motion** (Kerr–Schild): H to 1.2e-11; L and Q to 4e-12.
  - **The metric:** the Kerr–Schild metric equals the transformed BL metric, the ZAMO frame is orthonormal, and the initial momenta are null.
  - **Shadow edge:** rays 2e-4 inside the analytic edge (relative to its distance from the center) are captured and rays 2e-4 outside escape. Checked at spins 0.5, 0.9 and 0.998 × inclinations 0°, 17°, 60° and 90° × distances 5, 20 and 100 M.
  - **Round from the axis:** at spins 0.5 and 0.998, the edge radius is the same in every direction to 1e-7.
  - **Flattened on the approaching side:** for an equatorial camera at 20 M, the edge sits at 0.196 rad (approaching side) vs 0.295 rad at a = 0.5, and 0.100 vs 0.337 rad at a = 0.998.
  - **Mirror symmetry** through the equatorial plane, to 1e-10.
  - **Weak field:** prograde rays deflect less than retrograde ones by 8a/b². The excess over that is 2.7% at b = 300 and 0.8% at b = 1000, converging as 1/b. The mean matches 4/b + 15π/(4b²).
  - **GPU prediction** (the 2b self-test views): with the shader's step control, the error against the reference is 7.8e-8 rad in f64 and 1.3e-5 rad in f32, over 412 rays. At most 620 steps were needed (cap 1000), and no ray changed fate.
- **Found along the way:** step 1's `sweep_quadrature` loses accuracy (9e-5 rad) on an *outward* ray whose b equals b_c exactly. It takes the turning-point branch with a double root. This is measure-zero, already outside the step 1 tests' 1% band, and unchanged here.

#### 2b: shader and GPU self-test (spin as a URL option only)

- `lens.frag` gets the Mino-time integrator, with `u_spin` and the ZAMO camera. `?a=` sets the spin, with no slider yet.
- **GPU self-test** (`?selftest`): the step 1 views, plus spinning views at a = 0.5 and 0.998: on the axis, inclined 17° (the M87 viewing angle), equatorial, and an equatorial view close in (5 M) to stress frame dragging.
  - Reference: `trace_mino` through a new wasm binding `lensKerrEscapeDirections(cam, a, dirs)`.
  - Target: about step 1's 3.3e-5 rad worst error.
  - Exclusion band: rays the reference flags as near-critical, for example those whose closest approach is within 2% of the spherical photon orbit for their (L, Q). This is the counterpart of step 1's band within 2% of b_c.
  - At a = 0 the numbers must match step 1's.
- **Performance:** `?lensbench` at a = 0, 0.5 and 0.998, compared with step 1's 3.7 / 11.2 / 38.9 ms. The budget is about 2× step 1's cost; past that, tighten the step control or add the analytic capture test.

#### 2c: the app

- **Spin slider:** a from 0 to 0.998 (Thorne's limit), linear, synced with `?a=`, in the existing panel style.
- **Readouts:**
  - the horizon radius r₊
  - the shadow's angular width and height, from the analytic edge (closed form, ported to TypeScript, so no wasm in the app). This replaces the step 1 radius readout; at a = 0 width = height = the old value.
- The camera minimum stays at 3.5 M. It is outside the ergosphere (2 M at the equator) for every spin, so the ZAMO is never moving close to light speed.
- **Visual checks:** a round shadow from on the axis; at a = 0.998, the D-shape with its flat side on the approaching side from the equator; and the twisted sky.

#### 2d: wrap-up

- **One integrator or two:** if the Kerr shader at a = 0 matches step 1's accuracy and speed closely enough, retire the planar Schwarzschild path and keep one integrator. Otherwise keep the planar path as the a = 0 fast path. Record the measurements.
- Update the README (spin slider, `?a=`) and this plan with results, as was done for step 1.

**Done when:** all 2a tests pass, the GPU self-test passes at every spin within the target, `?lensbench` is within budget, and the visual checks hold.

### Step 3: thin accretion disk

The physics is under "Step 3 physics" above. Built on the step 2 integrator, so it works at any spin; spin 0 is the Luminet case.

- **Rust reference** (`disk.rs`):
  - ISCO as a function of spin, for both prograde and retrograde disks
  - Ω, uᵗ and the redshift g for a given photon (E, L) and observer
  - the Page–Thorne flux
  - a reference disk hit (radius, g, and which image order: direct, far side, higher) for any camera ray, built on the step 1 and step 2 reference integrators
- **Rust tests:**
  - ISCO is 6 M at spin 0, tends to M (prograde) and 9 M (retrograde) at maximal spin
  - face-on, from far away: L = 0, so g = 1/uᵗ = √(1 − 3M/r) in Schwarzschild
  - edge-on: g is highest on the approaching side and lowest on the receding side, and the two match the special-relativistic Doppler factor times the gravitational shift
  - the flux is zero at the ISCO; its integral over the disk gives the efficiency 1 − E_ISCO, which is 1 − √(8/9) ≈ 5.7% at spin 0
  - the Kerr disk at spin 0 matches the Schwarzschild disk
- **Shader:**
  - equatorial-plane crossing detection with interpolation, in whichever integrator step 2 leaves in place
  - first hit inside [r_in, r_out] ends the ray
  - emission from the blackbody table, g⁴ brightness, tone map
  - the sky shows wherever no disk is hit
- **App controls:**
  - disk on/off
  - outer radius
  - displayed peak temperature
  - exposure
  - teaching toggles: Doppler shift on/off and gravitational redshift on/off (setting that part of g to 1), so each effect can be seen alone
  - a false-color "redshift map" view of g
  - URL options to match (for example `?disk`, `?rout=`)
- **GPU self-test:** extend the raw mode to output each pixel's disk-hit radius and g (or a no-hit flag), and compare with the Rust reference. Exclude rays that cross near r_in or r_out, or that graze the plane, where a tiny error flips hit and miss.
- **Checks against the literature:** at spin 0 and an inclination near Luminet's (about 10° from edge-on), the image reproduces his figure: the lifted far side, the bright approaching side and the thin secondary image.
- **Performance:** measure with `?lensbench` in a disk view. Rays that hit the disk stop early, so this should cost no more than step 2.

### Maybe later

- A richer disk: procedural turbulence rotating with Ω(r) (differential rotation shears it over time), finite thickness, or a semi-transparent disk.
- A moving camera (orbiting or falling in), with aberration.
- Lensing combined with the BBH app (for example the remnant black hole).

## Conventions

- Geometric units, G = c = 1, with the black hole mass M = 1: lengths and distances are in M. A physical mass only rescales the scene, so the mass control can be cosmetic (a label in km or solar radii).
- The spin axis (for Kerr) is +z, matching the BBH app's orbital axis.
- Sky directions are fixed in the black hole's rest frame. The camera moves; the sky does not.

## Risks

- **Aliasing near the photon ring** (see The sky).
- **Precision.** Rays that skim the photon sphere are sensitive to float32 error. Small errors there only reorder which sky point a winding ray lands on. That is visually harmless, but it limits the GPU-vs-CPU tolerance near b_c, so the self-test should exclude a thin band around it, as the BBH self-test does at boundaries.
- **Disk dynamic range.** g⁴ makes the approaching side of an inclined disk tens of times brighter than the receding side, and the higher-order images are much fainter still. A tone map and exposure control are needed so all of them read on screen without washing out the sky.
- **Kerr cost.** Full geodesics may need several hundred steps per pixel. Budget it with the shared adaptive resolution, and fall back to fewer steps far from the hole.
- ~~**Rays near the spin axis.**~~ Resolved in 2a: the angular position is integrated as a unit vector, so nothing is singular on the axis.
- **Skimming the horizon at high spin.** At a = 0.998, escaping prograde rays pass within 1% of r₊, where φ′ (frame dragging) grows large. The step control's |φ′| term must keep these rays resolved; the close-in equatorial self-test view checks it.

## Open questions

- [x] Camera model for step 1: a static observer at 3.5–300 M (outside the photon sphere, so the planar escape logic holds). An orbiting or falling camera remains a "maybe later".
- [x] Integration variable and step control for the GPU, Schwarzschild: RK4 in φ, step min(0.02, ½u/|du/dφ|) ≥ 0.002; 3.3e-5 rad worst against the reference.
- [x] Kerr formulation: Boyer–Lindquist in Mino time with u = 1/r and the angular position as a unit vector (frame dragging split off as a rotation about z), for the shader and its mirror in Rust; a Kerr–Schild Hamiltonian as the independent reference. Confirmed in 2a.
- [ ] Default spin on load: 0 (the step 1 look, with the Einstein ring on load) or high (the D-shaped shadow shows at once)?
- [ ] Disk look: a smooth Novikov–Thorne profile only, or with procedural texture so the rotation and shearing are readable? If textured, animated?
- [ ] Disk default: on when the app loads, or off so the lensed sky comes first?
- [ ] Should the lensing app and the BBH app share one URL-parameter and panel style, or diverge?

## References

From memory, to verify before citing:

- Luminet, "Image of a spherical black hole with thin accretion disk", A&A 75, 228 (1979): the classic ray-traced Schwarzschild image.
- Bardeen (1973), the Kerr shadow ("Timelike and null geodesics in the Kerr metric").
- James, von Tunzelmann, Franklin & Thorne, "Gravitational lensing by spinning black holes in astrophysics, and in the movie Interstellar", Class. Quantum Grav. 32, 065001 (2015): camera model, ray bundles and anti-aliasing near the photon ring.
- Novikov & Thorne, "Astrophysics of black holes", in *Black Holes* (Les Houches 1973): the thin-disk model.
- Page & Thorne, "Disk-accretion onto a black hole. Time-averaged structure of accretion disk", ApJ 191, 499 (1974): the flux F(r).
- Bardeen, Press & Teukolsky, "Rotating black holes: locally nonrotating frames, energy extraction, and scalar synchrotron radiation", ApJ 178, 347 (1972): ISCO, circular-orbit Ω and uᵗ, the ZAMO frame.
- Carter, "Global structure of the Kerr family of gravitational fields", Phys. Rev. 174, 1559 (1968): separability, the Carter constant.
- Mino, "Perturbative approach to an orbital evolution around a supermassive black hole", Phys. Rev. D 67, 084027 (2003): Mino time.
- Gralla & Lupsasca, "Null geodesics of the Kerr exterior", Phys. Rev. D 101, 044032 (2020): closed-form Kerr geodesics; a possible third check.
- Chandrasekhar, *The Mathematical Theory of Black Holes* (1983): geodesics in Schwarzschild and Kerr.
