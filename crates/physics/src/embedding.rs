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
//! Integrals run from the slice's inner edge r_in (a horizon, or the center of
//! a star) in u = √(r − r_in). At a horizon f ~ (r − r₊), so dz/dr and the
//! proper-distance integrand blow up like (r − r₊)^(−1/2); in u,
//! dz/du = 2u √((1 − f R′²)/f) is finite. At a center the substitution is
//! harmless. Integrals use composite 8-point Gauss–Legendre in u, which never
//! evaluates at the endpoints, and split at the slice's breaks (a star's
//! surface, where f′ jumps), so the rule only ever sees smooth integrands.
//!
//! The web app mirrors this file in `web/src/curvature/embedding.ts`.

/// A spatial slice dl² = dr²/f(r) + R(r)² dφ², from an inner edge outward.
pub trait Slice {
    /// f = 1/g_rr: positive outside the inner edge (zero there at a horizon).
    fn f(&self, r: f64) -> f64;
    /// df/dr.
    fn df(&self, r: f64) -> f64;
    /// Circumferential radius R(r).
    fn circ(&self, r: f64) -> f64;
    /// dR/dr.
    fn dcirc(&self, r: f64) -> f64;
    /// d²R/dr².
    fn d2circ(&self, r: f64) -> f64;
    /// The inner edge r_in: a horizon (f = 0) or a center (R = 0).
    fn inner(&self) -> f64;
    /// Radii outside the inner edge where f′ jumps; integrals split there.
    fn breaks(&self) -> Vec<f64> {
        Vec::new()
    }
    /// Gaussian curvature at r. The default is the metric formula, which is
    /// 0/0 at a center; slices with a center override it.
    fn curvature(&self, r: f64) -> f64 {
        gaussian_curvature(self, r)
    }
}

/// Schwarzschild (M = 1): f = 1 − 2/r, R = r, inner edge at the horizon r = 2.
/// Its embedding is Flamm's paraboloid. The Einstein–Rosen bridge is this
/// sheet joined to its mirror image at the horizon (see [`flamm_meridian`]).
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
    fn inner(&self) -> f64 {
        2.0
    }
}

/// A star of uniform density and radius r_s > 2 (M = 1): inside,
/// f = 1 − 2r²/r_s³ (the interior Schwarzschild solution's spatial metric);
/// outside, Schwarzschild. R = r, inner edge at the center.
#[derive(Clone, Copy, Debug)]
pub struct Star {
    radius: f64,
}

impl Star {
    /// Buchdahl's limit: no static star of this mass is smaller (r_s ≥ 9/4 M).
    pub const BUCHDAHL: f64 = 2.25;

    /// A star of radius r_s; `None` unless r_s > 2 (outside its own horizon).
    pub fn new(radius: f64) -> Option<Star> {
        (radius > 2.0).then_some(Star { radius })
    }

    pub fn radius(&self) -> f64 {
        self.radius
    }
}

impl Slice for Star {
    fn f(&self, r: f64) -> f64 {
        if r <= self.radius {
            1.0 - 2.0 * r * r / self.radius.powi(3)
        } else {
            1.0 - 2.0 / r
        }
    }
    fn df(&self, r: f64) -> f64 {
        if r <= self.radius {
            -4.0 * r / self.radius.powi(3)
        } else {
            2.0 / (r * r)
        }
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
    fn inner(&self) -> f64 {
        0.0
    }
    fn breaks(&self) -> Vec<f64> {
        vec![self.radius]
    }
    /// +2/r_s³ inside (the surface counts as inside), −1/r³ outside.
    fn curvature(&self, r: f64) -> f64 {
        if r <= self.radius {
            2.0 / self.radius.powi(3)
        } else {
            -1.0 / (r * r * r)
        }
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

/// Flamm's paraboloid as a meridian ρ(z) = 2 + z²/8, for z of either sign: the
/// Einstein–Rosen bridge, both exterior sheets joined smoothly at the throat.
pub fn flamm_meridian(z: f64) -> f64 {
    2.0 + z * z / 8.0
}

/// The uniform-density star's embedding height above its center, in closed
/// form: inside, a spherical cap of radius a = √(r_s³/2), z = a − √(a² − r²);
/// outside, Flamm's paraboloid continued from the surface.
pub fn star_height(rs: f64, r: f64) -> f64 {
    let a2 = rs.powi(3) / 2.0;
    let cap = |r: f64| a2.sqrt() - (a2 - r * r).sqrt();
    if r <= rs {
        cap(r)
    } else {
        cap(rs) + flamm_height(r) - flamm_height(rs)
    }
}

/// Proper radial distance from the star's center, in closed form: a arcsin(r/a)
/// inside, then Flamm's distance continued from the surface.
pub fn star_distance(rs: f64, r: f64) -> f64 {
    let a = (rs.powi(3) / 2.0).sqrt();
    if r <= rs {
        a * (r / a).asin()
    } else {
        a * (rs / a).asin() + flamm_distance(r) - flamm_distance(rs)
    }
}

/// The embedding of a slice sampled at given radii.
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    /// Coordinate radius r of each sample (as given).
    pub r: Vec<f64>,
    /// Circumferential radius R: the distance from the axis in R³.
    pub circ: Vec<f64>,
    /// Height z above the inner edge (z = 0 there), increasing outward.
    pub height: Vec<f64>,
    /// Proper radial distance from the inner edge.
    pub distance: Vec<f64>,
    /// Gaussian curvature K (units 1/M²).
    pub curvature: Vec<f64>,
}

/// Why a slice can't be embedded.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EmbedError {
    /// The radii must be increasing and not inside the inner edge.
    BadRadii,
    /// f R′² > 1 at this radius: circles grow faster than the distance between them.
    NotEmbeddable { r: f64 },
}

impl std::fmt::Display for EmbedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EmbedError::BadRadii => {
                write!(f, "radii must be increasing and outside the inner edge")
            }
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

/// Largest sub-interval in u = √(r − r_in) for the composite rule.
pub const MAX_DU: f64 = 0.05;

/// Gaussian curvature from the metric: K = −(R′ f′/2 + R″ f)/R.
pub fn gaussian_curvature<S: Slice + ?Sized>(s: &S, r: f64) -> f64 {
    -(s.dcirc(r) * s.df(r) / 2.0 + s.d2circ(r) * s.f(r)) / s.circ(r)
}

/// dz/du and d(distance)/du at u, with r = r_in + u².
fn integrands<S: Slice>(s: &S, u: f64) -> Result<(f64, f64), EmbedError> {
    let r = s.inner() + u * u;
    let f = s.f(r);
    let dr = s.dcirc(r);
    let excess = 1.0 - f * dr * dr;
    if excess < 0.0 {
        return Err(EmbedError::NotEmbeddable { r });
    }
    let inv_sqrt_f = 1.0 / f.sqrt();
    Ok((2.0 * u * excess.sqrt() * inv_sqrt_f, 2.0 * u * inv_sqrt_f))
}

/// Adds ∫ dz and ∫ d(distance) over [ua, ub] in u to `z` and `d`.
fn integrate<S: Slice>(
    s: &S,
    ua: f64,
    ub: f64,
    z: &mut f64,
    d: &mut f64,
) -> Result<(), EmbedError> {
    // No sub-intervals for an empty range (a repeated radius, or the inner
    // edge itself, where the integrand at u = 0 can be 0 × ∞).
    let n = ((ub - ua) / MAX_DU).ceil() as usize;
    let h = if n > 0 { (ub - ua) / n as f64 } else { 0.0 };
    for k in 0..n {
        let mid = ua + (k as f64 + 0.5) * h;
        for (x, w) in GL_X.iter().zip(GL_W) {
            for u in [mid - x * h / 2.0, mid + x * h / 2.0] {
                let (dz, dd) = integrands(s, u)?;
                *z += w * h / 2.0 * dz;
                *d += w * h / 2.0 * dd;
            }
        }
    }
    Ok(())
}

/// Samples the embedding at `radii` (increasing, each ≥ the inner edge).
pub fn profile<S: Slice>(s: &S, radii: &[f64]) -> Result<Profile, EmbedError> {
    let r_in = s.inner();
    if radii.iter().any(|&r| r.is_nan() || r < r_in) || radii.windows(2).any(|w| w[1] < w[0]) {
        return Err(EmbedError::BadRadii);
    }
    let breaks: Vec<f64> = s.breaks().iter().map(|&b| (b - r_in).sqrt()).collect();
    let mut height = Vec::with_capacity(radii.len());
    let mut distance = Vec::with_capacity(radii.len());
    let (mut z, mut d, mut u0) = (0.0, 0.0, 0.0);
    for &r in radii {
        let u1 = (r - r_in).sqrt();
        let mut ua = u0;
        for &ub in breaks.iter().filter(|&&b| b > u0 && b < u1) {
            integrate(s, ua, ub, &mut z, &mut d)?;
            ua = ub;
        }
        integrate(s, ua, u1, &mut z, &mut d)?;
        u0 = u1;
        height.push(z);
        distance.push(d);
    }
    Ok(Profile {
        r: radii.to_vec(),
        circ: radii.iter().map(|&r| s.circ(r)).collect(),
        height,
        distance,
        curvature: radii.iter().map(|&r| s.curvature(r)).collect(),
    })
}
