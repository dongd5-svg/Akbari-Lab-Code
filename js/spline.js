(function (AK) {
'use strict';

// spline.js — cubic spline interpolation matching MATLAB's spline().
//
// MATLAB uses the NOT-A-KNOT end condition: the third derivative is continuous
// across the second and second-to-last knots. This is NOT the same as a
// "natural" spline (second derivative zero at the ends), which is what most
// quick JavaScript implementations do — and using the wrong one shifts every
// interpolated value. That difference is the single most likely way a port of
// this pipeline silently disagrees with MATLAB, so it is implemented carefully
// here and checked against MATLAB output in test/.
//
// Also matches MATLAB's behaviour outside the data range: it EXTRAPOLATES using
// the end polynomials rather than returning NaN.

function splineNotAKnot(x, y) {
  const n = x.length;
  if (n !== y.length) throw new Error(`spline: x has ${n} points, y has ${y.length}`);
  if (n < 2) throw new Error('spline: need at least 2 points');

  // Two points -> straight line. Three points -> single parabola.
  if (n === 2) {
    const m = (y[1] - y[0]) / (x[1] - x[0]);
    return { x: Float64Array.from(x), a: Float64Array.from([y[0]]),
             b: Float64Array.from([m]), c: new Float64Array(1), d: new Float64Array(1) };
  }

  const h = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = x[i + 1] - x[i];
    if (h[i] <= 0) throw new Error('spline: x must be strictly increasing');
  }

  // Solve for second derivatives (sigma) with not-a-knot end conditions.
  // Tridiagonal system, solved by Thomas algorithm with the two end rows
  // folded in.
  const A = new Float64Array(n);   // sub
  const B = new Float64Array(n);   // diag
  const C = new Float64Array(n);   // super
  const D = new Float64Array(n);   // rhs

  for (let i = 1; i < n - 1; i++) {
    A[i] = h[i - 1];
    B[i] = 2 * (h[i - 1] + h[i]);
    C[i] = h[i];
    D[i] = 6 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]);
  }

  if (n === 3) {
    // Not-a-knot with 3 points degenerates to a single quadratic through all
    // three, i.e. constant second derivative.
    const s = D[1] / (B[1] + h[0] + h[1]);
    const sig = new Float64Array([s, s, s]);
    return buildPieces(x, y, h, sig);
  }

  // Not-a-knot: sigma[0] is a linear extrapolation of sigma[1], sigma[2];
  // same at the far end. Substituting removes them from the system.
  B[1] += h[0] * (h[0] + h[1]) / h[1];
  C[1] -= h[0] * h[0] / h[1];

  B[n - 2] += h[n - 2] * (h[n - 2] + h[n - 3]) / h[n - 3];
  A[n - 2] -= h[n - 2] * h[n - 2] / h[n - 3];

  // Thomas algorithm over rows 1..n-2
  const cp = new Float64Array(n);
  const dp = new Float64Array(n);
  cp[1] = C[1] / B[1];
  dp[1] = D[1] / B[1];
  for (let i = 2; i <= n - 2; i++) {
    const m = B[i] - A[i] * cp[i - 1];
    cp[i] = C[i] / m;
    dp[i] = (D[i] - A[i] * dp[i - 1]) / m;
  }

  const sig = new Float64Array(n);
  sig[n - 2] = dp[n - 2];
  for (let i = n - 3; i >= 1; i--) sig[i] = dp[i] - cp[i] * sig[i + 1];

  // Recover the two end second-derivatives from the not-a-knot condition.
  sig[0]     = ((h[0] + h[1]) * sig[1] - h[0] * sig[2]) / h[1];
  sig[n - 1] = ((h[n - 2] + h[n - 3]) * sig[n - 2] - h[n - 2] * sig[n - 3]) / h[n - 3];

  return buildPieces(x, y, h, sig);
}

function buildPieces(x, y, h, sig) {
  const n = x.length;
  const a = new Float64Array(n - 1);
  const b = new Float64Array(n - 1);
  const c = new Float64Array(n - 1);
  const d = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    a[i] = y[i];
    b[i] = (y[i + 1] - y[i]) / h[i] - h[i] * (2 * sig[i] + sig[i + 1]) / 6;
    c[i] = sig[i] / 2;
    d[i] = (sig[i + 1] - sig[i]) / (6 * h[i]);
  }
  return { x: Float64Array.from(x), a, b, c, d };
}

// Evaluate a fitted spline at query points. Extrapolates past both ends using
// the end polynomials, as MATLAB does.
function splineEval(pp, xq) {
  const { x, a, b, c, d } = pp;
  const nSeg = a.length;
  const out = new Float64Array(xq.length);

  let seg = 0;
  const ascending = xq.length < 2 || xq[xq.length - 1] >= xq[0];

  for (let k = 0; k < xq.length; k++) {
    const q = xq[k];
    if (ascending) {
      // queries usually arrive sorted, so walk forward instead of binary searching
      while (seg < nSeg - 1 && q >= x[seg + 1]) seg++;
      while (seg > 0 && q < x[seg]) seg--;
    } else {
      seg = findSegment(x, q, nSeg);
    }
    const dx = q - x[seg];
    out[k] = a[seg] + dx * (b[seg] + dx * (c[seg] + dx * d[seg]));
  }
  return out;
}

function findSegment(x, q, nSeg) {
  let lo = 0, hi = nSeg - 1;
  if (q <= x[0]) return 0;
  if (q >= x[nSeg]) return nSeg - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (x[mid] <= q) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Convenience: fit and evaluate in one call, like MATLAB's spline(x,y,xq).
function spline(x, y, xq) {
  return splineEval(splineNotAKnot(x, y), xq);
}

AK.spline = spline;
AK.splineNotAKnot = splineNotAKnot;
AK.splineEval = splineEval;
})(window.AK = window.AK || {});
