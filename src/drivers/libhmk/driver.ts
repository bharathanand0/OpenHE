/**
 * libhmk driver: any board running libhmk firmware (the same boards hmkconf
 * talks to). Everything about the board comes from its own metadata, so no
 * per-board registry entry is needed.
 */

import {
  hasCollection,
  InputReportTransport,
  type HidDeviceLike,
  type ReportTransport
} from '../transport';
import {
  DriverError,
  type AdvancedKey,
  type BoardLayout,
  type DeviceInfo,
  type DriverCapabilities,
  type KeyActuation,
  type KeyboardDriver,
  type LayoutKey,
  type TravelSample
} from '../types';
import type { UiKeycode } from '../keycodes';
import { hmkCodeFromName, hmkLegendFromName, hmkNativeLabel, hmkToUi, uiToHmk } from './keycodes';
import { decodeUiKeycode, uiMomentaryLayer, uiNative } from '../keycodes';
import {
  ACTUATION_CHUNK,
  ACTUATION_SIZE,
  ANALOG_INFO_CHUNK,
  Cmd,
  HMK_USAGE,
  HMK_USAGE_PAGE,
  KEYMAP_CHUNK,
  KEYMAP_GET_CHUNK,
  STAGED_GET_CHUNK,
  STAGED_SET_CHUNK,
  advancedKeySize,
  decodeActuation,
  decodeAdvancedKey,
  encodeActuation,
  encodeAdvancedKey,
  formatFirmwareVersion,
  gunzipJson,
  rd16,
  rd32,
  request,
  u16,
  u32,
  type HmkMetadata
} from './protocol';

/** libhmk stores travel as 0..255 over the full stroke; hmkconf assumes 4 mm. */
export const HMK_TRAVEL_MM = 4;
const UNITS = 255;

export const LIBHMK_HID_FILTER = { usagePage: HMK_USAGE_PAGE, usage: HMK_USAGE } as const;

export function isLibhmkDevice(device: HidDeviceLike): boolean {
  return hasCollection(device, HMK_USAGE_PAGE, HMK_USAGE);
}

export class LibhmkDriver implements KeyboardDriver {
  readonly id = 'libhmk' as const;
  readonly capabilities: DriverCapabilities;
  readonly layout: BoardLayout;

  private constructor(
    private readonly transport: ReportTransport,
    readonly info: DeviceInfo,
    readonly metadata: HmkMetadata
  ) {
    this.capabilities = {
      profiles: metadata.numProfiles,
      layers: metadata.numLayers,
      travelMm: HMK_TRAVEL_MM,
      travelStepMm: HMK_TRAVEL_MM / UNITS,
      actuation: true,
      rapidTrigger: true,
      rapidTriggerSplit: true,
      continuousRapidTrigger: true,
      advancedKeys: ['nullBind', 'dynamicKeystroke', 'tapHold', 'toggle', 'macro'],
      maxAdvancedKeys: metadata.numAdvancedKeys,
      macros: metadata.numMacroNodes > 0,
      travelStream: true,
      calibration: true,
      rgb: false,
      gamepad: true,
      pollingRates: metadata.usbHighSpeed ? [8000, 1000] : [1000],
      releasePoint: false,
      bottomDeadzone: false,
      writable: { keymap: true, actuation: true, advancedKeys: true },
      actuationActiveProfileOnly: false
    };
    this.layout = { ...layoutFromMetadata(metadata), source: 'board' };
  }

  /** Open a WebHID device (already granted by the user) as a libhmk board. */
  static async fromHidDevice(device: HidDeviceLike): Promise<LibhmkDriver> {
    if (!device.opened) await device.open();
    const transport = new InputReportTransport(device, 0);
    try {
      return await LibhmkDriver.connect(transport, {
        vendorId: device.vendorId,
        productId: device.productId,
        productName: device.productName
      });
    } catch (err) {
      await transport.close().catch(() => undefined);
      throw err;
    }
  }

  static async connect(
    transport: ReportTransport,
    usb: { vendorId: number; productId: number; productName: string }
  ): Promise<LibhmkDriver> {
    const call = (cmd: number, payload: number[] = []) => exchange(transport, cmd, payload);
    const version = rd16(await call(Cmd.FIRMWARE_VERSION), 1);
    const metadata = await readMetadata(transport);
    const serialBytes = (await call(Cmd.GET_SERIAL)).subarray(1, 33);
    const serial = new TextDecoder().decode(serialBytes).replace(/\0.*$/s, '');
    return new LibhmkDriver(
      transport,
      {
        name: metadata.name || usb.productName,
        firmwareVersion: formatFirmwareVersion(version),
        serial: serial || undefined,
        vendorId: usb.vendorId,
        productId: usb.productId
      },
      metadata
    );
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  private call(cmd: number, payload: number[] = []): Promise<Uint8Array> {
    return exchange(this.transport, cmd, payload);
  }

  private toMm(units: number): number {
    return (units * HMK_TRAVEL_MM) / UNITS;
  }

  private toUnits(mm: number): number {
    return Math.max(0, Math.min(UNITS, Math.round((mm * UNITS) / HMK_TRAVEL_MM)));
  }

  private checkProfile(profile: number) {
    if (!Number.isInteger(profile) || profile < 0 || profile >= this.metadata.numProfiles) {
      throw new RangeError(`profile ${profile} out of range`);
    }
  }

  async getProfile(): Promise<number> {
    return (await this.call(Cmd.GET_PROFILE))[1];
  }

  async getKeymap(profile: number, layer: number): Promise<UiKeycode[]> {
    this.checkProfile(profile);
    const n = this.metadata.numKeys;
    const out: UiKeycode[] = [];
    for (let offset = 0; offset < n; offset += KEYMAP_GET_CHUNK) {
      const len = Math.min(KEYMAP_GET_CHUNK, n - offset);
      const reply = await this.call(Cmd.GET_KEYMAP, [profile, layer, offset, len]);
      for (let i = 0; i < len; i++) out.push(hmkToUi(reply[1 + i]));
    }
    return out;
  }

  async setKeymap(profile: number, layer: number, keymap: readonly UiKeycode[]): Promise<void> {
    this.checkProfile(profile);
    const codes = keymap.map((kc, i) => {
      const code = uiToHmk(kc);
      if (code === null)
        throw new DriverError(`Key ${i}: this keycode is not available on libhmk boards`);
      return code;
    });
    if (codes.length !== this.metadata.numKeys)
      throw new RangeError('keymap length does not match the board');
    for (let offset = 0; offset < codes.length; offset += KEYMAP_CHUNK) {
      const chunk = codes.slice(offset, offset + KEYMAP_CHUNK);
      await this.call(Cmd.SET_KEYMAP, [profile, layer, offset, chunk.length, ...chunk]);
    }
  }

  defaultKeymap(layer: number): UiKeycode[] | null {
    const names = this.metadata.defaultKeymaps?.[0]?.[layer];
    if (!names) return null;
    return names.map(name => hmkToUi(hmkCodeFromName(name) ?? 0));
  }

  async getActuation(profile: number): Promise<KeyActuation[]> {
    this.checkProfile(profile);
    const n = this.metadata.numKeys;
    const out: KeyActuation[] = [];
    for (let offset = 0; offset < n; offset += ACTUATION_CHUNK) {
      const len = Math.min(ACTUATION_CHUNK, n - offset);
      const reply = await this.call(Cmd.GET_ACTUATION_MAP, [profile, offset]);
      for (let i = 0; i < len; i++) {
        const a = decodeActuation(reply, 1 + i * ACTUATION_SIZE);
        out.push({
          actuationMm: this.toMm(a.actuationPoint),
          rtPressMm: this.toMm(a.rtDown),
          rtReleaseMm: this.toMm(a.rtUp),
          continuous: a.continuous
        });
      }
    }
    return out;
  }

  async setActuation(profile: number, actuation: readonly KeyActuation[]): Promise<void> {
    this.checkProfile(profile);
    if (actuation.length !== this.metadata.numKeys)
      throw new RangeError('actuation length does not match the board');
    for (let offset = 0; offset < actuation.length; offset += ACTUATION_CHUNK) {
      const chunk = actuation.slice(offset, offset + ACTUATION_CHUNK);
      const bytes = chunk.flatMap(a =>
        encodeActuation({
          // 0 would never actuate; libhmk treats actuation as a distance threshold.
          actuationPoint: Math.max(1, this.toUnits(a.actuationMm)),
          rtDown: this.toUnits(a.rtPressMm),
          rtUp: this.toUnits(a.rtReleaseMm),
          continuous: a.continuous
        })
      );
      await this.call(Cmd.SET_ACTUATION_MAP, [profile, offset, chunk.length, ...bytes]);
    }
  }

  private readStaged(cmd: number, profile: number, size: number): Promise<Uint8Array> {
    return readStaged(this.transport, cmd, profile, size);
  }

  async getAdvancedKeys(profile: number): Promise<AdvancedKey[]> {
    this.checkProfile(profile);
    const dks = this.metadata.numDynamicKeystrokeMaxBindings;
    const item = advancedKeySize(dks);
    const bytes = await this.readStaged(
      Cmd.GET_ADVANCED_KEYS,
      profile,
      item * this.metadata.numAdvancedKeys
    );
    const out: AdvancedKey[] = [];
    for (let i = 0; i < this.metadata.numAdvancedKeys; i++) {
      const ak = decodeAdvancedKey(bytes, i * item, dks, u => this.toMm(u));
      if (ak) out.push(ak);
    }
    return out;
  }

  async setAdvancedKeys(profile: number, keys: readonly AdvancedKey[]): Promise<void> {
    this.checkProfile(profile);
    const max = this.metadata.numAdvancedKeys;
    if (keys.length > max) throw new DriverError(`This board holds at most ${max} advanced keys`);
    const dks = this.metadata.numDynamicKeystrokeMaxBindings;
    const item = advancedKeySize(dks);
    const bytes = new Uint8Array(item * max);
    keys.forEach((ak, i) =>
      bytes.set(
        encodeAdvancedKey(ak, dks, mm => this.toUnits(mm)),
        i * item
      )
    );
    for (let offset = 0; offset < bytes.length; offset += STAGED_SET_CHUNK) {
      const chunk = bytes.subarray(offset, offset + STAGED_SET_CHUNK);
      await this.call(Cmd.SET_ADVANCED_KEYS, [profile, ...u16(offset), chunk.length, ...chunk]);
    }
  }

  async readTravel(): Promise<TravelSample[]> {
    const n = this.metadata.numKeys;
    const out: TravelSample[] = [];
    for (let offset = 0; offset < n; offset += ANALOG_INFO_CHUNK) {
      const reply = await this.call(Cmd.ANALOG_INFO, [offset]);
      const len = Math.min(ANALOG_INFO_CHUNK, n - offset);
      for (let i = 0; i < len; i++) {
        const o = 1 + i * 3;
        out.push({ index: offset + i, raw: rd16(reply, o), travelMm: this.toMm(reply[o + 2]) });
      }
    }
    return out;
  }

  supportsKeycode(value: UiKeycode): boolean {
    return uiToHmk(value) !== null;
  }

  keycodeLabel(value: UiKeycode): string | null {
    const d = decodeUiKeycode(value);
    if (d.type === 'native') return hmkNativeLabel(d.code);
    if (d.type === 'layer') return d.layer === 1 ? 'Fn' : `Fn${d.layer}`;
    return null;
  }

  extraKeycodes(): Array<{ value: UiKeycode; label: string }> {
    const out: Array<{ value: UiKeycode; label: string }> = [
      { value: uiNative(0x01), label: '▽ Transparent' }
    ];
    for (let l = 1; l < this.metadata.numLayers; l++) {
      out.push({ value: uiMomentaryLayer(l), label: `Layer ${l} (hold)` });
    }
    for (let p = 0; p < this.metadata.numProfiles; p++) {
      out.push({ value: uiNative(0xc8 + p), label: `Profile ${p}` });
    }
    for (const code of [0xd0, 0xd1, 0xd2, 0xd3, 0xd4])
      out.push({ value: uiNative(code), label: hmkNativeLabel(code) });
    return out;
  }

  async recalibrate(): Promise<void> {
    await this.call(Cmd.RECALIBRATE);
  }

  async factoryReset(): Promise<void> {
    await this.call(Cmd.FACTORY_RESET);
  }
}

async function exchange(
  transport: ReportTransport,
  cmd: number,
  payload: number[] = []
): Promise<Uint8Array> {
  const reply = await transport.exchange(request(cmd, payload));
  if (reply[0] !== cmd) {
    throw new DriverError(
      reply[0] === Cmd.UNKNOWN
        ? `The keyboard rejected command ${cmd}`
        : `Unexpected reply to command ${cmd}`
    );
  }
  return reply;
}

async function readStaged(transport: ReportTransport, cmd: number, profile: number, size: number) {
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size;) {
    const reply = await exchange(transport, cmd, [profile, ...u16(offset)]);
    const len = Math.min(reply[1], STAGED_GET_CHUNK, size - offset);
    if (len === 0) throw new DriverError('Keyboard returned an empty block');
    out.set(reply.subarray(2, 2 + len), offset);
    offset += len;
  }
  return out;
}

async function readMetadata(transport: ReportTransport): Promise<HmkMetadata> {
  const chunks: Uint8Array[] = [];
  let total = -1;
  for (let offset = 0; total < 0 || offset < total;) {
    const reply = await exchange(transport, Cmd.GET_METADATA, u32(offset));
    const remaining = rd32(reply, 1);
    if (total < 0) total = remaining;
    const len = Math.min(remaining, 59);
    if (len === 0) break;
    chunks.push(reply.slice(5, 5 + len));
    offset += len;
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return gunzipJson<HmkMetadata>(bytes);
}

export function layoutFromMetadata(metadata: HmkMetadata): BoardLayout {
  const legends = metadata.defaultKeymaps?.[0]?.[0] ?? [];
  const keys: LayoutKey[] = [];
  let width = 0;
  metadata.layout.keymap.forEach((row, rowIndex) => {
    let x = 0;
    for (const k of row) {
      x += k.x ?? 0;
      const w = k.w ?? 1;
      const h = k.h ?? 1;
      if (!keys.some(existing => existing.index === k.key)) {
        keys.push({
          index: k.key,
          x,
          y: rowIndex + (k.y ?? 0),
          w,
          h,
          label: legends[k.key] ? hmkLegendFromName(legends[k.key]) : String(k.key)
        });
      }
      x += w;
    }
    width = Math.max(width, x);
  });
  keys.sort((a, b) => a.index - b.index);
  const height = keys.reduce((m, k) => Math.max(m, k.y + k.h), 0);
  return { keys, width, height };
}
