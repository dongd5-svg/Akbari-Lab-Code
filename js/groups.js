(function (AK) {
'use strict';

const METRICS = [
  { key: 'rCBF',   label: 'Relative CBF',    yLabel: 'rCBF',                              need: () => true },
  { key: 'rCMRO2', label: 'Relative CMRO2',  yLabel: 'rCMRO_2',                           need: (R) => R.hasSFDI },
  { key: 'rRatio', label: 'rCBF / rCMRO2',   yLabel: 'rCBF / rCMRO_2',                    need: (R) => R.hasSFDI },
  { key: 'aCBF',   label: 'Absolute CBF',    yLabel: 'D_b (mm^2 s^{-1})',                 need: (R) => R.hasSFDI },
  { key: 'aCMRO2', label: 'Absolute CMRO2',  yLabel: 'CMRO_2 (µmol min^{-1})',       need: (R) => R.hasSFDI },
];

const STOP = new Set(['baseline', 'lsi', 'sfdi', 'roi', 'data', 'mat', 'mouse', 'rat',
                      'animal', 'subject', 'processed', 'analysis', 'results', 'copy',
                      'final', 'raw', 'file', 'files', 'run', 'trial', 'sample']);

function guessGroups(files) {
  const byAnimal = new Map();
  for (const f of files) {
    if (!f.animal || f.kind === 'unknown') continue;
    if (!byAnimal.has(f.animal)) byAnimal.set(f.animal, []);
    byAnimal.get(f.animal).push(f.name);
  }

  const guess = new Map();
  for (const [animal, names] of byAnimal) {
    for (const name of names) {
      const tok = tokensOf(name, animal);
      if (tok.length) { guess.set(animal, tok[0]); break; }
    }
  }

  const counts = new Map();
  for (const g of guess.values()) counts.set(g, (counts.get(g) || 0) + 1);
  const splits = counts.size >= 2 && [...counts.values()].some((c) => c >= 2);
  if (!splits) return {};

  const out = {};
  for (const [animal, g] of guess) out[animal] = g;
  return out;
}

function tokensOf(fileName, animal) {
  const stem = fileName.replace(/\.mat$/i, '');
  const flat = animal.toLowerCase();
  return stem
    .split(/[\s_\-.()]+/)
    .filter((t) => {
      const l = t.toLowerCase();
      if (!t || STOP.has(l)) return false;
      if (/^\d+$/.test(t)) return false;
      if (/^(day|d)\d*$/i.test(t)) return false;
      if (flat.includes(l) || l.includes(flat)) return false;
      return /[a-z]/i.test(t);
    });
}

function groupsOf(results, assign) {
  const map = new Map();
  for (const R of results) {
    const g = (assign[R.id] || '').trim();
    if (!g) continue;
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(R);
  }
  return [...map.entries()].map(([name, members]) => ({ name, members }));
}

function groupTraces(groups, key) {
  const all = [];
  for (const g of groups) for (const R of g.members) if (usable(R, key)) all.push(R);
  if (!all.length) return null;

  const lo = Math.max(...all.map((R) => R.time[0]));
  const hi = Math.min(...all.map((R) => R.time[R.time.length - 1]));
  if (!(hi > lo)) return null;

  const steps = all.map((R) => (R.time[R.time.length - 1] - R.time[0]) / (R.time.length - 1));
  const step = Math.max(Math.min(...steps), (hi - lo) / 20000);
  const n = Math.max(2, Math.floor((hi - lo) / step) + 1);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = lo + i * step;

  const series = [];
  for (const g of groups) {
    const use = g.members.filter((R) => usable(R, key));
    if (!use.length) continue;
    const rows = use.map((R) => interp(R.time, R[key], x));
    const mean = new Float64Array(n), sd = new Float64Array(n), sem = new Float64Array(n);
    const hiB = new Float64Array(n), loB = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = 0; k < rows.length; k++) if (isFinite(rows[k][i])) { s += rows[k][i]; c++; }
      const mu = c ? s / c : NaN;
      let v = 0;
      for (let k = 0; k < rows.length; k++) if (isFinite(rows[k][i])) v += (rows[k][i] - mu) * (rows[k][i] - mu);
      mean[i] = mu;
      sd[i] = c > 1 ? Math.sqrt(v / (c - 1)) : 0;
      sem[i] = c > 1 ? sd[i] / Math.sqrt(c) : 0;
      hiB[i] = mu + sem[i];
      loB[i] = mu - sem[i];
    }
    series.push({ name: g.name, n: use.length, ids: use.map((R) => R.id),
                  mean, sd, sem, hi: hiB, lo: loB });
  }
  return series.length ? { x, series } : null;
}

function usable(R, key) {
  return R[key] && R[key].length && R.time && R.time.length > 1;
}

function interp(xs, ys, grid) {
  const out = new Float64Array(grid.length);
  let j = 0;
  for (let i = 0; i < grid.length; i++) {
    const t = grid[i];
    while (j < xs.length - 2 && xs[j + 1] < t) j++;
    const x0 = xs[j], x1 = xs[j + 1];
    if (!(x1 > x0)) { out[i] = ys[j]; continue; }
    const f = (t - x0) / (x1 - x0);
    out[i] = ys[j] + f * (ys[j + 1] - ys[j]);
  }
  return out;
}

function groupTraceRows(groups) {
  const rows = [];
  for (const m of METRICS) {
    const tr = groupTraces(groups, m.key);
    if (!tr) continue;
    for (const s of tr.series) {
      for (let i = 0; i < tr.x.length; i++) {
        if (!isFinite(s.mean[i])) continue;
        rows.push({ Group: s.name, Metric: m.key, Time_min: tr.x[i],
                    Mean: s.mean[i], SD: s.sd[i], SEM: s.sem[i], n: s.n });
      }
    }
  }
  return rows;
}

function animalMeans(R) {
  const out = {};
  for (const m of METRICS) out[m.key] = m.need(R) ? meanOf(R[m.key]) : NaN;
  return out;
}

function meanOf(a) {
  if (!a || !a.length) return NaN;
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (isFinite(a[i])) { s += a[i]; n++; }
  return n ? s / n : NaN;
}

function describe(values) {
  const v = values.filter(isFinite);
  const n = v.length;
  if (!n) return { n: 0, mean: NaN, sd: NaN, sem: NaN };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { n, mean, sd: NaN, sem: NaN };
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1));
  return { n, mean, sd, sem: sd / Math.sqrt(n) };
}

function groupStatRows(groups) {
  const rows = [];
  for (const g of groups) {
    const means = g.members.map(animalMeans);
    for (const m of METRICS) {
      const d = describe(means.map((x) => x[m.key]));
      if (!d.n) continue;
      rows.push({ Group: g.name, Metric: m.key, n: d.n, Mean: d.mean, SD: d.sd, SEM: d.sem });
    }
  }
  return rows;
}

function compareGroups(gA, gB) {
  const A = gA.members.map(animalMeans), B = gB.members.map(animalMeans);
  return METRICS.map((m) => {
    const a = A.map((x) => x[m.key]).filter(isFinite);
    const b = B.map((x) => x[m.key]).filter(isFinite);
    const dA = describe(a), dB = describe(b);
    const row = { Metric: m.key, label: m.label,
                  nA: dA.n, meanA: dA.mean, semA: dA.sem,
                  nB: dB.n, meanB: dB.mean, semB: dB.sem,
                  diff: dA.mean - dB.mean };
    if (dA.n >= 2 && dB.n >= 2) {
      const t = welchT(a, b);
      row.t = t.t; row.df = t.df; row.pT = t.p;
      const u = mannWhitney(a, b);
      row.U = u.U; row.pU = u.p; row.exact = u.exact;
    }
    return row;
  }).filter((r) => r.nA || r.nB);
}

function welchT(a, b) {
  const n1 = a.length, n2 = b.length;
  const m1 = a.reduce((x, y) => x + y, 0) / n1;
  const m2 = b.reduce((x, y) => x + y, 0) / n2;
  const v1 = a.reduce((x, y) => x + (y - m1) * (y - m1), 0) / (n1 - 1);
  const v2 = b.reduce((x, y) => x + (y - m2) * (y - m2), 0) / (n2 - 1);
  const se2 = v1 / n1 + v2 / n2;
  if (!(se2 > 0)) return { t: NaN, df: NaN, p: NaN };
  const t = (m1 - m2) / Math.sqrt(se2);
  const df = (se2 * se2) /
    ((v1 / n1) * (v1 / n1) / (n1 - 1) + (v2 / n2) * (v2 / n2) / (n2 - 1));
  const p = betai(df / 2, 0.5, df / (df + t * t));
  return { t, df, p: Math.min(1, Math.max(0, p)) };
}

function mannWhitney(a, b) {
  const n1 = a.length, n2 = b.length;
  const all = a.map((v) => ({ v, g: 0 })).concat(b.map((v) => ({ v, g: 1 })));
  all.sort((x, y) => x.v - y.v);

  const rank = new Array(all.length);
  const tieSizes = [];
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[k] = r;
    if (j > i) tieSizes.push(j - i + 1);
    i = j + 1;
  }

  let R1 = 0;
  for (let k = 0; k < all.length; k++) if (all[k].g === 0) R1 += rank[k];
  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);

  if (!tieSizes.length && n1 <= 15 && n2 <= 15) {
    const counts = mwuCounts(n1, n2, {});
    let cum = 0;
    for (let u = 0; u <= U; u++) cum += counts[u];
    const total = counts.reduce((x, y) => x + y, 0);
    return { U, p: Math.min(1, (2 * cum) / total), exact: true };
  }

  const N = n1 + n2;
  const mu = (n1 * n2) / 2;
  const tie = tieSizes.reduce((s, t) => s + (t * t * t - t), 0);
  const sig = Math.sqrt((n1 * n2 / 12) * ((N + 1) - tie / (N * (N - 1))));
  if (!(sig > 0)) return { U, p: NaN, exact: false };
  const z = (Math.abs(U - mu) - 0.5) / sig;
  return { U, p: Math.min(1, 2 * (1 - normCdf(Math.max(z, 0)))), exact: false };
}

function mwuCounts(a, b, memo) {
  const key = a + ',' + b;
  if (memo[key]) return memo[key];
  let out;
  if (a === 0 || b === 0) out = [1];
  else {
    const A = mwuCounts(a - 1, b, memo);
    const B = mwuCounts(a, b - 1, memo);
    out = new Array(a * b + 1).fill(0);
    for (let u = 0; u < A.length; u++) out[u + b] += A[u];
    for (let u = 0; u < B.length; u++) out[u] += B[u];
  }
  memo[key] = out;
  return out;
}

// ---- distributions ----
function normCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  let poly = 0;
  for (let i = a.length - 1; i >= 0; i--) poly = poly * t + a[i];
  return s * (1 - poly * t * Math.exp(-x * x));
}

function betai(a, b, x) {
  if (!(x >= 0) || !(x <= 1) || !isFinite(a) || !isFinite(b)) return NaN;
  if (x === 0 || x === 1) return x === 0 ? 0 : 1;
  const bt = Math.exp(gammln(a + b) - gammln(a) - gammln(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? bt * betacf(a, b, x) / a
    : 1 - bt * betacf(b, a, 1 - x) / b;
}

function betacf(a, b, x) {
  const FPMIN = 1e-300, EPS = 3e-16;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function gammln(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
               -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

AK.groups = {
  METRICS, guessGroups, groupsOf, animalMeans, describe,
  groupStatRows, groupTraces, groupTraceRows, compareGroups, welchT, mannWhitney,
  betai, normCdf,
};
})(window.AK = window.AK || {});
