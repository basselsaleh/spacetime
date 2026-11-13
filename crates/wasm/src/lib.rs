//! Thin wasm-bindgen layer over `spacetime-physics`. Keep logic out of here:
//! anything worth testing belongs in the physics crate.

use wasm_bindgen::prelude::*;

/// Version of the physics crate this module was built from.
#[wasm_bindgen]
pub fn physics_version() -> String {
    spacetime_physics::version().to_string()
}

/// (2,2) gravitational-wave angular frequency for a Newtonian circular orbit
/// at the given separation (units of M). Placeholder until step 1.
#[wasm_bindgen]
pub fn newtonian_gw_omega_22(separation: f64) -> f64 {
    spacetime_physics::newtonian::gw_omega_22(separation)
}
