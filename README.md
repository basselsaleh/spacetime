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
