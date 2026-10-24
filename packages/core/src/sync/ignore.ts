// Folder sync: names that are never synced (our own work areas, editors' lock and temp files, OS clutter).
const IGNORED: RegExp[] = [/^\.meshdrop-/, /\.part$/, /^~\$/, /^\.~lock\./, /^\.DS_Store$/, /^Thumbs\.db$/i, /^desktop\.ini$/i];

/**
 * Removed files land here, at the top of each synced folder (keeping their paths), so a deletion on
 * another device never loses anything. It is never synced; the owner empties it by hand.
 */
export const DELETED_DIR = 'Deleted';

/** True if any segment of the "/"-separated relative path is ignored, or it is in the top-level Deleted folder. */
export function ignored(rel: string): boolean {
  if (rel === DELETED_DIR || rel.startsWith(`${DELETED_DIR}/`)) return true;
  return rel.split('/').some((seg) => IGNORED.some((r) => r.test(seg)));
}
