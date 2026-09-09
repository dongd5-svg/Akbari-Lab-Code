(function (AK) {
'use strict';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// drawClear, so the band ends up under the grid and curves rather than over them.
function bandPlugin(bands) {
  return { hooks: { drawClear: [(u) => {
    const ctx = u.ctx, xs = u.data[0];
    ctx.save();
    ctx.beginPath();
    ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
    ctx.clip();
    for (const b of bands) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < xs.length; i++) {
        if (!isFinite(b.hi[i])) continue;
        const x = u.valToPos(xs[i], 'x', true), y = u.valToPos(b.hi[i], 'y', true);
        if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
      }
      if (!started) continue;
      for (let i = xs.length - 1; i >= 0; i--) {
        if (!isFinite(b.lo[i])) continue;
        ctx.lineTo(u.valToPos(xs[i], 'x', true), u.valToPos(b.lo[i], 'y', true));
      }
      ctx.closePath();
      ctx.fillStyle = b.color;
      ctx.fill();
    }
    ctx.restore();
  }] } };
}

function makeChart(el, { title, subtitle, x, series, yLabel }) {
  const card = document.createElement('div');
  card.className = 'plot';
  card.innerHTML =
    `<h3>${title}</h3>` +
    (series.length > 1
      ? `<div class="key">${series
          .map((s) => `<span><i style="background:${s.color}"></i>${s.label}&nbsp;&nbsp;</span>`)
          .join('')}</div>`
      : '');
  const holder = document.createElement('div');
  card.appendChild(holder);
  el.appendChild(card);

  const width = () => Math.max(280, card.clientWidth - 24);

  const bands = series.filter((s) => s.band).map((s) => ({
    lo: s.band.lo, hi: s.band.hi, color: fade(s.color, 0.16),
  }));
  let bLo = Infinity, bHi = -Infinity;
  for (const b of bands) {
    for (let i = 0; i < b.lo.length; i++) {
      if (isFinite(b.lo[i]) && b.lo[i] < bLo) bLo = b.lo[i];
      if (isFinite(b.hi[i]) && b.hi[i] > bHi) bHi = b.hi[i];
    }
  }

  const opts = {
    width: width(),
    height: 210,
    padding: [8, 12, 0, 0],
    cursor: { drag: { x: true, y: false }, points: { size: 6 } },
    plugins: bands.length ? [bandPlugin(bands)] : [],
    scales: {
      x: { time: false },
      y: bands.length
        ? { range: (u, lo, hi) => uPlot.rangeNum(Math.min(lo, bLo), Math.max(hi, bHi), 0.1, true) }
        : {},
    },
    axes: [
      axis('Time (min)'),
      axis(yLabel, true),
    ],
    series: [
      { label: 'Time (min)', value: (u, v) => (v == null ? '--' : v.toFixed(3)) },
      ...series.map((s) => ({
        label: s.label,
        stroke: s.color,
        width: s.width ?? 1.6,
        dash: s.dash,
        points: { show: false },
        value: (u, v) => (v == null ? '--' : fmt(v)),
      })),
    ],
  };

  const u = new uPlot(opts, [x, ...series.map((s) => s.y)], holder);
  const ro = new ResizeObserver(() => u.setSize({ width: width(), height: 210 }));
  ro.observe(card);
  return { uplot: u, card, destroy: () => { ro.disconnect(); u.destroy(); } };
}

function axis(label, isY = false) {
  return {
    label,
    values: (u, ticks) => {
      const mag = Math.max(...ticks.map((t) => Math.abs(t)).filter((v) => v > 0), 0);
      if (mag > 0 && (mag < 1e-3 || mag >= 1e5)) {
        return ticks.map((t) => (t === 0 ? '0' : t.toExponential(1).replace('e', 'e')));
      }
      const span = Math.max(...ticks) - Math.min(...ticks);
      const dp = span > 0 ? Math.max(0, Math.min(6, Math.ceil(-Math.log10(span)) + 2)) : 2;
      return ticks.map((t) => t.toFixed(dp));
    },
    labelSize: 30,
    labelFont: '12px -apple-system, system-ui, sans-serif',
    font: '11px -apple-system, system-ui, sans-serif',
    stroke: () => css('--ink-3'),
    grid: { stroke: () => css('--grid'), width: 1 },
    ticks: { stroke: () => css('--grid'), width: 1 },
    size: isY ? 58 : 42,
  };
}

function fade(c, alpha) {
  const m = String(c).trim().match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const rgb = String(c).match(/(\d+)\D+(\d+)\D+(\d+)/);
  return rgb ? `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${alpha})` : `rgba(120,120,120,${alpha})`;
}

function fmt(v) {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a < 1e-3 || a >= 1e5) return v.toExponential(3);
  return v.toPrecision(6).replace(/\.?0+$/, '');
}

function chartsToPNG(charts, titleText) {
  const gap = 14, pad = 18, headH = titleText ? 34 : 0;
  const cs = charts.map((c) => c.uplot.ctx.canvas);
  const w = Math.max(...cs.map((c) => c.width));
  const h = cs.reduce((s, c) => s + c.height + gap, 0) - gap;

  const out = document.createElement('canvas');
  out.width = w + pad * 2;
  out.height = h + pad * 2 + headH;
  const g = out.getContext('2d');
  g.fillStyle = css('--panel') || '#fff';
  g.fillRect(0, 0, out.width, out.height);

  if (titleText) {
    g.fillStyle = css('--ink') || '#000';
    g.font = '600 15px -apple-system, system-ui, sans-serif';
    g.fillText(titleText, pad, pad + 16);
  }
  let y = pad + headH;
  for (const c of cs) { g.drawImage(c, pad, y); y += c.height + gap; }
  return out;
}

AK.makeChart = makeChart;
AK.chartsToPNG = chartsToPNG;
})(window.AK = window.AK || {});
