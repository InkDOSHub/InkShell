// Table of the big-file run (bench.sh wasmio MB): the catalog's WebAssembly zip, unzip, 7zz (and
// busybox sha256sum as reference) on the engine vs the same tools on the runner: time, x native and
// peak memory (program's linear memory, engine heap, the swap that holds the Linux disk, node RSS).
// usage: node tests/bench/bigwasm.mjs wasiprof.json engine.log native.log > bigwasm.md
import fs from 'node:fs';
const [jf, lf, nf] = process.argv.slice(2);
let J = { progs: [] };
try { J = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch {}
const MB = (b) => (b == null ? '—' : (b / 1048576).toFixed(0));
// "@@T begin:w-..." intervals, engine heap/swap at the end marker, native "@@RSS name KB"
const read = (f) => {
  const o = {}, r = {}, rss = {};
  if (!f || !fs.existsSync(f)) return { r, rss };
  for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
    const [t, l = '', heap, swap] = raw.split('\t'); let m;
    const at = (m) => (m[2] ? m[2] / 1e6 : +t);
    if ((m = /^@@T begin:(w-\S+)(?: (\d{12,}))?/.exec(l))) o[m[1]] = at(m);
    else if ((m = /^@@T end:(w-\S+)(?: (\d{12,}))?/.exec(l)) && o[m[1]] != null) r[m[1]] = { b: o[m[1]], e: at(m), heap: +heap, swap: +swap };
    else if ((m = /^@@RSS (\S+) (\d+)/.exec(l))) rss[m[1]] = +m[2] / 1024;
  }
  return { r, rss };
};
const E = read(lf), N = read(nf);
const s = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(1) + ' s');
const LABEL = { sha256: '`sha256sum` (busybox x86; ref.)', zip: '`zip -1` (WASM)', '7za': '`7zz a -mx1` (WASM)', unzip: '`unzip` (WASM)', '7zx': '`7zz x` (WASM)', make: 'gerar arquivo (busybox x86)' };
const names = Object.keys(E.r).length ? Object.keys(E.r) : Object.keys(N.r);
if (!names.length) { console.log('_Arquivo grande: sem marcadores w-* (o motor não rodou o wasmio?)._'); process.exit(0); }
let md = '| passo | motor | nativo | x nativo | MB/s motor | memória linear WASM (pico) | heap motor | swap (disco Linux) | RSS node (pico no programa) | RSS nativo | fd_read: n / máx por chamada / total | fd_write: n / máx / total |\n|---|' + '---:|'.repeat(11) + '\n';
for (const k of names) {
  const e = E.r[k], n = N.r[k], [, step, mb] = k.split('-');
  const p = e && J.progs.find((q) => q.tStart >= e.b && q.tStart <= e.e);
  const ms = e && e.e - e.b, nat = n && n.e - n.b;
  const io = (c) => (c ? `${c.n} / ${c.max != null ? (c.max / 1024).toFixed(0) + ' KB' : '—'} / ${MB(c.bytes)} MB` : '—');
  md += `| ${LABEL[step] || step} ${mb} MB | ${s(ms)} | ${s(nat)} | ${ms && nat ? (ms / nat).toFixed(1) + 'x' : '—'} | ${ms ? (+mb / (ms / 1000)).toFixed(0) : '—'} | ${p ? MB(p.mem1) + ' MB' : '—'} | ${e ? e.heap + ' MB' : '—'} | ${e ? e.swap + ' MB' : '—'} | ${p ? MB(p.rssMax) + ' MB' : '—'} | ${N.rss[k] != null ? N.rss[k].toFixed(0) + ' MB' : '—'} | ${p ? io(p.calls.fd_read || p.calls.fd_pread) : '—'} | ${p ? io(p.calls.fd_write || p.calls.fd_pwrite) : '—'} |\n`;
}
const last = J.progs[J.progs.length - 1];
md += `\n_"memória linear WASM" = \`memory.buffer.byteLength\` do programa ao fim (só cresce: é o pico). "heap motor" = memória do motor (WebAssembly do InkSoC) no marcador de fim (só cresce). "swap" = o que o disco Linux ocupa no swap do motor (no iPad: arquivo OPFS, não RAM; aqui um Map em node, entra no RSS). "RSS node" = amostrado a cada 16 chamadas WASI${last?.maxRss ? `; maxRSS do processo ao fim: ${MB(last.maxRss)} MB` : ''}. fd_read/fd_write = bytes pedidos pelo programa por chamada (wasi.js passa ao kernel em pedaços de até 1 MB)._\n`;
console.log(md);
