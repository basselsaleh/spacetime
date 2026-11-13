//! Compares the Rust surrogate evaluator against gwsurrogate's Python output.
//!
//! Data: `web/public/nrhybsur3dq8.stsur` (tools/export_surrogate.py) and
//! `tests/golden/nrhybsur3dq8.json` (tools/gen_golden.py).

use std::path::PathBuf;

use num_complex::Complex64;
use serde::Deserialize;
use spacetime_physics::surrogate::{Params, Surrogate};

/// Max |h_rust − h_ref| over all samples, relative to the peak |h₂₂|.
const TOLERANCE: f64 = 1e-6;

#[derive(Deserialize)]
struct Golden {
    t0: f64,
    dt: f64,
    n: usize,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    q: f64,
    chi1: f64,
    chi2: f64,
    modes: Vec<Mode>,
}

#[derive(Deserialize)]
struct Mode {
    l: i32,
    m: i32,
    re: Vec<f64>,
    im: Vec<f64>,
}

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn load_surrogate() -> Surrogate {
    let bytes = std::fs::read(repo_path("web/public/nrhybsur3dq8.stsur"))
        .expect("missing surrogate data; run tools/export_surrogate.py");
    Surrogate::from_bytes(&bytes).expect("parse surrogate")
}

#[test]
fn matches_gwsurrogate() {
    let sur = load_surrogate();
    let golden: Golden = serde_json::from_slice(
        &std::fs::read(repo_path("tests/golden/nrhybsur3dq8.json"))
            .expect("missing golden data; run tools/gen_golden.py"),
    )
    .unwrap();

    let mut worst = 0.0_f64;
    for case in &golden.cases {
        let p = Params {
            q: case.q,
            chi1: case.chi1,
            chi2: case.chi2,
        };
        let wf = sur.evaluate(p, golden.t0, golden.dt).unwrap();
        assert!(wf.len() >= golden.n);

        let peak = case
            .modes
            .iter()
            .find(|m| (m.l, m.m) == (2, 2))
            .map(|m| {
                (0..golden.n)
                    .map(|i| m.re[i].hypot(m.im[i]))
                    .fold(0.0, f64::max)
            })
            .unwrap();

        for mode in &case.modes {
            for sign in [1, -1] {
                if mode.m == 0 && sign == -1 {
                    continue;
                }
                let m = sign * mode.m;
                // Reference only stores m >= 0; derive m < 0 the same way gwsurrogate does.
                let parity = if mode.l % 2 == 0 { 1.0 } else { -1.0 };
                let (mut err, mut at) = (0.0_f64, 0.0);
                for i in 0..golden.n {
                    let mut want = Complex64::new(mode.re[i], mode.im[i]);
                    if sign == -1 {
                        want = want.conj() * parity;
                    }
                    let got = wf.h(mode.l, m, i).expect("mode present");
                    let e = (got - want).norm();
                    if e > err {
                        (err, at) = (e, golden.t0 + golden.dt * i as f64);
                    }
                }
                let rel = err / peak;
                println!(
                    "q={} χ1={} χ2={} ({},{}): rel err {rel:.2e} at t = {at} M",
                    case.q, case.chi1, case.chi2, mode.l, m
                );
                worst = worst.max(rel);
            }
        }
    }
    println!("worst relative error: {worst:.2e}");
    assert!(
        worst < TOLERANCE,
        "worst relative error {worst:.2e} exceeds {TOLERANCE:.0e}"
    );
}

#[test]
fn peak_is_near_t_zero() {
    let sur = load_surrogate();
    let wf = sur
        .evaluate(
            Params {
                q: 2.0,
                chi1: 0.3,
                chi2: -0.1,
            },
            -1000.0,
            0.5,
        )
        .unwrap();
    let (imax, _) =
        wf.amp22.iter().enumerate().fold(
            (0, 0.0),
            |acc, (i, &a)| if a > acc.1 { (i, a) } else { acc },
        );
    assert!(wf.time(imax).abs() < 2.0, "peak at t = {}", wf.time(imax));
}

#[test]
fn rejects_out_of_range_parameters() {
    let sur = load_surrogate();
    assert!(
        sur.evaluate(
            Params {
                q: 9.0,
                chi1: 0.0,
                chi2: 0.0
            },
            -1000.0,
            1.0
        )
        .is_err()
    );
    assert!(
        sur.evaluate(
            Params {
                q: 2.0,
                chi1: 0.9,
                chi2: 0.0
            },
            -1000.0,
            1.0
        )
        .is_err()
    );
    assert!(
        sur.evaluate(
            Params {
                q: 2.0,
                chi1: 0.0,
                chi2: 0.0
            },
            -1.0e7,
            1.0
        )
        .is_err()
    );
}
