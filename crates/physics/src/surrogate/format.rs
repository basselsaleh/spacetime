//! On-disk format for a trimmed aligned-spin co-orbital surrogate.
//!
//! Layout (all little-endian):
//!
//! ```text
//! 8 bytes   magic "STSUR001"
//! u32       header length in bytes (H)
//! H bytes   UTF-8 JSON header (`Header`)
//! padding   zero bytes up to the next multiple of 8 from the file start
//! rest      f64 blob; every array in the header is an offset/length into it
//! ```
//!
//! Written by `tools/export_surrogate.py`. The exporter folds the Gaussian-
//! process normalisations into `scale`/`offset` so evaluation is one kernel sum.

use serde::Deserialize;

pub const MAGIC: &[u8; 8] = b"STSUR001";

/// A slice of the f64 blob: `[offset, len]` in units of f64 elements.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Span(pub usize, pub usize);

#[derive(Debug, Deserialize)]
pub struct Header {
    pub model: String,
    pub attribution: String,
    /// Sparse time samples of the surrogate domain, in M (peak at t = 0).
    pub time: Span,
    /// Reference time of the 0PN TaylorT3 phase that was subtracted before fitting.
    pub taylor_t3_t_ref: f64,
    /// Time at which that TaylorT3 phase is zeroed.
    pub phase_align_time: f64,
    pub bounds: HeaderBounds,
    pub amp22: Piece,
    pub phase22: Piece,
    pub modes: Vec<HeaderMode>,
    /// Optional NRSur3dq8Remnant fits (same fit coordinates as the waveform).
    #[serde(default)]
    pub remnant: Option<HeaderRemnant>,
}

/// Remnant mass and spin in units of the initial total mass; kick velocity
/// components (units of c) in the co-orbital frame at t = −100 M, whose x-axis
/// points from the lighter to the heavier black hole.
#[derive(Debug, Deserialize)]
pub struct HeaderRemnant {
    pub mf: Node,
    pub chifz: Node,
    pub vfx: Node,
    pub vfy: Node,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct HeaderBounds {
    pub q: [f64; 2],
    pub chi1: [f64; 2],
    pub chi2: [f64; 2],
}

/// One co-orbital mode other than (2,2), with m > 0 or m = 0.
/// A missing component is identically zero.
#[derive(Debug, Deserialize)]
pub struct HeaderMode {
    pub l: i32,
    pub m: i32,
    pub re: Option<Piece>,
    pub im: Option<Piece>,
}

/// One real function of time: `f(t_k) = Σ_n node_n(x) · basis[n][k]`.
#[derive(Debug, Deserialize)]
pub struct Piece {
    /// Row-major basis, `nodes.len()` rows by `time.1` columns.
    pub basis: Span,
    pub nodes: Vec<Node>,
}

/// Gaussian-process fit (constant × RBF kernel) plus a linear model:
/// `y(x) = scale · Σ_j w_j exp(-½|(x − X_j)/ℓ|²) + linear·x + offset`.
#[derive(Debug, Deserialize)]
pub struct Node {
    /// Training points, row-major `n × 3`.
    pub x_train: Span,
    /// Kernel weights (constant × alpha), length `n`.
    pub weights: Span,
    pub inv_length_scale: [f64; 3],
    pub scale: f64,
    pub linear: [f64; 3],
    pub offset: f64,
}
