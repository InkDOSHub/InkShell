// Profile of cpubench on the engine (built with --features ophist), per section: where instructions run
// (JIT code vs interpreter), how JIT blocks end, dispatcher lookups, compiles, top interpreted opcodes.
// usage: PROFILE_JSON=prof.json node tests/bench-engine.mjs ophist.wasm cpubench=... -- sh /root/bench.sh cpu io 16
// (the io section adds the sha256sum of a 16 MB file: busybox x86 hashing)
//        node tests/bench/profile.mjs prof.json > profile.md
import fs from 'node:fs';
const snaps = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const NAMES = {
  0x01: 'add r/m,r', 0x03: 'add r,r/m', 0x09: 'or', 0x0b: 'or r,r/m', 0x29: 'sub', 0x2b: 'sub r,r/m', 0x31: 'xor', 0x33: 'xor r,r/m',
  0x39: 'cmp r/m,r', 0x3b: 'cmp r,r/m', 0x50: 'push', 0x53: 'push rbx', 0x55: 'push rbp', 0x58: 'pop', 0x5b: 'pop rbx', 0x5d: 'pop rbp',
  0x63: 'movsxd', 0x72: 'jb', 0x74: 'je', 0x75: 'jne', 0x7e: 'jle', 0x7f: 'jg', 0x81: 'alu imm32', 0x83: 'alu imm8', 0x85: 'test',
  0x89: 'mov r/m,r', 0x8b: 'mov r,r/m', 0x8d: 'lea', 0xa4: 'movsb', 0xa5: 'movs', 0xaa: 'stosb', 0xab: 'stos', 0xc1: 'shift imm',
  0xc3: 'ret', 0xc7: 'mov r/m,imm', 0xd1: 'shift 1', 0xd3: 'shift cl', 0xd8: 'x87 d8', 0xd9: 'x87 d9', 0xdc: 'x87 dc', 0xdd: 'x87 dd',
  0xde: 'x87 de', 0xdf: 'x87 df', 0xe8: 'call', 0xe9: 'jmp', 0xeb: 'jmp short', 0xf6: 'grp3 8', 0xf7: 'grp3', 0xff: 'grp5 (call/jmp/inc)',
  0x105: 'syscall', 0x110: 'movups/movsd', 0x111: 'movups/movsd st', 0x128: 'movaps', 0x12a: 'cvtsi2sd', 0x12c: 'cvttsd2si',
  0x12e: 'ucomisd', 0x12f: 'comisd', 0x131: 'rdtsc', 0x140: 'cmovcc', 0x157: 'xorps', 0x158: 'addsd', 0x159: 'mulsd', 0x15c: 'subsd',
  0x15e: 'divsd', 0x16e: 'movd', 0x16f: 'movdqa/u', 0x17e: 'movd/movq st', 0x17f: 'movdqa st', 0x174: 'pcmpeqb', 0x184: 'je near',
  0x185: 'jne near', 0x1af: 'imul r,r/m', 0x1b6: 'movzx 8', 0x1b7: 'movzx 16', 0x1bc: 'bsf/tzcnt', 0x1bd: 'bsr', 0x1be: 'movsx 8',
  0x1d7: 'pmovmskb', 0x1ef: 'pxor', 0x1a2: 'cpuid', 0x1a4: 'shld imm', 0x1a5: 'shld cl', 0x1ac: 'shrd imm', 0x1ad: 'shrd cl', 0x1c8: 'bswap',
};
const op = (k) => `${k >= 0x100 ? '0f ' + (k - 0x100).toString(16).padStart(2, '0') : k.toString(16).padStart(2, '0')}${NAMES[k] ? ' ' + NAMES[k] : ''}`;
const base = snaps.findIndex((s) => s.line.startsWith('@@T begin:cpu'));
const secs = [];
let prev = snaps[Math.max(base, 0)];
for (const s of snaps.slice(base + 1)) {
  // io sections of bench.sh (run after cpu): from "@@T begin:io-sha256-N" to its end marker
  if (/^@@T begin:io-sha256-/.test(s.line)) { prev = s; continue; }
  const e = s.line.match(/^@@T end:(io-sha256-\d+)/);
  if (e) {
    secs.push({ name: e[1], ms: s.ms - prev.ms, d: s.c.ctr.map((v, i) => v - prev.c.ctr[i]), o: s.c.op.map((v, i) => v - prev.c.op[i]) });
    prev = s;
    continue;
  }
  const m = s.line.match(/^(int|calls|sort|string|float)\s+([\d.]+) ms/);
  if (!m) continue;
  const d = s.c.ctr.map((v, i) => v - prev.c.ctr[i]), o = s.c.op.map((v, i) => v - prev.c.op[i]);
  secs.push({ name: m[1], ms: +m[2], d, o });
  prev = s;
}
if (!secs.length) { console.log('_Perfil: sem seções (o motor ophist não rodou o cpubench?)._'); process.exit(0); }
const M = (v) => (v / 1e6).toFixed(v >= 1e8 ? 0 : 1);
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '—');
const r1 = (a, b) => (b ? (a / b).toFixed(1) : '—');
let md = '| seção | ms | instr (M) | no JIT | blocos JIT (M) | instr/bloco | traces interp (M) | instr/trace | busca lenta (k) | compilações | sem bloco | comp. ms |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
for (const { name, ms, d } of secs) {
  const tot = d[1] + d[3];
  md += `| ${name} | ${ms.toFixed(0)} | ${M(tot)} | ${pct(d[1], tot)} | ${M(d[0])} | ${r1(d[1], d[0])} | ${M(d[2])} | ${r1(d[3], d[2])} | ${(d[4] / 1e3).toFixed(1)} | ${d[6]} | ${d[7]} | ${(d[10] / 1e3).toFixed(1)} |\n`;
}
md += '\n**Saídas dos blocos JIT** (M; % das execuções de bloco) e ações dentro do JIT\n\n| seção | encadeadas (sem dispatcher) | rip fixo | rip calculado (ret/indireto) | laço (orçamento) | fallback parou | fallbacks (instr interp. no JIT) | saltos p/ trás | saltos p/ frente | chamadas cond() | loads | stores | janela de pilha: acessos (lentos) / checagens |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
for (const { name, d } of secs) {
  // block runs = entered from the dispatcher (d[0]) + entered by a chained exit (DYN[10])
  const n = d[0] + d[26], y = (k) => `${M(d[16 + k])} (${pct(d[16 + k], n)})`;
  md += `| ${name} | ${y(10)} | ${y(2)} | ${y(8)} | ${y(9)} | ${M(d[8])} (${pct(d[8], n)}) | ${M(d[22])} | ${M(d[17])} | ${M(d[16])} | ${M(d[21])} | ${M(d[19])} | ${M(d[20])} | ${M(d[27])} (${M(d[28])}) / ${M(d[29])} |\n`;
}
md += '\n**Top opcodes interpretados** (traces + fallbacks; M e % das instruções interpretadas da seção)\n\n| seção | interp. (M) | top 6 |\n|---|---:|---|\n';
for (const { name, o } of secs) {
  const tot = o.reduce((a, b) => a + b, 0);
  const top = o.map((v, k) => [k, v]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
  md += `| ${name} | ${M(tot)} | ${top.map(([k, v]) => `\`${op(k)}\` ${M(v)} (${pct(v, tot)})`).join(', ') || '—'} |\n`;
}
md += '\n_Motor com `--features ophist` (contadores ligados, tempos não comparáveis com o motor normal). "busca lenta" = falta no cache L1 do dispatcher (HashMap). Cada trace volta ao dispatcher; um bloco JIT também, salvo saída encadeada (o bloco devolve o próximo bloco do cache L1 e o laço curto de jit::call o chama direto). "rip fixo"/"rip calculado" = só as saídas que voltaram ao dispatcher._\n';
console.log(md);
