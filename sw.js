/* Service worker, only for WebAssembly programs: the module runs in its own Worker (wasi-worker.js)
   and makes each WASI call a synchronous request to "__wasi?s=SESSION". This worker passes it to the
   engine's worker over BroadcastChannel "inkshell-wasi-SESSION" and answers with its reply.
   Item 94: the page and its Workers' scripts come back with COOP/COEP headers (cross-origin isolation:
   SharedArrayBuffer + Atomics.wait, so a program Worker can block on the engine directly, without this
   worker in the middle; see app.js wasiStart). Every other request goes to the network untouched (no cache here). */
'use strict';
const chans = new Map(), wait = new Map();
let next = 1;
function chan(sid) {
  let c = chans.get(sid);
  if (!c) {
    c = new BroadcastChannel('inkshell-wasi-' + sid);
    c.onmessage = (e) => { const r = wait.get(e.data.id); if (r) { wait.delete(e.data.id); r(e.data.body); } };
    chans.set(sid, c);
  }
  return c;
}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// GitHub Pages sets no such headers: they are added here (a reply that is a redirect or an error stays as it is)
function isolated(r) {
  if (!r || r.type === 'opaqueredirect' || r.status < 200 || r.status > 299) return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url), q = e.request;
  if (u.origin === location.origin && q.method === 'GET' && (q.mode === 'navigate' || q.destination === 'worker')) {
    e.respondWith(fetch(q).then(isolated));
    return;
  }
  if (u.origin !== location.origin || !u.pathname.endsWith('/__wasi') || e.request.method !== 'POST') return;
  e.respondWith((async () => {
    const body = await e.request.arrayBuffer();
    const id = next++;
    const got = new Promise((r) => wait.set(id, r));
    chan(u.searchParams.get('s') || '').postMessage({ id, body });
    // the engine answers within ~15 s (a "pending" reply when the call still waits: the module asks again)
    const t = new Promise((r) => setTimeout(() => r(null), 30000));
    const res = await Promise.race([got, t]);
    wait.delete(id);
    if (!res) return new Response('no answer from the engine', { status: 504 });
    return new Response(res, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
  })());
});
