# Development

## Layout

```
crates/physics/   Rust physics core (pure, f64, units of total mass M)
crates/wasm/      wasm-bindgen bindings over the physics crate
web/              TypeScript + Vite multi-page site (three.js): index.html (landing),
                  <app>/index.html per app, code in web/src/<app>/, shared code in web/src/common/
web/public/       Static files served as-is: the trimmed waveform model (NRSur7dq4), the logo
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

- `?q=3&chi1=0.6&chi2=0.2`: binary parameters (q ≤ 4, |χ| ≤ 0.8). A spin is one number (along
  the orbital axis L̂; negative = anti-aligned) or `x,y,z` in the co-orbital frame at the start
  of the data (t ≈ −4300 M; z along L̂, x toward the heavier hole), e.g. `?q=4&chi1=0.8,0,0`
- `?t=-300&zoom=250&tilt=40&paused`: start at a given time (M), half-width (M) and slice tilt
  (degrees), paused
- `?3d`: start in the 3D view
- `?selftest`: render off-screen and compare GPU pixels with the Rust CPU reference, for the URL's
  binary and a precessing one; the verdict appears in the page title and status line
- `?volbench`: GPU timing of the 3D volume (needs real time; see below)
- `?vdensity=0.035&vsharp=8`: tuning knobs for the volume's look

Black hole lensing (`/lensing/`):

- `?r=40` (distance, 3.5–300 M; default 40), `?fov=60` (degrees; default 60)
- `?a=0.9`: spin a/M (0–0.998; default 0)
- `?selftest`: GPU escape directions vs the Rust reference, at spin 0 (both integrators) and at
  spins 0.5 and 0.998
- `?lensbench`: GPU timing at spins 0 (both integrators), 0.5 and 0.998 (needs real time)

Curvature (`/curvature/`):

- `?grid=cartesian|polar|proper` (default cartesian), `?rmax=30` (outer radius, 6–150 M)
- `?probe=12`: measure the circle at r = 12 M; `?flat`: show the flat comparison grid
- `?selftest`: the TypeScript embedding vs the Rust reference and Flamm's closed forms

## GPU self-tests and screenshots (headless Chrome on macOS)

```sh
cd web && npm run build && npx vite preview --port 4173 &
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FLAGS="--headless=new --use-angle=metal --enable-gpu --ignore-gpu-blocklist"
"$CHROME" $FLAGS --virtual-time-budget=8000 --dump-dom "http://localhost:4173/bbh/?selftest" | grep -o "<title>[^<]*</title>"
"$CHROME" $FLAGS --virtual-time-budget=8000 --dump-dom "http://localhost:4173/lensing/?selftest" | grep -o "<title>[^<]*</title>"
"$CHROME" $FLAGS --virtual-time-budget=8000 --dump-dom "http://localhost:4173/curvature/?selftest" | grep -o "<title>[^<]*</title>"
"$CHROME" $FLAGS --window-size=1440,900 --force-device-scale-factor=1 \
  --virtual-time-budget=12000 --screenshot=out.png "http://localhost:4173/bbh/?paused&t=-400&3d"
```

- Use `--use-angle=metal` for the real GPU; SwiftShader's float arithmetic is less accurate.
- `--force-device-scale-factor=1` keeps screenshots at the window size on scaled displays.
- Headless windows are at least 500 px wide; a narrower `--window-size` crops a 500 px layout.
- `--virtual-time-budget` freezes `performance.now()` during synchronous work, so the benchmarks
  need real time: run headless with `--remote-debugging-port=9333 --user-data-dir=<tmp>` and poll
  `curl -s localhost:9333/json` for the page title.

## Waveform data

The waveform model is NRSur7dq4 with its NRSur7dq4Remnant fits, trimmed and packed into
`web/public/nrsur7dq4.stsur` (the STSUR002 format, which `tools/nrsur7dq4_ref.py` documents and
evaluates in plain NumPy; `crates/physics/src/nrsur7dq4/` reads it). The file and the golden test
data are committed. To regenerate them:

```sh
cd tools
curl -L -o data/NRSur7dq4.h5 https://zenodo.org/records/3348115/files/NRSur7dq4.h5   # 17.5 MB
curl -L -o data/fit_7dq4.h5 https://zenodo.org/records/3455886/files/remnant_fits/fit_7dq4.h5  # 132 MB
uv run python export_nrsur7dq4.py data/NRSur7dq4.h5 ../web/public/nrsur7dq4.stsur --remnant data/fit_7dq4.h5
uv run python compare_nrsur7dq4.py data/NRSur7dq4.h5 data/fit_7dq4.h5 ../web/public/nrsur7dq4.stsur
uv run python gen_golden_nrsur7dq4.py data/NRSur7dq4.h5 data/fit_7dq4.h5 ../tests/golden/nrsur7dq4.json
uv run python gen_orientation_golden.py data/NRSur7dq4.h5 ../tests/golden/orientation_lal.json
uv run python gen_harmonics_golden.py ../tests/golden/swsh_lal.json
uv run python proto_precession.py ../web/public/nrsur7dq4.stsur   # figures and animations in out/
```

The data is CC BY 4.0; the attribution travels inside the `.stsur` file and the app shows it.

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
