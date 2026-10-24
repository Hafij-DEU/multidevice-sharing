import { describe, expect, it } from 'vitest';
import { backupFolderName } from '../src/engine.ts';

describe('backupFolderName', () => {
  it('keeps a plain name and never yields a path or a dot folder', () => {
    expect(backupFolderName('Redmi Pad')).toBe('Redmi Pad');
    expect(backupFolderName('a/b\\c')).toBe('a_b_c');
    expect(backupFolderName('..')).toBe('phone');
    expect(backupFolderName(' . ')).toBe('phone');
    expect(backupFolderName('...')).toBe('phone');
    expect(backupFolderName('../..')).toBe('.._..');
    expect(backupFolderName('')).toBe('phone');
  });
});
