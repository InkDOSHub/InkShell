// Item 65 (CI only): RSS of the browser processes while a big File is read piece by piece, variant by variant, without the engine.
// env: BROWSERS=webkit,chromium  VARIANTS=a,b,...  FILE=<big sparse file>  MB=<MB to read per variant>  OUT=<md file>
import { chromium, webkit } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const E = process.env, mb = +(E.MB || 1536);
const variants = (E.VARIANTS || 'page-ab,page-xfer,w-frs-new,w-frs-reuse,w-stream,w-resp,w-blobpost,opfs-only,page-xfer+opfs,w-frs-new+opfs').split(',');
const browsers = (E.BROWSERS || 'webkit,chromium').split(',');
const srv = spawn('python3', ['-m', 'http.server', '8126'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1000));
let procs = '';
const rssNow = () => {
  let sum = 0; const per = [];
  for (const l of execFileSync('ps', ['-eo', 'rss=,args=']).toString().split('\n')) if (/ms-playwright/.test(l) && !/ps -eo/.test(l)) { const k = parseInt(l.trim(), 10) || 0; sum += k; per.push([k, (l.match(/\/([A-Za-z.]*(?:Process|MiniBrowser|chrome|pw_run)[A-Za-z.]*)/) || ['', l.trim().split(/\s+/)[1].slice(-30)])[1] + (/--type=(\w+)/.test(l) ? ':' + l.match(/--type=(\w+)/)[1] : '')]); }
  procs = per.sort((a, b) => b[0] - a[0]).slice(0, 4).map(([k, n]) => `${n} ${(k / 1024).toFixed(0)}`).join('; ');
  return sum / 1024;
};
const rows = [];

const mdOf = () => [`### RSS reading ${mb} MB of a File in 4 MB pieces (no engine)`, '', '| Browser | Variant | Result | Time | MB/s | RSS start | RSS max | RSS end | RSS +4 s | growth per GB read | processes at max (MB) |', '|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.br} | ${r.v} | ${r.ok ? 'ok' : r.note} | ${r.s.toFixed(1)} s | ${(mb / r.s).toFixed(0)} | ${r.r0.toFixed(0)} | ${r.max.toFixed(0)} | ${r.rEnd.toFixed(0)} | ${r.rAfter.toFixed(0)} | ${((r.max - r.r0) / (mb / 1024)).toFixed(0)} MB | ${r.procMax} |`), ''].join('\n');
for (const br of browsers) for (const v of variants) {
  const browser = await (br === 'chromium' ? chromium : webkit).launch();
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto(`http://localhost:8126/tests/bench/rss-micro.html?v=${v.split('/')[0].replace('+', '%2B')}&mb=${mb}${v.split('/').slice(1).map((k) => '&' + k).join('')}`);
  await new Promise((r) => setTimeout(r, 1500));
  const r0 = rssNow(); let max = r0, procMax = ''; const samp = setInterval(() => { const m = rssNow(); if (m > max) { max = m; procMax = procs; } }, 500);
  const t0 = Date.now();
  await page.setInputFiles('#f', E.FILE);
  let res = null;
  for (let i = 0; i < 240 && !res; i++) { res = await page.evaluate(() => window.__res).catch(() => null); if (!res) await new Promise((r) => setTimeout(r, 500)); }
  const s = (Date.now() - t0) / 1000, rEnd = rssNow();
  await new Promise((r) => setTimeout(r, 4000)); const rAfter = rssNow();
  clearInterval(samp);
  const row = { procMax, br, v, ok: !!(res && res.ok), s, r0, max, rEnd, rAfter, note: res ? (res.ok ? '' : res.err) : 'timeout' };
  rows.push(row);
  console.log(`  procs at max: ${procMax}`);
  console.log(`${br} ${v}: ${row.ok ? 'ok' : 'FAIL ' + row.note} ${s.toFixed(1)} s, ${(mb / s).toFixed(0)} MB/s, RSS ${r0.toFixed(0)} -> max ${max.toFixed(0)} -> end ${rEnd.toFixed(0)} -> +4s ${rAfter.toFixed(0)} MB`);
  await browser.close().catch(() => {});
  if (E.OUT) fs.writeFileSync(E.OUT, mdOf());
}
srv.kill();
console.log(mdOf());
process.exit(0);
