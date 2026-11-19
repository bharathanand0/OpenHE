/**
 * Browser wiring for the RongYuan driver: WebHID feature reports and the
 * board registry/layouts bundled from sharkfin's data (code-split, loaded on
 * first connect).
 */

import type { HidDeviceLike } from '../transport';
import { RongyuanDriver, type RyDeps, type RySpec } from './driver';
import type { RyLayoutFile } from './layout';
import { RY_USAGE_PAGE, RY_USAGES } from './protocol';
import { Wire, type FeatureNode } from './wire';

export type FeatureHidDevice = HidDeviceLike & {
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
};

/** Every vendor ID in the registry; RongYuan boards ship under many. */
export const RY_VENDOR_IDS = [
  0x3151, 0x046a, 0x0db0, 0x14a5, 0x2ea8, 0x3299, 0x331a, 0x374a, 0x379a, 0x38a9, 0x38ee, 0x391d,
  0x3984, 0x39a8, 0x39ab, 0x54ab
] as const;

export const RY_HID_FILTERS = RY_VENDOR_IDS.flatMap(vendorId =>
  RY_USAGES.map(usage => ({ vendorId, usagePage: RY_USAGE_PAGE, usage }))
);

export function isRongyuanSettingsDevice(device: HidDeviceLike): boolean {
  if (!(RY_VENDOR_IDS as readonly number[]).includes(device.vendorId)) return false;
  return (device.collections ?? []).some(
    c => c.usagePage === RY_USAGE_PAGE && (c.usage === 1 || c.usage === 2) && hasFeatureReports(c)
  );
}

function hasFeatureReports(c: unknown): boolean {
  const reports = (c as { featureReports?: unknown[] }).featureReports;
  return reports === undefined || reports.length > 0;
}

/** The input-only vendor collection that carries the travel stream (report ID 5). */
function isTravelStreamDevice(device: HidDeviceLike): boolean {
  return (device.collections ?? []).some(c => {
    const inputs = (c as { inputReports?: Array<{ reportId: number }> }).inputReports ?? [];
    return c.usagePage === RY_USAGE_PAGE && inputs.some(r => r.reportId === 5);
  });
}

export function featureNode(device: FeatureHidDevice): FeatureNode {
  return {
    sendFeature: buf => device.sendFeatureReport(0, buf as BufferSource),
    receiveFeature: async () => {
      const dv = await device.receiveFeatureReport(0);
      return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength).slice();
    }
  };
}

let registry: Promise<RySpec[]> | null = null;
const layouts = import.meta.glob<RyLayoutFile>('./data/layouts/*.json', { import: 'default' });

export const bundledDeps: RyDeps = {
  async findSpec(id) {
    registry ??= import('./data/devices.json').then(m => m.default as RySpec[]);
    return (await registry).find(s => s.id === id) ?? null;
  },
  async loadLayout(name) {
    const load = layouts[`./data/layouts/${name}.json`];
    return load ? load() : null;
  }
};

export async function connectRongyuan(
  device: FeatureHidDevice,
  siblings: readonly HidDeviceLike[] = []
): Promise<RongyuanDriver> {
  if (!device.opened) await device.open();
  const wire = new Wire(featureNode(device));
  const streamDevices = siblings.filter(
    d =>
      d !== device &&
      d.vendorId === device.vendorId &&
      d.productId === device.productId &&
      isTravelStreamDevice(d)
  );
  try {
    return await RongyuanDriver.connect(
      wire,
      bundledDeps,
      { vendorId: device.vendorId, productId: device.productId, productName: device.productName },
      { streamDevices, close: () => device.close() }
    );
  } catch (err) {
    await device.close().catch(() => undefined);
    throw err;
  }
}
