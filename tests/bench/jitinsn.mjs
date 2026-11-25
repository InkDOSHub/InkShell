// Item 63 (measurement only): what the code INSIDE a JIT block costs, for the hot fib regions of x86fib.
// Reads the regions dumped by tests/bench-engine.mjs (JITDUMP=DIR, --features jitprobe engine): decodes each
// module's wasm, splits it by x86 instruction (code positions the engine marked), sorts every wasm op into what
// it is for (register reload/write-back to Cpu, lazy flags, rip/icount/budget, TLB check, guest memory, stack
// window, chaining, control, plain computation) and into hot path / cold path (inside an `if` the engine hinted
// unlikely: side exits, TLB misses). A node --cpu-prof profile of the same run says which regions ran (the
// compiled copy is named jrK). A/B runs (INKSOC_AB bits: a part of the code emitted twice) price each part.
// usage: node tests/bench/jitinsn.mjs dump=DIR [dis=OBJDUMP.txt] [cpuprof=FILE cpulog=ENGINELOG] [native=NATIVE.txt]
//          [t:LABEL=ENGINELOG ...] > jitinsn.md     (LABEL = ab0, ab1, ab2, ... = INKSOC_AB value; may repeat)
import fs from 'node:fs';
const A = {}, T = {};
for (const a of process.argv.slice(2)) {
  const k = a.indexOf('='), key = a.slice(0, k), v = a.slice(k + 1);
  if (key.startsWith('t:')) (T[key.slice(2)] ||= []).push(v);
  else A[key] = v;
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const json = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const avg = (a) => { const s = a.filter(Number.isFinite); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN; };
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const hex = (v) => '0x' + Math.round(v).toString(16);
const esc = (s) => String(s).replace(/\|/g, '\\|');
let md = '';

// ---- x86 disassembly (objdump -d) ----
const dis = new Map(), syms = [];
for (const l of read(A.dis).split('\n')) {
  let m = l.match(/^([0-9a-f]+) <([^>]+)>:/);
  if (m) { syms.push([parseInt(m[1], 16), m[2]]); continue; }
  m = l.match(/^\s+([0-9a-f]+):\s+(.+)$/);
  if (m) dis.set(parseInt(m[1], 16), m[2].replace(/\s+/g, ' ').replace(/ ?#.*$/, '').trim());
}
const symOf = (a) => { let r = '?'; for (const [s, n] of syms) { if (s <= a) r = n; else break; } return r; };

// ---- dump ----
const idx = json(`${A.dump}/index.json`);
if (!idx) { console.log('_sem dump (index.json)_'); process.exit(0); }
const L = idx.layout || [];
const cpu = L[0], cpuSize = L[1], tlb = L[2], tlbBytes = L[3];
const FIELDS = [['regs', 4, 128], ['rip', 5, 8], ['icount', 6, 8], ['jit_limit', 7, 8], ['jit_l1', 8, 4], ['lz_op', 9, 4], ['lz_size', 10, 4], ['lz_cf', 11, 4],
  ['lz_a', 12, 8], ['lz_b', 13, 8], ['lz_r', 14, 8], ['cf', 15, 1], ['zf', 16, 1], ['sf', 17, 1], ['of', 18, 1], ['pf', 19, 1], ['df', 20, 1], ['xmm', 21, 256], ['xs', 22, 16]];
const field = (off) => {
  const o = off - cpu;
  for (const [n, i, w] of FIELDS) if (L[i] >= 0 && o >= L[i] && o < L[i] + w) return n;
  return 'other';
};

// ---- wasm decoding ----
function leb(b, p) { let r = 0, s = 0, c; do { c = b[p++]; r += (c & 127) * 2 ** s; s += 7; } while (c & 128); return [r, p]; }
function sleb(b, p) { let r = 0n, s = 0n, c; do { c = b[p++]; r |= BigInt(c & 127) << s; s += 7n; } while (c & 128); if (c & 64) r -= 1n << s; return [r, p]; }
const isMem = (op) => op >= 0x28 && op <= 0x3e;
const isStore = (op) => op >= 0x36 && op <= 0x3e;
function decodeModule(b) {
  let p = 8, code = null, hints = new Map();
  while (p < b.length) {
    const id = b[p++]; let n; [n, p] = leb(b, p); const end = p + n;
    if (id === 0) {
      let q = p, ln; [ln, q] = leb(b, q);
      const nm = new TextDecoder().decode(b.subarray(q, q + ln)); q += ln;
      if (nm === 'metadata.code.branch_hint') {
        let nf; [nf, q] = leb(b, q);
        for (let f = 0; f < nf; f++) {
          let fi, nh; [fi, q] = leb(b, q); [nh, q] = leb(b, q);
          for (let h = 0; h < nh; h++) { let off, sz; [off, q] = leb(b, q); [sz, q] = leb(b, q); if (fi === 4) hints.set(off, b[q]); q += sz; }
        }
      }
    } else if (id === 10) code = [p, end];
    p = end;
  }
  if (!code) return null;
  let q = code[0], nb, sz; [nb, q] = leb(b, q); [sz, q] = leb(b, q);
  const body = q, bend = q + sz;
  let nl; [nl, q] = leb(b, q);
  for (let i = 0; i < nl; i++) { let c; [c, q] = leb(b, q); q++; }
  const pre = q - body, start = q, ops = [];
  const stack = [];
  const cold = () => stack.some((e) => (e.inElse ? e.elseCold : e.thenCold));
  while (q < bend) {
    const p0 = q, op = b[q++];
    const o = { p: p0 - start, op, cold: cold(), off: 0, idx: -1 };
    switch (op) {
      case 0x02: case 0x03: case 0x04: {
        const bt = b[q];
        if (bt === 0x40 || (bt >= 0x6f && bt <= 0x7f)) q++; else [, q] = sleb(b, q);
        const h = op === 0x04 ? hints.get(p0 - body) : undefined;
        stack.push({ thenCold: h === 0, elseCold: h === 1, inElse: false });
        break;
      }
      case 0x05: if (stack.length) stack[stack.length - 1].inElse = true; break;
      case 0x0b: stack.pop(); break;
      case 0x0c: case 0x0d: case 0x10: case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: [o.idx, q] = leb(b, q); break;
      case 0x0e: { let n; [n, q] = leb(b, q); for (let i = 0; i <= n; i++) [, q] = leb(b, q); break; }
      case 0x11: [, q] = leb(b, q); [, q] = leb(b, q); break;
      case 0x1c: { let n; [n, q] = leb(b, q); q += n; break; }
      case 0x3f: case 0x40: q++; break;
      case 0x41: case 0x42: { let v; [v, q] = sleb(b, q); o.val = Number(v); break; }
      case 0x43: q += 4; break;
      case 0x44: q += 8; break;
      case 0xfc: { let s; [s, q] = leb(b, q); o.sub = s; if (s === 8) { [, q] = leb(b, q); q++; } else if (s === 10) q += 2; else if (s === 11) q++; else if (s === 9 || s === 13) [, q] = leb(b, q); else if (s === 12 || s === 14) { [, q] = leb(b, q); [, q] = leb(b, q); } break; }
      case 0xfd: {
        let s; [s, q] = leb(b, q); o.sub = s;
        if (s <= 11 || s === 92 || s === 93) { [, q] = leb(b, q); [o.off, q] = leb(b, q); o.mem = true; }
        else if (s === 12 || s === 13) q += 16;
        else if (s >= 21 && s <= 34) q++;
        else if (s >= 84 && s <= 91) { [, q] = leb(b, q); [o.off, q] = leb(b, q); q++; o.mem = true; }
        break;
      }
      case 0xfe: { let s; [s, q] = leb(b, q); o.sub = s; if (s === 3) q++; else { [, q] = leb(b, q); [o.off, q] = leb(b, q); o.mem = true; o.store = s >= 0x17 && s <= 0x1d; } break; }
      default:
        if (isMem(op)) { [, q] = leb(b, q); [o.off, q] = leb(b, q); o.mem = true; o.store = isStore(op); }
    }
    o.len = q - p0;
    ops.push(o);
  }
  return { ops, pre, size: sz, helpers: nb > 1 };
}

// ---- what each op is for ----
const GROUPS = ['reg ld', 'reg st', 'flags', 'rip/icount/budget', 'TLB', 'guest mem', 'window', 'chain', 'call', 'ctrl', 'comp'];
const GDESC = {
  'reg ld': 'registrador recarregado do Cpu (i32.const 0; i64.load; local.set)', 'reg st': 'registrador escrito de volta no Cpu (flush)',
  flags: 'flags preguiçosas (lz_*) / diretas guardadas no Cpu', 'rip/icount/budget': 'rip, icount, jit_limit (orçamento)',
  TLB: 'checagem de TLB + endereço host (load/store comum)', 'guest mem': 'load/store da memória x86 (o acesso em si)',
  window: 'acesso pela janela de pilha (item 59: if L_GS, load/store direto)', chain: 'encadear saída (cache L1 do dispatcher)',
  call: 'call a helper (rd/wr/step/cond)', ctrl: 'controle (block/loop/if/else/end/br/br_table/return)', comp: 'computação (locals, consts, ALU, compares)',
};
function classify(ops) {
  const g = new Array(ops.length).fill('comp');
  const set = (i, c) => { if (i >= 0 && i < ops.length) g[i] = c; };
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i], op = o.op;
    if ([0x02, 0x03, 0x04, 0x05, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x1a, 0x1b].includes(op)) { if (g[i] === 'comp') g[i] = 'ctrl'; continue; }
    if (op === 0x10) { g[i] = 'call'; continue; }
    if (!o.mem) continue;
    const off = o.off;
    let c;
    if (cpu > 0 && off >= cpu && off < cpu + cpuSize) {
      const f = field(off);
      c = f === 'regs' ? (o.store ? 'reg st' : 'reg ld') : f.startsWith('lz_') || ['cf', 'zf', 'sf', 'of', 'pf', 'df'].includes(f) ? 'flags'
        : f === 'rip' || f === 'icount' || f === 'jit_limit' ? 'rip/icount/budget' : f === 'jit_l1' ? 'chain' : 'comp';
      g[i] = c;
      // base `i32.const 0` (and for a store, the value pushed after it); a reload's local.set
      if (o.store) { if (ops[i - 2]?.op === 0x41 && ops[i - 2].val === 0) { set(i - 2, c); set(i - 1, c); } }
      else { if (ops[i - 1]?.op === 0x41 && ops[i - 1].val === 0) set(i - 1, c); if (c === 'reg ld' && ops[i + 1]?.op === 0x21) set(i + 1, c); }
      continue;
    }
    if (tlb > 0 && off >= tlb && off < tlb + tlbBytes) {
      g[i] = 'TLB';
      if (off === tlb) {
        // local.get a; i32.wrap; i32.const 12; i32.shr_u; i32.const MASK; i32.and; i32.const 4; i32.shl; local.tee L_E | load | ... i64.eq
        for (let k = 1; k <= 9 && i - k >= 0; k++) set(i - k, 'TLB');
        for (let k = i + 1; k < ops.length && k <= i + 6; k++) { set(k, 'TLB'); if (ops[k].op === 0x51) break; }
      } else if (off === tlb + 8) {
        set(i - 1, 'TLB'); for (let k = 1; k <= 3; k++) set(i + k, 'TLB'); // get L_E | i32.load | get a; i32.wrap; i32.add
      } else { set(i - 1, 'TLB'); set(i + 1, 'TLB'); } // writable bit
      continue;
    }
    const base = o.store ? ops[i - 2] : ops[i - 1];
    if (base?.op === 0x20 && base.idx === 4) { g[i] = 'window'; set(i - 1, 'window'); if (o.store) set(i - 2, 'window'); }
    else if ((base?.op === 0x20 || base?.op === 0x22) && base.idx === 1) { g[i] = 'chain'; set(i - 1, 'chain'); }
    else g[i] = 'guest mem';
  }
  // the window's `local.get L_GS; if` and chaining's compares stay ctrl/comp
  return g;
}

// ---- regions ----
const R = [];
for (const r of idx.regions) {
  const b = (() => { try { return new Uint8Array(fs.readFileSync(`${A.dump}/jr${r.k}.wasm`)); } catch { return null; } })();
  if (!b) continue;
  const d = decodeModule(b);
  if (!d) continue;
  R[r.k] = { ...r, ...d, g: classify(d.ops), fn: symOf(r.heads[0] || 0) };
}

// ---- profile: which regions ran in the steady window ----
const samples = {};
let jitS = 0, allS = 0, engS = 0, win = false;
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
  const pass = (useWin) => {
    let t = cp.startTime; jitS = allS = engS = 0;
    for (const k in samples) delete samples[k];
    for (let i = 0; i < cp.samples.length; i++) {
      t += cp.timeDeltas[i];
      if (useWin && (t < w0 || t > w1)) continue;
      const cf = node.get(cp.samples[i]).callFrame;
      allS++;
      const m = (cf.functionName + ' ' + cf.url).match(/jr(\d+)/);
      if (m) { samples[+m[1]] = (samples[+m[1]] || 0) + 1; jitS++; }
      else if (cf.url === engineUrl) engS++;
    }
  };
  win = Number.isFinite(w0) && Number.isFinite(w1) && w1 > w0;
  if (win) pass(true);
  if (jitS < 50) { win = false; pass(false); }
}
let top = Object.entries(samples).map(([k, n]) => [+k, n]).filter(([k]) => R[k]).sort((a, b) => b[1] - a[1]);
let byProfile = top.length > 0;
if (!byProfile) top = R.filter((r) => r && /fib/.test(r.fn)).map((r) => [r.k, r.ins]).sort((a, b) => b[1] - a[1]);
const sel = [];
{ let acc = 0; const tot = top.reduce((s, [, n]) => s + n, 0); for (const [k, n] of top) { if (sel.length >= 6 || (sel.length && acc >= 0.9 * tot)) break; sel.push(k); acc += n; } }

// per region and per x86 instruction
const stat = (r) => {
  const rows = [], marks = r.marks.slice().sort((a, b) => a[1] - b[1]);
  const mOf = (p) => { let m = -1; for (let i = 0; i < marks.length; i++) { if (marks[i][1] <= p) m = i; else break; } return m; };
  const per = new Map();
  const tot = { hot: 0, cold: 0, gh: Object.fromEntries(GROUPS.map((x) => [x, 0])), gc: Object.fromEntries(GROUPS.map((x) => [x, 0])) };
  r.ops.forEach((o, i) => {
    const m = mOf(o.p), key = m < 0 ? -1 : m;
    if (!per.has(key)) per.set(key, { hot: 0, cold: 0, bytes: 0, g: Object.fromEntries(GROUPS.map((x) => [x, 0])) });
    const e = per.get(key);
    e.bytes += o.len;
    if (o.cold) { e.cold++; tot.cold++; tot.gc[r.g[i]]++; } else { e.hot++; tot.hot++; e.g[r.g[i]]++; tot.gh[r.g[i]]++; }
  });
  for (const [key, e] of [...per.entries()].sort((a, b) => a[0] - b[0])) {
    const mk = key < 0 ? null : marks[key];
    if (mk && mk[2] === 4294967295 && e.hot + e.cold === 0) continue;
    rows.push({ mk, ...e });
  }
  const nIns = marks.filter((m) => m[2] < 4294967294).length;
  return { rows, tot, nIns };
};
const S = Object.fromEntries(sel.map((k) => [k, stat(R[k])]));

md += `### 1. Regiões JIT quentes (${byProfile ? `perfil V8 ${win ? 'janela runs 5 → long' : 'processo inteiro'}: ${jitS} amostras em código JIT, ${engS} no motor, ${allS} total` : 'sem perfil: regiões cuja 1ª cabeça está em fib'})\n\n`;
md += '| região | função (1ª cabeça) | cabeças | instr x86 | bytes wasm | ops wasm (quente / frio) | ops quentes por instr x86 | amostras (% do JIT) |\n|---|---|---|---:|---:|---:|---:|---:|\n';
for (const [k, n] of top.slice(0, 10)) {
  const r = R[k], s = S[k] || stat(r);
  md += `| jr${k} | ${esc(r.fn)} | ${r.heads.slice(0, 6).map(hex).join(' ')}${r.heads.length > 6 ? ' …' : ''} | ${s.nIns} | ${r.bytes} | ${s.tot.hot} / ${s.tot.cold} | ${f1(s.tot.hot / s.nIns)} | ${byProfile ? `${n} (${f1((100 * n) / jitS)}%)` : '—'} |\n`;
}

// weighted summary
{
  const w = sel.map((k) => (byProfile ? samples[k] : 1)), W = w.reduce((a, b) => a + b, 0) || 1;
  const gh = Object.fromEntries(GROUPS.map((x) => [x, 0])), gc = { ...gh };
  let hot = 0, cold = 0;
  sel.forEach((k, j) => { const s = S[k], f = w[j] / W / s.nIns; hot += s.tot.hot * f; cold += s.tot.cold * f; for (const x of GROUPS) { gh[x] += s.tot.gh[x] * f; gc[x] += s.tot.gc[x] * f; } });
  md += `\n### 2. Ops wasm por instrução x86 (regiões ${sel.map((k) => 'jr' + k).join(', ')}, média ponderada pelas amostras; estático, caminho quente = fora de \`if\` marcado improvável)\n\n`;
  md += `Quente: **${f1(hot)} ops wasm por instrução x86**; frio (saídas laterais, falta de TLB): ${f1(cold)}.\n\n| grupo | o que é | quente por instr x86 | % do quente | frio por instr x86 |\n|---|---|---:|---:|---:|\n`;
  for (const x of GROUPS) md += `| ${x} | ${GDESC[x]} | ${f2(gh[x])} | ${f1((100 * gh[x]) / hot)}% | ${f2(gc[x])} |\n`;
}

// per instruction tables
for (const k of sel.slice(0, 3)) {
  const r = R[k], s = S[k];
  md += `\n<details><summary>jr${k} (${esc(r.fn)}): ops wasm por instrução x86 (quente; frio entre parênteses)</summary>\n\n| rip | x86 | bytes | quente (frio) | ${GROUPS.join(' | ')} |\n|---|---|---:|---:|${GROUPS.map(() => '---:').join('|')}|\n`;
  for (const row of s.rows) {
    const mk = row.mk;
    const name = !mk ? '(entrada da região: icount → local, loop, br_table)' : mk[2] === 4294967295 ? '(cabeça de bloco)' : mk[2] === 4294967294 ? `(salto de fim de bloco → ${hex(mk[0])})` : esc(dis.get(mk[0]) || `op ${hex(mk[2])}`);
    md += `| ${mk ? hex(mk[0]) : ''} | ${name} | ${row.bytes} | ${row.hot} (${row.cold}) | ${GROUPS.map((x) => row.g[x] || '').join(' | ')} |\n`;
  }
  md += '\n</details>\n';
}

// ---- A/B ----
const runs = (text) => { const r = []; for (const l of text.split('\n')) { const m = l.match(/x86fib run (\d+) ([\d.]+) ms/); if (m) r[+m[1]] = +m[2]; } return r; };
const nat = med(runs(read(A.native)).filter((_, i) => i >= 5));
const ABD = { ab0: 'nada dobrado (= motor padrão)', ab1: 'escrita de volta dos registradores (flush) 2x', ab2: 'recarga de registrador do Cpu 2x', ab4: 'stores das flags preguiçosas 2x',
  ab8: 'stores de rip/icount nas saídas 2x', ab16: 'checagem de TLB dos loads/stores comuns 2x', ab32: 'checagem de orçamento nos saltos para trás 2x' };
const time = {};
for (const [lab, files] of Object.entries(T)) {
  const per = files.map((f) => runs(read(f))).filter((r) => r.length > 5);
  time[lab] = { steady: avg(per.map((r) => med(r.filter((_, i) => i >= 5)))), n: per.length, all: per.map((r) => med(r.filter((_, i) => i >= 5))) };
}
if (Object.keys(time).length) {
  const b = time.ab0?.steady;
  md += `\n### 3. A/B: uma parte do código do bloco emitida 2x (motor jitprobe, \`INKSOC_AB\`; fib(32) estável, mediana runs ≥5 de \`x86fib 10 30\`, média das rodadas)\n\nNativo: ${f2(nat)} ms. Δ ≈ preço daquela parte (teto se o V8 não elimina a cópia; ~0 pode ser a cópia eliminada pelo TurboFan).\n\n| variante | o que dobra | rodadas (estável por rodada) | estável ms | Δ ms vs ab0 | Δ % |\n|---|---|---|---:|---:|---:|\n`;
  for (const [lab, t] of Object.entries(time).sort((x, y) => (+x[0].slice(2) || 0) - (+y[0].slice(2) || 0))) {
    const d = t.steady - b;
    md += `| ${lab} | ${ABD[lab] || ''} | ${t.n} (${t.all.map(f1).join(', ')}) | ${f1(t.steady)} | ${lab === 'ab0' ? '—' : (d >= 0 ? '+' : '') + f1(d)} | ${lab === 'ab0' ? '—' : f1((100 * d) / b) + '%'} |\n`;
  }
}
console.log(md);
