/**
 * RongYuan keymap entries <-> UI keycodes.
 *
 * An entry is four bytes `[tag, a, b, c]` (sharkfin hid-usages.ts):
 *   [0, x, usage, y]   HID usage, x/y optional extra usages (combos)
 *   [1, 0, 240+n, 0]   mouse button n (0 left .. 4 forward)
 *   [3, 0, lo, hi]     consumer usage
 *   [10, 1, 0, 0]      Fn
 *   [0, 0, 0, 0]       disabled on the base layer, pass-through on Fn
 * Anything else (macros, lighting, mouse movement ...) is kept verbatim as a
 * driver-native code so it survives a read-modify-write.
 */

import {
  decodeUiKeycode,
  uiConsumer,
  uiHid,
  uiMomentaryLayer,
  uiMouseButton,
  uiNative,
  type UiKeycode
} from '../keycodes';

export type Entry = readonly [number, number, number, number];

const MOD_BITS: ReadonlyArray<readonly [number, number]> = [
  [0xe0, 0x01], // L Ctrl
  [0xe1, 0x02], // L Shift
  [0xe2, 0x04], // L Alt
  [0xe3, 0x08] // L GUI
];
const modBit = (usage: number) => MOD_BITS.find(([u]) => u === usage)?.[1];

/** Keeps entries the UI space cannot express, per connection. */
export class NativeEntries {
  private readonly byKey = new Map<string, number>();
  private readonly byId: Entry[] = [];

  id(entry: Entry): number {
    const key = entry.join(',');
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = this.byId.length;
      this.byId.push([...entry] as unknown as Entry);
      this.byKey.set(key, id);
    }
    return id;
  }

  entry(id: number): Entry | undefined {
    return this.byId[id];
  }
}

export function entryToUi(e: Entry, natives: NativeEntries): UiKeycode {
  const [tag, a, b, c] = e;
  if (tag === 0 && a === 0 && b === 0 && c === 0) return 0;
  if (tag === 0 && b !== 0) {
    if (a === 0 && c === 0) return uiHid(b);
    const ma = a === 0 ? 0 : modBit(a);
    const mc = c === 0 ? 0 : modBit(c);
    if (ma !== undefined && mc !== undefined && b < 0xe0) return ((ma | mc) << 16) | (b << 8);
  }
  if (tag === 1 && a === 0 && c === 0 && b >= 240 && b <= 244) return uiMouseButton(b - 239);
  if (tag === 3 && a === 0) return uiConsumer(b | (c << 8));
  if (tag === 10 && a === 1 && b === 0 && c === 0) return uiMomentaryLayer(1);
  return uiNative(natives.id(e));
}

/** null when the board cannot express the keycode. */
export function uiToEntry(value: UiKeycode, natives: NativeEntries): Entry | null {
  const d = decodeUiKeycode(value);
  switch (d.type) {
    case 'none':
      return [0, 0, 0, 0];
    case 'hid':
      return [0, 0, d.usage, 0];
    case 'combo': {
      const mods = MOD_BITS.filter(([, bit]) => d.modifiers & bit).map(([u]) => u);
      if (mods.length > 2 || d.modifiers & ~0x0f) return null;
      return [0, mods[0] ?? 0, d.usage, mods[1] ?? 0];
    }
    case 'consumer':
      return [3, 0, d.usage & 0xff, (d.usage >> 8) & 0xff];
    case 'mouse':
      return d.button >= 1 && d.button <= 5 ? [1, 0, 239 + d.button, 0] : null;
    case 'layer':
      return d.layer === 1 ? [10, 1, 0, 0] : null;
    case 'native':
      return natives.entry(d.code) ?? null;
    default:
      return null;
  }
}

export function nativeEntryLabel(e: Entry): string {
  const [tag, a, b, c] = e;
  if (tag === 1) return 'Mouse';
  if (tag === 4) return 'Scroll';
  if (tag === 9) return `Macro ${b + 1}`;
  if (tag === 10 && a === 12) return 'Power save';
  if (tag === 10) return 'Special';
  if (tag === 13) return 'Light';
  if (tag === 14) return 'Link';
  return `${tag}:${a}:${b}:${c}`;
}
