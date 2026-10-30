// Watch party (M12): rooms where everyone watches the same video in step. A room lives on the PC that
// made it (the hub, or a PC on the LAN); people join with its 6-character code or link, in the app or
// any browser. The server holds the one playback state (source, position at a server time, playing,
// rate); every client follows it and corrects its own player when it drifts.
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';

/** No 0/O, 1/I/L: a code read aloud or from a screen is typed right. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const MAX_ROOMS = 20;
export const MAX_MEMBERS = 50;
const MAX_CHAT = 200;
const ROOM_IDLE_MS = 6 * 3_600_000;
const MEMBER_GONE_MS = 45_000;

export type WatchSource =
  | { kind: 'youtube'; id: string; title: string }
  /** A video the browser plays itself: a direct link, or this server's /w/media/... (Drive, uploads). */
  | { kind: 'video'; url: string; title: string };

export interface WatchState {
  source: WatchSource | null;
  playing: boolean;
  /** Seconds into the video at `updatedAt`. */
  position: number;
  rate: number;
  /** Server time (ms) of the last change: where the video is now follows from it. */
  updatedAt: number;
  /** Who made the last change (a member id), for the "X paused" line. */
  by: string;
  seq: number;
}

export interface WatchMember { id: string; name: string; host: boolean; online: boolean }
export interface WatchChat { id: number; from: string; name: string; text: string; at: number }

export class WatchError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Where the video is now under `s` (seconds), at server time `now`. */
export function positionAt(s: Pick<WatchState, 'playing' | 'position' | 'rate' | 'updatedAt'>, now: number): number {
  return s.playing ? s.position + ((now - s.updatedAt) / 1000) * s.rate : s.position;
}

export function newCode(): string {
  const b = randomBytes(6);
  return Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}

const cleanText = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');

/**
 * What a pasted link plays: YouTube (watch, youtu.be, shorts, live, embed; t= becomes the start),
 * Dropbox (made a direct link), Google Drive (streamed through this server: its links are not direct),
 * or any other http(s) link as a direct video. Null: not something we can play.
 */
export function parseSource(raw: string, code: string): { source: WatchSource; start: number } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  const start = (() => {
    const t = u.searchParams.get('t') ?? u.searchParams.get('start') ?? '';
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
    return m && t ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
  })();
  const ytId = (id: string | undefined | null) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    const seg = u.pathname.split('/').filter(Boolean);
    const id = host === 'youtu.be' ? ytId(seg[0]) : u.pathname === '/watch' ? ytId(u.searchParams.get('v')) : ['shorts', 'live', 'embed', 'v'].includes(seg[0] ?? '') ? ytId(seg[1]) : null;
    return id ? { source: { kind: 'youtube', id, title: 'YouTube video' }, start } : null;
  }
  const name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '') || u.hostname;
  if (host === 'dropbox.com' || host === 'dl.dropboxusercontent.com') {
    if (host === 'dropbox.com') {
      u.searchParams.delete('dl');
      u.searchParams.set('raw', '1'); // the file itself, not Dropbox's page
    }
    return { source: { kind: 'video', url: u.href, title: name }, start: 0 };
  }
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const id = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname)?.[1] ?? u.searchParams.get('id');
    if (!id || !/^[A-Za-z0-9_-]{10,}$/.test(id)) return null;
    return { source: { kind: 'video', url: `/w/media/${code}/drive-${id}`, title: 'Google Drive video' }, start: 0 };
  }
  return { source: { kind: 'video', url: u.href, title: name }, start: 0 };
}

interface Member extends WatchMember {
  lastSeen: number;
  streams: Set<ServerResponse>;
}

/** One room. */
class WatchRoom {
  readonly code: string;
  readonly name: string;
  readonly hostToken: string;
  readonly createdAt: number;
  hostOnly = false;
  state: WatchState;
  readonly members = new Map<string, Member>();
  readonly chat: WatchChat[] = [];
  /** Videos served by this room: uploads and the host PC's own files. */
  readonly media = new Map<string, { path: string; name: string; size: number; owned: boolean }>();
  lastActive: number;
  #chatId = 0;
  readonly #now: () => number;

  constructor(code: string, name: string, now: () => number) {
    this.code = code;
    this.name = name;
    this.hostToken = randomBytes(18).toString('base64url');
    this.#now = now;
    this.createdAt = now();
    this.lastActive = now();
    this.state = { source: null, playing: false, position: 0, rate: 1, updatedAt: now(), by: '', seq: 0 };
  }

  isHost(token: unknown): boolean {
    return typeof token === 'string' && token === this.hostToken;
  }

  view(): { code: string; name: string; hostOnly: boolean; state: WatchState; members: WatchMember[]; chat: WatchChat[] } {
    return {
      code: this.code, name: this.name, hostOnly: this.hostOnly, state: { ...this.state },
      members: [...this.members.values()].filter((m) => m.online).map(({ id, name, host, online }) => ({ id, name, host, online })),
      chat: this.chat.slice(-50),
    };
  }

  #send(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event: string, data: unknown): void {
    for (const m of this.members.values()) for (const s of m.streams) this.#send(s, event, data);
  }

  #membersChanged(): void {
    this.broadcast('members', this.view().members);
  }

  /** A member's event stream opened (Server-Sent Events). */
  attach(id: string, name: string, host: boolean, res: ServerResponse): void {
    let m = this.members.get(id);
    if (!m) {
      if ([...this.members.values()].filter((x) => x.online).length >= MAX_MEMBERS) throw new WatchError(409, 'room-full');
      m = { id, name, host, online: true, lastSeen: this.#now(), streams: new Set() };
      this.members.set(id, m);
    }
    m.name = name || m.name;
    m.host = m.host || host;
    m.online = true;
    m.lastSeen = this.#now();
    m.streams.add(res);
    this.lastActive = this.#now();
    this.#send(res, 'hello', { now: this.#now(), you: id, host: m.host, ...this.view() });
    this.#membersChanged();
    res.on('close', () => {
      m!.streams.delete(res);
      m!.lastSeen = this.#now();
    });
  }

  /** Members whose streams closed a while ago leave; heartbeats keep streams alive. */
  tick(): void {
    const now = this.#now();
    let changed = false;
    for (const m of this.members.values()) {
      if (m.online && m.streams.size === 0 && now - m.lastSeen > MEMBER_GONE_MS) {
        m.online = false;
        changed = true;
      }
      for (const s of m.streams) s.write(`: ${now}\n\n`);
    }
    if (changed) this.#membersChanged();
  }

  get active(): boolean {
    return [...this.members.values()].some((m) => m.streams.size > 0) || this.#now() - this.lastActive < ROOM_IDLE_MS;
  }

  /** A command from a member: playback, source, chat, or (host) control lock. */
  command(member: string, hostToken: unknown, c: Record<string, unknown>): WatchState {
    const m = this.members.get(member);
    if (!m) throw new WatchError(403, 'not-in-room');
    const host = m.host || this.isHost(hostToken);
    const now = this.#now();
    this.lastActive = now;
    const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
    if (c.type === 'chat') {
      const text = cleanText(c.text, 500);
      if (!text) throw new WatchError(400, 'empty');
      const line: WatchChat = { id: ++this.#chatId, from: m.id, name: m.name, text, at: now };
      this.chat.push(line);
      if (this.chat.length > MAX_CHAT) this.chat.shift();
      this.broadcast('chat', line);
      return this.state;
    }
    if (c.type === 'hostOnly') {
      if (!host) throw new WatchError(403, 'host-only');
      this.hostOnly = c.on === true;
      this.broadcast('room', { hostOnly: this.hostOnly });
      return this.state;
    }
    if (this.hostOnly && !host) throw new WatchError(403, 'host-only');
    const s = { ...this.state, position: positionAt(this.state, now), updatedAt: now, by: m.id, seq: this.state.seq + 1 };
    switch (c.type) {
      case 'play':
        s.playing = true;
        if (num(c.position, 0, 1e7) !== null) s.position = num(c.position, 0, 1e7)!;
        break;
      case 'pause':
        s.playing = false;
        if (num(c.position, 0, 1e7) !== null) s.position = num(c.position, 0, 1e7)!;
        break;
      case 'seek': {
        const p = num(c.position, 0, 1e7);
        if (p === null) throw new WatchError(400, 'bad-position');
        s.position = p;
        break;
      }
      case 'rate': {
        const r = num(c.rate, 0.25, 4);
        if (r === null) throw new WatchError(400, 'bad-rate');
        s.rate = r;
        break;
      }
      case 'source': {
        const p = typeof c.url === 'string' ? parseSource(c.url, this.code) : null;
        if (!p) throw new WatchError(400, 'bad-link');
        s.source = typeof c.title === 'string' && c.title.trim() ? { ...p.source, title: cleanText(c.title, 120) } : p.source;
        s.position = p.start;
        s.playing = false;
        s.rate = 1;
        break;
      }
      default:
        throw new WatchError(400, 'bad-command');
    }
    this.state = s;
    this.broadcast('state', s);
    return s;
  }

  /** Plays one of the room's own videos (an upload or a file on this PC). */
  playMedia(id: string, by: string): WatchState {
    const f = this.media.get(id);
    if (!f) throw new WatchError(404, 'not-found');
    const now = this.#now();
    this.state = { source: { kind: 'video', url: `/w/media/${this.code}/${id}`, title: f.name }, playing: false, position: 0, rate: 1, updatedAt: now, by, seq: this.state.seq + 1 };
    this.lastActive = now;
    this.broadcast('state', this.state);
    return this.state;
  }

  close(): void {
    this.broadcast('ended', {});
    for (const m of this.members.values()) for (const s of m.streams) s.end();
    this.members.clear();
  }
}

/** All rooms on this device. Uploaded videos live in `<dir>/<code>/` and go with the room. */
export class WatchRooms {
  readonly #rooms = new Map<string, WatchRoom>();
  readonly #dir: string;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | null = null;

  constructor(dir: string, now: () => number = Date.now) {
    this.#dir = dir;
    this.#now = now;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#sweep(), 15_000);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const code of [...this.#rooms.keys()]) await this.end(code);
  }

  async #sweep(): Promise<void> {
    for (const r of [...this.#rooms.values()]) {
      r.tick();
      if (!r.active) await this.end(r.code);
    }
  }

  create(name: string): WatchRoom {
    if (this.#rooms.size >= MAX_ROOMS) throw new WatchError(507, 'too-many-rooms');
    let code = newCode();
    while (this.#rooms.has(code)) code = newCode();
    const room = new WatchRoom(code, cleanText(name, 60) || 'Watch party', this.#now);
    this.#rooms.set(code, room);
    return room;
  }

  get(code: string): WatchRoom | undefined {
    return this.#rooms.get(code.toUpperCase());
  }

  list(): WatchRoom[] {
    return [...this.#rooms.values()];
  }

  mediaDir(code: string): string {
    return join(this.#dir, code);
  }

  async end(code: string): Promise<void> {
    const r = this.#rooms.get(code);
    if (!r) return;
    this.#rooms.delete(code);
    r.close();
    await fsp.rm(this.mediaDir(code), { recursive: true, force: true });
  }
}
