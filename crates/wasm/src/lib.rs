//! Thin wasm-bindgen layer over `spacetime-physics`. Keep logic out of here:
//! anything worth testing belongs in the physics crate.

use spacetime_physics::binary::Binary;
use spacetime_physics::harmonics::spin_weighted_ylm_theta;
use spacetime_physics::mode_table::{FRAME_ROWS, ModeTable, equatorial_peak_22};
use spacetime_physics::nrsur7dq4::{Nrsur7dq4, Params, Remnant, Waveform};
use spacetime_physics::{embedding, geodesic, kerr};
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

/// A loaded waveform model (NRSur7dq4 surrogate with its remnant fits).
#[wasm_bindgen]
pub struct WaveformModel(Nrsur7dq4);

fn vec3(v: &[f64], name: &str) -> Result<[f64; 3], JsError> {
    v.try_into()
        .map_err(|_| JsError::new(&format!("{name} must have 3 components")))
}

#[wasm_bindgen]
impl WaveformModel {
    /// Parses the `.stsur` data file fetched by the page.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<WaveformModel, JsError> {
        Nrsur7dq4::from_bytes(bytes)
            .map(WaveformModel)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    #[wasm_bindgen(getter)]
    pub fn model(&self) -> String {
        self.0.model().to_string()
    }

    /// Credit line required by the data license (CC BY 4.0).
    #[wasm_bindgen(getter)]
    pub fn attribution(&self) -> String {
        self.0.attribution().to_string()
    }

    /// `[q_min, q_max, chi_max, q_max_extrapolated, chi_max_extrapolated]`:
    /// the trained range, then the range the evaluator accepts.
    #[wasm_bindgen(getter)]
    pub fn bounds(&self) -> Vec<f64> {
        let b = self.0.bounds();
        vec![b.q[0], b.q[1], b.chi, b.q_extrap, b.chi_extrap]
    }

    /// `[t_min, t_max]` in M.
    #[wasm_bindgen(getter, js_name = timeRange)]
    pub fn time_range(&self) -> Vec<f64> {
        let (a, b) = self.0.time_range();
        vec![a, b]
    }

    /// The initial frame (`[w, x, y, z]`) that puts the total angular momentum
    /// at the start of the data on +z, with L̂ there in the x–z plane; pass it
    /// to `evaluate` as `init_quat`. The identity for aligned spins.
    #[wasm_bindgen(js_name = displayFrame)]
    pub fn display_frame(&self, q: f64, chi_a: &[f64], chi_b: &[f64]) -> Result<Vec<f64>, JsError> {
        let p = Params {
            q,
            chi_a: vec3(chi_a, "chi_a")?,
            chi_b: vec3(chi_b, "chi_b")?,
        };
        self.0
            .display_frame(p)
            .map(|f| f.to_vec())
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Evaluates the binary on a uniform grid from `t_start` (M) with step `dt`.
    /// Spins (`[x, y, z]`, heavier hole A, lighter hole B) are given at the
    /// start of the data in the co-orbital frame there; `init_quat`
    /// (`[w, x, y, z]`, or empty for the identity) is the coprecessing frame
    /// there, which sets the display frame.
    pub fn evaluate(
        &self,
        q: f64,
        chi_a: &[f64],
        chi_b: &[f64],
        init_quat: &[f64],
        t_start: f64,
        dt: f64,
    ) -> Result<WaveformData, JsError> {
        let p = Params {
            q,
            chi_a: vec3(chi_a, "chi_a")?,
            chi_b: vec3(chi_b, "chi_b")?,
        };
        let frame = match init_quat.len() {
            0 => None,
            4 => Some([init_quat[0], init_quat[1], init_quat[2], init_quat[3]]),
            _ => return Err(JsError::new("init_quat must be empty or have 4 components")),
        };
        let (wf, dynm) = self
            .0
            .evaluate(p, frame, t_start, dt)
            .map_err(|e| JsError::new(&e.to_string()))?;
        let remnant = self
            .0
            .remnant(p, &dynm)
            .ok_or_else(|| JsError::new("data file has no remnant fits"))?;
        Ok(WaveformData { wf, p, remnant })
    }
}

/// An evaluated binary: modes, frame dynamics and remnant.
#[wasm_bindgen]
pub struct WaveformData {
    wf: Waveform,
    p: Params,
    remnant: Remnant,
}

#[wasm_bindgen]
impl WaveformData {
    #[wasm_bindgen(getter)]
    pub fn t0(&self) -> f64 {
        self.wf.t[0]
    }

    #[wasm_bindgen(getter)]
    pub fn dt(&self) -> f64 {
        self.wf.t[1] - self.wf.t[0]
    }

    #[wasm_bindgen(getter)]
    pub fn length(&self) -> usize {
        self.wf.len()
    }

    /// Twice the orbital angular frequency, 2 dΦ/dt (≈ ω₂₂), at each sample.
    pub fn omega22(&self) -> Vec<f64> {
        self.wf.omega_orb().iter().map(|w| 2.0 * w).collect()
    }

    /// Peak r·|h₊| in the orbital plane from the (2,±2) modes; the color scale's unit.
    #[wasm_bindgen(js_name = equatorialPeak22)]
    pub fn equatorial_peak_22(&self) -> f64 {
        equatorial_peak_22(&self.wf)
    }

    /// Packs the waveform for the strain shader (see `mode_table` in the physics crate).
    #[wasm_bindgen(js_name = modeTable)]
    pub fn mode_table(&self, width: usize) -> ModeTableData {
        ModeTableData(ModeTable::new(&self.wf, width))
    }

    /// Black-hole orbits and remnant.
    pub fn binary(&self) -> BinaryTrack {
        BinaryTrack(Binary::new(&self.wf, self.p, self.remnant))
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

    /// Samples per row.
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

    /// Rows before the first mode row (frame quaternion and orbital phase).
    #[wasm_bindgen(getter, js_name = frameRows)]
    pub fn frame_rows(&self) -> usize {
        FRAME_ROWS
    }

    /// Mode rows forming the three strongest (l, ±m) groups.
    #[wasm_bindgen(getter, js_name = leadingRows)]
    pub fn leading_rows(&self) -> usize {
        self.0.leading3
    }

    /// Flat `[l0, m0, l1, m1, ...]` of the mode rows.
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

    /// Interleaved `[r·h₊, r·h×, ...]` at every sample, as received in direction (x, y, z).
    #[wasm_bindgen(js_name = strainSeries)]
    pub fn strain_series(&self, x: f64, y: f64, z: f64) -> Vec<f64> {
        self.0
            .strain_series([x, y, z])
            .iter()
            .flat_map(|h| [h.re, -h.im])
            .collect()
    }

    /// CPU reference: `[r·h₊, r·h×]` at retarded time `t_ret` in direction
    /// (x, y, z), or NaNs outside the data.
    pub fn strain(&self, x: f64, y: f64, z: f64, t_ret: f64) -> Vec<f64> {
        match self.0.strain([x, y, z], t_ret) {
            Some(h) => vec![h.re, -h.im],
            None => vec![f64::NAN, f64::NAN],
        }
    }
}

/// Black holes over time, plus remnant properties.
#[wasm_bindgen]
pub struct BinaryTrack(Binary);

#[wasm_bindgen]
impl BinaryTrack {
    /// `[x, y, z, radius, opacity]` for the heavier hole, lighter hole and remnant (M).
    pub fn state(&self, t: f64) -> Vec<f64> {
        let s = self.0.state(t);
        [s.heavy, s.light, s.remnant]
            .iter()
            .flat_map(|d| [d.x, d.y, d.z, d.radius, d.opacity])
            .collect()
    }

    /// `[x, y, z]`: direction of the orbital angular momentum at time t.
    #[wasm_bindgen(js_name = orbitalAxis)]
    pub fn orbital_axis(&self, t: f64) -> Vec<f64> {
        self.0.orbital_axis(t).to_vec()
    }

    /// `[ax, ay, az, bx, by, bz]`: dimensionless spins of the heavier (A) and
    /// lighter (B) holes at time t.
    pub fn spins(&self, t: f64) -> Vec<f64> {
        let (a, b) = self.0.spins(t);
        [a, b].concat()
    }

    /// `[x, y, z]`: the final dimensionless spin vector.
    #[wasm_bindgen(getter, js_name = remnantSpinVector)]
    pub fn remnant_spin_vector(&self) -> Vec<f64> {
        self.0.remnant.spin.to_vec()
    }

    /// Final mass, in units of the initial total mass.
    #[wasm_bindgen(getter, js_name = remnantMass)]
    pub fn remnant_mass(&self) -> f64 {
        self.0.remnant.mass
    }

    /// Magnitude of the final dimensionless spin.
    #[wasm_bindgen(getter, js_name = remnantSpin)]
    pub fn remnant_spin(&self) -> f64 {
        let [x, y, z] = self.0.remnant.spin;
        (x * x + y * y + z * z).sqrt()
    }

    /// Recoil speed as a fraction of c.
    #[wasm_bindgen(getter, js_name = kickSpeed)]
    pub fn kick_speed(&self) -> f64 {
        let [x, y, z] = self.0.kick();
        (x * x + y * y + z * z).sqrt()
    }
}

/// Lensing self-test reference: for a camera at `cam` (x, y, z; |cam| > 3 M)
/// and ray directions `dirs` (flat x, y, z, ...), returns flat
/// `[sx, sy, sz, escaped, ...]`: the sky direction each ray reaches, and 1, or
/// zeros and 0 if it falls into the hole (Schwarzschild, M = 1).
#[wasm_bindgen(js_name = lensEscapeDirections)]
pub fn lens_escape_directions(cam: &[f64], dirs: &[f64]) -> Vec<f64> {
    let cam = [cam[0], cam[1], cam[2]];
    dirs.as_chunks::<3>()
        .0
        .iter()
        .flat_map(|d| match geodesic::escape_direction(cam, *d) {
            Some(s) => [s[0], s[1], s[2], 1.0],
            None => [0.0, 0.0, 0.0, 0.0],
        })
        .collect()
}

/// Angular radius (rad) of the Schwarzschild shadow seen by a static observer at `r0` (> 3 M).
#[wasm_bindgen(js_name = shadowAngularRadius)]
pub fn shadow_angular_radius(r0: f64) -> f64 {
    geodesic::shadow_angular_radius(r0)
}

/// Kerr lensing self-test reference: for a zero-angular-momentum camera at
/// `cam` around a hole of spin `a`, and ray directions `dirs` (flat x, y, z,
/// ...), returns flat `[sx, sy, sz, escaped, ...]` as `lensEscapeDirections`
/// does (`kerr::escape_direction`).
#[wasm_bindgen(js_name = lensKerrEscapeDirections)]
pub fn lens_kerr_escape_directions(cam: &[f64], a: f64, dirs: &[f64]) -> Vec<f64> {
    let cam = [cam[0], cam[1], cam[2]];
    dirs.as_chunks::<3>()
        .0
        .iter()
        .flat_map(|d| match kerr::escape_direction(cam, a, *d) {
            Some(s) => [s[0], s[1], s[2], 1.0],
            None => [0.0, 0.0, 0.0, 0.0],
        })
        .collect()
}

/// The exact edge of the shadow seen by a zero-angular-momentum camera at
/// `cam` around a hole of spin `a`: about `n` pixel directions (flat x, y, z, ...).
#[wasm_bindgen(js_name = lensShadowEdge)]
pub fn lens_shadow_edge(cam: &[f64], a: f64, n: usize) -> Vec<f64> {
    kerr::shadow_edge([cam[0], cam[1], cam[2]], a, n)
        .into_iter()
        .flatten()
        .collect()
}

/// Curvature self-test reference: the embedding of a slice at `radii`
/// (increasing, outside the horizon), as flat `[height..., distance..., curvature...]`.
/// `slice` is `"schwarzschild"` (more in step 2).
#[wasm_bindgen(js_name = curvatureProfile)]
pub fn curvature_profile(slice: &str, radii: &[f64]) -> Result<Vec<f64>, JsError> {
    let p = match slice {
        "schwarzschild" => embedding::profile(&embedding::Schwarzschild, radii),
        _ => return Err(JsError::new(&format!("unknown slice {slice}"))),
    }
    .map_err(|e| JsError::new(&e.to_string()))?;
    Ok([p.height, p.distance, p.curvature].concat())
}
