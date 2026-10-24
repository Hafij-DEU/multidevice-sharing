import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { GuestError, GuestUploads, type GuestEvent } from '../src/guest/uploads.ts';

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const d = mkdtempSync(join(tmpdir(), 'md-guest-'));
  tmps.push(d);
  const events: GuestEvent[] = [];
  const u = new GuestUploads(join(d, 'partial'), join(d, 'inbox'), (e) => events.push(e));
  return { d, u, events, inbox: join(d, 'inbox'), partial: join(d, 'partial') };
}

const body = (b: Buffer | string) => Readable.from([Buffer.from(b)]);

async function code(p: Promise<unknown> | (() => unknown)): Promise<[number, string]> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof GuestError) return [e.status, e.code];
    throw e;
  }
  throw new Error('expected a GuestError');
}

describe('GuestUploads', () => {
  it('takes nothing before the owner accepts, then stores the files byte-identical', async () => {
    const { u, events, inbox } = setup();
    const data = Buffer.alloc(300_000, 7);
    const { id, status } = u.offer({ files: [{ name: 'photo.jpg', size: data.length, type: 'image/jpeg', thumb: 'data:image/jpeg;base64,AAAA' }, { name: 'empty.txt', size: 0 }], text: 'hello' });
    expect(status).toBe('pending');
    expect(events[0]).toMatchObject({ type: 'guest-offer', id, text: 'hello', files: [{ name: 'photo.jpg', size: 300_000, thumb: 'data:image/jpeg;base64,AAAA' }, { name: 'empty.txt', size: 0 }] });
    expect(await code(u.write(id, 0, 0, body('x')))).toEqual([409, 'not-accepted']);
    await u.accept(id);
    expect(await u.write(id, 0, 0, body(data.subarray(0, 100_000)))).toBe(100_000);
    expect(await code(u.write(id, 0, 5, body('x')))).toEqual([409, 'offset']);
    expect(u.status(id).files[0]!.received).toBe(100_000);
    expect(await u.write(id, 0, 100_000, body(data.subarray(100_000)))).toBe(300_000);
    expect(u.status(id).status).toBe('done');
    expect(readFileSync(join(inbox, 'photo.jpg'))).toEqual(data);
    expect(readFileSync(join(inbox, 'empty.txt')).length).toBe(0);
    expect(events.at(-1)).toEqual({ type: 'guest-received', id, files: [join(inbox, 'photo.jpg'), join(inbox, 'empty.txt')], text: 'hello' });
  });

  it('refuses hostile names, sizes past the declared one, and too many pending offers', async () => {
    const { u } = setup();
    for (const name of ['../evil', '/abs', 'a\u0000b', '', '..']) expect(await code(() => u.offer({ files: [{ name, size: 1 }] }))).toEqual([400, 'bad-offer']);
    expect(await code(() => u.offer({ files: [{ name: 'a', size: -1 }] }))).toEqual([400, 'bad-offer']);
    expect(await code(() => u.offer({ files: [{ name: 'a', size: 1, thumb: 'data:image/png;base64,' + 'A'.repeat(50_000) }] }))).toEqual([400, 'bad-offer']);
    expect(await code(() => u.offer({ files: [{ name: 'a', size: 1, thumb: 'javascript:alert(1)' }] }))).toEqual([400, 'bad-offer']);
    expect(await code(() => u.offer({ files: [] }))).toEqual([400, 'bad-offer']);
    expect(await code(() => u.offer({ text: 'x'.repeat(65_537) }))).toEqual([400, 'bad-offer']);
    expect(await code(() => u.offer({ files: Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}`, size: 1 })) }))).toEqual([400, 'bad-offer']);
    const { id } = u.offer({ files: [{ name: 'small.txt', size: 3 }] });
    await u.accept(id);
    expect(await code(u.write(id, 0, 0, body('toolong')))).toEqual([400, 'too-large']);
    expect(u.status(id).files[0]!.received).toBe(0);
    expect(await code(u.write(id, 5, 0, body('x')))).toEqual([404, 'not-found']);
    for (let i = 0; i < 4; i++) u.offer({ text: `t${i}` });
    expect(await code(() => u.offer({ text: 'one too many' }))).toEqual([429, 'too-many']);
  });

  it('a rejected or cancelled upload leaves nothing behind', async () => {
    const { u, inbox, partial } = setup();
    const { id } = u.offer({ files: [{ name: 'x.bin', size: 10 }] });
    await u.accept(id);
    await u.write(id, 0, 0, body('12345'));
    await u.reject(id);
    expect(await code(u.write(id, 0, 5, body('67890')))).toEqual([410, 'rejected']);
    expect(u.status(id).status).toBe('rejected');
    expect(existsSync(join(partial, id))).toBe(false);
    const b = u.offer({ files: [{ name: 'y.bin', size: 10 }] });
    await u.accept(b.id);
    await u.write(b.id, 0, 0, body('12345'));
    await u.cancelAll();
    expect(await code(u.write(b.id, 0, 5, body('67890')))).toEqual([410, 'rejected']);
    expect(existsSync(inbox) ? readdirSync(inbox) : []).toEqual([]);
    expect(await code(() => u.status('nope'))).toEqual([404, 'not-found']);
  });

  it('never overwrites a file already in the inbox', async () => {
    const { u, inbox } = setup();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'x.txt'), 'old');
    const { id } = u.offer({ files: [{ name: 'x.txt', size: 3 }] });
    await u.accept(id);
    await u.write(id, 0, 0, body('new'));
    expect(readFileSync(join(inbox, 'x.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(inbox, 'x (1).txt'), 'utf8')).toBe('new');
  });
});
