//! Wigner-D matrices for rotating spin-weighted spherical-harmonic modes,
//! following gwsurrogate's `_wignerD_matrices` (after GWFrames, M. Boyle,
//! arXiv:1302.2919), with R_a = w + i z and R_b = y + i x.
//!
//! For a frame quaternion `q`, modes in that frame map to the reference frame
//! as h_ref[l, m] = Σ_m' D(q⁻¹)[l][m, m'] h[l, m'] (`rotate_modes`). In this
//! convention D(a)·D(b) = D(b·a).

use num_complex::Complex64;

use crate::quaternion::{Quat, inv};

pub const ELL_MIN: i32 = 2;
pub const ELL_MAX: i32 = 4;
/// Modes (2,−2) … (2,2), (3,−3) … (4,4).
pub const N_MODES: usize = 21;

/// Index of (l, m) in the mode ordering.
pub fn mode_index(l: i32, m: i32) -> usize {
    (l * l - 4 + l + m) as usize
}

fn factorial(n: i32) -> f64 {
    (1..=n).map(f64::from).product()
}

fn binomial(n: i32, k: i32) -> f64 {
    factorial(n) / (factorial(k) * factorial(n - k))
}

/// The general-case sum Σ_ρ C(l+m', ρ) C(l−m', l−ρ−m) (−1)^ρ R^ρ, as
/// polynomial coefficients in R, times the prefactor √((l+m)!(l−m)!/((l+m')!(l−m')!)).
#[derive(Debug, Clone)]
struct Element {
    rho_min: i32,
    coefs: Vec<f64>,
}

/// Precomputed coefficients for every (l, m, m').
#[derive(Debug, Clone)]
pub struct Wigner {
    elements: Vec<Element>,
}

impl Default for Wigner {
    fn default() -> Self {
        Self::new()
    }
}

impl Wigner {
    pub fn new() -> Self {
        let mut elements = Vec::new();
        for l in ELL_MIN..=ELL_MAX {
            for m in -l..=l {
                for mp in -l..=l {
                    let c = (factorial(l + m) * factorial(l - m)
                        / (factorial(l + mp) * factorial(l - mp)))
                    .sqrt();
                    let rho_min = 0.max(mp - m);
                    let rho_max = (l + mp).min(l - m);
                    let coefs = (rho_min..=rho_max)
                        .map(|rho| {
                            let sign = if rho % 2 == 0 { 1.0 } else { -1.0 };
                            c * binomial(l + mp, rho) * binomial(l - mp, l - rho - m) * sign
                        })
                        .collect();
                    elements.push(Element { rho_min, coefs });
                }
            }
        }
        Self { elements }
    }

    fn element(&self, l: i32, m: i32, mp: i32) -> &Element {
        let mut base = 0;
        for ll in ELL_MIN..l {
            base += ((2 * ll + 1) * (2 * ll + 1)) as usize;
        }
        let dim = 2 * l + 1;
        &self.elements[base + ((l + m) * dim + (l + mp)) as usize]
    }

    /// D(q)[l][m, m'] for l = 2…4, as one row-major (2l+1)² block per l.
    pub fn matrices(&self, q: Quat) -> [Vec<Complex64>; 3] {
        let ra = Complex64::new(q[0], q[3]);
        let rb = Complex64::new(q[2], q[1]);
        let (a2, b2) = (ra.norm_sqr(), rb.norm_sqr());
        let mut out: [Vec<Complex64>; 3] = Default::default();
        for l in ELL_MIN..=ELL_MAX {
            let dim = (2 * l + 1) as usize;
            let mut mat = vec![Complex64::new(0.0, 0.0); dim * dim];
            let at = |m: i32, mp: i32| (l + m) as usize * dim + (l + mp) as usize;
            if a2 < 1e-24 {
                // Rotation by π about an axis in the xy-plane.
                for m in -l..=l {
                    let sign = if (l + m) % 2 != 0 { 1.0 } else { -1.0 };
                    mat[at(m, -m)] = rb.powi(2 * m) * sign;
                }
            } else if b2 < 1e-24 {
                // Rotation about z.
                for m in -l..=l {
                    mat[at(m, m)] = ra.powi(2 * m);
                }
            } else {
                let abs_a = a2.sqrt();
                let ratio = b2 / a2;
                for m in -l..=l {
                    for mp in -l..=l {
                        let e = self.element(l, m, mp);
                        let mut s = 0.0;
                        let mut r = ratio.powi(e.rho_min);
                        for c in &e.coefs {
                            s += c * r;
                            r *= ratio;
                        }
                        mat[at(m, mp)] =
                            abs_a.powi(2 * l - 2 * m) * ra.powi(m + mp) * rb.powi(m - mp) * s;
                    }
                }
            }
            out[(l - ELL_MIN) as usize] = mat;
        }
        out
    }

    /// Modes in the frame `q` → reference-frame modes, at one instant.
    pub fn rotate_modes(&self, q: Quat, h: &[Complex64; N_MODES]) -> [Complex64; N_MODES] {
        let mats = self.matrices(inv(q));
        let mut out = [Complex64::new(0.0, 0.0); N_MODES];
        for l in ELL_MIN..=ELL_MAX {
            let mat = &mats[(l - ELL_MIN) as usize];
            let dim = (2 * l + 1) as usize;
            let base = mode_index(l, -l);
            for i in 0..dim {
                let mut acc = Complex64::new(0.0, 0.0);
                for j in 0..dim {
                    acc += mat[i * dim + j] * h[base + j];
                }
                out[base + i] = acc;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quaternion::{about_z, mul, normalize};

    #[test]
    fn mode_order() {
        assert_eq!(mode_index(2, -2), 0);
        assert_eq!(mode_index(2, 2), 4);
        assert_eq!(mode_index(3, -3), 5);
        assert_eq!(mode_index(4, 4), 20);
    }

    /// D is unitary, and composes in reverse order in this convention:
    /// D(a)D(b) = D(ba) (checked against gwsurrogate's matrices).
    #[test]
    fn unitary_and_composes() {
        let w = Wigner::new();
        let a = normalize([0.9, 0.2, -0.3, 0.25]);
        let b = normalize([0.1, -0.7, 0.4, 0.5]);
        let (da, db, dba) = (w.matrices(a), w.matrices(b), w.matrices(mul(b, a)));
        for k in 0..3 {
            let dim = 2 * k + 5;
            for i in 0..dim {
                for j in 0..dim {
                    let mut prod = Complex64::new(0.0, 0.0);
                    let mut gram = Complex64::new(0.0, 0.0);
                    for n in 0..dim {
                        prod += da[k][i * dim + n] * db[k][n * dim + j];
                        gram += da[k][n * dim + i].conj() * da[k][n * dim + j];
                    }
                    assert!((prod - dba[k][i * dim + j]).norm() < 1e-13, "composition");
                    let id = if i == j { 1.0 } else { 0.0 };
                    assert!((gram - id).norm() < 1e-13, "unitarity");
                }
            }
        }
    }

    /// Rotating about z only multiplies each mode by a phase, which the
    /// degenerate branch must agree with the general formula on nearby tilts.
    #[test]
    fn z_rotation_branch_is_continuous() {
        let w = Wigner::new();
        let exact = w.matrices(about_z(0.7));
        let tilted = w.matrices(normalize(mul(about_z(0.7), [1.0, 1e-9, 0.0, 0.0])));
        for k in 0..3 {
            for (a, b) in exact[k].iter().zip(&tilted[k]) {
                assert!((a - b).norm() < 1e-7);
            }
        }
    }
}
