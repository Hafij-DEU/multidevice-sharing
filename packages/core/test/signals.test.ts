import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installStopSignals } from '../src/signals.ts';

describe('installStopSignals', () => {
  it('first SIGINT stops gracefully, a second one exits 130 at once; dispose removes the handlers', () => {
    const proc = new EventEmitter();
    const stops: string[] = [];
    const exits: number[] = [];
    const dispose = installStopSignals((sig) => stops.push(sig), { proc, exit: (c) => exits.push(c) });
    proc.emit('SIGINT', 'SIGINT');
    expect(stops).toEqual(['SIGINT']);
    expect(exits).toEqual([]);
    proc.emit('SIGINT', 'SIGINT');
    expect(exits).toEqual([130]);
    expect(stops).toEqual(['SIGINT']);
    dispose();
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });

  it('SIGTERM then SIGTERM exits 143', () => {
    const proc = new EventEmitter();
    const exits: number[] = [];
    installStopSignals(() => {}, { proc, exit: (c) => exits.push(c) });
    proc.emit('SIGTERM', 'SIGTERM');
    proc.emit('SIGTERM', 'SIGTERM');
    expect(exits).toEqual([143]);
  });
});
