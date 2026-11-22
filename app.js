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
  const c = new Worker('worker.js?v=17');
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
    const r = new Worker('worker.js?v=17');
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
let ctrl = false;
const send = (t) => { if (w) w.postMessage({ type: 'key', data: t }); };

function start() {
  if (starting || w) return;
  starting = true;
  term.write('\x1b[2mStarting Alpine Linux on InkSoC…\x1b[0m\r\n');
  w = new Worker('worker.js?v=17');
  starting = false;
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'out') term.write(m.text);
    else if (m.type === 'file') {
      if (!m.data) { term.write('\r\n\x1b[31m' + m.path + ': not found\x1b[0m\r\n'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([m.data]));
      a.download = m.path.split('/').pop() || 'file';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } else if (m.type === 'saved') term.write('\r\n\x1b[2m[files saved]\x1b[0m\r\n');
    else if (m.type === 'info') { pref.set('alpine-user', m.user || ''); }
    else if (m.type === 'done') {
      term.write('\r\n\x1b[2m[' + (m.error ? 'stopped: ' + m.error : 'Linux ended') + ']\x1b[0m\r\n');
      if (w) w.terminate();
      w = null;
      setTimeout(() => { if (!w) openSettings(); }, 1500);
    }
  };
  fit();
  w.postMessage({ type: 'start', rows: term.rows, cols: term.cols, network, poolMb: budget().pool, targetMb: 8192 });
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
$('down').onclick = () => {
  const p = prompt('File to download (path, e.g. /home/you/notes.txt):', '/home/');
  if (p && w) w.postMessage({ type: 'get', path: p });
};

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
