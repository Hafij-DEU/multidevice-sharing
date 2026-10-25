// An update (the .deb, App Hub) replaces app.asar under a running MeshDrop. The old process keeps
// reading the new archive at the old offsets, so pages and lazy code come out as garbage: restart.
import { unwatchFile, watchFile, type Stats } from 'node:fs';

/** Call `fire` once when `file` is replaced (new inode or mtime) and has stayed put for `settle` ms. */
export function onReplaced(file: string, fire: () => void, { interval = 5000, settle = 5000 } = {}): () => void {
  let first: Stats | null = null;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    clearTimeout(timer);
    unwatchFile(file, check);
  };
  function check(cur: Stats, prev: Stats) {
    first ??= prev;
    clearTimeout(timer);
    if (cur.nlink === 0 && cur.ino === 0) return; // gone for now: dpkg is between unlink and rename
    if (cur.ino === first.ino && cur.mtimeMs === first.mtimeMs && cur.size === first.size) return;
    timer = setTimeout(() => {
      stop();
      fire();
    }, settle);
  }
  watchFile(file, { interval, persistent: false }, check);
  return stop;
}
