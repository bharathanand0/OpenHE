/**
 * libhmk keycodes (include/keycodes.h, firmware 0x0108) <-> UI keycodes.
 *
 * libhmk packs HID usages into one byte by dropping gaps, so the mapping is
 * piecewise. Codes the UI space cannot express (transparent, MO(0), profile
 * keys, key lock, bootloader ...) round-trip as driver-native codes.
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
import { HMK_KEYCODE_NAMES } from './keycodeNames';

export const HMK_KC_NO = 0x00;
export const HMK_KC_TRANSPARENT = 0x01;
const HMK_SP_MOUSE_MIN = 0x9b; // SP_MOUSE_BUTTON_1
const HMK_SP_MOUSE_MAX = 0x9f; // SP_MOUSE_BUTTON_5
export const HMK_SP_MO_MIN = 0xc0;
export const HMK_SP_MO_MAX = 0xc7;
export const HMK_SP_PF_MIN = 0xc8;
export const HMK_SP_PF_MAX = 0xcf;

/** [libhmk first, libhmk last, HID first] */
const HID_RANGES: ReadonlyArray<readonly [number, number, number]> = [
  [0x02, 0x63, 0x04], // A .. Application (incl. keypad, non-US backslash)
  [0x64, 0x6f, 0x68], // F13 .. F24
  [0x70, 0x75, 0x87], // International 1..6
  [0x76, 0x7a, 0x90], // Language 1..5
  [0x7b, 0x82, 0xe0] // LCtrl .. RGUI
];

/** libhmk code -> consumer usage */
const CONSUMER: ReadonlyMap<number, number> = new Map([
  [0x86, 0x0e2], // mute
  [0x87, 0x0e9], // volume up
  [0x88, 0x0ea], // volume down
  [0x89, 0x0b5], // next track
  [0x8a, 0x0b6], // previous track
  [0x8b, 0x0b7], // stop
  [0x8c, 0x0cd], // play/pause
  [0x8d, 0x183], // media select
  [0x8e, 0x18a], // mail
  [0x8f, 0x192], // calculator
  [0x90, 0x194], // my computer
  [0x91, 0x221], // WWW search
  [0x92, 0x223], // WWW home
  [0x93, 0x224], // WWW back
  [0x94, 0x225], // WWW forward
  [0x95, 0x227], // WWW refresh
  [0x96, 0x22a], // WWW favourites
  [0x97, 0x06f], // brightness up
  [0x98, 0x070], // brightness down
  [0x99, 0x29f], // mission control
  [0x9a, 0x2a0] // launchpad
]);
const CONSUMER_REVERSE: ReadonlyMap<number, number> = new Map(
  [...CONSUMER].map(([hmk, usage]) => [usage, hmk])
);

export function hmkToUi(code: number): UiKeycode {
  if (code === HMK_KC_NO) return 0;
  for (const [first, last, hid] of HID_RANGES) {
    if (code >= first && code <= last) return uiHid(hid + (code - first));
  }
  const consumer = CONSUMER.get(code);
  if (consumer !== undefined) return uiConsumer(consumer);
  if (code >= HMK_SP_MOUSE_MIN && code <= HMK_SP_MOUSE_MAX)
    return uiMouseButton(code - HMK_SP_MOUSE_MIN + 1);
  if (code > HMK_SP_MO_MIN && code <= HMK_SP_MO_MAX) return uiMomentaryLayer(code - HMK_SP_MO_MIN);
  return uiNative(code);
}

/** Returns null when the board cannot express the UI keycode. */
export function uiToHmk(value: UiKeycode): number | null {
  const d = decodeUiKeycode(value);
  switch (d.type) {
    case 'none':
      return HMK_KC_NO;
    case 'hid':
      for (const [first, last, hid] of HID_RANGES) {
        if (d.usage >= hid && d.usage <= hid + (last - first)) return first + (d.usage - hid);
      }
      return null;
    case 'consumer':
      return CONSUMER_REVERSE.get(d.usage) ?? null;
    case 'mouse':
      return d.button >= 1 && d.button <= 5 ? HMK_SP_MOUSE_MIN + d.button - 1 : null;
    case 'layer':
      return d.layer >= 1 && HMK_SP_MO_MIN + d.layer <= HMK_SP_MO_MAX
        ? HMK_SP_MO_MIN + d.layer
        : null;
    case 'native':
      return d.code <= 0xff ? d.code : null;
    default:
      return null;
  }
}

/** Labels for libhmk codes that only exist as driver-native UI codes. */
export function hmkNativeLabel(code: number): string {
  if (code === HMK_KC_TRANSPARENT) return '▽';
  if (code === 0x83) return 'Power';
  if (code === 0x84) return 'Sleep';
  if (code === 0x85) return 'Wake';
  if (code >= HMK_SP_MO_MIN && code <= HMK_SP_MO_MAX) return `MO(${code - HMK_SP_MO_MIN})`;
  if (code >= HMK_SP_PF_MIN && code <= HMK_SP_PF_MAX) return `Profile ${code - HMK_SP_PF_MIN}`;
  switch (code) {
    case 0xd0:
      return 'Key Lock';
    case 0xd1:
      return 'Layer Lock';
    case 0xd2:
      return 'Profile Swap';
    case 0xd3:
      return 'Next Profile';
    case 0xd4:
      return 'Bootloader';
    default:
      return `0x${code.toString(16).padStart(2, '0').toUpperCase()}`;
  }
}

export function hmkCodeFromName(name: string): number | null {
  if (Object.prototype.hasOwnProperty.call(HMK_KEYCODE_NAMES, name)) return HMK_KEYCODE_NAMES[name];
  const mo = /^MO\((\d)\)$/.exec(name);
  if (mo) return HMK_SP_MO_MIN + Number(mo[1]);
  const pf = /^PF\((\d)\)$/.exec(name);
  if (pf) return HMK_SP_PF_MIN + Number(pf[1]);
  return null;
}

/** Short legend for a keymap name, for drawing the board. */
export function hmkLegendFromName(name: string): string {
  const special: Record<string, string> = {
    KC_ESC: 'Esc',
    KC_BSPC: 'Bksp',
    KC_TAB: 'Tab',
    KC_CAPS: 'Caps',
    KC_ENT: 'Enter',
    KC_SPC: 'Space',
    KC_LSFT: 'Shift',
    KC_RSFT: 'Shift',
    KC_LCTL: 'Ctrl',
    KC_RCTL: 'Ctrl',
    KC_LALT: 'Alt',
    KC_RALT: 'Alt',
    KC_LGUI: 'Win',
    KC_RGUI: 'Win',
    KC_MINS: '-',
    KC_EQL: '=',
    KC_LBRC: '[',
    KC_RBRC: ']',
    KC_BSLS: '\\',
    KC_SCLN: ';',
    KC_QUOT: "'",
    KC_GRV: '`',
    KC_COMM: ',',
    KC_DOT: '.',
    KC_SLSH: '/',
    KC_INS: 'Ins',
    KC_DEL: 'Del',
    KC_HOME: 'Home',
    KC_END: 'End',
    KC_PGUP: 'PgUp',
    KC_PGDN: 'PgDn',
    KC_UP: '↑',
    KC_DOWN: '↓',
    KC_LEFT: '←',
    KC_RGHT: '→',
    KC_APP: 'Menu',
    KC_PSCR: 'PrtSc',
    _______: '',
    XXXXXXX: ''
  };
  if (name in special) return special[name];
  const mo = /^MO\((\d)\)$/.exec(name);
  if (mo) return mo[1] === '1' ? 'Fn' : `Fn${mo[1]}`;
  return name.replace(/^KC_/, '');
}
