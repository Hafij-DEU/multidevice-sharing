// Filesystem trust boundary helpers: manifests come from remote devices, so every path in them is
// attacker-influenced. safeRelPath turns an untrusted relative path into a clean '/'-joined path that
// cannot escape the directory it is joined onto; uniqueName picks a non-colliding file name.
import * as nodeFs from 'node:fs/promises';

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

export const MAX_PATH_SEGMENTS = 32;
/** Max UTF-8 bytes per segment: 255 (NAME_MAX) minus room for the " (nnn)" suffix uniqueName adds. */
export const MAX_SEGMENT_BYTES = 240;
/** Keep a trailing ".ext" when truncating only if it is at most this many bytes. */
const MAX_EXT_BYTES = 16;
/** Max UTF-8 bytes for the whole relative path (PATH_MAX is 4096 on Linux, leaving room for the root). */
export const MAX_PATH_BYTES = 3072;
const LONE_SURROGATE = /\p{Surrogate}/gu;
const byteLen = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Longest prefix of `s` that is <= max UTF-8 bytes, cut on a code-point boundary. */
function cutBytes(s: string, max: number): string {
  let bytes = 0;
  let out = '';
  for (const ch of s) {
    const n = byteLen(ch);
    if (bytes + n > max) break;
    bytes += n;
    out += ch;
  }
  return out;
}

function limitSegment(seg: string): string {
  if (byteLen(seg) <= MAX_SEGMENT_BYTES) return seg;
  const dot = seg.lastIndexOf('.');
  const ext = dot > 0 ? seg.slice(dot) : '';
  if (ext !== '' && byteLen(ext) <= MAX_EXT_BYTES) {
    return cutBytes(seg.slice(0, dot), MAX_SEGMENT_BYTES - byteLen(ext)) + ext;
  }
  return cutBytes(seg, MAX_SEGMENT_BYTES);
}
const DRIVE_LETTER = /^[A-Za-z]:(?:[/\\]|$)/; // "C:\x", "C:/x", "C:"; not "a:b.txt"
const BAD_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/g;
const RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeRelPath(p: string): string {
  if (typeof p !== 'string') throw new UnsafePathError('path must be a string');
  if (p.includes('\u0000')) throw new UnsafePathError('path contains NUL');
  if (p.startsWith('/') || p.startsWith('\\')) throw new UnsafePathError('absolute path');
  if (DRIVE_LETTER.test(p)) throw new UnsafePathError('drive-letter path');
  const segs: string[] = [];
  for (const raw of p.split(/[/\\]/)) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') throw new UnsafePathError('path traversal');
    let seg = raw.replace(BAD_CHARS, '_').replace(LONE_SURROGATE, '_');
    const dot = seg.indexOf('.');
    const stem = dot === -1 ? seg : seg.slice(0, dot);
    if (RESERVED_STEM.test(stem)) seg = '_' + seg;
    segs.push(limitSegment(seg));
  }
  if (segs.length > MAX_PATH_SEGMENTS) throw new UnsafePathError('path too deep');
  const rel = segs.join('/');
  if (byteLen(rel) > MAX_PATH_BYTES) throw new UnsafePathError('path too long');
  return rel;
}

function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' }; // ".bashrc" has no extension
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** `name`, or `stem (n).ext` for the smallest n >= 1 such that nothing exists at that name in `dir`. */
export async function uniqueName(dir: string, name: string, fs: typeof nodeFs = nodeFs): Promise<string> {
  const { stem, ext } = splitExt(name);
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    try {
      await fs.lstat(`${dir}/${candidate}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw e;
    }
  }
}
