//! Thin wasm-bindgen layer over `spacetime-physics`. Keep logic out of here:
//! anything worth testing belongs in the physics crate.

use spacetime_physics::binary::Binary;
use spacetime_physics::harmonics::spin_weighted_ylm_theta;
use spacetime_physics::mode_table::{ModeTable, equatorial_peak_22};
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

/// Real, θ-dependent part of ₛY_lm: ₛY_lm(θ, φ) = this · e^{imφ}.
#[wasm_bindgen(js_name = swshTheta)]
pub fn swsh_theta(s: i32, l: i32, m: i32, theta: f64) -> f64 {
    spin_weighted_ylm_theta(s, l, m, theta)
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

    /// Black-hole orbits and remnant for a waveform evaluated with the same
    /// parameters (it must start at or before t = −1000 M).
    pub fn binary(
        &self,
        q: f64,
        chi1: f64,
        chi2: f64,
        data: &WaveformData,
    ) -> Result<BinaryTrack, JsError> {
        let p = Params { q, chi1, chi2 };
        let remnant = self
            .0
            .remnant(p)
            .map_err(|e| JsError::new(&e.to_string()))?
            .ok_or_else(|| JsError::new("data file has no remnant fits"))?;
        Ok(BinaryTrack(Binary::new(&data.0, p, remnant)))
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

    /// ω₂₂ = dφ₂₂/dt at each sample.
    pub fn omega22(&self) -> Vec<f64> {
        self.0.omega22()
    }

    /// Peak r·|h₊| in the orbital plane from the (2,2) mode; the colour scale's unit.
    #[wasm_bindgen(js_name = equatorialPeak22)]
    pub fn equatorial_peak_22(&self) -> f64 {
        equatorial_peak_22(&self.0)
    }

    /// Packs the waveform for the strain shader (see `mode_table` in the physics crate).
    #[wasm_bindgen(js_name = modeTable)]
    pub fn mode_table(&self, width: usize) -> ModeTableData {
        ModeTableData(ModeTable::new(&self.0, width))
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

/// Waveform packed as an RG32F texture, plus a CPU reference of the shader.
#[wasm_bindgen]
pub struct ModeTableData(ModeTable);

#[wasm_bindgen]
impl ModeTableData {
    #[wasm_bindgen(getter)]
    pub fn t0(&self) -> f64 {
        self.0.t0
    }

    #[wasm_bindgen(getter)]
    pub fn dt(&self) -> f64 {
        self.0.dt
    }

    /// Samples per mode row.
    #[wasm_bindgen(getter)]
    pub fn samples(&self) -> usize {
        self.0.n
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> usize {
        self.0.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> usize {
        self.0.height()
    }

    /// Flat `[l0, m0, l1, m1, ...]`; row 0 is (2,2).
    pub fn rows(&self) -> Vec<i32> {
        self.0.rows.iter().flat_map(|&(l, m)| [l, m]).collect()
    }

    /// RG texel data, `width × height × 2` floats.
    pub fn data(&self) -> Vec<f32> {
        self.0.data.clone()
    }

    /// θ-dependence of the harmonics as RG texels (`rows × n_theta`); see
    /// `ModeTable::harmonic_table`.
    #[wasm_bindgen(js_name = harmonicTable)]
    pub fn harmonic_table(&self, n_theta: usize) -> Vec<f32> {
        self.0.harmonic_table(n_theta)
    }

    /// Interleaved `[r·h₊, r·h×, ...]` at every sample, as received in direction (θ, φ).
    #[wasm_bindgen(js_name = strainSeries)]
    pub fn strain_series(&self, theta: f64, phi: f64) -> Vec<f64> {
        self.0
            .strain_series(theta, phi)
            .iter()
            .flat_map(|z| [z.re, -z.im])
            .collect()
    }

    /// CPU reference: `[r·h₊, r·h×]` at retarded time `t_ret`, or NaNs outside the data.
    pub fn strain(&self, theta: f64, phi: f64, t_ret: f64) -> Vec<f64> {
        match self.0.strain(theta, phi, t_ret) {
            Some(z) => vec![z.re, -z.im],
            None => vec![f64::NAN, f64::NAN],
        }
    }
}

/// Black-hole discs over time, plus remnant properties.
#[wasm_bindgen]
pub struct BinaryTrack(Binary);

#[wasm_bindgen]
impl BinaryTrack {
    /// `[x, y, radius, opacity]` for the heavier hole, lighter hole and remnant (M).
    pub fn state(&self, t: f64) -> Vec<f64> {
        let s = self.0.state(t);
        [s.heavy, s.light, s.remnant]
            .iter()
            .flat_map(|d| [d.x, d.y, d.radius, d.opacity])
            .collect()
    }

    /// Final mass, in units of the initial total mass.
    #[wasm_bindgen(getter, js_name = remnantMass)]
    pub fn remnant_mass(&self) -> f64 {
        self.0.remnant.mass
    }

    /// Final dimensionless spin.
    #[wasm_bindgen(getter, js_name = remnantSpin)]
    pub fn remnant_spin(&self) -> f64 {
        self.0.remnant.spin
    }

    /// Recoil speed as a fraction of c.
    #[wasm_bindgen(getter, js_name = kickSpeed)]
    pub fn kick_speed(&self) -> f64 {
        let [x, y] = self.0.kick();
        x.hypot(y)
    }
}
