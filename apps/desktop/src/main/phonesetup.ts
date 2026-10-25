// "Set up a phone (USB)": what apps/android/scripts/keep-alive-adb.sh does, from the PC app. A phone
// plugged in with USB debugging on gets every keep-alive setting and the permissions MeshDrop would ask
// for, through adb (the phone's shell user may change them; an app cannot change them for itself).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const PKG = 'io.github.hafijbge.meshdrop';

export interface PhoneSetupResult {
  serial: string;
  model: string;
  /** 'done': all steps ran (some may be skipped on this phone); otherwise why nothing was done. */
  status: 'done' | 'unauthorized' | 'not-installed' | 'offline' | 'failed';
  steps: { label: string; ok: boolean }[];
  /** What the user still does by hand on this phone (Xiaomi's battery saver screen). */
  hint?: string;
}

const STEPS: [string, string[]][] = [
  ['Never paused by Doze', ['dumpsys', 'deviceidle', 'whitelist', `+${PKG}`]],
  ['May run in the background', ['cmd', 'appops', 'set', PKG, 'RUN_ANY_IN_BACKGROUND', 'allow']],
  ['May run in the background (old check)', ['cmd', 'appops', 'set', PKG, 'RUN_IN_BACKGROUND', 'allow']],
  ['App standby: always active', ['am', 'set-standby-bucket', PKG, 'active']],
  ['Xiaomi/HyperOS: autostart', ['cmd', 'appops', 'set', PKG, '10008', 'allow']],
  ['Xiaomi/HyperOS: start in background', ['cmd', 'appops', 'set', PKG, '10021', 'allow']],
  ['Notifications to the PC', ['cmd', 'notification', 'allow_listener', `${PKG}/${PKG}.NotifyListener`]],
  ...['CAMERA', 'RECORD_AUDIO', 'POST_NOTIFICATIONS', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO'].map(
    (p): [string, string[]] => [`Permission: ${p.toLowerCase().replace(/_/g, ' ')}`, ['pm', 'grant', PKG, `android.permission.${p}`]],
  ),
  ['Links from the PC open in the background', ['cmd', 'appops', 'set', PKG, 'SYSTEM_ALERT_WINDOW', 'allow']],
];

/** The phones adb sees: serial, state ('device' | 'unauthorized' | 'offline' …) and model. */
export async function adbDevices(adb = 'adb'): Promise<{ serial: string; state: string; model: string }[]> {
  let out: string;
  try {
    out = (await run(adb, ['devices', '-l'], { timeout: 15_000 })).stdout;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' ? 'adb is not installed on this PC. Install it once with: sudo apt install adb' : 'adb did not answer.');
  }
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial = '', state = ''] = l.split(/\s+/);
      const model = /model:(\S+)/.exec(l)?.[1]?.replace(/_/g, ' ') ?? serial;
      return { serial, state, model };
    });
}

const shell = async (adb: string, serial: string, args: string[]) => {
  const r = await run(adb, ['-s', serial, 'shell', ...args], { timeout: 20_000 });
  // `cmd`/`pm` print errors on stdout and still exit 0 on some phones
  if (/^(Error|Exception|java\.|Security exception|Unknown)/m.test(r.stdout + r.stderr)) throw new Error((r.stdout + r.stderr).trim());
  return r.stdout;
};

/** Sets up every phone plugged in (USB or wireless debugging). */
export async function setupPhones(adb = 'adb'): Promise<PhoneSetupResult[]> {
  const out: PhoneSetupResult[] = [];
  for (const d of await adbDevices(adb)) {
    const r: PhoneSetupResult = { serial: d.serial, model: d.model, status: 'done', steps: [] };
    out.push(r);
    if (d.state === 'unauthorized') {
      r.status = 'unauthorized';
      continue;
    }
    if (d.state !== 'device') {
      r.status = 'offline';
      continue;
    }
    try {
      if (!(await shell(adb, d.serial, ['pm', 'path', PKG])).includes('package:')) {
        r.status = 'not-installed';
        continue;
      }
    } catch {
      r.status = 'failed';
      continue;
    }
    for (const [label, args] of STEPS) {
      try {
        await shell(adb, d.serial, args);
        r.steps.push({ label, ok: true });
      } catch {
        r.steps.push({ label, ok: false }); // not on this phone (e.g. a Xiaomi step elsewhere), or an older MeshDrop
      }
    }
    try {
      if (/xiaomi|redmi|poco/i.test(await shell(adb, d.serial, ['getprop', 'ro.product.manufacturer']))) r.hint = 'On the phone: Settings > Apps > MeshDrop > Battery saver > No restrictions.';
    } catch {
      /* unknown maker */
    }
  }
  return out;
}
