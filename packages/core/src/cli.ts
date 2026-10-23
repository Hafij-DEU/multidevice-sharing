#!/usr/bin/env node
// meshdrop command line (M1). Run with `node packages/core/src/cli.ts <command>` (Node 24 strips
// the types). Every command takes --home (overrides $MESHDROP_HOME) so two instances can run side
// by side. `listen` is the long-running receiver (and the only command that runs multicast
// discovery); `pair`, `send`, `peers` and `resume` are one-shot client commands that never bind the
// mesh port, so they work next to a running `listen` on the same home. They reach trusted devices
// at the address recorded by `pair` (re-probed on start).
import { stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Engine, UnknownDeviceError, type EngineEvent, type EngineOptions, type SendItem, type SendResult } from './engine.ts';
import { DEFAULT_MESH_PORT, type DeviceType } from './discovery.ts';
import { configDir } from './paths.ts';
import { installStopSignals } from './signals.ts';

const USAGE = `usage: meshdrop <command> [options]

commands:
  id                                    print this device's id
  listen [--port N] [--inbox DIR]       receive until Ctrl-C
  peers                                 list trusted devices and whether they are reachable
  pair <host[:port]> <alias>            trust the device at host:port (both sides must pair)
  send <deviceId-prefix|all> <path...> [--text "..."]
                                        send files/folders (and/or text); exit 0 only if every target is done
  resume                                resume unfinished sends from the outbox

options:
  --home DIR            config dir (default: $MESHDROP_HOME, $XDG_CONFIG_HOME/meshdrop, ~/.config/meshdrop)
  --port N              mesh port (default ${DEFAULT_MESH_PORT})
  --inbox DIR           where received files go (default ~/Downloads/MeshDrop)
  --alias NAME          name shown to peers (default: host name)
  --device-type T       desktop | mobile | headless (default desktop)
  --no-discovery        listen: no multicast announce/discovery
  -h, --help            this help`;

class UsageError extends Error {}

const out = (s: string) => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');

/**
 * Characters that must never reach the terminal raw from network-sourced strings (aliases from
 * announces/info, received text and paths, peer error text): C0 controls (incl. ESC, so no escape
 * sequence survives), DEL, C1 controls (incl. 8-bit CSI), line/paragraph separators and the bidi
 * controls (ALM, LRM, RLM, LRE..RLO, LRI..PDI) that can visually reorder a line.
 */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Escapes UNPRINTABLE characters: \n, \r, \t as such, everything else as \u{XXXX}. One line out. */
function printable(s: unknown): string {
  return String(s).replace(UNPRINTABLE, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}`;
  });
}

function fmtBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${v.toFixed(2)} ${units[i]}`;
}

const short = (id: string) => id.slice(0, 8);

function parseHostPort(s: string): { host: string; port: number } {
  let host = s;
  let portStr: string | undefined;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) {
    host = v6[1]!;
    portStr = v6[2];
  } else if ((s.match(/:/g) ?? []).length === 1) {
    [host, portStr] = s.split(':') as [string, string];
  }
  const port = portStr === undefined ? DEFAULT_MESH_PORT : Number(portStr);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`invalid address "${s}"`);
  return { host, port };
}

function nameOf(engine: Engine, deviceId: string): string {
  const t = engine.trust.get(deviceId);
  return t ? `${printable(t.alias)} (${short(deviceId)})` : short(deviceId);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      home: { type: 'string' },
      port: { type: 'string' },
      inbox: { type: 'string' },
      alias: { type: 'string' },
      'device-type': { type: 'string' },
      text: { type: 'string' },
      'no-discovery': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...args] = positionals;
  if (values.help || !cmd) {
    out(USAGE);
    return cmd || values.help ? 0 : 2;
  }

  const port = values.port === undefined ? DEFAULT_MESH_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`invalid --port "${values.port}"`);
  const deviceType = values['device-type'] ?? 'desktop';
  if (!['desktop', 'mobile', 'headless'].includes(deviceType)) throw new UsageError(`invalid --device-type "${deviceType}"`);

  const base: EngineOptions = {
    home: values.home ?? configDir(),
    port,
    deviceType: deviceType as DeviceType,
  };
  if (values.inbox !== undefined) base.inbox = values.inbox;
  if (values.alias !== undefined) base.alias = values.alias;
  if (values['no-discovery']) base.discovery = false;

  switch (cmd) {
    case 'id':
      return cmdId(base, args);
    case 'listen':
      return cmdListen(base, args);
    case 'peers':
      return cmdPeers(base, args);
    case 'pair':
      return cmdPair(base, args);
    case 'send':
      return cmdSend(base, args, values.text);
    case 'resume':
      return cmdResume(base, args);
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

function noArgs(cmd: string, args: string[]): void {
  if (args.length > 0) throw new UsageError(`${cmd}: unexpected argument "${args[0]}"`);
}

async function cmdId(base: EngineOptions, args: string[]): Promise<number> {
  noArgs('id', args);
  const e = await Engine.create(base);
  out(`device id: ${e.identity.deviceId}`);
  out(`short id:  ${short(e.identity.deviceId)}`);
  out(`alias:     ${printable(e.alias)}`);
  out(`home:      ${printable(e.home)}`);
  out(`trusted:   ${e.trust.list().length} device(s)`);
  return 0;
}

/**
 * Stops the engine on the first SIGINT/SIGTERM (in-flight sends end 'cancelled' and stay resumable,
 * hashing is abandoned); resolves with the signal name. A second signal exits at once (130 / 143).
 */
function onSignal(engine: Engine): { promise: Promise<string>; dispose: () => void } {
  let resolveFn!: (s: string) => void;
  const promise = new Promise<string>((r) => (resolveFn = r));
  const dispose = installStopSignals((sig) => {
    err('stopping... (press Ctrl-C again to quit immediately)');
    void engine.stop();
    resolveFn(sig);
  });
  return { promise, dispose };
}

async function cmdListen(base: EngineOptions, args: string[]): Promise<number> {
  noArgs('listen', args);
  const e = await Engine.create({ ...base, serve: true });
  const sizes = new Map<string, number>(); // sessionId -> total bytes
  const lastPct = new Map<string, number>(); // sessionId/fileId -> last printed decile
  // A multi-homed host announces from every interface, so its host alternates; print a peer once
  // per alias/port, not on every host flip.
  const shown = new Map<string, string>(); // deviceId -> alias:port
  e.on('event', (ev: EngineEvent) => {
    if (ev.source === 'discovery') {
      const p = ev.peer;
      if (ev.type === 'lost') {
        shown.delete(p.deviceId);
        out(`lost   ${printable(p.alias)} (${short(p.deviceId)})`);
      } else if (shown.get(p.deviceId) !== `${p.alias}:${p.port}`) {
        shown.set(p.deviceId, `${p.alias}:${p.port}`);
        const tag = e.trust.isTrusted(p.deviceId) ? 'trusted' : 'untrusted';
        out(`peer   ${printable(p.alias)} (${short(p.deviceId)}) at ${printable(p.host)}:${p.port} [${tag}]`);
      }
      return;
    }
    if (ev.source !== 'receiver') return;
    const who = nameOf(e, ev.from);
    switch (ev.type) {
      case 'offer': {
        const total = ev.manifest.files.reduce((n, f) => n + f.size, 0);
        sizes.set(ev.sessionId, total);
        out(`offer  from ${who}: ${ev.manifest.files.length} file(s), ${fmtBytes(total)}${ev.manifest.text !== undefined ? ', text' : ''} [${ev.sessionId}]`);
        break;
      }
      case 'progress': {
        const key = `${ev.sessionId}/${ev.fileId}`;
        const pct = Math.floor((ev.chunks / ev.total) * 10) * 10;
        if (pct > (lastPct.get(key) ?? -1)) {
          lastPct.set(key, pct);
          out(`recv   ${who} file ${ev.fileId}: ${pct}% (${ev.chunks}/${ev.total} chunks)`);
        }
        break;
      }
      case 'file':
        out(`saved  ${printable(ev.path)}`);
        break;
      case 'received':
        out(`done   from ${who}: ${ev.files.length} file(s)${sizes.has(ev.sessionId) ? `, ${fmtBytes(sizes.get(ev.sessionId)!)}` : ''}`);
        if (ev.text !== undefined) out(`text   ${printable(ev.text)}`);
        break;
      case 'error':
        err(`error  ${printable(ev.code)} (session ${ev.sessionId || '?'}, from ${ev.from ? who : '?'})`);
        break;
      case 'cancelled':
        out(`cancel ${who} cancelled session ${ev.sessionId}`);
        break;
    }
  });
  const sig = onSignal(e);
  try {
    await e.start();
  } catch (x) {
    sig.dispose();
    throw x;
  }
  out(`listening on port ${e.port} as ${printable(e.alias)} (${short(e.identity.deviceId)}), inbox ${printable(e.inboxDir)}`);
  out(`device id ${e.identity.deviceId}`);
  const s = await sig.promise;
  await e.stop();
  sig.dispose();
  out(`stopped (${s})`);
  return 0;
}

async function startClient(base: EngineOptions): Promise<Engine> {
  const e = await Engine.create({ ...base, serve: false });
  await e.start();
  return e;
}

async function cmdPeers(base: EngineOptions, args: string[]): Promise<number> {
  noArgs('peers', args);
  const e = await startClient(base);
  try {
    const trusted = e.trust.list();
    const peers = e.peers();
    if (trusted.length === 0) out('no trusted devices (pair one with `meshdrop pair <host[:port]> <alias>`)');
    for (const p of peers) {
      out(`${p.trusted ? 'trusted  ' : 'untrusted'} ${printable(p.alias).padEnd(20)} ${short(p.deviceId)} ${printable(p.host)}:${p.port} ${printable(p.deviceType)}${p.manual ? ' manual' : ''}`);
    }
    const seen = new Set(peers.map((p) => p.deviceId));
    for (const t of trusted.filter((t) => !seen.has(t.deviceId))) out(`offline   ${printable(t.alias).padEnd(20)} ${short(t.deviceId)}`);
    return 0;
  } finally {
    await e.stop();
  }
}

async function cmdPair(base: EngineOptions, args: string[]): Promise<number> {
  if (args.length !== 2) throw new UsageError('pair: expected <host[:port]> <alias>');
  const { host, port } = parseHostPort(args[0]!);
  const e = await startClient(base);
  try {
    const d = await e.pairManual(host, port, args[1]!);
    out(`paired ${printable(d.alias)} (${short(d.deviceId)}) at ${printable(host)}:${port}`);
    out(`their device id: ${d.deviceId}`);
    out(`this device id:  ${e.identity.deviceId}`);
    // First contact is unauthenticated (trust on first use): only an out-of-band comparison of the
    // ids detects an active man-in-the-middle during pairing.
    out(`Verify: run \`meshdrop id\` on the other device and check it shows ${d.deviceId}`);
    out(`The other device must pair back (meshdrop pair <this-host>:${base.port ?? DEFAULT_MESH_PORT} <alias>) and should see ${e.identity.deviceId}`);
    return 0;
  } finally {
    await e.stop();
  }
}

function printResults(e: Engine, results: SendResult[], stats: Map<string, { bytes: Map<number, number>; started: number; ended?: number }>): void {
  for (const r of results) {
    const s = stats.get(r.deviceId);
    const bytes = s ? [...s.bytes.values()].reduce((a, b) => a + b, 0) : 0;
    const secs = s?.ended !== undefined ? (s.ended - s.started) / 1000 : 0;
    const rate = secs > 0 && bytes > 0 ? ` in ${secs.toFixed(1)} s (${fmtBytes(bytes / secs)}/s)` : '';
    const detail = r.status === 'done' ? `${fmtBytes(bytes)}${rate}` : printable(r.error ?? '');
    out(`${r.status.padEnd(9)} ${nameOf(e, r.deviceId)}  ${detail}${r.sessionId ? `  [${r.sessionId}]` : ''}`.trimEnd());
  }
}

/** Collects per-device bytes and timing from sender events; prints a line every 10% per file. */
function trackSends(e: Engine, started: number) {
  const stats = new Map<string, { bytes: Map<number, number>; started: number; ended?: number }>();
  const lastPct = new Map<string, number>();
  e.on('event', (ev: EngineEvent) => {
    if (ev.source !== 'sender') return;
    let s = stats.get(ev.deviceId);
    if (!s) stats.set(ev.deviceId, (s = { bytes: new Map(), started }));
    if (ev.type === 'progress') {
      s.bytes.set(ev.fileId, ev.total);
      const key = `${ev.deviceId}/${ev.fileId}`;
      const pct = ev.total === 0 ? 100 : Math.floor((ev.sent / ev.total) * 10) * 10;
      if (pct > (lastPct.get(key) ?? -1)) {
        lastPct.set(key, pct);
        out(`sending   ${nameOf(e, ev.deviceId)} file ${ev.fileId}: ${pct}% of ${fmtBytes(ev.total)}`);
      }
    } else {
      s.ended = Date.now();
    }
  });
  return stats;
}

async function cmdSend(base: EngineOptions, args: string[], text: string | undefined): Promise<number> {
  const [target, ...paths] = args;
  if (!target || (paths.length === 0 && text === undefined)) throw new UsageError('send: expected <deviceId-prefix|all> <path...> [--text "..."]');
  const items: SendItem[] = [];
  for (const p of paths) {
    let st;
    try {
      st = await stat(p);
    } catch {
      throw new UsageError(`send: no such file or directory: ${p}`);
    }
    items.push({ kind: st.isDirectory() ? 'dir' : 'file', srcPath: p });
  }
  if (text !== undefined) items.push({ kind: 'text', text });

  const e = await startClient(base);
  const sig = onSignal(e);
  try {
    const ids = target === 'all' ? 'all' : target.split(',').map((q) => e.resolveDeviceId(q));
    const started = Date.now();
    const stats = trackSends(e, started);
    out(`preparing ${items.length} item(s)...`);
    const results = await e.send(ids, items);
    if (results.length === 0) {
      err('meshdrop: no trusted device is present (pair one with `meshdrop pair`, or check that it is running)');
      return 1;
    }
    printResults(e, results, stats);
    return results.every((r) => r.status === 'done') ? 0 : 1;
  } finally {
    await e.stop();
    sig.dispose();
  }
}

async function cmdResume(base: EngineOptions, args: string[]): Promise<number> {
  noArgs('resume', args);
  const e = await startClient(base);
  const sig = onSignal(e);
  try {
    const stats = trackSends(e, Date.now());
    const results = await e.resumePending();
    if (results.length === 0) {
      out('nothing to resume');
      return 0;
    }
    printResults(e, results, stats);
    return results.every((r) => r.status === 'done') ? 0 : 1;
  } finally {
    await e.stop();
    sig.dispose();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof UsageError || (e as { code?: string })?.code?.startsWith('ERR_PARSE_ARGS')) {
      err(`meshdrop: ${printable((e as Error).message)}`);
      err(USAGE);
      process.exitCode = 2;
    } else if (e instanceof UnknownDeviceError) {
      err(`meshdrop: ${printable(e.message)}`);
      process.exitCode = 2;
    } else {
      err(`meshdrop: ${printable((e as Error)?.message ?? String(e))}`);
      process.exitCode = 1;
    }
  },
);
