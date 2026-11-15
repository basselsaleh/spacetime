//! Embedding diagrams (curvature app): a 2D slice of space drawn as a surface
//! of revolution in Euclidean R³ with the same lengths.
//!
//! A slice t = const, θ = π/2 of a static, spherically symmetric spacetime has
//! the metric
//!
//! ```text
//! dl² = dr²/f(r) + R(r)² dφ²
//! ```
//!
//! with f = 1/g_rr and R the circumferential radius (a circle at r has length
//! 2πR). In R³ with cylindrical coordinates (ρ, φ, z), the surface ρ = R(r),
//! z = z(r) has these lengths when (dz/dr)² = 1/f − (dR/dr)². That needs
//! f R′² ≤ 1; where it fails, no surface of revolution has this geometry.
//!
//! The slice is written with f rather than g_rr because f is regular at a
//! horizon (it vanishes there), which keeps the Gaussian curvature
//! K = −(R′ f′/2 + R″ f)/R finite and exact at the horizon.
//!
//! At a horizon r₊, f ~ (r − r₊), so dz/dr and the proper-distance integrand
//! blow up like (r − r₊)^(−1/2). The substitution r = r₊ + u² removes that:
//! dz/du = 2u √((1 − f R′²)/f) is finite. Integrals use composite 8-point
//! Gauss–Legendre in u, which never evaluates at the endpoints.
//!
//! The web app mirrors this file in `web/src/curvature/embedding.ts`.

/// A spatial slice dl² = dr²/f(r) + R(r)² dφ², with an inner edge at a horizon.
pub trait Slice {
    /// f = 1/g_rr: zero at the horizon, positive outside it.
    fn f(&self, r: f64) -> f64;
    /// df/dr.
    fn df(&self, r: f64) -> f64;
    /// Circumferential radius R(r).
    fn circ(&self, r: f64) -> f64;
    /// dR/dr.
    fn dcirc(&self, r: f64) -> f64;
    /// d²R/dr².
    fn d2circ(&self, r: f64) -> f64;
    /// The inner edge: the horizon radius r₊, where f = 0.
    fn horizon(&self) -> f64;
}

/// Schwarzschild (M = 1): f = 1 − 2/r, R = r. Its embedding is Flamm's paraboloid.
#[derive(Clone, Copy, Debug, Default)]
pub struct Schwarzschild;

impl Slice for Schwarzschild {
    fn f(&self, r: f64) -> f64 {
        1.0 - 2.0 / r
    }
    fn df(&self, r: f64) -> f64 {
        2.0 / (r * r)
    }
    fn circ(&self, r: f64) -> f64 {
        r
    }
    fn dcirc(&self, _r: f64) -> f64 {
        1.0
    }
    fn d2circ(&self, _r: f64) -> f64 {
        0.0
    }
    fn horizon(&self) -> f64 {
        2.0
    }
}

/// Flamm's paraboloid in closed form: z = √(8(r − 2)), height above the horizon.
pub fn flamm_height(r: f64) -> f64 {
    (8.0 * (r - 2.0)).sqrt()
}

/// Proper radial distance from the Schwarzschild horizon, in closed form:
/// √(r(r − 2)) + 2 ln(√(r/2) + √(r/2 − 1)).
pub fn flamm_distance(r: f64) -> f64 {
    (r * (r - 2.0)).sqrt() + 2.0 * ((r / 2.0).sqrt() + (r / 2.0 - 1.0).sqrt()).ln()
}

/// The embedding of a slice sampled at given radii.
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    /// Coordinate radius r of each sample (as given).
    pub r: Vec<f64>,
    /// Circumferential radius R: the distance from the axis in R³.
    pub circ: Vec<f64>,
    /// Height z above the horizon (z = 0 there), increasing outward.
    pub height: Vec<f64>,
    /// Proper radial distance from the horizon.
    pub distance: Vec<f64>,
    /// Gaussian curvature K (units 1/M²).
    pub curvature: Vec<f64>,
}

/// Why a slice can't be embedded.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EmbedError {
    /// The radii must be increasing and not inside the horizon.
    BadRadii,
    /// f R′² > 1 at this radius: circles grow faster than the distance between them.
    NotEmbeddable { r: f64 },
}

impl std::fmt::Display for EmbedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EmbedError::BadRadii => write!(f, "radii must be increasing and outside the horizon"),
            EmbedError::NotEmbeddable { r } => write!(f, "not embeddable in R³ at r = {r}"),
        }
    }
}

impl std::error::Error for EmbedError {}

/// Gauss–Legendre nodes and weights on [−1, 1], 8 points (positive half).
const GL_X: [f64; 4] = [
    0.183_434_642_495_649_8,
    0.525_532_409_916_329,
    0.796_666_477_413_626_7,
    0.960_289_856_497_536_3,
];
const GL_W: [f64; 4] = [
    0.362_683_783_378_362,
    0.313_706_645_877_887_3,
    0.222_381_034_453_374_5,
    0.101_228_536_290_376_3,
];

/// Largest sub-interval in u = √(r − r₊) for the composite rule.
pub const MAX_DU: f64 = 0.05;

/// Gaussian curvature of the slice at r: K = −(R′ f′/2 + R″ f)/R.
pub fn gaussian_curvature<S: Slice>(s: &S, r: f64) -> f64 {
    -(s.dcirc(r) * s.df(r) / 2.0 + s.d2circ(r) * s.f(r)) / s.circ(r)
}

/// dz/du and d(distance)/du at u, with r = r₊ + u².
fn integrands<S: Slice>(s: &S, u: f64) -> Result<(f64, f64), EmbedError> {
    let r = s.horizon() + u * u;
    let f = s.f(r);
    let dr = s.dcirc(r);
    let excess = 1.0 - f * dr * dr;
    if excess < 0.0 {
        return Err(EmbedError::NotEmbeddable { r });
    }
    let inv_sqrt_f = 1.0 / f.sqrt();
    Ok((2.0 * u * excess.sqrt() * inv_sqrt_f, 2.0 * u * inv_sqrt_f))
}

/// Samples the embedding at `radii` (increasing, each ≥ the horizon radius).
pub fn profile<S: Slice>(s: &S, radii: &[f64]) -> Result<Profile, EmbedError> {
    let rh = s.horizon();
    if radii.iter().any(|&r| r.is_nan() || r < rh) || radii.windows(2).any(|w| w[1] < w[0]) {
        return Err(EmbedError::BadRadii);
    }
    let mut height = Vec::with_capacity(radii.len());
    let mut distance = Vec::with_capacity(radii.len());
    let (mut z, mut d, mut u0) = (0.0, 0.0, 0.0);
    for &r in radii {
        let u1 = (r - rh).sqrt();
        // No sub-intervals for a repeated radius (or the horizon itself), where
        // the integrand at u = 0 would be 0 × ∞.
        let n = ((u1 - u0) / MAX_DU).ceil() as usize;
        let h = if n > 0 { (u1 - u0) / n as f64 } else { 0.0 };
        for k in 0..n {
            let mid = u0 + (k as f64 + 0.5) * h;
            for (x, w) in GL_X.iter().zip(GL_W) {
                for u in [mid - x * h / 2.0, mid + x * h / 2.0] {
                    let (dz, dd) = integrands(s, u)?;
                    z += w * h / 2.0 * dz;
                    d += w * h / 2.0 * dd;
                }
            }
        }
        u0 = u1;
        height.push(z);
        distance.push(d);
    }
    Ok(Profile {
        r: radii.to_vec(),
        circ: radii.iter().map(|&r| s.circ(r)).collect(),
        height,
        distance,
        curvature: radii.iter().map(|&r| gaussian_curvature(s, r)).collect(),
    })
}
