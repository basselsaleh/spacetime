//! Physics core for the spacetime visualizer.
//!
//! Pure Rust, `f64`, no GPU or web dependencies. Units are geometric with
//! total mass M = 1 (G = c = 1), so times and lengths are in units of M.
//!
//! Step 0 only contains a Newtonian placeholder used to prove the
//! Rust → wasm → WebGL pipeline. The real waveform model (IMRPhenomT/THM)
//! arrives in step 1.

pub mod newtonian;

/// Crate version, exposed so the web app can show which physics build it loaded.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
