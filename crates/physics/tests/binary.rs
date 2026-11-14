//! Orbits: the orientation and retarded-time lag between the black holes and
//! the waves they emit, and the orbit conventions. (The remnant fits are
//! checked against surfinBH in nrsur7dq4_golden.rs.)

use std::f64::consts::{FRAC_PI_2, PI};
use std::path::PathBuf;

use serde::Deserialize;
use spacetime_physics::binary::Binary;
use spacetime_physics::harmonics::spin_weighted_ylm;
use spacetime_physics::nrsur7dq4::{Nrsur7dq4, Params, Waveform, mode_index};

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn model() -> Nrsur7dq4 {
    Nrsur7dq4::from_bytes(&std::fs::read(repo_path("web/public/nrsur7dq4.stsur")).unwrap()).unwrap()
}

fn aligned(q: f64, chi1: f64, chi2: f64) -> Params {
    Params {
        q,
        chi_a: [0.0, 0.0, chi1],
        chi_b: [0.0, 0.0, chi2],
    }
}

fn binary(p: Params) -> (Binary, Waveform) {
    let m = model();
    let t0 = m.time_range().0.ceil();
    let (wf, dynm) = m.evaluate(p, None, t0, 1.0).unwrap();
    let b = Binary::new(&wf, p, m.remnant(p, &dynm).unwrap());
    (b, wf)
}

/// Wraps an angle difference into (−π/2, π/2]: the quadrupole pattern repeats every π.
fn wrap_half_pi(a: f64) -> f64 {
    let x = a.rem_euclid(PI);
    if x > FRAC_PI_2 { x - PI } else { x }
}

#[test]
fn waves_trail_the_binary_with_retarded_time() {
    // Leading-order quadrupole, with the LAL polarization convention the
    // surrogate uses (h₊ = ½(h_φφ − h_θθ) in the orbital plane; Blanchet/Kidder
    // differ by an overall sign): h₊ ∝ +cos 2(φ − Φ(t − r)), i.e. h₊ is largest
    // along the binary's axis as it was at the retarded time t − r.
    // Use the (2,±2) modes during the inspiral, where this is accurate.
    for (q, chi1, chi2) in [(1.0, 0.0, 0.0), (3.0, 0.6, 0.2), (4.0, -0.4, 0.8)] {
        let (b, wf) = binary(aligned(q, chi1, chi2));
        for (t, r) in [(-3000.0, 150.0), (-3000.0, 600.0), (-1500.0, 400.0)] {
            let i = ((t - r - wf.t[0]) / (wf.t[1] - wf.t[0])).round() as usize;
            let h22 = wf.h[mode_index(2, 2)][i];
            let h2m2 = wf.h[mode_index(2, -2)][i];
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
                    |acc, x| if x.1 > acc.1 { x } else { acc },
                );
            let lag = wrap_half_pi(phi_max - b.orbital_angle(wf.t[i]));
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
        let (b, _) = binary(aligned(c.q, c.chi1, c.chi2));
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
    let p = aligned(3.0, 0.6, 0.2);
    let (b, wf) = binary(p);
    let t0 = wf.t[0];
    // Frame definition: at the start of the data the co-orbital frame is the
    // inertial one (to within one sample of orbital motion): heavier hole on +x.
    let s = b.state(t0);
    assert!(s.heavy.x > 0.0 && s.light.x < 0.0);
    assert!((s.heavy.y / s.heavy.x).abs() < 0.05, "{:?}", s.heavy);
    // Aligned spins: the orbit stays in the xy-plane (up to the fits' noise).
    for t in [-3000.0, -1000.0, -100.0] {
        assert!(b.axis(t)[2].abs() < 3e-3, "t={t}: {:?}", b.axis(t));
    }
    // Counter-clockwise seen from +z: the angle increases.
    let d = b.orbital_angle(-999.0) - b.orbital_angle(-1000.0);
    assert!(d.rem_euclid(2.0 * PI) < PI);
    // Center of mass at the origin.
    let s = b.state(-1000.0);
    let (m1, m2) = (0.75, 0.25);
    assert!((m1 * s.heavy.x + m2 * s.light.x).abs() < 1e-12);
    assert!((m1 * s.heavy.z + m2 * s.light.z).abs() < 1e-12);
    // Separation shrinks as the binary inspirals.
    assert!(b.separation(-1000.0) < b.separation(-4000.0));
    // Before merger only the two holes are shown; after it only the remnant.
    let (before, after) = (b.state(-200.0), b.state(200.0));
    assert_eq!((before.heavy.opacity, before.remnant.opacity), (1.0, 0.0));
    assert_eq!((after.heavy.opacity, after.remnant.opacity), (0.0, 1.0));
    // The remnant drifts with the kick.
    let k = b.kick();
    assert!(
        (after.remnant.x - 200.0 * k[0]).abs() < 1e-12
            && (after.remnant.z - 200.0 * k[2]).abs() < 1e-12
    );
}

#[test]
fn precessing_orbit_leaves_the_plane() {
    let (b, _) = binary(Params {
        q: 4.0,
        chi_a: [0.8, 0.0, 0.0],
        chi_b: [0.0, 0.0, 0.0],
    });
    // The orbital plane tilts by tens of degrees, so the holes leave z = 0.
    let zmax = (-4000..-100)
        .step_by(10)
        .map(|t| b.axis(t as f64)[2].abs())
        .fold(0.0, f64::max);
    assert!(zmax > 0.3, "max |ẑ·axis| = {zmax}");
}

#[test]
fn display_frame_puts_j_on_z() {
    let m = model();
    // Aligned spins: the identity.
    let f = m.display_frame(aligned(3.0, 0.6, -0.4)).unwrap();
    assert!(
        (f[0] - 1.0).abs() < 1e-12 && f[1].abs() + f[2].abs() + f[3].abs() < 1e-12,
        "{f:?}"
    );

    let p = Params {
        q: 4.0,
        chi_a: [0.8, 0.0, 0.0],
        chi_b: [0.0, 0.3, 0.2],
    };
    let frame = m.display_frame(p).unwrap();
    let t0 = m.time_range().0.ceil();
    let (wf, dynm) = m.evaluate(p, Some(frame), t0, 1.0).unwrap();
    let b = Binary::new(&wf, p, m.remnant(p, &dynm).unwrap());
    // L̂ at the start lies in the x–z plane, tilted toward +x.
    let l0 = b.orbital_axis(t0);
    assert!(l0[1].abs() < 1e-3 && l0[0] > 0.1, "{l0:?}");
    // Spins at the start are the input spins, turned into this frame.
    let (sa, sb) = b.spins(t0);
    for (got, want) in [(sa, p.chi_a), (sb, p.chi_b)] {
        let w = spacetime_physics::quaternion::rotate(frame, want);
        for k in 0..3 {
            assert!((got[k] - w[k]).abs() < 2e-3, "{got:?} vs {w:?}");
        }
    }
    // J is (nearly) conserved in direction, so L̂ circles z at a roughly fixed
    // tilt, and the remnant spin ends up close to z.
    let tilts: Vec<f64> = (-4000..-500)
        .step_by(100)
        .map(|t| b.orbital_axis(t as f64)[2].acos().to_degrees())
        .collect();
    let (lo, hi) = tilts
        .iter()
        .fold((f64::MAX, 0.0_f64), |(a, c), &x| (a.min(x), c.max(x)));
    assert!(
        lo > 20.0 && hi - lo < 10.0,
        "L̂ tilt from z in [{lo:.1}, {hi:.1}]°"
    );
    let s = b.remnant.spin;
    let tilt = (s[2] / (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt())
        .acos()
        .to_degrees();
    assert!(tilt < 5.0, "remnant spin {tilt:.1}° from z");
}
