//! Physics core for the spacetime visualizer.
//!
//! Pure Rust, `f64`, no GPU or web dependencies. Units are geometric with
//! total mass M = 1 (G = c = 1), so times and lengths are in units of M.
//!
//! - [`nrsur7dq4`]: the NRSur7dq4 precessing numerical-relativity waveform
//!   model and its remnant fits.
//! - [`quaternion`]: frame rotations.
//! - [`spline`]: natural cubic splines used by the waveform model.
//! - [`binary`]: black-hole positions and remnant, derived from the waveform.
//! - [`geodesic`]: light rays around a Schwarzschild black hole (lensing app).
//! - [`harmonics`]: spin-weighted spherical harmonics.
//! - [`mode_table`]: GPU packing of a waveform, plus a CPU reference of the shader.
//! - [`newtonian`]: Newtonian placeholder relations (drives the step 0 demo field).

pub mod binary;
pub mod geodesic;
pub mod harmonics;
pub mod mode_table;
pub mod newtonian;
pub mod nrsur7dq4;
pub mod quaternion;
pub mod spline;

/// Crate version, exposed so the web app can show which physics build it loaded.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
