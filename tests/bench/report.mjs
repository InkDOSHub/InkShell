// Builds the benchmark table (Markdown) from stamped logs and writes results.json.
// usage: node tests/bench/report.mjs native=native.log engine=engine-*.log [wasm=wasm-py.log] [native.time=time.txt]
// Several files per label are merged (e.g. one engine run per section).
import fs from 'node:fs';
const runs = {}; // label -> { metric: ms }, plus mem and errors
const get = (l) => (runs[l] ??= { ms: {}, mem: {}, err: [], peak: {} });
for (const a of process.argv.slice(2)) {
  const [label, glob] = a.split('=');
  const [base, extra] = label.split('.');
  for (const f of glob.split(',')) {
    if (!fs.existsSync(f)) { get(base).err.push(`${f}: missing`); continue; }
    const txt = fs.readFileSync(f, 'utf8'), r = get(base);
    if (extra === 'time') { const m = /Maximum resident set size \(kbytes\): (\d+)/.exec(txt); if (m) r.peak.rss = Math.max(r.peak.rss || 0, m[1] / 1024); continue; }
    const open = {};
    for (const raw of txt.split('\n')) {
      const [t, l = '', wmb] = raw.split('\t');
      let m;
      if ((m = /^@@MEM wasm=(\d+) rss=(\d+)/.exec(raw))) { r.peak.wasm = Math.max(r.peak.wasm || 0, +m[1]); r.peak.rss = Math.max(r.peak.rss || 0, +m[2]); continue; }
      // "@@T begin:X NANOSECONDS" carries its own clock (native runs); else the host stamp counts
      const at = (m) => (m[2] ? m[2] / 1e6 : +t);
      if ((m = /^@@T begin:(\S+)(?: (\d{12,}))?/.exec(l))) open[m[1]] = at(m);
      else if ((m = /^@@T end:(\S+)(?: (\d{12,}))?/.exec(l)) && open[m[1]] != null) { r.ms[m[1]] = at(m) - open[m[1]]; if (wmb) r.mem[m[1]] = +wmb; }
      else if ((m = /^(int|calls|sort|string|float|total) +([\d.]+) ms/.exec(l))) r.ms['cpu.' + m[1]] = +m[2];
      else if ((m = /^py (\S+) +([\d.]+)$/.exec(l))) r.ms['py.' + m[1]] = +m[2];
      else if ((m = /^py (\S+) +skip/.exec(l))) r.err.push(`py.${m[1]} skip`);
      else if (/^@@ERR/.test(l)) r.err.push(`${f}: ${l.slice(6)}`);
    }
  }
}
const labels = Object.keys(runs);
const keys = [...new Set(labels.flatMap((l) => Object.keys(runs[l].ms)))];
const fmt = (v) => (v == null ? '—' : v >= 10000 ? (v / 1000).toFixed(1) + ' s' : v.toFixed(0) + ' ms');
const [a, b] = labels;
// one ratio column per label after the first (e.g. engine/native, wasm/native)
const rest = labels.length > 1 ? labels.slice(1) : [null];
let md = `| teste | ${labels.join(' | ')} | ${rest.map((l) => (l ? `${l}/${a}` : '')).join(' | ')} | ${b ? `${b} wasm MB` : ''} |\n|---|${labels.map(() => '---:').join('|')}|${rest.map(() => '---:').join('|')}|---:|\n`;
for (const k of keys) {
  const va = runs[a].ms[k];
  const rs = rest.map((l) => { const v = l && runs[l].ms[k]; return va && v ? (v / va).toFixed(1) + 'x' : '—'; });
  md += `| ${k} | ${labels.map((l) => fmt(runs[l].ms[k])).join(' | ')} | ${rs.join(' | ')} | ${b && runs[b].mem[k] != null ? runs[b].mem[k] : ''} |\n`;
}
md += `\n**Memória pico** — ${labels.map((l) => `${l}: ${Object.entries(runs[l].peak).map(([k, v]) => `${k} ${v.toFixed(0)} MB`).join(', ') || '—'}`).join('; ')}\n`;
const errs = labels.flatMap((l) => runs[l].err.map((e) => `- ${l}: ${e}`));
if (errs.length) md += `\n**Falhas/limites**\n${errs.join('\n')}\n`;
fs.writeFileSync('results.json', JSON.stringify(runs, null, 1));
console.log(md);
