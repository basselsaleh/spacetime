//! Tidal (E) and frame-drag (B) tensors of the binary, and their field lines
//! (tendex and vortex lines).
//!
//! The field is the linearized-gravity solution of a mass monopole M plus a
//! time-varying STF mass quadrupole I_ij(u), at retarded time u = t − r. It is
//! exact in weak gravity, with near, intermediate and far terms. It is derived
//! symbolically in `tools/tendex_field.py`, which also checks the closed form
//! used here:
//!
//! ```text
//! E_ij = M/r³ (δ_ij − 3 n_i n_j)
//!      + Σ_k r^−(5−k) [a_k Q_ij + b_k (n_i Qn_j + Qn_i n_j) + c_k δ_ij Qnn + d_k n_i n_j Qnn]
//! B_ij = Σ_k r^−(5−k) [e_k sym(ε_ipq n_p Q_qj) + f_k sym(ε_ipq n_p Qn_q n_j)]
//! ```
//!
//! with Q = d^kI/dt^k, Qn = Q·n, Qnn = n·Q·n. Geodesic deviation is
//! d²ξ_i/dt² = −E_ij ξ_j, so a negative eigenvalue stretches along its
//! eigenvector and a positive one squeezes. B follows Nichols et al. 2011's
//! convention (from memory; it only sets the sign of B).
//!
//! The quadrupole comes from the (2,2) mode (the "adiabatic" choice, compared
//! with alternatives in `tools/tendex_quadrupole.py`): with
//! K = −h₂₂/ω₂₂², the quadrupole is Ixx = −Re K/(2α), Iyy = Re K/(2α),
//! Ixy = Im K/(2α), α = 2√(π/5), and its second derivative's (2,2) mode is
//! exactly h₂₂. (2,±1) is the current quadrupole and is left out.
//!
//! None of this resolves the field inside the binary: lines are only meaningful
//! outside the near-zone radius.

use std::f64::consts::PI;

use num_complex::Complex64;

use crate::surrogate::Waveform;

/// A symmetric 3×3 matrix (stored in full).
pub type Mat3 = [[f64; 3]; 3];
/// Quadrupole and its first four time derivatives.
pub type QuadDerivs = [Mat3; 5];

/// (a, b, c, d) for E, per derivative order k.
const E_COEF: [[f64; 4]; 5] = [
    [-3.0, 15.0, 7.5, -52.5],
    [-3.0, 15.0, 7.5, -52.5],
    [-3.0, 9.0, 1.5, -22.5],
    [-2.0, 4.0, -1.0, -5.0],
    [-1.0, 1.0, -0.5, -0.5],
];
/// (e, f) for B, per derivative order k.
const B_COEF: [[f64; 2]; 5] = [
    [0.0, 0.0],
    [-3.0, 15.0],
    [-3.0, 15.0],
    [-2.0, 6.0],
    [-1.0, 1.0],
];

/// After this time (M) h₂₂ is near the noise floor and ω₂₂ is noise, so the
/// adiabatic quadrupole holds ω₂₂ fixed.
pub const OMEGA_HOLD_T: f64 = 60.0;

/// h₂₂ produced by unit I''_yy − I''_xx (LAL convention): h₂₂ = α (I''yy − I''xx + 2i I''xy).
pub fn mode_scale() -> f64 {
    2.0 * (PI / 5.0).sqrt()
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn mat_vec(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [dot(m[0], v), dot(m[1], v), dot(m[2], v)]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Tidal tensor E_ij at `p` for monopole `mass` and quadrupole derivatives `q`
/// evaluated at this point's retarded time.
pub fn tidal(p: [f64; 3], mass: f64, q: &QuadDerivs) -> Mat3 {
    let r = dot(p, p).sqrt();
    let n = [p[0] / r, p[1] / r, p[2] / r];
    let mono = mass / (r * r * r);
    let mut e = [[0.0; 3]; 3];
    for (i, row) in e.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = mono * ((i == j) as u8 as f64 - 3.0 * n[i] * n[j]);
        }
    }
    let mut s = 1.0 / (r * r * r * r * r);
    for (k, qk) in q.iter().enumerate() {
        let [a, b, c, d] = E_COEF[k];
        let qn = mat_vec(qk, n);
        let qnn = dot(n, qn);
        for i in 0..3 {
            for j in 0..3 {
                e[i][j] += s
                    * (a * qk[i][j]
                        + b * (n[i] * qn[j] + qn[i] * n[j])
                        + c * qnn * ((i == j) as u8 as f64)
                        + d * qnn * n[i] * n[j]);
            }
        }
        s *= r;
    }
    e
}

/// Frame-drag tensor B_ij (see [`tidal`]).
pub fn frame_drag(p: [f64; 3], q: &QuadDerivs) -> Mat3 {
    let r = dot(p, p).sqrt();
    let n = [p[0] / r, p[1] / r, p[2] / r];
    let mut bm = [[0.0; 3]; 3];
    let mut s = 1.0 / (r * r * r * r * r);
    for (k, qk) in q.iter().enumerate() {
        let [e, f] = B_COEF[k];
        if e != 0.0 || f != 0.0 {
            // X1_ij = ε_ipq n_p Q_qj: row i is (n × Q_·j)_i, i.e. columns of n × (column j of Q).
            let cols: [[f64; 3]; 3] =
                std::array::from_fn(|j| cross(n, [qk[0][j], qk[1][j], qk[2][j]]));
            let w = cross(n, mat_vec(qk, n)); // ε_ipq n_p Qn_q
            for i in 0..3 {
                for j in 0..3 {
                    let x1 = 0.5 * (cols[j][i] + cols[i][j]);
                    let x2 = 0.5 * (w[i] * n[j] + w[j] * n[i]);
                    bm[i][j] += s * (e * x1 + f * x2);
                }
            }
        }
        s *= r;
    }
    bm
}

/// Ascending eigenvalues of a symmetric 3×3 matrix (trigonometric method).
pub fn eigenvalues(a: &Mat3) -> [f64; 3] {
    let p1 = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
    let tr = (a[0][0] + a[1][1] + a[2][2]) / 3.0;
    let d = [a[0][0] - tr, a[1][1] - tr, a[2][2] - tr];
    let p2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] + 2.0 * p1;
    if p2 <= 1e-300 {
        return [tr; 3];
    }
    let p = (p2 / 6.0).sqrt();
    let b = |i: usize, j: usize| (a[i][j] - if i == j { tr } else { 0.0 }) / p;
    let det = b(0, 0) * (b(1, 1) * b(2, 2) - b(1, 2) * b(2, 1))
        - b(0, 1) * (b(1, 0) * b(2, 2) - b(1, 2) * b(2, 0))
        + b(0, 2) * (b(1, 0) * b(2, 1) - b(1, 1) * b(2, 0));
    let phi = (det / 2.0).clamp(-1.0, 1.0).acos() / 3.0;
    let hi = tr + 2.0 * p * phi.cos();
    let lo = tr + 2.0 * p * (phi + 2.0 * PI / 3.0).cos();
    [lo, 3.0 * tr - hi - lo, hi]
}

/// Unit eigenvector for eigenvalue `lambda`: the largest cross product of two
/// rows of A − λI. Ill-defined where λ is (nearly) degenerate.
pub fn eigenvector(a: &Mat3, lambda: f64) -> [f64; 3] {
    let r = |i: usize| {
        let mut row = a[i];
        row[i] -= lambda;
        row
    };
    let c = [cross(r(0), r(1)), cross(r(0), r(2)), cross(r(1), r(2))];
    let best = c
        .iter()
        .copied()
        .max_by(|x, y| dot(*x, *x).total_cmp(&dot(*y, *y)))
        .unwrap();
    let len = dot(best, best).sqrt();
    if len == 0.0 {
        return [1.0, 0.0, 0.0];
    }
    [best[0] / len, best[1] / len, best[2] / len]
}

/// Five-point first and second derivatives on a uniform grid (three-point near the ends).
fn derivatives(y: &[f64], dt: f64) -> (Vec<f64>, Vec<f64>) {
    let n = y.len();
    let mut d1 = vec![0.0; n];
    let mut d2 = vec![0.0; n];
    for i in 0..n {
        if i >= 2 && i + 2 < n {
            d1[i] = (y[i - 2] - 8.0 * y[i - 1] + 8.0 * y[i + 1] - y[i + 2]) / (12.0 * dt);
            d2[i] = (-y[i - 2] + 16.0 * y[i - 1] - 30.0 * y[i] + 16.0 * y[i + 1] - y[i + 2])
                / (12.0 * dt * dt);
        } else {
            let c = i.clamp(1, n - 2);
            d1[i] = (y[c + 1] - y[c - 1]) / (2.0 * dt);
            d2[i] = (y[c + 1] - 2.0 * y[c] + y[c - 1]) / (dt * dt);
        }
    }
    (d1, d2)
}

/// Catmull-Rom interpolation of uniformly sampled values at fractional index `x`.
fn catmull_rom<T>(v: &[T], x: f64) -> T
where
    T: Copy
        + std::ops::Add<Output = T>
        + std::ops::Sub<Output = T>
        + std::ops::Mul<f64, Output = T>,
{
    let n = v.len();
    let i = (x.floor() as isize).clamp(0, n as isize - 2) as usize;
    let f = x - i as f64;
    let p0 = v[i.saturating_sub(1)];
    let p1 = v[i];
    let p2 = v[i + 1];
    let p3 = v[(i + 2).min(n - 1)];
    let f2 = f * f;
    let f3 = f2 * f;
    (p1 * 2.0
        + (p2 - p0) * f
        + (p0 * 2.0 - p1 * 5.0 + p2 * 4.0 - p3) * f2
        + (p1 * 3.0 - p0 - p2 * 3.0 + p3) * f3)
        * 0.5
}

/// The binary's mass quadrupole and its first four derivatives, from the (2,2) mode.
#[derive(Debug, Clone)]
pub struct Quadrupole {
    t0: f64,
    dt: f64,
    phase: Vec<f64>,
    omega: Vec<f64>,
    /// K^(n) e^{iφ₂₂}: slowly varying, so it interpolates accurately.
    slow: [Vec<Complex64>; 5],
    /// Peak over time of the rotating amplitude of d⁴I/dt⁴ (far-zone r·|E| scale).
    pub far_scale: f64,
}

impl Quadrupole {
    pub fn new(wf: &Waveform) -> Self {
        let dt = wf.dt;
        let a = &wf.amp22;
        let phase = wf.phase22.clone();
        let (da, dda) = derivatives(a, dt);
        let (omega, domega) = derivatives(&phase, dt);
        let hold = ((OMEGA_HOLD_T - wf.t0) / dt)
            .round()
            .clamp(0.0, (a.len() - 1) as f64) as usize;
        let mut slow: [Vec<Complex64>; 5] = Default::default();
        for s in 0..a.len() {
            let (w, dw) = (omega[s], domega[s]);
            // h e^{iφ} and its derivatives, from h = A e^{−iφ}.
            let h0 = Complex64::new(a[s], 0.0);
            let h1 = Complex64::new(da[s], -a[s] * w);
            let h2 = Complex64::new(dda[s] - a[s] * w * w, -2.0 * da[s] * w - a[s] * dw);
            let (wh, dwh) = if s > hold {
                (omega[hold], 0.0)
            } else {
                (w, dw)
            };
            let k0 = -h0 / (wh * wh);
            let k1 = -h1 / (wh * wh) + h0 * (2.0 * dwh / (wh * wh * wh));
            slow[0].push(k0);
            slow[1].push(k1);
            slow[2].push(h0);
            slow[3].push(h1);
            slow[4].push(h2);
        }
        let far_scale = slow[4].iter().map(|z| z.norm()).fold(0.0, f64::max) / (2.0 * mode_scale());
        Self {
            t0: wf.t0,
            dt,
            phase,
            omega,
            slow,
            far_scale,
        }
    }

    pub fn t_range(&self) -> (f64, f64) {
        (self.t0, self.t0 + self.dt * (self.phase.len() - 1) as f64)
    }

    /// φ₂₂(u) by cubic Hermite interpolation with ω₂₂ as the slope.
    fn phase_at(&self, x: f64) -> f64 {
        let n = self.phase.len();
        let i = (x.floor() as isize).clamp(0, n as isize - 2) as usize;
        let f = x - i as f64;
        let (p0, p1) = (self.phase[i], self.phase[i + 1]);
        let (m0, m1) = (self.omega[i] * self.dt, self.omega[i + 1] * self.dt);
        let f2 = f * f;
        let f3 = f2 * f;
        (2.0 * f3 - 3.0 * f2 + 1.0) * p0
            + (f3 - 2.0 * f2 + f) * m0
            + (-2.0 * f3 + 3.0 * f2) * p1
            + (f3 - f2) * m1
    }

    /// K^(n)(u) for n = 0..4, where K is the (2,2)-mode equivalent of I. `u` is clamped to the data.
    pub fn k(&self, u: f64) -> [Complex64; 5] {
        let (lo, hi) = self.t_range();
        let x = (u.clamp(lo, hi) - self.t0) / self.dt;
        let rot = Complex64::from_polar(1.0, -self.phase_at(x));
        std::array::from_fn(|n| catmull_rom(&self.slow[n], x) * rot)
    }

    /// I and its first four derivatives at retarded time `u`.
    pub fn derivatives(&self, u: f64) -> QuadDerivs {
        let s = 1.0 / (2.0 * mode_scale());
        self.k(u).map(|k| {
            let (xx, xy) = (-k.re * s, k.im * s);
            [[xx, xy, 0.0], [xy, -xx, 0.0], [0.0, 0.0, 0.0]]
        })
    }
}

/// Which tensor to trace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Tidal,
    FrameDrag,
}

/// Which eigenvector family: smallest (most negative) or largest eigenvalue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Min,
    Max,
}

/// Field-line integration settings.
#[derive(Debug, Clone, Copy)]
pub struct TraceParams {
    /// Coordinate time at the source, M.
    pub t: f64,
    /// Monopole mass (total mass, 1).
    pub mass: f64,
    /// Lines stop inside this radius (the near zone) and beyond `r_max`.
    pub r_min: f64,
    pub r_max: f64,
    /// RK4 steps in each direction from the seed.
    pub steps: usize,
    /// Step length is `step_scale · (1 + r/30)` M.
    pub step_scale: f64,
}

/// One vertex of a traced line: position and the family's eigenvalue there.
#[derive(Debug, Clone, Copy)]
pub struct Vertex {
    pub p: [f64; 3],
    pub lambda: f64,
}

/// Evaluates fields for the tracer.
pub struct Tracer<'a> {
    quad: &'a Quadrupole,
    field: Field,
    family: Family,
    params: TraceParams,
}

impl<'a> Tracer<'a> {
    pub fn new(quad: &'a Quadrupole, field: Field, family: Family, params: TraceParams) -> Self {
        Self {
            quad,
            field,
            family,
            params,
        }
    }

    /// The tensor at `p` (each point at its own retarded time).
    pub fn tensor(&self, p: [f64; 3]) -> Mat3 {
        let r = dot(p, p).sqrt();
        let q = self.quad.derivatives(self.params.t - r);
        match self.field {
            Field::Tidal => tidal(p, self.params.mass, &q),
            Field::FrameDrag => frame_drag(p, &q),
        }
    }

    /// The family's unit eigenvector (sign aligned with `prev`) and eigenvalue,
    /// or `None` near a degeneracy, where the direction is ill-defined.
    fn direction(&self, p: [f64; 3], prev: Option<[f64; 3]>) -> Option<([f64; 3], f64)> {
        let t = self.tensor(p);
        let ev = eigenvalues(&t);
        let scale = ev[0].abs().max(ev[2].abs());
        let (lambda, gap) = match self.family {
            Family::Min => (ev[0], ev[1] - ev[0]),
            Family::Max => (ev[2], ev[2] - ev[1]),
        };
        if scale == 0.0 || gap < 0.02 * scale {
            return None;
        }
        let mut v = eigenvector(&t, lambda);
        if let Some(prev) = prev
            && dot(v, prev) < 0.0
        {
            v = [-v[0], -v[1], -v[2]];
        }
        Some((v, lambda))
    }

    fn walk(&self, seed: [f64; 3], sign: f64, out: &mut Vec<Vertex>) {
        let pr = &self.params;
        let mut p = seed;
        let mut prev: Option<[f64; 3]> = None;
        for _ in 0..pr.steps {
            let r = dot(p, p).sqrt();
            if r < pr.r_min || r > pr.r_max {
                return;
            }
            let Some((mut k1, lambda)) = self.direction(p, prev) else {
                return;
            };
            if prev.is_none() {
                k1 = k1.map(|c| c * sign);
            }
            out.push(Vertex { p, lambda });
            let Some((next, step)) = self.rk4_step(p, k1, pr.step_scale * (1.0 + r / 30.0)) else {
                return;
            };
            p = next;
            prev = Some(step);
        }
    }

    /// One RK4 step from `p` along `k1` of length up to `h`. Near degeneracies the
    /// eigenvector turns quickly; the step is halved (down to h/16) until the
    /// stages agree to within ~8°.
    fn rk4_step(&self, p: [f64; 3], k1: [f64; 3], h: f64) -> Option<([f64; 3], [f64; 3])> {
        let at = |s: f64, k: [f64; 3]| [p[0] + s * k[0], p[1] + s * k[1], p[2] + s * k[2]];
        let mut h = h;
        for attempt in 0..5 {
            let (k2, _) = self.direction(at(0.5 * h, k1), Some(k1))?;
            let (k3, _) = self.direction(at(0.5 * h, k2), Some(k1))?;
            let (k4, _) = self.direction(at(h, k3), Some(k1))?;
            if dot(k1, k4) < 0.99 && attempt < 4 {
                h *= 0.5;
                continue;
            }
            let mut step: [f64; 3] =
                std::array::from_fn(|i| (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]) / 6.0);
            let len = dot(step, step).sqrt();
            step = step.map(|c| c / len);
            return Some((at(h, step), step));
        }
        None
    }

    /// The line through `seed`, traced both ways, in order along the line.
    pub fn line(&self, seed: [f64; 3]) -> Vec<Vertex> {
        let mut back = Vec::new();
        self.walk(seed, -1.0, &mut back);
        let mut fwd = Vec::new();
        self.walk(seed, 1.0, &mut fwd);
        back.reverse();
        // The seed is the first vertex of both walks.
        if !back.is_empty() && !fwd.is_empty() {
            back.pop();
        }
        back.extend(fwd);
        back
    }
}

/// `n` well-spread, deterministic seed points between radii `r_lo` and `r_hi`:
/// isotropic, and uniform in radius (so density falls as 1/r² and the region
/// near the source, where the structure is, gets more lines). R3 low-discrepancy
/// sequence; `salt` offsets it.
pub fn seeds(n: usize, r_lo: f64, r_hi: f64, salt: u32) -> Vec<[f64; 3]> {
    // Roberts' R3 sequence: fractional parts of k·(1/g, 1/g², 1/g³), g³ = g + 1.
    let g = 1.220_744_084_605_759_5_f64;
    let alpha = [1.0 / g, 1.0 / (g * g), 1.0 / (g * g * g)];
    (0..n)
        .map(|i| {
            let k = (i as u64 + 1 + 7919 * salt as u64) as f64;
            let u: [f64; 3] = std::array::from_fn(|d| (0.5 + alpha[d] * k).fract());
            let z = 2.0 * u[0] - 1.0;
            let phi = 2.0 * PI * u[1];
            let rho = (1.0 - z * z).max(0.0).sqrt();
            let r = r_lo + u[2] * (r_hi - r_lo);
            [r * rho * phi.cos(), r * rho * phi.sin(), r * z]
        })
        .collect()
}
