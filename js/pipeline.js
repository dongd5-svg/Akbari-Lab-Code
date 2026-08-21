// pipeline.js — CMRO2 analysis, ported from the verified MATLAB implementation.
//
// Arithmetic is written in the SAME ORDER as the MATLAB source, not simplified.
// Reordering floating-point operations changes results in the last bits, and
// because the Db fit picks from a discrete grid, a last-bit difference can flip
// a whole sample to the neighbouring grid value. test/ checks every output of
// this file against MATLAB reference values.

import { spline } from './spline.js';

export const DEFAULTS = {
  n: 1.4,
  lambda: 809,
  fx0: 0,
  fx1: 0.3,
  Po: 1,
  beta: 1,
  Texposure: 1e-2,
  nTau: 10,
  dbMin: 1e-6,
  dbStep: 2.5e-6,
  dbMax: 3e-4,
  costMax: 1000,
  sfiScale: 0.01,
  cbfHighThreshold: 40000,
  cbfLowThreshold: -950,
  resampleRate: 100,
  baselineWin: 0.5,
};

// Haemoglobin absorption at 809 nm, per uM per mm.
// Prahl tabulated molar extinction x ln(10), interpolated to 1 nm.
// These are the exact values MATLAB's hbSpectra() returns at index 560.
export const E_HBO2_809 = 1980.6836969935;
export const E_HB_809   = 1658.3230363516;

// ---------------------------------------------------------------------------
// Replace flagged samples with the last preceding good value.
// A run of consecutive bad samples all collapse to the last good value before
// the run -- this is a forward fill, not a shift.
export function forwardFillOutliers(x, isBad) {
  const n = x.length;
  const out = Float64Array.from(x);
  let nReplaced = 0;
  for (let i = 0; i < n; i++) if (isBad[i]) nReplaced++;
  if (nReplaced === 0 || nReplaced === n) return { x: out, n: nReplaced };

  let lastGood = -1;
  for (let i = 0; i < n; i++) {
    if (!isBad[i]) { lastGood = i; continue; }
    if (lastGood >= 0) out[i] = out[lastGood];
  }
  // A leading run of bad samples has no preceding good value; back-fill it.
  if (isBad[0]) {
    let firstGood = 0;
    while (firstGood < n && isBad[firstGood]) firstGood++;
    for (let i = 0; i < firstGood; i++) out[i] = out[firstGood];
  }
  return { x: out, n: nReplaced };
}

// ---------------------------------------------------------------------------
// MATLAB's  base:step:limit  for the cases used here.
function colon(base, step, limit) {
  const n = Math.floor((limit - base) / step + 1e-10) + 1;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = base + i * step;
  return v;
}

function mean(a, i0, i1) {
  let s = 0;
  for (let i = i0; i <= i1; i++) s += a[i];
  return s / (i1 - i0 + 1);
}

// ---------------------------------------------------------------------------
// Clean, resample and baseline-normalise an LSI blood-flow trace.
export function prepareCBF(time, sfi, eventTime, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const N = time.length;
  if (sfi.length !== N) throw new Error(`time has ${N} samples but flow has ${sfi.length}`);

  // Trim to the sample nearest t = 0.
  let iStart = 0, best = Infinity;
  for (let i = 0; i < N; i++) {
    const a = Math.abs(time[i]);
    if (a < best) { best = a; iStart = i; }
  }
  const m = N - iStart;
  const CBFraw = new Float64Array(m);
  const CBFrawtime = new Float64Array(m);
  const t0 = time[iStart];
  for (let i = 0; i < m; i++) {
    CBFraw[i] = sfi[iStart + i];
    CBFrawtime[i] = time[iStart + i] - t0;
  }

  // Remove artifacts: high pass then low pass, forward-filling each.
  const badHi = new Uint8Array(m);
  for (let i = 0; i < m; i++) badHi[i] = Math.abs(CBFraw[i]) > o.cbfHighThreshold ? 1 : 0;
  const r1 = forwardFillOutliers(CBFraw, badHi);
  const badLo = new Uint8Array(m);
  for (let i = 0; i < m; i++) badLo[i] = r1.x[i] < o.cbfLowThreshold ? 1 : 0;
  const r2 = forwardFillOutliers(r1.x, badLo);
  const work = r2.x;
  const nDespiked = r1.n + r2.n;

  const tEnd = CBFrawtime[m - 1];
  if (!(tEnd > 0)) throw new Error(`Recording spans ${tEnd} min; cannot resample.`);

  const CBFtime = colon(0, 1 / o.resampleRate, tEnd);
  const CBFspline = spline(CBFrawtime, work, CBFtime);

  // Baseline window, 1-based in MATLAB -> 0-based here.
  let iLo = Math.round((eventTime - o.baselineWin) * o.resampleRate) + 1;
  let iHi = Math.round(eventTime * o.resampleRate) + 1;
  iLo = Math.max(iLo, 1);
  iHi = Math.min(Math.max(iHi, iLo), CBFspline.length);
  let shortBaseline = false;
  if (iHi <= iLo) {
    shortBaseline = true;
    iLo = 1;
    iHi = Math.min(Math.round(o.baselineWin * o.resampleRate) + 1, CBFspline.length);
  }
  const baseline = mean(CBFspline, iLo - 1, iHi - 1);
  if (!isFinite(baseline) || baseline === 0) {
    throw new Error(`Baseline evaluated to ${baseline}; cannot normalise.`);
  }

  const rCBF = new Float64Array(CBFspline.length);
  for (let i = 0; i < rCBF.length; i++) rCBF[i] = CBFspline[i] / baseline;

  return { CBFraw, CBFrawtime, CBFtime, CBFspline, rCBF,
           baseline, baselineIdx: [iLo, iHi], nDespiked, shortBaseline };
}

// ---------------------------------------------------------------------------
// Fit the Brownian diffusion coefficient from speckle contrast.
// Grid search; ties resolve to the smallest Db, matching MATLAB's strict
// `if cost < cost_min`.
export function fitDb(Kexp, musp, cthbo2, cthbr, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const N = Kexp.length;

  const ko   = 2 * Math.PI * o.n / (o.lambda * 1e-6);
  const kx   = 2 * Math.PI * o.fx0;
  const kx1  = 2 * Math.PI * o.fx1;
  const Reff = 0.0636 * o.n + 0.668 + (0.71 / o.n) - (1.44 / (o.n * o.n));
  const A    = (1 - Reff) / (2 * (1 + Reff));

  const Tstep = o.Texposure / o.nTau;
  const tau = new Float64Array(o.nTau);
  for (let i = 0; i < o.nTau; i++) tau[i] = Tstep * (i + 1);

  const grid = colon(o.dbMin, o.dbStep, o.dbMax);
  const nDb = grid.length;
  const c1 = Tstep * (2 / o.Texposure) * o.beta;

  const Db = new Float64Array(N);
  const Kmodel = new Float64Array(N);
  const deltaFx0 = new Float64Array(N);
  const deltaFx1 = new Float64Array(N);
  const residual = new Float64Array(N);
  const atEdge = [];
  const unconverged = [];

  for (let j = 0; j < N; j++) {
    const muspj = musp[j];
    const hbr = cthbr[j] < 0 ? 0 : cthbr[j];          // legacy clamp
    const mua = 1e-7 * (cthbo2[j] * E_HBO2_809 + hbr * E_HB_809);
    const mu_tr = mua + muspj;

    const me0 = Math.sqrt(3 * mua * mu_tr);
    const mep0 = Math.sqrt(me0 * me0 + kx * kx);
    const mep0f1 = Math.sqrt(me0 * me0 + kx1 * kx1);
    deltaFx0[j] = 1 / mep0;
    deltaFx1[j] = 1 / mep0f1;

    const r0 = mep0 / mu_tr;
    const G1tau0 = 3 * o.Po * A * (muspj / mu_tr) / ((r0 + 1) * (r0 + 3 * A));
    const G1tau0sq = G1tau0 * G1tau0;

    const coef = (1 / 3) * muspj * (ko * ko);
    const num  = 3 * o.Po * A * (muspj / mu_tr);

    let costMin = o.costMax;
    let bestIx = -1, bestK = 0;

    for (let g = 0; g < nDb; g++) {
      const DbG = grid[g];
      let Ksq = 0;
      for (let s = 0; s < o.nTau; s++) {
        const meanr2 = 6 * DbG * tau[s];
        const mua_dyn = mua + coef * meanr2;
        const me = Math.sqrt(3 * mua_dyn * mu_tr);
        const mep = Math.sqrt(me * me + kx * kx);
        const r = mep / mu_tr;
        const G1 = num / ((r + 1) * (r + 3 * A));
        Ksq += (c1 * (G1 * G1)) * (1 - (tau[s] / o.Texposure)) / G1tau0sq;
      }
      const K = Math.sqrt(Ksq);
      const diff = K - Kexp[j];
      const cost = diff * diff;
      if (cost < costMin) { costMin = cost; bestIx = g; bestK = K; }
    }

    if (bestIx >= 0) { Db[j] = grid[bestIx]; Kmodel[j] = bestK; }
    else unconverged.push(j);            // legacy left Db = 0 here
    residual[j] = costMin;
    if (bestIx === 0 || bestIx === nDb - 1) atEdge.push(j);
  }

  return { Db, Kmodel, deltaFx0, deltaFx1, residual,
           info: { grid, nDb, unconverged, atEdge } };
}

// ---------------------------------------------------------------------------
function matchLength(v, n) {
  const out = new Float64Array(n);
  const m = v.length;
  for (let i = 0; i < n; i++) out[i] = i < m ? v[i] : v[m - 1];
  return out;
}

// ---------------------------------------------------------------------------
// Full analysis for one animal. `sfdi` may be null -> flow-only result.
export function analyze(lsi, sfdi, eventTime, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const cbf = prepareCBF(lsi.time, lsi.sfi, eventTime, o);

  const R = {
    hasSFDI: false,
    time: cbf.CBFtime,
    CBFraw: cbf.CBFraw,
    CBFrawtime: cbf.CBFrawtime,
    CBFtime: cbf.CBFtime,
    CBFspline: cbf.CBFspline,
    rCBF: cbf.rCBF,
    baseline: cbf.baseline,
    baselineIdx: cbf.baselineIdx,
    nDespiked: cbf.nDespiked,
    shortBaseline: cbf.shortBaseline,
    eventTime,
  };
  if (!sfdi) return R;

  const nM = sfdi.MetabolismTime.length;
  const cthb    = Float64Array.from(sfdi.hbr,   v => v * 1000);
  const cthbo2  = Float64Array.from(sfdi.hbo2,  v => v * 1000);
  const cthbtot = Float64Array.from(sfdi.hbtot, v => v * 1000);
  const musp    = Float64Array.from(sfdi.scatter730);

  for (const [nm, arr] of [['hbr',cthb],['hbo2',cthbo2],['hbtot',cthbtot],['scatter730',musp]]) {
    if (arr.length !== nM) {
      throw new Error(`sfdi.${nm} has ${arr.length} samples but MetabolismTime has ${nM}`);
    }
  }

  const CBF  = matchLength(cbf.CBFspline, nM);
  const rCBF = matchLength(cbf.rCBF, nM);

  const Kexp = new Float64Array(nM);
  for (let i = 0; i < nM; i++) Kexp[i] = 1 / (o.sfiScale * CBF[i]);

  const fit = fitDb(Kexp, musp, cthbo2, cthb, o);

  const aCMRO2 = new Float64Array(nM);
  for (let i = 0; i < nM; i++) {
    const hb = cthb[i] < 0 ? 0 : cthb[i];
    aCMRO2[i] = 60 * fit.Db[i] * hb * (fit.deltaFx1[i] * fit.deltaFx1[i]);
  }

  // Baseline indices on the SFDI grid.
  let i1 = Math.round((eventTime - o.baselineWin) * o.resampleRate) + 1;
  let i2 = Math.round(eventTime * o.resampleRate) + 1;
  i1 = Math.max(i1, 1);
  i2 = Math.min(Math.max(i2, i1), nM);
  if (i2 <= i1) { i1 = 1; i2 = Math.min(Math.round(o.baselineWin * o.resampleRate) + 1, nM); }

  const hbBase  = mean(cthb, i1 - 1, i2 - 1);
  const hbtBase = mean(cthbtot, i1 - 1, i2 - 1);

  const rCTHB = new Float64Array(nM), rCTHBTOT = new Float64Array(nM);
  for (let i = 0; i < nM; i++) {
    let v = cthb[i] / hbBase;
    rCTHB[i] = v < 0 ? 0 : v;
    rCTHBTOT[i] = cthbtot[i] / hbtBase;
  }

  const cmRel = new Float64Array(nM);
  for (let i = 0; i < nM; i++) {
    cmRel[i] = (1 + rCBF[i]) * (1 + rCTHB[i]) * Math.pow(1 + rCTHBTOT[i], -1) - 1;
  }
  const cmBase = mean(cmRel, i1 - 1, i2 - 1);
  if (!isFinite(cmBase) || cmBase === 0) {
    throw new Error(`Relative CMRO2 baseline evaluated to ${cmBase}`);
  }

  const rCMRO2 = new Float64Array(nM), rRatio = new Float64Array(nM);
  for (let i = 0; i < nM; i++) {
    rCMRO2[i] = cmRel[i] / cmBase;
    rRatio[i] = rCBF[i] / rCMRO2[i];
  }

  Object.assign(R, {
    hasSFDI: true,
    time: sfdi.MetabolismTime,
    MetabolismTime: sfdi.MetabolismTime,
    Kexp, Db: fit.Db, deltaFx1: fit.deltaFx1,
    aCBF: fit.Db, aCMRO2,
    rCBF, rCMRO2, rRatio, rCTHB, rCTHBTOT,
    cthb, cthbo2, cthbtot, scatter730: musp,
    baselineIdx: [i1, i2],
    fitInfo: fit.info,
  });
  return R;
}
