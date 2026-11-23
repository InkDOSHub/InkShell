// The engine's swap for node hosts (tests/linux-test.mjs, tests/bench-engine.mjs): what the page
// keeps in its OPFS swap file, here in 64 KB chunks (16 slots of 4 KB) of a Map. Imports:
// host_swap_read/write (one slot, the engine's pages) and host_swap_readv/writev (n contiguous
// slots in one call: 64 KB extents of big Linux files). Slots never written read as zeros.
const PG = 4096, PER = 16, CH = PG * PER;
export function swapStore(memory) {
  const chunks = new Map();
  const io = (slot, n, p, write) => {
    let b = new Uint8Array(memory().buffer, p, n * PG);
    while (n > 0) {
      const k = Math.floor(slot / PER), i = slot % PER, c = Math.min(n, PER - i), len = c * PG;
      let ch = chunks.get(k);
      if (write) { if (!ch) chunks.set(k, ch = new Uint8Array(CH)); ch.set(b.subarray(0, len), i * PG); }
      else if (ch) b.set(ch.subarray(i * PG, i * PG + len)); else b.fill(0, 0, len);
      b = b.subarray(len); slot += c; n -= c;
    }
  };
  return {
    chunks,
    imports: {
      host_swap_write: (s, p) => io(s, 1, p, true),
      host_swap_read: (s, p) => io(s, 1, p, false),
      host_swap_writev: (s, n, p) => io(s, n, p, true),
      host_swap_readv: (s, n, p) => io(s, n, p, false),
    },
  };
}
