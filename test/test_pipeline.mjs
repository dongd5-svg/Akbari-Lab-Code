import { analyze, prepareCBF } from '../js/pipeline.js';
import { readFileSync } from 'fs';

const P = JSON.parse(readFileSync(new URL('../fixtures/pipeline_ref.json', import.meta.url)));
const D = JSON.parse(readFileSync(new URL('../fixtures/despike_ref.json', import.meta.url)));

let failures = 0;

function cmp(name, got, ref, tol = 1e-12, exact = false) {
  if (got.length !== ref.length) {
    console.log(`  FAIL  ${name}: length ${got.length} vs MATLAB ${ref.length}`);
    failures++; return;
  }
  let maxRel = 0, nDiff = 0, worst = -1;
  for (let i = 0; i < ref.length; i++) {
    if (got[i] !== ref[i]) nDiff++;
    const r = Math.abs(got[i] - ref[i]) / Math.max(1, Math.abs(ref[i]));
    if (r > maxRel) { maxRel = r; worst = i; }
  }
  const pass = exact ? nDiff === 0 : maxRel <= tol;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} n=${String(ref.length).padStart(6)}  max rel ${maxRel.toExponential(2)}${exact ? `  bitwise-diff ${nDiff}` : ''}`);
  if (!pass) {
    console.log(`        worst i=${worst}: MATLAB=${ref[worst]}  js=${got[worst]}`);
    failures++;
  }
}

console.log('\n--- prepareCBF on real Mouse272 data ---');
const prep = prepareCBF(P.input.time, P.input.mean_data, P.eventTime);
cmp('CBFraw',     prep.CBFraw,     P.prep.CBFraw, 0, true);
cmp('CBFrawtime', prep.CBFrawtime, P.prep.CBFrawtime);
cmp('CBFtime',    prep.CBFtime,    P.prep.CBFtime);
cmp('CBFspline',  prep.CBFspline,  P.prep.CBFspline);
cmp('rCBF',       prep.rCBF,       P.prep.rCBF);
console.log(`  ${prep.nDespiked === P.prep.nDespiked ? 'PASS' : 'FAIL'}  nDespiked              ${prep.nDespiked} vs ${P.prep.nDespiked}`);
console.log(`  ${Math.abs(prep.baseline - P.prep.baseline) < 1e-9 ? 'PASS' : 'FAIL'}  baseline               ${prep.baseline} vs ${P.prep.baseline}`);
if (prep.nDespiked !== P.prep.nDespiked) failures++;

console.log('\n--- despike with injected spikes ---');
const dp = prepareCBF(D.t, D.x, 1);
cmp('CBFspline (despiked)', dp.CBFspline, D.CBFspline);
cmp('rCBF (despiked)',      dp.rCBF,      D.rCBF);
console.log(`  ${dp.nDespiked === D.nDespiked ? 'PASS' : 'FAIL'}  nDespiked              ${dp.nDespiked} vs ${D.nDespiked}`);
if (dp.nDespiked !== D.nDespiked) failures++;

console.log('\n--- full CMRO2 analysis ---');
const R = analyze({ time: P.input.time, sfi: P.input.mean_data }, P.sfdi, P.eventTime);
cmp('Kexp',     R.Kexp,     P.out.Kexp);
cmp('Db',       R.Db,       P.out.Db, 0, true);       // grid values: must match exactly
cmp('deltaFx1', R.deltaFx1, P.out.deltaFx1);
cmp('aCBF',     R.aCBF,     P.out.aCBF, 0, true);
cmp('aCMRO2',   R.aCMRO2,   P.out.aCMRO2);
cmp('rCBF',     R.rCBF,     P.out.rCBF);
cmp('rCMRO2',   R.rCMRO2,   P.out.rCMRO2);
cmp('rRatio',   R.rRatio,   P.out.rRatio);

console.log(failures === 0 ? '\nALL PIPELINE CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
