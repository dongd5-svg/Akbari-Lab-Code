(function (AK) {
'use strict';

// figure.js - vector figures sized for journal submission.
//
// The interactive plots elsewhere are drawn on a canvas, which is fine on
// screen but turns into a fuzzy bitmap in a manuscript. This builds SVG
// instead, laid out in real millimetres, so a figure exported at 85 mm arrives
// in the journal template at exactly 85 mm with text still selectable and
// curves still sharp at any zoom.
//
// Conventions follow what most journals ask for: single column 85 mm, double
// column 170 mm, sans-serif labels at 7 pt, hairline axes, ticks pointing
// outward, no box, no gridlines unless asked.

const PT = 25.4 / 72;              // 1 pt in mm

const PRESETS = {
  single:  85,
  onehalf: 114,
  double:  170,
};

const DEFAULTS = {
  widthMm: 85,
  panelHeightMm: 32,
  fontPt: 7,
  lineWidthPt: 0.75,
  axisWidthPt: 0.5,
  grid: false,
  panelLabels: true,
  greyscale: false,
  sharedX: true,
  colors: ['#0b62a4', '#b8560f'],
  font: 'Helvetica, Arial, sans-serif',
};

// ---------------------------------------------------------------------------
function buildFigure(panels, opt) {
  const o = Object.assign({}, DEFAULTS, opt);
  const f = o.fontPt * PT;                       // label size in mm
  const lw = o.lineWidthPt * PT;
  const aw = o.axisWidthPt * PT;

  const mL = f * 4.4;                            // room for tick labels + title
  const mR = f * 0.8;
  const mT = o.panelLabels ? f * 1.5 : f * 0.6;
  const mB = f * 3.2;
  const gapY = o.sharedX ? f * 1.2 : f * 3.4;

  const plotW = o.widthMm - mL - mR;
  const plotH = o.panelHeightMm;
  const totalH = mT + panels.length * plotH + (panels.length - 1) * gapY + mB;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
    `width="${r(o.widthMm)}mm" height="${r(totalH)}mm" ` +
    `viewBox="0 0 ${r(o.widthMm)} ${r(totalH)}">`);
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  parts.push(`<g font-family="${o.font}" font-size="${r(f)}" fill="#000000">`);

  const xAll = panels.flatMap((p) => p.series.flatMap((s) => [s.x[0], s.x[s.x.length - 1]]));
  const xDomShared = [Math.min(...xAll), Math.max(...xAll)];

  panels.forEach((p, i) => {
    const top = mT + i * (plotH + gapY);
    const xDom = o.sharedX ? xDomShared : spanOf(p.series.map((s) => s.x));
    const yDom = p.yRange || padded(spanOf(p.series.map((s) => s.y)));

    const xt = ticks(xDom[0], xDom[1], 5);
    const yt = ticks(yDom[0], yDom[1], 4);
    const yScaleExp = pickExponent(yt);
    const isLast = i === panels.length - 1;
    const showX = !o.sharedX || isLast;

    const X = (v) => mL + (v - xDom[0]) / (xDom[1] - xDom[0]) * plotW;
    const Y = (v) => top + plotH - (v - yDom[0]) / (yDom[1] - yDom[0]) * plotH;

    if (o.grid) {
      const g = [];
      yt.forEach((v) => g.push(`M${r(mL)},${r(Y(v))}H${r(mL + plotW)}`));
      xt.forEach((v) => g.push(`M${r(X(v))},${r(top)}V${r(top + plotH)}`));
      parts.push(`<path d="${g.join('')}" stroke="#cccccc" stroke-width="${r(aw * 0.7)}" fill="none"/>`);
    }

    // data
    p.series.forEach((s, k) => {
      const stroke = o.greyscale ? (k === 0 ? '#000000' : '#7a7a7a') : (s.color || o.colors[k % o.colors.length]);
      const dash = o.greyscale && k > 0 ? ` stroke-dasharray="${r(lw * 3)},${r(lw * 2)}"` : '';
      parts.push(
        `<path d="${polyline(s.x, s.y, X, Y, plotW)}" fill="none" stroke="${stroke}" ` +
        `stroke-width="${r(lw)}" stroke-linejoin="round" stroke-linecap="round"${dash}/>`);
    });

    // axes: left and bottom only
    parts.push(`<path d="M${r(mL)},${r(top)}V${r(top + plotH)}H${r(mL + plotW)}" ` +
               `fill="none" stroke="#000000" stroke-width="${r(aw)}"/>`);

    // y ticks
    const tk = f * 0.5;
    yt.forEach((v) => {
      const y = Y(v);
      parts.push(`<path d="M${r(mL - tk)},${r(y)}H${r(mL)}" stroke="#000000" stroke-width="${r(aw)}"/>`);
      parts.push(`<text x="${r(mL - tk - f * 0.35)}" y="${r(y + f * 0.35)}" text-anchor="end">` +
                 `${esc(fmtTick(v, yt, yScaleExp))}</text>`);
    });

    // x ticks
    xt.forEach((v) => {
      const x = X(v);
      parts.push(`<path d="M${r(x)},${r(top + plotH)}V${r(top + plotH + tk)}" stroke="#000000" stroke-width="${r(aw)}"/>`);
      if (showX) {
        parts.push(`<text x="${r(x)}" y="${r(top + plotH + tk + f)}" text-anchor="middle">` +
                   `${esc(fmtTick(v, xt, 0))}</text>`);
      }
    });

    // y label, rotated
    const yLab = yScaleExp ? `${p.yLabel} (\u00d710^{${yScaleExp}})` : p.yLabel;
    const yc = top + plotH / 2;
    parts.push(`<text transform="translate(${r(f * 0.95)},${r(yc)}) rotate(-90)" text-anchor="middle">` +
               `${rich(yLab, f)}</text>`);

    if (showX) {
      parts.push(`<text x="${r(mL + plotW / 2)}" y="${r(top + plotH + tk + f * 2.4)}" ` +
                 `text-anchor="middle">${rich(p.xLabel || 'Time (min)', f)}</text>`);
    }

    if (o.panelLabels && panels.length > 1) {
      parts.push(`<text x="${r(f * 0.2)}" y="${r(top - f * 0.45)}" font-weight="bold">` +
                 `${String.fromCharCode(65 + i)}</text>`);
    }

    // legend, only when a panel has more than one series
    if (p.series.length > 1) {
      const lx = mL + plotW, ly = top + f * 0.9;
      const items = p.series.map((s, k) => ({
        label: s.label,
        color: o.greyscale ? (k === 0 ? '#000000' : '#7a7a7a') : (s.color || o.colors[k % o.colors.length]),
        dash: o.greyscale && k > 0,
      }));
      let cx = lx;
      for (let k = items.length - 1; k >= 0; k--) {
        const it = items[k];
        const tw = it.label.length * f * 0.52;
        cx -= tw;
        parts.push(`<text x="${r(cx)}" y="${r(ly + f * 0.35)}" text-anchor="start">${rich(it.label, f)}</text>`);
        cx -= f * 0.4;
        const seg = f * 1.1;
        cx -= seg;
        parts.push(`<path d="M${r(cx)},${r(ly)}h${r(seg)}" stroke="${it.color}" stroke-width="${r(lw)}"` +
                   (it.dash ? ` stroke-dasharray="${r(lw * 3)},${r(lw * 2)}"` : '') + `/>`);
        cx -= f * 0.9;
      }
    }
  });

  parts.push('</g></svg>');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Reduce a trace to at most two points per output column, keeping the min and
// max within each column. Visually identical to plotting every sample, but a
// 12,000 point recording becomes a few hundred path commands instead, which is
// the difference between a 40 kB figure and a 2 MB one that Illustrator chokes
// on.
function polyline(x, y, X, Y, plotWmm) {
  const targetCols = Math.max(120, Math.round(plotWmm * 12));
  const n = x.length;
  const out = [];
  if (n <= targetCols * 2) {
    for (let i = 0; i < n; i++) {
      if (!isFinite(y[i])) continue;
      out.push((out.length ? 'L' : 'M') + r(X(x[i])) + ',' + r(Y(y[i])));
    }
    return out.join('');
  }
  const per = n / targetCols;
  for (let c = 0; c < targetCols; c++) {
    const i0 = Math.floor(c * per), i1 = Math.min(n, Math.floor((c + 1) * per));
    let lo = Infinity, hi = -Infinity, loI = -1, hiI = -1;
    for (let i = i0; i < i1; i++) {
      const v = y[i];
      if (!isFinite(v)) continue;
      if (v < lo) { lo = v; loI = i; }
      if (v > hi) { hi = v; hiI = i; }
    }
    if (loI < 0) continue;
    const first = Math.min(loI, hiI), second = Math.max(loI, hiI);
    for (const i of (first === second ? [first] : [first, second])) {
      out.push((out.length ? 'L' : 'M') + r(X(x[i])) + ',' + r(Y(y[i])));
    }
  }
  return out.join('');
}

function spanOf(arrays) {
  let lo = Infinity, hi = -Infinity;
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (!isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  return [lo, hi];
}

function padded([lo, hi]) {
  const p = (hi - lo) * 0.06;
  return [lo - p, hi + p];
}

// 1-2-5 tick steps
function ticks(lo, hi, target) {
  const raw = (hi - lo) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const first = Math.ceil(lo / step) * step;
  const out = [];
  for (let v = first; v <= hi + step * 1e-6; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

// Journals prefer "3.0" with a "x10^-5" in the axis label over "0.00003" on
// every tick, so pull a common exponent out when the values are small or large.
function pickExponent(tks) {
  const mx = Math.max(...tks.map((t) => Math.abs(t)));
  if (!isFinite(mx) || mx === 0) return 0;
  if (mx >= 1e-2 && mx < 1e4) return 0;
  return Math.floor(Math.log10(mx));
}

function fmtTick(v, tks, exp) {
  const s = exp ? v / Math.pow(10, exp) : v;
  const step = tks.length > 1 ? Math.abs(tks[1] - tks[0]) / (exp ? Math.pow(10, exp) : 1) : Math.abs(s);
  let dp = 0;
  if (step > 0 && step < 1) dp = Math.min(4, Math.ceil(-Math.log10(step)));
  const t = s.toFixed(dp);
  return t === '-0' ? '0' : t;
}


// Turn "rCMRO_2" or "mm^{-1}" into tspans.
//
// Only relative dy shifts are used. Mixing baseline-shift with dy double-counts
// in some renderers and the subscript floats away from its baseline; plain dy
// behaves identically everywhere, including inside a rotated <text>.
function rich(str, f) {
  const s = String(str);
  const runs = [];
  let buf = '', i = 0;
  const push = (kind, text) => { if (text) runs.push({ k: kind, t: text }); };

  while (i < s.length) {
    const c = s[i];
    if ((c === '_' || c === '^') && i + 1 < s.length) {
      let body, adv;
      if (s[i + 1] === '{') {
        const end = s.indexOf('}', i + 2);
        if (end < 0) { buf += c; i++; continue; }
        body = s.slice(i + 2, end); adv = end - i + 1;
      } else { body = s[i + 1]; adv = 2; }
      push('n', buf); buf = '';
      push(c === '_' ? 'sub' : 'sup', body);
      i += adv;
    } else { buf += c; i++; }
  }
  push('n', buf);

  const SUB = f * 0.28, SUP = -f * 0.34;
  let at = 0, out = '';
  for (const run of runs) {
    const want = run.k === 'sub' ? SUB : run.k === 'sup' ? SUP : 0;
    const dy = want - at;
    at = want;
    const size = run.k === 'n' ? '' : ` font-size="${r(f * 0.72)}"`;
    out += `<tspan dy="${r(dy)}"${size}>${esc(run.t)}</tspan>`;
  }
  return out;
}

function r(v) { return Math.round(v * 1000) / 1000; }
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ---------------------------------------------------------------------------
// Rasterise the SVG at a chosen dots-per-inch, for journals that insist on TIFF
// or PNG. 300 dpi is the usual minimum, 600 for line art.
function svgToPNG(svg, widthMm, heightMm, dpi) {
  return new Promise((resolve, reject) => {
    const px = (mm) => Math.round(mm / 25.4 * dpi);
    const img = new Image();
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = px(widthMm); c.height = px(heightMm);
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas export failed'))), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not rasterise the figure')); };
    img.src = url;
  });
}

AK.figure = { build: buildFigure, toPNG: svgToPNG, PRESETS, DEFAULTS };
})(window.AK = window.AK || {});
