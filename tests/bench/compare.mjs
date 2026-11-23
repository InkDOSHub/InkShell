// Side-by-side table: previous main run vs this run (engine times, engine/native ratio, peak memory).
// usage: node tests/bench/compare.mjs prev/results.json results.json [label]
import fs from 'node:fs';
const [prevF, curF, label = 'engine'] = process.argv.slice(2);
const load = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const prev = load(prevF), cur = load(curF);
if (!cur) { console.log('_Sem results.json desta rodada._'); process.exit(0); }
if (!prev) { console.log('_Sem rodada anterior da main para comparar (primeira rodada ou artefato expirado)._'); process.exit(0); }
const fmt = (v) => (v == null ? '—' : v >= 10000 ? (v / 1000).toFixed(1) + ' s' : v.toFixed(0) + ' ms');
const ratio = (r, k) => { const e = r?.[label]?.ms?.[k], n = r?.native?.ms?.[k]; return e && n ? e / n : null; };
const keys = [...new Set([...Object.keys(prev[label]?.ms || {}), ...Object.keys(cur[label]?.ms || {})])];
let md = `| teste | antes | agora | agora/antes | x nativo antes | x nativo agora |\n|---|---:|---:|---:|---:|---:|\n`;
for (const k of keys) {
  const a = prev[label]?.ms?.[k], b = cur[label]?.ms?.[k];
  const d = a && b ? b / a : null;
  const ra = ratio(prev, k), rb = ratio(cur, k);
  // the mark follows "x native" (same runner, same moment) when both runs have it: runners differ
  // up to ~1.5x between runs, which moves raw times but not the ratio to the native run next to them
  // under 50 ms natively the ratio is noise (process start, timer): then the raw time decides
  const fast = [prev, cur].some((r) => (r?.native?.ms?.[k] ?? Infinity) < 50);
  const q = ra && rb && !fast ? rb / ra : d;
  const mark = d == null ? '—' : `${d.toFixed(2)}x${q > 1.15 ? ' 🔺' : q < 0.87 ? ' 🟢' : ''}`;
  md += `| ${k} | ${fmt(a)} | ${fmt(b)} | ${mark} | ${ra ? ra.toFixed(1) + 'x' : '—'} | ${rb ? rb.toFixed(1) + 'x' : '—'} |\n`;
}
const pk = (r) => Object.entries(r?.[label]?.peak || {}).map(([k, v]) => `${k} ${v.toFixed(0)} MB`).join(', ') || '—';
md += `\n**Memória pico ${label}** — antes: ${pk(prev)}; agora: ${pk(cur)}\n\n🔺/🟢 = \"x nativo\" piorou >15% / melhorou >13% (o runner muda de máquina; o tempo bruto sozinho engana). Nativo < 50 ms: vale o tempo bruto.\n`;
console.log(md);
