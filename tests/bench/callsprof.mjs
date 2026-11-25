// Item 60 (measurement only): where the x86 `calls` time goes after item 59 (#83), steady state.
// Same fib as cpubench (tests/src/x86fib.c, `x86fib 10 36`): per steady run (runs 5-9) the ophist
// counters (calls, rets, block exits, chained-exit cache hits/misses, loads/stores, TLB checks, helper
// calls), the time of variants that change only the number of exits (JIT region size, chaining off)
// to price one exit, and a V8 CPU profile (node --cpu-prof) split into JIT code / engine / JS / GC.
// usage: node tests/bench/callsprof.mjs native=NATIVE.txt t:LABEL=ENGINELOG ... p:LABEL=PROFILE_JSON ...
//          [cpuprof=FILE.cpuprofile cpulog=ENGINELOG] > callsprof.md
// LABEL = variant (default, r4, r1, c0); t: may repeat a label (rounds, averaged).
// ENGINELOG = output of tests/bench-engine.mjs (ms<TAB>line...); PROFILE_JSON = its PROFILE_JSON with the
// --features ophist engine; cpulog = run with HRMARK=1 (line @@HR0 = hrtime us at its t0).
import fs from 'node:fs';
const A = {}, T = {}, P = {};
for (const a of process.argv.slice(2)) {
  const k = a.indexOf('='), key = a.slice(0, k), v = a.slice(k + 1);
  if (key.startsWith('t:')) (T[key.slice(2)] ||= []).push(v);
  else if (key.startsWith('p:')) P[key.slice(2)] = v;
  else A[key] = v;
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const json = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const avg = (a) => { const s = a.filter(Number.isFinite); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN; };
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(Math.abs(v) >= 100 ? 0 : 1) : '—');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const M = (v) => (Number.isFinite(v) ? (v / 1e6).toFixed(v >= 1e8 ? 0 : 2) : '—');
const STEADY = (k) => k >= 5; // runs 5.. = steady state (as item 46)
function runs(text) {
  const r = [];
  for (const l of text.split('\n')) {
    const m = l.match(/x86fib run (\d+) ([\d.]+) ms/);
    if (m) r[+m[1]] = +m[2];
  }
  return r;
}
const nat = runs(read(A.native)), natSteady = med(nat.filter((_, k) => STEADY(k)));
// time per variant: median of steady runs per log, averaged over rounds
const time = {};
for (const [lab, files] of Object.entries(T)) {
  const per = files.map((f) => runs(read(f))).filter((r) => r.length > 5);
  time[lab] = { steady: avg(per.map((r) => med(r.filter((_, k) => STEADY(k))))), run0: avg(per.map((r) => r[0])), n: per.length };
}
// ophist counters per steady run: delta between the snapshots after "x86fib run K-1" and "x86fib run K"
const C = {};
for (const [lab, f] of Object.entries(P)) {
  const snaps = json(f);
  if (!snaps) continue;
  const at = {};
  for (const s of snaps) { const m = s.line.match(/^x86fib run (\d+) /); if (m) at[+m[1]] = s.c.ctr; }
  const ds = [];
  for (const k of Object.keys(at).map(Number)) if (STEADY(k) && at[k - 1]) ds.push(at[k].map((v, i) => v - at[k - 1][i]));
  if (!ds.length) continue;
  C[lab] = ds[0].map((_, i) => avg(ds.map((d) => d[i])));
}
// counter names (tests/bench-engine.mjs snap: ctr[i] = prof_ctr(i); 16+k = DYN[k], see engine-src/src/jit.rs)
const k = (d) => ({
  disp: d[0], ins: d[1] + d[3], insJ: d[1], interp: d[3], l1miss: d[4], comp: d[6],
  fwd: d[16], back: d[17], exC: d[18], loads: d[19], stores: d[20], cond: d[21], fb: d[22], exD: d[24], exB: d[25],
  chained: d[26], win: d[27], winSlow: d[28], winChk: d[29], rets: d[30], calls: d[31], tlbSlow: d[32], tries: d[33], retIn: d[34],
});
const V = Object.fromEntries(Object.entries(C).map(([l, d]) => [l, k(d)]));
const labs = [...new Set([...Object.keys(time), ...Object.keys(V)])];
const DESC = { default: 'padrão (região 16, encadeado)', r4: 'região 4 blocos', r1: 'região 1 bloco (todo salto = saída)', c0: 'encadeamento desligado (saída → dispatcher)', k0: 'call/ret dentro da região desligado (item 66)' };
let md = `### 1. Variantes: fib(32) em regime estável (mediana runs ≥5 de \`x86fib 10 36\`, média das rodadas) e contadores ophist por run\n\n`;
md += `Nativo (runner): fib(32) estável ${f2(natSteady)} ms.\n\n`;
md += '| variante | rodadas | run 0 ms | estável ms | x nativo | instr (M) | calls (M) | rets (M) | saídas encadeadas (M) | saídas p/ dispatcher (M) | saltos internos (M) | tentativas de encadear (M) / falta no cache (M) | loads (M) | stores (M) | janela: acessos / lentos / checagens (M) | TLB lento (helper) (M) | cond() (M) | fallbacks (M) |\n';
md += '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
const disp = (v) => v.exC + v.exD + v.exB; // block exits that returned to the dispatcher
for (const l of labs) {
  const t = time[l] || {}, v = V[l];
  md += `| ${l}: ${DESC[l] || ''} | ${t.n ?? 0} | ${f1(t.run0)} | ${f1(t.steady)} | ${natSteady > 0 && t.steady > 0 ? (t.steady / natSteady).toFixed(1) + 'x' : '—'} | `;
  md += v ? `${M(v.ins)} | ${M(v.calls)} | ${M(v.rets)} | ${M(v.chained)} | ${M(disp(v))} | ${M(v.fwd + v.back)} | ${M(v.tries)} / ${M(v.tries - v.chained)} | ${M(v.loads)} | ${M(v.stores)} | ${M(v.win)} / ${M(v.winSlow)} / ${M(v.winChk)} | ${M(v.tlbSlow)} | ${M(v.cond)} | ${M(v.fb)} |\n` : '— | — | — | — | — | — | — | — | — | — | — | — | — |\n';
}
// 2. per call (default)
const d = V.default, td = time.default?.steady;
if (d && d.calls > 0) {
  const pc = (x) => (x / d.calls).toFixed(2);
  const tlb = d.winChk + (d.loads + d.stores - d.win); // window checks + one check per access outside a window
  md += `\n### 2. Por call (variante padrão; ${M(d.calls)} M calls por fib(32) estável)\n\n| medida | por call |\n|---|---:|\n`;
  md += `| instruções x86 (${(100 * d.insJ / (d.ins || 1)).toFixed(2)}% no JIT) | ${pc(d.ins)} |\n| rets | ${pc(d.rets)} |\n| rets que viram salto interno (item 66) | ${pc(d.retIn || 0)} |\n| saídas de bloco encadeadas (sem dispatcher) | ${pc(d.chained)} |\n`;
  md += `| saídas p/ o dispatcher (rip fixo + calculado + orçamento) | ${pc(disp(d))} |\n| entradas do dispatcher em bloco JIT | ${pc(d.disp)} |\n| saltos internos da região (frente + trás) | ${pc(d.fwd + d.back)} |\n`;
  md += `| encadear: tentativas / acertos / faltas no cache L1 | ${pc(d.tries)} / ${pc(d.chained)} / ${pc(d.tries - d.chained)} |\n| loads / stores | ${pc(d.loads)} / ${pc(d.stores)} |\n`;
  md += `| checagens de TLB (janela + acessos fora da janela) | ${pc(tlb)} |\n| chamadas a helper (TLB lento + janela lenta + cond() + fallback) | ${pc(d.tlbSlow + d.winSlow + d.cond + d.fb)} |\n`;
  md += `| ns por call: motor / nativo | ${f1((td * 1e6) / d.calls)} / ${f2((natSteady * 1e6) / d.calls)} |\n| ns por instrução x86: motor / nativo | ${f2((td * 1e6) / d.ins)} / ${(natSteady * 1e6 / d.ins).toFixed(3)} |\n`;
}
// 3. price of one exit from the variants (same guest work, more exits)
if (d && td > 0) {
  md += '\n### 3. Preço de uma saída (variante − padrão: Δ tempo ÷ Δ saídas; mesmo trabalho x86)\n\n| variante | Δ ms | Δ saídas encadeadas (M) | Δ saídas p/ dispatcher (M) | ns por saída extra | se valesse p/ as saídas do padrão: ms (% do estável) |\n|---|---:|---:|---:|---:|---:|\n';
  for (const l of labs.filter((x) => x !== 'default')) {
    const v = V[l], t = time[l]?.steady;
    if (!v || !(t > 0)) continue;
    const dt = t - td, dch = v.chained - d.chained, ddi = disp(v) - disp(d), dex = dch + ddi;
    const ns = dex > 0 ? (dt * 1e6) / dex : NaN;
    const base = l === 'c0' ? d.chained : d.chained + disp(d);
    md += `| ${l} | ${f1(dt)} | ${M(dch)} | ${M(ddi)} | ${f1(ns)} | ${f1((ns * base) / 1e6)} (${f1((100 * ns * base) / 1e6 / td)}%) |\n`;
  }
  md += '\n_r4/r1: blocos que estavam na mesma região viram saídas encadeadas (call_indirect por `jit::call`, flags/rip/icount guardados, busca no cache L1); o Δ inclui também o código perdido entre blocos (registradores e flags recarregados), logo é teto do preço de uma saída encadeada. c0: as saídas que encadeavam voltam ao laço do `run` (lookup + checagens)._\n';
}
// 4. V8 CPU profile, steady window
const cp = json(A.cpuprof);
if (cp) {
  const log = read(A.cpulog).split('\n');
  const hr = +(log.find((l) => l.startsWith('@@HR0'))?.split('\t')[1] ?? NaN);
  const at = (re) => { const l = log.find((x) => re.test(x.split('\t')[1] || '')); return l ? +l.split('\t')[0] : NaN; };
  const w0 = hr + at(/^x86fib run 4 /) * 1000, w1 = hr + at(/^x86fib long /) * 1000;
  const node = new Map(cp.nodes.map((n) => [n.id, n]));
  const urlNames = new Map();
  for (const n of cp.nodes) if (n.callFrame.url.startsWith('wasm://')) (urlNames.get(n.callFrame.url) || urlNames.set(n.callFrame.url, new Set()).get(n.callFrame.url)).add(n.callFrame.functionName);
  const engineUrl = [...urlNames.entries()].sort((a, b) => b[1].size - a[1].size)[0]?.[0];
  let t = cp.startTime, inWin = 0;
  const cat = {}, eng = {};
  const cls = (n) => {
    const { url, functionName: fn } = n.callFrame;
    if (url === engineUrl) return 'motor (wasm do engine: run/dispatcher, helpers rd/wr/cond/step, kernel)';
    if (url.startsWith('wasm://')) return 'código JIT (módulos dos blocos x86)';
    if (fn === '(garbage collector)') return 'GC';
    if (fn === '(program)' || fn === '(idle)' || fn === '(root)') return 'V8 (program/idle)';
    if (url) return 'JS (host: bench-engine.mjs, node)';
    return `outros (${fn || '?'})`;
  };
  const useWin = Number.isFinite(w0) && Number.isFinite(w1) && w1 > w0;
  const pass = (win) => {
    t = cp.startTime; let n = 0;
    for (let i = 0; i < cp.samples.length; i++) {
      t += cp.timeDeltas[i];
      if (win && (t < w0 || t > w1)) continue;
      const nd = node.get(cp.samples[i]), c = cls(nd);
      n++; cat[c] = (cat[c] || 0) + 1;
      if (nd.callFrame.url === engineUrl) eng[nd.callFrame.functionName] = (eng[nd.callFrame.functionName] || 0) + 1;
    }
    return n;
  };
  inWin = useWin ? pass(true) : 0;
  const win = inWin > 50;
  if (!win) { for (const o of [cat, eng]) for (const x in o) delete o[x]; inWin = pass(false); }
  md += `\n### 4. Perfil de CPU do V8 (\`node --cpu-prof\`, amostra 50 µs) do motor normal, ${win ? 'janela runs 5 → fim dos 30 runs de fib(32)' : 'processo inteiro (janela por linha não casou)'}: ${inWin} amostras (tempo próprio)\n\n| onde | amostras | % |\n|---|---:|---:|\n`;
  for (const [c, n] of Object.entries(cat).sort((a, b) => b[1] - a[1])) md += `| ${c} | ${n} | ${(100 * n / inWin).toFixed(1)}% |\n`;
  const top = Object.entries(eng).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length) {
    md += '\nTop funções do motor (tempo próprio, % da janela):\n\n| função | % |\n|---|---:|\n';
    for (const [fn, n] of top) md += `| \`${(fn || '?').replace(/\|/g, '\\|').slice(0, 90)}\` | ${(100 * n / inWin).toFixed(1)}% |\n`;
  }
}
console.log(md);
