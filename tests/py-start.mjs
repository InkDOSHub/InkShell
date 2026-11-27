// item 86: python3.wasm start-up time, 1 run each (node:wasi, compile + instantiate + `import PIL.Image`).
// usage: node tests/py-start.mjs label=file.wasm...
import fs from 'node:fs';
import { WASI } from 'node:wasi';
for (const arg of process.argv.slice(2)) {
  const [label, file] = arg.split('=');
  const t0 = performance.now();
  const mod = await WebAssembly.compile(fs.readFileSync(file));
  const t1 = performance.now();
  const wasi = new WASI({ version: 'preview1', args: ['python3', '-c', 'import PIL.Image'], env: {}, returnOnExit: true });
  const inst = await WebAssembly.instantiate(mod, wasi.getImportObject());
  const rc = wasi.start(inst);
  const t2 = performance.now();
  console.log(`python3 start (${label}): compile ${Math.round(t1 - t0)} ms, run "import PIL.Image" ${Math.round(t2 - t1)} ms, exit ${rc}`);
}
