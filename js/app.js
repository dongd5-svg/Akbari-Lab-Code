(function (AK) {
'use strict';

var inspectFile = AK.inspectFile, pairFiles = AK.pairFiles, runAll = AK.runAll;
var summaryRows = AK.summaryRows, toCSV = AK.toCSV, DEFAULTS = AK.DEFAULTS;
var allTraceRows = AK.allTraceRows;
var makeChart = AK.makeChart, chartsToPNG = AK.chartsToPNG;
var FIG = AK.figure, GR = AK.groups;

const GROUP_COLORS = ['#0b62a4', '#b8560f', '#117733', '#882255', '#44aa99', '#999933', '#332288'];

const $ = (id) => document.getElementById(id);
const state = { files: [], results: [], charts: [], animal: 0, metric: 'flow',
                figPanels: ['rCBF', 'rCMRO2'],
                assign: {}, view: 'animal', cmpA: '', cmpB: '', touched: false };

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
  state.files = []; state.results = []; state.assign = {}; state.touched = false;
  state.view = 'animal';
  drawFiles(); hide('resultsPanel'); hide('chartsPanel'); hide('groupsPanel'); hide('figPanel');
  show('blank');
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

  if (!state.touched) {
    const g = GR.guessGroups(state.files);
    if (Object.keys(g).length) state.assign = g;
  }

  tbl.innerHTML = state.files.map((f) => {
    const kind = f.kind === 'lsi' ? '<span class="lsi">flow</span>'
               : f.kind === 'sfdi' ? '<span class="sfdi">haemoglobin</span>'
               : '<span class="bad">not usable</span>';
    const bits = [];
    if (f.animal) bits.push(esc(f.animal));
    if (f.nSamples) bits.push(f.nSamples.toLocaleString() + ' samples');
    if (f.error) bits.push(`<span class="bad">${esc(f.error)}</span>`);
    else if (f.kind === 'unknown') {
      bits.push('found ' + (f.varNames.length ? esc(f.varNames.slice(0, 3).join(', ')) : 'nothing'));
    } else if (!used.has(f.name)) bits.push('<span class="bad">unpaired</span>');

    const grp = f.kind === 'unknown' ? ''
      : `<input class="grp" data-a="${esc(f.animal)}" value="${esc(state.assign[f.animal] || '')}" ` +
        `placeholder="group" aria-label="Group for ${esc(f.animal)}">`;

    return `<tr><td class="fname"><span class="nm mono" title="${esc(f.name)}">${esc(f.name)}</span>` +
           `<span class="sub">${bits.join(' · ')}</span></td>` +
           `<td class="kind">${kind}</td><td class="grpcell">${grp}</td></tr>`;
  }).join('');

  bindGroupInputs();

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
  hide('blank');
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

  drawGroups();
  drawTabs();
  drawCharts();
  drawFigure();
}

function drawTabs() {
  const gs = currentGroups();
  if (!gs.length && state.view === 'groups') state.view = 'animal';

  const tabs = [];
  if (gs.length) {
    tabs.push(`<button aria-selected="${state.view === 'groups'}" data-g="1">Groups</button>`);
  }
  state.results.forEach((r, i) => {
    const on = state.view === 'animal' && i === state.animal;
    tabs.push(`<button aria-selected="${on}" data-i="${i}">${esc(r.id)}</button>`);
  });
  $('animalTabs').innerHTML = tabs.join('');
  $('animalTabs').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.g) state.view = 'groups';
      else { state.view = 'animal'; state.animal = +b.dataset.i; }
      drawTabs(); drawCharts(); drawFigure();
    };
  });

  const grouped = gs.flatMap((g) => g.members);
  const anyOx = state.view === 'groups'
    ? grouped.some((r) => r.hasSFDI)
    : !!(state.results[state.animal] && state.results[state.animal].hasSFDI);

  let opts = anyOx
    ? [['flow', 'Flow'], ['oxygen', 'CMRO2'], ['absolute', 'Absolute'], ['raw', 'Raw']]
    : [['flow', 'Flow'], ['raw', 'Raw']];
  if (state.view === 'groups') opts = opts.filter((o) => o[0] !== 'raw');
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

  if (state.view === 'groups') { drawGroupCharts(host); return; }

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

function drawGroupCharts(host) {
  const gs = currentGroups();
  if (!gs.length) { hide('chartsPanel'); return; }
  show('chartsPanel');

  const keys = state.metric === 'flow' ? ['rCBF']
             : state.metric === 'oxygen' ? ['rCMRO2', 'rRatio']
             : ['aCBF', 'aCMRO2'];

  for (const key of keys) {
    const m = GR.METRICS.find((v) => v.key === key);
    const tr = GR.groupTraces(gs, key);
    if (!tr) continue;
    const series = tr.series.map((sr) => ({
      label: `${sr.name} (n=${sr.n})`,
      y: Array.from(sr.mean),
      color: GROUP_COLORS[gs.findIndex((g) => g.name === sr.name) % GROUP_COLORS.length],
      band: { lo: Array.from(sr.lo), hi: Array.from(sr.hi) },
    }));
    state.charts.push(makeChart(host, {
      title: `${m.label}, mean ± SEM`, yLabel: key, x: Array.from(tr.x), series,
    }));
  }

  if (!state.charts.length) {
    note('resultMsgs', 'w', 'Nothing to average for these groups yet.');
  }
}

// ---- groups ----
function bindGroupInputs() {
  const boxes = [...$('fileTable').querySelectorAll('input.grp')];
  boxes.forEach((el) => {
    el.oninput = () => {
      const a = el.dataset.a;
      state.touched = true;
      state.assign[a] = el.value;
      boxes.forEach((o) => { if (o !== el && o.dataset.a === a) o.value = el.value; });
      clearTimeout(state.grpTimer);
      state.grpTimer = setTimeout(() => {
        drawGroups();
        if (state.view === 'groups') { drawTabs(); drawCharts(); }
        drawFigure();
      }, 250);
    };
  });
}

function currentGroups() { return GR.groupsOf(state.results, state.assign); }

function drawGroups() {
  const gs = currentGroups();
  if (!state.results.length || !gs.length) { hide('groupsPanel'); return; }
  show('groupsPanel');
  clearNote('groupMsgs');

  const placed = gs.reduce((n, g) => n + g.members.length, 0);
  const left = state.results.length - placed;
  if (left) note('groupMsgs', 'i', `${left} animal(s) have no group and are left out of the comparison.`);

  const rows = GR.groupStatRows(gs);
  $('groupTable').innerHTML =
    '<tr><th>Group</th><th>Metric</th><th class="n">n</th><th class="n">mean</th>' +
    '<th class="n">SD</th><th class="n">SEM</th></tr>' +
    rows.map((r, i) => {
      const first = i === 0 || rows[i - 1].Group !== r.Group;
      const swatch = first
        ? `<i class="gkey" style="background:${GROUP_COLORS[gs.findIndex((g) => g.name === r.Group) % GROUP_COLORS.length]}"></i>${esc(r.Group)}`
        : '';
      return `<tr><td>${swatch}</td><td>${esc(r.Metric)}</td><td class="n">${r.n}</td>` +
             `<td class="n">${sig(r.Mean)}</td><td class="n">${isFinite(r.SD) ? sig(r.SD) : ''}</td>` +
             `<td class="n">${isFinite(r.SEM) ? sig(r.SEM) : ''}</td></tr>`;
    }).join('');

  drawComparison(gs);
}

function drawComparison(gs) {
  const names = gs.map((g) => g.name);
  if (names.length < 2) {
    $('cmpRow').hidden = true;
    $('statsTable').innerHTML = '';
    $('statsNote').textContent = '';
    return;
  }
  $('cmpRow').hidden = false;
  if (!names.includes(state.cmpA)) state.cmpA = names[0];
  if (!names.includes(state.cmpB) || state.cmpB === state.cmpA) {
    state.cmpB = names.find((n) => n !== state.cmpA);
  }
  for (const [id, cur] of [['cmpA', state.cmpA], ['cmpB', state.cmpB]]) {
    $(id).innerHTML = names.map((n) =>
      `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }

  const A = gs.find((g) => g.name === state.cmpA);
  const B = gs.find((g) => g.name === state.cmpB);
  const rows = GR.compareGroups(A, B);
  state.cmpRows = rows.map((r) => ({
    Metric: r.Metric, GroupA: A.name, nA: r.nA, meanA: r.meanA, semA: r.semA,
    GroupB: B.name, nB: r.nB, meanB: r.meanB, semB: r.semB,
    Difference: r.diff, t: r.t, df: r.df, p_ttest: r.pT, U: r.U, p_MannWhitney: r.pU,
  }));

  $('statsTable').innerHTML =
    `<tr><th>Metric</th><th class="n">${esc(A.name)}</th><th class="n">${esc(B.name)}</th>` +
    '<th class="n">difference</th><th class="n">t (df)</th><th class="n">p, t-test</th>' +
    '<th class="n">p, Mann-Whitney</th></tr>' +
    rows.map((r) => {
      const cell = (m, sem, n) => isFinite(m)
        ? `${sig(m)}${isFinite(sem) ? ' ± ' + sig(sem) : ''} <span class="dim">(${n})</span>` : '';
      const pc = (p) => isFinite(p)
        ? `<td class="n${p < 0.05 ? ' sigp' : ''}">${p < 1e-4 ? p.toExponential(1) : p.toFixed(4)}</td>`
        : '<td class="n"></td>';
      return `<tr><td>${esc(r.Metric)}</td>` +
             `<td class="n">${cell(r.meanA, r.semA, r.nA)}</td>` +
             `<td class="n">${cell(r.meanB, r.semB, r.nB)}</td>` +
             `<td class="n">${isFinite(r.diff) ? sig(r.diff) : ''}</td>` +
             `<td class="n">${isFinite(r.t) ? r.t.toFixed(3) + ' (' + r.df.toFixed(1) + ')' : ''}</td>` +
             pc(r.pT) + pc(r.pU) + '</tr>';
    }).join('');

  const anyExact = rows.some((r) => r.exact);
  $('statsNote').textContent =
    'Welch t-test and Mann-Whitney, run on the per-animal means, so n is animals rather than ' +
    'timepoints. ' + (anyExact ? 'Mann-Whitney p values are exact at these sample sizes. ' : '') +
    'No correction is applied for testing several metrics at once.';
}

['cmpA', 'cmpB'].forEach((id) => {
  $(id).onchange = () => {
    state[id] = $(id).value;
    drawComparison(currentGroups());
  };
});

$('dlGrpStats').onclick = () => {
  const rows = GR.groupStatRows(currentGroups());
  if (rows.length) save(new Blob([toCSV(rows)], { type: 'text/csv' }), 'group_stats.csv');
};
$('dlGrpTrace').onclick = () => {
  const rows = GR.groupTraceRows(currentGroups());
  if (rows.length) save(new Blob([toCSV(rows)], { type: 'text/csv' }), 'group_traces.csv');
};
$('dlGrpCmp').onclick = () => {
  if (state.cmpRows && state.cmpRows.length) {
    save(new Blob([toCSV(state.cmpRows)], { type: 'text/csv' }), 'group_comparison.csv');
  }
};

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
  const gs = currentGroups();
  $('figGroupsWrap').hidden = gs.length === 0;
  if (!gs.length) $('figGroups').checked = false;
  const asGroups = gs.length > 0 && $('figGroups').checked;

  const R = state.results[state.animal];
  if (!R && !asGroups) { hide('figPanel'); return; }
  show('figPanel');

  const grouped = gs.flatMap((g) => g.members);
  const avail = asGroups
    ? FIG_METRICS.filter((m) => GR.METRICS.some((v) => v.key === m[0]) && grouped.some((r) => m[3](r)))
    : FIG_METRICS.filter((m) => m[3](R));
  if (!avail.length) { $('figPreview').innerHTML = ''; return; }
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

  const panels = (asGroups
    ? state.figPanels.map((k) => groupFigPanel(gs, k))
    : state.figPanels.map((k) => figPanel(R, k))).filter(Boolean);
  if (!panels.length) { $('figPreview').innerHTML = ''; return; }

  const o = figOpts();
  const svg = FIG.build(panels, o);
  $('figPreview').innerHTML = svg;

  const el = $('figPreview').querySelector('svg');
  const hMm = el ? parseFloat(el.getAttribute('height')) : 0;
  state.figSvg = svg;
  state.figW = o.widthMm;
  state.figH = hMm;
  state.figName = asGroups ? 'groups' : R.id;
  $('figSize').textContent =
    `${o.widthMm} × ${hMm.toFixed(1)} mm, ${panels.length} panel${panels.length > 1 ? 's' : ''}` +
    (asGroups ? ', group mean ± SEM' : '') + '. ' +
    `SVG keeps text editable; PNG is flattened at the chosen resolution.`;
}

function groupFigPanel(gs, key) {
  const m = GR.METRICS.find((v) => v.key === key);
  const tr = GR.groupTraces(gs, key);
  if (!m || !tr) return null;
  const x = Array.from(tr.x);
  return {
    yLabel: m.yLabel, xLabel: 'Time (min)',
    series: tr.series.map((sr) => ({
      x, y: Array.from(sr.mean), lo: Array.from(sr.lo), hi: Array.from(sr.hi),
      label: `${sr.name} (n=${sr.n})`,
      color: GROUP_COLORS[gs.findIndex((g) => g.name === sr.name) % GROUP_COLORS.length],
    })),
  };
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

['figWidth','figHeight','figFont','figLine','figGrey','figGrid','figShared','figGroups'].forEach((id) => {
  $(id).addEventListener('change', drawFigure);
  $(id).addEventListener('input', drawFigure);
});

$('dlSvg').onclick = () => {
  if (!state.figSvg) return;
  save(new Blob([state.figSvg], { type: 'image/svg+xml' }), `${state.figName}_figure.svg`);
};

$('dlPngHi').onclick = async () => {
  if (!state.figSvg) return;
  const dpi = parseInt($('figDpi').value, 10);
  $('dlPngHi').disabled = true;
  try {
    const blob = await FIG.toPNG(state.figSvg, state.figW, state.figH, dpi);
    save(blob, `${state.figName}_figure_${dpi}dpi.png`);
  } catch (e) {
    note('resultMsgs', 'e', 'Could not export PNG: ' + esc(e.message));
  }
  $('dlPngHi').disabled = false;
};

// ---- downloads ----
$('dlCsv').onclick = () =>
  save(new Blob([toCSV(summaryRows(state.results, state.assign))], { type: 'text/csv' }), 'summary.csv');

$('dlData').onclick = () => {
  const rows = allTraceRows(state.results, state.assign);
  if (!rows.length) return;
  const name = state.results.length === 1 ? `${state.results[0].id}_data.csv` : 'all_animals_data.csv';
  save(new Blob([toCSV(rows)], { type: 'text/csv' }), name);
};

$('dlPng').onclick = () => {
  if (!state.charts.length) return;
  const name = state.view === 'groups' ? 'groups' : state.results[state.animal].id;
  chartsToPNG(state.charts, name).toBlob((b) => save(b, `${name}.png`));
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
