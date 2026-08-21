import { spline } from '../js/spline.js';
import { readFileSync } from 'fs';

const ref = JSON.parse(readFileSync(new URL('../fixtures/spline_ref.json', import.meta.url)));

function check(name, c) {
  const got = spline(c.x, c.y, c.xq);
  let maxAbs = 0, maxRel = 0, worst = -1;
  for (let i = 0; i < got.length; i++) {
    const e = Math.abs(got[i] - c.yq[i]);
    const r = e / Math.max(1, Math.abs(c.yq[i]));
    if (e > maxAbs) maxAbs = e;
    if (r > maxRel) { maxRel = r; worst = i; }
  }
  const pass = maxRel < 1e-12;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}: ${got.length} pts, max abs ${maxAbs.toExponential(2)}, max rel ${maxRel.toExponential(2)}`);
  if (!pass) {
    console.log(`        worst at i=${worst}: xq=${c.xq[worst]} MATLAB=${c.yq[worst]} js=${got[worst]}`);
  }
  return pass;
}

console.log('\nSpline vs MATLAB spline():');
const ok = [check('12 knots, incl. extrapolation', ref.spline1),
            check('60 uneven knots', ref.spline2)].every(Boolean);
process.exit(ok ? 0 : 1);
