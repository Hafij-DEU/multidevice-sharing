// Folder sync: names that are never synced (our own work areas, editors' lock and temp files, OS clutter).
const IGNORED: RegExp[] = [/^\.meshdrop-/, /\.part$/, /^~\$/, /^\.~lock\./, /^\.DS_Store$/, /^Thumbs\.db$/i, /^desktop\.ini$/i];

/** True if any segment of the "/"-separated relative path is ignored. */
export function ignored(rel: string): boolean {
  return rel.split('/').some((seg) => IGNORED.some((r) => r.test(seg)));
}
