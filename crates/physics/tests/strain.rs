//! Strain-field physics checks: harmonics against LAL, the orbital-plane
//! polarisation, and the GPU table against the exact mode sum.

use std::f64::consts::PI;
use std::path::PathBuf;

use num_complex::Complex64;
use serde::Deserialize;
use spacetime_physics::harmonics::spin_weighted_ylm;
use spacetime_physics::mode_table::{ModeTable, equatorial_peak_22};
use spacetime_physics::surrogate::{Params, Surrogate, Waveform};

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn waveform(q: f64, chi1: f64, chi2: f64, t_start: f64, dt: f64) -> Waveform {
    let bytes = std::fs::read(repo_path("web/public/nrhybsur3dq8.stsur")).unwrap();
    let sur = Surrogate::from_bytes(&bytes).unwrap();
    sur.evaluate(Params { q, chi1, chi2 }, t_start, dt).unwrap()
}

/// r·(h₊ − i h×) from the exact (unpacked) modes at sample `i`.
fn exact_strain(wf: &Waveform, theta: f64, phi: f64, i: usize) -> Complex64 {
    wf.modes()
        .into_iter()
        .map(|(l, m)| wf.h(l, m, i).unwrap() * spin_weighted_ylm(-2, l, m, theta, phi))
        .sum()
}

#[derive(Deserialize)]
struct LalHarmonics {
    s: i32,
    rows: Vec<(f64, f64, i32, i32, f64, f64)>,
}

#[test]
fn harmonics_match_lal() {
    let golden: LalHarmonics =
        serde_json::from_slice(&std::fs::read(repo_path("tests/golden/swsh_lal.json")).unwrap())
            .unwrap();
    for (theta, phi, l, m, re, im) in golden.rows {
        let got = spin_weighted_ylm(golden.s, l, m, theta, phi);
        let err = (got - Complex64::new(re, im)).norm();
        assert!(
            err < 1e-12,
            "l={l} m={m} θ={theta} φ={phi}: {got} vs {re}+{im}i"
        );
    }
}

#[test]
fn cross_polarisation_vanishes_in_orbital_plane() {
    // Aligned spins ⇒ reflection symmetry through the orbital plane ⇒ h× = 0 there.
    // This checks the mode symmetry, the harmonics and the conventions together.
    for (q, c1, c2) in [(1.0, 0.0, 0.0), (3.0, 0.5, -0.2), (8.0, -0.4, 0.8)] {
        let wf = waveform(q, c1, c2, -2000.0, 1.0);
        let peak = equatorial_peak_22(&wf);
        for i in (0..wf.len()).step_by(37) {
            for phi in [0.0, 0.7, 2.0, 4.4] {
                let h = exact_strain(&wf, PI / 2.0, phi, i);
                assert!(
                    h.im.abs() < 1e-12 * peak,
                    "q={q} t={} φ={phi}: h× = {}",
                    wf.time(i),
                    -h.im
                );
            }
        }
        // ...while off the plane both polarisations are present.
        let i_peak = wf.len() - 140; // near t = 0
        let h = exact_strain(&wf, 0.6, 0.3, i_peak);
        assert!(h.im.abs() > 1e-3 * peak);
    }
}

#[test]
fn table_matches_exact_sum() {
    let wf = waveform(3.0, 0.6, 0.2, -3000.0, 1.0);
    let table = ModeTable::new(&wf, 2048);
    assert_eq!(table.rows[0], (2, 2));
    assert_eq!(table.data.len(), 2 * table.width * table.height());
    let peak = equatorial_peak_22(&wf);

    // At sample times the only difference is f32 storage.
    let mut worst_at_samples = 0.0_f64;
    for i in (0..wf.len()).step_by(11) {
        for (theta, phi) in [(PI / 2.0, 0.0), (PI / 2.0, 2.5), (0.8, 1.0), (2.6, 5.0)] {
            let want = exact_strain(&wf, theta, phi, i);
            let got = table.strain(theta, phi, wf.time(i)).unwrap();
            worst_at_samples = worst_at_samples.max((got - want).norm() / peak);
        }
    }
    assert!(
        worst_at_samples < 1e-5,
        "at samples: {worst_at_samples:.2e}"
    );

    // Halfway between samples, linear interpolation adds a small error.
    let fine = waveform(3.0, 0.6, 0.2, -3000.0, 0.5);
    let mut worst_between = 0.0_f64;
    for i in (1..fine.len() - 1).step_by(2).step_by(5) {
        let want = exact_strain(&fine, PI / 2.0, 1.3, i);
        let got = table.strain(PI / 2.0, 1.3, fine.time(i)).unwrap();
        worst_between = worst_between.max((got - want).norm() / peak);
    }
    println!("table error: {worst_at_samples:.2e} at samples, {worst_between:.2e} between");
    assert!(worst_between < 2e-3, "between samples: {worst_between:.2e}");

    assert!(table.strain(PI / 2.0, 0.0, table.t0 - 1.0).is_none());
    assert!(table.strain(PI / 2.0, 0.0, table.t_end() + 1.0).is_none());
}
