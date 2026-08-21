// app.js — wiring: drop files, inspect, analyse, render.

import { inspectFile, pairFiles, runAll, summaryRows, toCSV, DEFAULTS } from './analysis.js';
import { makeChart, chartsToPNG } from './charts.js';

const $ = (id) => document.getElementById(id);
const state = { files: [], results: [], charts: [], animal: 0, metric: 'flow' };

// ---------- theme -----------------------------------------------------------
const savedTheme = safeGet('theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
$('theme').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  safeSet('theme', next);
  if (state.results.length) renderCharts();
};

// ---------- file intake -----------------------------------------------------
const drop = $('drop');
drop.addEventListener('click', () => $('picker').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('picker').click(); } });
$('picker').addEventListener('change', (e) => addFiles([...e.target.files]));

['dragenter', 'dragover'].forEach((t) =>
  drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) =>
  drop.addEventListener(t, (e) => { e.preventDefault(); if (t === 'dragleave' && drop.contains(e.relatedTarget)) return; drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles([...(e.dataTransfer?.files || [])]));

$('clearFiles').onclick = () => {
  state.files = []; state.results = [];
  renderFiles(); hide('resultsPanel'); hide('chartsPanel');
};

async function addFiles(list) {
  const mats = list.filter((f) => /\.mat$/i.test(f.name));
  const skipped = list.length - mats.length;
  if (!mats.length) {
    msg('fileMsgs', 'err', skipped ? `Those are not .mat files. Drop MATLAB .mat files instead.` : 'No files received.');
    show('filesPanel');
    return;
  }
  show('filesPanel');
  msg('fileMsgs', 'info', `<span class="spinner"></span> Reading ${mats.length} file${mats.length > 1 ? 's' : ''}…`);

  for (const f of mats) {
    if (state.files.some((x) => x.name === f.name && x.size === f.size)) continue;
    try {
      state.files.push(await inspectFile(f));
    } catch (err) {
      state.files.push({ name: f.name, size: f.size, kind: 'unknown', animal: '--',
                         error: err.message, varNames: [], nSamples: 0 });
    }
    renderFiles();
  }
  clearMsg('fileMsgs');
  renderFiles();
  if (skipped) msg('fileMsgs', 'warn', `Ignored ${skipped} file(s) that were not .mat.`);
}

function renderFiles() {
  const tb = $('fileTable').querySelector('tbody');
  if (!state.files.length) { hide('filesPanel'); hide('settingsPanel'); tb.innerHTML = ''; return; }

  const pairs = pairFiles(state.files);
  const paired = new Map();
  pairs.forEach((p) => {
    if (p.lsiFile) paired.set(p.lsiFile.name, p.id);
    if (p.sfdiFile) paired.set(p.sfdiFile.name, p.id);
  });

  tb.innerHTML =
    `<tr><th>File</th><th>Type</th><th>Animal</th><th class="num">Samples</th><th>Notes</th></tr>` +
    state.files.map((f) => {
      const tag = f.kind === 'lsi' ? '<span class="tag lsi">LSI flow</span>'
               : f.kind === 'sfdi' ? '<span class="tag sfdi">SFDI oxygen</span>'
               : '<span class="tag unknown">not recognised</span>';
      let note = '';
      if (f.error) note = `<span class="muted">${esc(f.error)}</span>`;
      else if (f.kind === 'unknown') {
        note = `<span class="muted">no usable variables — found ${f.varNames.length ? esc(f.varNames.slice(0, 4).join(', ')) : 'nothing'}</span>`;
      } else if (!paired.has(f.name)) note = '<span class="muted">not paired</span>';
      return `<tr><td class="mono">${esc(f.name)}</td><td>${tag}</td><td>${esc(f.animal)}</td>` +
             `<td class="num">${f.nSamples ? f.nSamples.toLocaleString() : '--'}</td><td>${note}</td></tr>`;
    }).join('');

  const nReady = pairs.length;
  const nOx = pairs.filter((p) => p.sfdiFile).length;
  if (nReady) {
    show('settingsPanel');
    $('run').disabled = false;
    $('runStatus').innerHTML = `${nReady} animal${nReady > 1 ? 's' : ''} ready` +
      (nOx ? `, ${nOx} with oxygen data` : ' — flow only, add SFDI ROI files for CMRO₂');
  } else {
    show('settingsPanel');
    $('run').disabled = true;
    $('runStatus').textContent = 'No usable LSI file yet.';
  }
}

// ---------- run -------------------------------------------------------------
$('run').onclick = () => {
  const pairs = pairFiles(state.files);
  if (!pairs.length) return;

  const opts = {
    ...DEFAULTS,
    eventTime: numOr($('eventTime').value, 1),
    cbfHighThreshold: numOr($('hiThr').value, 40000),
    cbfLowThreshold: numOr($('loThr').value, -950),
    Texposure: numOr($('exposure').value, 10) / 1000,
  };

  $('run').disabled = true;
  $('runStatus').innerHTML = '<span class="spinner"></span> analysing…';

  setTimeout(() => {
    const t0 = performance.now();
    const { results, problems } = runAll(pairs, opts);
    const ms = performance.now() - t0;
    state.results = results;
    state.animal = 0;
    $('run').disabled = false;
    $('runStatus').textContent = `${results.length} of ${pairs.length} analysed in ${ms.toFixed(0)} ms`;
    renderResults(problems, ms);
  }, 10);
};

function renderResults(problems, ms) {
  const rows = summaryRows(state.results);
  show('resultsPanel');
  clearMsg('resultMsgs');

  if (problems.length) {
    msg('resultMsgs', 'err',
      `<strong>${problems.length} animal(s) failed:</strong><br>` +
      problems.map((p) => `${esc(p.id)} — ${esc(p.message)}`).join('<br>'));
  }
  const noOx = state.results.filter((r) => !r.hasSFDI);
  if (noOx.length === state.results.length && state.results.length) {
    msg('resultMsgs', 'warn',
      'No SFDI data supplied, so only blood flow was computed. Add the ROI <code>.mat</code> files (containing <span class="mono">MetabolismTime, hbo2, hbr, hbtot, scatter730</span>) to get CMRO₂.');
  } else if (noOx.length) {
    msg('resultMsgs', 'warn', `${noOx.length} animal(s) had no SFDI data — oxygen skipped for them.`);
  }
  const short = state.results.filter((r) => r.shortBaseline);
  if (short.length) {
    msg('resultMsgs', 'warn', `${short.length} recording(s) were shorter than the baseline window; the first ${DEFAULTS.baselineWin} min was used instead.`);
  }

  if (!rows.length) { $('summary').innerHTML = ''; hide('chartsPanel'); return; }

  const cols = Object.keys(rows[0]);
  $('summary').innerHTML =
    `<tr>${cols.map((c) => `<th>${esc(niceCol(c))}</th>`).join('')}</tr>` +
    rows.map((r) => `<tr>${cols.map((c) => {
      const v = r[c];
      if (typeof v === 'number') return `<td class="num">${isFinite(v) ? sig(v) : '<span class="muted">--</span>'}</td>`;
      if (c === 'Oxygen') return `<td>${v === 'yes' ? '<span class="tag ok">yes</span>' : '<span class="muted">no</span>'}</td>`;
      return `<td>${esc(String(v))}</td>`;
    }).join('')}</tr>`).join('');

  renderTabs();
  renderCharts();
}

function renderTabs() {
  const at = $('animalTabs');
  at.innerHTML = state.results.map((r, i) =>
    `<button role="tab" aria-selected="${i === state.animal}" data-i="${i}">${esc(r.id)}</button>`).join('');
  at.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { state.animal = +b.dataset.i; renderTabs(); renderCharts(); };
  });

  const R = state.results[state.animal];
  const metrics = R?.hasSFDI
    ? [['flow', 'Blood flow'], ['oxygen', 'Oxygen use'], ['absolute', 'Absolute values'], ['raw', 'Raw + cleaned']]
    : [['flow', 'Blood flow'], ['raw', 'Raw + cleaned']];
  if (!metrics.some((m) => m[0] === state.metric)) state.metric = 'flow';

  const mt = $('metricTabs');
  mt.innerHTML = metrics.map(([k, label]) =>
    `<button role="tab" aria-selected="${k === state.metric}" data-k="${k}">${label}</button>`).join('');
  mt.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { state.metric = b.dataset.k; renderTabs(); renderCharts(); };
  });
}

function renderCharts() {
  const host = $('charts');
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
  host.innerHTML = '';
  const R = state.results[state.animal];
  if (!R) { hide('chartsPanel'); return; }
  show('chartsPanel');

  const C1 = cssv('--accent'), C2 = cssv('--accent-2');
  const t = Array.from(R.time);
  const add = (cfg) => state.charts.push(makeChart(host, cfg));

  if (state.metric === 'flow') {
    add({ title: 'Relative blood flow', subtitle: '1.0 = baseline average', yLabel: 'rCBF',
          x: t, series: [{ label: 'rCBF', y: Array.from(R.rCBF), color: C1 }] });
    add({ title: 'Blood flow, resampled', subtitle: 'de-spiked and interpolated to 100 samples/min',
          yLabel: 'SFI', x: Array.from(R.CBFtime), series: [{ label: 'CBF', y: Array.from(R.CBFspline), color: C1 }] });
  } else if (state.metric === 'oxygen') {
    add({ title: 'Relative oxygen use', subtitle: '1.0 = baseline average', yLabel: 'rCMRO₂',
          x: t, series: [{ label: 'rCMRO₂', y: Array.from(R.rCMRO2), color: C2 }] });
    add({ title: 'Flow vs metabolism', subtitle: 'rCBF ÷ rCMRO₂ — above 1 means supply exceeds demand',
          yLabel: 'ratio', x: t, series: [{ label: 'rCBF/rCMRO₂', y: Array.from(R.rRatio), color: C1 }] });
    add({ title: 'Relative flow and oxygen together', yLabel: 'relative', x: t,
          series: [{ label: 'rCBF', y: Array.from(R.rCBF), color: C1 },
                   { label: 'rCMRO₂', y: Array.from(R.rCMRO2), color: C2 }] });
  } else if (state.metric === 'absolute') {
    add({ title: 'Absolute blood flow (D_b)', subtitle: 'fitted Brownian diffusion coefficient, mm²/s',
          yLabel: 'D_b', x: t, series: [{ label: 'aCBF', y: Array.from(R.aCBF), color: C1 }] });
    add({ title: 'Absolute oxygen consumption', subtitle: 'µmol O₂ / min', yLabel: 'aCMRO₂',
          x: t, series: [{ label: 'aCMRO₂', y: Array.from(R.aCMRO2), color: C2 }] });
    add({ title: 'Haemoglobin', subtitle: 'from the SFDI file, µM', yLabel: 'µM', x: t,
          series: [{ label: 'HbO₂', y: Array.from(R.cthbo2), color: C1 },
                   { label: 'HbR', y: Array.from(R.cthb), color: C2 }] });
  } else {
    add({ title: 'Raw recording', subtitle: `${R.CBFraw.length.toLocaleString()} frames as acquired`,
          yLabel: 'SFI', x: Array.from(R.CBFrawtime),
          series: [{ label: 'raw', y: Array.from(R.CBFraw), color: C1, width: 1 }] });
    add({ title: 'After cleaning and resampling',
          subtitle: `${R.nDespiked} artifact sample${R.nDespiked === 1 ? '' : 's'} replaced`,
          yLabel: 'SFI', x: Array.from(R.CBFtime),
          series: [{ label: 'cleaned', y: Array.from(R.CBFspline), color: C2 }] });
  }
}

// ---------- downloads -------------------------------------------------------
$('dlCsv').onclick = () => {
  const csv = toCSV(summaryRows(state.results));
  download(new Blob([csv], { type: 'text/csv' }), 'cmro2_summary.csv');
};
$('dlPng').onclick = () => {
  if (!state.charts.length) return;
  const R = state.results[state.animal];
  chartsToPNG(state.charts, `${R.id} — ${$('metricTabs').querySelector('[aria-selected="true"]')?.textContent || ''}`)
    .toBlob((b) => download(b, `${R.id}_charts.png`));
};

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- small helpers ---------------------------------------------------
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function msg(host, kind, html) {
  const d = document.createElement('div');
  d.className = `msg ${kind}`;
  d.innerHTML = html;
  $(host).appendChild(d);
}
function clearMsg(host) { $(host).innerHTML = ''; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function numOr(v, d) { const n = parseFloat(v); return isFinite(n) ? n : d; }
function cssv(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function sig(v) {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a < 1e-3 || a >= 1e6) return v.toExponential(3);
  return (+v.toPrecision(5)).toString();
}
function niceCol(c) {
  return { mean_rCBF: 'mean rCBF', mean_rCMRO2: 'mean rCMRO₂', mean_aCBF: 'mean aCBF',
           mean_aCMRO2: 'mean aCMRO₂', SpikesRemoved: 'spikes removed', ms: 'ms' }[c] || c;
}
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
