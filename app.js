/* Alpine Linux terminal page: xterm.js in front, the engine (worker.js) behind. */
'use strict';
const $ = (id) => document.getElementById(id);
const term = new Terminal({
  convertEol: true, cursorBlink: true, fontSize: 14, scrollback: 5000,
  fontFamily: 'ui-monospace, Menlo, "SF Mono", Consolas, monospace',
  theme: { background: '#0b0b0d' },
});
term.open($('term'));

// size the terminal to its box (no fit add-on: measure one character)
function fit() {
  const box = $('term').getBoundingClientRect();
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;font-family:' + term.options.fontFamily + ';font-size:' + term.options.fontSize + 'px;line-height:normal';
  probe.textContent = 'W'.repeat(50);
  document.body.appendChild(probe);
  let cw = probe.getBoundingClientRect().width / 50, ch = term.options.fontSize * 1.2;
  probe.remove();
  // xterm's own cell size when it has one (Safari's line height differs from the estimate, and too many rows covered the key bar)
  try { const c = term._core._renderService.dimensions.css.cell; if (c.width > 0 && c.height > 0) { cw = c.width; ch = c.height; } } catch (e) {}
  const cols = Math.max(20, Math.floor(box.width / cw)), rows = Math.max(5, Math.floor(box.height / ch));
  if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
  if (w) w.postMessage({ type: 'resize', rows: term.rows, cols: term.cols });
}

/* ---- start panel: system, network, memory (same budget as InkSoC), saved data ---- */
const NETS = ['wisp', 'off'];
const pref = { get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
let network = pref.get('alpine-net', 'wisp');
if (!NETS.includes(network)) network = 'wisp';
document.querySelector('input[name=net][value=' + network + ']').checked = true;
for (const r of document.querySelectorAll('input[name=net]')) r.onchange = () => { network = r.value; pref.set('alpine-net', network); if (w) w.postMessage({ type: 'net', network }); };

// InkSoC's memory limits (same site, same storage): the lowest tab limit seen on this device
const LS = 'inksoc-limits';
const limits = { get() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } }, set(v) { try { localStorage.setItem(LS, JSON.stringify(v)); } catch (e) {} } };
{ // a calibration that was still running when the tab reloaded: the last step saved is the limit
  const s = limits.get();
  if (s.calib && s.calib.running && s.calib.mb) { s.calib.running = false; s.calib.note = 'the tab reloaded'; s.minLimit = Math.min(s.minLimit || Infinity, s.calib.mb); limits.set(s); }
}
function budget() {
  const s = limits.get();
  const lim = s.minLimit || (s.calib && !s.calib.running && s.calib.mb) || 0;
  if (!lim) return { pool: 256, text: 'Programs see 8 GB. Real RAM: a safe 256 MB, because this device was not calibrated yet; the rest goes to a swap file in this browser. Calibrate once to use more.' };
  const pool = Math.max(128, Math.min(2048, Math.floor(lim * 0.5 / 64) * 64));
  return { pool, text: `Programs see 8 GB. Real RAM: ${pool} MB (half of this device's limit, ${lim} MB); the rest goes to a swap file in this browser.` };
}
const showMem = () => { $('mem-text').textContent = budget().text; };
showMem();
$('calib').onclick = async () => {
  if (!confirm('Calibrating fills memory until the browser says no. The tab may reload once; that is expected and gives the limit.' + (w ? ' Linux saves your files and stops first.' : '') + ' Continue?')) return;
  $('calib').disabled = true;
  await stop(true);
  limits.set(Object.assign(limits.get(), { calib: { mb: 0, running: true } }));
  const c = new Worker('worker.js?v=70');
  c.onmessage = (ev) => {
    const d = ev.data; if (d.type !== 'calib') return;
    const s = limits.get();
    s.calib = { mb: d.mb, running: !d.done };
    if (d.done) s.minLimit = Math.min(s.minLimit || Infinity, d.mb);
    limits.set(s);
    $('mem-text').textContent = d.done ? '' : 'Calibrating… ' + d.mb + ' MB';
    if (d.done) { c.terminate(); $('calib').disabled = false; showMem(); }
  };
  c.postMessage({ type: 'calibrate' });
};

const fmtMb = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB';
async function showData() {
  let size = 0;
  try { const root = await navigator.storage.getDirectory(); size = (await (await root.getFileHandle('alpine-fs.tar')).getFile()).size; } catch (e) {}
  const user = pref.get('alpine-user', '');
  $('data-text').textContent = size ? (user ? 'User ' + user + ' · ' : '') + fmtMb(size) + ' of files and programs saved in this browser.' : 'Nothing saved yet. The first start asks you to create a user and a password (like WSL).';
  $('erase').disabled = !size;
}
showData();
$('erase').onclick = () => {
  if (!confirm('Erase your Linux user, files and installed programs, and start again from a clean Alpine?')) return;
  stop(false).then(() => {
    const r = new Worker('worker.js?v=70');
    r.onmessage = () => { r.terminate(); pref.set('alpine-user', ''); showData(); };
    r.postMessage({ type: 'reset' });
  });
};
fetch('engine-version.txt?x=' + Date.now()).then((r) => r.text()).then((v) => { $('engine-text').textContent = 'Engine: InkSoC ' + v.trim() + ' (the Windows engine version, plus the Linux part)'; }).catch(() => {});
$('start').onclick = () => { $('panel').hidden = true; fit(); term.reset(); start(); term.focus(); };
// Settings page: opened from the ☰ menu; the red X goes back to the terminal (and starts Linux if it is not running)
const openSettings = () => { $('info').classList.remove('show'); showMem(); showData(); $('start').hidden = !!w; $('panel').hidden = false; };
$('settings').onclick = openSettings;
$('fechar').onclick = () => { if (!w) { $('start').click(); return; } $('panel').hidden = true; fit(); term.focus(); };
// stops a running Linux; save = true lets it write the files first
function stop(save) {
  if (!w) return Promise.resolve();
  const old = w; w = null;
  return new Promise((res) => {
    let done = false;
    const end = () => { if (done) return; done = true; old.terminate(); $('start').hidden = false; term.write('\r\n\x1b[2m[Linux stopped]\x1b[0m\r\n'); res(); };
    if (!save) { end(); return; }
    old.onmessage = (ev) => { if (ev.data.type === 'saved') end(); };
    old.postMessage({ type: 'save' });
    setTimeout(end, 5000);
  });
}

let w = null, starting = false;
// WebAssembly programs: each runs in its own Worker; the service worker carries their calls to the engine
const wasiWorkers = new Map();
const wasiSlots = new Map(); // wasi.js cwdSlot results by module (each program's Worker is new)
const wasiMods = new Map(); // compiled WebAssembly.Module by file version (worker.js key); a few, newest last
const swOn = () => !!(navigator.serviceWorker && navigator.serviceWorker.controller);
if (navigator.serviceWorker) {
  navigator.serviceWorker.register('sw.js?v=1').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (w) w.postMessage({ type: 'wasi-sw', on: swOn() }); });
}
function wasiEnd(pid) { const b = wasiWorkers.get(pid); if (b) { b.terminate(); wasiWorkers.delete(pid); } }
function wasiStart(m) {
  const b = new Worker('wasi-worker.js?v=70', { type: 'module' });
  wasiWorkers.set(m.pid, b);
  b.onmessage = (ev) => {
    if (ev.data.type === 'done') wasiEnd(m.pid);
    else if (ev.data.type === 'slot' && wasiSlots.size < 256) wasiSlots.set(ev.data.key, ev.data.slot);
    else if (ev.data.type === 'module' && ev.data.module) {
      wasiMods.delete(ev.data.key); wasiMods.set(ev.data.key, ev.data.module);
      while (wasiMods.size > 4) wasiMods.delete(wasiMods.keys().next().value);
    }
  };
  b.onerror = () => wasiEnd(m.pid);
  m.slots = [...wasiSlots];
  if (m.key && wasiMods.has(m.key)) { m.module = wasiMods.get(m.key); wasiMods.delete(m.key); wasiMods.set(m.key, m.module); }
  b.postMessage(m, [m.bytes.buffer]);
}
let ctrl = false;
const send = (t) => { if (w) w.postMessage({ type: 'key', data: t }); };

function start() {
  if (starting || w) return;
  starting = true;
  term.write('\x1b[2mStarting Alpine Linux on InkSoC…\x1b[0m\r\n');
  w = new Worker('worker.js?v=70');
  starting = false;
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'out') term.write(m.text);
    else if (m.type === 'file') dlGot(m);
    else if (m.type === 'ls') dlShow(m);
    else if (m.type === 'store') stShow(m);
    else if (m.type === 'mfetch') mountFetch(m.paths);
    else if (m.type === 'msync') { syncQ = syncQ.then(() => mountSync(m.root, m.ops)); } // one after another: a big file is written in many steps
    else if (m.type === 'range') { const r = ranges.get(m.id); if (r) { ranges.delete(m.id); r(m); } }
    else if (m.type === 'saved') term.write('\r\n\x1b[2m[files saved]\x1b[0m\r\n');
    else if (m.type === 'info') { pref.set('alpine-user', m.user || ''); }
    else if (m.type === 'wasi-start') wasiStart(m);
    else if (m.type === 'wasi-end') wasiEnd(m.pid);
    else if (m.type === 'done') {
      term.write('\r\n\x1b[2m[' + (m.error ? 'stopped: ' + m.error : 'Linux ended') + ']\x1b[0m\r\n');
      if (w) w.terminate();
      w = null;
      for (const pid of [...wasiWorkers.keys()]) wasiEnd(pid);
      setTimeout(() => { if (!w) openSettings(); }, 1500);
    }
  };
  fit();
  w.postMessage({ type: 'start', rows: term.rows, cols: term.cols, network, poolMb: budget().pool, targetMb: 8192, sw: swOn() });
  for (const [root, m] of mounted) { w.postMessage({ type: 'mount', root, list: m.list }); shareFiles(m); } // mounted before a restart
}

let lastEnter = 0;
term.onData((d) => {
  if (!w) return;
  if (/^[\r\n]+$/.test(d)) { // one Enter (\r, \n or \r\n); iOS can send it twice for one tap
    const t = performance.now();
    if (t - lastEnter < 150) return;
    lastEnter = t; d = '\r';
  }
  if (ctrl && d.length === 1) {
    const c = d.toUpperCase().charCodeAt(0);
    if (c >= 64 && c < 96) d = String.fromCharCode(c - 64);
    ctrl = false; $('ctrl').classList.remove('on');
  }
  send(d);
});

const K = { esc: '\x1b', tab: '\t', '^C': '\x03', '^D': '\x04', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };
$('keys').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  const k = b.dataset.k;
  if (k === 'ctrl') { ctrl = !ctrl; b.classList.toggle('on', ctrl); }
  else send(K[k] || k);
  term.focus();
});

$('i').onclick = () => $('info').classList.toggle('show');
$('save').onclick = () => { if (w) w.postMessage({ type: 'save' }); };
$('up').onclick = () => $('file').click();
// A file from the InkOS Finder (Hub assets/inkos-bridge.js): same as the upload
// button. Linux starts if it is not running; the worker keeps the file until
// the system is up.
window.addEventListener('inkos:file', async (e) => {
  const f = e.detail;
  if (!(f instanceof File)) return;
  e.preventDefault();
  if (!w) $('start').click();
  const data = await f.arrayBuffer();
  if (w) w.postMessage({ type: 'put', name: f.name, data }, [data]);
  term.write('\r\n\x1b[2m[' + f.name + ' → your home folder]\x1b[0m\r\n');
});
$('file').onchange = async () => {
  for (const f of $('file').files) {
    const data = await f.arrayBuffer();
    if (w) w.postMessage({ type: 'put', name: f.name, data }, [data]);
    term.write('\r\n\x1b[2m[' + f.name + ' → your home folder]\x1b[0m\r\n');
  }
  $('file').value = '';
  send('');
};

/* ---- Files: a page like Settings that lists your Linux files ----
   No prompt() (apps like XeOS may not show it) and no click from a script after the file
   arrives (Safari drops it once the tap is too old): the file is read first, then the person
   taps Save (a real link) or Save to Files / Share (the system sheet). */
let dlPath = null, dlRow = null, dlUrl = null;
const dlReq = (path) => { if (w) w.postMessage({ type: 'ls', path }); };
const human = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const MIME = { txt: 'text/plain', pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', zip: 'application/zip', mp3: 'audio/mpeg', mp4: 'video/mp4', csv: 'text/csv', json: 'application/json', html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const mimeOf = (n) => MIME[(n.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
const ICON = (id) => '<svg aria-hidden="true"><use href="#' + id + '"></use></svg>';
let dlHome = null;
function dlSide() {
  const nav = $('dl-side'); nav.textContent = '';
  const h = document.createElement('h4'); h.textContent = 'Favorites'; nav.append(h);
  const add = (icon, label, path) => {
    const b = document.createElement('button'); b.type = 'button';
    b.innerHTML = ICON(icon); b.append(label);
    if (dlPath === path) b.className = 'on';
    b.onclick = () => dlReq(path);
    nav.append(b);
  };
  if (dlHome) add('ic-home', dlHome.split('/').pop() || 'Home', dlHome);
  for (const r of mounted.keys()) add('ic-side-folder', r.split('/').pop(), r);
  add('ic-disk', 'Linux (/)', '/');
}
function dlShow(m) {
  if ($('dl').hidden) return;
  if (m.home) dlHome = m.home;
  dlPath = m.path; dlRow = null;
  $('dl-acts').hidden = true;
  $('dl-path').textContent = m.path === '/' ? 'Linux (/)' : m.path.split('/').filter(Boolean).join('  ›  ');
  $('dl-up').disabled = m.path === '/';
  dlSide();
  const g = $('dl-list'); g.textContent = '';
  const msg = (t) => { const d = document.createElement('div'); d.className = 'vazio'; d.textContent = t; g.append(d); };
  if (!m.items) { msg('Linux is starting…'); return; }
  if (!m.items.length) { msg('Empty folder'); return; }
  const join = (n) => (m.path === '/' ? '' : m.path) + '/' + n;
  for (const it of m.items) {
    const p = join(it.name);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'item';
    b.innerHTML = ICON(it.dir ? 'ic-folder' : 'ic-file');
    const n = document.createElement('span'); n.className = 'n'; n.textContent = it.name; b.append(n);
    if (!it.dir) { const t = document.createElement('span'); t.className = 't'; t.textContent = human(it.size || 0); b.append(t); }
    b.onclick = () => { if (b.dataset.held) { delete b.dataset.held; return; } it.dir ? dlReq(p) : dlPick(p, b); };
    if (dlCanDelete(p)) {
      b.oncontextmenu = (ev) => { ev.preventDefault(); dlMenu(p, it, ev.clientX, ev.clientY); };
      let t = null; // touch: hold the icon (iPhone/iPad without a mouse)
      b.addEventListener('touchstart', (ev) => { const q = ev.touches[0]; t = setTimeout(() => { t = null; b.dataset.held = '1'; dlMenu(p, it, q.clientX, q.clientY); }, 550); }, { passive: true });
      const stop = () => { if (t) { clearTimeout(t); t = null; } };
      b.addEventListener('touchmove', stop, { passive: true }); b.addEventListener('touchend', stop); b.addEventListener('touchcancel', stop);
    }
    g.append(b);
  }
}
// Only your own files can be deleted (home folder, /root, /tmp, inside mounted folders); the worker checks it again.
function dlCanDelete(p) {
  if (rootOf(p)) return true;
  return [dlHome, '/root', '/tmp'].some((r) => r && p.startsWith(r + '/'));
}
function dlMenu(path, it, x, y) {
  const mnu = $('dl-menu'); mnu.textContent = '';
  const t = document.createElement('div'); t.className = 't'; t.textContent = it.name; mnu.append(t);
  if (!it.dir) { const o = document.createElement('button'); o.type = 'button'; o.textContent = 'Save…'; o.onclick = () => { mnu.hidden = true; const el = [...$('dl-list').children].find((c) => c.querySelector('.n') && c.querySelector('.n').textContent === it.name); dlPick(path, el || document.createElement('div')); }; mnu.append(o); }
  const d = document.createElement('button'); d.type = 'button'; d.className = 'perigo';
  d.textContent = it.dir ? 'Delete folder' : 'Delete';
  d.onclick = () => {
    if (!d.classList.contains('sim')) { d.classList.add('sim'); d.textContent = 'Tap again to delete' + (rootOf(path) ? ' (also on the device)' : ''); return; }
    mnu.hidden = true;
    if (w) w.postMessage({ type: 'rm', path });
  };
  mnu.append(d);
  mnu.hidden = false;
  const r = mnu.getBoundingClientRect();
  mnu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  mnu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
document.addEventListener('pointerdown', (ev) => { const mnu = $('dl-menu'); if (!mnu.hidden && !mnu.contains(ev.target)) mnu.hidden = true; }, true);
$('dl-up').onclick = () => { if (dlPath && dlPath !== '/') dlReq(dlPath.replace(/\/[^/]*$/, '') || '/'); };
async function dlPick(path, el) {
  for (const o of $('dl-list').querySelectorAll('.item.on')) o.classList.remove('on');
  el.classList.add('on');
  dlRow = { path, el };
  const box = $('dl-acts'); box.hidden = false; box.textContent = 'Reading…';
  const mt = mounted.get(rootOf(path)), h = mt && mt.files.get(path);
  if (h) { // a file of a mounted folder: the page already has it
    try { dlReady(path, h.getFile ? await h.getFile() : h); return; } catch (er) {}
  }
  if (w) w.postMessage({ type: 'get', path, to: 'dl' });
}
function dlGot(m) {
  if (!dlRow || dlRow.path !== m.path) return;
  if (!m.data) { $('dl-acts').textContent = 'Could not read this file.'; return; }
  const name = m.path.split('/').pop() || 'file';
  dlReady(m.path, new File([m.data], name, { type: mimeOf(name) }));
}
function dlReady(path, f) {
  const box = $('dl-acts');
  if (!dlRow || dlRow.path !== path) return;
  const name = path.split('/').pop() || 'file';
  const file = f instanceof File && f.name === name ? f : new File([f], name, { type: mimeOf(name) });
  if (dlUrl) URL.revokeObjectURL(dlUrl);
  dlUrl = URL.createObjectURL(file);
  box.textContent = '';
  const nm = document.createElement('span'); nm.className = 'nome'; nm.textContent = name + ' · ' + human(file.size); box.append(nm);
  let canShare = false;
  try { canShare = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch (er) {}
  if (canShare) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'sec'; b.textContent = 'Save to Files / Share';
    b.onclick = () => { navigator.share({ files: [file] }).catch(() => {}); };
    box.append(b);
  }
  const a = document.createElement('a'); a.href = dlUrl; a.download = name; a.textContent = 'Save'; box.append(a);
}
$('down').onclick = () => {
  if (!w) $('start').click();
  $('info').classList.remove('show');
  $('dl').hidden = false;
  $('dl-list').textContent = ''; $('dl-acts').hidden = true;
  dlReq(dlPath);
};
$('dl-x').onclick = () => { $('dl').hidden = true; fit(); term.focus(); };

/* ---- Store: the WebAssembly catalog (☰ Store) ----
   Install / Remove run "apk add/del NAME" in Linux through the worker (a root helper there), not in
   your shell; this page shows the progress and the result. */
const stReq = () => { if (w) w.postMessage({ type: 'store' }); };
// apk writes "NAME: 12/25 MB 48%" while it downloads, one line updated with \r: the last line wins
const stProg = (log, name) => {
  let p = null; const re = /(?:^|[\r\n])([A-Za-z0-9._+-]+): (\d+)\/(\d+) ([KM])B (\d+)%/g;
  for (let r; (r = re.exec(log || ''));) if (r[1] === name) { const u = r[4] === 'M' ? 1048576 : 1024; p = { pct: +r[5], done: +r[2] * u, total: +r[3] * u }; }
  return p;
};
// speed = moving average over the last ~8 s of samples; ETA from the bytes left. null until it has 2 s of data.
const stSamples = [];
function stRate(name, done, total, now) {
  if (!stSamples.length || stSamples[0].name !== name || done < stSamples[stSamples.length - 1].done) stSamples.length = 0;
  if (!stSamples.length || done > stSamples[stSamples.length - 1].done) stSamples.push({ name, t: now, done });
  while (stSamples.length > 2 && now - stSamples[1].t > 8000) stSamples.shift();
  const f = stSamples[0], l = stSamples[stSamples.length - 1], dt = (l.t - f.t) / 1000;
  if (dt < 2 || l.done <= f.done) return null;
  const bps = (l.done - f.done) / dt, eta = Math.max(0, Math.round((total - l.done) / bps));
  return (bps / 1048576).toFixed(1).replace('.', ',') + ' MB/s · ' + (eta >= 60 ? Math.floor(eta / 60) + ' min ' + (eta % 60) + ' s' : eta + ' s');
}
function stShow(m) {
  if ($('st').hidden) return;
  const list = $('st-list'); list.textContent = '';
  if (!m.items) { list.textContent = 'Linux is starting…'; setTimeout(stReq, 1000); return; }
  const j = m.job, k = m.done;
  const pName = j && j.op === 'add' ? j.name : k && k.op === 'add' ? k.name : '', prog = pName ? stProg(m.log, pName) : null, pct = prog ? prog.pct : null;
  const rate = j && prog && pct < 100 ? stRate(pName, prog.done, prog.total, Date.now()) : null;
  for (const it of m.items) {
    const row = document.createElement('div'); row.className = 'pkg'; row.dataset.name = it.name;
    const d = document.createElement('div'); d.className = 'd';
    const b = document.createElement('b'); b.textContent = it.name;
    const s = document.createElement('div'); s.className = 'nota';
    s.textContent = [it.desc, human(it.size), it.license, it.installed ? 'installed' : ''].filter(Boolean).join(' · ');
    d.append(b, s);
    if (pct !== null && it.name === pName) {
      row.dataset.pct = pct;
      if (j) { const bar = document.createElement('progress'); bar.max = 100; bar.value = pct; d.append(bar); }
    }
    const busy = m.busy.includes(it.name);
    const btn = document.createElement('button'); btn.type = 'button';
    btn.textContent = busy ? 'Working…' : it.installed ? 'Remove' : 'Install';
    if (it.installed) btn.className = 'perigo';
    btn.disabled = busy;
    btn.onclick = () => { btn.disabled = true; btn.textContent = 'Working…'; if (w) w.postMessage({ type: 'store-do', op: it.installed ? 'del' : 'add', name: it.name }); };
    row.append(d, btn); list.append(row);
  }
  $('st-msg').textContent = j ? (j.op === 'add' ? 'Installing ' + j.name + '… ' + (pct !== null ? pct + '%' + (rate ? ' · ' + rate : '') : '(downloading it can take a minute)') : 'Removing ' + j.name + '…')
    : m.busy.length ? (m.ready ? '' : 'Waiting for Linux to be ready… (if it stays, restart Linux)')
    : k ? (k.rc ? (k.op === 'add' ? 'Could not install ' : 'Could not remove ') + k.name + '.' : k.op === 'add' ? k.name + ' installed: type ' + k.name + ' in the terminal.' : k.name + ' removed.') : '';
  $('st-log').textContent = (m.log || '').split('\n').map((l) => l.slice(l.lastIndexOf('\r') + 1)).join('\n');
}
$('store').onclick = () => {
  if (!w) $('start').click();
  $('info').classList.remove('show');
  $('st').hidden = false;
  $('st-list').textContent = 'Loading…'; $('st-msg').textContent = ''; $('st-log').textContent = '';
  stReq();
};
$('st-x').onclick = () => { $('st').hidden = true; fit(); term.focus(); };

/* ---- device folders at /mnt/NAME ----
   showDirectoryPicker (Chrome, Edge, Brave on computers; XeOS on iPad adds its own) gives a folder
   that can be read and, where the browser allows it, written. Elsewhere (Safari on iPhone) the
   folder input gives a read-only copy of the files. The worker asks for a file when a program
   opens it (mfetch) and sends back what programs changed (msync). */
const mounted = new Map(); // root -> { dir, files: Map(path -> handle or File), list, ro }
const note = (t) => term.write('\r\n\x1b[2m[' + t + ']\x1b[0m\r\n');
const safeName = (n) => (n || 'folder').replace(/[\/\\\0\n\t]/g, '_').replace(/^\.+/, '') || 'folder';
async function entries(dir) {
  const out = [];
  if (dir.values) { for await (const e of dir.values()) out.push(e); }
  else if (dir.entries) { for await (const [, e] of dir.entries()) out.push(e); }
  return out;
}
async function mountDir(dir) {
  const root = '/mnt/' + safeName(dir.name);
  const files = new Map(), lines = [];
  let count = 0;
  const walk = async (d, path) => {
    for (const e of await entries(d)) {
      if (++count > 50000) return;
      const p = path + '/' + safeName(e.name);
      if (e.kind === 'directory') { lines.push('D\t' + p); await walk(e, p); }
      else { let size = 0; try { size = (await e.getFile()).size; } catch (er) {} files.set(p, e); lines.push('F\t' + p + '\t' + size); }
    }
  };
  note('reading the folder list of ' + dir.name + '…');
  await walk(dir, root);
  let ro = true;
  try { ro = dir.queryPermission ? (await dir.queryPermission({ mode: 'readwrite' })) === 'denied' : false; } catch (er) { ro = false; }
  if (!ro && !(window.FileSystemFileHandle && FileSystemFileHandle.prototype.createWritable) && !dir.getFileHandle) ro = true;
  return { root, dir, files, list: lines.join('\n'), ro };
}
function mountFiles(list) { // the folder input: a read-only copy
  const first = list[0] && list[0].webkitRelativePath ? list[0].webkitRelativePath.split('/')[0] : 'folder';
  const root = '/mnt/' + safeName(first), files = new Map(), dirs = new Set(), lines = [];
  for (const f of list) {
    const parts = (f.webkitRelativePath || f.name).split('/').map(safeName);
    parts.shift();
    let p = root;
    for (const d of parts.slice(0, -1)) { p += '/' + d; if (!dirs.has(p)) { dirs.add(p); lines.push('D\t' + p); } }
    p += '/' + parts[parts.length - 1];
    files.set(p, f); lines.push('F\t' + p + '\t' + f.size);
  }
  return { root, dir: null, files, list: lines.join('\n'), ro: true };
}
// Without a service worker WebAssembly programs run inside the engine's worker, blocked: it reads the
// device files itself (FileReaderSync), so it gets the File objects beforehand (see worker.js wasiServe)
async function shareFiles(m, only) {
  if (!w || swOn()) return;
  let batch = [];
  const flush = () => { if (batch.length && w) w.postMessage({ type: 'mfiles', files: batch }); batch = []; };
  for (const [p, h] of (only ? [[only, m.files.get(only)]] : m.files)) {
    try { batch.push([p, h && h.getFile ? await h.getFile() : h || null]); } catch (er) { batch.push([p, null]); }
    if (batch.length >= 500) flush();
  }
  flush();
}
function addMount(m) {
  mounted.set(m.root, m);
  if (!w) $('start').click();
  if (w) { w.postMessage({ type: 'mount', root: m.root, list: m.list }); shareFiles(m); }
  note(m.root + ': ' + m.files.size + ' files' + (m.ro ? ', read-only (this browser does not let pages write to folders; ☰ Files brings results out)' : ', changes go back to the folder') + '.  cd ' + m.root);
}
$('mount').onclick = async () => {
  if (window.showDirectoryPicker) {
    try {
      let dir;
      try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); }
      catch (er) { if (er && er.name === 'AbortError') throw er; dir = await window.showDirectoryPicker(); } // pickers that take no options
      addMount(await mountDir(dir));
    }
    catch (er) { if (er && er.name !== 'AbortError') note('could not mount: ' + er.message); }
  } else $('mountdir').click();
};
$('mountdir').onchange = () => { const l = [...$('mountdir').files]; $('mountdir').value = ''; if (l.length) addMount(mountFiles(l)); };
const mntStats = { read: 0, written: 0 }; // bytes read from and written to device folders (tests check them)
const rootOf = (p) => { for (const r of mounted.keys()) if (p.startsWith(r + '/')) return r; return null; };
async function mountFetch(paths) {
  for (const ln of paths) {
    const [p, off, len] = ln.split('\t');
    if (len !== undefined) { // a piece of a big file: only that slice is read from the device
      const m = mounted.get(rootOf(p)), a = +off, n = +len;
      let data = new ArrayBuffer(0);
      for (let k = 0; k < 3; k++) { // a write back in progress may hold the file a moment: try again before giving up
        try { const h = m && m.files.get(p); const f = h && (h.getFile ? await h.getFile() : h); if (f) data = await f.slice(a, a + n).arrayBuffer(); else note(p + ': not found in the device folder'); break; }
        catch (er) { if (k === 2) note(p + ': could not read (' + er.message + ')'); else await new Promise((r) => setTimeout(r, 300)); }
      }
      mntStats.read += data.byteLength;
      if (w) w.postMessage({ type: 'mdata', name: p, off: a, len: n, data }, [data]);
      continue;
    }
    const m = mounted.get(rootOf(p));
    let data = new ArrayBuffer(0);
    try { const h = m && m.files.get(p); const f = h && (h.getFile ? await h.getFile() : h); if (f) data = await f.arrayBuffer(); else note(p + ': not found in the device folder'); }
    catch (er) { note(p + ': could not read (' + er.message + ')'); }
    mntStats.read += data.byteLength;
    if (w) w.postMessage({ type: 'put', name: p, data }, [data]);
  }
}
async function dirFor(m, path, create) { // the device folder holding path
  let d = m.dir;
  for (const s of path.slice(m.root.length + 1).split('/').slice(0, -1)) d = await d.getDirectoryHandle(s, { create });
  return d;
}
let roWarned = false, syncQ = Promise.resolve();
const ranges = new Map(); let rangeId = 0; // pieces of Linux files asked from the worker
const wRange = (path, off, len) => new Promise((res) => { if (!w) return res(null); const id = ++rangeId; ranges.set(id, res); w.postMessage({ type: 'range', id, path, off, len }); });
const PIECE = 4 * 1048576;
let opfsRoot = null;
async function inOpfs(fh) { try { opfsRoot = opfsRoot || await navigator.storage.getDirectory(); return !!(await opfsRoot.resolve(fh)); } catch (er) { return false; } }
// an OPFS file: the worker writes the changed ranges with a sync access handle (createWritable would copy the file first)
const wPart = (o, fh) => new Promise((res) => { if (!w) return res(null); const id = ++rangeId; ranges.set(id, res); try { w.postMessage({ type: 'mwrite', id, path: o.path, size: o.size, ranges: o.ranges, fh }); } catch (er) { ranges.delete(id); res(null); } });
async function mountSync(root, ops) {
  const m = mounted.get(root);
  if (!m) return;
  if (m.ro || !m.dir) { if (!roWarned) { roWarned = true; note(root + ' is read-only here: changes stay in Linux only (☰ Files brings them out)'); } return; }
  for (const o of ops) {
    const base = o.path.split('/').pop();
    try {
      if (o.op === 'mkdir') { await dirFor(m, o.path + '/x', true); }
      else if (o.op === 'write') {
        const fh = await (await dirFor(m, o.path, true)).getFileHandle(base, { create: true });
        const wr = await fh.createWritable(); await wr.write(o.data); await wr.close();
        m.files.set(o.path, fh); shareFiles(m, o.path);
      } else if (o.op === 'wbig') { // a big file: written in 4 MB pieces as the worker hands them, never whole in memory
        const fh = await (await dirFor(m, o.path, true)).getFileHandle(base, { create: true });
        const wr = await fh.createWritable({ keepExistingData: false });
        try {
          for (let off = 0, size = o.size; off < size;) {
            const r = await wRange(o.path, off, PIECE);
            if (!r || !r.data) throw new Error('Linux did not give the file');
            size = r.size;
            if (!r.data.byteLength) break;
            await wr.write({ type: 'write', position: off, data: r.data }); off += r.data.byteLength; mntStats.written += r.data.byteLength;
          }
          await wr.close();
        } catch (er) { try { await wr.abort(); } catch (e2) {} throw er; }
        m.files.set(o.path, fh); shareFiles(m, o.path);
      } else if (o.op === 'wpart') { // a big file changed in places: only those ranges are written, then the size if it changed
        const fh = await (await dirFor(m, o.path, true)).getFileHandle(base, { create: true });
        const r = (await inOpfs(fh)) ? await wPart(o, fh) : null;
        if (r && r.err) throw new Error(r.err);
        if (r) mntStats.written += r.n;
        else { // a folder from showDirectoryPicker: keepExistingData (the browser may copy the file to its own swap file first)
          const size0 = (await fh.getFile()).size;
          const wr = await fh.createWritable({ keepExistingData: true });
          try {
            for (const [a, len] of o.ranges) for (let off = a; off < a + len;) {
              const q = await wRange(o.path, off, Math.min(PIECE, a + len - off));
              if (!q || !q.data) throw new Error('Linux did not give the file');
              if (!q.data.byteLength) break;
              await wr.write({ type: 'write', position: off, data: q.data }); off += q.data.byteLength; mntStats.written += q.data.byteLength;
            }
            if (size0 !== o.size) await wr.truncate(o.size);
            await wr.close();
          } catch (er) { try { await wr.abort(); } catch (e2) {} throw er; }
        }
        m.files.set(o.path, fh); shareFiles(m, o.path);
      } else if (o.op === 'move') {
        const src = m.files.get(o.from);
        if (src && src.move) await src.move(await dirFor(m, o.path, true), base);
        else { // copy, then remove the old one
          const f = src.getFile ? await src.getFile() : src;
          const fh = await (await dirFor(m, o.path, true)).getFileHandle(base, { create: true });
          const wr = await fh.createWritable(); await wr.write(f); await wr.close();
          await (await dirFor(m, o.from, false)).removeEntry(o.from.split('/').pop());
          m.files.set(o.path, fh); m.files.delete(o.from); continue;
        }
        m.files.set(o.path, src); m.files.delete(o.from);
      } else if (o.op === 'remove') {
        await (await dirFor(m, o.path, false)).removeEntry(base, { recursive: !!o.dir });
        m.files.delete(o.path);
      }
    } catch (er) {
      if (er && er.name === 'NotFoundError' && o.op === 'remove') continue;
      note(o.path + ': could not ' + o.op + ' in the device folder (' + (er && er.message) + ')');
      if (er instanceof TypeError) { m.ro = true; note(root + ': this browser cannot write to the folder; it is read-only from now on'); return; }
    }
  }
}

addEventListener('resize', () => fit());
// iPhone/iPad: the on-screen keyboard covers the page; shrink it to the visible area so the key bar stays above the keyboard
const vv = window.visualViewport;
if (vv) {
  const fitView = () => { document.body.style.height = vv.height + 'px'; window.scrollTo(0, 0); fit(); };
  vv.addEventListener('resize', fitView);
  vv.addEventListener('scroll', () => window.scrollTo(0, 0));
  fitView();
}
// no auto-capitals or auto-correct in the terminal
const ta = document.querySelector('.xterm-helper-textarea');
if (ta) { ta.setAttribute('autocapitalize', 'off'); ta.setAttribute('autocorrect', 'off'); ta.setAttribute('spellcheck', 'false'); ta.setAttribute('autocomplete', 'off'); }
// Linux starts at once with the saved choices (the panel with the settings comes back when it stops).
// Inside InkOS (?inkos=1) the window is the terminal, so the page's own header (back link,
// title) steps aside.
if (new URLSearchParams(location.search).has('inkos')) document.body.classList.add('embed');
$('start').click();
