//! Newtonian circular-orbit relations (placeholder physics for step 0).

/// Orbital angular frequency of a circular binary with separation `a`
/// (Kepler's third law with M = 1): ω = sqrt(M / a³).
pub fn orbital_omega(separation: f64) -> f64 {
    separation.powf(-1.5)
}

/// Angular frequency of the dominant (2,2) gravitational-wave mode,
/// which is twice the orbital frequency.
pub fn gw_omega_22(separation: f64) -> f64 {
    2.0 * orbital_omega(separation)
}

/// Wavelength of the (2,2) wave in units of M: λ = 2π / ω₂₂.
pub fn gw_wavelength_22(separation: f64) -> f64 {
    std::f64::consts::TAU / gw_omega_22(separation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kepler_at_unit_separation() {
        assert!((orbital_omega(1.0) - 1.0).abs() < 1e-15);
    }

    #[test]
    fn gw_frequency_is_twice_orbital() {
        let a = 20.0;
        assert!((gw_omega_22(a) - 2.0 * orbital_omega(a)).abs() < 1e-15);
    }

    #[test]
    fn wavelength_at_separation_20() {
        // ω_orb = 20^-1.5 ≈ 0.01118, so λ = π / ω_orb ≈ 281 M.
        let lambda = gw_wavelength_22(20.0);
        assert!((lambda - std::f64::consts::PI * 20f64.powf(1.5)).abs() < 1e-9);
    }
}
