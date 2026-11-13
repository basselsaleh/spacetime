//! Packs a [`Waveform`] into the flat `f32` table the strain shader reads, and
//! evaluates the strain from that table on the CPU with the shader's exact
//! arithmetic, so GPU output can be checked pixel by pixel.
//!
//! Layout: one row per stored mode, `n` samples per row, two floats per sample
//! (an RG32F texel). Row 0 is (2,2) as (A₂₂, φ₂₂ mod 4π); every other row is a
//! co-orbital mode as (Re H_lm, Im H_lm). Texel `row·n + i` lives at
//! (x, y) = (idx mod width, idx div width) of a `width`-wide texture.
//!
//! φ₂₂ is reduced mod 4π because GPU sin/cos lose accuracy at large arguments.
//! Every factor e^{−imφ₂₂/2} with integer m has period 4π, so this is exact.
//! Interpolation unwraps across the cut (φ₂₂ only increases, by far less than 2π
//! per sample).

use num_complex::Complex64;
use std::f64::consts::{PI, TAU};

use crate::harmonics::{spin_weighted_ylm, spin_weighted_ylm_theta};
use crate::surrogate::Waveform;

const FOUR_PI: f64 = 2.0 * TAU;

/// Waveform packed for the GPU.
#[derive(Debug, Clone)]
pub struct ModeTable {
    pub t0: f64,
    pub dt: f64,
    /// Samples per row.
    pub n: usize,
    /// Texture width in texels; height is `data.len() / (2 · width)`.
    pub width: usize,
    /// (l, m) of each row, m ≥ 0. Row 0 is always (2, 2).
    pub rows: Vec<(i32, i32)>,
    /// RG texel data, zero-padded to a whole number of texture rows.
    pub data: Vec<f32>,
}

impl ModeTable {
    pub fn new(wf: &Waveform, width: usize) -> Self {
        assert!(width > 0);
        let n = wf.len();
        let mut rows = vec![(2, 2)];
        rows.extend(wf.coorbital.iter().map(|c| (c.l, c.m)));
        let texels = rows.len() * n;
        let height = texels.div_ceil(width);
        let mut data = vec![0.0_f32; 2 * width * height];

        for i in 0..n {
            data[2 * i] = wf.amp22[i] as f32;
            data[2 * i + 1] = wf.phase22[i].rem_euclid(FOUR_PI) as f32;
        }
        for (k, c) in wf.coorbital.iter().enumerate() {
            let base = 2 * (k + 1) * n;
            for (i, z) in c.data.iter().enumerate() {
                data[base + 2 * i] = z.re as f32;
                data[base + 2 * i + 1] = z.im as f32;
            }
        }
        Self {
            t0: wf.t0,
            dt: wf.dt,
            n,
            width,
            rows,
            data,
        }
    }

    pub fn height(&self) -> usize {
        self.data.len() / (2 * self.width)
    }

    /// Last sample time.
    pub fn t_end(&self) -> f64 {
        self.t0 + self.dt * (self.n - 1) as f64
    }

    fn texel(&self, row: usize, i: usize) -> (f64, f64) {
        let idx = 2 * (row * self.n + i);
        (f64::from(self.data[idx]), f64::from(self.data[idx + 1]))
    }

    /// Complex strain r·(h₊ − i h×) at retarded time `t_ret` in direction (θ, φ),
    /// interpolated linearly between samples exactly as the shader does.
    /// Returns `None` outside the table's time range.
    pub fn strain(&self, theta: f64, phi: f64, t_ret: f64) -> Option<Complex64> {
        let x = (t_ret - self.t0) / self.dt;
        if !(0.0..=(self.n - 1) as f64).contains(&x) {
            return None;
        }
        let i = (x.floor() as usize).min(self.n - 2);
        let f = x - i as f64;
        let lerp = |a: f64, b: f64| a + f * (b - a);

        let (a0, p0) = self.texel(0, i);
        let (a1, p1) = self.texel(0, i + 1);
        let mut dp = p1 - p0;
        if dp < -TAU {
            dp += FOUR_PI;
        }
        let amp22 = lerp(a0, a1);
        let half_phase = (p0 + f * dp) / 2.0;
        // e^{−iφ₂₂/2}; e^{−imφ₂₂/2} is its m-th power.
        let rot = Complex64::from_polar(1.0, -half_phase);

        let mut sum = Complex64::new(0.0, 0.0);
        for (row, &(l, m)) in self.rows.iter().enumerate() {
            let h = if row == 0 {
                rot.powi(2) * amp22
            } else {
                let (r0, i0) = self.texel(row, i);
                let (r1, i1) = self.texel(row, i + 1);
                Complex64::new(lerp(r0, r1), lerp(i0, i1)) * rot.powi(m)
            };
            sum += h * spin_weighted_ylm(-2, l, m, theta, phi);
            if m != 0 {
                let parity = if l % 2 == 0 { 1.0 } else { -1.0 };
                sum += h.conj() * parity * spin_weighted_ylm(-2, l, -m, theta, phi);
            }
        }
        Some(sum)
    }
}

impl ModeTable {
    /// Strain at every sample time in direction (θ, φ), i.e. the signal an
    /// observer there receives, against retarded time `t0 + i·dt`.
    pub fn strain_series(&self, theta: f64, phi: f64) -> Vec<Complex64> {
        (0..self.n)
            .map(|i| {
                let t = (self.t0 + self.dt * i as f64).min(self.t_end());
                self.strain(theta, phi, t).unwrap_or_default()
            })
            .collect()
    }

    /// θ-dependence of the harmonics for the shader: RG texels, one row per
    /// table row, `n_theta` columns at θ_j = jπ/(n_theta − 1). Texel (j, k) is
    /// (₋₂Y_{l,m}(θ_j, 0), (−1)^l ₋₂Y_{l,−m}(θ_j, 0)) for row k = (l, m);
    /// the second value is 0 for m = 0. Use an odd `n_theta` so θ = π/2 is a
    /// sample and the orbital plane is exact.
    pub fn harmonic_table(&self, n_theta: usize) -> Vec<f32> {
        assert!(n_theta >= 2);
        let mut out = Vec::with_capacity(2 * n_theta * self.rows.len());
        for &(l, m) in &self.rows {
            let parity = if l % 2 == 0 { 1.0 } else { -1.0 };
            for j in 0..n_theta {
                let theta = PI * j as f64 / (n_theta - 1) as f64;
                let pos = spin_weighted_ylm_theta(-2, l, m, theta);
                let neg = if m == 0 {
                    0.0
                } else {
                    parity * spin_weighted_ylm_theta(-2, l, -m, theta)
                };
                out.push(pos as f32);
                out.push(neg as f32);
            }
        }
        out
    }
}

/// Peak of r·|h₊| expected in the orbital plane from the (2,2) mode alone:
/// 2 · ₋₂Y₂₂(π/2) · max A₂₂. Used to normalise the colour scale.
pub fn equatorial_peak_22(wf: &Waveform) -> f64 {
    let a = wf.amp22.iter().copied().fold(0.0, f64::max);
    2.0 * crate::harmonics::spin_weighted_ylm_theta(-2, 2, 2, PI / 2.0) * a
}
