//! Light rays (null geodesics) around a Schwarzschild black hole, for the
//! lensing app: the CPU reference for its GPU ray tracer.
//!
//! Units: G = c = 1 and the black hole mass M = 1, so the horizon is at r = 2,
//! the photon sphere at r = 3 and the critical impact parameter is 3√3.
//!
//! A ray from a static observer at radius r₀ stays in the plane spanned by the
//! outward radial direction n̂ and its initial direction. With u = 1/r and φ
//! the angle swept in that plane, measured from n̂ toward the ray:
//!
//! ```text
//! (du/dφ)² = f(u) = 1/b² − u² + 2u³,   d²u/dφ² = 3u² − u
//! ```
//!
//! where b is the impact parameter. If the ray makes an angle ψ with n̂ in the
//! observer's local frame, b = r₀ sin ψ / √(1 − 2/r₀) and initially
//! du/dφ = −u √(1 − 2u) cot ψ.
//!
//! A ray escapes when u reaches 0 and is captured when it crosses the horizon
//! (u = 1/2). An escaping ray ends up moving radially, at angle φ_∞ from n̂, so
//! its direction at infinity is cos φ_∞ n̂ + sin φ_∞ t̂ (t̂ the tangential unit
//! vector of the initial direction). Tracing from the camera backwards in time,
//! that is the direction on the sky the pixel shows.
//!
//! Two independent methods compute φ_∞: [`sweep_quadrature`] (the integral of
//! du/√f, with the turning-point singularity removed by substitution) and
//! [`sweep_ode`] (RK4 on the second-order equation, as the GPU does). The
//! observer must be outside the photon sphere (r₀ > 3).

use std::f64::consts::PI;

/// Critical impact parameter 3√3: rays with smaller b fall in.
pub const B_CRIT: f64 = 5.196_152_422_706_632;

/// What happens to a ray traced back from the camera.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fate {
    /// Crosses the horizon: the pixel is black.
    Captured,
    /// Reaches infinity after sweeping `phi` radians from the camera's radial direction.
    Escaped { phi: f64 },
}

/// Impact parameter of a ray leaving a static observer at `r0` at angle `psi` from the outward radial direction.
pub fn impact_parameter(r0: f64, psi: f64) -> f64 {
    r0 * psi.sin() / (1.0 - 2.0 / r0).sqrt()
}

/// Angular radius of the shadow seen by a static observer at `r0` (> 3): rays
/// within this angle of the direction to the hole are captured.
pub fn shadow_angular_radius(r0: f64) -> f64 {
    (B_CRIT / r0 * (1.0 - 2.0 / r0).sqrt()).asin()
}

fn f(u: f64, inv_b2: f64) -> f64 {
    inv_b2 - u * u + 2.0 * u * u * u
}

/// The turning point: the smallest positive root of f (exists for b > B_CRIT).
fn turning_point(inv_b2: f64) -> f64 {
    // f(0) = 1/b² > 0 and f(1/3) = 1/b² − 1/27 < 0, and f decreases on [0, 1/3]:
    // bisect to full precision.
    let (mut lo, mut hi) = (0.0, 1.0 / 3.0);
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if f(mid, inv_b2) > 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
        if hi - lo < 1e-17 {
            break;
        }
    }
    0.5 * (lo + hi)
}

/// Gauss–Legendre nodes and weights on [−1, 1].
fn gauss_legendre(n: usize) -> Vec<(f64, f64)> {
    (0..n)
        .map(|i| {
            let mut x = (PI * (i as f64 + 0.75) / (n as f64 + 0.5)).cos();
            let mut dp = 0.0;
            for _ in 0..100 {
                let (mut p0, mut p1) = (1.0, x);
                for k in 2..=n {
                    let p2 = ((2 * k - 1) as f64 * x * p1 - (k - 1) as f64 * p0) / k as f64;
                    p0 = p1;
                    p1 = p2;
                }
                dp = n as f64 * (x * p1 - p0) / (x * x - 1.0);
                let dx = p1 / dp;
                x -= dx;
                if dx.abs() < 1e-16 {
                    break;
                }
            }
            (x, 2.0 / ((1.0 - x * x) * dp * dp))
        })
        .collect()
}

/// ∫ g over [a, b] by composite Gauss–Legendre (smooth integrands).
fn integrate(g: impl Fn(f64) -> f64, a: f64, b: f64) -> f64 {
    thread_local! {
        static NODES: Vec<(f64, f64)> = gauss_legendre(64);
    }
    const PANELS: usize = 16;
    NODES.with(|nodes| {
        let w = (b - a) / PANELS as f64;
        (0..PANELS)
            .map(|p| {
                let (lo, hi) = (a + p as f64 * w, a + (p + 1) as f64 * w);
                let (mid, half) = (0.5 * (lo + hi), 0.5 * (hi - lo));
                nodes
                    .iter()
                    .map(|&(x, wt)| wt * g(mid + half * x))
                    .sum::<f64>()
                    * half
            })
            .sum()
    })
}

/// q(w) with f(u1 − w²) = w² q(w) about a simple root u1 of f (exact: f is cubic).
fn root_factor(u1: f64) -> impl Fn(f64) -> f64 {
    let d1 = -2.0 * u1 + 6.0 * u1 * u1; // f'(u1) < 0
    let d2 = -2.0 + 12.0 * u1; // f''(u1)
    move |w: f64| {
        let w2 = w * w;
        -d1 + w2 * (0.5 * d2 - 2.0 * w2)
    }
}

/// ∫ du/√f(u) from u1 − w0² up to the simple root u1: with u = u1 − w² the
/// integrand becomes 2/√q(w), smooth and positive.
fn to_root_w(w0: f64, u1: f64) -> f64 {
    let q = root_factor(u1);
    integrate(|w| 2.0 / q(w).sqrt(), 0.0, w0)
}

/// ∫_a^{u1} du/√f(u) for a lower limit a known exactly.
fn to_root(a: f64, u1: f64) -> f64 {
    to_root_w((u1 - a).max(0.0).sqrt(), u1)
}

/// The w with u1 − w² = u0, found from f(u0) = w² q(w) (known exactly from the
/// ray's angle) rather than from u1 − u0, which loses all precision when the
/// observer sits at the turning point (a tangential ray).
fn w_at_observer(f0: f64, u0: f64, u1: f64) -> f64 {
    let q = root_factor(u1);
    // Start from the direct value (accurate unless u0 ≈ u1, and next to the right
    // root of the quartic); when u0 ≈ u1, from the small-w approximation.
    let gap = u1 - u0;
    let mut w = if gap > 1e-8 {
        gap.sqrt()
    } else {
        (f0 / q(0.0)).max(0.0).sqrt()
    };
    for _ in 0..30 {
        let (qw, h) = (q(w), 1e-7 * (w + 1e-12));
        let g = w * w * qw - f0;
        let dg =
            ((w + h) * (w + h) * q(w + h) - (w - h) * (w - h) * q((w - h).max(0.0))) / (2.0 * h);
        if dg == 0.0 {
            break;
        }
        let next = (w - g / dg).max(0.0);
        if (next - w).abs() <= 1e-16 * w.max(1e-300) {
            w = next;
            break;
        }
        w = next;
    }
    w
}

/// Angle swept to infinity (or capture) by quadrature.
pub fn sweep_quadrature(r0: f64, psi: f64) -> Fate {
    assert!(r0 > 3.0, "the observer must be outside the photon sphere");
    let u0 = 1.0 / r0;
    let b = impact_parameter(r0, psi);
    let outward = psi <= PI / 2.0;
    if b <= 1e-12 {
        return if outward {
            Fate::Escaped { phi: 0.0 }
        } else {
            Fate::Captured
        };
    }
    let inv_b2 = 1.0 / (b * b);
    if b < B_CRIT {
        if !outward {
            return Fate::Captured;
        }
        // No turning point below u = 1/3, so f > 0 on [0, u0]: the integrand is smooth.
        let phi = integrate(|u| 1.0 / f(u, inv_b2).sqrt(), 0.0, u0);
        return Fate::Escaped { phi };
    }
    let u1 = turning_point(inv_b2);
    let f0 = (u0 * (1.0 - 2.0 * u0).sqrt() / psi.tan()).powi(2);
    let from_observer = to_root_w(w_at_observer(f0, u0, u1), u1);
    let phi = if outward {
        to_root(0.0, u1) - from_observer
    } else {
        from_observer + to_root(0.0, u1)
    };
    Fate::Escaped { phi }
}

/// Angle swept to infinity (or capture) by RK4 on d²u/dφ² = 3u² − u with
/// step `h`, the escape point found by cubic Hermite interpolation. Mirrors the
/// GPU shader (which uses an adaptive step), but in f64.
pub fn sweep_ode(r0: f64, psi: f64, h: f64, max_steps: usize) -> Option<Fate> {
    let mut u = 1.0 / r0;
    let (s, c) = psi.sin_cos();
    if s < 1e-12 {
        return Some(if c > 0.0 {
            Fate::Escaped { phi: 0.0 }
        } else {
            Fate::Captured
        });
    }
    if c < 0.0 && impact_parameter(r0, psi) < B_CRIT {
        return Some(Fate::Captured);
    }
    let mut du = -u * (1.0 - 2.0 * u).sqrt() * c / s;
    let mut phi = 0.0;
    let acc = |u: f64| 3.0 * u * u - u;
    for _ in 0..max_steps {
        let (k1u, k1v) = (du, acc(u));
        let (k2u, k2v) = (du + 0.5 * h * k1v, acc(u + 0.5 * h * k1u));
        let (k3u, k3v) = (du + 0.5 * h * k2v, acc(u + 0.5 * h * k2u));
        let (k4u, k4v) = (du + h * k3v, acc(u + h * k3u));
        let u1 = u + h / 6.0 * (k1u + 2.0 * k2u + 2.0 * k3u + k4u);
        let du1 = du + h / 6.0 * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);
        if u1 >= 0.5 {
            return Some(Fate::Captured);
        }
        if u1 <= 0.0 {
            return Some(Fate::Escaped {
                phi: phi + h * hermite_root(u, du * h, u1, du1 * h),
            });
        }
        u = u1;
        du = du1;
        phi += h;
    }
    None
}

/// Root in [0, 1] of the cubic Hermite interpolant with values p0, p1 and
/// (step-scaled) slopes m0, m1, where p0 > 0 ≥ p1.
pub fn hermite_root(p0: f64, m0: f64, p1: f64, m1: f64) -> f64 {
    let mut s = (p0 / (p0 - p1)).clamp(0.0, 1.0);
    for _ in 0..8 {
        let (s2, s3) = (s * s, s * s * s);
        let p = (2.0 * s3 - 3.0 * s2 + 1.0) * p0
            + (s3 - 2.0 * s2 + s) * m0
            + (-2.0 * s3 + 3.0 * s2) * p1
            + (s3 - s2) * m1;
        let dp = (6.0 * s2 - 6.0 * s) * p0
            + (3.0 * s2 - 4.0 * s + 1.0) * m0
            + (-6.0 * s2 + 6.0 * s) * p1
            + (3.0 * s2 - 2.0 * s) * m1;
        if dp.abs() < 1e-300 {
            break;
        }
        s = (s - p / dp).clamp(0.0, 1.0);
    }
    s
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// The sky direction seen along `dir` (a unit vector in the static observer's
/// local frame, axes aligned with the coordinate directions) by a camera at
/// `cam` (|cam| > 3), or `None` if the ray falls into the hole.
pub fn escape_direction(cam: [f64; 3], dir: [f64; 3]) -> Option<[f64; 3]> {
    let r0 = dot(cam, cam).sqrt();
    let n = cam.map(|c| c / r0);
    let len = dot(dir, dir).sqrt();
    let d = dir.map(|c| c / len);
    let c = dot(d, n).clamp(-1.0, 1.0);
    let tang: [f64; 3] = std::array::from_fn(|i| d[i] - c * n[i]);
    let s = dot(tang, tang).sqrt();
    let psi = s.atan2(c);
    match sweep_quadrature(r0, psi) {
        Fate::Captured => None,
        Fate::Escaped { phi } => {
            if s < 1e-12 {
                return Some(n);
            }
            let t = tang.map(|x| x / s);
            let (sp, cp) = phi.sin_cos();
            Some(std::array::from_fn(|i| cp * n[i] + sp * t[i]))
        }
    }
}
