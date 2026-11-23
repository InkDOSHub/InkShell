/* Service worker, only for WebAssembly programs: the module runs in its own Worker (wasi-worker.js)
   and makes each WASI call a synchronous request to "__wasi?s=SESSION". This worker passes it to the
   engine's worker over BroadcastChannel "inkshell-wasi-SESSION" and answers with its reply.
   Every other request goes to the network untouched (no cache here). */
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
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
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
