//! Embedding diagrams: the quadrature reproduces Flamm's paraboloid and the
//! closed-form proper distance, the intrinsic curvature matches the curvature
//! of the embedded surface (Gauss's Theorema Egregium), and non-embeddable
//! slices are caught. The uniform-density star matches its closed forms
//! (a spherical cap joined to Flamm's paraboloid), and the Einstein–Rosen
//! bridge's two sheets join smoothly at the throat.

use spacetime_physics::embedding::{
    EmbedError, Schwarzschild, Slice, Star, flamm_distance, flamm_height, flamm_meridian,
    gaussian_curvature, profile, star_distance, star_height,
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
    fn inner(&self) -> f64 {
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

/// The curvature of the embedded surface from its profile alone (central
/// differences of z(ρ), with ρ = r here), relative to the intrinsic K.
fn extrinsic_error<S: Slice>(s: &S, r: f64, dr: f64) -> f64 {
    let p = profile(s, &[s.inner(), r - dr, r, r + dr]).unwrap();
    let z1 = (p.height[3] - p.height[1]) / (2.0 * dr);
    let z2 = (p.height[3] - 2.0 * p.height[2] + p.height[1]) / (dr * dr);
    let k_ext = z1 * z2 / (r * (1.0 + z1 * z1).powi(2));
    (k_ext - p.curvature[2]).abs() / p.curvature[2].abs()
}

#[test]
fn star_matches_closed_forms() {
    let mut worst = 0.0_f64;
    for rs in [Star::BUCHDAHL, 3.0, 6.0, 20.0] {
        let star = Star::new(rs).unwrap();
        // Uniform in √r out to 100 M, plus the surface itself.
        let mut r: Vec<f64> = (0..=400)
            .map(|i| 100.0 * (i as f64 / 400.0).powi(2))
            .collect();
        r.push(rs);
        r.sort_by(f64::total_cmp);
        let p = profile(&star, &r).unwrap();
        for i in 0..r.len() {
            let (z, d) = (star_height(rs, r[i]), star_distance(rs, r[i]));
            worst = worst.max((p.height[i] - z).abs() / (1.0 + z));
            worst = worst.max((p.distance[i] - d).abs() / (1.0 + d));
        }
    }
    println!("star vs closed forms: {worst:.1e}");
    assert!(worst < 1e-11, "error {worst:e}");
}

#[test]
fn star_curvature_flips_sign_at_the_surface() {
    let rs = 6.0;
    let star = Star::new(rs).unwrap();
    // The override agrees with the metric formula on both sides.
    for r in [0.5, 3.0, 5.99, 6.0, 6.01, 10.0, 40.0] {
        let k = star.curvature(r);
        assert!((k - gaussian_curvature(&star, r)).abs() < 1e-15, "r = {r}");
    }
    assert_eq!(star.curvature(0.0), 2.0 / 216.0);
    assert_eq!(star.curvature(rs), 2.0 / 216.0);
    assert!((star.curvature(rs + 1e-9) + 1.0 / 216.0).abs() < 1e-11);
    // And the embedded surface agrees: positive (bowl) inside, negative (saddle) outside.
    let mut worst = 0.0_f64;
    for r in [1.0, 3.0, 5.0, 7.0, 12.0, 30.0] {
        worst = worst.max(extrinsic_error(&star, r, 1e-3));
    }
    println!("star extrinsic vs intrinsic: {worst:.1e}");
    assert!(worst < 1e-5, "relative error {worst:e}");
}

#[test]
fn star_surface_is_smooth() {
    // The slope dz/dr is continuous at the surface (the curvature jumps, the tangent doesn't).
    for rs in [Star::BUCHDAHL, 6.0, 20.0] {
        let star = Star::new(rs).unwrap();
        let h = 1e-6;
        let p = profile(&star, &[0.0, rs - h, rs, rs + h]).unwrap();
        let inside = (p.height[2] - p.height[1]) / h;
        let outside = (p.height[3] - p.height[2]) / h;
        let exact = (2.0 / (rs - 2.0)).sqrt();
        assert!(
            (inside - exact).abs() < 1e-4 * exact,
            "rs = {rs}: inside {inside}"
        );
        assert!(
            (outside - exact).abs() < 1e-4 * exact,
            "rs = {rs}: outside {outside}"
        );
    }
}

#[test]
fn large_star_is_nearly_flat() {
    // The steepest point is the surface, where dz/dr = √(2/(r_s − 2)).
    let rs = 1e4;
    let star = Star::new(rs).unwrap();
    let r: Vec<f64> = (0..=200).map(|i| 3.0 * rs * i as f64 / 200.0).collect();
    let p = profile(&star, &r).unwrap();
    let steepest = p
        .height
        .windows(2)
        .zip(r.windows(2))
        .map(|(z, r)| (z[1] - z[0]) / (r[1] - r[0]))
        .fold(0.0, f64::max);
    assert!(steepest < 0.015, "steepest slope {steepest}");
    assert!(Star::new(2.0).is_none());
}

#[test]
fn bridge_sheets_join_smoothly() {
    // Read back as ρ(z), the profile is the even function 2 + z²/8: its mirror
    // image through the throat continues it with no kink (dρ/dz = 0 at z = 0).
    let r: Vec<f64> = (0..=200)
        .map(|i| 2.0 + 50.0 * (i as f64 / 200.0).powi(2))
        .collect();
    let p = profile(&Schwarzschild, &r).unwrap();
    for i in 0..r.len() {
        assert!((p.circ[i] - flamm_meridian(p.height[i])).abs() < 1e-10 * p.circ[i]);
        assert_eq!(flamm_meridian(-p.height[i]), flamm_meridian(p.height[i]));
    }
    let near = profile(&Schwarzschild, &[2.0, 2.0 + 1e-8]).unwrap();
    let slope = (near.circ[1] - near.circ[0]) / (near.height[1] - near.height[0]);
    assert!(slope < 1e-4, "dρ/dz at the throat {slope}");
}
