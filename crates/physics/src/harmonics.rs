//! Spin-weighted spherical harmonics ₛY_lm(θ, φ).
//!
//! Uses Goldberg's explicit sum, written with sin/cos of θ/2 so it is finite at
//! the poles. Convention matches LAL's `XLALSpinWeightedSphericalHarmonic`
//! (checked in tests against LAL values), which is the convention the
//! surrogate's modes are defined in: h₊ − i h× = Σ h_lm ₋₂Y_lm(θ, φ).

use num_complex::Complex64;
use std::f64::consts::PI;

fn factorial(n: i32) -> f64 {
    (1..=n).map(f64::from).product()
}

fn binomial(n: i32, k: i32) -> f64 {
    if k < 0 || k > n {
        return 0.0;
    }
    factorial(n) / (factorial(k) * factorial(n - k))
}

/// The real, φ-independent part: ₛY_lm(θ, φ) = `spin_weighted_ylm_theta(s, l, m, θ)` · e^{imφ}.
/// Returns 0 for |m| > l or |s| > l.
pub fn spin_weighted_ylm_theta(s: i32, l: i32, m: i32, theta: f64) -> f64 {
    if m.abs() > l || s.abs() > l {
        return 0.0;
    }
    let (sh, ch) = ((theta / 2.0).sin(), (theta / 2.0).cos());
    let norm = (factorial(l + m) * factorial(l - m) * f64::from(2 * l + 1)
        / (4.0 * PI * factorial(l + s) * factorial(l - s)))
    .sqrt();
    let mut sum = 0.0;
    for r in 0..=(l - s) {
        let c = binomial(l - s, r) * binomial(l + s, r + s - m);
        if c == 0.0 {
            continue;
        }
        // sin^{2l}(θ/2) · cot^{k}(θ/2) = sin^{2l−k}(θ/2) · cos^{k}(θ/2)
        let k = 2 * r + s - m;
        let sign = if (l - r - s).rem_euclid(2) == 0 {
            1.0
        } else {
            -1.0
        };
        sum += sign * c * sh.powi(2 * l - k) * ch.powi(k);
    }
    let m_sign = if m.rem_euclid(2) == 0 { 1.0 } else { -1.0 };
    m_sign * norm * sum
}

/// ₛY_lm(θ, φ).
pub fn spin_weighted_ylm(s: i32, l: i32, m: i32, theta: f64, phi: f64) -> Complex64 {
    spin_weighted_ylm_theta(s, l, m, theta) * Complex64::from_polar(1.0, f64::from(m) * phi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_closed_forms_for_l2() {
        // LAL's hard-coded s = −2, l = 2 expressions.
        for theta in [0.0_f64, 0.4, 1.3, PI / 2.0, 2.2, PI] {
            let c = theta.cos();
            let st = theta.sin();
            let expect = [
                (2, (5.0 / (64.0 * PI)).sqrt() * (1.0 + c).powi(2)),
                (1, (5.0 / (16.0 * PI)).sqrt() * st * (1.0 + c)),
                (0, (15.0 / (32.0 * PI)).sqrt() * st * st),
                (-1, (5.0 / (16.0 * PI)).sqrt() * st * (1.0 - c)),
                (-2, (5.0 / (64.0 * PI)).sqrt() * (1.0 - c).powi(2)),
            ];
            for (m, want) in expect {
                let got = spin_weighted_ylm_theta(-2, 2, m, theta);
                assert!(
                    (got - want).abs() < 1e-14,
                    "m={m} θ={theta}: {got} vs {want}"
                );
            }
        }
    }

    #[test]
    fn spin_zero_is_ordinary_ylm() {
        // Y_10 = sqrt(3/4π) cos θ.
        let theta: f64 = 0.7;
        let want = (3.0 / (4.0 * PI)).sqrt() * theta.cos();
        assert!((spin_weighted_ylm_theta(0, 1, 0, theta) - want).abs() < 1e-14);
    }
}
