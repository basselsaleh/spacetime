//! Embedding diagrams: the quadrature reproduces Flamm's paraboloid and the
//! closed-form proper distance, the intrinsic curvature matches the curvature
//! of the embedded surface (Gauss's Theorema Egregium), and non-embeddable
//! slices are caught.

use spacetime_physics::embedding::{
    EmbedError, Schwarzschild, Slice, flamm_distance, flamm_height, gaussian_curvature, profile,
};

/// Radii from the horizon outward, denser near it (uniform in √(r − 2)).
fn radii(r_max: f64, n: usize) -> Vec<f64> {
    (0..=n)
        .map(|i| 2.0 + (r_max - 2.0) * (i as f64 / n as f64).powi(2))
        .collect()
}

#[test]
fn quadrature_matches_flamm() {
    let r = radii(100.0, 400);
    let p = profile(&Schwarzschild, &r).unwrap();
    let (mut worst_z, mut worst_d) = (0.0_f64, 0.0_f64);
    for i in 0..r.len() {
        worst_z =
            worst_z.max((p.height[i] - flamm_height(r[i])).abs() / (1.0 + flamm_height(r[i])));
        worst_d = worst_d
            .max((p.distance[i] - flamm_distance(r[i])).abs() / (1.0 + flamm_distance(r[i])));
    }
    println!("height {worst_z:.1e}, distance {worst_d:.1e}");
    // The height integrand is exactly the constant 2√2 here, so what remains is
    // rounding accumulated over ~3000 quadrature terms (about 2e-12).
    assert!(worst_z < 1e-11, "height error {worst_z:e}");
    assert!(worst_d < 1e-11, "distance error {worst_d:e}");
    assert_eq!(p.height[0], 0.0);
    assert_eq!(p.distance[0], 0.0);
}

#[test]
fn curvature_is_minus_one_over_r_cubed() {
    for r in [2.0, 2.5, 3.0, 6.0, 30.0, 1e3] {
        let k = gaussian_curvature(&Schwarzschild, r);
        assert!(
            (k + 1.0 / (r * r * r)).abs() <= 1e-15 / (r * r * r),
            "r = {r}: K = {k}"
        );
    }
}

/// The curvature of the surface in R³, from its profile z(ρ) alone: for a
/// surface of revolution z(ρ), K = z′ z″ / (ρ (1 + z′²)²). Finite differences of
/// the computed profile; agreement with the intrinsic K checks the embedding.
#[test]
fn extrinsic_curvature_matches_intrinsic() {
    let dr = 1e-3;
    let mut worst = 0.0_f64;
    for r in [2.2, 3.0, 4.0, 8.0, 20.0, 60.0] {
        let p = profile(&Schwarzschild, &[r - dr, r, r + dr]).unwrap();
        // R = r here, so ρ-derivatives are r-derivatives.
        let z1 = (p.height[2] - p.height[0]) / (2.0 * dr);
        let z2 = (p.height[2] - 2.0 * p.height[1] + p.height[0]) / (dr * dr);
        let k_ext = z1 * z2 / (r * (1.0 + z1 * z1).powi(2));
        let k = p.curvature[1];
        worst = worst.max((k_ext - k).abs() / k.abs());
    }
    println!("extrinsic vs intrinsic: {worst:.1e}");
    assert!(worst < 1e-5, "relative error {worst:e}");
}

#[test]
fn flat_far_away() {
    let r = [1e3, 1e6];
    let p = profile(&Schwarzschild, &r).unwrap();
    for i in 0..2 {
        let slope = (2.0 / (r[i] - 2.0)).sqrt(); // dz/dr
        assert!(slope < 0.05);
        // Circumference over 2π × (distance from the horizon + its radius) → 1 (slowly: ln r / r).
        let ratio = p.circ[i] / (p.distance[i] + 2.0);
        let tol = 2.0 * (r[i]).ln() / r[i];
        assert!((ratio - 1.0).abs() < tol, "r = {}: ratio {ratio}", r[i]);
    }
}

/// A made-up slice with a horizon at r = 2 but f > 1 far out
/// (f = 1 + 1/r − 6/r²), so circles there grow faster than radial distance.
struct Toy;
impl Slice for Toy {
    fn f(&self, r: f64) -> f64 {
        1.0 + 1.0 / r - 6.0 / (r * r)
    }
    fn df(&self, r: f64) -> f64 {
        -1.0 / (r * r) + 12.0 / (r * r * r)
    }
    fn circ(&self, r: f64) -> f64 {
        r
    }
    fn dcirc(&self, _r: f64) -> f64 {
        1.0
    }
    fn d2circ(&self, _r: f64) -> f64 {
        0.0
    }
    fn horizon(&self) -> f64 {
        2.0
    }
}

#[test]
fn non_embeddable_is_caught() {
    // f = 1 at r = 6; embeddable inside, not outside.
    assert!(profile(&Toy, &[2.0, 3.0, 5.9]).is_ok());
    match profile(&Toy, &[2.0, 10.0]) {
        Err(EmbedError::NotEmbeddable { r }) => assert!(r > 6.0 && r < 10.0, "r = {r}"),
        other => panic!("expected NotEmbeddable, got {other:?}"),
    }
}

#[test]
fn bad_radii_are_rejected() {
    assert_eq!(
        profile(&Schwarzschild, &[1.9, 3.0]),
        Err(EmbedError::BadRadii)
    );
    assert_eq!(
        profile(&Schwarzschild, &[3.0, 2.5]),
        Err(EmbedError::BadRadii)
    );
}
