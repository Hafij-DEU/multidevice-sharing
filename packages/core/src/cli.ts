#!/usr/bin/env node
// meshdrop command line (M1). Run with `node packages/core/src/cli.ts <command>` (Node 24 strips
// the types). Every command takes --home (overrides $MESHDROP_HOME) so two instances can run side
// by side. `listen` is the long-running receiver (and the only command that runs multicast
// discovery); `pair`, `send`, `peers`, `resume` and `outbox` are one-shot client commands that never bind the
// mesh port, so they work next to a running `listen` on the same home. They reach trusted devices
// at the address recorded by `pair` (re-probed on start).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import QRCode from 'qrcode';
import { parseArgs } from 'node:util';
import {
  Engine,
  liveListener,
  UnknownDeviceError,
  UnknownOutboxEntryError,
  type EngineEvent,
  type EngineOptions,
  type SendItem,
  type SendResult,
} from './engine.ts';
import { DEFAULT_MESH_PORT, type DeviceType } from './discovery.ts';
import { DEFAULT_INGRESS_PORT } from './hub/server.ts';
import { ReachManager } from './reach/manager.ts';
import { configDir } from './paths.ts';
import { installStopSignals } from './signals.ts';
import { writeFileAtomic } from './trust.ts';

const USAGE = `usage: meshdrop <command> [options]

commands:
  id                                    print this device's id
  listen [--port N] [--inbox DIR]       receive until Ctrl-C
  peers                                 list trusted devices and whether they are reachable
  pair <host[:port]> <alias>            trust the device at host:port (both sides must pair)
  send <deviceId-prefix|all> <path...> [--text "..."]
                                        send files/folders (and/or text); exit 0 only if every target is done
  resume                                resume unfinished sends from the outbox
  outbox                                list unfinished sends (paused, failed or interrupted)
  outbox rm <sessionId-prefix>          drop an unfinished send (and tell its receiver to discard it)
  hub init [--url wss://...]...         make this device the hub of a new mesh
  hub status                            this device's role, list version, members and hub URLs
  hub revoke <deviceId-prefix>          remove a device from the mesh for good (hub only)
  hub reach [status|detect|off|tailscale|cloudflare <host>|port-forward <name> --token-file F [--manual]]
                                        how this hub is reached from the internet (applied by listen)
  hub recovery-export <file>            save the mesh root key + device list, passphrase-encrypted
  hub recovery-import <file>            restore a mesh on this (fresh) device; it becomes the hub
  invite                                print a single-use QR invite (valid 5 minutes)
  join <meshdrop://join?...> [--alias]  join a mesh with an invite
  members                               list the devices in this mesh
  link create <path>... [--days N] [--passphrase-file F] [--max-downloads N] [--allow-uploads]
                                        hub only: an encrypted internet link (key in the URL #fragment)
  link list / link revoke <id-prefix>   the hub's internet links
  guest [--share <path>]... [--accept-all]
                                        a guest QR link for a browser on this network: the guest sends
                                        to this device (you accept each send) and downloads --share files

options:
  --home DIR            config dir (default: $MESHDROP_HOME, $XDG_CONFIG_HOME/meshdrop, ~/.config/meshdrop)
  --port N              mesh port (default ${DEFAULT_MESH_PORT})
  --inbox DIR           where received files go (default ~/Downloads/MeshDrop)
  --alias NAME          name shown to peers (default: host name)
  --device-type T       desktop | mobile | headless (default desktop)
  --no-discovery        listen: no multicast announce/discovery
  --url URL             hub init: public wss:// URL of the hub (repeatable)
  --passphrase-file F   hub recovery-*: read the passphrase from F instead of the terminal
  --share PATH          guest: a file the guest may download (repeatable)
  --accept-all          guest: accept every send without asking
  --minutes N           guest: how long the link works (5..1440, default 60)
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
      url: { type: 'string', multiple: true },
      'passphrase-file': { type: 'string' },
      share: { type: 'string', multiple: true },
      'accept-all': { type: 'boolean' },
      minutes: { type: 'string' },
      days: { type: 'string' },
      'max-downloads': { type: 'string' },
      'allow-uploads': { type: 'boolean' },
      'token-file': { type: 'string' },
      manual: { type: 'boolean' },
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
    case 'outbox':
      return cmdOutbox(base, args);
    case 'hub':
      return args[0] === 'reach' ? cmdReach(base, args.slice(1), values) : cmdHub(base, args, values.url ?? [], values['passphrase-file']);
    case 'invite':
      noArgs('invite', args);
      return cmdInvite(base);
    case 'join':
      if (args.length !== 1) throw new UsageError('join: expected <meshdrop://join?...>');
      return cmdJoin(base, args[0]!);
    case 'members':
      noArgs('members', args);
      return cmdMembers(base);
    case 'link':
      return cmdLink(base, args, values);
    case 'guest':
      noArgs('guest', args);
      return cmdGuest(base, values.share ?? [], values['accept-all'] === true, values.minutes);
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
  // The desktop app (or another listen) already receives for this device: two would fight over
  // the hub link. Exit 0 so a systemd unit does not restart-loop.
  const other = await liveListener(e.home, e.identity.deviceId);
  if (other && other.pid !== process.pid) {
    out(`MeshDrop is already receiving on this home (pid ${other.pid}, port ${other.port}); not starting another listener`);
    return 0;
  }
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
    if (ev.source === 'mesh') {
      switch (ev.type) {
        case 'online': out('hub    linked'); break;
        case 'offline': out('hub    link lost (reconnecting)'); break;
        case 'membership': out(`mesh   device list v${ev.version ?? '?'}`); break;
        case 'joined': out(`mesh   joined (list v${ev.version ?? '?'})`); break;
        case 'revoked': out('mesh   this device was removed from the mesh'); break;
        case 'held-delivered': out(`held   delivered to ${nameOf(e, ev.to ?? '')} [${printable(ev.sessionId)}]`); break;
        case 'held-failed': out(`held   delivery to ${nameOf(e, ev.to ?? '')} failed: ${printable(ev.error)} [${printable(ev.sessionId)}]`); break;
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
  const st = e.hubStatus();
  if (st.role === 'hub') out(`hub    serving the mesh (list v${st.version}, ${st.members} device(s)), tunnel ingress 127.0.0.1:${e.hubIngressPort}`);
  const pidFile = join(e.home, 'listen.pid');
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port: e.port }), { mode: 0o600 });
  const s = await sig.promise;
  rmSync(pidFile, { force: true });
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

/**
 * The engine for `send` / `resume`. Next to a running `listen` it is client-only (LAN only: the
 * listener owns this device's single hub link). Without a listener, a device in a mesh runs a
 * short-lived engine with its own hub link (ephemeral ports, no multicast), so it can relay or
 * leave files on the hub.
 */
async function startSender(base: EngineOptions): Promise<Engine> {
  const probe = await Engine.create({ ...base, serve: false });
  if (probe.hubStatus().role === 'none' || listenerRunning(base.home!)) return startClient(base);
  const e = await Engine.create({ ...base, serve: true, port: 0, discovery: false, hub: { ingressPort: 0 } });
  await e.start();
  for (let i = 0; i < 50 && !e.hubStatus().online; i++) await new Promise((r) => setTimeout(r, 100));
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
    const detail = r.status === 'done' ? `${fmtBytes(bytes)}${rate}` : r.status === 'held' ? 'left on the hub until the device connects' : printable(r.error ?? '');
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

  const e = await startSender(base);
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
    return results.every((r) => r.status === 'done' || r.status === 'held') ? 0 : 1;
  } finally {
    await e.stop();
    sig.dispose();
  }
}

async function cmdResume(base: EngineOptions, args: string[]): Promise<number> {
  noArgs('resume', args);
  const e = await startSender(base);
  const sig = onSignal(e);
  try {
    const stats = trackSends(e, Date.now());
    const results = await e.resumePending();
    if (results.length === 0) {
      out('nothing to resume');
      return 0;
    }
    printResults(e, results, stats);
    return results.every((r) => r.status === 'done' || r.status === 'held') ? 0 : 1;
  } finally {
    await e.stop();
    sig.dispose();
  }
}

async function cmdOutbox(base: EngineOptions, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === 'list' || sub === 'ls') {
    noArgs('outbox', rest);
    const e = await Engine.create({ ...base, serve: false });
    const items = await e.listOutbox();
    if (items.length === 0) out('outbox is empty');
    for (const it of items) {
      const to = it.alias !== undefined ? `${printable(it.alias)} (${short(it.deviceId)})` : `${short(it.deviceId)} (no longer trusted)`;
      const what = `${it.files} file(s), ${fmtBytes(it.bytes)}${it.text ? ', text' : ''}`;
      out(`${it.sessionId}  to ${to}  ${what}  created ${new Date(it.createdAt).toISOString()}`);
    }
    return 0;
  }
  if (sub === 'rm' || sub === 'remove') {
    if (rest.length !== 1) throw new UsageError('outbox rm: expected <sessionId-prefix>');
    const e = await startClient(base); // re-probes manual peers so the receiver can be told
    try {
      const { removed, cancelled } = await e.removeOutbox(rest[0]!);
      out(`removed ${removed.sessionId} (to ${nameOf(e, removed.deviceId)}); ${cancelled ? 'receiver notified' : 'receiver not reachable, it discards the partial data after 30 days'}`);
      return 0;
    } finally {
      await e.stop();
    }
  }
  throw new UsageError(`outbox: unknown subcommand "${sub}"`);
}

// ---- mesh (M2) ----------------------------------------------------------------------------------

/** The `meshdrop listen` running on this home ({pid, port} in listen.pid, live process), or null. */
function listener(home: string): { pid: number; port: number } | null {
  try {
    const j = JSON.parse(readFileSync(join(home, 'listen.pid'), 'utf8')) as { pid?: unknown; port?: unknown };
    if (!Number.isInteger(j.pid) || (j.pid as number) <= 0 || !Number.isInteger(j.port)) return null;
    process.kill(j.pid as number, 0);
    return { pid: j.pid as number, port: j.port as number };
  } catch {
    return null;
  }
}

function listenerRunning(home: string): boolean {
  return listener(home) !== null;
}

async function readPassphrase(file: string | undefined, confirm: boolean): Promise<string> {
  if (file !== undefined) return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (!process.stdin.isTTY) throw new UsageError('no terminal to ask for the passphrase: use --passphrase-file');
  const ask = (q: string) =>
    new Promise<string>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.startsWith(q)) process.stderr.write(q);
      };
      rl.question(q, (a) => {
        rl.close();
        process.stderr.write('\n');
        resolve(a);
      });
    });
  const p = await ask('passphrase: ');
  if (confirm && (await ask('again:      ')) !== p) throw new UsageError('the passphrases do not match');
  return p;
}

async function cmdHub(base: EngineOptions, args: string[], urls: string[], passFile: string | undefined): Promise<number> {
  const [sub, ...rest] = args;
  const home = base.home!;
  switch (sub) {
    case 'init': {
      noArgs('hub init', rest);
      if (listenerRunning(home)) throw new UsageError('hub init: stop `meshdrop listen` on this device first');
      const e = await Engine.create(base);
      const s = await e.hubInit(urls);
      out(`mesh created: ${s.list.mesh}`);
      out(`this device is the hub (${short(e.identity.deviceId)}); run \`meshdrop listen\`, then \`meshdrop invite\` to add devices`);
      return 0;
    }
    case 'status': {
      noArgs('hub status', rest);
      const e = await Engine.create(base);
      const st = e.hubStatus();
      out(`role:     ${st.role}`);
      if (st.role === 'none') return 0;
      out(`list:     v${st.version}, ${st.members} device(s)`);
      out(`hub:      ${st.hubId ? short(st.hubId) : '?'}`);
      out(`urls:     ${st.urls.length ? st.urls.map(printable).join(' ') : '(none: LAN only)'}`);
      out(`listener: ${listenerRunning(home) ? 'running' : 'not running'}`);
      return 0;
    }
    case 'revoke': {
      if (rest.length !== 1) throw new UsageError('hub revoke: expected <deviceId-prefix>');
      const prefix = rest[0]!;
      if (listenerRunning(home)) {
        // The running hub owns the list: hand it the request and wait for its answer.
        const id = randomBytes(9).toString('base64url');
        const dir = join(home, 'hub', 'requests');
        writeFileAtomic(join(dir, `${id}.json`), JSON.stringify({ op: 'revoke', prefix }));
        const done = join(dir, `${id}.done.json`);
        for (let i = 0; i < 100 && !existsSync(done); i++) await new Promise((r) => setTimeout(r, 100));
        if (!existsSync(done)) throw new Error('hub revoke: the running listener did not answer');
        const r = JSON.parse(readFileSync(done, 'utf8')) as { ok: boolean; version?: number; error?: string };
        rmSync(done, { force: true });
        if (!r.ok) throw new Error(`hub revoke: ${r.error ?? 'failed'}`);
        out(`revoked; device list is now v${r.version}`);
        return 0;
      }
      const e = await Engine.create({ ...base, serve: true, port: 0, discovery: false, hub: { ingressPort: 0 } });
      await e.start();
      try {
        const s = await e.revoke(prefix);
        out(`revoked; device list is now v${s.list.version} (devices get it when they next reach the hub)`);
        return 0;
      } finally {
        await e.stop();
      }
    }
    case 'recovery-export': {
      if (rest.length !== 1) throw new UsageError('hub recovery-export: expected <file>');
      const e = await Engine.create(base);
      const text = e.exportRecovery(await readPassphrase(passFile, true));
      writeFileSync(rest[0]!, text, { mode: 0o600, flag: 'wx' });
      out(`saved ${printable(rest[0]!)}; keep it and the passphrase safe: together they control the mesh`);
      return 0;
    }
    case 'recovery-import': {
      if (rest.length !== 1) throw new UsageError('hub recovery-import: expected <file>');
      if (listenerRunning(home)) throw new UsageError('hub recovery-import: stop `meshdrop listen` on this device first');
      const e = await Engine.create(base);
      const s = await e.importRecovery(readFileSync(rest[0]!, 'utf8'), await readPassphrase(passFile, false));
      out(`restored mesh ${s.list.mesh}; this device is the hub now (list v${s.list.version}). Run \`meshdrop listen\`.`);
      return 0;
    }
    default:
      throw new UsageError(`hub: unknown subcommand "${sub ?? ''}"`);
  }
}

async function cmdInvite(base: EngineOptions): Promise<number> {
  // The invite carries the address of this device's receiver: the running listener's port.
  const l = listener(base.home!);
  const e = await Engine.create(l ? { ...base, port: l.port } : base);
  const { uri } = e.createInvite();
  out(uri);
  out(await QRCode.toString(uri, { type: 'terminal', small: true }));
  out(l ? 'valid for 5 minutes, once' : 'note: start `meshdrop listen` on this device so the invite can be redeemed');
  return 0;
}

async function cmdJoin(base: EngineOptions, uri: string): Promise<number> {
  const e = await Engine.create(base);
  const status = await e.join(uri);
  if (status === 'member') out(`joined: this device is in the mesh (list v${e.hubStatus().version})`);
  else out('joined provisionally: the inviting device will have the hub sign this device in; keep `meshdrop listen` running');
  return 0;
}

async function cmdMembers(base: EngineOptions): Promise<number> {
  const e = await Engine.create(base);
  const ms = e.members();
  if (ms.length === 0) {
    out('not in a mesh (run `meshdrop hub init`, or `meshdrop join <invite>`)');
    return 0;
  }
  for (const m of ms) {
    const me = m.deviceId === e.identity.deviceId ? ' (this device)' : '';
    out(`${printable(m.alias).padEnd(20)} ${m.role.padEnd(6)} ${short(m.deviceId)}${me}`);
  }
  return 0;
}

// ---- internet reach (M5c) -----------------------------------------------------------------------

async function cmdReach(base: EngineOptions, args: string[], values: { 'token-file'?: string; manual?: boolean }): Promise<number> {
  const home = base.home!;
  const m = new ReachManager({ home, ingressPort: () => DEFAULT_INGRESS_PORT, attachPublic: () => {}, publish: async () => {} });
  const [sub, ...rest] = args;
  const applied = () => out(listenerRunning(home) ? 'saved; restart `meshdrop listen` (or the MeshDrop app) to apply it' : 'saved; `meshdrop listen` applies it');
  switch (sub ?? 'status') {
    case 'status': {
      const c = m.config;
      out(`mode:  ${c.mode}${c.cloudflareHost ? ` (${printable(c.cloudflareHost)})` : ''}${c.duckdnsDomain ? ` (${printable(c.duckdnsDomain)}.duckdns.org)` : ''}`);
      out(`token: ${m.status().tokenSet ? 'set' : 'not set'}`);
      return 0;
    }
    case 'detect': {
      const d = await m.detect();
      out(`router WAN address: ${d.wanIp ?? 'unknown'}${d.upnp ? ' (UPnP)' : d.natpmp ? ' (NAT-PMP)' : ''}`);
      out(`public address:     ${d.publicIp ?? 'unknown'}`);
      out(`suggestion:         ${d.suggestion}`);
      out(d.reason);
      return 0;
    }
    case 'off':
    case 'tailscale':
      m.save({ mode: sub as "off" | "tailscale" });
      applied();
      return 0;
    case 'cloudflare':
      if (rest.length !== 1) throw new UsageError('hub reach cloudflare: expected <hostname on your Cloudflare domain>');
      m.save({ mode: 'cloudflare', cloudflareHost: rest[0]! });
      applied();
      return 0;
    case 'port-forward': {
      if (rest.length !== 1) throw new UsageError('hub reach port-forward: expected <duckdns name> --token-file F');
      const token = values['token-file'] !== undefined ? readFileSync(values['token-file'], 'utf8').trim() : undefined;
      if (token === undefined && !m.status().tokenSet) throw new UsageError('hub reach port-forward: --token-file F (your DuckDNS token) is needed once');
      m.save({ mode: 'port-forward', duckdnsDomain: rest[0]!, mapping: values.manual ? 'manual' : 'auto' }, token !== undefined ? { duckdnsToken: token } : {});
      applied();
      return 0;
    }
    default:
      throw new UsageError(`hub reach: unknown subcommand "${sub}"`);
  }
}

// ---- internet guest links (M5b) ----------------------------------------------------------------

async function cmdLink(base: EngineOptions, args: string[], values: { days?: string; 'max-downloads'?: string; 'allow-uploads'?: boolean; 'passphrase-file'?: string; text?: string }): Promise<number> {
  const [sub, ...rest] = args;
  const e = await Engine.create(base);
  switch (sub) {
    case 'create': {
      if (rest.length === 0 && values.text === undefined) throw new UsageError('link create: expected <path>... (or --text)');
      const days = values.days === undefined ? 7 : Number(values.days);
      if (!Number.isFinite(days) || days < 1 / 24 || days > 30) throw new UsageError(`invalid --days "${values.days}" (1/24..30)`);
      const max = values['max-downloads'] === undefined ? undefined : Number(values['max-downloads']);
      if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 1000)) throw new UsageError(`invalid --max-downloads "${values['max-downloads']}" (1..1000)`);
      const password = values['passphrase-file'] !== undefined ? readFileSync(values['passphrase-file'], 'utf8').replace(/\r?\n$/, '') : undefined;
      const l = await e.linkCreate({
        files: rest.map((p) => resolve(p)), days, allowUploads: values['allow-uploads'] === true,
        ...(values.text !== undefined ? { text: values.text } : {}), ...(password ? { password } : {}), ...(max !== undefined ? { maxDownloads: max } : {}),
      });
      out(l.url);
      out(await QRCode.toString(l.url, { type: 'terminal', small: true }));
      out(`expires ${new Date(l.expiresAt).toLocaleString()}; anyone with the whole link can download (keep the part after #)`);
      return 0;
    }
    case 'list': {
      noArgs('link list', rest);
      const ls = await e.linkList();
      if (ls.length === 0) out('no internet links');
      for (const l of ls) {
        out(`${l.id.slice(0, 8)}  ${printable(l.label).padEnd(24)} until ${new Date(l.expiresAt).toLocaleString()}  downloads ${l.downloads}${l.maxDownloads ? `/${l.maxDownloads}` : ''}${l.hasPassword ? '  password' : ''}${l.allowUploads ? '  uploads' : ''}`);
        if (l.url) out(`          ${l.url}`);
      }
      return 0;
    }
    case 'revoke': {
      if (rest.length !== 1) throw new UsageError('link revoke: expected <id-prefix>');
      const hits = (await e.linkList()).filter((l) => l.id.startsWith(rest[0]!));
      if (hits.length !== 1) throw new UsageError(hits.length === 0 ? `no link matches "${rest[0]}"` : `"${rest[0]}" matches ${hits.length} links`);
      await e.linkRevoke(hits[0]!.id);
      out(`revoked ${hits[0]!.id.slice(0, 8)}`);
      return 0;
    }
    default:
      throw new UsageError(`link: unknown subcommand "${sub ?? ''}"`);
  }
}

// ---- LAN guests (M5a) -------------------------------------------------------------------------

async function cmdGuest(base: EngineOptions, share: string[], acceptAll: boolean, minutesArg: string | undefined): Promise<number> {
  const minutes = minutesArg === undefined ? undefined : Number(minutesArg);
  if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440)) throw new UsageError(`invalid --minutes "${minutesArg}" (5..1440)`);
  // Its own short-lived receiver (ephemeral port, no multicast) next to whatever else runs on this home.
  const e = await Engine.create({ ...base, serve: true, port: 0, discovery: false });
  await e.start();
  const { promise, dispose } = onSignal(e);
  try {
    const g = await e.guestStart(minutes !== undefined ? { minutes } : {});
    if (share.length > 0) await e.guestShare(share.map((p) => resolve(p)));
    out(g.url);
    out(await QRCode.toString(g.url, { type: 'terminal', small: true }));
    out(`one browser, until ${new Date(g.expiresAt).toLocaleTimeString()}; Ctrl-C ends the session`);
    const ask = process.stdin.isTTY && !acceptAll ? createInterface({ input: process.stdin, output: process.stderr, terminal: true }) : null;
    let queue = Promise.resolve();
    e.on('event', (ev: EngineEvent) => {
      if (ev.source !== 'guest') return;
      if (ev.type === 'offer') {
        const what = [...ev.files.map((f) => `${printable(f.name)} (${f.size} B)`), ...(ev.text !== undefined ? ['a message'] : [])].join(', ');
        queue = queue.then(async () => {
          out(`guest  wants to send: ${what}`);
          let yes = acceptAll;
          if (ask) yes = /^y(es)?$/i.test((await new Promise<string>((r) => ask.question('accept? [y/N] ', r))).trim());
          await (yes ? e.guestAccept(ev.id) : e.guestReject(ev.id)).catch(() => {});
          out(yes ? 'guest  accepted' : 'guest  declined');
        });
      } else if (ev.type === 'received') {
        for (const f of ev.files) out(`file   ${printable(f)}`);
        if (ev.text !== undefined) out(`text   ${printable(ev.text)}`);
      }
    });
    await promise;
    ask?.close();
    await e.guestEnd();
    return 0;
  } finally {
    dispose();
    await e.stop();
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
    } else if (e instanceof UnknownDeviceError || e instanceof UnknownOutboxEntryError) {
      err(`meshdrop: ${printable(e.message)}`);
      process.exitCode = 2;
    } else {
      err(`meshdrop: ${printable((e as Error)?.message ?? String(e))}`);
      process.exitCode = 1;
    }
  },
);
