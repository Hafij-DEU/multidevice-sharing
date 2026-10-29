import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { handoffUrl, cleanHandoff } from '@meshdrop/core/src/handoff.ts';
import { startHandoffServer } from '../src/main/handoff.ts';

describe('handoff links', () => {
  it('YouTube continues at the second; other pages scroll to the text', () => {
    expect(handoffUrl({ url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', time: 754.6 })).toBe('https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=754s');
    expect(handoffUrl({ url: 'https://en.wikipedia.org/wiki/Mesh', scroll: 0.4, text: 'A mesh network is a local-area' })).toBe('https://en.wikipedia.org/wiki/Mesh#:~:text=A%20mesh%20network%20is%20a%20local%2Darea');
    expect(handoffUrl({ url: 'https://x.org/a#part', scroll: 0.4, text: 'here' })).toBe('https://x.org/a#part:~:text=here');
    expect(handoffUrl({ url: 'https://x.org/a', scroll: 0, text: 'top' })).toBe('https://x.org/a');
    expect(handoffUrl({ url: 'javascript:alert(1)' })).toBeNull();
    expect(cleanHandoff({ url: 'file:///etc/passwd' })).toBeNull();
    expect(cleanHandoff({ url: 'https://a.b/', scroll: 5, title: 'T\u0000' })).toMatchObject({ url: 'https://a.b/', scroll: 1, title: 'T ' });
  });
});

describe('the extension door', () => {
  it('answers browser extensions only; polls get commands', async () => {
    const got: unknown[] = [];
    let release: (c: Record<string, unknown>) => void = () => {};
    // Port 0: a fixed or random pick can sit in the ephemeral range, held by some outgoing socket.
    const srv = await startHandoffServer(
      {
        state: (s) => void got.push(s),
        nextCommand: () => new Promise((r) => (release = r)),
        devices: () => [{ deviceId: 'p'.repeat(64), alias: 'Phone' }],
        send: async () => true,
      },
      0,
    );
    expect(srv).not.toBeNull();
    try {
      const base = `http://127.0.0.1:${(srv!.address() as AddressInfo).port}`;
      const ext = { origin: 'chrome-extension://abcdefghijklmnop', 'content-type': 'application/json' };
      expect((await fetch(`${base}/status`)).status).toBe(403); // no extension origin (curl, a web page)
      expect((await fetch(`${base}/status`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
      expect(await (await fetch(`${base}/status`, { headers: ext })).json()).toEqual({ devices: [{ deviceId: 'p'.repeat(64), alias: 'Phone' }] });
      await fetch(`${base}/state`, { method: 'POST', headers: ext, body: JSON.stringify({ url: 'https://a.b/' }) });
      expect(got).toEqual([{ url: 'https://a.b/' }]);
      const poll = fetch(`${base}/poll`, { method: 'POST', headers: ext, body: '{}' }).then((r) => r.json());
      await new Promise((r) => setTimeout(r, 100));
      release({ type: 'snapshot' });
      expect(await poll).toEqual({ type: 'snapshot' });
    } finally {
      srv?.close();
    }
  });
});

describe('the extension package', () => {
  it('carries the app version: App Hub updates the unpacked copy when the release is newer', () => {
    const json = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as { version: string };
    expect(json('../../browser-extension/manifest.json').version).toBe(json('../package.json').version);
  });
});
