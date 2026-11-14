//! Schwarzschild light rays: two independent methods agree, and they
//! reproduce known results (weak-field deflection, capture threshold, shadow).

use std::f64::consts::PI;

use spacetime_physics::geodesic::{
    B_CRIT, Fate, escape_direction, impact_parameter, shadow_angular_radius, sweep_ode,
    sweep_quadrature,
};

fn phi(f: Fate) -> f64 {
    match f {
        Fate::Escaped { phi } => phi,
        Fate::Captured => panic!("captured"),
    }
}

#[test]
fn quadrature_and_ode_agree() {
    let mut worst: f64 = 0.0;
    let mut compared = 0;
    for r0 in [3.5, 6.0, 20.0, 100.0] {
        for k in 1..60 {
            let psi = PI * k as f64 / 60.0;
            let b = impact_parameter(r0, psi);
            if (b - B_CRIT).abs() < 1e-2 * B_CRIT {
                continue; // near the photon sphere both slow down; covered separately
            }
            let q = sweep_quadrature(r0, psi);
            let o = sweep_ode(r0, psi, 1e-3, 1_000_000).expect("ODE did not finish");
            match (q, o) {
                (Fate::Captured, Fate::Captured) => {}
                (Fate::Escaped { phi: a }, Fate::Escaped { phi: b }) => {
                    worst = worst.max((a - b).abs());
                    compared += 1;
                }
                _ => panic!("fates differ at r0 = {r0}, psi = {psi}: {q:?} vs {o:?}"),
            }
        }
    }
    assert!(compared > 150);
    assert!(worst < 1e-11, "worst |Δφ| = {worst:e}");
}

#[test]
fn weak_field_deflection() {
    // Far away the deflection is α = 4/b + (15π/4)/b² + O(1/b³) (M = 1). The
    // straight-line sweep from the observer is ψ, so α = φ∞ − ψ.
    let r0 = 1e8f64;
    for b in [1e3f64, 3e3, 1e4] {
        let psi = PI - (b * (1.0 - 2.0 / r0).sqrt() / r0).asin(); // inward ray
        let alpha = phi(sweep_quadrature(r0, psi)) - psi;
        let expect = 4.0 / b + 15.0 * PI / 4.0 / (b * b);
        let rel = (alpha - expect).abs() / expect;
        assert!(
            rel < 1e-4,
            "b = {b}: α = {alpha:e}, expected {expect:e} (rel {rel:e})"
        );
    }
}

#[test]
fn capture_threshold_is_the_critical_impact_parameter() {
    for r0 in [3.2f64, 5.0, 30.0] {
        let alpha = shadow_angular_radius(r0);
        // Inward rays just inside the shadow edge fall in, just outside escape.
        assert_eq!(
            sweep_quadrature(r0, PI - alpha * (1.0 - 1e-6)),
            Fate::Captured
        );
        assert!(matches!(
            sweep_quadrature(r0, PI - alpha * (1.0 + 1e-6)),
            Fate::Escaped { .. }
        ));
        assert!((impact_parameter(r0, PI - alpha) - B_CRIT).abs() < 1e-9);
    }
}

#[test]
fn rays_near_the_photon_sphere_wind_around() {
    // As b → b_c from above the sweep grows like −ln(b − b_c).
    let r0 = 20.0f64;
    let mut last = 0.0;
    for eps in [1e-2, 1e-4, 1e-6] {
        let b = B_CRIT * (1.0 + eps);
        let psi = PI - (b * (1.0 - 2.0 / r0).sqrt() / r0).asin();
        let p = phi(sweep_quadrature(r0, psi));
        assert!(p > last + 2.0, "eps = {eps}: φ = {p}");
        last = p;
    }
    assert!(last > 3.0 * PI, "φ = {last}");
}

#[test]
fn escape_directions() {
    let cam = [0.0f64, -20.0, 5.0];
    let n = {
        let r = cam[0] * cam[0] + cam[1] * cam[1] + cam[2] * cam[2];
        cam.map(|c| c / r.sqrt())
    };
    // Straight outward: unchanged.
    let out = escape_direction(cam, n).unwrap();
    assert!((0..3).all(|i| (out[i] - n[i]).abs() < 1e-12));
    // Straight at the hole: captured.
    assert!(escape_direction(cam, n.map(|c| -c)).is_none());
    // A ray bends towards the hole: its sky direction is rotated further from n̂ than the ray.
    let d = [1.0, 0.0, 0.0];
    let e = escape_direction(cam, d).unwrap();
    let ang = |a: [f64; 3], b: [f64; 3]| {
        (a[0] * b[0] + a[1] * b[1] + a[2] * b[2])
            .clamp(-1.0, 1.0)
            .acos()
    };
    assert!(ang(e, n) > ang(d, n) + 1e-3);
    // The result stays a unit vector in the plane of n̂ and d.
    let len = (e[0] * e[0] + e[1] * e[1] + e[2] * e[2]).sqrt();
    assert!((len - 1.0).abs() < 1e-12);
    let normal = [
        n[1] * d[2] - n[2] * d[1],
        n[2] * d[0] - n[0] * d[2],
        n[0] * d[1] - n[1] * d[0],
    ];
    assert!((normal[0] * e[0] + normal[1] * e[1] + normal[2] * e[2]).abs() < 1e-12);
}
