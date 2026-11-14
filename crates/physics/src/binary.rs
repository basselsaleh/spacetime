//! Black-hole positions and sizes, derived from the waveform model's own
//! dynamics so that the orbits and the waves can never drift apart.
//!
//! - Direction: NRSur7dq4's co-orbital frame has its x-axis from the lighter
//!   to the heavier hole (the frame the model's spins are defined in), so the
//!   heavier hole sits along +x̂_coorb(t) and the lighter along −x̂_coorb(t),
//!   in the plane perpendicular to the orbital angular momentum.
//! - Separation: 2PN relation between orbital frequency and separation in
//!   harmonic coordinates for non-spinning bodies, γ = M/r =
//!   x[1 + (1 − η/3)x + (1 − 65η/12)x²] with x = (M ω)^{2/3}, ω the orbital
//!   frequency (Blanchet, Living Rev. Rel. 17, 2 (2014)). Spin terms are
//!   omitted, and PN breaks down in the last orbits: positions there are
//!   schematic.
//! - Sizes: horizon radius r₊ = m(1 + √(1 − |χ|²)) (Kerr, Boyer–Lindquist/Kerr–
//!   Schild radius). Mixing this with harmonic-coordinate positions is a
//!   visual approximation, stated in the app.
//! - Merger: the two holes cross-fade into the remnant over [−20 M, +5 M]
//!   around the waveform peak (t = 0); afterwards the remnant drifts with its
//!   recoil kick. The orbital frame is frozen at the end of the cross-fade
//!   (in the ringdown NRSur7dq4's frame drifts and no longer means an orbit).

use crate::nrsur7dq4::{Params, Remnant, Waveform};
use crate::quaternion;

/// Start and end of the cross-fade from the two holes to the remnant, in M.
pub const MERGE_WINDOW: (f64, f64) = (-20.0, 5.0);

/// One sphere to draw: center, radius (M) and opacity in [0, 1].
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Disk {
    pub x: f64,
    pub y: f64,
    pub z: f64,
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
    /// Unit vector toward the heavier hole (co-orbital x-axis).
    axis: Vec<[f64; 3]>,
    /// Orbital angular momentum direction (coprecessing z-axis).
    lhat: Vec<[f64; 3]>,
    /// Dimensionless spins of the heavier and lighter holes, inertial frame.
    spin_a: Vec<[f64; 3]>,
    spin_b: Vec<[f64; 3]>,
    separation: Vec<f64>,
    m1: f64,
    m2: f64,
    r1: f64,
    r2: f64,
    remnant_radius: f64,
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

fn norm(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

impl Binary {
    /// `wf` must be on a uniform grid (`Nrsur7dq4::evaluate`).
    pub fn new(wf: &Waveform, p: Params, remnant: Remnant) -> Self {
        assert!(wf.len() >= 2, "waveform too short");
        let eta = p.q / (1.0 + p.q).powi(2);
        let m1 = p.q / (1.0 + p.q);
        let m2 = 1.0 / (1.0 + p.q);
        let axis = (0..wf.len())
            .map(|i| quaternion::rotate(wf.coorbital_frame(i), [1.0, 0.0, 0.0]))
            .collect();
        let lhat = wf
            .quat
            .iter()
            .map(|q| quaternion::rotate(*q, [0.0, 0.0, 1.0]))
            .collect();
        let separation = wf
            .omega_orb()
            .iter()
            .map(|w| pn_separation(*w, eta))
            .collect();
        Self {
            t0: wf.t[0],
            dt: wf.t[1] - wf.t[0],
            axis,
            lhat,
            spin_a: wf.chi_a.clone(),
            spin_b: wf.chi_b.clone(),
            separation,
            m1,
            m2,
            r1: horizon_radius(m1, norm(p.chi_a)),
            r2: horizon_radius(m2, norm(p.chi_b)),
            remnant_radius: horizon_radius(remnant.mass, norm(remnant.spin)),
            remnant,
        }
    }

    fn index(&self, n: usize, t: f64) -> (usize, f64) {
        let x = ((t - self.t0) / self.dt).clamp(0.0, (n - 1) as f64);
        let i = (x.floor() as usize).min(n - 2);
        (i, x - i as f64)
    }

    fn lerp3(&self, v: &[[f64; 3]], t: f64) -> [f64; 3] {
        let (i, f) = self.index(v.len(), t);
        let (a, b) = (v[i], v[i + 1]);
        std::array::from_fn(|k| a[k] + f * (b[k] - a[k]))
    }

    fn unit_at(&self, v: &[[f64; 3]], t: f64) -> [f64; 3] {
        let u = self.lerp3(v, t);
        let n = norm(u);
        u.map(|c| c / n)
    }

    /// Unit vector toward the heavier hole at time t (frozen after the merger window).
    pub fn axis(&self, t: f64) -> [f64; 3] {
        self.unit_at(&self.axis, t.min(MERGE_WINDOW.1))
    }

    /// Direction of the orbital angular momentum at time t (frozen after the
    /// merger window).
    pub fn orbital_axis(&self, t: f64) -> [f64; 3] {
        self.unit_at(&self.lhat, t.min(MERGE_WINDOW.1))
    }

    /// Dimensionless spin vectors of the heavier and lighter holes at time t
    /// (frozen after the merger window).
    pub fn spins(&self, t: f64) -> ([f64; 3], [f64; 3]) {
        let t = t.min(MERGE_WINDOW.1);
        (self.lerp3(&self.spin_a, t), self.lerp3(&self.spin_b, t))
    }

    /// Angle of the heavier hole's direction projected on the xy-plane
    /// (radians, counter-clockwise from +x).
    pub fn orbital_angle(&self, t: f64) -> f64 {
        let a = self.axis(t);
        a[1].atan2(a[0])
    }

    /// PN separation at time t (M); only meaningful well before merger.
    pub fn separation(&self, t: f64) -> f64 {
        let (i, f) = self.index(self.separation.len(), t.min(MERGE_WINDOW.0));
        self.separation[i] + f * (self.separation[i + 1] - self.separation[i])
    }

    /// Inertial-frame recoil velocity (units of c).
    pub fn kick(&self) -> [f64; 3] {
        self.remnant.kick
    }

    pub fn state(&self, t: f64) -> BinaryState {
        let s = smoothstep(MERGE_WINDOW.0, MERGE_WINDOW.1, t);
        let ax = self.axis(t);
        // Freeze the PN separation once the cross-fade starts.
        let a = self.separation(t);
        let drift = t.max(0.0);
        let k = self.remnant.kick;
        let at = |scale: f64, radius: f64, opacity: f64| Disk {
            x: scale * ax[0],
            y: scale * ax[1],
            z: scale * ax[2],
            radius,
            opacity,
        };
        BinaryState {
            heavy: at(self.m2 * a, self.r1, 1.0 - s),
            light: at(-self.m1 * a, self.r2, 1.0 - s),
            remnant: Disk {
                x: k[0] * drift,
                y: k[1] * drift,
                z: k[2] * drift,
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
