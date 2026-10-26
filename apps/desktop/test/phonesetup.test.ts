import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adbDevices, setupPhones } from '../src/main/phonesetup.ts';

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake adb: three phones (ready, not allowed yet, no MeshDrop); logs every call. */
function fakeAdb(): { adb: string; log: string } {
  const d = mkdtempSync(join(tmpdir(), 'md-adb-'));
  tmps.push(d);
  const log = join(d, 'log');
  const adb = join(d, 'adb');
  writeFileSync(adb, `#!/bin/sh
echo "$@" >> ${log}
if [ "$1" = devices ]; then
  printf 'List of devices attached\\nAAA device usb:1 product:x model:Redmi_Pad device:x\\nBBB unauthorized usb:2\\nCCC device usb:3 model:Pixel_8\\n'
  exit 0
fi
serial=$2
shift 3
case "$serial $*" in
  "CCC pm path"*) exit 0 ;;
  *"pm path"*) echo "package:/data/app/base.apk" ;;
  *"getprop ro.product.manufacturer") [ "$serial" = AAA ] && echo Xiaomi || echo Google ;;
  *"RECORD_AUDIO") echo "Exception occurred while executing 'grant'" ;;
esac
`);
  chmodSync(adb, 0o755);
  return { adb, log };
}

describe('Set up a phone (USB)', () => {
  it('sets up ready phones and says what to do for the others', async () => {
    const { adb, log } = fakeAdb();
    expect((await adbDevices(adb)).map((d) => d.state)).toEqual(['device', 'unauthorized', 'device']);
    const r = await setupPhones(adb);
    expect(r.map((p) => [p.model, p.status])).toEqual([['Redmi Pad', 'done'], ['BBB', 'unauthorized'], ['Pixel 8', 'not-installed']]);
    const a = r[0]!;
    expect(a.steps.find((s) => s.label.includes('record audio'))?.ok).toBe(false);
    expect(a.steps.filter((s) => s.ok).length).toBe(a.steps.length - 1);
    expect(a.hint).toMatch(/Battery saver/);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('-s AAA shell dumpsys deviceidle whitelist +io.github.hafijbge.meshdrop');
    expect(calls).not.toContain('-s BBB shell');
  });

  it('says how to install adb when it is missing', async () => {
    await expect(setupPhones('/nonexistent/adb')).rejects.toThrow(process.platform === 'win32' ? /winget install Google\.PlatformTools/ : /sudo apt install adb/);
  });
});
