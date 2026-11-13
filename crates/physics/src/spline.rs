//! Natural cubic spline interpolation on a non-uniform grid.
//!
//! Matches the boundary conditions used by gwsurrogate's C spline wrapper
//! (second derivative zero at both ends), so interpolating the surrogate's
//! sparse time samples reproduces the reference implementation.

/// A natural cubic spline through `(x[i], y[i])`, with `x` strictly increasing.
#[derive(Debug, Clone)]
pub struct NaturalCubicSpline {
    x: Vec<f64>,
    y: Vec<f64>,
    /// Second derivatives at the knots.
    m: Vec<f64>,
}

impl NaturalCubicSpline {
    /// Builds the spline. Panics if lengths differ, there are fewer than two
    /// points, or `x` is not strictly increasing.
    pub fn new(x: &[f64], y: &[f64]) -> Self {
        let n = x.len();
        assert_eq!(n, y.len(), "x and y must have the same length");
        assert!(n >= 2, "need at least two points");
        assert!(
            x.windows(2).all(|w| w[1] > w[0]),
            "x must be strictly increasing"
        );

        let mut m = vec![0.0; n];
        if n > 2 {
            // Tridiagonal system for interior second derivatives (Thomas algorithm).
            let k = n - 2;
            let mut diag = vec![0.0; k];
            let mut rhs = vec![0.0; k];
            let mut upper = vec![0.0; k];
            for i in 0..k {
                let h0 = x[i + 1] - x[i];
                let h1 = x[i + 2] - x[i + 1];
                diag[i] = 2.0 * (h0 + h1);
                upper[i] = h1;
                rhs[i] = 6.0 * ((y[i + 2] - y[i + 1]) / h1 - (y[i + 1] - y[i]) / h0);
            }
            for i in 1..k {
                let lower = x[i + 1] - x[i]; // h_i, sub-diagonal of row i
                let w = lower / diag[i - 1];
                diag[i] -= w * upper[i - 1];
                rhs[i] -= w * rhs[i - 1];
            }
            m[k] = rhs[k - 1] / diag[k - 1];
            for i in (0..k - 1).rev() {
                m[i + 1] = (rhs[i] - upper[i] * m[i + 2]) / diag[i];
            }
        }
        Self {
            x: x.to_vec(),
            y: y.to_vec(),
            m,
        }
    }

    /// Lower bound of the interpolation domain.
    pub fn x_min(&self) -> f64 {
        self.x[0]
    }

    /// Upper bound of the interpolation domain.
    pub fn x_max(&self) -> f64 {
        self.x[self.x.len() - 1]
    }

    fn eval_in_interval(&self, i: usize, t: f64) -> f64 {
        let h = self.x[i + 1] - self.x[i];
        let a = (self.x[i + 1] - t) / h;
        let b = (t - self.x[i]) / h;
        a * self.y[i]
            + b * self.y[i + 1]
            + ((a * a * a - a) * self.m[i] + (b * b * b - b) * self.m[i + 1]) * h * h / 6.0
    }

    fn interval(&self, t: f64) -> usize {
        // Index i with x[i] <= t < x[i+1], clamped to valid intervals.
        let n = self.x.len();
        match self.x.partition_point(|&xi| xi <= t) {
            0 => 0,
            p if p >= n => n - 2,
            p => p - 1,
        }
    }

    /// Evaluates at a single point. Points outside the domain are extrapolated
    /// with the end cubic; callers are expected to stay inside it.
    pub fn eval(&self, t: f64) -> f64 {
        self.eval_in_interval(self.interval(t), t)
    }

    /// Evaluates at many points in increasing order, in one linear pass.
    pub fn eval_sorted(&self, ts: &[f64]) -> Vec<f64> {
        let mut out = Vec::with_capacity(ts.len());
        let mut i = ts.first().map_or(0, |&t| self.interval(t));
        let last = self.x.len() - 2;
        for &t in ts {
            while i < last && t >= self.x[i + 1] {
                i += 1;
            }
            out.push(self.eval_in_interval(i, t));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_through_knots() {
        let x = [0.0, 0.5, 1.7, 2.0, 3.5];
        let y = [1.0, -2.0, 0.3, 4.0, 2.5];
        let s = NaturalCubicSpline::new(&x, &y);
        for (xi, yi) in x.iter().zip(y) {
            assert!((s.eval(*xi) - yi).abs() < 1e-12);
        }
    }

    #[test]
    fn reproduces_straight_lines_exactly() {
        let x = [0.0, 0.3, 1.1, 2.0, 5.0];
        let y: Vec<f64> = x.iter().map(|t| 3.0 * t - 1.0).collect();
        let s = NaturalCubicSpline::new(&x, &y);
        for t in [0.1, 0.9, 2.7, 4.99] {
            assert!((s.eval(t) - (3.0 * t - 1.0)).abs() < 1e-12);
        }
    }

    #[test]
    fn accurate_for_smooth_function_on_nonuniform_grid() {
        let x: Vec<f64> = (0..200)
            .map(|i| (i as f64 / 199.0).powf(1.5) * 10.0)
            .collect();
        let y: Vec<f64> = x.iter().map(|t| t.sin()).collect();
        let s = NaturalCubicSpline::new(&x, &y);
        let ts: Vec<f64> = (0..1000).map(|i| 1.0 + 8.0 * i as f64 / 999.0).collect();
        let vals = s.eval_sorted(&ts);
        let max_err = ts
            .iter()
            .zip(&vals)
            .map(|(t, v)| (t.sin() - v).abs())
            .fold(0.0, f64::max);
        assert!(max_err < 1e-5, "max error {max_err}");
    }

    #[test]
    fn sorted_and_single_evaluation_agree() {
        let x = [0.0, 1.0, 2.5, 3.0, 4.0, 6.0];
        let y = [0.0, 1.0, -1.0, 0.5, 2.0, 0.0];
        let s = NaturalCubicSpline::new(&x, &y);
        let ts = [0.0, 0.2, 1.0, 2.9, 3.0, 5.5, 6.0];
        let batch = s.eval_sorted(&ts);
        for (t, b) in ts.iter().zip(batch) {
            assert!((s.eval(*t) - b).abs() < 1e-14);
        }
    }
}
