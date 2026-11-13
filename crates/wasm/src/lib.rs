//! Thin wasm-bindgen layer over `spacetime-physics`. Keep logic out of here:
//! anything worth testing belongs in the physics crate.

use spacetime_physics::surrogate::{Params, Surrogate, Waveform};
use wasm_bindgen::prelude::*;

/// Version of the physics crate this module was built from.
#[wasm_bindgen]
pub fn physics_version() -> String {
    spacetime_physics::version().to_string()
}

/// (2,2) gravitational-wave angular frequency for a Newtonian circular orbit
/// at the given separation (units of M). Placeholder until step 3.
#[wasm_bindgen]
pub fn newtonian_gw_omega_22(separation: f64) -> f64 {
    spacetime_physics::newtonian::gw_omega_22(separation)
}

/// A loaded waveform model (NRHybSur3dq8 surrogate).
#[wasm_bindgen]
pub struct WaveformModel(Surrogate);

#[wasm_bindgen]
impl WaveformModel {
    /// Parses the `.stsur` data file fetched by the page.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<WaveformModel, JsError> {
        Surrogate::from_bytes(bytes)
            .map(WaveformModel)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(getter)]
    pub fn model(&self) -> String {
        self.0.model().to_string()
    }

    /// Credit line required by the data licence (CC BY 4.0).
    #[wasm_bindgen(getter)]
    pub fn attribution(&self) -> String {
        self.0.attribution().to_string()
    }

    /// `[q_min, q_max, chi1_min, chi1_max, chi2_min, chi2_max]`.
    #[wasm_bindgen(getter)]
    pub fn bounds(&self) -> Vec<f64> {
        let b = self.0.bounds();
        [b.q, b.chi1, b.chi2].concat()
    }

    /// `[t_min, t_max]` in M.
    #[wasm_bindgen(getter, js_name = timeRange)]
    pub fn time_range(&self) -> Vec<f64> {
        let (a, b) = self.0.time_range();
        vec![a, b]
    }

    /// Evaluates all modes on a uniform grid from `t_start` (M) with step `dt`.
    pub fn evaluate(
        &self,
        q: f64,
        chi1: f64,
        chi2: f64,
        t_start: f64,
        dt: f64,
    ) -> Result<WaveformData, JsError> {
        self.0
            .evaluate(Params { q, chi1, chi2 }, t_start, dt)
            .map(WaveformData)
            .map_err(|e| JsError::new(&e.to_string()))
    }
}

/// Waveform samples in the co-orbital representation the shaders consume.
#[wasm_bindgen]
pub struct WaveformData(Waveform);

#[wasm_bindgen]
impl WaveformData {
    #[wasm_bindgen(getter)]
    pub fn t0(&self) -> f64 {
        self.0.t0
    }

    #[wasm_bindgen(getter)]
    pub fn dt(&self) -> f64 {
        self.0.dt
    }

    #[wasm_bindgen(getter)]
    pub fn length(&self) -> usize {
        self.0.len()
    }

    /// |h₂₂| at each sample.
    #[wasm_bindgen(js_name = amp22)]
    pub fn amp22(&self) -> Vec<f64> {
        self.0.amp22.clone()
    }

    /// φ₂₂ with h₂₂ = A₂₂ e^{−iφ₂₂}.
    #[wasm_bindgen(js_name = phase22)]
    pub fn phase22(&self) -> Vec<f64> {
        self.0.phase22.clone()
    }

    /// Co-orbital modes other than (2,2), as flat `[l0, m0, l1, m1, ...]`.
    #[wasm_bindgen(js_name = coorbitalModes)]
    pub fn coorbital_modes(&self) -> Vec<i32> {
        self.0.coorbital.iter().flat_map(|c| [c.l, c.m]).collect()
    }

    /// Interleaved `[re, im, re, im, ...]` for the i-th co-orbital mode.
    #[wasm_bindgen(js_name = coorbitalData)]
    pub fn coorbital_data(&self, index: usize) -> Vec<f64> {
        self.0
            .coorbital
            .get(index)
            .map(|c| c.data.iter().flat_map(|z| [z.re, z.im]).collect())
            .unwrap_or_default()
    }
}
