//! On-disk format of the NRSur7dq4 data file (STSUR002).
//!
//! Layout (all little-endian):
//!
//! ```text
//! 8 bytes   magic "STSUR002"
//! u32       header length in bytes (H)
//! H bytes   UTF-8 JSON header (`Header`)
//! then three sections, each starting at a multiple of 8 bytes from the file
//! start (zero padding), with element counts in `Header::counts`:
//!   u32     packed basis-function orders (`PolyFit::orders`)
//!   f32     empirical-interpolation bases and polynomial coefficients
//!   f64     times and the remnant GPR data
//! ```
//!
//! Written by `tools/export_nrsur7dq4.py`; `tools/nrsur7dq4_ref.py` is the
//! reference reader and evaluator this module follows.

use serde::Deserialize;

pub const MAGIC: &[u8; 8] = b"STSUR002";

/// `[offset, len]` in elements of the section the field lives in.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Span(pub usize, pub usize);

#[derive(Debug, Deserialize)]
pub struct Header {
    pub model: String,
    pub attribution: String,
    pub counts: Counts,
    pub fit_settings: FitSettings,
    pub bounds: HeaderBounds,
    /// Dynamics nodes (f64), in M; the first 6 intervals are RK4 half steps.
    pub t_ds: Span,
    /// Co-orbital waveform time grid (f64), in M.
    pub t_coorb: Span,
    /// Per dynamics node, 9 fits: Ω_x, Ω_y (co-orbital rotation rate of the
    /// coprecessing frame), ω (orbital frequency), dχ_A/dt, dχ_B/dt
    /// (co-orbital components).
    pub dynamics: Vec<Vec<PolyFit>>,
    pub coorbital: Vec<Component>,
    #[serde(default)]
    pub remnant: Option<HeaderRemnant>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Counts {
    pub u32: usize,
    pub f32: usize,
    pub f64: usize,
}

/// Maps ln q to [−1, 1] for the q basis functions; maximum orders.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct FitSettings {
    pub q_fit_offset: f64,
    pub q_fit_slope: f64,
    pub q_max_order: usize,
    pub chi_max_order: usize,
}

/// Trained range (q, |χ|) and the range gwsurrogate allows as extrapolation.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct HeaderBounds {
    pub q: [f64; 2],
    pub chi: f64,
    pub q_extrap: f64,
    pub chi_extrap: f64,
}

/// Σ_i coef_i Π_j x_j^{o_ij}; the 7 orders of term i are packed base 4.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct PolyFit {
    /// u32 section.
    pub orders: Span,
    /// f32 section.
    pub coefs: Span,
}

/// One real co-orbital waveform component: `nodes · basis`, where node k is
/// `fits[k]` evaluated at the spins at time index `node_indices[k]`.
#[derive(Debug, Deserialize)]
pub struct Component {
    pub l: i32,
    pub m: i32,
    /// "real"/"imag" for m = 0; "Re+", "Re-", "Im+", "Im-" for m > 0.
    pub part: String,
    pub node_indices: Vec<usize>,
    /// f32 section, row-major `node_indices.len() × t_coorb.len()`.
    pub basis: Span,
    pub fits: Vec<PolyFit>,
}

/// NRSur7dq4Remnant (co-orbital frame at t = −100 M).
#[derive(Debug, Deserialize)]
pub struct HeaderRemnant {
    pub mf: Gpr,
    pub chif: [Gpr; 3],
    pub vf: [Gpr; 3],
}

/// `y(x) = scale · Σ_j w_j exp(−½|(x − X_j)/ℓ|²) + linear·x + offset`, 7 inputs.
#[derive(Debug, Deserialize)]
pub struct Gpr {
    /// f64 section, row-major `n × 7`.
    pub x_train: Span,
    /// f64 section, length `n`.
    pub weights: Span,
    pub inv_length_scale: [f64; 7],
    pub scale: f64,
    pub linear: [f64; 7],
    pub offset: f64,
}
