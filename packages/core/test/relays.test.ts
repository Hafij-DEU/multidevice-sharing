import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayStore, signRelays, verifyRelays, type RelayList } from '../src/mesh/relays.ts';

const root = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const list = (version: number): RelayList => ({ v: 1, mesh: 'm1', version, issuedAt: 1, relays: [{ deviceId: 'ab'.repeat(32), urls: ['wss://relay.example.org/mesh/v1/hub'] }] });
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('relay list', () => {
  it('verifies only with the mesh root, for this mesh', () => {
    const s = signRelays(list(1), root.privateKey);
    expect(verifyRelays(s, root.publicKey, 'm1').relays[0]!.deviceId).toBe('ab'.repeat(32));
    expect(() => verifyRelays(s, other.publicKey, 'm1')).toThrow(/signature/);
    expect(() => verifyRelays(s, root.publicKey, 'm2')).toThrow(/another mesh/);
    expect(() => verifyRelays({ ...s, list: { ...s.list, relays: [] } }, root.publicKey, 'm1')).toThrow(/signature/);
    expect(() => signRelays({ ...list(1), relays: [{ deviceId: 'ab'.repeat(32), urls: ['https://x'] }] }, root.privateKey)).toThrow(/wss/);
  });

  it('the store keeps only newer lists, and survives a restart', () => {
    const d = mkdtempSync(join(tmpdir(), 'md-rel-'));
    dirs.push(d);
    const st = new RelayStore(d);
    expect(st.accept(signRelays(list(2), root.privateKey), root.publicKey, 'm1')).toBe('updated');
    expect(st.accept(signRelays(list(1), root.privateKey), root.publicKey, 'm1')).toBe('stale');
    expect(st.accept(signRelays(list(2), root.privateKey), root.publicKey, 'm1')).toBe('same');
    expect(() => st.accept(signRelays(list(3), other.privateKey), root.publicKey, 'm1')).toThrow();
    expect(new RelayStore(d).list(root.publicKey, 'm1')?.version).toBe(2);
    expect(new RelayStore(d).list(other.publicKey, 'm1')).toBeNull();
  });
});
