import { readMat, pickVariable } from '../js/matfile.js';
import { readFileSync } from 'fs';

const dir = new URL('./matfiles/', import.meta.url);
let fail = 0;

async function load(name) {
  const buf = readFileSync(new URL(name, dir));
  return readMat(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), name);
}

function check(cond, msg) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fail++;
}

// Expected values come from the same fixture MATLAB produced, so this test
// stays correct if the sample data is ever regenerated.
const PREF = JSON.parse(readFileSync(new URL('../fixtures/pipeline_ref.json', import.meta.url)));
const REF_T = PREF.input.time.slice(0, 4);
const REF_M = PREF.input.mean_data.slice(0, 4);

function firstFour(a) { return Array.from(a.slice(0, 4)); }
function same(a, b, tol = 1e-12) {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol * Math.max(1, Math.abs(b[i])));
}

for (const [file, label] of [['sample_v73.mat','v7.3 (HDF5)'], ['sample_v7.mat','v7 (zlib)'], ['sample_v6.mat','v6 (uncompressed)']]) {
  console.log(`\n--- ${label} ---`);
  const v = await load(file);
  const t = pickVariable(v, ['time']);
  const m = pickVariable(v, ['mean_data']);
  check(!!t && !!m, `found time + mean_data  (keys: ${Object.keys(v).join(', ')})`);
  if (t && m) {
    check(t.data.length === 11984, `11984 samples, got ${t.data.length}`);
    check(same(firstFour(t.data), REF_T), 'time values match MATLAB');
    check(same(firstFour(m.data), REF_M), 'mean_data values match MATLAB');
  }
}

console.log('\n--- flat ROI file (v7) ---');
{
  const v = await load('sample_roi_v7.mat');
  const need = ['MetabolismTime','hbo2','hbr','hbtot','scatter730'];
  const got = need.map(n => pickVariable(v, [n]));
  check(got.every(Boolean), `all SFDI fields present (${Object.keys(v).length} vars)`);
  check(got[0].data.length === 360, `360 timepoints, got ${got[0]?.data.length}`);
  check(Math.abs(got[1].data[0] - 0.060) < 1e-12, `hbo2[0] = ${got[1].data[0]}`);
}

for (const [file, label] of [['sample_struct_v7.mat','struct (v7)'], ['sample_struct_v73.mat','struct (v7.3)']]) {
  console.log(`\n--- ${label} ---`);
  const v = await load(file);
  const keys = Object.keys(v);
  check(keys.length > 0, `flattened to ${keys.length} keys: ${keys.slice(0,3).join(', ')}...`);
  const h = pickVariable(v, ['hbo2']);
  check(!!h, 'hbo2 reachable inside nested struct');
  if (h) check(Math.abs(h.data[0] - 0.060) < 1e-12, `hbo2[0] = ${h.data[0]} (key "${h.key}")`);
}

console.log('\n--- mixed types (single, int32) ---');
{
  const v = await load('sample_types_v7.mat');
  const sp = pickVariable(v, ['sp']);
  const iv = pickVariable(v, ['iv']);
  check(!!sp && !!iv, 'single + int32 both read');
  if (sp) check(Math.abs(sp.data[0] - 4032.2769449607922) < 1e-3, `single promoted: ${sp.data[0]}`);
  if (iv) check(iv.data[0] === 1 && iv.data[99] === 100, `int32 range ${iv.data[0]}..${iv.data[99]}`);
}

console.log('\n--- rejects a non-mat file ---');
{
  let threw = false;
  try { await readMat(new TextEncoder().encode('x'.repeat(300)).buffer); } catch { threw = true; }
  check(threw, 'garbage input raises a clear error');
}

console.log(fail === 0 ? '\nALL MAT-READER CHECKS PASSED\n' : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
