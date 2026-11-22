// Runs a WASI program in node (reference for phase 2: the kernel will run these directly).
// usage: node tests/bench/wasi/run.mjs PROG.wasm [args...]   (env WASI_DIR = folder at /w)
// Prints the module's WASI imports, then the program output stamped like tests/bench/stamp.mjs,
// then "@@MEM wasm=MB rss=MB".
import fs from 'node:fs';
import { WASI } from 'node:wasi';
const [file, ...args] = process.argv.slice(2);
const dir = process.env.WASI_DIR || fs.mkdtempSync('/tmp/wasi-');
const mod = await WebAssembly.compile(fs.readFileSync(file));
const imp = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
console.error(`@@IMPORTS ${imp.length}: ${imp.join(' ')}`);
const wasi = new WASI({ version: 'preview1', args: [file, ...args], env: { PROBE: 'yes', ...(process.env.WASI_ENV ? Object.fromEntries(process.env.WASI_ENV.split(' ').map((s) => s.split('='))) : {}) }, preopens: { '/w': dir, ...(process.env.WASI_LIB ? { '/usr': process.env.WASI_LIB } : {}) }, returnOnExit: true });
const inst = await WebAssembly.instantiate(mod, wasi.getImportObject());
const t0 = performance.now();
let code = 0;
try { code = wasi.start(inst); } catch (e) { console.error('@@ERR ' + e.message); code = 99; }
const mem = inst.exports.memory?.buffer.byteLength || 0;
console.error(`@@MEM wasm=${(mem / 1048576).toFixed(0)} rss=${(process.memoryUsage().rss / 1048576).toFixed(0)} ms=${(performance.now() - t0).toFixed(0)} exit=${code}`);
process.exit(code);
