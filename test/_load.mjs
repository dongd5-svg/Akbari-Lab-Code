// Loads the browser scripts under Node by evaluating them against a stub window.
import { readFileSync } from 'fs';
import vm from 'vm';

const files = ['js/spline.js','js/pipeline.js','js/matfile.js'];
const ctx = { console, TextDecoder, TextEncoder, DataView, Float64Array, Uint8Array, Uint32Array,
  Int32Array, Math, Number, JSON, Object, Array, String, Boolean, Error, isFinite, parseFloat,
  performance, Blob, Response, DecompressionStream, URL, setTimeout, BigInt };
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

// h5wasm ships an IIFE build that assigns a global.
vm.runInContext(readFileSync(new URL('../vendor/h5wasm/h5wasm.js', import.meta.url), 'utf8'), ctx,
  { filename: 'h5wasm.js' });
for (const f of files) {
  vm.runInContext(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), ctx, { filename: f });
}
export const AK = ctx.AK;
export const ctxRef = ctx;
