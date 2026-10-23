// Test helper (not a test file): loopback multicast is unavailable in some sandboxes/CI kernels.
// Probe it once with a self-send and skip (with a reason) the tests that need it instead of failing.
import { createSocket } from 'node:dgram';
import { it } from 'vitest';

export const MCAST_GROUP = '224.0.0.168';
const LO = '127.0.0.1';

/** True if a datagram sent to `group:port` on loopback comes back within 500 ms. */
export async function probeLoopbackMulticast(port: number, group = MCAST_GROUP): Promise<boolean> {
  const rx = createSocket({ type: 'udp4', reuseAddr: true });
  const tx = createSocket({ type: 'udp4', reuseAddr: true });
  try {
    await new Promise<void>((r, j) => {
      rx.once('error', j);
      rx.bind(port, () => r());
    });
    rx.addMembership(group, LO);
    await new Promise<void>((r) => tx.bind(0, LO, () => r()));
    tx.setMulticastInterface(LO);
    tx.setMulticastLoopback(true);
    return await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 500);
      rx.once('message', () => {
        clearTimeout(t);
        resolve(true);
      });
      tx.send('ping', port, group, () => {});
    });
  } catch {
    return false;
  } finally {
    rx.close();
    tx.close();
  }
}

/**
 * `it` for a test that needs loopback multicast: skipped under CI, and skipped with a reason when
 * `ok()` (normally the result of probeLoopbackMulticast in a beforeAll) is false.
 */
export function multicastIt(ok: () => boolean) {
  return (name: string, fn: () => Promise<void>, timeout?: number) =>
    it.skipIf(!!process.env.CI)(
      name,
      async (ctx) => {
        if (!ok()) ctx.skip('loopback multicast does not deliver in this environment');
        await fn();
      },
      timeout,
    );
}
