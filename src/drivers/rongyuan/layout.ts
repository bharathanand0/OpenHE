/**
 * Board pictures for RongYuan boards and the key -> matrix slot mapping.
 *
 * The layouts come from sharkfin's vendor layout set (pixel geometry plus,
 * per key, either a known slot or the factory keymap entry). Where a file
 * names no slots, they are matched against the keymap read from the board,
 * the way sharkfin's layout-infer.ts does; the match is only trustworthy on
 * a board that still has its factory keymap, so an inferred mapping must be
 * confirmed before writes.
 */

import type { BoardLayout, LayoutKey } from '../types';
import type { Entry } from './keycodes';

export type RyLayoutKey = {
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  matrixIndex?: number;
  matrixEntry?: number[];
};

export type RyLayoutFile = { canvas: { width: number; height: number }; keys: RyLayoutKey[] };

export type ResolvedLayout = {
  layout: BoardLayout;
  /** Matrix slot of each layout key, by `LayoutKey.index`. */
  slots: number[];
  /** Share of keys with a factory entry that matched a slot (1 for registry/grid). */
  matchRate: number;
};

/** Below this, a stored picture is not trusted and a slot grid is shown instead. */
export const MIN_MATCH_RATE = 0.7;

function unitOf(keys: RyLayoutKey[]): number {
  const counts = new Map<number, number>();
  for (const k of keys) counts.set(k.w, (counts.get(k.w) ?? 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 40;
  // a 1U key plus the gap to its neighbour
  const gaps = keys
    .map(k => keys.filter(o => o !== k && Math.abs(o.y - k.y) < 2 && o.x > k.x).map(o => o.x - k.x))
    .flatMap(d => (d.length ? [Math.min(...d)] : []))
    .filter(d => d >= common && d < common * 1.4);
  if (!gaps.length) return common;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

function toKeys(
  file: RyLayoutFile,
  picked: Array<{ key: RyLayoutKey; slot: number }>
): LayoutKey[] {
  // pitch: distance between neighbouring 1U keys; gap: pitch minus a 1U cap
  const pitch = unitOf(file.keys);
  const oneU = Math.min(...file.keys.map(k => k.w));
  const gap = Math.max(0, pitch - oneU);
  const minX = Math.min(...picked.map(p => p.key.x));
  const minY = Math.min(...picked.map(p => p.key.y));
  const r = (v: number) => Math.round(v * 100) / 100;
  return picked.map((p, index) => ({
    index,
    x: r((p.key.x - minX) / pitch),
    y: r((p.key.y - minY) / pitch),
    w: r((p.key.w + gap) / pitch),
    h: r((p.key.h + gap) / pitch),
    label: p.key.text ?? ''
  }));
}

function finish(
  keys: LayoutKey[],
  slots: number[],
  source: BoardLayout['source'],
  matchRate: number
): ResolvedLayout {
  const width = keys.reduce((m, k) => Math.max(m, k.x + k.w), 0);
  const height = keys.reduce((m, k) => Math.max(m, k.y + k.h), 0);
  return { layout: { keys, width, height, source }, slots, matchRate };
}

/** Every key with a slot from the file itself, or null when the file names none. */
export function layoutFromRegistry(file: RyLayoutFile): ResolvedLayout | null {
  if (!file.keys.length || file.keys.some(k => k.matrixIndex === undefined)) return null;
  const picked = file.keys.map(key => ({ key, slot: key.matrixIndex as number }));
  return finish(
    toKeys(file, picked),
    picked.map(p => p.slot),
    'registry',
    1
  );
}

/** Match each key's factory entry against the live keymap (sharkfin inferSlots). */
export function inferLayout(file: RyLayoutFile, matrix: Uint8Array): ResolvedLayout {
  const bySlot = new Map<string, number[]>();
  for (let s = 0; s * 4 + 3 < matrix.length; s++) {
    const et = Array.from(matrix.subarray(s * 4, s * 4 + 4)).join(',');
    if (et === '0,0,0,0') continue;
    const list = bySlot.get(et);
    if (list) list.push(s);
    else bySlot.set(et, [s]);
  }
  const counts = new Map<string, number>();
  let total = 0;
  const picked: Array<{ key: RyLayoutKey; slot: number }> = [];
  for (const key of file.keys) {
    if (!key.matrixEntry) continue;
    total++;
    const et = key.matrixEntry.join(',');
    const nth = counts.get(et) ?? 0;
    counts.set(et, nth + 1);
    const hits = bySlot.get(et);
    if (hits && nth < hits.length) picked.push({ key, slot: hits[nth] });
  }
  const matchRate = total ? picked.length / total : 0;
  if (!picked.length) return gridLayout(matrix);
  return finish(
    toKeys(file, picked),
    picked.map(p => p.slot),
    'inferred',
    matchRate
  );
}

/** A 16-wide grid of every slot holding something: still fully editable. */
export function gridLayout(matrix: Uint8Array, slotCount = 128): ResolvedLayout {
  const slots: number[] = [];
  for (let s = 0; s < slotCount && s * 4 + 3 < matrix.length; s++) {
    if (matrix[s * 4] | matrix[s * 4 + 1] | matrix[s * 4 + 2] | matrix[s * 4 + 3]) slots.push(s);
  }
  const keys: LayoutKey[] = slots.map((slot, index) => ({
    index,
    x: index % 16,
    y: Math.floor(index / 16),
    w: 1,
    h: 1,
    label: String(slot)
  }));
  return finish(keys, slots, 'grid', 1);
}

export const entryAt = (matrix: Uint8Array, slot: number): Entry =>
  [matrix[slot * 4], matrix[slot * 4 + 1], matrix[slot * 4 + 2], matrix[slot * 4 + 3]] as const;
