# spacetime

A browser-based, real-time visualization of a binary black hole merger and its
gravitational waves, faithful to general relativity where it counts. See
[plan.md](plan.md) for the project plan.

## Layout

```
crates/physics/   Rust physics core (pure, f64, units of total mass M)
crates/wasm/      wasm-bindgen bindings over the physics crate
web/              TypeScript + Vite app, WebGL2 shaders in web/src/shaders/
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

## App URL options

- `?q=3&chi1=0.6&chi2=0.2`: binary parameters (q ≤ 8, |χ| ≤ 0.8)
- `?t=-300&zoom=250&paused`: start at a given time (M) and half-width (M), paused
- `?selftest`: render off-screen and compare GPU pixels with the Rust CPU reference;
  the verdict appears in the page title and status line

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
