// Copies stdin to stdout, prefixing each line with the milliseconds since start ("MS<TAB>line").
// The native runs use it; tests/bench-engine.mjs writes the same format for the engine.
import readline from 'node:readline';
const t0 = performance.now();
for await (const l of readline.createInterface({ input: process.stdin })) console.log(`${(performance.now() - t0).toFixed(1)}\t${l}`);
