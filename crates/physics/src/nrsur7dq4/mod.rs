//! Evaluation of the NRSur7dq4 precessing numerical-relativity surrogate
//! (Varma et al., Phys. Rev. Research 1, 033015 (2019), arXiv:1905.09300)
//! and its NRSur7dq4Remnant fits, from the STSUR002 data file.
//!
//! The model has three parts:
//!
//! 1. **Dynamics.** An ODE for y = [quaternion of the coprecessing frame (4),
//!    orbital phase φ, χ_A (3), χ_B (3)] (spins in the coprecessing frame).
//!    At each node of `t_ds`, polynomial fits give the right-hand side from the
//!    current spins in the co-orbital frame. Three RK4 steps over the first six
//!    half-intervals start it, then AB4; after each step the quaternion is
//!    renormalized and the spins rescaled to their initial magnitudes.
//! 2. **Co-orbital waveform.** On the `t_coorb` grid, each real component is
//!    an empirical-interpolation basis weighted by polynomial fits evaluated at
//!    the co-orbital spins of its node times.
//! 3. **Frame rotation.** The co-orbital frame is the coprecessing frame
//!    turned by φ about its z-axis; Wigner-D matrices take the modes to the
//!    inertial frame.
//!
//! Units: total mass M = 1, t = 0 at the peak. Spins are given at the start
//! of the data (t ≈ −4300 M), in the co-orbital frame there: x from the
//! lighter to the heavier hole, z along the orbital angular momentum. The
//! inertial frame equals that frame unless an initial frame quaternion is
//! given. `tools/nrsur7dq4_ref.py` is the reference implementation.

mod format;
pub mod wigner;

use std::fmt;

use num_complex::Complex64;

use crate::quaternion::{self, Quat};
use crate::spline::NaturalCubicSpline;
pub use format::HeaderBounds as Bounds;
use format::{FitSettings, Gpr, MAGIC, PolyFit, Span};
pub use wigner::{N_MODES, mode_index};

/// Binary parameters: mass ratio q = m_A/m_B ≥ 1 and the dimensionless spin
/// vectors of the heavier (A) and lighter (B) holes at the start of the data,
/// in the co-orbital frame there.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Params {
    pub q: f64,
    pub chi_a: [f64; 3],
    pub chi_b: [f64; 3],
}

#[derive(Debug)]
pub enum Error {
    /// The data file is malformed.
    Format(String),
    /// Parameters outside the model's range.
    OutOfBounds(String),
    /// Requested times outside the model's time domain, or bad sampling.
    Time(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Format(s) => write!(f, "surrogate data: {s}"),
            Error::OutOfBounds(s) => write!(f, "parameters out of range: {s}"),
            Error::Time(s) => write!(f, "time sampling: {s}"),
        }
    }
}

impl std::error::Error for Error {}

/// The ODE solution on the full dynamics nodes (`t_ds` without its three
/// half-step nodes).
#[derive(Debug, Clone)]
pub struct Dynamics {
    pub t: Vec<f64>,
    /// Coprecessing frame.
    pub quat: Vec<Quat>,
    /// Orbital phase in the coprecessing frame.
    pub orbphase: Vec<f64>,
    /// Spins in the coprecessing frame.
    pub chi_a: Vec<[f64; 3]>,
    pub chi_b: Vec<[f64; 3]>,
}

/// Inertial-frame modes and the binary's frame and spins on a time grid.
#[derive(Debug, Clone)]
pub struct Waveform {
    pub t: Vec<f64>,
    /// Inertial frame: `h[mode_index(l, m)][i]`, all 21 modes with 2 ≤ l ≤ 4.
    pub h: Vec<Vec<Complex64>>,
    /// The same modes in the co-orbital frame, where they vary slowly.
    pub h_coorb: Vec<Vec<Complex64>>,
    /// Coprecessing frame (z along the orbital angular momentum).
    pub quat: Vec<Quat>,
    /// Orbital phase in the coprecessing frame: the co-orbital frame (x from
    /// the lighter to the heavier hole) is `quat · about_z(orbphase)`.
    pub orbphase: Vec<f64>,
    /// Spins in the inertial frame.
    pub chi_a: Vec<[f64; 3]>,
    pub chi_b: Vec<[f64; 3]>,
}

impl Waveform {
    pub fn len(&self) -> usize {
        self.t.len()
    }

    pub fn is_empty(&self) -> bool {
        self.t.is_empty()
    }

    /// Orbital angular frequency dφ/dt at each sample (central differences,
    /// one-sided at the ends).
    pub fn omega_orb(&self) -> Vec<f64> {
        let (p, t) = (&self.orbphase, &self.t);
        let n = p.len();
        (0..n)
            .map(|i| {
                let (a, b) = (i.saturating_sub(1), (i + 1).min(n - 1));
                (p[b] - p[a]) / (t[b] - t[a])
            })
            .collect()
    }

    /// The co-orbital frame at sample `i`.
    pub fn coorbital_frame(&self, i: usize) -> Quat {
        quaternion::mul(self.quat[i], quaternion::about_z(self.orbphase[i]))
    }
}

/// Final black hole (NRSur7dq4Remnant), vectors in the inertial frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Remnant {
    /// In units of the initial total mass.
    pub mass: f64,
    /// Dimensionless spin vector.
    pub spin: [f64; 3],
    /// Recoil velocity, units of c.
    pub kick: [f64; 3],
}

/// Time at which the remnant fits take their input spins.
pub const REMNANT_FIT_TIME: f64 = -100.0;

// ---------------------------------------------------------------- fits

/// Powers of the 7 fit inputs: q basis (rescaled ln q) up to order 3, χ up to 2.
type Powers = [[f64; 4]; 7];

#[derive(Debug, Clone)]
struct Poly {
    orders: Vec<[u8; 7]>,
    coefs: Vec<f64>,
}

impl Poly {
    /// Σ_i c_i Π_j x_j^{o_ij}, multiplied in gwsurrogate's order.
    fn eval(&self, pw: &Powers) -> f64 {
        let mut res = 0.0;
        for (o, c) in self.orders.iter().zip(&self.coefs) {
            let mut prod = pw[0][o[0] as usize];
            for j in 1..7 {
                prod *= pw[j][o[j] as usize];
            }
            res += c * prod;
        }
        res
    }
}

/// Fit inputs [ln q, χAx, χAy, χ̂, χBx, χBy, χa] from co-orbital spins;
/// χ̂ is Eq. (3) of arXiv:1508.07253 with the z-components, χa = (χAz − χBz)/2.
fn fit_params(q: f64, a: [f64; 3], b: [f64; 3]) -> [f64; 7] {
    let eta = q / (1.0 + q).powi(2);
    let chi_wt = (q * a[2] + b[2]) / (1.0 + q);
    let chi_hat = (chi_wt - 38.0 * eta / 113.0 * (a[2] + b[2])) / (1.0 - 76.0 * eta / 113.0);
    [q.ln(), a[0], a[1], chi_hat, b[0], b[1], 0.5 * (a[2] - b[2])]
}

fn powers(fs: &FitSettings, x: &[f64; 7]) -> Powers {
    let mut pw = [[1.0; 4]; 7];
    let qb = fs.q_fit_offset + fs.q_fit_slope * x[0];
    for k in 1..4 {
        pw[0][k] = pw[0][k - 1] * qb;
    }
    for j in 1..7 {
        for k in 1..4 {
            pw[j][k] = pw[j][k - 1] * x[j];
        }
    }
    pw
}

#[derive(Debug)]
struct LoadedGpr {
    x_train: Vec<[f64; 7]>,
    weights: Vec<f64>,
    inv_length_scale: [f64; 7],
    scale: f64,
    linear: [f64; 7],
    offset: f64,
}

impl LoadedGpr {
    fn eval(&self, x: &[f64; 7]) -> f64 {
        let mut sum = 0.0;
        for (xt, w) in self.x_train.iter().zip(&self.weights) {
            let mut d2 = 0.0;
            for k in 0..7 {
                let d = (x[k] - xt[k]) * self.inv_length_scale[k];
                d2 += d * d;
            }
            sum += w * (-0.5 * d2).exp();
        }
        let lin: f64 = (0..7).map(|k| self.linear[k] * x[k]).sum();
        self.scale * sum + lin + self.offset
    }
}

#[derive(Debug)]
struct LoadedRemnant {
    mf: LoadedGpr,
    chif: [LoadedGpr; 3],
    vf: [LoadedGpr; 3],
}

/// One real co-orbital component.
#[derive(Debug)]
struct LoadedComponent {
    l: i32,
    m: i32,
    part: Part,
    node_indices: Vec<usize>,
    /// Row-major, nodes × t_coorb.
    basis: Vec<f64>,
    fits: Vec<Poly>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Part {
    Real,
    Imag,
    RePlus,
    ReMinus,
    ImPlus,
    ImMinus,
}

// ---------------------------------------------------------------- loading

struct Sections<'a> {
    u32: &'a [u8],
    f32: &'a [u8],
    f64: &'a [u8],
}

fn slice<'a>(bytes: &'a [u8], span: Span, size: usize, what: &str) -> Result<&'a [u8], Error> {
    let Span(offset, len) = span;
    bytes
        .get(offset * size..(offset + len) * size)
        .ok_or_else(|| Error::Format(format!("{what} span {offset}+{len} outside its section")))
}

impl Sections<'_> {
    fn f64(&self, span: Span) -> Result<Vec<f64>, Error> {
        Ok(slice(self.f64, span, 8, "f64")?
            .as_chunks::<8>()
            .0
            .iter()
            .map(|c| f64::from_le_bytes(*c))
            .collect())
    }

    fn f32(&self, span: Span) -> Result<Vec<f64>, Error> {
        Ok(slice(self.f32, span, 4, "f32")?
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f64::from(f32::from_le_bytes(*c)))
            .collect())
    }

    fn poly(&self, f: &PolyFit, fs: &FitSettings) -> Result<Poly, Error> {
        let coefs = self.f32(f.coefs)?;
        let orders: Vec<[u8; 7]> = slice(self.u32, f.orders, 4, "u32")?
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| {
                let packed = u32::from_le_bytes(*c);
                std::array::from_fn(|j| ((packed >> (2 * j)) & 3) as u8)
            })
            .collect();
        if orders.len() != coefs.len() {
            return Err(Error::Format(
                "fit orders and coefficients differ in length".into(),
            ));
        }
        let bad = orders.iter().any(|o| {
            o[0] as usize > fs.q_max_order || o[1..].iter().any(|&k| k as usize > fs.chi_max_order)
        });
        if bad {
            return Err(Error::Format("basis-function order out of range".into()));
        }
        Ok(Poly { orders, coefs })
    }

    fn gpr(&self, g: &Gpr) -> Result<LoadedGpr, Error> {
        let flat = self.f64(g.x_train)?;
        let weights = self.f64(g.weights)?;
        if flat.len() != 7 * weights.len() {
            return Err(Error::Format("remnant x_train is not n × 7".into()));
        }
        Ok(LoadedGpr {
            x_train: flat.as_chunks::<7>().0.to_vec(),
            weights,
            inv_length_scale: g.inv_length_scale,
            scale: g.scale,
            linear: g.linear,
            offset: g.offset,
        })
    }
}

// ---------------------------------------------------------------- the model

/// A loaded NRSur7dq4 model.
#[derive(Debug)]
pub struct Nrsur7dq4 {
    model: String,
    attribution: String,
    bounds: Bounds,
    fit: FitSettings,
    t_ds: Vec<f64>,
    t_coorb: Vec<f64>,
    /// 9 fits per dynamics node.
    dynamics: Vec<[Poly; 9]>,
    components: Vec<LoadedComponent>,
    remnant: Option<LoadedRemnant>,
    wigner: wigner::Wigner,
}

type State = [f64; 11];

fn normalize_state(mut y: State, norm_a: f64, norm_b: f64) -> State {
    let qn = (y[0] * y[0] + y[1] * y[1] + y[2] * y[2] + y[3] * y[3]).sqrt();
    for v in &mut y[..4] {
        *v /= qn;
    }
    for (range, norm) in [(5..8, norm_a), (8..11, norm_b)] {
        let n = y[range.clone()].iter().map(|v| v * v).sum::<f64>().sqrt();
        for v in &mut y[range] {
            *v = if n > 0.0 { *v * norm / n } else { 0.0 };
        }
    }
    y
}

/// Adams–Bashforth 4 increment on a non-uniform grid (gwsurrogate `ab4_dy`).
#[allow(clippy::too_many_arguments)]
fn ab4_dy(
    k1: &State,
    k2: &State,
    k3: &State,
    k4: &State,
    dt1: f64,
    dt2: f64,
    dt3: f64,
    dt4: f64,
) -> State {
    let dt12 = dt1 + dt2;
    let dt123 = dt12 + dt3;
    let dt23 = dt2 + dt3;
    let d1 = dt1 * dt12 * dt123;
    let d2 = dt1 * dt2 * dt23;
    let d3 = dt2 * dt12 * dt3;
    let b41 = dt3 * dt23 / d1;
    let b42 = -dt3 * dt123 / d2;
    let b43 = dt23 * dt123 / d3;
    let b4 = b41 + b42 + b43;
    let c41 = (dt23 + dt3) / d1;
    let c42 = -(dt123 + dt3) / d2;
    let c43 = (dt123 + dt23) / d3;
    let c4 = c41 + c42 + c43;
    std::array::from_fn(|i| {
        let a = k4[i];
        let b = k4[i] * b4 - k1[i] * b41 - k2[i] * b42 - k3[i] * b43;
        let c = k4[i] * c4 - k1[i] * c41 - k2[i] * c42 - k3[i] * c43;
        let d = (k4[i] - k1[i]) / d1 - (k4[i] - k2[i]) / d2 + (k4[i] - k3[i]) / d3;
        dt4 * (a + dt4 * (0.5 * b + dt4 * (c / 3.0 + dt4 * 0.25 * d)))
    })
}

fn axpy(y: &State, h: f64, k: &State) -> State {
    std::array::from_fn(|i| y[i] + h * k[i])
}

/// Coprecessing → co-orbital components: rotate (x, y) by −φ.
fn to_coorbital(v: [f64; 3], c: f64, s: f64) -> [f64; 3] {
    [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]]
}

fn norm3(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

impl Nrsur7dq4 {
    /// Parses a data file produced by `tools/export_nrsur7dq4.py`.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() < 12 || &bytes[..8] != MAGIC {
            return Err(Error::Format("bad magic; not a STSUR002 file".into()));
        }
        let header_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let header_end = 12 + header_len;
        let header: format::Header = serde_json::from_slice(
            bytes
                .get(12..header_end)
                .ok_or_else(|| Error::Format("truncated header".into()))?,
        )
        .map_err(|e| Error::Format(format!("header JSON: {e}")))?;

        let mut pos = header_end;
        let mut take = |count: usize, size: usize| -> Result<&[u8], Error> {
            pos = pos.next_multiple_of(8);
            let s = bytes
                .get(pos..pos + count * size)
                .ok_or_else(|| Error::Format("truncated data section".into()))?;
            pos += count * size;
            Ok(s)
        };
        let c = header.counts;
        let sec = Sections {
            u32: take(c.u32, 4)?,
            f32: take(c.f32, 4)?,
            f64: take(c.f64, 8)?,
        };
        if pos != bytes.len() {
            return Err(Error::Format(
                "file length does not match the section counts".into(),
            ));
        }

        let fs = header.fit_settings;
        if fs.q_max_order > 3 || fs.chi_max_order > 3 {
            return Err(Error::Format(
                "basis-function orders above 3 are not supported".into(),
            ));
        }
        let t_ds = sec.f64(header.t_ds)?;
        let t_coorb = sec.f64(header.t_coorb)?;
        let increasing = |t: &[f64]| t.len() >= 8 && t.windows(2).all(|w| w[1] > w[0]);
        if !increasing(&t_ds) || !increasing(&t_coorb) {
            return Err(Error::Format("time grids must be increasing".into()));
        }
        let d: Vec<f64> = t_ds.windows(2).map(|w| w[1] - w[0]).collect();
        if (0..3).any(|i| d[2 * i] != d[2 * i + 1]) {
            return Err(Error::Format(
                "t_ds must start with three pairs of equal half steps".into(),
            ));
        }
        if header.dynamics.len() != t_ds.len() {
            return Err(Error::Format(
                "one set of dynamics fits per node expected".into(),
            ));
        }
        let dynamics = header
            .dynamics
            .iter()
            .map(|node| -> Result<[Poly; 9], Error> {
                let fits: Vec<Poly> = node
                    .iter()
                    .map(|f| sec.poly(f, &fs))
                    .collect::<Result<_, _>>()?;
                fits.try_into()
                    .map_err(|_| Error::Format("expected 9 dynamics fits per node".into()))
            })
            .collect::<Result<_, _>>()?;

        let n = t_coorb.len();
        let components = header
            .coorbital
            .iter()
            .map(|c| -> Result<LoadedComponent, Error> {
                let part = match c.part.as_str() {
                    "real" => Part::Real,
                    "imag" => Part::Imag,
                    "Re+" => Part::RePlus,
                    "Re-" => Part::ReMinus,
                    "Im+" => Part::ImPlus,
                    "Im-" => Part::ImMinus,
                    other => return Err(Error::Format(format!("unknown component part {other}"))),
                };
                if !(wigner::ELL_MIN..=wigner::ELL_MAX).contains(&c.l) || !(0..=c.l).contains(&c.m)
                {
                    return Err(Error::Format(format!(
                        "component ({}, {}) out of range",
                        c.l, c.m
                    )));
                }
                if c.node_indices.len() != c.fits.len()
                    || c.basis.1 != c.fits.len() * n
                    || c.node_indices.iter().any(|&i| i >= n)
                {
                    return Err(Error::Format(format!(
                        "component ({}, {}) {}: bad sizes",
                        c.l, c.m, c.part
                    )));
                }
                Ok(LoadedComponent {
                    l: c.l,
                    m: c.m,
                    part,
                    node_indices: c.node_indices.clone(),
                    basis: sec.f32(c.basis)?,
                    fits: c
                        .fits
                        .iter()
                        .map(|f| sec.poly(f, &fs))
                        .collect::<Result<_, _>>()?,
                })
            })
            .collect::<Result<_, _>>()?;

        let remnant = header
            .remnant
            .as_ref()
            .map(|r| -> Result<LoadedRemnant, Error> {
                Ok(LoadedRemnant {
                    mf: sec.gpr(&r.mf)?,
                    chif: [
                        sec.gpr(&r.chif[0])?,
                        sec.gpr(&r.chif[1])?,
                        sec.gpr(&r.chif[2])?,
                    ],
                    vf: [sec.gpr(&r.vf[0])?, sec.gpr(&r.vf[1])?, sec.gpr(&r.vf[2])?],
                })
            })
            .transpose()?;

        Ok(Self {
            model: header.model,
            attribution: header.attribution,
            bounds: header.bounds,
            fit: fs,
            t_ds,
            t_coorb,
            dynamics,
            components,
            remnant,
            wigner: wigner::Wigner::new(),
        })
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Credit line required by the data license; show it in the app.
    pub fn attribution(&self) -> &str {
        &self.attribution
    }

    /// Trained range and the extrapolation range the evaluator accepts.
    pub fn bounds(&self) -> Bounds {
        self.bounds
    }

    /// First and last time (in M) of the waveform.
    pub fn time_range(&self) -> (f64, f64) {
        (self.t_coorb[0], self.t_coorb[self.t_coorb.len() - 1])
    }

    /// The model's own (non-uniform) waveform time grid.
    pub fn coorbital_times(&self) -> &[f64] {
        &self.t_coorb
    }

    /// Accepts the extrapolation range (q ≤ 6, |χ| ≤ 1), like gwsurrogate.
    fn check(&self, p: &Params) -> Result<(), Error> {
        let b = &self.bounds;
        let tol = 1e-12;
        if !(p.q >= b.q[0] - tol && p.q <= b.q_extrap + tol) {
            return Err(Error::OutOfBounds(format!(
                "q = {} not in [{}, {}]",
                p.q, b.q[0], b.q_extrap
            )));
        }
        for (name, chi) in [("chi_a", p.chi_a), ("chi_b", p.chi_b)] {
            let n = norm3(chi);
            if n.is_nan() || n > b.chi_extrap + tol {
                return Err(Error::OutOfBounds(format!(
                    "|{name}| = {n} > {}",
                    b.chi_extrap
                )));
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ dynamics

    fn dydt(&self, q: f64, node: usize, y: &State) -> State {
        let (sp, cp) = y[4].sin_cos();
        let a = to_coorbital([y[5], y[6], y[7]], cp, sp);
        let b = to_coorbital([y[8], y[9], y[10]], cp, sp);
        let pw = powers(&self.fit, &fit_params(q, a, b));
        let f: [f64; 9] = std::array::from_fn(|k| self.dynamics[node][k].eval(&pw));
        let ox = f[0] * cp - f[1] * sp;
        let oy = f[0] * sp + f[1] * cp;
        [
            -0.5 * y[1] * ox - 0.5 * y[2] * oy,
            -0.5 * y[3] * oy + 0.5 * y[0] * ox,
            0.5 * y[3] * ox + 0.5 * y[0] * oy,
            0.5 * y[1] * oy - 0.5 * y[2] * ox,
            f[2],
            f[3] * cp - f[4] * sp,
            f[3] * sp + f[4] * cp,
            f[5],
            f[6] * cp - f[7] * sp,
            f[6] * sp + f[7] * cp,
            f[8],
        ]
    }

    /// Integrates the dynamics from the start of the data. `init_quat` is the
    /// coprecessing frame there (identity by default).
    pub fn dynamics(&self, p: Params, init_quat: Option<Quat>) -> Result<Dynamics, Error> {
        self.check(&p)?;
        let t = &self.t_ds;
        let dts: Vec<f64> = t.windows(2).map(|w| w[1] - w[0]).collect();
        let (norm_a, norm_b) = (norm3(p.chi_a), norm3(p.chi_b));
        let q0 = init_quat.map_or(quaternion::IDENTITY, quaternion::normalize);
        let mut y: Vec<State> = Vec::with_capacity(t.len() - 3);
        y.push([
            q0[0], q0[1], q0[2], q0[3], 0.0, p.chi_a[0], p.chi_a[1], p.chi_a[2], p.chi_b[0],
            p.chi_b[1], p.chi_b[2],
        ]);
        let q = p.q;

        // Three RK4 steps, each spanning two half-intervals of t_ds.
        let mut ks: Vec<State> = Vec::with_capacity(3);
        let mut hs: Vec<f64> = Vec::with_capacity(3);
        for i in 0..3 {
            let dt = dts[2 * i];
            let yi = y[i];
            let k1 = self.dydt(q, 2 * i, &yi);
            let k2 = self.dydt(q, 2 * i + 1, &axpy(&yi, dt, &k1));
            let k3 = self.dydt(q, 2 * i + 1, &axpy(&yi, dt, &k2));
            let k4 = self.dydt(q, 2 * i + 2, &axpy(&yi, 2.0 * dt, &k3));
            let next: State = std::array::from_fn(|j| {
                yi[j] + dt / 3.0 * (k1[j] + 2.0 * k2[j] + 2.0 * k3[j] + k4[j])
            });
            y.push(normalize_state(next, norm_a, norm_b));
            ks.push(k1);
            hs.push(2.0 * dt);
        }

        // AB4 over the remaining nodes.
        let (mut k1, mut k2, mut k3) = (ks[0], ks[1], ks[2]);
        let (mut dt1, mut dt2, mut dt3) = (hs[0], hs[1], hs[2]);
        for (i, &dt4) in dts[6..].iter().enumerate() {
            let j = 3 + i;
            let k4 = self.dydt(q, j + 3, &y[j]);
            let next = axpy(&y[j], 1.0, &ab4_dy(&k1, &k2, &k3, &k4, dt1, dt2, dt3, dt4));
            y.push(normalize_state(next, norm_a, norm_b));
            (k1, k2, k3) = (k2, k3, k4);
            (dt1, dt2, dt3) = (dt2, dt3, dt4);
        }

        let times: Vec<f64> = [t[0], t[2], t[4]]
            .into_iter()
            .chain(t[6..].iter().copied())
            .collect();
        debug_assert_eq!(times.len(), y.len());
        Ok(Dynamics {
            t: times,
            quat: y.iter().map(|s| [s[0], s[1], s[2], s[3]]).collect(),
            orbphase: y.iter().map(|s| s[4]).collect(),
            chi_a: y.iter().map(|s| [s[5], s[6], s[7]]).collect(),
            chi_b: y.iter().map(|s| [s[8], s[9], s[10]]).collect(),
        })
    }

    /// Dynamics resampled to `times` with natural cubic splines; spins
    /// rescaled to their magnitudes and the quaternion renormalized, as
    /// gwsurrogate does. Returns (quat, orbphase, χ_A, χ_B), coprecessing frame.
    #[allow(clippy::type_complexity)]
    fn resample_dynamics(
        dynm: &Dynamics,
        p: &Params,
        times: &[f64],
    ) -> (Vec<Quat>, Vec<f64>, Vec<[f64; 3]>, Vec<[f64; 3]>) {
        let column = |f: &dyn Fn(usize) -> f64| -> Vec<f64> {
            let vals: Vec<f64> = (0..dynm.t.len()).map(f).collect();
            NaturalCubicSpline::new(&dynm.t, &vals).eval_sorted(times)
        };
        let vec3 = |src: &Vec<[f64; 3]>, norm: f64| -> Vec<[f64; 3]> {
            let cols: [Vec<f64>; 3] = std::array::from_fn(|k| column(&|i| src[i][k]));
            (0..times.len())
                .map(|i| {
                    let v = [cols[0][i], cols[1][i], cols[2][i]];
                    let n = norm3(v);
                    if norm > 0.0 {
                        v.map(|c| c * norm / n)
                    } else {
                        v
                    }
                })
                .collect()
        };
        let qcols: [Vec<f64>; 4] = std::array::from_fn(|k| column(&|i| dynm.quat[i][k]));
        let quat = (0..times.len())
            .map(|i| quaternion::normalize([qcols[0][i], qcols[1][i], qcols[2][i], qcols[3][i]]))
            .collect();
        let orbphase = column(&|i| dynm.orbphase[i]);
        (
            quat,
            orbphase,
            vec3(&dynm.chi_a, norm3(p.chi_a)),
            vec3(&dynm.chi_b, norm3(p.chi_b)),
        )
    }

    // ------------------------------------------------------------ waveform

    /// Inertial-frame modes on the model's own grid (`coorbital_times`), with
    /// the dynamics resampled there. This is the exact model output.
    pub fn evaluate_sparse(
        &self,
        p: Params,
        init_quat: Option<Quat>,
    ) -> Result<(Waveform, Dynamics), Error> {
        let dynm = self.dynamics(p, init_quat)?;
        let tc = &self.t_coorb;
        let (quat, orbphase, chi_a, chi_b) = Self::resample_dynamics(&dynm, &p, tc);

        // Fit inputs at each co-orbital time index, computed on demand.
        let mut pw: Vec<Option<Powers>> = vec![None; tc.len()];
        let mut values: Vec<(i32, i32, Part, Vec<f64>)> = Vec::with_capacity(self.components.len());
        for c in &self.components {
            let mut out = vec![0.0; tc.len()];
            for (k, (&i, fit)) in c.node_indices.iter().zip(&c.fits).enumerate() {
                let pwi = pw[i].get_or_insert_with(|| {
                    let (s, co) = orbphase[i].sin_cos();
                    let a = to_coorbital(chi_a[i], co, s);
                    let b = to_coorbital(chi_b[i], co, s);
                    powers(&self.fit, &fit_params(p.q, a, b))
                });
                let node = fit.eval(pwi);
                let row = &c.basis[k * tc.len()..(k + 1) * tc.len()];
                for (o, b) in out.iter_mut().zip(row) {
                    *o += node * b;
                }
            }
            values.push((c.l, c.m, c.part, out));
        }
        let get = |l: i32, m: i32, part: Part| -> &[f64] {
            values
                .iter()
                .find(|v| v.0 == l && v.1 == m && v.2 == part)
                .map(|v| v.3.as_slice())
                .expect("component present (checked at load)")
        };

        let zero = Complex64::new(0.0, 0.0);
        let mut h = vec![vec![zero; tc.len()]; N_MODES];
        let mut h_coorb = vec![vec![zero; tc.len()]; N_MODES];
        for i in 0..tc.len() {
            let mut co = [zero; N_MODES];
            for l in wigner::ELL_MIN..=wigner::ELL_MAX {
                co[mode_index(l, 0)] =
                    Complex64::new(get(l, 0, Part::Real)[i], get(l, 0, Part::Imag)[i]);
                for m in 1..=l {
                    let (rp, rm) = (get(l, m, Part::RePlus)[i], get(l, m, Part::ReMinus)[i]);
                    let (ip, im) = (get(l, m, Part::ImPlus)[i], get(l, m, Part::ImMinus)[i]);
                    co[mode_index(l, m)] = Complex64::new(rp - rm, im - ip);
                    co[mode_index(l, -m)] = Complex64::new(rp + rm, ip + im);
                }
            }
            let frame = quaternion::mul(quat[i], quaternion::about_z(orbphase[i]));
            let inertial = self.wigner.rotate_modes(frame, &co);
            for (k, v) in inertial.into_iter().enumerate() {
                h[k][i] = v;
                h_coorb[k][i] = co[k];
            }
        }

        let to_inertial = |chi: &[[f64; 3]]| -> Vec<[f64; 3]> {
            chi.iter()
                .zip(&quat)
                .map(|(v, q)| quaternion::rotate(*q, *v))
                .collect()
        };
        let wf = Waveform {
            t: tc.clone(),
            h,
            h_coorb,
            chi_a: to_inertial(&chi_a),
            chi_b: to_inertial(&chi_b),
            quat,
            orbphase,
        };
        Ok((wf, dynm))
    }

    /// Inertial-frame modes and dynamics on `t_i = t_start + i·dt`, up to the
    /// end of the data (inclusive, within rounding).
    pub fn evaluate(
        &self,
        p: Params,
        init_quat: Option<Quat>,
        t_start: f64,
        dt: f64,
    ) -> Result<(Waveform, Dynamics), Error> {
        let (t_min, t_max) = self.time_range();
        if dt.is_nan() || dt <= 0.0 {
            return Err(Error::Time(format!("dt must be positive, got {dt}")));
        }
        if !(t_start >= t_min && t_start < t_max) {
            return Err(Error::Time(format!(
                "t_start = {t_start} not in [{t_min}, {t_max})"
            )));
        }
        let (sparse, dynm) = self.evaluate_sparse(p, init_quat)?;
        let n_out = ((t_max - t_start) / dt + 1e-9).floor() as usize + 1;
        let ts: Vec<f64> = (0..n_out).map(|i| t_start + dt * i as f64).collect();

        let resample = |modes: &[Vec<Complex64>]| -> Vec<Vec<Complex64>> {
            modes
                .iter()
                .map(|mode| {
                    let re: Vec<f64> = mode.iter().map(|z| z.re).collect();
                    let im: Vec<f64> = mode.iter().map(|z| z.im).collect();
                    let re = NaturalCubicSpline::new(&sparse.t, &re).eval_sorted(&ts);
                    let im = NaturalCubicSpline::new(&sparse.t, &im).eval_sorted(&ts);
                    re.into_iter()
                        .zip(im)
                        .map(|(a, b)| Complex64::new(a, b))
                        .collect()
                })
                .collect()
        };
        let h = resample(&sparse.h);
        let h_coorb = resample(&sparse.h_coorb);
        let (quat, orbphase, chi_a, chi_b) = Self::resample_dynamics(&dynm, &p, &ts);
        let to_inertial = |chi: &[[f64; 3]]| -> Vec<[f64; 3]> {
            chi.iter()
                .zip(&quat)
                .map(|(v, q)| quaternion::rotate(*q, *v))
                .collect()
        };
        let wf = Waveform {
            t: ts,
            h,
            h_coorb,
            chi_a: to_inertial(&chi_a),
            chi_b: to_inertial(&chi_b),
            quat,
            orbphase,
        };
        Ok((wf, dynm))
    }

    // ------------------------------------------------------------ display frame

    /// Orbital angular frequency at the start of the data (the dynamics
    /// surrogate's ω at its first node).
    pub fn initial_orbital_frequency(&self, p: Params) -> Result<f64, Error> {
        self.check(&p)?;
        let y0: State = [
            1.0, 0.0, 0.0, 0.0, 0.0, p.chi_a[0], p.chi_a[1], p.chi_a[2], p.chi_b[0], p.chi_b[1],
            p.chi_b[2],
        ];
        Ok(self.dydt(p.q, 0, &y0)[4])
    }

    /// The initial frame (`init_quat` for `evaluate`) that puts the total
    /// angular momentum J at the start of the data on +z, with the orbital
    /// angular momentum L̂ there in the x–z plane (x ≥ 0). Precession then
    /// sweeps L̂ around a nearly fixed vertical axis.
    ///
    /// J = L + m_A² χ_A + m_B² χ_B, with |L| from the 2PN orbital angular
    /// momentum of a circular orbit without spin terms (Blanchet, Living Rev.
    /// Rel. 17, 2 (2014); quoted from memory). This only chooses the axes; any
    /// constant rotation leaves the physics unchanged. For aligned spins it is
    /// the identity.
    pub fn display_frame(&self, p: Params) -> Result<Quat, Error> {
        let omega = self.initial_orbital_frequency(p)?;
        let (ma, mb) = (p.q / (1.0 + p.q), 1.0 / (1.0 + p.q));
        let eta = ma * mb;
        let x = omega.powf(2.0 / 3.0);
        let l = eta / x.sqrt()
            * (1.0
                + (1.5 + eta / 6.0) * x
                + (27.0 / 8.0 - 19.0 * eta / 8.0 + eta * eta / 24.0) * x * x);
        let j: [f64; 3] = std::array::from_fn(|k| {
            ma * ma * p.chi_a[k] + mb * mb * p.chi_b[k] + if k == 2 { l } else { 0.0 }
        });
        let tilt = quaternion::between(j, [0.0, 0.0, 1.0]);
        let lhat = quaternion::rotate(tilt, [0.0, 0.0, 1.0]);
        let azimuth = if lhat[0].hypot(lhat[1]) > 1e-12 {
            lhat[1].atan2(lhat[0])
        } else {
            0.0
        };
        Ok(quaternion::normalize(quaternion::mul(
            quaternion::about_z(-azimuth),
            tilt,
        )))
    }

    // ------------------------------------------------------------ remnant

    /// The NRSur7dq4Remnant fits themselves: spins in, and results out, in the
    /// co-orbital frame at t = −100 M. `None` if the file has no remnant data.
    pub fn remnant_coorbital(&self, q: f64, chi_a: [f64; 3], chi_b: [f64; 3]) -> Option<Remnant> {
        let r = self.remnant.as_ref()?;
        let x = fit_params(q, chi_a, chi_b);
        Some(Remnant {
            mass: r.mf.eval(&x),
            spin: std::array::from_fn(|k| r.chif[k].eval(&x)),
            kick: std::array::from_fn(|k| r.vf[k].eval(&x)),
        })
    }

    /// Final black hole in the inertial frame, from the co-orbital spins at
    /// the dynamics node nearest t = −100 M (as surfinBH does when it evolves
    /// the spins with NRSur7dq4).
    pub fn remnant(&self, p: Params, dynm: &Dynamics) -> Option<Remnant> {
        let i = Self::remnant_node(dynm);
        let (s, c) = dynm.orbphase[i].sin_cos();
        let a = to_coorbital(dynm.chi_a[i], c, s);
        let b = to_coorbital(dynm.chi_b[i], c, s);
        let r = self.remnant_coorbital(p.q, a, b)?;
        let frame = quaternion::mul(dynm.quat[i], quaternion::about_z(dynm.orbphase[i]));
        Some(Remnant {
            mass: r.mass,
            spin: quaternion::rotate(frame, r.spin),
            kick: quaternion::rotate(frame, r.kick),
        })
    }

    /// Index of the dynamics node nearest `REMNANT_FIT_TIME`.
    pub fn remnant_node(dynm: &Dynamics) -> usize {
        let mut best = 0;
        for (i, t) in dynm.t.iter().enumerate() {
            if (t - REMNANT_FIT_TIME).abs() < (dynm.t[best] - REMNANT_FIT_TIME).abs() {
                best = i;
            }
        }
        best
    }
}
