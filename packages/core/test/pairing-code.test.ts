import { describe, expect, it } from 'vitest';
import { pairingCode } from '../src/trust.ts';

describe('pairingCode', () => {
  it('is the same on both sides and formatted as two groups of three digits', () => {
    const a = 'a'.repeat(52), b = 'b'.repeat(52);
    expect(pairingCode(a, b)).toBe(pairingCode(b, a));
    expect(pairingCode(a, b)).toMatch(/^\d{3} \d{3}$/);
  });
  it('changes when either device changes', () => {
    const a = 'a'.repeat(52), b = 'b'.repeat(52), c = 'c'.repeat(52);
    expect(pairingCode(a, b)).not.toBe(pairingCode(a, c));
  });
});
