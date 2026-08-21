(function (AK) {
'use strict';

// matfile.js — read MATLAB .mat files in the browser.
//
// MATLAB writes two completely different formats and lab folders usually hold
// a mix of both:
//   * v7.3  -- HDF5 underneath. Written when you use save(...,'-v7.3').
//              Your LSI outputs are these.
//   * v5/v7 -- MATLAB's own binary container, zlib-compressed. Written by a
//              plain save(...) with no flag, which is what analyze_roi.m does.
// Both are handled here, so it does not matter which one a file happens to be.
//
// Returns a flat object: { variableName: { data: Float64Array, shape: [r,c] } }
// Struct variables are flattened to "structName.fieldName".

let h5Ready = null;

// h5wasm is loaded as a plain <script>, so it is on the window as `h5wasm`.
// Loading it this way (rather than as a module) is what lets this page work
// when opened straight off disk, where the browser blocks module imports.
async function ensureH5() {
  if (typeof h5wasm === 'undefined') {
    throw new Error('HDF5 reader did not load. Check that vendor/h5wasm/h5wasm.js is present.');
  }
  if (!h5Ready) h5Ready = h5wasm.ready.then(() => h5wasm);
  return h5Ready;
}

const isHDF5 = (bytes) =>
  bytes.length > 512 &&
  // MATLAB puts its 128-byte header first, then the HDF5 signature at 512.
  (sig(bytes, 512) || sig(bytes, 0));

function sig(b, at) {
  return b[at] === 0x89 && b[at+1] === 0x48 && b[at+2] === 0x44 && b[at+3] === 0x46 &&
         b[at+4] === 0x0d && b[at+5] === 0x0a && b[at+6] === 0x1a && b[at+7] === 0x0a;
}

async function readMat(arrayBuffer, fileName = 'file.mat') {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 128) throw new Error('File is too small to be a .mat file.');

  if (isHDF5(bytes)) return readHDF5(bytes, fileName);

  const hdr = new TextDecoder('latin1').decode(bytes.subarray(0, 116));
  if (!/MATLAB/i.test(hdr)) {
    throw new Error('This does not look like a MATLAB .mat file.');
  }
  return readV5(bytes);
}

// ---------------------------------------------------------------------------
// v7.3 / HDF5
async function readHDF5(bytes, fileName) {
  const H = await ensureH5();
  const tmp = `/tmp_${Math.random().toString(36).slice(2)}.mat`;
  H.FS.writeFile(tmp, bytes);
  const out = {};
  let f;
  try {
    f = new H.File(tmp, 'r');
    walkH5(f, '', out);
  } finally {
    try { f && f.close(); } catch {}
    try { H.FS.unlink(tmp); } catch {}
  }
  return out;
}

function walkH5(group, prefix, out, depth = 0) {
  if (depth > 4) return;
  for (const key of group.keys()) {
    if (key.startsWith('#')) continue;              // MATLAB internal refs
    let item;
    try { item = group.get(key); } catch { continue; }
    const name = prefix ? `${prefix}.${key}` : key;

    if (item && typeof item.keys === 'function') {  // a group -> struct
      walkH5(item, name, out, depth + 1);
      continue;
    }
    if (!item || item.value == null) continue;

    const v = item.value;
    if (typeof v === 'string' || Array.isArray(v)) continue;   // char data etc.
    const shape = item.shape || [v.length];
    // MATLAB stores column-major; HDF5 reports the reversed shape.
    out[name] = { data: Float64Array.from(v), shape: [...shape].reverse() };
  }
}

// ---------------------------------------------------------------------------
// v5 / v7
const miINT8=1, miUINT8=2, miINT16=3, miUINT16=4, miINT32=5, miUINT32=6,
      miSINGLE=7, miDOUBLE=9, miINT64=12, miUINT64=13, miMATRIX=14,
      miCOMPRESSED=15, miUTF8=16;

const mxCELL=1, mxSTRUCT=2, mxCHAR=4, mxDOUBLE=6, mxSINGLE=7,
      mxINT8=8, mxUINT8=9, mxINT16=10, mxUINT16=11, mxINT32=12, mxUINT32=13,
      mxINT64=14, mxUINT64=15;

async function readV5(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endianTag = String.fromCharCode(bytes[126], bytes[127]);
  const little = endianTag !== 'MI';       // 'IM' => little-endian

  const out = {};
  let pos = 128;
  while (pos + 8 <= bytes.length) {
    const { type, nbytes, headerLen } = readTag(dv, pos, little);
    if (nbytes === 0 && type === 0) break;
    const body = pos + headerLen;

    if (type === miCOMPRESSED) {
      const raw = bytes.subarray(body, body + nbytes);
      const inflated = await inflate(raw);
      const idv = new DataView(inflated.buffer, inflated.byteOffset, inflated.byteLength);
      const t2 = readTag(idv, 0, little);
      if (t2.type === miMATRIX) parseMatrix(idv, t2.headerLen, t2.nbytes, little, out, '');
    } else if (type === miMATRIX) {
      parseMatrix(dv, body, nbytes, little, out, '');
    }
    pos = body + nbytes;
    // Ordinary data elements are padded out to an 8-byte boundary, but
    // compressed elements are NOT -- the next one starts immediately. Padding
    // them anyway makes every variable after the first unreadable.
    if (type !== miCOMPRESSED) pos += (8 - (pos % 8)) % 8;
  }
  return out;
}

function readTag(dv, pos, little) {
  const w = dv.getUint32(pos, little);
  // Small-data-element format packs nbytes into the upper 16 bits.
  if ((w >>> 16) !== 0) {
    return { type: w & 0xffff, nbytes: w >>> 16, headerLen: 4, small: true };
  }
  return { type: w, nbytes: dv.getUint32(pos + 4, little), headerLen: 8, small: false };
}

function parseMatrix(dv, pos, nbytes, little, out, prefix) {
  const end = pos + nbytes;

  // 1. array flags
  let t = readTag(dv, pos, little);
  let p = pos + t.headerLen;
  const flagsWord = dv.getUint32(p, little);
  const cls = flagsWord & 0xff;
  p = advance(p, t.nbytes);

  // 2. dimensions
  t = readTag(dv, p, little);
  p += t.headerLen;
  const nd = t.nbytes / 4;
  const dims = [];
  for (let i = 0; i < nd; i++) dims.push(dv.getInt32(p + i * 4, little));
  p = advance(p, t.nbytes);

  // 3. name
  t = readTag(dv, p, little);
  p += t.headerLen;
  let name = '';
  for (let i = 0; i < t.nbytes; i++) name += String.fromCharCode(dv.getUint8(p + i));
  p = advance(p, t.nbytes);

  const full = prefix ? `${prefix}.${name}` : name;

  if (cls === mxSTRUCT) {
    // field name length
    t = readTag(dv, p, little);
    p += t.headerLen;
    const fieldLen = dv.getInt32(p, little);
    p = advance(p, t.nbytes);
    // field names
    t = readTag(dv, p, little);
    p += t.headerLen;
    const nFields = t.nbytes / fieldLen;
    const names = [];
    for (let i = 0; i < nFields; i++) {
      let s = '';
      for (let j = 0; j < fieldLen; j++) {
        const c = dv.getUint8(p + i * fieldLen + j);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      names.push(s);
    }
    p = advance(p, t.nbytes);
    // each field is a miMATRIX
    for (let i = 0; i < nFields && p < end; i++) {
      const ft = readTag(dv, p, little);
      const fBody = p + ft.headerLen;
      if (ft.type === miMATRIX) {
        parseMatrixNamed(dv, fBody, ft.nbytes, little, out, full, names[i]);
      }
      p = advance(fBody, ft.nbytes);
    }
    return;
  }

  if (cls === mxCHAR || cls === mxCELL) return;      // not needed downstream

  // 4. numeric payload
  t = readTag(dv, p, little);
  p += t.headerLen;
  const data = readNumeric(dv, p, t.type, t.nbytes, little);
  if (data) out[full] = { data, shape: dims };
}

// Same as parseMatrix but the name comes from the parent struct's field list.
function parseMatrixNamed(dv, pos, nbytes, little, out, prefix, fieldName) {
  const sub = {};
  parseMatrix(dv, pos, nbytes, little, sub, '');
  for (const k of Object.keys(sub)) {
    const clean = k.replace(/^\./, '');
    out[`${prefix}.${fieldName}${clean ? '.' + clean : ''}`] = sub[k];
  }
}

function advance(p, nbytes) {
  const q = p + nbytes;
  return q + ((8 - (q % 8)) % 8);
}

function readNumeric(dv, p, type, nbytes, little) {
  let n, get;
  switch (type) {
    case miDOUBLE: n = nbytes / 8; get = (i) => dv.getFloat64(p + i * 8, little); break;
    case miSINGLE: n = nbytes / 4; get = (i) => dv.getFloat32(p + i * 4, little); break;
    case miINT8:   n = nbytes;     get = (i) => dv.getInt8(p + i); break;
    case miUINT8:  n = nbytes;     get = (i) => dv.getUint8(p + i); break;
    case miINT16:  n = nbytes / 2; get = (i) => dv.getInt16(p + i * 2, little); break;
    case miUINT16: n = nbytes / 2; get = (i) => dv.getUint16(p + i * 2, little); break;
    case miINT32:  n = nbytes / 4; get = (i) => dv.getInt32(p + i * 4, little); break;
    case miUINT32: n = nbytes / 4; get = (i) => dv.getUint32(p + i * 4, little); break;
    case miINT64:  n = nbytes / 8; get = (i) => Number(dv.getBigInt64(p + i * 8, little)); break;
    case miUINT64: n = nbytes / 8; get = (i) => Number(dv.getBigUint64(p + i * 8, little)); break;
    default: return null;
  }
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = get(i);
  return a;
}

async function inflate(raw) {
  // zlib-wrapped deflate. Available natively in browsers and Node 18+.
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([raw]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Pull a named variable out, tolerating the several spellings your files use.
function pickVariable(vars, candidates) {
  const keys = Object.keys(vars);
  for (const want of candidates) {
    const exact = keys.find((k) => k === want);
    if (exact) return { key: exact, ...vars[exact] };
  }
  for (const want of candidates) {
    const tail = keys.find((k) => k.split('.').pop() === want);
    if (tail) return { key: tail, ...vars[tail] };
  }
  for (const want of candidates) {
    const ci = keys.find((k) => k.toLowerCase() === want.toLowerCase());
    if (ci) return { key: ci, ...vars[ci] };
  }
  return null;
}

AK.readMat = readMat;
AK.pickVariable = pickVariable;
})(window.AK = window.AK || {});
