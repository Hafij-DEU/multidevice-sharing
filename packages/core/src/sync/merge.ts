// Folder sync (M8a): the three-way decision for one path between this device (local), a partner
// (remote) and the version both last agreed on (base). Pure: the round in client.ts carries it out.
// Versions are content hashes; null means the file is not there.
//   L == R                      agree      (the base becomes L)
//   R changed, L == B           take       (download R, or delete when R is gone)
//   L changed, R == B           keep       (the partner pulls ours)
//   both changed, one deleted   the change wins over the delete
//   both changed, both files    the newer mtime wins (tie: the larger device id); only the side
//                               that loses acts: it keeps its own as a conflict copy and takes R
export type Version = string | null;

export interface Side {
  hash: Version;
  /** Modification time (ms) when hash is a file. */
  mtime?: number;
}

export type Decision =
  | { kind: 'agree'; base: Version }
  | { kind: 'take'; base: Version }
  | { kind: 'conflict-take'; base: Version }
  | { kind: 'keep' };

export function decide(local: Side, remote: Side, base: Version, ids: { local: string; remote: string }): Decision {
  const L = local.hash;
  const R = remote.hash;
  if (L === R) return { kind: 'agree', base: L };
  if (L === base) return { kind: 'take', base: R };
  if (R === base) return { kind: 'keep' };
  // Both changed.
  if (L === null) return { kind: 'take', base: R }; // our delete loses to their change
  if (R === null) return { kind: 'keep' }; // their delete loses to our change: they take ours
  const lm = local.mtime ?? 0;
  const rm = remote.mtime ?? 0;
  const remoteWins = rm > lm || (rm === lm && ids.remote > ids.local);
  return remoteWins ? { kind: 'conflict-take', base: R } : { kind: 'keep' };
}

/** "photo (conflict from Phone 2026-10-24 21-30).jpg": the losing version, kept beside the winner. */
export function conflictName(name: string, alias: string, at: Date): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const p = (n: number) => String(n).padStart(2, '0');
  const when = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}-${p(at.getMinutes())}`;
  const who = alias.replace(/[/\\\u0000-\u001f]/g, '_').slice(0, 40);
  return `${stem} (conflict from ${who} ${when})${ext}`;
}
