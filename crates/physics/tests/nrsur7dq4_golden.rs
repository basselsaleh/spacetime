//! Compares the Rust NRSur7dq4 evaluator against gwsurrogate and surfinBH.
//!
//! Data: `web/public/nrsur7dq4.stsur` (tools/export_nrsur7dq4.py) and
//! `tests/golden/nrsur7dq4.json` (tools/gen_golden_nrsur7dq4.py). The file
//! stores bases and fit coefficients as f32, which alone costs ~1.1e-6 of the
//! peak in the modes and ~8e-7 in the dynamics (tools/compare_nrsur7dq4.py).

use std::path::PathBuf;
use std::time::Instant;

use num_complex::Complex64;
use serde::Deserialize;
use spacetime_physics::nrsur7dq4::{Nrsur7dq4, Params, mode_index};

/// Modes: max |h_rust − h_ref| relative to the peak |h₂₂|.
const MODE_TOLERANCE: f64 = 3e-6;
/// Dynamics: max abs error of quaternion components, orbital phase (rad), spins.
const DYNAMICS_TOLERANCE: f64 = 3e-6;
/// Remnant fits evaluated at the same inputs (f64 data): abs error.
const REMNANT_TOLERANCE: f64 = 1e-10;
/// Aligned spins, before the peak: largest tilt of the orbital plane (rad) and
/// violation of the planar mode symmetry (of peak), both from the fits' noise.
const TILT_TOLERANCE: f64 = 3e-3;
const SYMMETRY_TOLERANCE: f64 = 1e-2; // a sign or m-ordering error would be O(1)

#[derive(Deserialize)]
struct Golden {
    t_ds: Vec<f64>,
    mode_time_indices: Stride,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Stride {
    stride: usize,
    count: usize,
}

#[derive(Deserialize)]
struct Case {
    q: f64,
    #[serde(rename = "chiA")]
    chi_a: [f64; 3],
    #[serde(rename = "chiB")]
    chi_b: [f64; 3],
    init_quat: Option<[f64; 4]>,
    dynamics: Vec<[f64; 11]>,
    modes: Vec<Mode>,
    remnant: GoldenRemnant,
}

#[derive(Deserialize)]
struct Mode {
    l: i32,
    m: i32,
    re: Vec<f64>,
    im: Vec<f64>,
}

#[derive(Deserialize)]
struct GoldenRemnant {
    node: usize,
    #[serde(rename = "chiA_coorb")]
    chi_a: [f64; 3],
    #[serde(rename = "chiB_coorb")]
    chi_b: [f64; 3],
    mf: f64,
    chif: [f64; 3],
    vf: [f64; 3],
}

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn load_model() -> Nrsur7dq4 {
    let bytes = std::fs::read(repo_path("web/public/nrsur7dq4.stsur"))
        .expect("missing model data; run tools/export_nrsur7dq4.py");
    Nrsur7dq4::from_bytes(&bytes).expect("parse model")
}

fn load_golden() -> Golden {
    serde_json::from_slice(
        &std::fs::read(repo_path("tests/golden/nrsur7dq4.json"))
            .expect("missing golden data; run tools/gen_golden_nrsur7dq4.py"),
    )
    .unwrap()
}

fn params(c: &Case) -> Params {
    Params {
        q: c.q,
        chi_a: c.chi_a,
        chi_b: c.chi_b,
    }
}

#[test]
fn dynamics_match_gwsurrogate() {
    let model = load_model();
    let golden = load_golden();
    let mut worst = 0.0_f64;
    for c in &golden.cases {
        let d = model.dynamics(params(c), c.init_quat).unwrap();
        assert_eq!(d.t.len(), c.dynamics.len());
        for (a, b) in d.t.iter().zip(&golden.t_ds) {
            assert!((a - b).abs() < 1e-9, "dynamics node times differ");
        }
        for (i, row) in c.dynamics.iter().enumerate() {
            let mine = [
                d.quat[i][0],
                d.quat[i][1],
                d.quat[i][2],
                d.quat[i][3],
                d.orbphase[i],
                d.chi_a[i][0],
                d.chi_a[i][1],
                d.chi_a[i][2],
                d.chi_b[i][0],
                d.chi_b[i][1],
                d.chi_b[i][2],
            ];
            for (a, b) in mine.iter().zip(row) {
                worst = worst.max((a - b).abs());
            }
        }
    }
    println!("worst dynamics error {worst:.2e}");
    assert!(worst < DYNAMICS_TOLERANCE, "dynamics error {worst:.2e}");
}

#[test]
fn modes_match_gwsurrogate() {
    let model = load_model();
    let golden = load_golden();
    let stride = golden.mode_time_indices.stride;
    let mut worst = 0.0_f64;
    for c in &golden.cases {
        let start = Instant::now();
        let (wf, _) = model.evaluate_sparse(params(c), c.init_quat).unwrap();
        let ms = start.elapsed().as_secs_f64() * 1e3;
        let peak = c
            .modes
            .iter()
            .filter(|m| m.l == 2 && m.m.abs() == 2)
            .flat_map(|m| m.re.iter().zip(&m.im).map(|(a, b)| a.hypot(*b)))
            .fold(0.0, f64::max);
        let mut case_worst = 0.0_f64;
        for m in &c.modes {
            assert_eq!(m.re.len(), golden.mode_time_indices.count);
            let mine = &wf.h[mode_index(m.l, m.m)];
            for (k, (re, im)) in m.re.iter().zip(&m.im).enumerate() {
                let err = (mine[k * stride] - Complex64::new(*re, *im)).norm() / peak;
                case_worst = case_worst.max(err);
            }
        }
        println!(
            "q={} chiA={:?} chiB={:?} frame={}: worst {case_worst:.2e} of peak ({ms:.0} ms)",
            c.q,
            c.chi_a,
            c.chi_b,
            c.init_quat.is_some()
        );
        worst = worst.max(case_worst);
    }
    assert!(worst < MODE_TOLERANCE, "mode error {worst:.2e} of peak");
}

#[test]
fn remnant_matches_surfinbh() {
    let model = load_model();
    let golden = load_golden();
    for c in &golden.cases {
        let g = &c.remnant;
        // The fits at surfinBH's inputs.
        let r = model
            .remnant_coorbital(c.q, g.chi_a, g.chi_b)
            .expect("remnant data");
        assert!((r.mass - g.mf).abs() < REMNANT_TOLERANCE);
        for k in 0..3 {
            assert!((r.spin[k] - g.chif[k]).abs() < REMNANT_TOLERANCE);
            assert!((r.kick[k] - g.vf[k]).abs() < REMNANT_TOLERANCE);
        }
        // The full path: same node, same spins there, close results.
        let d = model.dynamics(params(c), c.init_quat).unwrap();
        let node = Nrsur7dq4::remnant_node(&d);
        assert_eq!(node, g.node);
        let full = model.remnant(params(c), &d).unwrap();
        assert!(
            (full.mass - g.mf).abs() < 1e-5,
            "mass {} vs {}",
            full.mass,
            g.mf
        );
        let spin_norm = |v: [f64; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        assert!((spin_norm(full.spin) - spin_norm(g.chif)).abs() < 1e-5);
    }
}

/// Aligned spins in the identity frame keep the orbital plane fixed, so the
/// modes obey h_{l,−m} = (−1)^l h*_{lm}, up to the surrogate's fit error.
#[test]
fn aligned_spins_have_planar_symmetry() {
    let model = load_model();
    let p = Params {
        q: 3.0,
        chi_a: [0.0, 0.0, 0.6],
        chi_b: [0.0, 0.0, -0.3],
    };
    let (wf, d) = model.evaluate_sparse(p, None).unwrap();
    // Before the peak the orbital plane does not move, up to the fits' noise.
    // (In the ringdown the fitted frame drifts by a few degrees even for
    // aligned spins, in gwsurrogate too: there is no orbit left to define it.)
    let tilt = d
        .quat
        .iter()
        .zip(&d.t)
        .filter(|(_, t)| **t < 0.0)
        .map(|(q, _)| 2.0 * q[1].hypot(q[2]))
        .fold(0.0, f64::max);
    println!("aligned-spin frame tilt {tilt:.2e} rad");
    assert!(tilt < TILT_TOLERANCE, "frame tilted by {tilt:.2e} rad");
    let peak = wf.h[mode_index(2, 2)]
        .iter()
        .map(|z| z.norm())
        .fold(0.0, f64::max);
    let mut worst = 0.0_f64;
    for l in 2..=4 {
        for m in 1..=l {
            let sign = if l % 2 == 0 { 1.0 } else { -1.0 };
            let pairs = wf.h[mode_index(l, m)].iter().zip(&wf.h[mode_index(l, -m)]);
            for ((a, b), t) in pairs.zip(&wf.t) {
                if *t < 0.0 {
                    worst = worst.max((b - a.conj() * sign).norm() / peak);
                }
            }
        }
    }
    println!("planar-symmetry violation {worst:.2e} of peak");
    assert!(
        worst < SYMMETRY_TOLERANCE,
        "symmetry violated by {worst:.2e}"
    );
}

/// The uniform-grid output is the spline of the sparse output.
#[test]
fn uniform_grid_resamples_the_sparse_output() {
    let model = load_model();
    let p = Params {
        q: 2.0,
        chi_a: [0.3, -0.4, 0.5],
        chi_b: [-0.6, 0.1, -0.2],
    };
    let (sparse, _) = model.evaluate_sparse(p, None).unwrap();
    let (t0, t1) = model.time_range();
    let (wf, _) = model.evaluate(p, None, t0, 1.0).unwrap();
    assert_eq!(wf.t.len(), ((t1 - t0) + 1e-9).floor() as usize + 1);
    let peak = sparse.h[mode_index(2, 2)]
        .iter()
        .map(|z| z.norm())
        .fold(0.0, f64::max);
    // At the first sample the grids coincide.
    for k in 0..21 {
        assert!((wf.h[k][0] - sparse.h[k][0]).norm() < 1e-14 * peak.max(1.0));
    }
    // Near merger, where the sparse grid is 0.2 M, compare at matching times.
    for (i, &t) in sparse.t.iter().enumerate() {
        let x = t - t0;
        if t > -50.0 && t < 50.0 && (x - x.round()).abs() < 1e-6 {
            let j = x.round() as usize;
            let err = (wf.h[mode_index(2, 2)][j] - sparse.h[mode_index(2, 2)][i]).norm() / peak;
            assert!(err < 1e-6, "t = {t}: {err:.2e}");
        }
    }
    // Spins keep their magnitudes; the frame stays unit.
    for (a, q) in wf.chi_a.iter().zip(&wf.quat) {
        let n = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
        assert!((n - (0.09f64 + 0.16 + 0.25).sqrt()).abs() < 1e-12);
        assert!((q.iter().map(|c| c * c).sum::<f64>() - 1.0).abs() < 1e-12);
    }
}

#[test]
fn rejects_out_of_range() {
    let model = load_model();
    let b = model.bounds();
    assert_eq!(b.q, [1.0, 4.0]);
    let bad = [
        Params {
            q: 6.5,
            chi_a: [0.0; 3],
            chi_b: [0.0; 3],
        },
        Params {
            q: 0.9,
            chi_a: [0.0; 3],
            chi_b: [0.0; 3],
        },
        Params {
            q: 2.0,
            chi_a: [0.8, 0.7, 0.0],
            chi_b: [0.0; 3],
        },
    ];
    for p in bad {
        assert!(model.dynamics(p, None).is_err(), "{p:?} accepted");
    }
}
