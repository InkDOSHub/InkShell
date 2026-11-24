// Tables of the python3 (WASI) start profile: where the time of `python3 -c pass` goes.
// usage: INKSOC_WASI_PROFILE=1 WASI_PROFILE_JSON=wp.json node tests/bench-engine.mjs ... -- sh /root/bench.sh pystart > e.log
//        node tests/bench/wasiprof.mjs wp.json e.log [native.log] > wasiprof.md
import fs from 'node:fs';
const [jf, lf, nf] = process.argv.slice(2);
let J;
try { J = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch { console.log('_Perfil WASI: sem dados (o motor não rodou o pystart?)._'); process.exit(0); }
// marker intervals of a stamped log: { name: [begin, end] } (ms of the log's clock)
const marks = (f) => {
  const o = {}, r = {};
  if (!f || !fs.existsSync(f)) return r;
  for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
    const [t, l = ''] = raw.split('\t'); let m;
    const at = (m) => (m[2] ? m[2] / 1e6 : +t);
    if ((m = /^@@T begin:(ps-\S+)(?: (\d{12,}))?/.exec(l))) o[m[1]] = at(m);
    else if ((m = /^@@T end:(ps-\S+)(?: (\d{12,}))?/.exec(l)) && o[m[1]] != null) r[m[1]] = [o[m[1]], at(m)];
  }
  return r;
};
const E = marks(lf), N = marks(nf);
const f1 = (v) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(v < 10 ? 1 : 0));
const sum = (o, k) => Object.values(o).reduce((a, c) => a + c[k], 0);
const rows = [];
for (const [name, [b, e]] of Object.entries(E)) {
  const p = J.progs.find((q) => q.tStart >= b && q.tStart <= e);
  rows.push({ name, total: e - b, p });
}
if (!rows.length) { console.log('_Perfil WASI: sem marcadores ps-* no log do motor._'); process.exit(0); }
const LABEL = { c: '`-c pass`', S: '`-S -c pass` (sem site)', I: '`-I -c pass` (isolado)' };
let md = '| execução | total | nativo | antes do programa (fork+execve) | leitura .wasm (wasi_module) | detecção cwd | resto do setup (getcwd, preopens, cópia) | compilação | instanciação | chamadas WASI (n / ms) | motor dentro das chamadas | Python puro | exit (depois do marcador fim) |\n|---|' + '---:|'.repeat(12) + '\n';
for (const { name, total, p } of rows) {
  const [b, e] = E[name];
  const [, v, i] = name.split('-');
  const nat = N[name] ? N[name][1] - N[name][0] : null;
  if (!p) { md += `| ${LABEL[v] || v} #${i} | ${f1(total)} | ${f1(nat)} | — | — | — | — | — | — | — | — | — | — |\n`; continue; }
  const wasiN = sum(p.calls, 'n'), wasiMs = sum(p.calls, 'ms'), wasiEng = sum(p.calls, 'eng');
  const setup = p.tCompile - p.tStart, slot = p.slotMs ?? 0;
  // the stub's exit runs the shell on, which prints the end marker before runModule returns
  const pre = p.tStart - b, tail = Math.max(0, p.tEnd - e), py = Math.min(e, p.tEnd) - p.tRun - wasiMs;
  md += `| ${LABEL[v] || v} #${i} | ${f1(total)} | ${f1(nat)} | ${f1(pre)} | ${f1(p.readMs)} | ${p.slotMs == null ? '—' : `${f1(p.slotMs)}${p.slotHit ? ' (cache)' : ''}`} | ${f1(setup - p.readMs - slot)} | ${f1(p.compileMs)}${p.modCached ? ' (cache)' : ''} | ${f1(p.instMs)} | ${wasiN} / ${f1(wasiMs)} | ${f1(wasiEng)} | ${f1(py)} | ${f1(tail)} |\n`;
}
md += '\n_ms. Colunas de "antes" a "Python puro" somam o total. "antes" = do marcador ao programa chegar em runWasi (fork+execve do shell; o execve lê o .wasm inteiro p/ ver o cabeçalho); "leitura .wasm" = `wasi_module` (o kernel lê de novo o arquivo do disco Linux, blocos/swap); "detecção cwd" com cache = só a busca da chave; "Python puro" = dentro de `_start` fora das chamadas WASI (inclui a compilação preguiçosa das funções pelo V8); "exit" = o resto do exit do stub depois do marcador (fora do total). Compilação "(cache)" = o WebAssembly.Module compilado veio do cache de wasi.js (chave = versão do arquivo no kernel, wasi_module_gen); "detecção cwd" com a mesma chave não lê o módulo._\n';
// WASI calls by function, for the first two runs of each variant
const pick = rows.filter((r) => r.p && /-[12]$/.test(r.name));
const fns = [...new Set(pick.flatMap((r) => Object.keys(r.p.calls)))]
  .map((k) => [k, Math.max(...pick.map((r) => r.p.calls[k]?.ms || 0))]).sort((a, b) => b[1] - a[1]).map(([k]) => k);
md += `\n**Chamadas WASI por tipo** (n / ms total / ms do motor; ${pick.map((r) => r.name).join(', ')})\n\n| chamada | ${pick.map((r) => r.name).join(' | ')} |\n|---|${pick.map(() => '---:').join('|')}|\n`;
for (const k of fns) md += `| ${k} | ${pick.map((r) => { const c = r.p.calls[k]; return c ? `${c.n} / ${f1(c.ms)} / ${f1(c.eng)}` : '—'; }).join(' | ')} |\n`;
// Linux calls of the stub per WASI function (top 12 of the first plain run)
const first = rows.find((r) => r.p);
if (first) {
  const top = Object.entries(first.p.sys).sort((a, b) => b[1] - a[1]).slice(0, 12);
  md += `\n**Chamadas Linux do stub** (${first.name}; função WASI:nr = n; ${first.p.sysN} no total, ${first.p.runs} fatias x.run dentro delas): ${top.map(([k, n]) => `\`${k}\` ${n}`).join(', ')}\n`;
  md += `\nMódulo: ${(first.p.bytes / 1048576).toFixed(1)} MB; memória do programa ao fim: ${((first.p.mem1 || 0) / 1048576).toFixed(0)} MB.\n`;
}
console.log(md);
