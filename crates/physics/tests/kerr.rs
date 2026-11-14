//! Kerr light rays: the two independent methods agree with each other and
//! with the Schwarzschild reference at spin 0, conserve the constants of
//! motion, and reproduce known results (the shadow's edge, its shape and
//! orientation, the weak-field deflection).

use std::f64::consts::PI;

use spacetime_physics::geodesic;
use spacetime_physics::kerr::{
    Fate, REFERENCE_STEPS, SHADER_STEPS, bl_metric, bl_to_ks_jacobian, escape_direction, frame,
    horizon_radius, ks_invariant_drift, ks_invariants, ks_metric, ks_start, shadow_edge, trace_ks,
    trace_mino, zamo,
};

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn angle(a: [f64; 3], b: [f64; 3]) -> f64 {
    let c = [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
    dot(c, c).sqrt().atan2(dot(a, b))
}

fn normalize(v: [f64; 3]) -> [f64; 3] {
    let n = dot(v, v).sqrt();
    v.map(|x| x / n)
}

/// Camera at distance r0 and inclination `incl` (degrees from the +z spin axis), at azimuth 30°.
fn camera(r0: f64, incl: f64) -> [f64; 3] {
    let (st, ct) = incl.to_radians().sin_cos();
    let (sp, cp) = 30f64.to_radians().sin_cos();
    [r0 * st * cp, r0 * st * sp, r0 * ct]
}

/// A pixel direction at angle β from the direction to the hole, rotated γ about it.
fn pixel(cam: [f64; 3], beta: f64, gamma: f64) -> [f64; 3] {
    let f = frame(cam);
    let (sb, cb) = beta.sin_cos();
    let (sg, cg) = gamma.sin_cos();
    std::array::from_fn(|i| -cb * f.e_r[i] + sb * (cg * f.e_theta[i] + sg * f.e_phi[i]))
}

/// The shadow's angular size (largest angle from the direction to the hole to its edge) and edge.
fn shadow(cam: [f64; 3], a: f64) -> (f64, Vec<[f64; 3]>) {
    let edge = shadow_edge(cam, a, 2000);
    let center = frame(cam).e_r.map(|x| -x);
    let size = edge.iter().map(|&e| angle(e, center)).fold(0.0, f64::max);
    (size, edge)
}

/// Whether `d` is within `band` (a fraction of the shadow's size) of the shadow's edge.
fn near_edge(d: [f64; 3], size: f64, edge: &[[f64; 3]], band: f64) -> bool {
    edge.iter().any(|&e| angle(d, e) < band * size)
}

#[test]
fn zamo_frame_is_orthonormal() {
    for s in [-0.9, 0.0, 0.5, 0.998] {
        for (r, th) in [(1.5f64, 1.2f64), (3.5, 0.3), (20.0, PI / 2.0), (300.0, 2.5)] {
            if r <= horizon_radius(s) {
                continue;
            }
            let g = bl_metric(s, r, th);
            let z = zamo(s, r, th.cos());
            let varpi = z.varpi_over_sin * th.sin();
            let e = [
                [1.0 / z.alpha, 0.0, 0.0, z.omega / z.alpha],
                [0.0, (z.delta / z.sigma).sqrt(), 0.0, 0.0],
                [0.0, 0.0, 1.0 / z.sigma.sqrt(), 0.0],
                [0.0, 0.0, 0.0, 1.0 / varpi],
            ];
            for a in 0..4 {
                for b in 0..4 {
                    let gab: f64 = (0..4)
                        .flat_map(|i| (0..4).map(move |j| (i, j)))
                        .map(|(i, j)| g[i][j] * e[a][i] * e[b][j])
                        .sum();
                    let eta = if a != b {
                        0.0
                    } else if a == 0 {
                        -1.0
                    } else {
                        1.0
                    };
                    assert!((gab - eta).abs() < 1e-12, "s {s} r {r}: g({a},{b}) = {gab}");
                }
            }
        }
    }
}

#[test]
fn kerr_schild_metric_is_the_transformed_boyer_lindquist_metric() {
    for s in [-0.998, -0.5, 0.0, 0.7, 0.998] {
        for (r, th, ph) in [(1.2f64, 0.7f64, 0.3f64), (3.0, 1.9, -2.0), (50.0, 0.1, 1.0)] {
            if r <= horizon_radius(s) {
                continue;
            }
            let (j, pos) = bl_to_ks_jacobian(s, r, th, ph);
            let gk = ks_metric(s, pos);
            let gb = bl_metric(s, r, th);
            for a in 0..4 {
                for b in 0..4 {
                    let v: f64 = (0..4)
                        .flat_map(|i| (0..4).map(move |k| (i, k)))
                        .map(|(i, k)| j[i][a] * gk[i][k] * j[k][b])
                        .sum();
                    let scale = gb[a][b].abs().max(1.0);
                    assert!(
                        (v - gb[a][b]).abs() < 1e-10 * scale,
                        "s {s} r {r}: ({a},{b}) KS {v} vs BL {}",
                        gb[a][b]
                    );
                }
            }
        }
    }
}

#[test]
fn initial_momenta_are_null() {
    for a in [0.0, 0.5, 0.998] {
        for cam in [camera(3.5, 90.0), camera(20.0, 17.0), [0.0, 0.0, 10.0]] {
            for (beta, gamma) in [(0.0, 0.0), (0.4, 1.0), (1.5, 3.0), (2.8, -2.0)] {
                let (y, e) = ks_start(cam, -a, pixel(cam, beta, gamma));
                let [h, ..] = ks_invariants(-a, e, &y);
                assert!(h.abs() < 1e-12 * e * e, "a {a}: H = {h}");
                assert!(e > 0.0);
            }
        }
    }
}

#[test]
fn spin_zero_matches_schwarzschild() {
    let mut worst_mino: f64 = 0.0;
    let mut worst_ks: f64 = 0.0;
    let mut compared = 0;
    for r0 in [3.5, 6.0, 20.0, 100.0] {
        let cam = camera(r0, 60.0);
        for k in 1..40 {
            let beta = PI * k as f64 / 40.0;
            // Near the photon sphere, as in the Schwarzschild tests. (This also skips
            // r0 = 6, β = 3π/4, where b = b_c exactly and the Schwarzschild quadrature
            // loses accuracy on an outward ray: 9e-5 rad.)
            let b = geodesic::impact_parameter(r0, PI - beta);
            if (b - geodesic::B_CRIT).abs() < 0.01 * geodesic::B_CRIT {
                continue;
            }
            let d = pixel(cam, beta, 0.7 * k as f64);
            let want = geodesic::escape_direction(cam, d);
            let mino = escape_direction(cam, 0.0, d);
            let ks = trace_ks(cam, 0.0, d, 1e-12).fate;
            match (want, mino, ks) {
                (None, None, Some(Fate::Captured)) => {}
                (Some(w), Some(m), Some(Fate::Escaped(k))) => {
                    worst_mino = worst_mino.max(angle(w, m));
                    worst_ks = worst_ks.max(angle(w, k));
                    compared += 1;
                }
                other => panic!("r0 {r0}, β {beta}: fates differ: {other:?}"),
            }
        }
    }
    println!("spin 0 vs Schwarzschild: Mino {worst_mino:e}, KS {worst_ks:e} rad over {compared}");
    assert!(compared > 100);
    assert!(worst_mino < 1e-9, "Mino: {worst_mino:e}");
    assert!(worst_ks < 1e-8, "KS: {worst_ks:e}");
}

/// Spins, inclinations (degrees) and distances for the comparisons.
const SPINS: [f64; 4] = [0.0, 0.5, 0.9, 0.998];
const INCLINATIONS: [f64; 4] = [0.0, 17.0, 60.0, 90.0];
const DISTANCES: [f64; 3] = [3.5, 20.0, 300.0];

/// Pixel directions spread over the shadow, the ring around it and the rest of the sky.
fn sample_pixels(cam: [f64; 3], size: f64) -> Vec<[f64; 3]> {
    let mut out = Vec::new();
    for (i, f) in [0.3, 0.8, 1.15, 1.5, 2.5].iter().enumerate() {
        let beta = (f * size).min(PI - 0.05);
        for j in 0..8 {
            out.push(pixel(cam, beta, 2.0 * PI * j as f64 / 8.0 + 0.3 * i as f64));
        }
    }
    for beta in [1.2f64, 2.0, 2.9] {
        for j in 0..4 {
            out.push(pixel(
                cam,
                beta.max(size * 1.1).min(3.0),
                1.6 * j as f64 + 0.2,
            ));
        }
    }
    out
}

#[test]
fn mino_and_kerr_schild_agree() {
    let mut worst: f64 = 0.0;
    let (mut compared, mut captured, mut skipped) = (0, 0, 0);
    for a in SPINS {
        for incl in INCLINATIONS {
            for r0 in DISTANCES {
                let cam = camera(r0, incl);
                let (size, edge) = shadow(cam, a);
                for d in sample_pixels(cam, size) {
                    if near_edge(d, size, &edge, 0.02) {
                        skipped += 1;
                        continue;
                    }
                    let m = trace_mino::<f64>(cam, a, d, &REFERENCE_STEPS).fate;
                    let k = trace_ks(cam, a, d, 1e-12).fate;
                    match (m, k) {
                        (Some(Fate::Captured), Some(Fate::Captured)) => captured += 1,
                        (Some(Fate::Escaped(x)), Some(Fate::Escaped(y))) => {
                            worst = worst.max(angle(x, y));
                            compared += 1;
                        }
                        other => panic!("a {a}, incl {incl}, r0 {r0}, d {d:?}: {other:?}"),
                    }
                }
            }
        }
    }
    println!(
        "Mino vs KS: worst {worst:e} rad over {compared} escaping, {captured} captured, {skipped} near the edge"
    );
    assert!(compared > 1000 && captured > 300);
    assert!(worst < 1e-8, "worst {worst:e}");
}

#[test]
fn kerr_schild_conserves_the_constants_of_motion() {
    let mut worst = [0.0f64; 4];
    for a in [0.5, 0.998] {
        for incl in [17.0, 90.0] {
            let cam = camera(10.0, incl);
            let (size, _) = shadow(cam, a);
            for d in sample_pixels(cam, size).into_iter().step_by(5) {
                let drift = ks_invariant_drift(cam, a, d, 1e-12);
                for i in 0..4 {
                    worst[i] = worst[i].max(drift[i]);
                }
            }
        }
    }
    println!(
        "KS drift: H {:e}, E {:e}, L {:e}, Q {:e}",
        worst[0], worst[1], worst[2], worst[3]
    );
    assert!(worst.iter().all(|&w| w < 1e-10), "{worst:?}");
}

#[test]
fn the_shadow_edge_separates_captured_from_escaping_rays() {
    for a in [0.5, 0.9, 0.998] {
        for incl in [0.0, 17.0, 60.0, 90.0] {
            for r0 in [5.0, 20.0, 100.0] {
                let cam = camera(r0, incl);
                let center = frame(cam).e_r.map(|x| -x);
                let edge = shadow_edge(cam, a, 400);
                assert!(edge.len() > 390);
                for &e in edge.iter().step_by(20) {
                    assert!(
                        (dot(e, e) - 1.0).abs() < 1e-12,
                        "edge point not a unit vector"
                    );
                    let toward = |t: f64| {
                        normalize(std::array::from_fn(|i| center[i] + t * (e[i] - center[i])))
                    };
                    let inside = escape_direction(cam, a, toward(1.0 - 2e-4));
                    let outside = escape_direction(cam, a, toward(1.0 + 2e-4));
                    assert!(
                        inside.is_none(),
                        "a {a}, incl {incl}, r0 {r0}: inside escaped"
                    );
                    assert!(
                        outside.is_some(),
                        "a {a}, incl {incl}, r0 {r0}: outside captured"
                    );
                }
            }
        }
    }
}

/// The angle from the direction to the hole at which rays at rotation γ stop being captured.
fn edge_angle(cam: [f64; 3], a: f64, gamma: f64) -> f64 {
    let (mut lo, mut hi) = (0.0, PI / 2.0);
    for _ in 0..30 {
        let mid = 0.5 * (lo + hi);
        if escape_direction(cam, a, pixel(cam, mid, gamma)).is_none() {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

#[test]
fn seen_along_the_spin_axis_the_shadow_is_round() {
    for a in [0.5, 0.998] {
        let cam = [0.0, 0.0, 15.0];
        let (size, _) = shadow(cam, a);
        for g in 0..6 {
            let beta = edge_angle(cam, a, g as f64);
            assert!((beta - size).abs() < 1e-7, "a {a}, γ {g}: {beta} vs {size}");
        }
    }
}

#[test]
fn the_shadow_is_flattened_on_the_approaching_side() {
    // Camera on the +x axis in the equatorial plane, spin +z: the hole's −y side
    // moves toward the camera. Prograde photons pass there, closer to the hole,
    // so the shadow's edge on that side is nearer the center.
    let cam = [20.0, 0.0, 0.0];
    let f = frame(cam);
    assert!(f.e_phi[1] > 0.99); // φ̂ = +y here, so γ = π/2 looks toward +y
    for a in [0.5, 0.998] {
        let toward_plus_y = edge_angle(cam, a, PI / 2.0);
        let toward_minus_y = edge_angle(cam, a, -PI / 2.0);
        let up = edge_angle(cam, a, 0.0);
        println!(
            "a {a}: edge at −y {toward_minus_y:.5}, +y {toward_plus_y:.5}, along the axis {up:.5} rad"
        );
        assert!(toward_minus_y < toward_plus_y - 0.01);
    }
    // And the a → 0 limit is the Schwarzschild radius.
    let rs = geodesic::shadow_angular_radius(20.0);
    assert!((edge_angle(cam, 1e-6, PI / 2.0) - rs).abs() < 1e-6);
}

#[test]
fn mirror_symmetry_through_the_equatorial_plane() {
    let flip = |v: [f64; 3]| [v[0], v[1], -v[2]];
    for a in [0.5, 0.998] {
        let cam = camera(12.0, 50.0);
        let (size, _) = shadow(cam, a);
        for d in sample_pixels(cam, size) {
            let one = escape_direction(cam, a, d);
            let two = escape_direction(flip(cam), a, flip(d));
            match (one, two) {
                (None, None) => {}
                (Some(x), Some(y)) => assert!(angle(flip(x), y) < 1e-10),
                other => panic!("{other:?}"),
            }
        }
    }
}

#[test]
fn weak_field_deflection_with_spin() {
    // Equatorial rays far from the hole: α = 4/b + (15π/4)/b² ∓ 4a/b² + O(1/b³),
    // − for prograde rays. A camera on +x at r0 looks past the hole's −y side
    // (γ = −π/2) at prograde photons (L > 0), as in the flattening test.
    let r0 = 1e7f64;
    let cam = [r0, 0.0, 0.0];
    for a in [0.5, 0.998] {
        for b in [300.0f64, 1000.0] {
            let beta = (b / r0).asin();
            let deflection = |gamma: f64| {
                let d = pixel(cam, beta, gamma);
                angle(d, escape_direction(cam, a, d).unwrap())
            };
            let (pro, retro) = (deflection(-PI / 2.0), deflection(PI / 2.0));
            let diff = retro - pro;
            let mean = 0.5 * (pro + retro);
            let want_mean = 4.0 / b + 15.0 * PI / 4.0 / (b * b);
            println!(
                "a {a}, b {b}: retro − pro {diff:e} (8a/b² = {:e}), mean {mean:e} ({want_mean:e})",
                8.0 * a / (b * b)
            );
            // The next orders are O(1/b³): a few percent of the spin term at b = 300.
            assert!((diff / (8.0 * a / (b * b)) - 1.0).abs() < 0.04);
            assert!((mean / want_mean - 1.0).abs() < 2e-4);
        }
    }
}

#[test]
fn float32_and_shader_step_errors() {
    // What the GPU (float32, the shader's step control) should achieve: the error
    // of trace_mino with SHADER_STEPS in f64 (truncation) and in f32, against the
    // reference, in the step 2b self-test's views.
    let views: [(f64, [f64; 3]); 8] = [
        (0.5, [0.0, 0.0, 40.0]),
        (0.5, camera(40.0, 17.0)),
        (0.5, camera(40.0, 90.0)),
        (0.5, camera(5.0, 90.0)),
        (0.998, [0.0, 0.0, 40.0]),
        (0.998, camera(40.0, 17.0)),
        (0.998, camera(40.0, 90.0)),
        (0.998, camera(5.0, 90.0)),
    ];
    let mut worst64: f64 = 0.0;
    let mut worst32: f64 = 0.0;
    let mut most_steps = 0;
    let mut fate_flips = 0;
    let mut total = 0;
    for (a, cam) in views {
        let (size, edge) = shadow(cam, a);
        for d in sample_pixels(cam, size) {
            if near_edge(d, size, &edge, 0.02) {
                continue;
            }
            total += 1;
            let want = trace_mino::<f64>(cam, a, d, &REFERENCE_STEPS).fate;
            let t64 = trace_mino::<f64>(cam, a, d, &SHADER_STEPS);
            let t32 = trace_mino::<f32>(cam, a, d, &SHADER_STEPS);
            most_steps = most_steps.max(t64.steps).max(t32.steps);
            for (t, worst) in [(t64, &mut worst64), (t32, &mut worst32)] {
                match (want, t.fate) {
                    (Some(Fate::Escaped(x)), Some(Fate::Escaped(y))) => {
                        *worst = worst.max(angle(x, y))
                    }
                    (Some(Fate::Captured), Some(Fate::Captured)) => {}
                    _ => fate_flips += 1,
                }
            }
        }
    }
    println!(
        "shader steps: f64 {worst64:e}, f32 {worst32:e} rad over {total} rays; most steps {most_steps}; fate flips {fate_flips}"
    );
    assert_eq!(fate_flips, 0);
    assert!(worst64 < 1e-4 && worst32 < 1e-4);
}
