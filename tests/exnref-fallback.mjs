// Item 89: a module needing exnref on an engine without it must end with exit 126 and a clear message
// (not a cryptic crash); with exnref it runs normally.
import { runModule, hasExnref } from '../wasi.js';
// (module (func (export "_start") (local exnref))): compile fails where exnref is unknown
const bytes = new Uint8Array([0,0x61,0x73,0x6d,1,0,0,0, 1,4,1,0x60,0,0, 3,2,1,0, 7,10,1,6,0x5f,0x73,0x74,0x61,0x72,0x74,0,0, 10,6,1,4,1,1,0x69,0x0b]);
const run = () => { let err = '';
  const sys = (nr, a, d) => { if (nr === 1 && a[0] === 2) err += new TextDecoder().decode(d); return { r: 0, out: null }; };
  return { code: runModule({ bytes, args: ['awk'], envs: [], base: 0, size: 65536, sys }), err }; };
const a = run(); // natural: whatever this engine does
console.log('exnref supported:', hasExnref(), 'code:', a.code, a.err.trim());
if (hasExnref() ? a.code !== 0 : (a.code !== 126 || !/exception handling/.test(a.err))) { console.error('FAIL natural run'); process.exit(1); }
globalThis.INKSHELL_NO_EXNREF = 1; // forced off: always the clear message
const b = run();
console.log('forced off: code', b.code, b.err.trim());
if (b.code !== 126 || !/exception handling/.test(b.err)) { console.error('FAIL forced run'); process.exit(1); }
console.log('ok');
