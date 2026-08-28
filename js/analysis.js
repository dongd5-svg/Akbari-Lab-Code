(function (AK) {
'use strict';

// analysis.js — turn a set of dropped files into results.
//
// Works out which file is which, pairs them by animal, and runs the pipeline.

var readMat = AK.readMat, pickVariable = AK.pickVariable;
var analyze = AK.analyze, DEFAULTS = AK.DEFAULTS;

const LSI_TIME = ['time', 'CBFrawtime', 'CBFtime'];
const LSI_FLOW = ['mean_data', 'CBFraw', 'sfi'];
const SFDI_NEED = ['MetabolismTime', 'hbo2', 'hbr', 'hbtot', 'scatter730'];

// Pull an animal label out of a filename: "Mouse 272_Baseline_LSI.mat" -> "Mouse272"
function animalIdFromName(fileName) {
  const stem = fileName.replace(/\.mat$/i, '');
  const m = stem.match(/((?:mouse|rat|animal|subject)\s*[-_]?\s*\d+[a-z]?)/i);
  if (m) return m[1].replace(/[\s\-_]+/g, '');
  const n = stem.match(/(\d{2,5})/);
  if (n) return `Animal${n[1]}`;
  return stem.slice(0, 24);
}

// Inspect one file and decide what it holds.
async function inspectFile(file) {
  const buf = await file.arrayBuffer();
  const vars = await readMat(buf, file.name);

  const t = pickVariable(vars, LSI_TIME);
  const f = pickVariable(vars, LSI_FLOW);
  const sfdiHits = SFDI_NEED.map((n) => pickVariable(vars, [n]));
  const hasSFDI = sfdiHits.every(Boolean);
  const hasLSI = !!t && !!f;

  let kind = 'unknown';
  if (hasSFDI) kind = 'sfdi';
  else if (hasLSI) kind = 'lsi';

  const info = {
    name: file.name,
    size: file.size,
    kind,
    animal: animalIdFromName(file.name),
    varNames: Object.keys(vars),
    nSamples: hasSFDI ? sfdiHits[0].data.length : hasLSI ? t.data.length : 0,
  };

  if (kind === 'lsi') {
    info.lsi = { time: t.data, sfi: f.data, timeKey: t.key, flowKey: f.key };
  } else if (kind === 'sfdi') {
    info.sfdi = {
      MetabolismTime: sfdiHits[0].data,
      hbo2: sfdiHits[1].data,
      hbr: sfdiHits[2].data,
      hbtot: sfdiHits[3].data,
      scatter730: sfdiHits[4].data,
    };
  } else {
    info.missing = hasLSI
      ? SFDI_NEED.filter((n, i) => !sfdiHits[i])
      : ['time/mean_data (LSI) or MetabolismTime/hbo2/hbr/hbtot/scatter730 (SFDI)'];
  }
  return info;
}

// Group inspected files into animals: one LSI file, optionally one SFDI file.
function pairFiles(infos) {
  const byAnimal = new Map();
  for (const f of infos) {
    if (f.kind === 'unknown') continue;
    if (!byAnimal.has(f.animal)) byAnimal.set(f.animal, { id: f.animal, lsiFile: null, sfdiFile: null });
    const e = byAnimal.get(f.animal);
    if (f.kind === 'lsi' && !e.lsiFile) e.lsiFile = f;
    else if (f.kind === 'sfdi' && !e.sfdiFile) e.sfdiFile = f;
  }

  // A single SFDI file with no matching LSI partner is common when the naming
  // differs (e.g. "roi1.mat"). If exactly one animal lacks SFDI and exactly one
  // orphan SFDI exists, pair them rather than dropping both.
  const entries = [...byAnimal.values()];
  const orphanSfdi = entries.filter((e) => e.sfdiFile && !e.lsiFile);
  const needSfdi = entries.filter((e) => e.lsiFile && !e.sfdiFile);
  if (orphanSfdi.length === 1 && needSfdi.length === 1) {
    needSfdi[0].sfdiFile = orphanSfdi[0].sfdiFile;
    byAnimal.delete(orphanSfdi[0].id);
  }

  return [...byAnimal.values()].filter((e) => e.lsiFile);
}

// Run the pipeline over every paired animal.
function runAll(pairs, opts) {
  const results = [];
  const problems = [];
  for (const p of pairs) {
    const t0 = performance.now();
    try {
      const R = analyze(
        { time: p.lsiFile.lsi.time, sfi: p.lsiFile.lsi.sfi },
        p.sfdiFile ? p.sfdiFile.sfdi : null,
        opts.eventTime,
        opts
      );
      R.id = p.id;
      R.sourceLSI = p.lsiFile.name;
      R.sourceSFDI = p.sfdiFile ? p.sfdiFile.name : null;
      R.elapsedMs = performance.now() - t0;
      results.push(R);
    } catch (err) {
      problems.push({ id: p.id, message: err.message });
    }
  }
  return { results, problems };
}

function summaryRows(results) {
  return results.map((R) => ({
    Animal: R.id,
    Points: R.time.length,
    SpikesRemoved: R.nDespiked,
    Oxygen: R.hasSFDI ? 'yes' : 'no',
    mean_rCBF: meanOf(R.rCBF),
    mean_rCMRO2: R.hasSFDI ? meanOf(R.rCMRO2) : NaN,
    mean_aCBF: R.hasSFDI ? meanOf(R.aCBF) : NaN,
    mean_aCMRO2: R.hasSFDI ? meanOf(R.aCMRO2) : NaN,
    ms: Math.round(R.elapsedMs),
  }));
}

function meanOf(a) {
  if (!a || !a.length) return NaN;
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (isFinite(a[i])) { s += a[i]; n++; }
  return n ? s / n : NaN;
}

function toCSV(rows) {
  if (!rows.length) return '';
  // Animals without SFDI have fewer columns, so take the union in first-seen order.
  const seen = new Set(), cols = [];
  for (const r of rows) for (const k in r) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  const esc = (v) => (v === undefined || v === null ? ''
    : typeof v === 'number' ? (isFinite(v) ? String(v) : '')
    : `"${String(v).replace(/"/g, '""')}"`);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

// Pad or trim to n points the same way the pipeline does.
function matchLen(v, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = i < v.length ? v[i] : v[v.length - 1];
  return out;
}

// Every timepoint of one animal, one row each. These are the same numbers you
// would read out of the struct in MATLAB, just laid out for a spreadsheet.
function traceRows(R) {
  const n = R.time.length;
  const flow = matchLen(R.CBFspline, n);
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = {
      Animal: R.id,
      Time_min: R.time[i],
      CBF_SFI: flow[i],
      rCBF: R.rCBF[i],
    };
    if (R.hasSFDI) {
      r.aCBF_Db_mm2_per_s   = R.aCBF[i];
      r.aCMRO2_umol_per_min = R.aCMRO2[i];
      r.rCMRO2              = R.rCMRO2[i];
      r.rCBF_over_rCMRO2    = R.rRatio[i];
      r.HbO2_uM             = R.cthbo2[i];
      r.HbR_uM              = R.cthb[i];
      r.HbTot_uM            = R.cthbtot[i];
      r.musp730_per_mm      = R.scatter730[i];
    }
    rows[i] = r;
  }
  return rows;
}

function allTraceRows(results) {
  const out = [];
  for (const R of results) for (const r of traceRows(R)) out.push(r);
  return out;
}

AK.animalIdFromName = animalIdFromName;
AK.inspectFile = inspectFile;
AK.pairFiles = pairFiles;
AK.runAll = runAll;
AK.summaryRows = summaryRows;
AK.toCSV = toCSV;
AK.traceRows = traceRows;
AK.allTraceRows = allTraceRows;
})(window.AK = window.AK || {});
