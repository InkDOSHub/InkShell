// Store download through the real wisp tunnels (item 62): node 22, real network.
// usage: node tests/wisp-download.mjs [catalog-name ...]   (default: python3 hashtools)
// For each catalog entry: HTTPS GET over a wisp v1 stream (TLS in node, like the terminal's ssl_client
// does), follows redirects, checks sha256 + size from the catalog. Tries the public tunnel, then the Hub relay.
// Prints host of each redirect, bytes, seconds, and where a failed transfer stopped. Exit 1 if a name fails on both.
import fs from 'node:fs';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { Duplex } from 'node:stream';

const TUNNELS = ['wss://wisp.mercurywork.shop/v86/', 'wss://hub.inkdos.workers.dev/net/wisp/'];
const cat = fs.readFileSync('overlay/etc/inksoc/wasm-catalog', 'utf8').split('\n').filter((l) => l && l[0] !== '#').map((l) => l.split('\t'));
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['python3', 'hashtools'];

function packet(t, id, body) { const b = Buffer.alloc(5 + body.length); b[0] = t; b.writeUInt32LE(id, 1); Buffer.from(body).copy(b, 5); return b; }

function openTunnel(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
    const streams = new Map(); let next = 1;
    const t = setTimeout(() => reject(new Error('tunnel open timeout')), 15000);
    ws.onopen = () => { clearTimeout(t); resolve({ url, connect, close: () => ws.close() }); };
    ws.onerror = () => { clearTimeout(t); reject(new Error('tunnel unreachable')); };
    ws.onclose = () => { for (const s of streams.values()) s.destroy(new Error('tunnel closed')); };
    ws.onmessage = (ev) => {
      const b = Buffer.from(ev.data); if (b.length < 5) return;
      const id = b.readUInt32LE(1), s = streams.get(id);
      if (b[0] === 2 && s) s.push(b.subarray(5));
      else if (b[0] === 4 && s) { console.log('  [wisp close stream', id, 'reason', b[5], ']'); streams.delete(id); s.destroy(b[5] === 2 || s.got ? undefined : new Error('stream refused ' + b[5])); if (s.got) s.push(null); }
    };
    function connect(host, port) {
      const id = next++;
      const s = new Duplex({
        read() {},
        write(chunk, _e, cb) { ws.send(packet(2, id, chunk)); cb(); },
        final(cb) { ws.send(packet(4, id, [2])); cb(); },
      });
      s.setTimeout = () => s; s.setNoDelay = () => s; s.setKeepAlive = () => s; s.got = true;
      streams.set(id, s);
      const h = Buffer.from(host), body = Buffer.alloc(3 + h.length); body[0] = 1; body.writeUInt16LE(port, 1); h.copy(body, 3);
      ws.send(packet(1, id, body));
      return s;
    }
  });
}

async function get(tun, url, st, hops = 0) {
  const u = new URL(url);
  const sock = tls.connect({ socket: tun.connect(u.hostname, 443), servername: u.hostname });
  await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
  sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\nUser-Agent: Wget\r\nConnection: close\r\n\r\n`);
  let head = null, buf = Buffer.alloc(0), redirected = false;
  const h = crypto.createHash('sha256');
  return new Promise((resolve, reject) => {
    sock.on('data', (d) => {
      if (!head) {
        buf = Buffer.concat([buf, d]); const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
        head = buf.subarray(0, i).toString(); d = buf.subarray(i + 4);
        const code = +head.split(' ')[1];
        if (code >= 300 && code < 400) {
          const loc = /^location: (.*)$/im.exec(head)[1].trim(); redirected = true; sock.destroy();
          if (hops > 5) return reject(new Error('too many redirects'));
          console.log(`  ${code} -> ${new URL(loc).hostname} (Location ${loc.length} chars)`);
          return get(tun, new URL(loc, url).href, st, hops + 1).then(resolve, reject);
        }
        if (code !== 200) { sock.destroy(); return reject(new Error('HTTP ' + code)); }
        st.total = +(/^content-length: (\d+)/im.exec(head) || [])[1] || 0;
      }
      st.n += d.length; h.update(d); if (!st.logged) { st.logged = 1; console.log('  headers:', head.split('\r\n')[0]); }
    });
    sock.on('end', () => resolve(h.digest('hex')));
    sock.on('error', (e) => { console.log('  tls error:', e.code, e.message); reject(e); });
    sock.on('close', () => redirected || reject(new Error('closed early (' + (head ? 'after headers' : 'before any response, ' + buf.length + ' bytes') + ')')));
  });
}

let bad = 0;
for (const name of names) {
  const e = cat.find((c) => c[0] === name); if (!e) { console.log('no catalog entry', name); bad = 1; continue; }
  let ok = false;
  for (const turl of TUNNELS) {
    const st = { n: 0, total: 0 }, t0 = Date.now();
    console.log(`${name} via ${turl}`);
    try {
      const tun = await openTunnel(turl);
      const sum = await Promise.race([get(tun, e[1], st), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 240 s')), 240000))]);
      tun.close();
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ${st.n} bytes in ${secs} s, sha256 ${sum === e[2] ? 'ok' : 'MISMATCH ' + sum}`);
      if (sum === e[2] && st.n === +e[3]) { ok = true; break; }
    } catch (err) {
      console.log(`  FAILED after ${st.n}/${st.total} bytes, ${((Date.now() - t0) / 1000).toFixed(1)} s: ${err.message}`);
    }
  }
  if (!ok) bad = 1;
}
process.exit(bad);
