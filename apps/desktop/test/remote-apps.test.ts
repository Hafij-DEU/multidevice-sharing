import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {} }));
const { listApps } = await import('../src/main/remote.ts');

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('listApps', () => {
  it('lists shown applications by id, first directory wins', () => {
    const a = mkdtempSync(join(tmpdir(), 'md-apps-'));
    const b = mkdtempSync(join(tmpdir(), 'md-apps-'));
    tmps.push(a, b);
    writeFileSync(join(a, 'org.gnome.Nautilus.desktop'), '[Desktop Entry]\nType=Application\nName=Files\n');
    writeFileSync(join(a, 'hidden.desktop'), '[Desktop Entry]\nType=Application\nName=Hidden\nNoDisplay=true\n');
    writeFileSync(join(a, 'link.desktop'), '[Desktop Entry]\nType=Link\nName=Web\n');
    writeFileSync(join(b, 'org.gnome.Nautilus.desktop'), '[Desktop Entry]\nType=Application\nName=Other\n');
    writeFileSync(join(b, 'firefox.desktop'), '[Desktop Entry]\nType=Application\nName=Firefox\n[Desktop Action new]\nName=New Window\n');
    expect(listApps([a, b])).toEqual([{ id: 'org.gnome.Nautilus', name: 'Files' }, { id: 'firefox', name: 'Firefox' }]);
  });
});
