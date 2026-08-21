(function (AK) {
'use strict';

var inspectFile = AK.inspectFile, pairFiles = AK.pairFiles, runAll = AK.runAll;
var summaryRows = AK.summaryRows, toCSV = AK.toCSV, DEFAULTS = AK.DEFAULTS;
var makeChart = AK.makeChart, chartsToPNG = AK.chartsToPNG;
var FIG = AK.figure;

const $ = (id) => document.getElementById(id);
const state = { files: [], results: [], charts: [], animal: 0, metric: 'flow',
                figPanels: ['rCBF', 'rCMRO2'] };

// ---- theme ----
const saved = safeGet('theme');
if (saved) document.documentElement.setAttribute('data-theme', saved);
setThemeLabel();
$('theme').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  safeSet('theme', next);
  setThemeLabel();
  if (state.results.length) drawCharts();
};
function setThemeLabel() {
  const cur = document.documentElement.getAttribute('data-theme');
  const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('theme').textContent = dark ? 'Light' : 'Dark';
}

// ---- file intake ----
const drop = $('drop');
drop.onclick = () => $('picker').click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('picker').click(); } };
$('picker').onchange = (e) => addFiles([...e.target.files]);

['dragenter', 'dragover'].forEach((t) =>
  drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
drop.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (!drop.contains(e.relatedTarget)) drop.classList.remove('over');
});
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  addFiles([...(e.dataTransfer ? e.dataTransfer.files : [])]);
});

$('clearFiles').onclick = () => {
  state.files = []; state.results = [];
  drawFiles(); hide('resultsPanel'); hide('chartsPanel');
};

async function addFiles(list) {
  const mats = list.filter((f) => /\.mat$/i.test(f.name));
  const skipped = list.length - mats.length;
  show('filesPanel');
  if (!mats.length) {
    note('fileMsgs', 'e', 'No .mat files in that drop.');
    return;
  }
  clearNote('fileMsgs');
  note('fileMsgs', 'i', `Reading ${mats.length} file${mats.length > 1 ? 's' : ''}.`);

  for (const f of mats) {
    if (state.files.some((x) => x.name === f.name && x.size === f.size)) continue;
    try {
      state.files.push(await inspectFile(f));
    } catch (err) {
      state.files.push({ name: f.name, size: f.size, kind: 'unknown', animal: '',
                         error: err.message, varNames: [], nSamples: 0 });
    }
    drawFiles();
  }
  clearNote('fileMsgs');
  drawFiles();
  if (skipped) note('fileMsgs', 'w', `Skipped ${skipped} file(s) that were not .mat.`);
}

function drawFiles() {
  const tbl = $('fileTable');
  if (!state.files.length) { hide('filesPanel'); hide('settingsPanel'); tbl.innerHTML = ''; return; }

  const pairs = pairFiles(state.files);
  const used = new Set();
  pairs.forEach((p) => { if (p.lsiFile) used.add(p.lsiFile.name); if (p.sfdiFile) used.add(p.sfdiFile.name); });

  tbl.innerHTML =
    '<tr><th>File</th><th>Contents</th><th>Animal</th><th class="n">Samples</th><th>Note</th></tr>' +
    state.files.map((f) => {
      const kind = f.kind === 'lsi' ? '<span class="lsi">flow</span>'
                 : f.kind === 'sfdi' ? '<span class="sfdi">haemoglobin</span>'
                 : '<span class="bad">not usable</span>';
      let n = '';
      if (f.error) n = `<span class="dim">${esc(f.error)}</span>`;
      else if (f.kind === 'unknown') {
        n = `<span class="dim">variables found: ${f.varNames.length ? esc(f.varNames.slice(0, 4).join(', ')) : 'none'}</span>`;
      } else if (!used.has(f.name)) n = '<span class="dim">unpaired</span>';
      return `<tr><td class="mono">${esc(f.name)}</td><td>${kind}</td><td>${esc(f.animal)}</td>` +
             `<td class="n">${f.nSamples ? f.nSamples.toLocaleString() : ''}</td><td>${n}</td></tr>`;
    }).join('');

  show('settingsPanel');
  const nOx = pairs.filter((p) => p.sfdiFile).length;
  $('run').disabled = pairs.length === 0;
  $('runStatus').textContent = pairs.length
    ? `${pairs.length} animal${pairs.length > 1 ? 's' : ''}, ${nOx} with haemoglobin data`
    : 'Need at least one flow file.';
}

// ---- run ----
$('run').onclick = () => {
  const pairs = pairFiles(state.files);
  if (!pairs.length) return;
  const opts = Object.assign({}, DEFAULTS, {
    eventTime: num($('eventTime').value, 1),
    cbfHighThreshold: num($('hiThr').value, 40000),
    cbfLowThreshold: num($('loThr').value, -950),
    Texposure: num($('exposure').value, 10) / 1000,
  });

  $('run').disabled = true;
  $('runStatus').textContent = 'working';

  setTimeout(() => {
    const t0 = performance.now();
    const r = runAll(pairs, opts);
    const ms = performance.now() - t0;
    state.results = r.results;
    state.animal = 0;
    $('run').disabled = false;
    $('runStatus').textContent = `${r.results.length} of ${pairs.length} done in ${ms.toFixed(0)} ms`;
    drawResults(r.problems);
  }, 10);
};

function drawResults(problems) {
  const rows = summaryRows(state.results);
  show('resultsPanel');
  clearNote('resultMsgs');

  if (problems.length) {
    note('resultMsgs', 'e', problems.map((p) => `${esc(p.id)}: ${esc(p.message)}`).join('<br>'));
  }
  const noOx = state.results.filter((r) => !r.hasSFDI).length;
  if (noOx && noOx === state.results.length) {
    note('resultMsgs', 'w', 'No haemoglobin files, so flow only. Add the SFDI ROI files for CMRO2.');
  } else if (noOx) {
    note('resultMsgs', 'w', `${noOx} animal(s) had no haemoglobin data, so CMRO2 was skipped for them.`);
  }
  const short = state.results.filter((r) => r.shortBaseline).length;
  if (short) note('resultMsgs', 'w', `${short} recording(s) were shorter than the baseline window. The first ${DEFAULTS.baselineWin} min was used.`);

  if (!rows.length) { $('summary').innerHTML = ''; hide('chartsPanel'); return; }

  const cols = Object.keys(rows[0]);
  $('summary').innerHTML =
    '<tr>' + cols.map((c) => `<th class="${typeof rows[0][c] === 'number' ? 'n' : ''}">${esc(head(c))}</th>`).join('') + '</tr>' +
    rows.map((r) => '<tr>' + cols.map((c) => {
      const v = r[c];
      if (typeof v === 'number') return `<td class="n">${isFinite(v) ? sig(v) : ''}</td>`;
      if (c === 'Oxygen') return `<td class="${v === 'yes' ? 'yes' : 'no'}">${v}</td>`;
      return `<td>${esc(String(v))}</td>`;
    }).join('') + '</tr>').join('');

  drawTabs();
  drawCharts();
  drawFigure();
}

function drawTabs() {
  $('animalTabs').innerHTML = state.results.map((r, i) =>
    `<button aria-selected="${i === state.animal}" data-i="${i}">${esc(r.id)}</button>`).join('');
  $('animalTabs').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { state.animal = +b.dataset.i; drawTabs(); drawCharts(); drawFigure(); };
  });

  const R = state.results[state.animal];
  const opts = R && R.hasSFDI
    ? [['flow', 'Flow'], ['oxygen', 'CMRO2'], ['absolute', 'Absolute'], ['raw', 'Raw']]
    : [['flow', 'Flow'], ['raw', 'Raw']];
  if (!opts.some((o) => o[0] === state.metric)) state.metric = 'flow';

  $('metricTabs').innerHTML = opts.map(([k, l]) =>
    `<button aria-selected="${k === state.metric}" data-k="${k}">${l}</button>`).join('');
  $('metricTabs').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { state.metric = b.dataset.k; drawTabs(); drawCharts(); };
  });
}

function drawCharts() {
  const host = $('charts');
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
  host.innerHTML = '';
  const R = state.results[state.animal];
  if (!R) { hide('chartsPanel'); return; }
  show('chartsPanel');

  const B = cssv('--blue'), O = cssv('--orange');
  const t = Array.from(R.time);
  const add = (c) => state.charts.push(makeChart(host, c));

  if (state.metric === 'flow') {
    add({ title: 'Relative blood flow', yLabel: 'rCBF', x: t,
          series: [{ label: 'rCBF', y: Array.from(R.rCBF), color: B }] });
    add({ title: 'Blood flow, resampled', yLabel: 'SFI', x: Array.from(R.CBFtime),
          series: [{ label: 'CBF', y: Array.from(R.CBFspline), color: B }] });
  } else if (state.metric === 'oxygen') {
    add({ title: 'Relative CMRO2', yLabel: 'rCMRO2', x: t,
          series: [{ label: 'rCMRO2', y: Array.from(R.rCMRO2), color: O }] });
    add({ title: 'rCBF / rCMRO2', yLabel: 'ratio', x: t,
          series: [{ label: 'ratio', y: Array.from(R.rRatio), color: B }] });
    add({ title: 'Flow and CMRO2', yLabel: 'relative', x: t,
          series: [{ label: 'rCBF', y: Array.from(R.rCBF), color: B },
                   { label: 'rCMRO2', y: Array.from(R.rCMRO2), color: O }] });
  } else if (state.metric === 'absolute') {
    add({ title: 'Db, mm2/s', yLabel: 'Db', x: t,
          series: [{ label: 'aCBF', y: Array.from(R.aCBF), color: B }] });
    add({ title: 'Absolute CMRO2, umol O2/min', yLabel: 'aCMRO2', x: t,
          series: [{ label: 'aCMRO2', y: Array.from(R.aCMRO2), color: O }] });
    add({ title: 'Haemoglobin, uM', yLabel: 'uM', x: t,
          series: [{ label: 'HbO2', y: Array.from(R.cthbo2), color: B },
                   { label: 'HbR', y: Array.from(R.cthb), color: O }] });
  } else {
    add({ title: `Raw recording, ${R.CBFraw.length.toLocaleString()} frames`, yLabel: 'SFI',
          x: Array.from(R.CBFrawtime),
          series: [{ label: 'raw', y: Array.from(R.CBFraw), color: B, width: 1 }] });
    add({ title: `After cleaning, ${R.nDespiked} sample(s) replaced`, yLabel: 'SFI',
          x: Array.from(R.CBFtime),
          series: [{ label: 'cleaned', y: Array.from(R.CBFspline), color: O }] });
  }
}


// ---- publication figure ----
const FIG_METRICS = [
  ['rCBF',   'Relative CBF',          (R) => ({ y: R.rCBF,   yLabel: 'rCBF' }),                       () => true],
  ['rCMRO2', 'Relative CMRO2',        (R) => ({ y: R.rCMRO2, yLabel: 'rCMRO_2' }),                (R) => R.hasSFDI],
  ['rRatio', 'rCBF / rCMRO2',         (R) => ({ y: R.rRatio, yLabel: 'rCBF / rCMRO_2' }),         (R) => R.hasSFDI],
  ['aCBF',   'Absolute CBF',          (R) => ({ y: R.aCBF,   yLabel: 'D_b (mm^2 s^{-1})' }), (R) => R.hasSFDI],
  ['aCMRO2', 'Absolute CMRO2',        (R) => ({ y: R.aCMRO2, yLabel: 'CMRO_2 (\u00b5mol min^{-1})' }), (R) => R.hasSFDI],
  ['flow',   'Flow, resampled',       (R) => ({ y: R.CBFspline, x: R.CBFtime, yLabel: 'SFI (a.u.)' }), () => true],
  ['hb',     'Haemoglobin',           null,                                                            (R) => R.hasSFDI],
];

function figOpts() {
  return {
    widthMm: parseFloat($('figWidth').value),
    panelHeightMm: parseFloat($('figHeight').value) || 32,
    fontPt: parseFloat($('figFont').value) || 7,
    lineWidthPt: parseFloat($('figLine').value) || 0.75,
    greyscale: $('figGrey').checked,
    grid: $('figGrid').checked,
    sharedX: $('figShared').checked,
    panelLabels: true,
  };
}

function drawFigure() {
  const R = state.results[state.animal];
  if (!R) { hide('figPanel'); return; }
  show('figPanel');

  const avail = FIG_METRICS.filter((m) => m[3](R));
  state.figPanels = state.figPanels.filter((k) => avail.some((m) => m[0] === k));
  if (!state.figPanels.length) state.figPanels = [avail[0][0]];

  $('figPanels').innerHTML = avail.map(([k, label]) =>
    `<button aria-selected="${state.figPanels.includes(k)}" data-k="${k}">${label}</button>`).join('');
  $('figPanels').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.k;
      const i = state.figPanels.indexOf(k);
      if (i >= 0) { if (state.figPanels.length > 1) state.figPanels.splice(i, 1); }
      else state.figPanels.push(k);
      state.figPanels.sort((a, c) => avail.findIndex((m) => m[0] === a) - avail.findIndex((m) => m[0] === c));
      drawFigure();
    };
  });

  const panels = state.figPanels.map((k) => figPanel(R, k)).filter(Boolean);
  if (!panels.length) { $('figPreview').innerHTML = ''; return; }

  const o = figOpts();
  const svg = FIG.build(panels, o);
  $('figPreview').innerHTML = svg;

  const el = $('figPreview').querySelector('svg');
  const hMm = el ? parseFloat(el.getAttribute('height')) : 0;
  state.figSvg = svg;
  state.figW = o.widthMm;
  state.figH = hMm;
  $('figSize').textContent =
    `${o.widthMm} × ${hMm.toFixed(1)} mm, ${panels.length} panel${panels.length > 1 ? 's' : ''}. ` +
    `SVG keeps text editable; PNG is flattened at the chosen resolution.`;
}

function figPanel(R, key) {
  const t = Array.from(R.time);
  if (key === 'hb') {
    return { yLabel: 'Concentration (\u00b5M)', xLabel: 'Time (min)',
             series: [{ x: t, y: Array.from(R.cthbo2), label: 'HbO_2' },
                      { x: t, y: Array.from(R.cthb),   label: 'HbR' }] };
  }
  const m = FIG_METRICS.find((v) => v[0] === key);
  if (!m || !m[2]) return null;
  const d = m[2](R);
  if (!d.y) return null;
  return { yLabel: d.yLabel, xLabel: 'Time (min)',
           series: [{ x: Array.from(d.x || R.time), y: Array.from(d.y), label: d.yLabel }] };
}

['figWidth','figHeight','figFont','figLine','figGrey','figGrid','figShared'].forEach((id) => {
  $(id).addEventListener('change', drawFigure);
  $(id).addEventListener('input', drawFigure);
});

$('dlSvg').onclick = () => {
  if (!state.figSvg) return;
  const R = state.results[state.animal];
  save(new Blob([state.figSvg], { type: 'image/svg+xml' }), `${R.id}_figure.svg`);
};

$('dlPngHi').onclick = async () => {
  if (!state.figSvg) return;
  const R = state.results[state.animal];
  const dpi = parseInt($('figDpi').value, 10);
  $('dlPngHi').disabled = true;
  try {
    const blob = await FIG.toPNG(state.figSvg, state.figW, state.figH, dpi);
    save(blob, `${R.id}_figure_${dpi}dpi.png`);
  } catch (e) {
    note('resultMsgs', 'e', 'Could not export PNG: ' + esc(e.message));
  }
  $('dlPngHi').disabled = false;
};

// ---- downloads ----
$('dlCsv').onclick = () =>
  save(new Blob([toCSV(summaryRows(state.results))], { type: 'text/csv' }), 'cmro2_summary.csv');

$('dlPng').onclick = () => {
  if (!state.charts.length) return;
  const R = state.results[state.animal];
  chartsToPNG(state.charts, R.id).toBlob((b) => save(b, `${R.id}.png`));
};

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- helpers ----
function show(id) { $(id).classList.remove('hide'); }
function hide(id) { $(id).classList.add('hide'); }
function note(host, kind, html) {
  const d = document.createElement('div');
  d.className = 'note-box ' + kind;
  d.innerHTML = html;
  $(host).appendChild(d);
}
function clearNote(host) { $(host).innerHTML = ''; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function num(v, d) { const n = parseFloat(v); return isFinite(n) ? n : d; }
function cssv(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function sig(v) {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a < 1e-3 || a >= 1e6) return v.toExponential(3);
  return String(+v.toPrecision(5));
}
function head(c) {
  return { mean_rCBF: 'rCBF', mean_rCMRO2: 'rCMRO2', mean_aCBF: 'aCBF', mean_aCMRO2: 'aCMRO2',
           SpikesRemoved: 'replaced', Points: 'points', Oxygen: 'CMRO2', ms: 'ms' }[c] || c;
}
function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

})(window.AK = window.AK || {});
