//! Packs an NRSur7dq4 [`Waveform`] into the flat `f32` table the strain shader
//! reads, and evaluates the strain from that table on the CPU with the
//! shader's exact arithmetic, so GPU output can be checked pixel by pixel.
//!
//! The table holds what varies slowly: the coprecessing frame and the modes in
//! the co-orbital frame. (Inertial-frame modes of a precessing binary mix the
//! co-orbital m′ = ±2 parts, so no single phase factor makes them smooth.) The
//! shader turns each pixel's direction into the source frame instead:
//!
//! - n_c = R⁻¹ n: the direction in the coprecessing frame R (z along L̂), at
//!   polar angle θ_c and azimuth φ_c;
//! - the co-orbital frame is R turned by the orbital phase Φ about its z-axis,
//!   so the co-orbital azimuth is φ_c − Φ;
//! - r·(h₊ − i h×) = e^{−2iγ} Σ_lm H_lm ₋₂Y_lm(θ_c, φ_c − Φ), where γ is the
//!   angle from the inertial θ̂ to the coprecessing θ̂ at n, toward φ̂: the
//!   strain is measured against each frame's own polarization basis.
//!
//! Layout: rows of `n` samples, two floats per sample (an RG32F texel); texel
//! `row·n + i` lives at (idx mod width, idx div width) of a `width`-wide
//! texture.
//!
//! - row 0: (q_w, q_x), row 1: (q_y, q_z) of the coprecessing frame;
//! - row 2: (Φ mod 2π, 0); the shader unwraps across the cut (Φ increases by
//!   far less than π per sample) and reduces to [−π, π) before using it;
//! - rows 3…: co-orbital modes (Re H, Im H), listed in `rows`, in (l, ±m)
//!   pairs ordered by peak amplitude (+m first), so a shader can sum only the
//!   leading pairs for a cheaper approximation.

use num_complex::Complex64;
use std::f64::consts::{PI, TAU};

use crate::harmonics::spin_weighted_ylm_theta;
use crate::nrsur7dq4::{Waveform, mode_index};
use crate::quaternion::{self, Quat};

/// Rows before the first mode row.
pub const FRAME_ROWS: usize = 3;

/// Waveform packed for the GPU.
#[derive(Debug, Clone)]
pub struct ModeTable {
    pub t0: f64,
    pub dt: f64,
    /// Samples per row.
    pub n: usize,
    /// Texture width in texels; height is `data.len() / (2 · width)`.
    pub width: usize,
    /// (l, m) of each mode row (table row `FRAME_ROWS + k`).
    pub rows: Vec<(i32, i32)>,
    /// Number of leading mode rows forming the three strongest (l, ±m) groups.
    pub leading3: usize,
    /// RG texel data, zero-padded to a whole number of texture rows.
    pub data: Vec<f32>,
}

/// The rotation matrix of a unit quaternion (v_ref = M v), row-major.
fn matrix(q: Quat) -> [[f64; 3]; 3] {
    let [w, x, y, z] = q;
    [
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y - w * z),
            2.0 * (x * z + w * y),
        ],
        [
            2.0 * (x * y + w * z),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z - w * x),
        ],
        [
            2.0 * (x * z - w * y),
            2.0 * (y * z + w * x),
            1.0 - 2.0 * (x * x + y * y),
        ],
    ]
}

fn mat_vec(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2])
}

fn mat_t_vec(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| m[0][i] * v[0] + m[1][i] * v[1] + m[2][i] * v[2])
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Polar angle, e^{iφ} and the unit θ̂ of a unit vector; φ = 0 on the axis.
fn spherical(n: [f64; 3]) -> (f64, Complex64, [f64; 3]) {
    let rho = n[0].hypot(n[1]);
    let e = if rho > 0.0 {
        Complex64::new(n[0] / rho, n[1] / rho)
    } else {
        Complex64::new(1.0, 0.0)
    };
    let theta = rho.atan2(n[2]);
    (theta, e, [n[2] * e.re, n[2] * e.im, -rho])
}

impl ModeTable {
    pub fn new(wf: &Waveform, width: usize) -> Self {
        assert!(width > 0);
        let n = wf.len();
        let peak = |l: i32, m: i32| {
            wf.h_coorb[mode_index(l, m)]
                .iter()
                .map(|z| z.norm())
                .fold(0.0, f64::max)
        };
        // Groups (l, |m|), strongest first; each group lists +m then −m.
        let mut groups: Vec<(i32, i32, f64)> = Vec::new();
        for l in 2..=4 {
            for m in 0..=l {
                let p = if m == 0 {
                    peak(l, 0)
                } else {
                    peak(l, m).max(peak(l, -m))
                };
                groups.push((l, m, p));
            }
        }
        groups.sort_by(|a, b| b.2.total_cmp(&a.2));
        let mut rows = Vec::new();
        let mut leading3 = 0;
        for (k, &(l, m, _)) in groups.iter().enumerate() {
            rows.push((l, m));
            if m != 0 {
                rows.push((l, -m));
            }
            if k == 2 {
                leading3 = rows.len();
            }
        }

        let texels = (FRAME_ROWS + rows.len()) * n;
        let height = texels.div_ceil(width);
        let mut data = vec![0.0_f32; 2 * width * height];
        for i in 0..n {
            let q = wf.quat[i];
            data[2 * i] = q[0] as f32;
            data[2 * i + 1] = q[1] as f32;
            data[2 * (n + i)] = q[2] as f32;
            data[2 * (n + i) + 1] = q[3] as f32;
            data[2 * (2 * n + i)] = wf.orbphase[i].rem_euclid(TAU) as f32;
        }
        for (k, &(l, m)) in rows.iter().enumerate() {
            let base = 2 * (FRAME_ROWS + k) * n;
            for (i, z) in wf.h_coorb[mode_index(l, m)].iter().enumerate() {
                data[base + 2 * i] = z.re as f32;
                data[base + 2 * i + 1] = z.im as f32;
            }
        }
        Self {
            t0: wf.t[0],
            dt: wf.t[1] - wf.t[0],
            n,
            width,
            rows,
            leading3,
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

    /// Complex strain r·(h₊ − i h×) at retarded time `t_ret` in the direction
    /// of `dir` (any length > 0), from the first `rows` mode rows, with the
    /// shader's interpolation. `None` outside the table's time range.
    pub fn strain_rows(&self, dir: [f64; 3], t_ret: f64, rows: usize) -> Option<Complex64> {
        let x = (t_ret - self.t0) / self.dt;
        if !(0.0..=(self.n - 1) as f64).contains(&x) {
            return None;
        }
        let i = (x.floor() as usize).min(self.n - 2);
        let f = x - i as f64;
        let lerp = |a: f64, b: f64| a + f * (b - a);

        // Frame: normalized lerp of the quaternion; unwrapped lerp of Φ.
        let (a0, b0) = self.texel(0, i);
        let (a1, b1) = self.texel(0, i + 1);
        let (c0, d0) = self.texel(1, i);
        let (c1, d1) = self.texel(1, i + 1);
        let q = quaternion::normalize([lerp(a0, a1), lerp(b0, b1), lerp(c0, c1), lerp(d0, d1)]);
        let (p0, _) = self.texel(2, i);
        let (p1, _) = self.texel(2, i + 1);
        let mut dp = p1 - p0;
        if dp < -PI {
            dp += TAU;
        }
        let mut phase = p0 + f * dp;
        phase -= TAU * (phase / TAU + 0.5).floor();

        let len = dot(dir, dir).sqrt();
        let n = dir.map(|c| c / len);
        let rm = matrix(q);
        let (theta_c, e_c, that_c) = spherical(mat_t_vec(&rm, n));
        let (_, e_i, that_i) = spherical(n);
        let phihat_i = [-e_i.im, e_i.re, 0.0];
        let that_c_inertial = mat_vec(&rm, that_c);
        let g = Complex64::new(
            dot(that_c_inertial, that_i),
            -dot(that_c_inertial, phihat_i),
        );
        let polar = g * g; // e^{−2iγ}
        let e_coorb = e_c * Complex64::from_polar(1.0, -phase);

        let mut sum = Complex64::new(0.0, 0.0);
        for (k, &(l, m)) in self.rows.iter().enumerate().take(rows) {
            let (r0, i0) = self.texel(FRAME_ROWS + k, i);
            let (r1, i1) = self.texel(FRAME_ROWS + k, i + 1);
            let h = Complex64::new(lerp(r0, r1), lerp(i0, i1));
            sum += h * spin_weighted_ylm_theta(-2, l, m, theta_c) * e_coorb.powi(m);
        }
        Some(sum * polar)
    }

    /// `strain_rows` with every mode.
    pub fn strain(&self, dir: [f64; 3], t_ret: f64) -> Option<Complex64> {
        self.strain_rows(dir, t_ret, self.rows.len())
    }

    /// Strain at every sample time in direction `dir`, i.e. the signal an
    /// observer there receives, against retarded time `t0 + i·dt`.
    pub fn strain_series(&self, dir: [f64; 3]) -> Vec<Complex64> {
        (0..self.n)
            .map(|i| {
                let t = (self.t0 + self.dt * i as f64).min(self.t_end());
                self.strain(dir, t).unwrap_or_default()
            })
            .collect()
    }

    /// θ-dependence of the harmonics for the shader: RG texels, one row per
    /// mode row, `n_theta` columns at θ_j = jπ/(n_theta − 1). Texel (j, k) is
    /// (₋₂Y_{l,m}(θ_j, 0), 0) for mode row k = (l, m). Use an odd `n_theta`
    /// so θ = π/2 is a sample.
    pub fn harmonic_table(&self, n_theta: usize) -> Vec<f32> {
        assert!(n_theta >= 2);
        let mut out = Vec::with_capacity(2 * n_theta * self.rows.len());
        for &(l, m) in &self.rows {
            for j in 0..n_theta {
                let theta = PI * j as f64 / (n_theta - 1) as f64;
                out.push(spin_weighted_ylm_theta(-2, l, m, theta) as f32);
                out.push(0.0);
            }
        }
        out
    }
}

/// Peak of r·|h₊| expected in the orbital plane from the co-orbital (2,±2)
/// modes alone: 2 · ₋₂Y₂₂(π/2) · max |H₂₂|. Used to normalize the color scale.
pub fn equatorial_peak_22(wf: &Waveform) -> f64 {
    let a = wf.h_coorb[mode_index(2, 2)]
        .iter()
        .map(|z| z.norm())
        .fold(0.0, f64::max);
    2.0 * spin_weighted_ylm_theta(-2, 2, 2, PI / 2.0) * a
}
