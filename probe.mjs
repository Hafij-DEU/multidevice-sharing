import net from 'node:net';
import { networkInterfaces } from 'node:os';
const srv = net.createServer((s) => s.end('x')).listen(0, '0.0.0.0');
await new Promise((r) => srv.once('listening', r));
const port = srv.address().port;
const hosts = ['127.0.0.1'];
for (const l of Object.values(networkInterfaces())) for (const a of l ?? []) if (a.family === 'IPv4' && !a.internal) hosts.push(a.address);
for (const h of hosts) {
  const t = [];
  let fail = 0;
  for (let i = 0; i < 300; i++) {
    const t0 = performance.now();
    const ok = await new Promise((res) => {
      const s = net.connect(port, h);
      const to = setTimeout(() => { s.destroy(); res(false); }, 5000);
      s.once('data', () => { clearTimeout(to); s.destroy(); res(true); });
      s.once('error', () => { clearTimeout(to); res(false); });
    });
    if (!ok) fail++;
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  console.log(h, 'fail', fail, 'p50', t[150].toFixed(1), 'p99', t[296].toFixed(1), 'max', t[299].toFixed(1));
}
srv.close();
