//! Orbits and remnant: remnant fits against surfinBH, and the orientation /
//! retarded-time lag between the black holes and the waves they emit.

use std::f64::consts::{FRAC_PI_2, PI};
use std::path::PathBuf;

use serde::Deserialize;
use spacetime_physics::binary::Binary;
use spacetime_physics::harmonics::spin_weighted_ylm;
use spacetime_physics::surrogate::{Params, Surrogate};

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn surrogate() -> Surrogate {
    Surrogate::from_bytes(&std::fs::read(repo_path("web/public/nrhybsur3dq8.stsur")).unwrap())
        .unwrap()
}

#[derive(Deserialize)]
struct RemnantGolden {
    cases: Vec<RemnantCase>,
}

#[derive(Deserialize)]
struct RemnantCase {
    q: f64,
    chi1: f64,
    chi2: f64,
    mf: f64,
    chif: f64,
    vf: [f64; 2],
}

#[test]
fn remnant_matches_surfinbh() {
    let sur = surrogate();
    let golden: RemnantGolden = serde_json::from_slice(
        &std::fs::read(repo_path("tests/golden/nrsur3dq8remnant.json")).unwrap(),
    )
    .unwrap();
    for c in golden.cases {
        let r = sur
            .remnant(Params {
                q: c.q,
                chi1: c.chi1,
                chi2: c.chi2,
            })
            .unwrap()
            .expect("data file includes remnant fits");
        assert!((r.mass - c.mf).abs() < 1e-10, "mf {} vs {}", r.mass, c.mf);
        assert!(
            (r.spin - c.chif).abs() < 1e-10,
            "chif {} vs {}",
            r.spin,
            c.chif
        );
        for k in 0..2 {
            assert!(
                (r.kick_coorbital[k] - c.vf[k]).abs() < 1e-12,
                "vf {:?} vs {:?}",
                r.kick_coorbital,
                c.vf
            );
        }
    }
}

fn binary(q: f64, chi1: f64, chi2: f64) -> (Binary, spacetime_physics::surrogate::Waveform) {
    let sur = surrogate();
    let p = Params { q, chi1, chi2 };
    let wf = sur.evaluate(p, -6000.0, 1.0).unwrap();
    let b = Binary::new(&wf, p, sur.remnant(p).unwrap().unwrap());
    (b, wf)
}

/// Wraps an angle difference into (−π/2, π/2]: the quadrupole pattern repeats every π.
fn wrap_half_pi(a: f64) -> f64 {
    let x = a.rem_euclid(PI);
    if x > FRAC_PI_2 { x - PI } else { x }
}

#[test]
fn waves_trail_the_binary_with_retarded_time() {
    // Leading-order quadrupole, with the LAL polarisation convention the
    // surrogate uses (h₊ = ½(h_φφ − h_θθ) in the orbital plane; Blanchet/Kidder
    // differ by an overall sign): h₊ ∝ +cos 2(φ − Φ(t − r)), i.e. h₊ is largest
    // along the binary's axis as it was at the retarded time t − r.
    // Use the (2,±2) modes during the inspiral, where this is accurate.
    for (q, chi1, chi2) in [(1.0, 0.0, 0.0), (3.0, 0.6, 0.2), (8.0, -0.4, 0.8)] {
        let (b, wf) = binary(q, chi1, chi2);
        for (t, r) in [(-3000.0, 150.0), (-3000.0, 600.0), (-1500.0, 400.0)] {
            let i = ((t - r - wf.t0) / wf.dt).round() as usize;
            let h22 = wf.h(2, 2, i).unwrap();
            let h2m2 = wf.h(2, -2, i).unwrap();
            let hplus = |phi: f64| -> f64 {
                let y = |m| spin_weighted_ylm(-2, 2, m, FRAC_PI_2, phi);
                (h22 * y(2) + h2m2 * y(-2)).re
            };
            let n = 3600;
            let (phi_max, _) = (0..n)
                .map(|k| 2.0 * PI * k as f64 / n as f64)
                .map(|phi| (phi, hplus(phi)))
                .fold(
                    (0.0, f64::NEG_INFINITY),
                    |acc, x| {
                        if x.1 > acc.1 { x } else { acc }
                    },
                );
            let lag = wrap_half_pi(phi_max - b.orbital_angle(wf.time(i)));
            assert!(
                lag.abs() < 0.01,
                "q={q} t={t} r={r}: h₊ maximum is {lag:.4} rad off the binary axis"
            );
        }
    }
}

#[derive(Deserialize)]
struct OrientationGolden {
    cases: Vec<OrientationCase>,
}

#[derive(Deserialize)]
struct OrientationCase {
    q: f64,
    chi1: f64,
    chi2: f64,
    t: f64,
    heavier_angle: f64,
}

#[test]
fn heavier_hole_is_where_lal_pn_puts_it() {
    // tools/gen_orientation_golden.py locates the heavier hole by matching the
    // (2,2), (2,1) and (3,3) modes to LAL's PN modes. Compare modulo 2π (not π),
    // so swapping the holes fails. PN tail terms allow ~0.15 rad of slack.
    let golden: OrientationGolden = serde_json::from_slice(
        &std::fs::read(repo_path("tests/golden/orientation_lal.json")).unwrap(),
    )
    .unwrap();
    for c in golden.cases {
        let (b, _) = binary(c.q, c.chi1, c.chi2);
        let d = (b.orbital_angle(c.t) - c.heavier_angle + PI).rem_euclid(2.0 * PI) - PI;
        assert!(
            d.abs() < 0.25,
            "q={} t={}: heavier hole {d:.3} rad from LAL PN",
            c.q,
            c.t
        );
    }
}

#[test]
fn orbit_conventions() {
    let (b, _) = binary(3.0, 0.6, 0.2);
    // Frame definition: heavier hole on +x at t = −1000 M.
    let s = b.state(-1000.0);
    assert!(s.heavy.y.abs() < 1e-9 && s.heavy.x > 0.0 && s.light.x < 0.0);
    // Counter-clockwise seen from +z: the angle increases.
    assert!(b.orbital_angle(-999.0) > b.orbital_angle(-1000.0));
    // Centre of mass at the origin.
    let (m1, m2) = (0.75, 0.25);
    assert!((m1 * s.heavy.x + m2 * s.light.x).abs() < 1e-12);
    // Separation shrinks as the binary inspirals.
    assert!(b.separation(-1000.0) < b.separation(-4000.0));
    // Before merger only the two holes are shown; after it only the remnant.
    let (before, after) = (b.state(-200.0), b.state(200.0));
    assert_eq!((before.heavy.opacity, before.remnant.opacity), (1.0, 0.0));
    assert_eq!((after.heavy.opacity, after.remnant.opacity), (0.0, 1.0));
    // The kick is only rotated, not rescaled.
    let [kx, ky] = b.kick();
    let [cx, cy] = b.remnant.kick_coorbital;
    assert!((kx.hypot(ky) - cx.hypot(cy)).abs() < 1e-15);
}
