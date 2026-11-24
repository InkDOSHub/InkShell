// usage: node known-slots.mjs file.wasm... -> lines for KNOWN in wasi.js (catalog modules' cwdSlot by fastKey)
import fs from 'fs';
import { cwdSlot, fastKey } from '../../wasi.js';
for (const f of process.argv.slice(2)) {
  const b = new Uint8Array(fs.readFileSync(f)), s = cwdSlot(b);
  if (s) console.log(`KNOWN['${fastKey(b)}'] = { ptr: ${s.ptr}, lit: ${s.lit} }; // ${f.split('/').pop()}`);
  else console.error('no slot: ' + f);
}
