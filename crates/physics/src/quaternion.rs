//! Minimal unit-quaternion helpers for frame rotations.
//!
//! Quaternions are `[w, x, y, z]`. A frame given by quaternion `q` maps a
//! vector's components in that frame to the reference frame as
//! v_ref = q v q⁻¹ (the convention of gwsurrogate's precessing models).

/// `[w, x, y, z]`.
pub type Quat = [f64; 4];

pub const IDENTITY: Quat = [1.0, 0.0, 0.0, 0.0];

/// Hamilton product a·b.
pub fn mul(a: Quat, b: Quat) -> Quat {
    [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ]
}

/// Inverse (conjugate divided by the squared norm).
pub fn inv(q: Quat) -> Quat {
    let n2 = norm_sqr(q);
    [q[0] / n2, -q[1] / n2, -q[2] / n2, -q[3] / n2]
}

pub fn norm_sqr(q: Quat) -> f64 {
    q.iter().map(|c| c * c).sum()
}

pub fn normalize(q: Quat) -> Quat {
    let n = norm_sqr(q).sqrt();
    q.map(|c| c / n)
}

/// Rotation by `angle` about +z.
pub fn about_z(angle: f64) -> Quat {
    let (s, c) = (0.5 * angle).sin_cos();
    [c, 0.0, 0.0, s]
}

/// q v q⁻¹.
pub fn rotate(q: Quat, v: [f64; 3]) -> [f64; 3] {
    let r = mul(q, mul([0.0, v[0], v[1], v[2]], inv(q)));
    [r[1], r[2], r[3]]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_z_turns_x_into_y() {
        let v = rotate(about_z(std::f64::consts::FRAC_PI_2), [1.0, 0.0, 0.0]);
        assert!((v[0]).abs() < 1e-15 && (v[1] - 1.0).abs() < 1e-15 && v[2].abs() < 1e-15);
    }

    #[test]
    fn inverse_undoes_rotation() {
        let q = normalize([0.9, 0.2, -0.3, 0.25]);
        let v = [0.3, -1.2, 0.7];
        let back = rotate(inv(q), rotate(q, v));
        for k in 0..3 {
            assert!((back[k] - v[k]).abs() < 1e-14);
        }
    }
}
