// Fan-out: one independent sendTo-style session per target, run concurrently.
//
// Items are walked and hashed once; each target then gets its own manifest, sessionId, HPKE
// context and outbox entry, so one target dying (or being slow) has no effect on the others and
// can be resumed later on its own. Never rejects; results are in target order. A target listed
// twice (same deviceId) is sent to once and both positions get that result.
import type { Identity } from '../identity.ts';
import {
  errorString,
  prepareItems,
  sendPrepared,
  type PreparedItems,
  type SendItem,
  type SendOptions,
  type SendProgress,
  type SendResult,
  type Target,
} from './send.ts';

export interface MultiSendOptions extends Omit<SendOptions, 'onProgress'> {
  onProgress?: (p: SendProgress & { deviceId: string }) => void;
}

export async function multiSend(id: Identity, targets: Target[], items: SendItem[], opts: MultiSendOptions = {}): Promise<SendResult[]> {
  let prepared: PreparedItems;
  try {
    prepared = await prepareItems(items, opts.signal);
  } catch (e) {
    if (opts.signal?.aborted) return targets.map((t) => ({ deviceId: t.deviceId, status: 'cancelled', sessionId: '' }));
    const error = errorString(e);
    return targets.map((t) => ({ deviceId: t.deviceId, status: 'failed', sessionId: '', error }));
  }
  const { onProgress, ...rest } = opts;
  const byDevice = new Map<string, Promise<SendResult>>();
  return Promise.all(
    targets.map((t) => {
      let p = byDevice.get(t.deviceId);
      if (!p) {
        const perTarget: SendOptions = { ...rest };
        if (onProgress) perTarget.onProgress = (x) => onProgress({ deviceId: t.deviceId, ...x });
        p = sendPrepared(id, t, prepared, perTarget).catch(
          (e: unknown): SendResult => ({ deviceId: t.deviceId, status: 'failed', sessionId: '', error: errorString(e) }),
        );
        byDevice.set(t.deviceId, p);
      }
      return p;
    }),
  );
}
