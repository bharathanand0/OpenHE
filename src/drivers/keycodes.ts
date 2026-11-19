/**
 * UI keycode space shared by every driver.
 *
 * This is the numeric space the existing remap UI already uses (inherited from
 * the AULA ByteTech catalog), so the remap pages work unchanged:
 *
 *   0x000000UU            HID keyboard usage UU (0 = no key)
 *   0x00MM0000            a lone modifier, one bit (L Ctrl 0x01 .. R GUI 0x80)
 *   0x00MMUU00            modifiers MM (bit0 Ctrl, bit1 Shift, bit2 Alt, bit3 GUI) + usage UU
 *   0x02000UUU            consumer-control usage
 *   0x01BB0100            mouse button BB (1 left, 2 right, 3 middle, 4 back, 5 forward)
 *   0x0D0L0000            momentary layer L+1 (0x0D000000 = Fn = layer 1)
 *
 * Extension for codes a board has but the catalog does not:
 *
 *   0x7FNNNNNN            driver-native code NNNNNN, labelled by the driver
 */

export type UiKeycode = number;

export const UI_NONE: UiKeycode = 0;

/**
 * HID keyboard usage. Modifiers (0xE0..0xE7) take the catalog's form, one
 * bit in 0x00MM0000 (L Ctrl 0x010000 .. R GUI 0x800000).
 */
export const uiHid = (usage: number): UiKeycode =>
  usage >= 0xe0 && usage <= 0xe7 ? (1 << (usage - 0xe0)) << 16 : usage & 0xff;
export const uiConsumer = (usage: number): UiKeycode => 0x02000000 | (usage & 0xfff);
export const uiMouseButton = (button: number): UiKeycode => 0x01000100 | ((button & 0xff) << 16);
/** Momentary layer `layer` (>= 1). */
export const uiMomentaryLayer = (layer: number): UiKeycode =>
  0x0d000000 | (((layer - 1) & 0xff) << 16);
export const uiNative = (code: number): UiKeycode => 0x7f000000 | (code & 0xffffff);

export type DecodedUiKeycode =
  | { type: 'none' }
  | { type: 'hid'; usage: number }
  | { type: 'combo'; modifiers: number; usage: number }
  | { type: 'consumer'; usage: number }
  | { type: 'mouse'; button: number }
  | { type: 'layer'; layer: number }
  | { type: 'native'; code: number }
  | { type: 'unknown'; value: number };

export function decodeUiKeycode(value: UiKeycode): DecodedUiKeycode {
  if (value === 0) return { type: 'none' };
  const top = (value >>> 24) & 0xff;
  if (top === 0x7f) return { type: 'native', code: value & 0xffffff };
  if (top === 0x0d && (value & 0xffff) === 0)
    return { type: 'layer', layer: ((value >>> 16) & 0xff) + 1 };
  if (top === 0x02) return { type: 'consumer', usage: value & 0xfff };
  if (top === 0x01 && (value & 0xffff) === 0x0100)
    return { type: 'mouse', button: (value >>> 16) & 0xff };
  if (top === 0) {
    if (value <= 0xff) return { type: 'hid', usage: value };
    const mods = (value >>> 16) & 0xff;
    if ((value & 0xffff) === 0 && mods && (mods & (mods - 1)) === 0) {
      return { type: 'hid', usage: 0xe0 + Math.log2(mods) };
    }
    if ((value & 0xff) === 0 && value <= 0xffff00) {
      return { type: 'combo', modifiers: (value >>> 16) & 0xff, usage: (value >>> 8) & 0xff };
    }
  }
  return { type: 'unknown', value };
}
