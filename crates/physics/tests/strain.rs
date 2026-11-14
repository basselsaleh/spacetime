//! Strain-field physics checks: harmonics against LAL, the orbital-plane
//! polarization, and the GPU table (co-orbital modes + frame, rotated per
//! direction) against the exact sum over the model's inertial-frame modes.

use std::f64::consts::PI;
use std::path::PathBuf;

use num_complex::Complex64;
use serde::Deserialize;
use spacetime_physics::harmonics::spin_weighted_ylm;
use spacetime_physics::mode_table::{ModeTable, equatorial_peak_22};
use spacetime_physics::nrsur7dq4::{Nrsur7dq4, Params, Waveform, mode_index};
use spacetime_physics::quaternion::{Quat, normalize};

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn model() -> Nrsur7dq4 {
    Nrsur7dq4::from_bytes(&std::fs::read(repo_path("web/public/nrsur7dq4.stsur")).unwrap()).unwrap()
}

fn waveform(p: Params, frame: Option<Quat>, t_start: f64, dt: f64) -> Waveform {
    model().evaluate(p, frame, t_start, dt).unwrap().0
}

fn aligned(q: f64, chi1: f64, chi2: f64) -> Params {
    Params {
        q,
        chi_a: [0.0, 0.0, chi1],
        chi_b: [0.0, 0.0, chi2],
    }
}

const PRECESSING: Params = Params {
    q: 4.0,
    chi_a: [0.8, 0.0, 0.0],
    chi_b: [0.0, 0.0, 0.0],
};
const GENERIC: Params = Params {
    q: 2.0,
    chi_a: [0.5, 0.4, 0.3],
    chi_b: [-0.5, 0.2, 0.4],
};

fn dir(theta: f64, phi: f64) -> [f64; 3] {
    [
        theta.sin() * phi.cos(),
        theta.sin() * phi.sin(),
        theta.cos(),
    ]
}

/// r·(h₊ − i h×) from the exact inertial-frame modes at sample `i`.
fn exact_strain(wf: &Waveform, theta: f64, phi: f64, i: usize) -> Complex64 {
    let mut sum = Complex64::new(0.0, 0.0);
    for l in 2..=4 {
        for m in -l..=l {
            sum += wf.h[mode_index(l, m)][i] * spin_weighted_ylm(-2, l, m, theta, phi);
        }
    }
    sum
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
fn cross_polarization_vanishes_in_orbital_plane_for_aligned_spins() {
    // Aligned spins ⇒ reflection symmetry through the orbital plane ⇒ h× = 0
    // there. NRSur7dq4 fits the ±m components separately, so the symmetry
    // holds to the model's accuracy (~4e-3 of peak), not to rounding; a
    // convention error would be O(1).
    for (q, c1, c2) in [(1.0, 0.0, 0.0), (3.0, 0.5, -0.2), (4.0, -0.4, 0.8)] {
        let wf = waveform(aligned(q, c1, c2), None, -2500.0, 1.0);
        let table = ModeTable::new(&wf, 2048);
        let peak = equatorial_peak_22(&wf);
        let mut worst = 0.0_f64;
        for i in (0..wf.len() - 100).step_by(37) {
            for phi in [0.0, 0.7, 2.0, 4.4] {
                let exact = exact_strain(&wf, PI / 2.0, phi, i);
                let packed = table.strain(dir(PI / 2.0, phi), wf.t[i]).unwrap();
                worst = worst.max(exact.im.abs().max(packed.im.abs()) / peak);
            }
        }
        assert!(
            worst < 1e-2,
            "q={q}: h× in the plane up to {worst:.2e} of peak"
        );
        // ...while off the plane both polarizations are present.
        let i_peak = wf.len() - 101; // near t = 0
        assert!(exact_strain(&wf, 0.6, 0.3, i_peak).im.abs() > 3e-2 * peak);
    }
}

/// The table's per-direction rotation reproduces the exact inertial-mode sum.
#[test]
fn table_matches_exact_sum() {
    let frame = normalize([0.9, 0.2, -0.3, 0.25]);
    let dirs = [
        (PI / 2.0, 0.0),
        (PI / 2.0, 2.5),
        (0.8, 1.0),
        (2.6, 5.0),
        (0.05, 0.3),
        (PI - 0.05, 4.0),
    ];
    for (name, p, f) in [
        ("aligned", aligned(3.0, 0.6, 0.2), None),
        ("precessing", PRECESSING, None),
        ("generic, rotated frame", GENERIC, Some(frame)),
    ] {
        let wf = waveform(p, f, -3000.0, 1.0);
        let table = ModeTable::new(&wf, 2048);
        assert_eq!(table.rows.len(), 21);
        assert_eq!(table.data.len(), 2 * table.width * table.height());
        let peak = equatorial_peak_22(&wf);

        // At sample times: f32 storage, and the spline of slow quantities
        // (co-orbital modes, frame) vs the spline of the inertial modes.
        let mut at_samples = 0.0_f64;
        for i in (0..wf.len()).step_by(11) {
            for &(theta, phi) in &dirs {
                let want = exact_strain(&wf, theta, phi, i);
                let got = table.strain(dir(theta, phi), wf.t[i]).unwrap();
                at_samples = at_samples.max((got - want).norm() / peak);
            }
        }

        // Halfway between samples, linear interpolation adds an error that
        // peaks at the merger (t ≈ 0-5 M), where the co-orbital phase turns
        // fastest: measured 1.9e-3 to 4.9e-3 of peak, where the color map is
        // near saturation. A 0.5 M table would cut it ~4×.
        let fine = waveform(p, f, -3000.0, 0.5);
        let mut between = 0.0_f64;
        let mut where_ = 0.0;
        for i in (1..fine.len() - 1).step_by(2).step_by(5) {
            for &(theta, phi) in &dirs[..3] {
                let want = exact_strain(&fine, theta, phi, i);
                let got = table.strain(dir(theta, phi), fine.t[i]).unwrap();
                let e = (got - want).norm() / peak;
                if e > between {
                    between = e;
                    where_ = fine.t[i];
                }
            }
        }
        println!("{name}: worst between samples at t = {where_}");
        println!("{name}: table error {at_samples:.2e} at samples, {between:.2e} between");
        assert!(at_samples < 1e-4, "{name}: at samples {at_samples:.2e}");
        assert!(between < 6e-3, "{name}: between samples {between:.2e}");
    }
}

#[test]
fn table_range_and_direction_scaling() {
    let wf = waveform(GENERIC, None, -2000.0, 1.0);
    let table = ModeTable::new(&wf, 2048);
    let d = dir(1.1, 0.4);
    assert!(table.strain(d, table.t0 - 1.0).is_none());
    assert!(table.strain(d, table.t_end() + 1.0).is_none());
    // Only the direction matters, not the length.
    let a = table.strain(d, -500.0).unwrap();
    let b = table.strain(d.map(|c| 37.0 * c), -500.0).unwrap();
    assert!((a - b).norm() < 1e-12);
}

#[test]
fn harmonic_table_is_exact_in_the_plane_and_smooth_elsewhere() {
    let wf = waveform(GENERIC, None, -1500.0, 1.0);
    let table = ModeTable::new(&wf, 2048);
    let n = 1025;
    let h = table.harmonic_table(n);
    assert_eq!(h.len(), 2 * n * table.rows.len());
    for (k, &(l, m)) in table.rows.iter().enumerate() {
        // θ = π/2 is sample 512.
        let want = spin_weighted_ylm(-2, l, m, PI / 2.0, 0.0).re;
        assert!((f64::from(h[2 * (k * n + 512)]) - want).abs() < 1e-6);
        // Linear interpolation midway between samples stays within 1e-4.
        for j in (0..n - 1).step_by(37) {
            let theta = PI * (j as f64 + 0.5) / (n - 1) as f64;
            let lerp = 0.5 * (f64::from(h[2 * (k * n + j)]) + f64::from(h[2 * (k * n + j + 1)]));
            let want = spin_weighted_ylm(-2, l, m, theta, 0.0).re;
            assert!((lerp - want).abs() < 1e-4, "l={l} m={m} θ={theta}");
        }
    }
}

#[test]
fn strain_series_is_the_signal_at_a_fixed_direction() {
    let wf = waveform(GENERIC, None, -1500.0, 1.0);
    let table = ModeTable::new(&wf, 2048);
    let d = dir(1.0, 0.3);
    let series = table.strain_series(d);
    assert_eq!(series.len(), table.n);
    for i in (0..table.n).step_by(97) {
        let want = table.strain(d, table.t0 + table.dt * i as f64).unwrap();
        assert!((series[i] - want).norm() < 1e-12);
    }
}

#[test]
fn rows_come_in_pairs_ordered_by_peak_amplitude() {
    let wf = waveform(PRECESSING, None, -3000.0, 1.0);
    let table = ModeTable::new(&wf, 2048);
    let peak = |l: i32, m: i32| {
        wf.h_coorb[mode_index(l, m)]
            .iter()
            .map(|z| z.norm())
            .fold(0.0, f64::max)
    };
    assert_eq!(&table.rows[..2], &[(2, 2), (2, -2)]);
    let mut groups = Vec::new();
    let mut k = 0;
    while k < table.rows.len() {
        let (l, m) = table.rows[k];
        assert!(m >= 0, "group starts with +m");
        if m == 0 {
            groups.push(peak(l, 0));
            k += 1;
        } else {
            assert_eq!(table.rows[k + 1], (l, -m));
            groups.push(peak(l, m).max(peak(l, -m)));
            k += 2;
        }
    }
    assert!(groups.windows(2).all(|w| w[0] >= w[1]), "{:?}", table.rows);
    // The three leading groups: (2,±2) and two more.
    assert!(table.leading3 >= 4 && table.leading3 <= 6);
    // They carry most of the signal.
    let d = dir(1.0, 0.5);
    let full = table.strain(d, -800.0).unwrap();
    let lead = table.strain_rows(d, -800.0, table.leading3).unwrap();
    assert!((full - lead).norm() < 0.1 * full.norm().max(equatorial_peak_22(&wf) * 0.1));
}
