//! Black-hole positions and sizes, derived from the waveform so that the
//! orbits and the waves can never drift apart.
//!
//! - Direction: the surrogate's frame has the heavier hole on +x at
//!   t = −1000 M and h₂₂ ∝ e^{−iφ₂₂}, so the heavier hole sits at angle
//!   Φ(t) = (φ₂₂(t) − φ₂₂(−1000 M)) / 2, orbiting counter-clockwise seen from +z.
//! - Separation: 2PN relation between orbital frequency and separation in
//!   harmonic coordinates for non-spinning bodies, γ = M/r =
//!   x[1 + (1 − η/3)x + (1 − 65η/12)x²] with x = (M ω₂₂/2)^{2/3}
//!   (Blanchet, Living Rev. Rel. 17, 2 (2014)). Spin terms are omitted, and PN
//!   breaks down in the last orbits: positions there are schematic.
//! - Sizes: horizon radius r₊ = m(1 + √(1 − χ²)) (Kerr, Boyer–Lindquist/Kerr–
//!   Schild radius). Mixing this with harmonic-coordinate positions is a
//!   visual approximation, stated in the app.
//! - Merger: the two holes cross-fade into the remnant over [−20 M, +5 M]
//!   around the waveform peak (t = 0); afterwards the remnant drifts with its
//!   recoil kick.

use crate::surrogate::{Params, Remnant, Waveform};

/// Start and end of the cross-fade from the two holes to the remnant, in M.
pub const MERGE_WINDOW: (f64, f64) = (-20.0, 5.0);
const ALIGN_TIME: f64 = -1000.0;

/// One disk to draw: center, radius (M) and opacity in [0, 1].
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Disk {
    pub x: f64,
    pub y: f64,
    pub radius: f64,
    pub opacity: f64,
}

/// Heavier hole, lighter hole and remnant at one instant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BinaryState {
    pub heavy: Disk,
    pub light: Disk,
    pub remnant: Disk,
}

#[derive(Debug, Clone)]
pub struct Binary {
    t0: f64,
    dt: f64,
    angle: Vec<f64>,
    separation: Vec<f64>,
    m1: f64,
    m2: f64,
    r1: f64,
    r2: f64,
    remnant_radius: f64,
    kick: [f64; 2],
    pub remnant: Remnant,
}

/// Kerr horizon radius r₊ = m(1 + √(1 − χ²)).
pub fn horizon_radius(mass: f64, chi: f64) -> f64 {
    mass * (1.0 + (1.0 - chi * chi).max(0.0).sqrt())
}

/// 2PN harmonic-coordinate separation (units of M) at orbital frequency ω.
pub fn pn_separation(omega_orb: f64, eta: f64) -> f64 {
    let x = omega_orb.max(1e-6).powf(2.0 / 3.0);
    let gamma = x * (1.0 + (1.0 - eta / 3.0) * x + (1.0 - 65.0 * eta / 12.0) * x * x);
    1.0 / gamma
}

fn smoothstep(a: f64, b: f64, t: f64) -> f64 {
    let u = ((t - a) / (b - a)).clamp(0.0, 1.0);
    u * u * (3.0 - 2.0 * u)
}

impl Binary {
    /// `wf` must start at or before t = −1000 M.
    pub fn new(wf: &Waveform, p: Params, remnant: Remnant) -> Self {
        let n = wf.len();
        assert!(
            wf.t0 <= ALIGN_TIME,
            "waveform must cover t = {ALIGN_TIME} M"
        );
        let eta = p.q / (1.0 + p.q).powi(2);
        let m1 = p.q / (1.0 + p.q);
        let m2 = 1.0 / (1.0 + p.q);

        let phase_at = |t: f64| {
            let x = (t - wf.t0) / wf.dt;
            let i = (x.floor() as usize).min(n - 2);
            let f = x - i as f64;
            wf.phase22[i] + f * (wf.phase22[i + 1] - wf.phase22[i])
        };
        let ref_phase = phase_at(ALIGN_TIME);
        let angle: Vec<f64> = wf.phase22.iter().map(|p| (p - ref_phase) / 2.0).collect();
        let separation = wf
            .omega22()
            .iter()
            .map(|w| pn_separation(w / 2.0, eta))
            .collect();

        // Kick: rotate from the co-orbital frame at t = −100 M (x toward the
        // heavier hole) into the inertial frame.
        let a = (phase_at(-100.0) - ref_phase) / 2.0;
        let [vx, vy] = remnant.kick_coorbital;
        let kick = [vx * a.cos() - vy * a.sin(), vx * a.sin() + vy * a.cos()];

        Self {
            t0: wf.t0,
            dt: wf.dt,
            angle,
            separation,
            m1,
            m2,
            r1: horizon_radius(m1, p.chi1),
            r2: horizon_radius(m2, p.chi2),
            remnant_radius: horizon_radius(remnant.mass, remnant.spin),
            kick,
            remnant,
        }
    }

    fn sample(v: &[f64], t0: f64, dt: f64, t: f64) -> f64 {
        let x = ((t - t0) / dt).clamp(0.0, (v.len() - 1) as f64);
        let i = (x.floor() as usize).min(v.len() - 2);
        let f = x - i as f64;
        v[i] + f * (v[i + 1] - v[i])
    }

    /// Angle of the heavier hole at time t (radians, counter-clockwise from +x).
    pub fn orbital_angle(&self, t: f64) -> f64 {
        Self::sample(&self.angle, self.t0, self.dt, t)
    }

    /// PN separation at time t (M); only meaningful well before merger.
    pub fn separation(&self, t: f64) -> f64 {
        Self::sample(&self.separation, self.t0, self.dt, t.min(MERGE_WINDOW.0))
    }

    /// Inertial-frame recoil velocity (units of c).
    pub fn kick(&self) -> [f64; 2] {
        self.kick
    }

    pub fn state(&self, t: f64) -> BinaryState {
        let s = smoothstep(MERGE_WINDOW.0, MERGE_WINDOW.1, t);
        let phi = self.orbital_angle(t.min(MERGE_WINDOW.1));
        // Freeze the PN separation once the cross-fade starts.
        let a = self.separation(t);
        let (c, sn) = (phi.cos(), phi.sin());
        let drift = t.max(0.0);
        BinaryState {
            heavy: Disk {
                x: self.m2 * a * c,
                y: self.m2 * a * sn,
                radius: self.r1,
                opacity: 1.0 - s,
            },
            light: Disk {
                x: -self.m1 * a * c,
                y: -self.m1 * a * sn,
                radius: self.r2,
                opacity: 1.0 - s,
            },
            remnant: Disk {
                x: self.kick[0] * drift,
                y: self.kick[1] * drift,
                radius: self.remnant_radius,
                opacity: s,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn horizon_radius_limits() {
        assert!((horizon_radius(1.0, 0.0) - 2.0).abs() < 1e-15);
        assert!((horizon_radius(1.0, 1.0) - 1.0).abs() < 1e-15);
        assert!((horizon_radius(0.5, -0.6) - 0.9).abs() < 1e-15);
    }

    #[test]
    fn pn_separation_approaches_kepler_at_large_separation() {
        // At a = 1000 M the 1PN correction is ~0.1%.
        let omega = 1000f64.powf(-1.5);
        let a = pn_separation(omega, 0.25);
        assert!((a / 1000.0 - 1.0).abs() < 2e-3, "{a}");
        // PN shrinks the separation relative to Kepler at fixed frequency.
        assert!(a < 1000.0);
    }
}
