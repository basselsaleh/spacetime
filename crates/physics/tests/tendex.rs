//! Tidal/frame-drag field checks: the closed form against the symbolic
//! derivation, its limits, the quadrupole from the (2,2) mode against the
//! mode sum, and the field-line tracer.

use std::f64::consts::PI;
use std::path::PathBuf;

use num_complex::Complex64;
use serde::Deserialize;
use spacetime_physics::harmonics::spin_weighted_ylm;
use spacetime_physics::surrogate::{Params, Surrogate, Waveform};
use spacetime_physics::tendex::{
    Family, Field, Mat3, QuadDerivs, Quadrupole, TraceParams, Tracer, eigenvalues, eigenvector,
    frame_drag, seeds, tidal,
};

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn waveform(dt: f64) -> Waveform {
    let bytes = std::fs::read(repo_path("web/public/nrhybsur3dq8.stsur")).unwrap();
    let sur = Surrogate::from_bytes(&bytes).unwrap();
    let (t_min, _) = sur.time_range();
    sur.evaluate(
        Params {
            q: 3.0,
            chi1: 0.6,
            chi2: 0.2,
        },
        t_min.ceil() + 1.0,
        dt,
    )
    .unwrap()
}

/// STF matrix from (xx, yy, xy, xz, yz).
fn stf(c: [f64; 5]) -> Mat3 {
    [
        [c[0], c[2], c[3]],
        [c[2], c[1], c[4]],
        [c[3], c[4], -c[0] - c[1]],
    ]
}

fn max_abs(m: &Mat3) -> f64 {
    m.iter().flatten().fold(0.0, |a, &b| a.max(b.abs()))
}

fn max_diff(a: &Mat3, b: &Mat3) -> f64 {
    (0..3)
        .flat_map(|i| (0..3).map(move |j| (i, j)))
        .fold(0.0, |m, (i, j)| m.max((a[i][j] - b[i][j]).abs()))
}

/// Deterministic pseudo-random numbers in [−1, 1).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
    }
    fn quad(&mut self) -> QuadDerivs {
        std::array::from_fn(|_| stf(std::array::from_fn(|_| self.next())))
    }
    fn point(&mut self, scale: f64) -> [f64; 3] {
        std::array::from_fn(|_| self.next() * scale)
    }
}

#[derive(Deserialize)]
struct GoldenCase {
    p: [f64; 3],
    #[serde(rename = "M")]
    m: f64,
    ider: [[f64; 5]; 5], // [component][derivative order]
    #[serde(rename = "E")]
    e: Mat3,
    #[serde(rename = "B")]
    b: Mat3,
}

#[derive(Deserialize)]
struct Golden {
    cases: Vec<GoldenCase>,
}

#[test]
fn closed_form_matches_symbolic_derivation() {
    let text = std::fs::read_to_string(repo_path("tests/golden/tendex_fields.json")).unwrap();
    let golden: Golden = serde_json::from_str(&text).unwrap();
    let mut worst: f64 = 0.0;
    for c in &golden.cases {
        let q: QuadDerivs =
            std::array::from_fn(|k| stf(std::array::from_fn(|comp| c.ider[comp][k])));
        let e = tidal(c.p, c.m, &q);
        let b = frame_drag(c.p, &q);
        worst = worst
            .max(max_diff(&e, &c.e) / max_abs(&c.e))
            .max(max_diff(&b, &c.b) / max_abs(&c.b));
    }
    assert!(worst < 1e-12, "worst relative difference {worst:e}");
}

#[test]
fn fields_are_symmetric_and_traceless() {
    let mut rng = Rng(1);
    for _ in 0..50 {
        let q = rng.quad();
        let p = rng.point(40.0);
        for m in [tidal(p, 0.8, &q), frame_drag(p, &q)] {
            let s = max_abs(&m);
            for i in 0..3 {
                for j in 0..3 {
                    assert!((m[i][j] - m[j][i]).abs() < 1e-13 * s);
                }
            }
            assert!((m[0][0] + m[1][1] + m[2][2]).abs() < 1e-13 * s);
        }
    }
}

#[test]
fn static_limit_is_newtonian_tidal_field() {
    // E_ij = ∂i∂j Φ with Φ = −M/r − (3/2) x·I·x / r⁵, and B = 0.
    let mut rng = Rng(2);
    for _ in 0..20 {
        let mut q = rng.quad();
        for qk in q.iter_mut().skip(1) {
            *qk = [[0.0; 3]; 3];
        }
        let m = 0.6;
        let p = rng.point(20.0);
        let phi = |x: [f64; 3]| {
            let r = (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]).sqrt();
            let xi: f64 = (0..3)
                .map(|i| (0..3).map(|j| x[i] * q[0][i][j] * x[j]).sum::<f64>())
                .sum();
            -m / r - 1.5 * xi / r.powi(5)
        };
        let h = 1e-3 * (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        let hess: Mat3 = std::array::from_fn(|i| {
            std::array::from_fn(|j| {
                let at = |si: f64, sj: f64| {
                    let mut x = p;
                    x[i] += si * h;
                    x[j] += sj * h;
                    phi(x)
                };
                (at(1.0, 1.0) - at(1.0, -1.0) - at(-1.0, 1.0) + at(-1.0, -1.0)) / (4.0 * h * h)
            })
        });
        let e = tidal(p, m, &q);
        assert!(
            max_diff(&e, &hess) < 1e-5 * max_abs(&hess),
            "{e:?} vs {hess:?}"
        );
        assert!(max_abs(&frame_drag(p, &q)) == 0.0);
    }
}

#[test]
fn far_zone_is_a_transverse_outgoing_wave() {
    // r·E → −(d⁴I/dt⁴)^TT and B_ij → ε_ipq n_p E_qj, with error ∝ 1/r.
    let mut rng = Rng(3);
    let r = 1e6;
    for _ in 0..20 {
        let q = rng.quad();
        let mut n = rng.point(1.0);
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        n = n.map(|c| c / len);
        let p = n.map(|c| c * r);
        let e = tidal(p, 0.0, &q);
        let b = frame_drag(p, &q);
        let proj: Mat3 =
            std::array::from_fn(|i| std::array::from_fn(|j| (i == j) as u8 as f64 - n[i] * n[j]));
        let mul = |a: &Mat3, b: &Mat3| -> Mat3 {
            std::array::from_fn(|i| {
                std::array::from_fn(|j| (0..3).map(|k| a[i][k] * b[k][j]).sum())
            })
        };
        let piq = mul(&mul(&proj, &q[4]), &proj);
        let tr: f64 = (0..3).map(|i| piq[i][i]).sum();
        let tt: Mat3 =
            std::array::from_fn(|i| std::array::from_fn(|j| piq[i][j] - 0.5 * proj[i][j] * tr));
        let re: Mat3 = std::array::from_fn(|i| std::array::from_fn(|j| -r * e[i][j]));
        assert!(max_diff(&re, &tt) < 1e-5 * max_abs(&tt));
        let eps = |i: usize, j: usize, k: usize| {
            ((i as i32 - j as i32) * (j as i32 - k as i32) * (k as i32 - i as i32)) as f64 / 2.0
        };
        let nxe: Mat3 = std::array::from_fn(|i| {
            std::array::from_fn(|j| {
                (0..9)
                    .map(|k| (k / 3, k % 3))
                    .map(|(pp, qq)| eps(i, pp, qq) * n[pp] * e[qq][j])
                    .sum()
            })
        });
        assert!(max_diff(&b, &nxe) < 1e-5 * max_abs(&nxe));
    }
}

#[test]
fn eigen_decomposition() {
    let mut rng = Rng(4);
    for _ in 0..200 {
        let c: [f64; 6] = std::array::from_fn(|_| rng.next());
        let a = [[c[0], c[3], c[4]], [c[3], c[1], c[5]], [c[4], c[5], c[2]]];
        let ev = eigenvalues(&a);
        assert!(ev[0] <= ev[1] && ev[1] <= ev[2]);
        for &l in &[ev[0], ev[2]] {
            let v = eigenvector(&a, l);
            for i in 0..3 {
                let av: f64 = (0..3).map(|j| a[i][j] * v[j]).sum();
                assert!((av - l * v[i]).abs() < 1e-9, "eigenpair residual");
            }
        }
    }
}

/// r·(h₊ − i h×) from the (2,2) and (2,−2) modes at sample `i`.
fn strain22(wf: &Waveform, theta: f64, phi: f64, i: usize) -> Complex64 {
    [(2, 2), (2, -2)]
        .into_iter()
        .map(|(l, m)| wf.h(l, m, i).unwrap() * spin_weighted_ylm(-2, l, m, theta, phi))
        .sum()
}

#[test]
fn quadrupole_far_field_matches_the_22_mode_sum() {
    // E_ij = −½ ḧ_ij^TT far away. With the LAL convention h₊ = ½(h_φφ − h_θθ),
    // h× = −h_θφ, that is r(E₊ + i E_θφ) = −½ d²/dt² r(h₊ − i h×). This pins the
    // mode-to-quadrupole scale and sign and the K'''' derivatives.
    let wf = waveform(1.0);
    let quad = Quadrupole::new(&wf);
    let r = 1e5;
    let mut worst: f64 = 0.0;
    for (theta, phi) in [(0.4f64, 0.3f64), (PI / 2.0, 1.2), (2.2, -2.0), (1.0, 4.0)] {
        let e_th = [
            theta.cos() * phi.cos(),
            theta.cos() * phi.sin(),
            -theta.sin(),
        ];
        let e_ph = [-phi.sin(), phi.cos(), 0.0];
        let n = [
            theta.sin() * phi.cos(),
            theta.sin() * phi.sin(),
            theta.cos(),
        ];
        for u in [-3000.0, -1200.0, -400.0] {
            let i = ((u - wf.t0) / wf.dt).round() as usize;
            let u = wf.time(i);
            let e = tidal(n.map(|c| c * r), 0.0, &quad.derivatives(u));
            let form = |a: [f64; 3], b: [f64; 3]| -> f64 {
                (0..3)
                    .map(|x| (0..3).map(|y| a[x] * e[x][y] * b[y]).sum::<f64>())
                    .sum()
            };
            let lhs = Complex64::new(
                0.5 * (form(e_ph, e_ph) - form(e_th, e_th)),
                form(e_th, e_ph),
            ) * r;
            let s = |k: usize| strain22(&wf, theta, phi, k);
            let dd = (-s(i - 2) + s(i - 1) * 16.0 - s(i) * 30.0 + s(i + 1) * 16.0 - s(i + 2))
                / (12.0 * wf.dt * wf.dt);
            let rhs = dd * -0.5;
            worst = worst.max((lhs - rhs).norm() / rhs.norm());
        }
    }
    assert!(worst < 2e-3, "worst relative difference {worst:e}");
}

#[test]
fn adiabatic_quadrupole_is_consistent_in_the_inspiral() {
    // K'' = h₂₂ exactly by construction; the adiabatic K = −h₂₂/ω² must have
    // K'' ≈ h₂₂ and K' ≈ dK/dt while the frequency changes slowly.
    let wf = waveform(1.0);
    let quad = Quadrupole::new(&wf);
    let h = 1.0;
    for t in [-3000.0, -2000.0, -1000.0, -600.0] {
        let k = |x: f64| quad.k(x);
        let d2 = (k(t + h)[0] - k(t)[0] * 2.0 + k(t - h)[0]) / (h * h);
        let d1 = (k(t + h)[0] - k(t - h)[0]) / (2.0 * h);
        let now = k(t);
        assert!(
            (d2 - now[2]).norm() < 0.03 * now[2].norm(),
            "K'' vs h22 at t = {t}"
        );
        assert!((d1 - now[1]).norm() < 0.01 * now[1].norm(), "K' at t = {t}");
    }
}

#[test]
fn quadrupole_interpolation_is_accurate_through_merger() {
    // The app samples the waveform at 1 M; compare with a 0.25 M evaluation at off-grid times.
    let coarse = Quadrupole::new(&waveform(1.0));
    let fine = Quadrupole::new(&waveform(0.25));
    let mut worst = [0.0f64; 5];
    let mut peak = [0.0f64; 5];
    let mut t = -300.0 + 0.37;
    while t < 50.0 {
        let (a, b) = (coarse.k(t), fine.k(t));
        for n in 0..5 {
            worst[n] = worst[n].max((a[n] - b[n]).norm());
            peak[n] = peak[n].max(b[n].norm());
        }
        t += 0.5;
    }
    for n in 0..5 {
        assert!(
            worst[n] < 1e-2 * peak[n],
            "K^({n}): {:e} of peak",
            worst[n] / peak[n]
        );
    }
}

#[test]
fn seeds_fill_the_shell() {
    let s = seeds(500, 20.0, 100.0, 3);
    assert_eq!(s.len(), 500);
    let mut inner = 0;
    for p in &s {
        let r = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        assert!((20.0 - 1e-9..=100.0 + 1e-9).contains(&r));
        if r < 60.0 {
            inner += 1;
        }
    }
    // Uniform in radius: half the points inside r = 60.
    assert!((230..270).contains(&inner), "{inner} seeds inside r = 60");
    assert_ne!(seeds(1, 20.0, 100.0, 3)[0], seeds(1, 20.0, 100.0, 4)[0]);
}

#[test]
fn traced_lines_follow_the_eigenvectors() {
    let wf = waveform(1.0);
    let quad = Quadrupole::new(&wf);
    let params = TraceParams {
        t: -200.0,
        mass: 1.0,
        r_min: 15.0,
        r_max: 150.0,
        steps: 40,
        step_scale: 0.5,
    };
    for (field, family) in [
        (Field::Tidal, Family::Min),
        (Field::Tidal, Family::Max),
        (Field::FrameDrag, Family::Max),
    ] {
        let tracer = Tracer::new(&quad, field, family, params);
        let mut total = 0;
        for seed in seeds(20, 30.0, 120.0, 1) {
            let line = tracer.line(seed);
            total += line.len();
            for w in line.windows(2) {
                let r = (w[0].p.iter().map(|c| c * c).sum::<f64>()).sqrt();
                assert!(r >= params.r_min - 1e-9 && r <= params.r_max + 1e-9);
                // The chord between vertices lies along the family's eigenvector at its midpoint.
                let mid: [f64; 3] = std::array::from_fn(|i| 0.5 * (w[0].p[i] + w[1].p[i]));
                let t = tracer.tensor(mid);
                let ev = eigenvalues(&t);
                let v = eigenvector(&t, if family == Family::Min { ev[0] } else { ev[2] });
                let d: [f64; 3] = std::array::from_fn(|i| w[1].p[i] - w[0].p[i]);
                let len = (d.iter().map(|c| c * c).sum::<f64>()).sqrt();
                let cos = (d[0] * v[0] + d[1] * v[1] + d[2] * v[2]).abs() / len;
                assert!(
                    cos > 0.98,
                    "{field:?} {family:?}: chord at {cos:.3} to the eigenvector"
                );
            }
        }
        assert!(total > 200, "{field:?} {family:?}: only {total} vertices");
    }
}

/// Rough cost of tracing a frame's worth of lines (run with `--release -- --ignored`).
#[test]
#[ignore]
fn tracing_cost() {
    let wf = waveform(1.0);
    let quad = Quadrupole::new(&wf);
    let params = TraceParams {
        t: -200.0,
        mass: 1.0,
        r_min: 15.0,
        r_max: 600.0,
        steps: 40,
        step_scale: 1.0,
    };
    let tracer = Tracer::new(&quad, Field::Tidal, Family::Min, params);
    let start = std::time::Instant::now();
    let mut vertices = 0;
    for seed in seeds(150, 20.0, 600.0, 0) {
        vertices += tracer.line(seed).len();
    }
    let el = start.elapsed();
    println!(
        "150 lines, {vertices} vertices in {el:?} ({:.2} µs per vertex)",
        el.as_secs_f64() * 1e6 / vertices as f64
    );
}
