//! Light rays (null geodesics) around a spinning (Kerr) black hole, for the
//! lensing app: the CPU reference for its GPU ray tracer.
//!
//! Units: G = c = 1 and the black hole mass M = 1. The spin a ∈ [0, 1) points
//! along +z. Positions are Boyer–Lindquist (BL) coordinates (r, θ, φ), drawn in
//! the scene with the flat-space map x = r sin θ cos φ and so on.
//!
//! # The camera
//!
//! The camera is a zero-angular-momentum observer (ZAMO) at the BL position of
//! `cam`. A pixel direction `dir` is a vector in its local rest frame, whose
//! axes are along the BL coordinate directions (r̂, θ̂, φ̂ of the flat map), as
//! for the static observer of [`crate::geodesic`].
//!
//! # Tracing backwards
//!
//! The pixel shows the photon that *arrives* moving along −`dir`. Its past
//! path is found by time reversal: t → −t maps the Kerr spacetime of spin a to
//! the one of spin −a and maps a ZAMO to a ZAMO, so the arriving photon's past
//! path is the *future* path of a photon leaving along `dir` around a hole of
//! spin −a. Both integrators below trace that forward ray, internally with
//! spin `s` = −a; the public functions take the physical spin a.
//!
//! # Method 1: separated equations in Mino time ([`trace_mino`])
//!
//! With E = −p_t scaled to 1, L = p_φ, the Carter constant Q, and Mino time λ
//! (dλ = dτ/Σ), the ray separates (Carter 1968). With u = 1/r:
//!
//! ```text
//! (du/dλ)² = P(u) = (1 + k u²)² − C u²(1 − 2u + s²u²),   k = s² − sL,  C = Q + (L − s)²
//! d²u/dλ² = P′(u)/2
//! ```
//!
//! For the angles, BL φ is singular on the spin axis, so the ray's angular
//! position is integrated as a unit vector m, with frame dragging split off as
//! a rotation χ about z:
//!
//! ```text
//! d²m/dλ² = s² m_z ẑ − (s² m_z² + |dm/dλ|²) m          (motion on the unit sphere)
//! dχ/dλ   = Ψ(u) = s u (2 − sLu) / (1 − 2u + s²u²)
//! ```
//!
//! The BL direction is n = R_z(χ) m: m_z = cos θ obeys the polar equation
//! (dμ/dλ)² = Q − (Q + L² − s²)μ² − s²μ⁴, m's azimuth advances at L/sin²θ,
//! and χ carries the rest of dφ/dλ. All right-hand sides are polynomial or
//! regular: nothing is singular at infinity (u = 0 is reached at finite λ), at
//! the poles, or for u (not χ) at the horizon. At s = 0, χ = 0 and m moves on
//! a great circle at speed b, so d²u/dφ² = 3u² − u: the Schwarzschild orbit
//! equation of [`crate::geodesic`].
//!
//! RK4 with the step control of [`Steps`]; the escape point (u = 0) is found by
//! cubic Hermite interpolation, as in the Schwarzschild shader. The ray is
//! captured when u reaches 1/r₊. Generic over f32/f64 to predict the GPU's
//! float32 error.
//!
//! # Method 2: Hamiltonian in Kerr–Schild coordinates ([`trace_ks`])
//!
//! H = ½ g^{μν} p_μ p_ν with the Kerr–Schild inverse metric g^{μν} = η^{μν} − f l^μ l^ν,
//! integrated with an adaptive Dormand–Prince 5(4) method. No separation, no
//! Mino time, no BL coordinates along the way, and regular at the horizon; it
//! shares only the camera's frame and the time reversal with method 1. (The
//! time reversal's sign is checked physically by the tests: the shadow must be
//! flattened on the side of the hole that moves toward the camera.)

use num_traits::Float;

/// Outer horizon radius r₊ = 1 + √(1 − a²).
pub fn horizon_radius(a: f64) -> f64 {
    1.0 + (1.0 - a * a).sqrt()
}

/// Radii of the prograde and retrograde circular photon orbits in the equatorial plane.
pub fn equatorial_photon_orbits(a: f64) -> (f64, f64) {
    let a = a.abs();
    let r = |x: f64| 2.0 * (1.0 + ((2.0 / 3.0) * x.acos()).cos());
    (r(-a), r(a))
}

/// Critical constants (L, Q) (E = 1) of the spherical photon orbit at radius
/// `rp` (Bardeen 1973), for spin `a` > 0. Photons with these constants wind
/// toward that orbit; they trace the shadow's edge.
pub fn spherical_photon_orbit(a: f64, rp: f64) -> (f64, f64) {
    let l = (rp * rp * (3.0 - rp) - a * a * (rp + 1.0)) / (a * (rp - 1.0));
    let q = rp.powi(3) * (4.0 * a * a - rp * (rp - 3.0).powi(2)) / (a * a * (rp - 1.0).powi(2));
    (l, q)
}

/// What happens to a pixel's ray traced back from the camera.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fate {
    /// Falls into the hole: the pixel is black.
    Captured,
    /// Comes from this direction on the sky (a unit vector).
    Escaped([f64; 3]),
}

/// A traced ray: its fate (`None` if unresolved within the step cap) and the
/// number of steps taken.
#[derive(Debug, Clone, Copy)]
pub struct Trace {
    pub fate: Option<Fate>,
    pub steps: usize,
}

/// Step control for [`trace_mino`]. With angular rate ω = max(|dm/dλ|, 1) and
/// Ψ the frame-dragging rate, each step is
/// `h = max(min(u / (2|u′|), eps / max(ω, |Ψ|)), floor / ω)`.
/// At a = 0 that is the Schwarzschild shader's step in φ,
/// clamp(u / (2|du/dφ|), 0.002, 0.02), for b ≥ 1. The floor is set by ω alone
/// so that rays falling in reach the horizon in finitely many steps (Ψ diverges
/// there).
#[derive(Debug, Clone, Copy)]
pub struct Steps {
    pub eps: f64,
    pub floor: f64,
    pub max_steps: usize,
}

/// The step control the GPU shader uses (as in the Schwarzschild shader).
pub const SHADER_STEPS: Steps = Steps {
    eps: 0.02,
    floor: 0.002,
    max_steps: 1000,
};

/// A fine step control for reference results.
pub const REFERENCE_STEPS: Steps = Steps {
    eps: 1e-3,
    floor: 1e-4,
    max_steps: 4_000_000,
};

fn c<F: Float>(x: f64) -> F {
    F::from(x).unwrap()
}

/// The camera's BL position and the axes of its local frame (flat-map r̂, θ̂, φ̂).
#[derive(Debug, Clone, Copy)]
pub struct Frame<F> {
    pub r: F,
    pub cos_theta: F,
    pub sin_theta: F,
    pub phi: F,
    pub e_r: [F; 3],
    pub e_theta: [F; 3],
    pub e_phi: [F; 3],
}

/// The frame at `cam`. On the axis (sin θ = 0), φ = 0 is used.
pub fn frame<F: Float>(cam: [F; 3]) -> Frame<F> {
    let [x, y, z] = cam;
    let rho = (x * x + y * y).sqrt();
    let r = (rho * rho + z * z).sqrt();
    let (st, ct) = (rho / r, z / r);
    let (cp, sp) = if rho > F::zero() {
        (x / rho, y / rho)
    } else {
        (F::one(), F::zero())
    };
    Frame {
        r,
        cos_theta: ct,
        sin_theta: st,
        phi: sp.atan2(cp),
        e_r: [st * cp, st * sp, ct],
        e_theta: [ct * cp, ct * sp, -st],
        e_phi: [-sp, cp, F::zero()],
    }
}

/// ZAMO quantities at BL (r, θ) for spin `s`: lapse α, frame-dragging rate ω,
/// and √(A/Σ) (= ϖ / sin θ, ϖ the circumferential radius), plus Σ and Δ.
#[derive(Debug, Clone, Copy)]
pub struct Zamo<F> {
    pub sigma: F,
    pub delta: F,
    pub alpha: F,
    pub omega: F,
    pub varpi_over_sin: F,
}

pub fn zamo<F: Float>(s: F, r: F, cos_theta: F) -> Zamo<F> {
    let two = c::<F>(2.0);
    let sigma = r * r + s * s * cos_theta * cos_theta;
    let delta = r * r - two * r + s * s;
    let sin2 = F::one() - cos_theta * cos_theta;
    let r2a2 = r * r + s * s;
    let big_a = r2a2 * r2a2 - s * s * delta * sin2;
    Zamo {
        sigma,
        delta,
        alpha: (sigma * delta / big_a).sqrt(),
        omega: two * s * r / big_a,
        varpi_over_sin: (big_a / sigma).sqrt(),
    }
}

fn dot<F: Float>(a: [F; 3], b: [F; 3]) -> F {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn normalize<F: Float>(v: [F; 3]) -> [F; 3] {
    let n = dot(v, v).sqrt();
    v.map(|x| x / n)
}

/// Root in [0, 1] of the cubic Hermite interpolant with values p0, p1 and
/// (step-scaled) slopes m0, m1, where p0 > 0 ≥ p1.
pub fn hermite_root<F: Float>(p0: F, m0: F, p1: F, m1: F) -> F {
    let (one, two, three) = (F::one(), c::<F>(2.0), c::<F>(3.0));
    let (four, six) = (c::<F>(4.0), c::<F>(6.0));
    let mut t = (p0 / (p0 - p1)).max(F::zero()).min(one);
    for _ in 0..8 {
        let (t2, t3) = (t * t, t * t * t);
        let p = (two * t3 - three * t2 + one) * p0
            + (t3 - two * t2 + t) * m0
            + (three * t2 - two * t3) * p1
            + (t3 - t2) * m1;
        let dp = (six * t2 - six * t) * p0
            + (three * t2 - four * t + one) * m0
            + (six * t - six * t2) * p1
            + (three * t2 - two * t) * m1;
        if dp.abs() < F::min_positive_value() {
            break;
        }
        t = (t - p / dp).max(F::zero()).min(one);
    }
    t
}

/// Cubic Hermite interpolation at t ∈ [0, 1] (slopes step-scaled).
fn hermite<F: Float>(p0: F, m0: F, p1: F, m1: F, t: F) -> F {
    let (one, two, three) = (F::one(), c::<F>(2.0), c::<F>(3.0));
    let (t2, t3) = (t * t, t * t * t);
    (two * t3 - three * t2 + one) * p0
        + (t3 - two * t2 + t) * m0
        + (three * t2 - two * t3) * p1
        + (t3 - t2) * m1
}

/// Initial state and constants of the forward ray for [`trace_mino`].
#[derive(Debug, Clone, Copy)]
pub struct MinoStart<F> {
    /// Spin of the spacetime the forward ray is traced in (−a).
    pub s: F,
    /// L = p_φ / E.
    pub l: F,
    /// Carter constant Q / E².
    pub q: F,
    pub u: F,
    pub du: F,
    pub m: [F; 3],
    pub dm: [F; 3],
    /// k = s² − sL and C = Q + (L − s)² in P(u).
    pub k: F,
    pub big_c: F,
}

/// The forward ray leaving the ZAMO at `cam` along `dir` (local frame) in
/// spin-`s` Kerr, in Mino-time variables.
pub fn mino_start<F: Float>(cam: [F; 3], s: F, dir: [F; 3]) -> MinoStart<F> {
    let fr = frame(cam);
    let d = normalize(dir);
    let (nr, nt, np) = (dot(d, fr.e_r), dot(d, fr.e_theta), dot(d, fr.e_phi));
    let z = zamo(s, fr.r, fr.cos_theta);
    let e = z.alpha + z.omega * fr.sin_theta * z.varpi_over_sin * np;
    let l_over_sin = z.varpi_over_sin * np / e;
    let l = l_over_sin * fr.sin_theta;
    let p_theta = z.sigma.sqrt() * nt / e;
    let u = F::one() / fr.r;
    let du = -u * u * (z.sigma * z.delta).sqrt() * nr / e;
    let dm: [F; 3] = std::array::from_fn(|i| p_theta * fr.e_theta[i] + l_over_sin * fr.e_phi[i]);
    let mu = fr.cos_theta;
    let q = p_theta * p_theta + mu * mu * (l_over_sin * l_over_sin - s * s);
    MinoStart {
        s,
        l,
        q,
        u,
        du,
        m: fr.e_r,
        dm,
        k: s * s - s * l,
        big_c: q + (l - s) * (l - s),
    }
}

/// State (u, u′, m, m′, χ).
type MinoState<F> = [F; 9];

fn mino_rhs<F: Float>(st: &MinoStart<F>, y: &MinoState<F>) -> MinoState<F> {
    let (s, k, cc) = (st.s, st.k, st.big_c);
    let (two, three) = (c::<F>(2.0), c::<F>(3.0));
    let u = y[0];
    let ddu =
        two * k * u * (F::one() + k * u * u) - cc * (u - three * u * u + two * s * s * u * u * u);
    let m = [y[2], y[3], y[4]];
    let dm = [y[5], y[6], y[7]];
    let mz = m[2];
    let cen = s * s * mz * mz + dot(dm, dm);
    let psi = frame_drag(st, u);
    [
        y[1],
        ddu,
        dm[0],
        dm[1],
        dm[2],
        -cen * m[0],
        -cen * m[1],
        s * s * mz - cen * m[2],
        psi,
    ]
}

/// Ψ(u) = dχ/dλ, the frame-dragging part of dφ/dλ.
fn frame_drag<F: Float>(st: &MinoStart<F>, u: F) -> F {
    let (s, two) = (st.s, c::<F>(2.0));
    s * u * (two - s * st.l * u) / (F::one() - two * u + s * s * u * u)
}

fn rk4<F: Float>(st: &MinoStart<F>, y: &MinoState<F>, h: F) -> MinoState<F> {
    let half = c::<F>(0.5);
    let add = |a: &MinoState<F>, b: &MinoState<F>, w: F| -> MinoState<F> {
        std::array::from_fn(|i| a[i] + w * b[i])
    };
    let k1 = mino_rhs(st, y);
    let k2 = mino_rhs(st, &add(y, &k1, half * h));
    let k3 = mino_rhs(st, &add(y, &k2, half * h));
    let k4 = mino_rhs(st, &add(y, &k3, h));
    let sixth = h / c::<F>(6.0);
    let two = c::<F>(2.0);
    std::array::from_fn(|i| y[i] + sixth * (k1[i] + two * k2[i] + two * k3[i] + k4[i]))
}

/// Traces the pixel ray `dir` of a ZAMO camera at `cam` around a hole of spin
/// `a`, by RK4 in Mino time in arithmetic `F` (f64 for references, f32 to
/// mimic the GPU). Mirrors the GPU shader.
pub fn trace_mino<F: Float>(cam: [f64; 3], a: f64, dir: [f64; 3], steps: &Steps) -> Trace {
    let st = mino_start(cam.map(c::<F>), c::<F>(-a), dir.map(c::<F>));
    let u_plus = c::<F>(1.0 / horizon_radius(a));
    let (eps, floor) = (c::<F>(steps.eps), c::<F>(steps.floor));
    let half = c::<F>(0.5);
    let tiny = c::<F>(1e-30);
    let mut y: MinoState<F> = [
        st.u,
        st.du,
        st.m[0],
        st.m[1],
        st.m[2],
        st.dm[0],
        st.dm[1],
        st.dm[2],
        F::zero(),
    ];
    for i in 0..steps.max_steps {
        let u = y[0];
        let rate = dot([y[5], y[6], y[7]], [y[5], y[6], y[7]])
            .sqrt()
            .max(F::one());
        let psi = frame_drag(&st, u);
        let h = (half * u / y[1].abs().max(tiny))
            .min(eps / rate.max(psi.abs()))
            .max(floor / rate);
        let y1 = rk4(&st, &y, h);
        if y1[0] >= u_plus {
            return Trace {
                fate: Some(Fate::Captured),
                steps: i + 1,
            };
        }
        if y1[0] <= F::zero() {
            let t = hermite_root(y[0], y[1] * h, y1[0], y1[1] * h);
            let m: [F; 3] = std::array::from_fn(|j| {
                hermite(y[2 + j], y[5 + j] * h, y1[2 + j], y1[5 + j] * h, t)
            });
            let chi = hermite(y[8], psi * h, y1[8], frame_drag(&st, y1[0]) * h, t);
            let m = normalize(m);
            let (sc, cc) = chi.sin_cos();
            let dir = [cc * m[0] - sc * m[1], sc * m[0] + cc * m[1], m[2]];
            return Trace {
                fate: Some(Fate::Escaped(dir.map(|x| x.to_f64().unwrap()))),
                steps: i + 1,
            };
        }
        y = y1;
    }
    Trace {
        fate: None,
        steps: steps.max_steps,
    }
}

/// The sky direction seen along `dir` by a ZAMO camera at `cam` around a hole
/// of spin `a`, or `None` if the ray falls in (or doesn't resolve: it then
/// sits on the photon ring). [`trace_mino`] in f64 with [`REFERENCE_STEPS`].
pub fn escape_direction(cam: [f64; 3], a: f64, dir: [f64; 3]) -> Option<[f64; 3]> {
    match trace_mino::<f64>(cam, a, dir, &REFERENCE_STEPS).fate {
        Some(Fate::Escaped(d)) => Some(d),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Method 2: Kerr–Schild Hamiltonian.

/// A number with its gradient with respect to (x, y, z).
#[derive(Debug, Clone, Copy)]
struct Dual {
    v: f64,
    g: [f64; 3],
}

impl Dual {
    fn cst(v: f64) -> Self {
        Dual { v, g: [0.0; 3] }
    }
    fn var(v: f64, i: usize) -> Self {
        let mut g = [0.0; 3];
        g[i] = 1.0;
        Dual { v, g }
    }
    fn sqrt(self) -> Self {
        let r = self.v.sqrt();
        Dual {
            v: r,
            g: self.g.map(|x| 0.5 * x / r),
        }
    }
}

impl std::ops::Add for Dual {
    type Output = Dual;
    fn add(self, o: Dual) -> Dual {
        Dual {
            v: self.v + o.v,
            g: std::array::from_fn(|i| self.g[i] + o.g[i]),
        }
    }
}

impl std::ops::Sub for Dual {
    type Output = Dual;
    fn sub(self, o: Dual) -> Dual {
        Dual {
            v: self.v - o.v,
            g: std::array::from_fn(|i| self.g[i] - o.g[i]),
        }
    }
}

// Product and quotient rules: the mixed operators are intended.
#[allow(clippy::suspicious_arithmetic_impl)]
impl std::ops::Mul for Dual {
    type Output = Dual;
    fn mul(self, o: Dual) -> Dual {
        Dual {
            v: self.v * o.v,
            g: std::array::from_fn(|i| self.g[i] * o.v + self.v * o.g[i]),
        }
    }
}

// Product and quotient rules: the mixed operators are intended.
#[allow(clippy::suspicious_arithmetic_impl)]
impl std::ops::Div for Dual {
    type Output = Dual;
    fn div(self, o: Dual) -> Dual {
        Dual {
            v: self.v / o.v,
            g: std::array::from_fn(|i| (self.g[i] * o.v - self.v * o.g[i]) / (o.v * o.v)),
        }
    }
}

/// Kerr–Schild fields at Cartesian (x, y, z) for spin `s`: the BL radius r,
/// f = 2r³/(r⁴ + s²z²) and the spatial part of l_μ = (1, (rx + sy)/(r² + s²), (ry − sx)/(r² + s²), z/r).
fn ks_fields(s: f64, x: [Dual; 3]) -> (Dual, Dual, [Dual; 3]) {
    let [px, py, pz] = x;
    let s2 = Dual::cst(s * s);
    let w = px * px + py * py + pz * pz - s2;
    let r2 = Dual::cst(0.5) * (w + (w * w + Dual::cst(4.0) * s2 * pz * pz).sqrt());
    let r = r2.sqrt();
    let f = Dual::cst(2.0) * r * r2 / (r2 * r2 + s2 * pz * pz);
    let den = r2 + s2;
    let sd = Dual::cst(s);
    let l = [(r * px + sd * py) / den, (r * py - sd * px) / den, pz / r];
    (r, f, l)
}

/// The Kerr–Schild metric g_μν = η_μν + f l_μ l_ν at Cartesian `x`, coordinates (t, x, y, z).
pub fn ks_metric(s: f64, x: [f64; 3]) -> [[f64; 4]; 4] {
    let (_, f, l) = ks_fields(s, x.map(Dual::cst));
    let lv = [1.0, l[0].v, l[1].v, l[2].v];
    std::array::from_fn(|i| {
        std::array::from_fn(|j| {
            let eta = if i == j {
                if i == 0 { -1.0 } else { 1.0 }
            } else {
                0.0
            };
            eta + f.v * lv[i] * lv[j]
        })
    })
}

/// The BL metric g_μν at (r, θ) for spin `s`, coordinates (t, r, θ, φ).
pub fn bl_metric(s: f64, r: f64, theta: f64) -> [[f64; 4]; 4] {
    let (st, ct) = theta.sin_cos();
    let sigma = r * r + s * s * ct * ct;
    let delta = r * r - 2.0 * r + s * s;
    let big_a = (r * r + s * s).powi(2) - s * s * delta * st * st;
    let mut g = [[0.0; 4]; 4];
    g[0][0] = -(1.0 - 2.0 * r / sigma);
    g[0][3] = -2.0 * s * r * st * st / sigma;
    g[3][0] = g[0][3];
    g[1][1] = sigma / delta;
    g[2][2] = sigma;
    g[3][3] = big_a * st * st / sigma;
    g
}

/// Kerr–Schild azimuth minus BL azimuth at radius r, φ̃ − φ = ∫ s/Δ dr, with
/// the constant chosen so the two agree at infinity.
pub fn ks_azimuth_offset(s: f64, r: f64) -> f64 {
    if s == 0.0 {
        return 0.0;
    }
    let root = (1.0 - s * s).sqrt();
    let (rp, rm) = (1.0 + root, 1.0 - root);
    s / (rp - rm) * ((r - rp) / (r - rm)).ln()
}

/// The Jacobian ∂(t̃, x, y, z)/∂(t, r, θ, φ) of BL → Kerr–Schild at BL (r, θ, φ),
/// columns indexed by the BL coordinate. Also returns the Cartesian position.
pub fn bl_to_ks_jacobian(s: f64, r: f64, theta: f64, phi: f64) -> ([[f64; 4]; 4], [f64; 3]) {
    let (st, ct) = theta.sin_cos();
    let pt = phi + ks_azimuth_offset(s, r);
    let (sp, cp) = pt.sin_cos();
    let delta = r * r - 2.0 * r + s * s;
    let (xa, ya) = (r * cp - s * sp, r * sp + s * cp); // x / sin θ, y / sin θ
    let pos = [xa * st, ya * st, r * ct];
    let mut j = [[0.0; 4]; 4];
    // ∂/∂t
    j[0][0] = 1.0;
    // ∂/∂r = ∂/∂r|_KS + (2r/Δ) ∂/∂t̃ + (s/Δ) ∂/∂φ̃
    j[0][1] = 2.0 * r / delta;
    j[1][1] = st * cp - (s / delta) * pos[1];
    j[2][1] = st * sp + (s / delta) * pos[0];
    j[3][1] = ct;
    // ∂/∂θ
    j[1][2] = xa * ct;
    j[2][2] = ya * ct;
    j[3][2] = -r * st;
    // ∂/∂φ = ∂/∂φ̃
    j[1][3] = -pos[1];
    j[2][3] = pos[0];
    (j, pos)
}

/// Kerr–Schild phase-space state (x, y, z, p_x, p_y, p_z); p_t = −E is fixed.
type KsState = [f64; 6];

fn ks_rhs(s: f64, e: f64, y: &KsState) -> KsState {
    let x = [Dual::var(y[0], 0), Dual::var(y[1], 1), Dual::var(y[2], 2)];
    let (_, f, l) = ks_fields(s, x);
    let p = [y[3], y[4], y[5]];
    // l^μ p_μ with l^t = −1, p_t = −E.
    let lp = e + l[0].v * p[0] + l[1].v * p[1] + l[2].v * p[2];
    let mut out = [0.0; 6];
    for i in 0..3 {
        out[i] = p[i] - f.v * lp * l[i].v;
        let dl_p = l[0].g[i] * p[0] + l[1].g[i] * p[1] + l[2].g[i] * p[2];
        out[3 + i] = 0.5 * f.g[i] * lp * lp + f.v * lp * dl_p;
    }
    out
}

fn ks_radius(s: f64, x: [f64; 3]) -> f64 {
    ks_fields(s, x.map(Dual::cst)).0.v
}

/// Conserved quantities of a Kerr–Schild state: H (0 for light), E, L = p_φ and Carter's Q.
pub fn ks_invariants(s: f64, e: f64, y: &[f64; 6]) -> [f64; 4] {
    let x = [y[0], y[1], y[2]];
    let (r, f, l) = ks_fields(s, x.map(Dual::cst));
    let (r, f) = (r.v, f.v);
    let p = [y[3], y[4], y[5]];
    let lp = e + l[0].v * p[0] + l[1].v * p[1] + l[2].v * p[2];
    let h = 0.5 * (-e * e + dot(p, p) - f * lp * lp);
    let lz = x[0] * p[1] - x[1] * p[0];
    let ct = x[2] / r;
    let st2 = 1.0 - ct * ct;
    let cot = ct / st2.sqrt();
    let p_theta = cot * (x[0] * p[0] + x[1] * p[1]) - r * st2.sqrt() * p[2];
    let q = p_theta * p_theta + ct * ct * (lz * lz / st2 - s * s * e * e);
    [h, e, lz, q]
}

/// Initial Kerr–Schild state of the forward ray leaving the ZAMO at `cam` along
/// `dir` in spin-`s` Kerr (unit local energy). Returns (state, E).
pub fn ks_start(cam: [f64; 3], s: f64, dir: [f64; 3]) -> (KsState, f64) {
    let fr = frame(cam);
    let d = normalize(dir);
    let (nr, nt, np) = (dot(d, fr.e_r), dot(d, fr.e_theta), dot(d, fr.e_phi));
    let r = fr.r;
    let z = zamo(s, r, fr.cos_theta);
    // Contravariant BL momentum p = e_t̂ + n_r e_r̂ + n_θ e_θ̂ + n_φ e_φ̂; sin θ p^φ is regular on the axis.
    let pt = 1.0 / z.alpha;
    let pr = (z.delta / z.sigma).sqrt() * nr;
    let pth = nt / z.sigma.sqrt();
    let sin_pphi = fr.sin_theta * z.omega / z.alpha + np / z.varpi_over_sin;
    let (st, ct) = (fr.sin_theta, fr.cos_theta);
    let ptil = fr.phi + ks_azimuth_offset(s, r);
    let (sp, cp) = ptil.sin_cos();
    let (xa, ya) = (r * cp - s * sp, r * sp + s * cp);
    let pos = [xa * st, ya * st, r * ct];
    // sin θ p^φ̃ = sin θ (p^φ + (s/Δ) p^r)
    let sin_pphit = sin_pphi + st * (s / z.delta) * pr;
    let pt_ks = pt + 2.0 * r / z.delta * pr;
    let pvec = [
        st * cp * pr + xa * ct * pth - ya * sin_pphit,
        st * sp * pr + ya * ct * pth + xa * sin_pphit,
        ct * pr - r * st * pth,
    ];
    // Lower with g = η + f l l.
    let (_, f, l) = ks_fields(s, pos.map(Dual::cst));
    let lup = pt_ks + l[0].v * pvec[0] + l[1].v * pvec[1] + l[2].v * pvec[2]; // l_μ p^μ, l_t = 1
    let p_t = -pt_ks + f.v * lup;
    let p: [f64; 3] = std::array::from_fn(|i| pvec[i] + f.v * l[i].v * lup);
    ([pos[0], pos[1], pos[2], p[0], p[1], p[2]], -p_t)
}

/// Dormand–Prince 5(4) on the Kerr–Schild Hamiltonian until the ray crosses
/// the horizon or reaches `r_far`. `visit` sees every accepted state.
fn ks_integrate(
    s: f64,
    e: f64,
    mut y: KsState,
    tol: f64,
    r_far: f64,
    max_steps: usize,
    mut visit: impl FnMut(&KsState),
) -> Trace {
    const A: [[f64; 6]; 7] = [
        [0.0; 6],
        [0.2, 0.0, 0.0, 0.0, 0.0, 0.0],
        [3.0 / 40.0, 9.0 / 40.0, 0.0, 0.0, 0.0, 0.0],
        [44.0 / 45.0, -56.0 / 15.0, 32.0 / 9.0, 0.0, 0.0, 0.0],
        [
            19372.0 / 6561.0,
            -25360.0 / 2187.0,
            64448.0 / 6561.0,
            -212.0 / 729.0,
            0.0,
            0.0,
        ],
        [
            9017.0 / 3168.0,
            -355.0 / 33.0,
            46732.0 / 5247.0,
            49.0 / 176.0,
            -5103.0 / 18656.0,
            0.0,
        ],
        [
            35.0 / 384.0,
            0.0,
            500.0 / 1113.0,
            125.0 / 192.0,
            -2187.0 / 6784.0,
            11.0 / 84.0,
        ],
    ];
    const B4: [f64; 7] = [
        5179.0 / 57600.0,
        0.0,
        7571.0 / 16695.0,
        393.0 / 640.0,
        -92097.0 / 339200.0,
        187.0 / 2100.0,
        1.0 / 40.0,
    ];
    let r_plus = horizon_radius(s);
    let mut h = 1e-2;
    let mut k = [[0.0; 6]; 7];
    k[0] = ks_rhs(s, e, &y);
    let mut steps = 0;
    while steps < max_steps {
        steps += 1;
        for i in 1..7 {
            let yi: KsState =
                std::array::from_fn(|n| y[n] + h * (0..i).map(|j| A[i][j] * k[j][n]).sum::<f64>());
            k[i] = ks_rhs(s, e, &yi);
        }
        // The 5th-order solution is the last stage's argument (FSAL).
        let y5: KsState =
            std::array::from_fn(|n| y[n] + h * (0..6).map(|j| A[6][j] * k[j][n]).sum::<f64>());
        let y4: KsState =
            std::array::from_fn(|n| y[n] + h * (0..7).map(|j| B4[j] * k[j][n]).sum::<f64>());
        let err = (0..6)
            .map(|n| {
                let sc = tol + tol * y[n].abs().max(y5[n].abs());
                ((y5[n] - y4[n]) / sc).powi(2)
            })
            .sum::<f64>()
            / 6.0;
        let err = err.sqrt();
        if err <= 1.0 {
            y = y5;
            k[0] = k[6];
            visit(&y);
            let r = ks_radius(s, [y[0], y[1], y[2]]);
            if r < r_plus {
                return Trace {
                    fate: Some(Fate::Captured),
                    steps,
                };
            }
            if r > r_far {
                let v: [f64; 3] = std::array::from_fn(|n| k[0][n]);
                return Trace {
                    fate: Some(Fate::Escaped(normalize(v))),
                    steps,
                };
            }
        }
        let fac = if err == 0.0 {
            5.0
        } else {
            (0.9 * err.powf(-0.2)).clamp(0.2, 5.0)
        };
        h *= fac;
    }
    Trace { fate: None, steps }
}

/// Traces the pixel ray `dir` of a ZAMO camera at `cam` around a hole of spin
/// `a` by integrating Hamilton's equations in Kerr–Schild coordinates
/// (Dormand–Prince 5(4), tolerance `tol`), to r = 10⁷ (where the remaining
/// bending is below 1e-12 rad for the rays of interest) or the horizon.
pub fn trace_ks(cam: [f64; 3], a: f64, dir: [f64; 3], tol: f64) -> Trace {
    let s = -a;
    let (y, e) = ks_start(cam, s, dir);
    ks_integrate(s, e, y, tol, 1e7, 2_000_000, |_| {})
}

/// The largest deviation of (H, E, L, Q) from their initial values along a
/// [`trace_ks`] ray while r < 1000, relative to max(1, |initial value|). For tests.
pub fn ks_invariant_drift(cam: [f64; 3], a: f64, dir: [f64; 3], tol: f64) -> [f64; 4] {
    let s = -a;
    let (y, e) = ks_start(cam, s, dir);
    let start = ks_invariants(s, e, &y);
    let mut worst = [0.0f64; 4];
    ks_integrate(s, e, y, tol, 1e7, 2_000_000, |y| {
        let x = [y[0], y[1], y[2]];
        let r = ks_radius(s, x);
        // Far out, L = x p_y − y p_x loses digits to cancellation: stop checking.
        if r > 1e3 {
            return;
        }
        let now = ks_invariants(s, e, y);
        for i in 0..4 {
            // Q's formula has a cot θ: skip it near the axis.
            if i == 3 && (x[2] / r).abs() > 0.99 {
                continue;
            }
            let d = (now[i] - start[i]).abs() / start[i].abs().max(1.0);
            worst[i] = worst[i].max(d);
        }
    });
    worst
}

// ---------------------------------------------------------------------------
// The shadow's edge.

/// Pixel directions (unit vectors, scene axes) on the edge of the shadow seen
/// by a ZAMO camera at `cam` around a hole of spin `a`, as a closed loop of
/// about `n` points. Exact: each is the direction from which photons with the
/// critical constants of a spherical photon orbit arrive (Bardeen 1973). At
/// a = 0 or on the axis the edge is a circle about the direction to the hole.
pub fn shadow_edge(cam: [f64; 3], a: f64, n: usize) -> Vec<[f64; 3]> {
    let fr = frame(cam);
    let (r0, mu0) = (fr.r, fr.cos_theta);
    let center = fr.e_r.map(|x| -x);
    let circle = |sin_radius: f64| -> Vec<[f64; 3]> {
        let (sr, cr) = (sin_radius, (1.0 - sin_radius * sin_radius).sqrt());
        (0..n)
            .map(|i| {
                let t = 2.0 * std::f64::consts::PI * i as f64 / n as f64;
                let (st, ct) = t.sin_cos();
                std::array::from_fn(|j| {
                    cr * center[j] + sr * (ct * fr.e_theta[j] + st * fr.e_phi[j])
                })
            })
            .collect()
    };
    let z = zamo(a, r0, mu0);
    let (rpro, rret) = equatorial_photon_orbits(a);
    if a < 1e-9 {
        let b = 27f64.sqrt();
        return circle(b / r0 * (1.0 - 2.0 / r0).sqrt());
    }
    if fr.sin_theta < 1e-9 {
        // Only L = 0 photons reach the axis.
        let g = |r: f64| r * r * (3.0 - r) - a * a * (r + 1.0);
        let (mut lo, mut hi) = (rpro, rret);
        for _ in 0..200 {
            let mid = 0.5 * (lo + hi);
            if g(mid) > 0.0 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let (_, q) = spherical_photon_orbit(a, 0.5 * (lo + hi));
        return circle((z.delta * (q + a * a)).sqrt() / (r0 * r0 + a * a));
    }
    let st2 = 1.0 - mu0 * mu0;
    // Θ(θ₀) ≥ 0: photons of that orbit reach the camera's latitude.
    let reaches = |rp: f64| {
        let (l, q) = spherical_photon_orbit(a, rp);
        q + a * a * mu0 * mu0 - l * l * mu0 * mu0 / st2
    };
    let point = |rp: f64, sign: f64| -> [f64; 3] {
        let (l, q) = spherical_photon_orbit(a, rp);
        let theta = reaches(rp).max(0.0);
        let e_loc = (1.0 - z.omega * l) / z.alpha;
        let np = l / (fr.sin_theta * z.varpi_over_sin * e_loc);
        let nt = sign * theta.sqrt() / (z.sigma.sqrt() * e_loc);
        let big_r = (r0 * r0 + a * a - a * l).powi(2) - z.delta * (q + (l - a).powi(2));
        let nr = (r0 - rp).signum() * (big_r.max(0.0) / (z.sigma * z.delta)).sqrt() / e_loc;
        // The arriving photon moves along n; the pixel looks along −n.
        std::array::from_fn(|j| -(nr * fr.e_r[j] + nt * fr.e_theta[j] + np * fr.e_phi[j]))
    };
    // The orbits that reach the camera form one interval of radii: find its ends.
    let scan = 4000;
    let at = |i: usize| rpro + (rret - rpro) * i as f64 / scan as f64;
    let first = (0..=scan).find(|&i| reaches(at(i)) >= 0.0);
    let last = (0..=scan).rev().find(|&i| reaches(at(i)) >= 0.0);
    let (Some(first), Some(last)) = (first, last) else {
        return Vec::new();
    };
    let refine = |mut inside: f64, mut outside: f64| {
        for _ in 0..100 {
            let mid = 0.5 * (inside + outside);
            if reaches(mid) >= 0.0 {
                inside = mid;
            } else {
                outside = mid;
            }
        }
        inside
    };
    let r1 = if first == 0 {
        rpro
    } else {
        refine(at(first), at(first - 1))
    };
    let r2 = if last == scan {
        rret
    } else {
        refine(at(last), at(last + 1))
    };
    let m = n / 2;
    let rps: Vec<f64> = (0..=m)
        .map(|i| {
            let t = std::f64::consts::PI * i as f64 / m as f64;
            r1 + (r2 - r1) * 0.5 * (1.0 - t.cos())
        })
        .collect();
    let mut out: Vec<[f64; 3]> = rps.iter().map(|&rp| point(rp, 1.0)).collect();
    out.extend(rps.iter().rev().map(|&rp| point(rp, -1.0)));
    out
}
