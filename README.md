# spacetime

Browser-based, real-time visualizations of extreme spacetimes, faithful to general
relativity where it counts. One web site, one app per page:

- **Binary black hole** (`/bbh/`): gravitational waves from a merging binary. Finished for
  now; plan: [plans/bbh.md](plans/bbh.md).
- **Black hole lensing** (`/lensing/`): light from a background sky bent around a black hole.
  In development; plan: [plans/lensing.md](plans/lensing.md).

## Layout

```
crates/physics/   Rust physics core (pure, f64, units of total mass M)
crates/wasm/      wasm-bindgen bindings over the physics crate
web/              TypeScript + Vite multi-page site (three.js): index.html (landing),
                  <app>/index.html per app, code in web/src/<app>/, shared code in web/src/common/
tools/            Python (uv): golden data from LAL, NR reference tables
tests/golden/     Small reference files used by the Rust tests
web/public/       Static data served to the app (trimmed waveform surrogate)
```

## Prerequisites

- Rust (via rustup) with the `wasm32-unknown-unknown` target
- wasm-pack
- Node.js 24+
- uv (only for `tools/`)

## Common commands

```sh
cargo test --workspace          # physics tests
cd web && npm install           # once
npm run dev                     # build wasm, start dev server
npm run build                   # production build into web/dist
cd tools && uv sync             # once, installs lalsuite and sxs
```

`npm run dev` rebuilds wasm only at startup; restart it after changing Rust code.

## Using the binary black hole app (`/bbh/`)

- The view is a slice through the source: the orbital plane from above, a side view, or any
  tilt in between ("⇄" animates between top and side). Drag to pan, scroll to zoom,
  double-click to reset; h₊/h× chooses the polarisation.
- "3D view" animates to an orbit camera showing the strain as a glowing volume (drag to orbit,
  scroll to zoom, double-click to reset); "Flat view" animates back.
- Click a slice to move the probe (the ring marker); its ring and chirp plot update.
- The sliders change the binary; the URL updates so the view can be shared.

## Binary black hole URL options (append to `/bbh/`)

- `?q=3&chi1=0.6&chi2=0.2`: binary parameters (q ≤ 8, |χ| ≤ 0.8)
- `?t=-300&zoom=250&tilt=40&paused`: start at a given time (M), half-width (M) and slice
  tilt (degrees), paused
- `?3d`: start in the 3D view
- `?selftest`: render off-screen and compare GPU pixels with the Rust CPU reference;
  the verdict appears in the page title and status line
- `?dev`: a temporary panel for tuning the look (colour map, saturation curve, near zone,
  horizons, probe, 3D guides) and comparing candidates; remembered in the browser

## Using the lensing app (`/lensing/`)

- A non-spinning black hole in front of a procedural sky, every pixel ray-traced through the
  curved spacetime. Drag to orbit; scroll or use the slider to change the distance (in units of
  the hole's mass M); widen the field of view when close; double-click to reset.
- URL options: `?r=20` (distance, 3.5–300 M), `?fov=60` (degrees), `?selftest` (GPU escape
  directions vs the Rust reference), `?lensbench` (GPU timing; needs real time, not
  `--virtual-time-budget`).

## Waveform data

The app evaluates the NRHybSur3dq8 numerical-relativity surrogate
(V. Varma et al., Phys. Rev. D 99, 064045 (2019), arXiv:1812.07865) and the
NRSur3dq8Remnant fits (arXiv:1809.09125). Their data is licensed CC BY 4.0
(doi:10.5281/zenodo.3348115, records 3348115 and 1435751); the trimmed copy in
`web/public/nrhybsur3dq8.stsur` is a derivative of it, and the app displays the
required attribution. The code in this repo is MIT.

The trimmed file and the golden test data are committed. To regenerate them:

```sh
cd tools
curl -L -o data/NRHybSur3dq8.h5 https://zenodo.org/record/3348115/files/NRHybSur3dq8.h5   # 213 MB
curl -L -o data/fit_3dq8.h5 https://zenodo.org/records/1435751/files/remnant_fits/fit_3dq8.h5  # 0.45 MB
uv run python export_surrogate.py data/NRHybSur3dq8.h5 ../web/public/nrhybsur3dq8.stsur --remnant data/fit_3dq8.h5
uv run python gen_golden.py data/NRHybSur3dq8.h5 ../tests/golden/nrhybsur3dq8.json
uv run python gen_remnant_golden.py data/fit_3dq8.h5 ../tests/golden/nrsur3dq8remnant.json
uv run python gen_orientation_golden.py data/NRHybSur3dq8.h5 ../tests/golden/orientation_lal.json
uv run python gen_harmonics_golden.py ../tests/golden/swsh_lal.json
```
