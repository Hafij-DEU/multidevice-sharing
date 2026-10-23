import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, signDomain, spkiSha256 } from '../src/mesh/canonical.ts';
import { CompositeTrust, MembershipStore } from '../src/mesh/members.ts';
import { MEMBERSHIP_DOMAIN, MembershipError, signList, type Member, type MembershipList, type SignedMembership } from '../src/mesh/membership.ts';
import { TrustStore, type TrustSource, type TrustedDevice } from '../src/trust.ts';

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'meshdrop-members-'));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const hex32 = () => randomBytes(32).toString('hex');
const spkiPem = (pub: KeyObject) => pub.export({ type: 'spki', format: 'pem' }) as string;
const newKey = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const clone = <T>(v: T): T => structuredClone(v);

interface Mesh {
  root: KeyObject;
  rootPub: KeyObject;
  base: MembershipList;
  /** version `n` of this mesh, signed; `edit` may change the body (members/revoked/...) first. */
  signed(version: number, edit?: (l: MembershipList) => void): SignedMembership;
}

function newMesh(): Mesh {
  const r = newKey();
  const mk = (role: Member['role'], alias: string): Member => ({
    deviceId: hex32(),
    alias,
    publicKeyPem: spkiPem(newKey().publicKey),
    role,
    addedAt: 1790000000000,
  });
  const hub = mk('hub', 'Hub');
  const base: MembershipList = {
    v: 1,
    mesh: spkiSha256(r.publicKey),
    version: 1,
    issuedAt: 1790000000000,
    hub: { deviceId: hub.deviceId, urls: ['https://10.0.0.1:53318'] },
    members: [hub, mk('member', 'Laptop'), mk('member', 'Phone')],
    revoked: [],
  };
  return {
    root: r.privateKey,
    rootPub: r.publicKey,
    base,
    signed(version, edit) {
      const l = clone(base);
      l.version = version;
      l.issuedAt += version;
      edit?.(l);
      return signList(l, r.privateKey);
    },
  };
}

const memFile = (home: string) => join(home, 'mesh', 'membership.json');
const anchorFile = (home: string) => join(home, 'mesh', 'anchor.pem');

/** Everything on disk that makes up the device-side mesh state. */
function disk(home: string): { anchor: string; membership: string } {
  return { anchor: readFileSync(anchorFile(home), 'utf8'), membership: readFileSync(memFile(home), 'utf8') };
}

describe('MembershipStore.init / load', () => {
  it('load returns null when there is no mesh state', async () => {
    expect(await MembershipStore.load(tmp())).toBeNull();
  });

  it('init persists anchor.pem (SPKI PEM) and membership.json as exactly {list, sig}, 0600 in a 0700 dir', async () => {
    const m = newMesh();
    const home = tmp();
    const v1 = m.signed(1);
    const store = await MembershipStore.init(home, m.rootPub, v1);
    expect(store.current()).toEqual(v1);
    expect(store.list()).toEqual(v1.list);
    expect(spkiSha256(store.anchor)).toBe(v1.list.mesh);
    expect(readFileSync(anchorFile(home), 'utf8')).toBe(spkiPem(m.rootPub));
    expect(JSON.parse(readFileSync(memFile(home), 'utf8'))).toEqual({ list: v1.list, sig: v1.sig });
    expect(Object.keys(JSON.parse(readFileSync(memFile(home), 'utf8'))).sort()).toEqual(['list', 'sig']);
    expect(statSync(anchorFile(home)).mode & 0o777).toBe(0o600);
    expect(statSync(memFile(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'mesh')).mode & 0o777).toBe(0o700);

    const reloaded = await MembershipStore.load(home);
    expect(reloaded?.current()).toEqual(v1);
    expect(spkiSha256(reloaded!.anchor)).toBe(spkiSha256(m.rootPub));
  });

  it('init rejects a bad signature / wrong anchor and writes nothing', async () => {
    const m = newMesh();
    const other = newMesh();
    const home = tmp();
    await expect(MembershipStore.init(home, other.rootPub, m.signed(1))).rejects.toThrow(MembershipError);
    const tampered = m.signed(1);
    tampered.list.members[1]!.alias = 'x';
    await expect(MembershipStore.init(home, m.rootPub, tampered)).rejects.toThrow(MembershipError);
    expect(existsSync(anchorFile(home))).toBe(false);
    expect(existsSync(memFile(home))).toBe(false);
    expect(await MembershipStore.load(home)).toBeNull();
  });

  it('init refuses to replace an existing mesh state (no silent re-anchoring)', async () => {
    const m = newMesh();
    const other = newMesh();
    const home = tmp();
    await MembershipStore.init(home, m.rootPub, m.signed(2));
    const before = disk(home);
    await expect(MembershipStore.init(home, other.rootPub, other.signed(1))).rejects.toThrow(MembershipError);
    await expect(MembershipStore.init(home, m.rootPub, m.signed(1))).rejects.toThrow(MembershipError);
    expect(disk(home)).toEqual(before);
  });

  it('init can complete a half-written state (crash between the two files)', async () => {
    const m = newMesh();
    const home = tmp();
    await MembershipStore.init(home, m.rootPub, m.signed(1));
    unlinkSync(memFile(home));
    await expect(MembershipStore.load(home)).rejects.toThrow(MembershipError); // fail closed
    const s = await MembershipStore.init(home, m.rootPub, m.signed(1));
    expect(s.list().version).toBe(1);
    expect((await MembershipStore.load(home))?.list().version).toBe(1);
  });

  it('load fails closed on anything that does not verify', async () => {
    const m = newMesh();
    const other = newMesh();
    const mk = async () => {
      const home = tmp();
      await MembershipStore.init(home, m.rootPub, m.signed(1));
      return home;
    };

    // tampered list body
    let home = await mk();
    const doc = JSON.parse(readFileSync(memFile(home), 'utf8')) as SignedMembership;
    doc.list.members[1]!.alias = 'Mallory';
    writeFileSync(memFile(home), JSON.stringify(doc));
    await expect(MembershipStore.load(home)).rejects.toThrow(MembershipError);

    // swapped anchor (attacker plants their own root + their own validly-signed list)
    home = await mk();
    writeFileSync(anchorFile(home), spkiPem(other.rootPub));
    await expect(MembershipStore.load(home)).rejects.toThrow(MembershipError);

    // anchor and list both from another mesh is *consistent* (it is a different mesh, not a forgery) — but a mix is not
    home = await mk();
    writeFileSync(memFile(home), JSON.stringify(other.signed(1)));
    await expect(MembershipStore.load(home)).rejects.toThrow(MembershipError);

    // garbage JSON / garbage PEM / wrong shape
    home = await mk();
    writeFileSync(memFile(home), '{not json');
    await expect(MembershipStore.load(home)).rejects.toThrow(MembershipError);
    home = await mk();
    writeFileSync(anchorFile(home), 'garbage');
    await expect(MembershipStore.load(home)).rejects.toThrow(MembershipError);
    home = await mk();
    writeFileSync(memFile(home), JSON.stringify([1, 2]));
    await expect(MembershipStore.load(home)).rejects.toThrow(MembershipError);

    // a non-P-256 anchor
    home = await mk();
    writeFileSync(anchorFile(home), spkiPem(generateKeyPairSync('ed25519').publicKey));
    await expect(MembershipStore.load(home)).rejects.toThrow(MembershipError);

    // only one of the two files
    home = await mk();
    unlinkSync(anchorFile(home));
    await expect(MembershipStore.load(home)).rejects.toThrow(MembershipError);
  });
});

describe('MembershipStore.accept — rollback / fork / foreign-mesh (Review Focus #2)', () => {
  /** Reload from disk and assert both persisted files still hold exactly `expected`. */
  async function expectPersisted(home: string, expected: SignedMembership, files: { anchor: string; membership: string }) {
    expect(disk(home)).toEqual(files);
    expect(JSON.parse(readFileSync(memFile(home), 'utf8'))).toEqual(expected);
    const re = await MembershipStore.load(home);
    expect(re).not.toBeNull();
    expect(re!.current()).toEqual(expected);
    expect(re!.list()).toEqual(expected.list);
  }

  it("accept(v3) is 'updated' and persisted; accept(v2) is then 'stale' and changes nothing", async () => {
    const m = newMesh();
    const home = tmp();
    const store = await MembershipStore.init(home, m.rootPub, m.signed(1));

    const v3 = m.signed(3);
    expect(store.accept(v3)).toBe('updated');
    expect(store.current()).toEqual(v3);
    await expectPersisted(home, v3, disk(home));

    const files = disk(home);
    const v2 = m.signed(2);
    expect(store.accept(v2)).toBe('stale');
    expect(store.current()).toEqual(v3);
    expect(store.list().version).toBe(3);
    await expectPersisted(home, v3, files);
  });

  it("a validly-signed older list stays 'stale' even with a different body (e.g. un-revoking)", async () => {
    const m = newMesh();
    const home = tmp();
    const revokedId = m.base.members[2]!.deviceId;
    const v5 = m.signed(5, (l) => {
      l.members = l.members.filter((x) => x.deviceId !== revokedId);
      l.revoked.push({ deviceId: revokedId, revokedAt: 1790000009000 });
    });
    const store = await MembershipStore.init(home, m.rootPub, v5);
    const files = disk(home);
    const v4 = m.signed(4); // still lists the revoked device as a member
    expect(store.accept(v4)).toBe('stale');
    expect(store.isTrusted(revokedId)).toBe(false);
    expect(store.isRevoked(revokedId)).toBe(true);
    await expectPersisted(home, v5, files);
  });

  it("the very same list is 'same' (idempotent re-delivery)", async () => {
    const m = newMesh();
    const home = tmp();
    const v3 = m.signed(3);
    const store = await MembershipStore.init(home, m.rootPub, v3);
    const files = disk(home);
    expect(store.accept(clone(v3))).toBe('same');
    await expectPersisted(home, v3, files);
    expect(store.accept(v3)).toBe('same');
  });

  it('accept(v3) with a different body throws fork and changes nothing', async () => {
    const m = newMesh();
    const home = tmp();
    const v3 = m.signed(3);
    const store = await MembershipStore.init(home, m.rootPub, v3);
    const files = disk(home);

    const forkedBody = m.signed(3, (l) => void (l.members[1]!.alias = 'Evil twin'));
    expect(() => store.accept(forkedBody)).toThrow(MembershipError);
    expect(() => store.accept(forkedBody)).toThrow('fork');
    expect(store.current()).toEqual(v3);
    await expectPersisted(home, v3, files);
  });

  it('same version and body but a different signature is also a fork', async () => {
    const m = newMesh();
    const home = tmp();
    const v3 = m.signed(3);
    const store = await MembershipStore.init(home, m.rootPub, v3);
    const files = disk(home);
    const resigned = signList(clone(v3.list), m.root); // ECDSA is randomised => new, valid, different sig
    expect(resigned.sig).not.toBe(v3.sig);
    expect(() => store.accept(resigned)).toThrow('fork');
    expect(store.current()).toEqual(v3);
    await expectPersisted(home, v3, files);
  });

  it('a list signed by a foreign root throws and leaves the current list unchanged (any version)', async () => {
    const m = newMesh();
    const foreign = newMesh();
    const home = tmp();
    const v3 = m.signed(3);
    const store = await MembershipStore.init(home, m.rootPub, v3);
    const files = disk(home);

    for (const version of [1, 3, 4, 99]) {
      expect(() => store.accept(foreign.signed(version))).toThrow(MembershipError);
      expect(store.current()).toEqual(v3);
    }
    // foreign key signing OUR mesh id
    const forged = signList(clone(m.signed(9).list), foreign.root);
    expect(() => store.accept(forged)).toThrow(MembershipError);
    expect(store.current()).toEqual(v3);
    await expectPersisted(home, v3, files);
  });

  it('a broken signature or tampered body throws — even when the version is stale', async () => {
    const m = newMesh();
    const home = tmp();
    const v3 = m.signed(3);
    const store = await MembershipStore.init(home, m.rootPub, v3);
    const files = disk(home);

    const staleTampered = m.signed(2);
    staleTampered.list.members[1]!.alias = 'x';
    expect(() => store.accept(staleTampered)).toThrow(MembershipError);

    const newerTampered = m.signed(4);
    newerTampered.list.version = 5;
    expect(() => store.accept(newerTampered)).toThrow(MembershipError);

    const badSig = m.signed(4);
    badSig.sig = badSig.sig.slice(0, -6) + 'AAAAAA';
    expect(() => store.accept(badSig)).toThrow(MembershipError);

    for (const junk of [null, {}, { list: m.base, sig: 'AA==' }]) expect(() => store.accept(junk as never)).toThrow(MembershipError);

    expect(store.current()).toEqual(v3);
    await expectPersisted(home, v3, files);
  });

  it('a newer list with an invalid body (signed by the root) is rejected', async () => {
    const m = newMesh();
    const home = tmp();
    const v1 = m.signed(1);
    const store = await MembershipStore.init(home, m.rootPub, v1);
    const files = disk(home);
    const l = clone(m.base);
    l.version = 2;
    l.members[1]!.role = 'hub'; // two hubs: validly signed by the root, but not a valid list
    const bad = { list: l, sig: signDomain(MEMBERSHIP_DOMAIN, canonicalJson(l), m.root) };
    expect(() => store.accept(bad)).toThrow(/invalid list: hub/);
    await expectPersisted(home, v1, files);
  });

  it('persists before reporting updated: a failed write throws and keeps the in-memory list', async () => {
    const m = newMesh();
    const home = tmp();
    const v1 = m.signed(1);
    const store = await MembershipStore.init(home, m.rootPub, v1);
    // make the final rename impossible: membership.json becomes a non-empty directory
    unlinkSync(memFile(home));
    mkdirSync(memFile(home));
    writeFileSync(join(memFile(home), 'x'), '');
    expect(() => store.accept(m.signed(2))).toThrow();
    expect(store.current()).toEqual(v1);
    expect(store.list().version).toBe(1);
    // no tmp litter left behind
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(home, 'mesh')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('updated lists are written atomically at 0600 and survive reload; the trust set follows', async () => {
    const m = newMesh();
    const home = tmp();
    const store = await MembershipStore.init(home, m.rootPub, m.signed(1));
    const added: Member = { deviceId: hex32(), alias: 'Tablet', publicKeyPem: spkiPem(newKey().publicKey), role: 'member', addedAt: 1790000005000 };
    const v2 = m.signed(2, (l) => void l.members.push(added));
    expect(store.isTrusted(added.deviceId)).toBe(false);
    expect(store.accept(v2)).toBe('updated');
    expect(store.isTrusted(added.deviceId)).toBe(true);
    expect(statSync(memFile(home)).mode & 0o777).toBe(0o600);
    const re = await MembershipStore.load(home);
    expect(re!.isTrusted(added.deviceId)).toBe(true);
    expect(re!.current()).toEqual(v2);
  });

  it('current() / list() return copies; mutating them does not alter the store', async () => {
    const m = newMesh();
    const home = tmp();
    const v1 = m.signed(1);
    const store = await MembershipStore.init(home, m.rootPub, v1);
    store.current().list.members[1]!.alias = 'x';
    store.list().members.length = 0;
    expect(store.current()).toEqual(v1);
    expect(store.accept(clone(v1))).toBe('same');
  });
});

describe('MembershipStore trust queries', () => {
  it('members map to TrustedDevice; non-members and revoked ids are not trusted', async () => {
    const m = newMesh();
    const gone: Member = { deviceId: hex32(), alias: 'Gone', publicKeyPem: spkiPem(newKey().publicKey), role: 'member', addedAt: 1 };
    const store = await MembershipStore.init(
      tmp(),
      m.rootPub,
      m.signed(2, (l) => void l.revoked.push({ deviceId: gone.deviceId, revokedAt: 99 })),
    );
    const laptop = m.base.members[1]!;
    expect(store.isTrusted(laptop.deviceId)).toBe(true);
    expect(store.get(laptop.deviceId)).toEqual<TrustedDevice>({ deviceId: laptop.deviceId, alias: laptop.alias, publicKeyPem: laptop.publicKeyPem, addedAt: laptop.addedAt });
    expect(store.isTrusted(m.base.hub.deviceId)).toBe(true); // the hub is a member
    expect(store.isTrusted(hex32())).toBe(false);
    expect(store.get(hex32())).toBeUndefined();
    expect(store.isTrusted(gone.deviceId)).toBe(false);
    expect(store.get(gone.deviceId)).toBeUndefined();
    expect(store.isRevoked(gone.deviceId)).toBe(true);
    expect(store.isRevoked(laptop.deviceId)).toBe(false);
  });

  it("an unrelated device's own id is not trusted unless it is a member", async () => {
    const m = newMesh();
    const store = await MembershipStore.init(tmp(), m.rootPub, m.signed(1));
    const self = hex32(); // this device, not (yet) in the list
    expect(store.isTrusted(self)).toBe(false);
  });
});

describe('CompositeTrust', () => {
  function manualStore(devs: TrustedDevice[]): TrustStore {
    const t = new TrustStore(join(tmp(), 'trust.json'));
    for (const d of devs) t.add(d);
    return t;
  }
  const manualDev = (alias = 'Manual'): TrustedDevice => ({ deviceId: hex32(), alias, publicKeyPem: spkiPem(newKey().publicKey), addedAt: 5 });

  it('trusts mesh members and manual devices, nothing else', async () => {
    const m = newMesh();
    const store = await MembershipStore.init(tmp(), m.rootPub, m.signed(1));
    const man = manualDev();
    const c = new CompositeTrust(store, manualStore([man]));
    expect(c.isTrusted(m.base.members[1]!.deviceId)).toBe(true);
    expect(c.get(m.base.members[1]!.deviceId)?.alias).toBe('Laptop');
    expect(c.isTrusted(man.deviceId)).toBe(true);
    expect(c.get(man.deviceId)).toEqual(man);
    const stranger = hex32();
    expect(c.isTrusted(stranger)).toBe(false);
    expect(c.get(stranger)).toBeUndefined();
  });

  it('a mesh-revoked id is not trusted even if the manual TrustStore lists it', async () => {
    const m = newMesh();
    const man = manualDev();
    const store = await MembershipStore.init(
      tmp(),
      m.rootPub,
      m.signed(2, (l) => void l.revoked.push({ deviceId: man.deviceId, revokedAt: 7 })),
    );
    const manual = manualStore([man]);
    expect(manual.isTrusted(man.deviceId)).toBe(true);
    const c = new CompositeTrust(store, manual);
    expect(c.isTrusted(man.deviceId)).toBe(false);
    expect(c.get(man.deviceId)).toBeUndefined();
  });

  it('a revoked mesh member is untrusted via the composite, including after accept() of the revoking list', async () => {
    const m = newMesh();
    const store = await MembershipStore.init(tmp(), m.rootPub, m.signed(1));
    const victim = m.base.members[2]!;
    const manual = manualStore([{ deviceId: victim.deviceId, alias: 'also manual', publicKeyPem: victim.publicKeyPem, addedAt: 1 }]);
    const c = new CompositeTrust(store, manual);
    expect(c.isTrusted(victim.deviceId)).toBe(true);
    store.accept(
      m.signed(2, (l) => {
        l.members = l.members.filter((x) => x.deviceId !== victim.deviceId);
        l.revoked.push({ deviceId: victim.deviceId, revokedAt: 8 });
      }),
    );
    expect(c.isTrusted(victim.deviceId)).toBe(false);
    expect(c.get(victim.deviceId)).toBeUndefined();
  });

  it('the mesh list wins on alias and key when a device is in both', async () => {
    const m = newMesh();
    const store = await MembershipStore.init(tmp(), m.rootPub, m.signed(1));
    const laptop = m.base.members[1]!;
    const stale = { deviceId: laptop.deviceId, alias: 'old manual alias', publicKeyPem: spkiPem(newKey().publicKey), addedAt: 1 };
    const c = new CompositeTrust(store, manualStore([stale]));
    expect(c.get(laptop.deviceId)).toEqual({ deviceId: laptop.deviceId, alias: 'Laptop', publicKeyPem: laptop.publicKeyPem, addedAt: laptop.addedAt });
  });

  it('with no mesh (null) it behaves exactly like the manual store', () => {
    const man = manualDev();
    const manual = manualStore([man]);
    const c = new CompositeTrust(null, manual);
    expect(c.isTrusted(man.deviceId)).toBe(true);
    expect(c.get(man.deviceId)).toEqual(man);
    expect(c.isTrusted(hex32())).toBe(false);
  });

  it('is usable wherever a TrustSource is expected and follows later manual changes', () => {
    const manual = manualStore([]);
    const src: TrustSource = new CompositeTrust(null, manual);
    const d = manualDev();
    expect(src.isTrusted(d.deviceId)).toBe(false);
    manual.add(d);
    expect(src.isTrusted(d.deviceId)).toBe(true);
  });
});

// keep canonicalJson import honest: the persisted list must be what was signed
describe('persisted state is the signed bytes', () => {
  it('membership.json list canonicalises to the signed payload', async () => {
    const m = newMesh();
    const home = tmp();
    const v1 = m.signed(1);
    await MembershipStore.init(home, m.rootPub, v1);
    const doc = JSON.parse(readFileSync(memFile(home), 'utf8')) as SignedMembership;
    expect(canonicalJson(doc.list)).toBe(canonicalJson(v1.list));
    chmodSync(memFile(home), 0o600);
  });
});
