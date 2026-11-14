# Development

## Layout

```
crates/physics/   Rust physics core (pure, f64, units of total mass M)
crates/wasm/      wasm-bindgen bindings over the physics crate
web/              TypeScript + Vite multi-page site (three.js): index.html (landing),
                  <app>/index.html per app, code in web/src/<app>/, shared code in web/src/common/
web/public/       Static files served as-is: the trimmed waveform surrogate, the logo
tools/            Python (uv): golden data from LAL, NR reference tables
tests/golden/     Small reference files used by the Rust tests
docs/             This file and the README's images
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
npm run build                   # wasm + typecheck + production build into web/dist
cd tools && uv sync             # once, installs lalsuite and sxs
```

`npm run dev` rebuilds wasm only at startup; restart it after changing Rust code.

CI (`.github/workflows/ci.yml`) runs `cargo fmt --check`, `clippy -D warnings`, `cargo test` and
`npm run build` on pushes to `main` and on pull requests.

## URL options

Gravitational waves (`/bbh/`):

- `?q=3&chi1=0.6&chi2=0.2`: binary parameters (q ≤ 8, |χ| ≤ 0.8)
- `?t=-300&zoom=250&tilt=40&paused`: start at a given time (M), half-width (M) and slice tilt
  (degrees), paused
- `?3d`: start in the 3D view
- `?selftest`: render off-screen and compare GPU pixels with the Rust CPU reference; the verdict
  appears in the page title and status line
- `?volbench`: GPU timing of the 3D volume (needs real time; see below)
- `?vdensity=0.035&vsharp=8`: tuning knobs for the volume's look

Black hole lensing (`/lensing/`):

- `?r=40` (distance, 3.5–300 M; default 40), `?fov=60` (degrees; default 60)
- `?selftest`: GPU escape directions vs the Rust reference
- `?lensbench`: GPU timing (needs real time)

## GPU self-tests and screenshots (headless Chrome on macOS)

```sh
cd web && npm run build && npx vite preview --port 4173 &
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FLAGS="--headless=new --use-angle=metal --enable-gpu --ignore-gpu-blocklist"
"$CHROME" $FLAGS --virtual-time-budget=8000 --dump-dom "http://localhost:4173/bbh/?selftest" | grep -o "<title>[^<]*</title>"
"$CHROME" $FLAGS --virtual-time-budget=8000 --dump-dom "http://localhost:4173/lensing/?selftest" | grep -o "<title>[^<]*</title>"
"$CHROME" $FLAGS --window-size=1440,900 --force-device-scale-factor=1 \
  --virtual-time-budget=12000 --screenshot=out.png "http://localhost:4173/bbh/?paused&t=-400&3d"
```

- Use `--use-angle=metal` for the real GPU; SwiftShader's float arithmetic is less accurate.
- `--force-device-scale-factor=1` keeps screenshots at the window size on scaled displays.
- `--virtual-time-budget` freezes `performance.now()` during synchronous work, so the benchmarks
  need real time: run headless with `--remote-debugging-port=9333 --user-data-dir=<tmp>` and poll
  `curl -s localhost:9333/json` for the page title.

## Waveform data

The trimmed surrogate (`web/public/nrhybsur3dq8.stsur`) and the golden test data are committed.
To regenerate them:

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

The data is CC BY 4.0; the attribution travels inside the `.stsur` file and the app shows it.

### NRSur7dq4 (precessing spins, in progress)

The precessing model that will replace NRHybSur3dq8 is exported to the STSUR002 format, which
`tools/nrsur7dq4_ref.py` documents and evaluates in plain NumPy:

```sh
cd tools
curl -L -o data/NRSur7dq4.h5 https://zenodo.org/records/3348115/files/NRSur7dq4.h5   # 17.5 MB
curl -L -o data/fit_7dq4.h5 https://zenodo.org/records/3455886/files/remnant_fits/fit_7dq4.h5  # 132 MB
uv run python export_nrsur7dq4.py data/NRSur7dq4.h5 out/nrsur7dq4.stsur --remnant data/fit_7dq4.h5
uv run python compare_nrsur7dq4.py data/NRSur7dq4.h5 data/fit_7dq4.h5 out/nrsur7dq4.stsur
uv run python gen_golden_nrsur7dq4.py data/NRSur7dq4.h5 data/fit_7dq4.h5 ../tests/golden/nrsur7dq4.json
uv run python proto_precession.py out/nrsur7dq4.stsur   # figures and animations in out/
```

## Planning documents

Plans live on the `dev` branch, which holds only those files and is never merged into `main`.
Check it out into a `plans/` folder inside your clone (ignored by `main`):

```sh
git fetch origin dev
git worktree add plans dev      # once per clone
```

Then edit and commit inside `plans/` as on any branch (`git -C plans commit …`, `git -C plans push`).

## Deployment

`.github/workflows/pages.yml` builds the site and deploys it to GitHub Pages on every push to
`main` (or by hand from the Actions tab). The build uses relative paths (`base: "./"` in
`web/vite.config.ts`), so it works under the `/spacetime/` prefix.
