// Item 46 (measurement only): JIT warm-up vs steady state for calls (tests/src/x86fib.c) and the
// regions the JIT compiles (bytes, blocks, blocks duplicated across regions) for fib and x86 python3.
// usage: node tests/bench/jitwarm.mjs native=FILE run:LABEL=ENGINELOG ... fiblog=JITLOG fiblogN=ENGINELOG
//          [hot:N=JITLOG ...] prof=PROFILE_JSON pylog=JITLOG pylogN=ENGINELOG > jitwarm.md
// ENGINELOG = output of tests/bench-engine.mjs (ms<TAB>line...), JITLOG = its JITLOG=FILE,
// PROFILE_JSON = its PROFILE_JSON=FILE with the --features ophist engine.
import fs from 'node:fs';
const A = {}, runs = [];
for (const a of process.argv.slice(2)) {
  const k = a.indexOf('='), key = a.slice(0, k), v = a.slice(k + 1);
  if (key.startsWith('run:')) runs.push([key.slice(4), v]); else A[key] = v;
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const json = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
const lines = (f) => read(f).split('\n').filter(Boolean).map((l) => { const c = l.split('\t'); return c.length > 1 && /^[\d.]+$/.test(c[0]) ? { ms: +c[0], l: c[1] } : { ms: NaN, l }; });
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(v >= 100 ? 0 : 1) : '—');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const fx = (a, b) => (a > 0 && b > 0 ? (a / b).toFixed(1) + 'x' : '—');
function fibRuns(f) {
  const r = [], o = {};
  for (const { l } of lines(f)) {
    let m = l.match(/^x86fib run (\d+) ([\d.]+) ms/); if (m) r[+m[1]] = +m[2];
    m = l.match(/^x86fib long (\d+) ([\d.]+) ms/); if (m) { o.longN = +m[1]; o.long = +m[2]; }
  }
  return { r, steady: med(r.slice(5).length ? r.slice(5) : r.slice(1)), ...o };
}
let md = '';
// 1 warm-up vs steady
const nat = fibRuns(A.native);
md += '### 1. fib(32) repetido no mesmo processo (ms; run 0 = o que o bench `calls` mede) + fib longo\n\n';
md += `| variante | run 0 | run 1 | run 2 | estável (mediana run ≥5) | run 0 x nativo | estável x nativo | fib(${nat.longN ?? '?'}) ms | longo x nativo |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
md += `| nativo | ${f2(nat.r[0])} | ${f2(nat.r[1])} | ${f2(nat.r[2])} | ${f2(nat.steady)} | — | — | ${f1(nat.long)} | — |\n`;
for (const [label, f] of runs) {
  const e = fibRuns(f);
  md += `| ${label} | ${f1(e.r[0])} | ${f1(e.r[1])} | ${f1(e.r[2])} | ${f1(e.steady)} | ${fx(e.r[0], nat.steady)} | ${fx(e.steady, nat.steady)} | ${f1(e.long)} | ${fx(e.long, nat.long)} |\n`;
}
// phases of a run from its engine log: [name, from ms, to ms]
function fibPhases(f) {
  const L = lines(f), p = [], at = (re) => L.find((x) => re.test(x.l))?.ms;
  const s = at(/^x86fib start/), r0 = at(/^x86fib run 0 /), r1 = at(/^x86fib run 1 /), rl = [...L].reverse().find((x) => /^x86fib run /.test(x.l))?.ms, lg = at(/^x86fib long/);
  p.push(['antes (sh, exec)', 0, s], ['run 0', s, r0], ['run 1', r0, r1], ['runs 2+', r1, rl], ['longo', rl, lg], ['depois', lg, Infinity]);
  return p.filter(([, a, b]) => Number.isFinite(a) && b !== undefined);
}
function markPhases(f) {
  const L = lines(f), p = [], open = {};
  for (const { ms, l } of L) {
    let m = l.match(/^@@T begin:(\S+)/); if (m) open[m[1]] = ms;
    m = l.match(/^@@T end:(\S+)/); if (m && open[m[1]] !== undefined) p.push([m[1], open[m[1]], ms]);
  }
  return p;
}
const hex = (v) => '0x' + v.toString(16);
function regionStats(log, phases) {
  const R = log?.regions || [], cnt = new Map();
  for (const r of R) for (const h of new Set(r.heads || [])) cnt.set(h, (cnt.get(h) || 0) + 1);
  const rows = [];
  for (const [name, a, b] of phases) {
    const S = R.filter((r) => r.t >= a && r.t < b);
    if (!S.length) { rows.push({ name, n: 0 }); continue; }
    const inst = S.flatMap((r) => r.heads || []), uniq = new Set(inst), sum = (k) => S.reduce((s, r) => s + (r[k] || 0), 0);
    const dupIn = [...uniq].filter((h) => S.filter((r) => (r.heads || []).includes(h)).length >= 2).length;
    rows.push({ name, n: S.length, blocks: inst.length, uniq: uniq.size, dupIn, extra: inst.length - uniq.size, kb: sum('bytes') / 1024, ins: sum('ins'), tr: sum('tr'), mod: sum('mod'), inst: sum('inst') });
  }
  return { rows, R, cnt };
}
function regionTable(title, log, phases) {
  if (!log) return `### ${title}\n\n_sem JITLOG_\n\n`;
  const { rows } = regionStats(log, phases);
  let s = `### ${title}\n\nRegiões = módulos wasm (host_jit). Blocos = cabeças de bloco somadas nas regiões; únicos = rips distintos; dup = rips em ≥ 2 regiões da fase; extra = blocos − únicos (cópias). Tempos somados por fase (ms): tradução Rust, \`new WebAssembly.Module\`, \`new WebAssembly.Instance\`. Total \`Jit.ms\` (Rust, inclui host_jit) do processo: ${f1(log.jitMs)} ms.\n\n`;
  s += '| fase | regiões | blocos | únicos | dup (≥2 regiões) | extra (cópias) | instr x86 | wasm KB | KB/região | tradução | Module | Instance |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
  const T = { n: 0, blocks: 0, kb: 0, ins: 0, tr: 0, mod: 0, inst: 0 };
  for (const r of rows) {
    if (!r.n) { s += `| ${r.name} | 0 | | | | | | | | | | |\n`; continue; }
    for (const k in T) T[k] += r[k];
    s += `| ${r.name} | ${r.n} | ${r.blocks} | ${r.uniq} | ${r.dupIn} | ${r.extra} (${((100 * r.extra) / r.blocks).toFixed(0)}%) | ${r.ins} | ${f1(r.kb)} | ${f1(r.kb / r.n)} | ${f2(r.tr)} | ${f2(r.mod)} | ${f2(r.inst)} |\n`;
  }
  const all = log.regions, inst = all.flatMap((r) => r.heads || []), uniq = new Set(inst), cnt = new Map();
  for (const r of all) for (const h of new Set(r.heads || [])) cnt.set(h, (cnt.get(h) || 0) + 1);
  const heads = new Map(); for (const r of all) heads.set(r.heads?.[0], (heads.get(r.heads?.[0]) || 0) + 1);
  s += `| **processo todo** | ${all.length} | ${inst.length} | ${uniq.size} | ${[...cnt.values()].filter((v) => v >= 2).length} | ${inst.length - uniq.size} (${inst.length ? ((100 * (inst.length - uniq.size)) / inst.length).toFixed(0) : 0}%) | ${all.reduce((a, r) => a + (r.ins || 0), 0)} | ${f1(all.reduce((a, r) => a + r.bytes, 0) / 1024)} | ${f1(all.reduce((a, r) => a + r.bytes, 0) / 1024 / (all.length || 1))} | ${f2(all.reduce((a, r) => a + (r.tr || 0), 0))} | ${f2(all.reduce((a, r) => a + r.mod, 0))} | ${f2(all.reduce((a, r) => a + r.inst, 0))} |\n\n`;
  s += `Mesmo rip de entrada compilado de novo (região repetida): ${[...heads.values()].filter((v) => v >= 2).length}. Pior cópia: um bloco em ${Math.max(0, ...cnt.values())} regiões.\n\n`;
  return s;
}
// 2 warm-up split of run 0
const fl = json(A.fiblog), prof = json(A.prof);
if (A.fiblogN) {
  const ph = fibPhases(A.fiblogN), e = fibRuns(A.fiblogN), r0 = ph.find((p) => p[0] === 'run 0');
  const S = (fl?.regions || []).filter((r) => r0 && r.t >= r0[1] && r.t < r0[2]);
  const sum = (k) => S.reduce((s, r) => s + (r[k] || 0), 0);
  const extra = e.r[0] - e.steady, comp = sum('tr') + sum('mod') + sum('inst');
  md += '\n### 2. Onde vai o run 0 (motor jitprobe, HOT 40)\n\n| parte | ms | % do run 0 |\n|---|---:|---:|\n';
  const row = (n, v) => (md += `| ${n} | ${f2(v)} | ${e.r[0] > 0 ? ((100 * v) / e.r[0]).toFixed(0) + '%' : '—'} |\n`);
  row('run 0 inteiro', e.r[0]); row('regime estável (mediana run ≥5)', e.steady); row('aquecimento = run 0 − estável', extra);
  row(`tradução Rust (${S.length} regiões)`, sum('tr')); row('`new WebAssembly.Module` (JS)', sum('mod')); row('`new WebAssembly.Instance` (JS)', sum('inst'));
  row('resto do aquecimento (interpretador antes de HOT + compilação lazy/tier-up do V8 na 1ª chamada)', extra - comp);
  if (prof) {
    const sn = (re) => prof.find((p) => re.test(p.line)), a = sn(/^x86fib start/), b = sn(/^x86fib run 0 /), c = sn(/^x86fib run 1 /);
    if (a && b) {
      const d = b.c.ctr.map((v, i) => v - a.c.ctr[i]), d1 = c ? c.c.ctr.map((v, i) => v - b.c.ctr[i]) : null, M = (v) => (v / 1e6).toFixed(2);
      md += `\nPerfil ophist (motor com contadores): run 0 = ${M(d[1])} M instr. no JIT + ${M(d[3])} M no interpretador (${((100 * d[3]) / (d[1] + d[3] || 1)).toFixed(2)}%), ${d[6]} compilações, ${(d[10] / 1e3).toFixed(1)} ms de compilação, ${M(d[22])} M fallbacks`;
      if (d1) md += `; run 1 = ${M(d1[1])} M JIT + ${M(d1[3])} M interp., ${d1[6]} compilações`;
      md += '.\n';
    }
  }
}
// 3 regions
if (A.fiblogN) md += '\n' + regionTable('3a. Regiões do JIT: fib (x86fib, HOT 40)', fl, fibPhases(A.fiblogN));
for (const k of Object.keys(A).filter((k) => /^hot:/.test(k))) {
  const L = json(A[k]); if (!L) continue;
  md += `HOT ${k.slice(4)}: ${L.regions.length} regiões, ${L.regions.reduce((a, r) => a + (r.heads?.length || 0), 0)} blocos, ${f1(L.regions.reduce((a, r) => a + r.bytes, 0) / 1024)} KB, Jit.ms ${f1(L.jitMs)}.\n\n`;
}
if (fl && A.fiblogN) {
  const r0 = fibPhases(A.fiblogN).find((p) => p[0] === 'start' || p[0] === 'run 0');
  const S = fl.regions.filter((r) => r.t >= (r0?.[1] ?? 0));
  const { cnt } = regionStats(fl, []);
  md += `<details><summary>Regiões do fib (a partir do run 0)</summary>\n\n| # | t ms | entrada | blocos | instr | bytes | Module ms | Instance ms | blocos também em outra região |\n|---|---:|---|---:|---:|---:|---:|---:|---:|\n`;
  S.slice(0, 60).forEach((r, i) => (md += `| ${i} | ${f1(r.t)} | ${hex(r.heads?.[0] ?? 0)} | ${r.heads?.length ?? '—'} | ${r.ins ?? '—'} | ${r.bytes} | ${f2(r.mod)} | ${f2(r.inst)} | ${(r.heads || []).filter((h) => cnt.get(h) >= 2).length} |\n`));
  md += '\n</details>\n\n';
}
if (A.pylogN) md += regionTable('3b. Regiões do JIT: python3 x86 (bench.sh py: py-start + py-bench)', json(A.pylog), markPhases(A.pylogN));
console.log(md);
