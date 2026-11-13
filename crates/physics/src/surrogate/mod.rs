//! Evaluation of the NRHybSur3dq8 numerical-relativity surrogate
//! (Varma et al. 2019, arXiv:1812.07865) from a trimmed data file.
//!
//! The surrogate models the waveform in the co-orbital frame, where it varies
//! slowly: the (2,2) mode as amplitude A₂₂ and phase φ₂₂ (with h₂₂ = A₂₂ e^{−iφ₂₂}),
//! and every other mode as H_lm = h_lm e^{i m φ₂₂/2}. Each of these real
//! functions of time is an empirical-interpolation basis weighted by node values,
//! and each node value is a Gaussian-process fit over (ln q, χ̂, χ_a).
//!
//! Units are geometric with total mass M = 1; t = 0 is the waveform peak. The
//! frame is the surrogate's own: heavier black hole on +x at t = −1000 M.

mod format;

use std::fmt;

use num_complex::Complex64;

use crate::spline::NaturalCubicSpline;
use format::{HeaderBounds, MAGIC, Node, Piece, Span};

/// Binary parameters. Mass ratio q = m₁/m₂ ≥ 1; spins are dimensionless and
/// aligned with the orbital angular momentum.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Params {
    pub q: f64,
    pub chi1: f64,
    pub chi2: f64,
}

/// Valid parameter ranges (inclusive) for the loaded model.
pub type Bounds = HeaderBounds;

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

/// Co-orbital-frame data for one (l, m) mode with m ≥ 0, m ≠ 2 when l = 2.
#[derive(Debug, Clone)]
pub struct CoorbitalMode {
    pub l: i32,
    pub m: i32,
    pub data: Vec<Complex64>,
}

/// Surrogate output on a uniform time grid `t_i = t0 + i·dt`.
#[derive(Debug, Clone)]
pub struct Waveform {
    pub t0: f64,
    pub dt: f64,
    /// |h₂₂|.
    pub amp22: Vec<f64>,
    /// φ₂₂ with h₂₂ = A₂₂ e^{−iφ₂₂}; increases with time. Orbital phase ≈ φ₂₂/2.
    pub phase22: Vec<f64>,
    /// Remaining modes in the co-orbital frame (m ≥ 0 only).
    pub coorbital: Vec<CoorbitalMode>,
}

impl Waveform {
    pub fn len(&self) -> usize {
        self.amp22.len()
    }

    pub fn is_empty(&self) -> bool {
        self.amp22.is_empty()
    }

    pub fn time(&self, i: usize) -> f64 {
        self.t0 + self.dt * i as f64
    }

    /// All available (l, m) modes, including negative m.
    pub fn modes(&self) -> Vec<(i32, i32)> {
        let mut out = vec![(2, 2), (2, -2)];
        for c in &self.coorbital {
            out.push((c.l, c.m));
            if c.m != 0 {
                out.push((c.l, -c.m));
            }
        }
        out
    }

    /// Inertial-frame h_lm at sample `i`. Negative m uses the aligned-spin
    /// symmetry h_{l,−m} = (−1)^l h*_{lm}. Returns `None` for unknown modes.
    pub fn h(&self, l: i32, m: i32, i: usize) -> Option<Complex64> {
        if m < 0 {
            let sign = if l % 2 == 0 { 1.0 } else { -1.0 };
            return self.h(l, -m, i).map(|z| z.conj() * sign);
        }
        let phi = self.phase22[i];
        if (l, m) == (2, 2) {
            return Some(Complex64::from_polar(self.amp22[i], -phi));
        }
        let c = self.coorbital.iter().find(|c| c.l == l && c.m == m)?;
        Some(c.data[i] * Complex64::from_polar(1.0, -(m as f64) * phi / 2.0))
    }
}

/// A loaded surrogate model.
#[derive(Debug)]
pub struct Surrogate {
    model: String,
    attribution: String,
    time: Vec<f64>,
    t3_t_ref: f64,
    phase_align_time: f64,
    bounds: Bounds,
    amp22: LoadedPiece,
    phase22: LoadedPiece,
    modes: Vec<LoadedMode>,
}

#[derive(Debug)]
struct LoadedMode {
    l: i32,
    m: i32,
    re: Option<LoadedPiece>,
    im: Option<LoadedPiece>,
}

#[derive(Debug)]
struct LoadedPiece {
    /// Row-major, n_nodes × n_times.
    basis: Vec<f64>,
    nodes: Vec<LoadedNode>,
}

#[derive(Debug)]
struct LoadedNode {
    x_train: Vec<[f64; 3]>,
    weights: Vec<f64>,
    inv_length_scale: [f64; 3],
    scale: f64,
    linear: [f64; 3],
    offset: f64,
}

impl LoadedNode {
    fn eval(&self, x: &[f64; 3]) -> f64 {
        let mut sum = 0.0;
        for (xt, w) in self.x_train.iter().zip(&self.weights) {
            let mut d2 = 0.0;
            for k in 0..3 {
                let d = (x[k] - xt[k]) * self.inv_length_scale[k];
                d2 += d * d;
            }
            sum += w * (-0.5 * d2).exp();
        }
        let lin: f64 = (0..3).map(|k| self.linear[k] * x[k]).sum();
        self.scale * sum + lin + self.offset
    }
}

impl LoadedPiece {
    /// Values on the sparse time grid.
    fn eval(&self, x: &[f64; 3], n_times: usize) -> Vec<f64> {
        let mut out = vec![0.0; n_times];
        for (n, node) in self.nodes.iter().enumerate() {
            let c = node.eval(x);
            let row = &self.basis[n * n_times..(n + 1) * n_times];
            for (o, b) in out.iter_mut().zip(row) {
                *o += c * b;
            }
        }
        out
    }
}

struct Blob<'a>(&'a [u8]);

impl Blob<'_> {
    fn get(&self, span: Span) -> Result<Vec<f64>, Error> {
        let Span(offset, len) = span;
        let start = offset * 8;
        let end = start + len * 8;
        let bytes = self
            .0
            .get(start..end)
            .ok_or_else(|| Error::Format(format!("span {offset}+{len} outside data blob")))?;
        Ok(bytes
            .as_chunks::<8>()
            .0
            .iter()
            .map(|c| f64::from_le_bytes(*c))
            .collect())
    }

    fn piece(&self, p: &Piece, n_times: usize) -> Result<LoadedPiece, Error> {
        if p.basis.1 != p.nodes.len() * n_times {
            return Err(Error::Format(format!(
                "basis has {} values, expected {} nodes × {n_times} times",
                p.basis.1,
                p.nodes.len()
            )));
        }
        let nodes = p
            .nodes
            .iter()
            .map(|n| self.node(n))
            .collect::<Result<_, _>>()?;
        Ok(LoadedPiece {
            basis: self.get(p.basis)?,
            nodes,
        })
    }

    fn node(&self, n: &Node) -> Result<LoadedNode, Error> {
        let flat = self.get(n.x_train)?;
        let weights = self.get(n.weights)?;
        if flat.len() != 3 * weights.len() {
            return Err(Error::Format("x_train is not n × 3".into()));
        }
        Ok(LoadedNode {
            x_train: flat.as_chunks::<3>().0.to_vec(),
            weights,
            inv_length_scale: n.inv_length_scale,
            scale: n.scale,
            linear: n.linear,
            offset: n.offset,
        })
    }
}

impl Surrogate {
    /// Parses a data file produced by `tools/export_surrogate.py`.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() < 12 || &bytes[..8] != MAGIC {
            return Err(Error::Format("bad magic; not a STSUR001 file".into()));
        }
        let header_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let header_end = 12 + header_len;
        let header_bytes = bytes
            .get(12..header_end)
            .ok_or_else(|| Error::Format("truncated header".into()))?;
        let header: format::Header = serde_json::from_slice(header_bytes)
            .map_err(|e| Error::Format(format!("header JSON: {e}")))?;
        let blob = Blob(&bytes[header_end.next_multiple_of(8)..]);

        let time = blob.get(header.time)?;
        if time.len() < 4 || !time.windows(2).all(|w| w[1] > w[0]) {
            return Err(Error::Format("time grid must be increasing".into()));
        }
        let n = time.len();
        let modes = header
            .modes
            .iter()
            .map(|m| {
                Ok(LoadedMode {
                    l: m.l,
                    m: m.m,
                    re: m.re.as_ref().map(|p| blob.piece(p, n)).transpose()?,
                    im: m.im.as_ref().map(|p| blob.piece(p, n)).transpose()?,
                })
            })
            .collect::<Result<_, Error>>()?;

        Ok(Self {
            amp22: blob.piece(&header.amp22, n)?,
            phase22: blob.piece(&header.phase22, n)?,
            modes,
            time,
            model: header.model,
            attribution: header.attribution,
            t3_t_ref: header.taylor_t3_t_ref,
            phase_align_time: header.phase_align_time,
            bounds: header.bounds,
        })
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Credit line required by the data licence; show it in the app.
    pub fn attribution(&self) -> &str {
        &self.attribution
    }

    pub fn bounds(&self) -> Bounds {
        self.bounds
    }

    /// First and last time (in M) the model can be evaluated at.
    pub fn time_range(&self) -> (f64, f64) {
        (self.time[0], self.time[self.time.len() - 1])
    }

    fn check(&self, p: &Params) -> Result<(), Error> {
        let b = &self.bounds;
        let tol = 1e-12;
        for (name, v, [lo, hi]) in [
            ("q", p.q, b.q),
            ("chi1", p.chi1, b.chi1),
            ("chi2", p.chi2, b.chi2),
        ] {
            if !(v >= lo - tol && v <= hi + tol) {
                return Err(Error::OutOfBounds(format!(
                    "{name} = {v} not in [{lo}, {hi}]"
                )));
            }
        }
        Ok(())
    }

    /// Fit coordinates (ln q, χ̂, χ_a); χ̂ is Eq. (3) of arXiv:1508.07253.
    fn fit_coords(p: &Params) -> [f64; 3] {
        let Params { q, chi1, chi2 } = *p;
        let eta = q / (1.0 + q).powi(2);
        let chi_wt = (q * chi1 + chi2) / (1.0 + q);
        let chi_hat = (chi_wt - 38.0 * eta / 113.0 * (chi1 + chi2)) / (1.0 - 76.0 * eta / 113.0);
        [q.ln(), chi_hat, (chi1 - chi2) / 2.0]
    }

    /// Leading-order TaylorT3 phase of the (2,2) mode, Eq. (43) of
    /// arXiv:1812.07865, zeroed at `phase_align_time`.
    fn taylor_t3_phase(&self, eta: f64, t: f64) -> f64 {
        let raw = |t: f64| -2.0 * ((self.t3_t_ref - t) / 5.0).powf(5.0 / 8.0) / eta.powf(3.0 / 8.0);
        raw(t) - raw(self.phase_align_time)
    }

    /// Evaluates all modes on `t_i = t_start + i·dt` up to the end of the model's
    /// domain (inclusive, within rounding).
    pub fn evaluate(&self, p: Params, t_start: f64, dt: f64) -> Result<Waveform, Error> {
        self.check(&p)?;
        let (t_min, t_max) = self.time_range();
        if dt.is_nan() || dt <= 0.0 {
            return Err(Error::Time(format!("dt must be positive, got {dt}")));
        }
        if t_start < t_min || t_start >= t_max {
            return Err(Error::Time(format!(
                "t_start = {t_start} not in [{t_min}, {t_max})"
            )));
        }
        let n_out = ((t_max - t_start) / dt + 1e-9).floor() as usize + 1;
        let ts: Vec<f64> = (0..n_out).map(|i| t_start + dt * i as f64).collect();

        let x = Self::fit_coords(&p);
        let n = self.time.len();
        let eta = p.q / (1.0 + p.q).powi(2);
        let interp = |vals: Vec<f64>| NaturalCubicSpline::new(&self.time, &vals).eval_sorted(&ts);

        let amp22 = interp(self.amp22.eval(&x, n));
        let mut phase_sparse = self.phase22.eval(&x, n);
        for (ph, &t) in phase_sparse.iter_mut().zip(&self.time) {
            *ph += self.taylor_t3_phase(eta, t);
        }
        let phase22 = interp(phase_sparse);

        let coorbital = self
            .modes
            .iter()
            .map(|m| {
                let re = m.re.as_ref().map(|pc| interp(pc.eval(&x, n)));
                let im = m.im.as_ref().map(|pc| interp(pc.eval(&x, n)));
                let data = (0..n_out)
                    .map(|i| {
                        Complex64::new(
                            re.as_ref().map_or(0.0, |v| v[i]),
                            im.as_ref().map_or(0.0, |v| v[i]),
                        )
                    })
                    .collect();
                CoorbitalMode {
                    l: m.l,
                    m: m.m,
                    data,
                }
            })
            .collect();

        Ok(Waveform {
            t0: t_start,
            dt,
            amp22,
            phase22,
            coorbital,
        })
    }
}
