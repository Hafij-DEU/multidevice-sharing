// Writes the LAN guest page (src/guest/page.ts) into the Java engine's resources, so the Android guest
// server serves the very same page. guest-page.test.ts fails when the two drift apart.
//   npx tsx packages/core/scripts/guest-page-java.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUEST_PAGE } from '../src/guest/page.ts';

export const JAVA_GUEST_DIR = fileURLToPath(new URL('../../../apps/android/engine/src/main/resources/io/github/hafijbge/meshdrop/engine/guest/', import.meta.url));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(JAVA_GUEST_DIR, { recursive: true });
  writeFileSync(join(JAVA_GUEST_DIR, 'page.html'), GUEST_PAGE.html);
  writeFileSync(join(JAVA_GUEST_DIR, 'app.js'), GUEST_PAGE.js);
  writeFileSync(join(JAVA_GUEST_DIR, 'app.css'), GUEST_PAGE.css);
}
