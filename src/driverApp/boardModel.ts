/**
 * The connected driver board as an OpenAula board model, so OpenAula's own
 * components (keyboard preview, advanced-key icons, Hall overlays) draw it.
 *
 * Driver layouts are absolute (x, y, w, h in key units); OpenAula's preview
 * draws rows of keys, so keys are grouped into rows and the gaps between them
 * become spacer slots. Keys taller than one row are drawn one row tall.
 */

import type { HeroDeviceModelId } from '../keyboard/devices';
import {
  computeKeyCoordinates,
  getBoard,
  registerBoard,
  unregisterBoard,
  type BoardDescriptor,
  type HeroKeyRow
} from '../keyboard/registry';
import type { BoardLayout, KeyboardDriver } from '../drivers/types';

export const DRIVER_MODEL_ID = 'openhe-board' as HeroDeviceModelId;

/** Frontend key id of the driver layout's key `index`. */
export const keyIdOf = (index: number) => `k${index}`;
export const indexOfKeyId = (keyId: string) => Number(keyId.slice(1));

const round = (v: number) => Math.round(v * 100) / 100;

export function rowsFromLayout(layout: BoardLayout): { rows: HeroKeyRow[]; widthUnits: number } {
  const byRow = new Map<number, BoardLayout['keys']>();
  for (const k of layout.keys) {
    const r = Math.round(k.y);
    const list = byRow.get(r) ?? [];
    list.push(k);
    byRow.set(r, list);
  }
  const rowIndexes = [...byRow.keys()].sort((a, b) => a - b);
  let spacer = 0;
  const rows: HeroKeyRow[] = rowIndexes.map(r => {
    const keys = (byRow.get(r) ?? []).slice().sort((a, b) => a.x - b.x);
    const row: HeroKeyRow = [];
    let cursor = 0;
    for (const k of keys) {
      const gap = round(k.x - cursor);
      if (gap >= 0.05) {
        row.push({ id: `gap${spacer++}`, label: '', width: gap, spacer: true });
        cursor += gap;
      }
      const width = round(Math.max(0.5, k.w));
      row.push({ id: keyIdOf(k.index), label: k.label, width, matrixKey: k.index });
      cursor = round(cursor + width);
    }
    return row;
  });
  const widthUnits = round(
    Math.max(1, ...rows.map(row => row.reduce((sum, k) => sum + (k.width ?? 1), 0)))
  );
  for (const row of rows) {
    const used = round(row.reduce((sum, k) => sum + (k.width ?? 1), 0));
    if (widthUnits - used > 1e-6) {
      row.push({ id: `gap${spacer++}`, label: '', width: round(widthUnits - used), spacer: true });
    }
  }
  return { rows, widthUnits };
}

export function boardDescriptorFor(driver: KeyboardDriver): BoardDescriptor {
  const { rows, widthUnits } = rowsFromLayout(driver.layout);
  const keyIds = rows
    .flat()
    .filter(k => !k.spacer)
    .map(k => k.id);
  const keyIdToPos = Object.fromEntries(keyIds.map(id => [id, indexOfKeyId(id)]));
  const posToKeyId = new Map(keyIds.map(id => [indexOfKeyId(id), id]));
  const caps = driver.capabilities;
  return {
    id: DRIVER_MODEL_ID,
    name: driver.info.name,
    label: driver.info.name,
    layoutTag: '65%',
    sideTab: false,
    thumbnail: '',
    usb: {
      vendorId: driver.info.vendorId,
      productIds: [driver.info.productId],
      usagePage: 0,
      usage: 0,
      reportId: 0,
      productNames: [],
      deviceUuids: [],
      modelByte: -1
    },
    capabilities: {
      keyCount: keyIds.length,
      rowCount: rows.length,
      widthUnits,
      maxTravelMm: caps.travelMm,
      writablePollingRate: false,
      hasSideRgb: false,
      sideLedCount: 0,
      maxGamepadBindings: keyIds.length,
      maxAdvancedBindings: caps.maxAdvancedKeys
    },
    rows,
    keyIds,
    keyIdSet: new Set(keyIds),
    keyCoordinates: computeKeyCoordinates(rows),
    keyIdToPos,
    posToKeyId,
    validPositions: new Set(posToKeyId.keys()),
    factoryRemapLayers: { 0: {}, 1: {}, 2: {} },
    makeDemoLighting: () => Object.fromEntries(keyIds.map(id => [id, '#3a4045']))
  };
}

/** Register the board (replacing a previous one) and return its model id. */
export function registerDriverBoard(driver: KeyboardDriver): HeroDeviceModelId {
  try {
    getBoard(DRIVER_MODEL_ID);
    unregisterBoard(DRIVER_MODEL_ID);
  } catch {
    // not registered yet
  }
  registerBoard(boardDescriptorFor(driver));
  return DRIVER_MODEL_ID;
}
