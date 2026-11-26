// Test helper (item 76): one WebAssembly program in a node worker thread, like the page's wasi-worker.js.
// Its calls reach the engine's thread through a SharedArrayBuffer (Atomics.wait), so the engine and the
// network pump keep running meanwhile (runWasi in the engine's thread would block the WebSocket).
// Layout: Int32 [0] = state (0 free, 1 call, 2 answer, 3 gone); Float64 at 64: nr, a0..a5, outLen,
// data length, ret, out length, target pid; data at 256. Served by serveThreads() in linux-test.mjs.
import { parentPort, workerData } from 'node:worker_threads';
import { runModule, parseInfo, Exit } from '../wasi.js';
const { sab, info, bytes, base, size, spawn, pid } = workerData;
const ctl = new Int32Array(sab, 0, 16), F = new Float64Array(sab, 64, 12), data = new Uint8Array(sab, 256);
const { args, envs } = parseInfo(info);
function sys(nr, a = [], d, outLen = 0, to = pid) { // to: a child this program forked (item 78), F[11]
  const q = [...a, 0, 0, 0, 0, 0, 0].slice(0, 6), b = d || new Uint8Array(0);
  F[11] = to; F[0] = nr; for (let k = 0; k < 6; k++) F[1 + k] = q[k];
  F[7] = outLen; F[8] = b.length; data.set(b);
  Atomics.store(ctl, 0, 1); Atomics.notify(ctl, 0);
  while (Atomics.load(ctl, 0) === 1) Atomics.wait(ctl, 0, 1);
  if (Atomics.load(ctl, 0) === 3) { Atomics.store(ctl, 0, 0); if (to !== pid) return { r: -3, out: null }; throw new Exit(-1); }
  const n = F[10], r = F[9], out = n > 0 ? data.slice(0, n) : null;
  Atomics.store(ctl, 0, 0);
  return { r, out };
}
const code = runModule({ bytes, args, envs, base, size, sys, spawn: spawn ? 2 : 0 });
parentPort.postMessage({ code });
