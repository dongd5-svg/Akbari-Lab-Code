// The group statistics, checked against results worked out a second way:
// Mann-Whitney against every possible split enumerated by brute force, and the
// t-test tail against numerical integration of the t density.
import { AK } from './_load.mjs';
const G = AK.groups;

let fail = 0;
const ok = (c, m, extra='') => { console.log(`  ${c?'PASS':'FAIL'}  ${m}${extra?'  - '+extra:''}`); if(!c) fail++; };

function bruteMWU(a, b) {
  const n1 = a.length, n2 = b.length, N = n1 + n2;
  const all = a.map(v=>({v,g:0})).concat(b.map(v=>({v,g:1}))).sort((x,y)=>x.v-y.v);
  let R1 = 0; all.forEach((e,k) => { if (e.g === 0) R1 += k + 1; });
  const U1 = R1 - n1*(n1+1)/2;
  const obs = Math.min(U1, n1*n2 - U1);
  const ranks = [...Array(N).keys()].map(i => i + 1);
  let total = 0, le = 0;
  const walk = (start, cur) => {
    if (cur.length === n1) {
      total++;
      const u1 = cur.reduce((s,r)=>s+r,0) - n1*(n1+1)/2;
      if (Math.min(u1, n1*n2-u1) <= obs) le++;
      return;
    }
    for (let i = start; i < N; i++) { cur.push(ranks[i]); walk(i+1, cur); cur.pop(); }
  };
  walk(0, []);
  return { p: Math.min(1, le/total), obs, total };
}

function integratedT(t, df) {
  const lg = (x) => {
    const c = [76.18009172947146,-86.50532032941677,24.01409824083091,
               -1.231739572450155,0.1208650973866179e-2,-0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let s = 1.000000000190015;
    for (let j = 0; j < 6; j++) s += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * s / x);
  };
  const C = Math.exp(lg((df+1)/2) - lg(df/2)) / Math.sqrt(df * Math.PI);
  const f = (u) => C * Math.pow(1 + u*u/df, -(df+1)/2);
  const lo = Math.abs(t), hi = lo + 400, n = 400000, h = (hi - lo) / n;
  let s = f(lo) + f(hi);
  for (let i = 1; i < n; i++) s += f(lo + i*h) * (i % 2 ? 4 : 2);
  return 2 * s * h / 3;
}

console.log('\nMann-Whitney against every possible split:');
for (const [a, b] of [
  [[1,2,3,4,5],[6,7,8,9,10]],
  [[1,3,5,7],[2,4,6,8]],
  [[2,9,4,1],[3,8,7,6,5]],
  [[1.2,3.4,5.6],[2.2,4.4,6.6,8.8,0.1]],
]) {
  const mine = G.mannWhitney(a, b), bf = bruteMWU(a, b);
  ok(Math.abs(mine.p - bf.p) < 1e-12 && mine.U === bf.obs,
     `n=${a.length} vs ${b.length}`,
     `U=${mine.U} p=${mine.p.toFixed(8)} over ${bf.total} splits`);
}

console.log('\nWelch t-test against numerical integration:');
for (const [a, b] of [
  [[1,2,3,4,5],[3,4,5,6,7]],
  [[5.1,4.9,6.2,5.8],[7.2,8.1,7.9,9.4,8.8]],
  [[0.9,1.1,1.0,1.2,0.95,1.05],[1.4,1.2,1.5,1.35]],
]) {
  const r = G.welchT(a, b);
  ok(Math.abs(r.p - integratedT(r.t, r.df)) < 1e-9,
     `t=${r.t.toFixed(4)}, df=${r.df.toFixed(3)}`, `p=${r.p.toExponential(6)}`);
}

console.log('\nNormal CDF:');
for (const [z, want] of [[0,0.5],[1,0.8413447],[1.959964,0.975],[3,0.9986501]]) {
  ok(Math.abs(G.normCdf(z) - want) < 5e-7, `Phi(${z})`, G.normCdf(z).toFixed(7));
}

console.log('\nAveraging across a group:');
const mk = (id, vals) => ({ id, hasSFDI: false,
  time: Float64Array.from(vals.map((_, i) => i * 0.01)),
  rCBF: Float64Array.from(vals) });
const groups = [{ name: 'A', members: [mk('a',[1,2,3,4]), mk('b',[3,4,5,6]), mk('c',[2,3,4,5])] }];
const tr = G.groupTraces(groups, 'rCBF');
const s0 = tr.series[0];
ok(s0.n === 3 && Math.abs(s0.mean[0] - 2) < 1e-12 && Math.abs(s0.mean[3] - 5) < 1e-12,
   'mean across three animals', Array.from(s0.mean).join(', '));
ok(Math.abs(s0.sem[0] - 1/Math.sqrt(3)) < 1e-12, 'SEM is SD over sqrt(n)', s0.sem[0].toFixed(6));
ok(Math.abs(s0.hi[0] - (s0.mean[0] + s0.sem[0])) < 1e-15, 'band edges are mean +/- SEM');

// Uneven recording lengths land on the overlapping stretch of time.
const uneven = [{ name: 'A', members: [mk('a', new Array(500).fill(1)), mk('b', new Array(497).fill(3))] }];
const tr2 = G.groupTraces(uneven, 'rCBF');
ok(tr2.x[tr2.x.length-1] <= 4.96 + 1e-9, 'grid stops at the shorter recording',
   `ends at ${tr2.x[tr2.x.length-1].toFixed(2)} min`);
ok(Math.abs(tr2.series[0].mean[10] - 2) < 1e-12, 'both animals still averaged');

console.log(fail === 0 ? '\nALL GROUP STATS CHECKS PASSED\n' : `\n${fail} CHECK(S) FAILED\n`);
process.exit(fail ? 1 : 0);
