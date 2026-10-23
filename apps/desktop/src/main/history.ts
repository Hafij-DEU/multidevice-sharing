// What this device received, newest first, capped (<home>/desktop-history.json, 0600).
import { readFileSync } from 'node:fs';
import { writeFileAtomic } from '@meshdrop/core/src/trust.ts';
import type { ReceivedRecord } from '../shared/api.ts';

const isRecord = (x: unknown): x is ReceivedRecord => {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.at === 'number' && typeof r.from === 'string' && typeof r.alias === 'string' && Array.isArray(r.files) && r.files.every((f) => typeof f === 'string');
};

export class HistoryStore {
  readonly #file: string;
  readonly #cap: number;
  #records: ReceivedRecord[] = [];

  constructor(file: string, cap = 500) {
    this.#file = file;
    this.#cap = cap;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (Array.isArray(j)) this.#records = j.filter(isRecord).slice(0, cap);
    } catch {
      /* missing or damaged: empty */
    }
  }

  addReceived(r: ReceivedRecord): void {
    this.#records = [r, ...this.#records].slice(0, this.#cap);
    writeFileAtomic(this.#file, JSON.stringify(this.#records));
  }

  received(): ReceivedRecord[] {
    return this.#records.map((r) => ({ ...r, files: [...r.files] }));
  }
}
