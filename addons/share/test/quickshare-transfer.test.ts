import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_LAPTOP } from '../src/quickshare/frames.ts';
import { receive, type Incoming, type Received } from '../src/quickshare/receiver.ts';
import { sendTo } from '../src/quickshare/sender.ts';

let dir: string;
let server: Server;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qs-test-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await rm(dir, { recursive: true, force: true });
});

/** A receiver on 127.0.0.1 that answers with `ok`; resolves its port, the offer and the result. */
async function listen(ok: boolean) {
  let offer!: (o: Incoming) => void;
  let result!: (r: Received | null | Error) => void;
  const offered = new Promise<Incoming>((r) => (offer = r));
  const done = new Promise<Received | null | Error>((r) => (result = r));
  const inbox = join(dir, 'inbox');
  server = createServer((sock) => {
    receive(sock, {
      partialDir: join(dir, 'partial'),
      decide: async (o) => {
        offer(o);
        return ok;
      },
      land: async (part, name) => {
        await import('node:fs/promises').then((fs) => fs.mkdir(inbox, { recursive: true }));
        const to = join(inbox, name);
        await rename(part, to);
        return to;
      },
    }).then(result, (e: Error) => result(e));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, offered, done, inbox };
}

describe('Quick Share loopback', () => {
  it('sends files and text, both sides showing the same code', async () => {
    const big = randomBytes(1_300_000); // three 512 KiB chunks
    await writeFile(join(dir, 'big.bin'), big);
    await writeFile(join(dir, 'empty.txt'), '');
    await writeFile(join(dir, 'photo.jpg'), 'not really a jpeg');
    const r = await listen(true);
    let pin = '';
    const progress: number[] = [];
    await sendTo('127.0.0.1', r.port, { paths: [join(dir, 'big.bin'), join(dir, 'empty.txt'), join(dir, 'photo.jpg')], text: 'hello there' }, {
      alias: 'Test PC',
      deviceType: DEVICE_LAPTOP,
      onPin: (p) => (pin = p),
      onProgress: (s) => progress.push(s),
    });
    const offer = await r.offered;
    const got = await r.done;
    expect(got).not.toBeInstanceOf(Error);
    expect(offer.alias).toBe('Test PC');
    expect(offer.pin).toBe(pin);
    expect(pin).toMatch(/^\d{4}$/);
    expect(offer.files.map((f) => [f.name, f.size, f.mime])).toEqual([
      ['big.bin', big.length, 'application/octet-stream'], ['empty.txt', 0, 'text/plain'], ['photo.jpg', 17, 'image/jpeg'],
    ]);
    expect((got as Received).text).toBe('hello there');
    expect(await readFile(join(r.inbox, 'big.bin'))).toEqual(big);
    expect((await readFile(join(r.inbox, 'empty.txt'))).length).toBe(0);
    expect(await readFile(join(r.inbox, 'photo.jpg'), 'utf8')).toBe('not really a jpeg');
    expect(progress.at(-1)).toBe(big.length + 17 + 11);
    expect(await readdir(dir)).not.toContain('partial');
  });

  it('tells the sender when the receiver declines', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    const r = await listen(false);
    await expect(sendTo('127.0.0.1', r.port, { paths: [join(dir, 'a.txt')] }, { alias: 'PC', deviceType: DEVICE_LAPTOP })).rejects.toThrow('The other device declined.');
    expect(await r.done).toBeNull();
  });

  it('sends text alone', async () => {
    const r = await listen(true);
    await sendTo('127.0.0.1', r.port, { paths: [], text: 'https://example.com/x' }, { alias: 'PC', deviceType: DEVICE_LAPTOP });
    const offer = await r.offered;
    expect(offer.texts[0]?.kind).toBe(2);
    expect(await r.done).toEqual({ alias: 'PC', files: [], text: 'https://example.com/x' });
  });
});
