// The "Share with other apps" add-on for MeshDrop: other apps' share protocols as add-on transports.
import type { AddonTransport } from '@meshdrop/core/src/addons.ts';
import { QuickShareTransport } from './quickshare/transport.ts';

/** The add-on contract version this add-on was built for (core's ADDON_API_VERSION). */
export const apiVersion = 1;

export function transports(): AddonTransport[] {
  return [new QuickShareTransport()];
}

export default { apiVersion, transports };
