/**
 * RongYuan driver: keymap, Fn layer and magnetic switch settings, following
 * what sharkfin does (docs/PROTOCOL.md, protocol/hall.rs, commands.rs):
 *
 * - Family (gen2 / yc500) and lineage come from the registry record of the
 *   id the board reports; never from the USB product ID.
 * - Switch settings are read on gen2 and on yc500 from firmware 2.00, and
 *   written only on the lineages whose write path is evidenced (ry5088 on
 *   gen2, yc3121 on yc500). Other boards are read-only.
 * - Switch columns belong to the active profile. Writes are paced like
 *   sharkfin's: 100 ms between flash pages, 2 s settle after a batch, 10 s
 *   between batches, 400 ms between key writes.
 */

import type { HidDeviceLike } from '../transport';
import {
  DriverError,
  type BoardLayout,
  type DeviceInfo,
  type DriverCapabilities,
  type KeyActuation,
  type KeyboardDriver,
  type TravelSample
} from '../types';
import type { UiKeycode } from '../keycodes';
import { entryToUi, NativeEntries, uiToEntry, type Entry } from './keycodes';
import {
  entryAt,
  gridLayout,
  inferLayout,
  layoutFromRegistry,
  MIN_MATCH_RATE,
  type RyLayoutFile
} from './layout';
import {
  Col,
  Columns,
  formatRevision,
  KEYMAP_PAGES,
  keymapReadRequest,
  keyWritePacket,
  MODE_RAPID_TRIGGER,
  Op,
  packet,
  parseTravelReport,
  profileOps,
  revisionWord,
  TRAVEL_STREAM,
  WRITE_COLUMNS,
  type Family
} from './protocol';
import { Wire, WireError } from './wire';

/** One board record from sharkfin's registry (trimmed). */
export type RySpec = {
  id: number;
  displayName?: string;
  company?: string;
  vendorId: number;
  productId: number;
  internalName: string;
  keyLayout: string;
  profiles: number;
  family?: string;
  travel?: Partial<
    Record<
      'travel' | 'firePress' | 'fireLift' | 'deadzone',
      { min: number; max: number; default?: number | null }
    >
  >;
  switchTypes?: Array<{ code: number; name: string }>;
};

export type RyDeps = {
  findSpec(id: number): Promise<RySpec | null>;
  loadLayout(name: string): Promise<RyLayoutFile | null>;
};

const YC500_HALL_REVISION = 0x0200;
const KEY_GAP_MS = 400;
const SETTING_GAP_MS = 1000;
const FLASH_PAGE_GAP_MS = 100;
const FLASH_SETTLE_MS = 2000;
const FLASH_COOLDOWN_MS = 10000;

const ACTUATION_COLUMNS = [
  Col.MODE,
  Col.TRAVEL,
  Col.LIFT,
  Col.RT_PRESS,
  Col.RT_LIFT,
  Col.DEAD_BOTTOM
] as const;

export function hallReads(spec: RySpec, family: Family, revision: number | null): boolean {
  if (family === 'gen2') return true;
  return revision !== null && revision >= YC500_HALL_REVISION;
}

export function hallWrites(spec: RySpec, family: Family, revision: number | null): boolean {
  if (!hallReads(spec, family, revision)) return false;
  return family === 'gen2'
    ? spec.internalName.startsWith('ry5088_')
    : spec.internalName.startsWith('yc3121_');
}

export class RongyuanDriver implements KeyboardDriver {
  readonly id = 'rongyuan' as const;
  readonly capabilities: DriverCapabilities;
  layout: BoardLayout;
  /** Matrix slot of each layout key. */
  private slots: number[];
  /** An inferred picture must be confirmed before keymap/switch writes. */
  private layoutConfirmed: boolean;
  readonly matchRate: number;

  private readonly natives = new NativeEntries();
  private readonly keymapCache = new Map<string, Uint8Array>();
  private columnsCache: { profile: number; values: Map<number, number[]> } | null = null;
  private lastWrite = -Infinity;
  private lastFlash = -Infinity;

  private constructor(
    private readonly wire: Wire,
    readonly info: DeviceInfo,
    readonly spec: RySpec,
    readonly family: Family,
    readonly revision: number | null,
    private readonly columns: Columns | null,
    resolved: { layout: BoardLayout; slots: number[]; matchRate: number },
    private readonly streamDevices: HidDeviceLike[],
    private readonly closeNode: () => Promise<void>
  ) {
    this.layout = resolved.layout;
    this.slots = resolved.slots;
    this.matchRate = resolved.matchRate;
    this.layoutConfirmed = resolved.layout.source !== 'inferred';
    const t = spec.travel;
    const switchWrites = columns !== null && hallWrites(spec, family, revision);
    this.capabilities = {
      profiles: spec.profiles,
      layers: 2,
      travelMm: t?.travel?.max ?? 4,
      travelStepMm: columns?.unitMm ?? 0.1,
      actuation: columns !== null,
      rapidTrigger: columns !== null,
      rapidTriggerSplit: columns !== null,
      continuousRapidTrigger: false,
      advancedKeys: [],
      maxAdvancedKeys: 0,
      macros: false,
      travelStream: columns?.format === 'gen2' && !wire.relay && streamDevices.length > 0,
      calibration: false,
      rgb: false,
      gamepad: false,
      pollingRates: [],
      releasePoint: columns !== null,
      bottomDeadzone: columns !== null,
      writable: { keymap: true, actuation: switchWrites, advancedKeys: false },
      actuationActiveProfileOnly: true,
      ranges: {
        ...(t?.travel ? { actuation: { min: t.travel.min, max: t.travel.max } } : {}),
        ...(t?.firePress ? { rapidTrigger: { min: t.firePress.min, max: t.firePress.max } } : {}),
        ...(t?.deadzone ? { deadzone: { min: t.deadzone.min, max: t.deadzone.max } } : {})
      }
    };
  }

  static async connect(
    wire: Wire,
    deps: RyDeps,
    usb: { vendorId: number; productId: number; productName: string },
    options: { streamDevices?: HidDeviceLike[]; close?: () => Promise<void> } = {}
  ): Promise<RongyuanDriver> {
    const id = await wire.exclusive(() => wire.identify());
    const spec = await deps.findSpec(id);
    if (!spec)
      throw new DriverError(`This RongYuan board (device ${id}) is not in the board list yet.`);
    const family = spec.family === 'gen2' || spec.family === 'yc500' ? spec.family : null;
    if (!family)
      throw new DriverError(
        `${spec.displayName ?? spec.internalName}: its command set is not established yet.`
      );

    const revision = await wire.exclusive(async () => {
      try {
        const rev = revisionWord(await wire.roundtrip(packet(Op.GET_REVISION)), 1);
        if (rev !== null || family !== 'gen2') return rev;
        return revisionWord(await wire.roundtrip(packet(Op.IDENTIFY)), 7);
      } catch {
        return null;
      }
    });
    const columns = hallReads(spec, family, revision)
      ? family === 'gen2'
        ? Columns.gen2(revision)
        : Columns.yc500()
      : null;

    const profile =
      (await wire.exclusive(() => wire.roundtrip(packet(profileOps(family).get)))).at(1) ?? 0;
    const file = await deps.loadLayout(spec.keyLayout);
    let resolved = file ? layoutFromRegistry(file) : null;
    if (!resolved) {
      const matrix = await wire.exclusive(() => readMatrix(wire, family, profile, false));
      const inferred = file ? inferLayout(file, matrix) : null;
      resolved =
        inferred && inferred.matchRate >= MIN_MATCH_RATE
          ? inferred
          : gridLayout(matrix, columns?.slots ?? 128);
    }

    const name = [spec.company, spec.displayName].filter(Boolean).join(' ') || usb.productName;
    const driver = new RongyuanDriver(
      wire,
      {
        name,
        firmwareVersion: formatRevision(revision),
        vendorId: usb.vendorId,
        productId: usb.productId
      },
      spec,
      family,
      revision,
      columns,
      resolved,
      options.streamDevices ?? [],
      options.close ?? (async () => undefined)
    );
    return driver;
  }

  /** The user looked at an inferred picture and says it is their board. */
  confirmLayout(): void {
    this.layoutConfirmed = true;
  }

  get needsLayoutConfirmation(): boolean {
    return !this.layoutConfirmed;
  }

  close(): Promise<void> {
    return this.closeNode();
  }

  private checkProfile(profile: number) {
    if (!Number.isInteger(profile) || profile < 0 || profile >= this.spec.profiles) {
      throw new RangeError(`profile ${profile} out of range`);
    }
  }

  private requireConfirmedLayout() {
    if (!this.layoutConfirmed) {
      throw new DriverError('Confirm that the picture matches your keyboard before writing to it.');
    }
  }

  private async gap(ms: number) {
    const wait = this.lastWrite + ms - this.wire.clock.now();
    if (wait > 0) await this.wire.clock.sleep(wait);
  }

  private stamp() {
    this.lastWrite = this.wire.clock.now();
  }

  async getProfile(): Promise<number> {
    const reply = await this.wire.exclusive(() =>
      this.wire.roundtrip(packet(profileOps(this.family).get))
    );
    return reply[1];
  }

  /** Switch the board's active profile (switch columns follow it). */
  async setProfile(profile: number): Promise<void> {
    this.checkProfile(profile);
    await this.wire.exclusive(async () => {
      await this.gap(SETTING_GAP_MS);
      await this.wire.send(packet(profileOps(this.family).set, [profile]));
      this.stamp();
    });
    this.columnsCache = null;
  }

  private async matrix(profile: number, fnLayer: boolean, fresh = false): Promise<Uint8Array> {
    const key = `${profile}:${fnLayer ? 1 : 0}`;
    const cached = this.keymapCache.get(key);
    if (cached && !fresh) return cached;
    const m = await this.wire.exclusive(() => readMatrix(this.wire, this.family, profile, fnLayer));
    this.keymapCache.set(key, m);
    return m;
  }

  async getKeymap(profile: number, layer: number): Promise<UiKeycode[]> {
    this.checkProfile(profile);
    if (layer !== 0 && layer !== 1) throw new RangeError(`layer ${layer} out of range`);
    const m = await this.matrix(profile, layer === 1, true);
    return this.slots.map(slot => entryToUi(entryAt(m, slot), this.natives));
  }

  async setKeymap(profile: number, layer: number, keymap: readonly UiKeycode[]): Promise<void> {
    this.checkProfile(profile);
    this.requireConfirmedLayout();
    if (layer !== 0 && layer !== 1) throw new RangeError(`layer ${layer} out of range`);
    if (keymap.length !== this.slots.length)
      throw new RangeError('keymap length does not match the board');
    const fnLayer = layer === 1;
    const entries = keymap.map((kc, i) => {
      const e = uiToEntry(kc, this.natives);
      if (!e)
        throw new DriverError(
          `Key ${this.layout.keys[i]?.label || i}: this keycode is not available on this board`
        );
      return e;
    });
    const current = await this.matrix(profile, fnLayer);
    const changes = entries
      .map((e, i) => ({ slot: this.slots[i], entry: e }))
      .filter(({ slot, entry }) => !sameEntry(entryAt(current, slot), entry));
    for (const { slot, entry } of changes) {
      await this.wire.exclusive(async () => {
        await this.gap(KEY_GAP_MS);
        const pkt = keyWritePacket(this.family, profile, slot, entry, fnLayer);
        await this.wire.send(pkt);
        this.stamp();
        if (this.family === 'yc500') await this.verifyYc500Slot(pkt, profile, slot, entry, fnLayer);
      });
      current.set(entry, slot * 4);
    }
  }

  /** yc500 firmware without the single-slot write drops it silently; look three times. */
  private async verifyYc500Slot(
    pkt: Uint8Array,
    profile: number,
    slot: number,
    entry: Entry,
    fnLayer: boolean
  ) {
    for (const wait of [10, 50, 150]) {
      await this.wire.clock.sleep(wait);
      const page = await this.wire.readRawPage(
        keymapReadRequest('yc500', profile, slot >> 4, fnLayer)
      );
      if (page[0] === pkt[0]) continue;
      if (sameEntry(entryAt(page, slot % 16), entry)) return;
    }
    throw new DriverError('The keyboard did not take the key write.');
  }

  defaultKeymap(): UiKeycode[] | null {
    return null;
  }

  private async ensureActiveProfile(profile: number) {
    this.checkProfile(profile);
    if ((await this.getProfile()) !== profile) await this.setProfile(profile);
  }

  private async readColumns(profile: number): Promise<Map<number, number[]>> {
    const f = this.columns;
    if (!f) throw new DriverError('This board has no magnetic switch settings to read.');
    if (this.columnsCache?.profile === profile) return this.columnsCache.values;
    await this.ensureActiveProfile(profile);
    const values = new Map<number, number[]>();
    await this.wire.exclusive(async () => {
      for (const col of ACTUATION_COLUMNS) {
        const pages: Uint8Array[] = [];
        for (let page = 0; page < f.getPages(col); page++)
          pages.push(await this.wire.readRawPage(f.readRequest(col, page)));
        values.set(col, f.decode(col, concat(pages)));
      }
    });
    this.columnsCache = { profile, values };
    return values;
  }

  async getActuation(profile: number): Promise<KeyActuation[]> {
    const f = this.columns;
    const cols = await this.readColumns(profile);
    if (!f) return [];
    const v = (col: number, slot: number) => cols.get(col)?.[slot] ?? 0;
    return this.slots.map(slot => {
      const rt = (v(Col.MODE, slot) & MODE_RAPID_TRIGGER) !== 0;
      return {
        actuationMm: f.toMm(Col.TRAVEL, v(Col.TRAVEL, slot)),
        rtPressMm: rt ? f.toMm(Col.RT_PRESS, v(Col.RT_PRESS, slot)) : 0,
        rtReleaseMm: rt ? f.toMm(Col.RT_LIFT, v(Col.RT_LIFT, slot)) : 0,
        continuous: false,
        releaseMm: f.toMm(Col.LIFT, v(Col.LIFT, slot)),
        bottomDeadzoneMm: f.toMm(Col.DEAD_BOTTOM, v(Col.DEAD_BOTTOM, slot))
      };
    });
  }

  async setActuation(profile: number, actuation: readonly KeyActuation[]): Promise<void> {
    const f = this.columns;
    if (!f || !this.capabilities.writable.actuation) {
      throw new DriverError(
        `Switch settings on ${this.info.name} can be read but not written yet.`
      );
    }
    this.requireConfirmedLayout();
    if (actuation.length !== this.slots.length)
      throw new RangeError('actuation length does not match the board');
    const cols = await this.readColumns(profile);
    const next = new Map<number, number[]>([...cols].map(([c, vals]) => [c, [...vals]]));
    actuation.forEach((a, i) => {
      const slot = this.slots[i];
      const set = (col: number, value: number) => {
        const arr = next.get(col);
        if (arr) arr[slot] = value;
      };
      const rt = a.rtPressMm > 0;
      const mode = cols.get(Col.MODE)?.[slot] ?? 0;
      set(Col.MODE, (mode & 0x7f) | (rt ? MODE_RAPID_TRIGGER : 0));
      set(Col.TRAVEL, f.toWire(Col.TRAVEL, a.actuationMm));
      if (rt) {
        set(Col.RT_PRESS, f.toWire(Col.RT_PRESS, a.rtPressMm));
        set(Col.RT_LIFT, f.toWire(Col.RT_LIFT, a.rtReleaseMm > 0 ? a.rtReleaseMm : a.rtPressMm));
      }
      if (a.releaseMm !== undefined) set(Col.LIFT, f.toWire(Col.LIFT, a.releaseMm));
      if (a.bottomDeadzoneMm !== undefined)
        set(Col.DEAD_BOTTOM, f.toWire(Col.DEAD_BOTTOM, a.bottomDeadzoneMm));
    });

    const changedSlots = new Set<number>();
    const changedCols: number[] = [];
    for (const col of WRITE_COLUMNS) {
      const before = cols.get(col) ?? [];
      const after = next.get(col) ?? [];
      let changed = false;
      after.forEach((v, s) => {
        if (v !== before[s]) {
          changed = true;
          changedSlots.add(s);
        }
      });
      if (changed) changedCols.push(col);
    }
    if (!changedSlots.size) return;

    await this.wire.exclusive(async () => {
      const cooldown = this.lastFlash + FLASH_COOLDOWN_MS - this.wire.clock.now();
      if (cooldown > 0) await this.wire.clock.sleep(cooldown);
      if (changedSlots.size <= 2) {
        // sharkfin's per-key path: the six plain columns, the last one flagged
        for (const slot of changedSlots) {
          for (const [i, col] of WRITE_COLUMNS.entries()) {
            const pkt = f.setOne(
              col,
              slot,
              i === WRITE_COLUMNS.length - 1,
              next.get(col)?.[slot] ?? 0
            );
            if (!pkt) throw new DriverError('slot out of range');
            await this.wire.send(pkt);
          }
          await this.wire.clock.sleep(FLASH_SETTLE_MS);
        }
      } else {
        // whole columns in bulk pages, the final page of the final column flagged
        for (const [i, col] of changedCols.entries()) {
          for (const pkt of f.setAll(col, next.get(col) ?? [], i === changedCols.length - 1)) {
            await this.wire.send(pkt);
            await this.wire.clock.sleep(FLASH_PAGE_GAP_MS);
          }
        }
        await this.wire.clock.sleep(FLASH_SETTLE_MS);
      }
      this.lastFlash = this.wire.clock.now();
      this.stamp();
    });
    this.columnsCache = { profile, values: next };
  }

  async subscribeTravel(listener: (samples: TravelSample[]) => void): Promise<() => Promise<void>> {
    const f = this.columns;
    if (!f || !this.capabilities.travelStream)
      throw new DriverError('Live travel is read from gen2 boards by cable only.');
    const indexOf = new Map(this.slots.map((slot, index) => [slot, index]));
    const onReport = (event: { reportId: number; data: DataView }) => {
      const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
      const t = parseTravelReport(event.reportId, data);
      if (!t) return;
      const index = indexOf.get(t.slot);
      if (index === undefined) return;
      listener([{ index, raw: t.counts, travelMm: t.counts * f.unitMm }]);
    };
    for (const d of this.streamDevices) {
      if (!d.opened) await d.open();
      d.addEventListener('inputreport', onReport);
    }
    await this.wire.exclusive(async () => {
      await this.gap(SETTING_GAP_MS);
      await this.wire.send(packet(TRAVEL_STREAM, [1]));
      this.stamp();
    });
    return async () => {
      for (const d of this.streamDevices) d.removeEventListener('inputreport', onReport);
      await this.wire.exclusive(async () => {
        await this.gap(SETTING_GAP_MS);
        await this.wire.send(packet(TRAVEL_STREAM, [0]));
        this.stamp();
      });
    };
  }
}

function sameEntry(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** One 512-byte keymap layer, eight raw pages. */
async function readMatrix(
  wire: Wire,
  family: Family,
  profile: number,
  fnLayer: boolean
): Promise<Uint8Array> {
  const pages: Uint8Array[] = [];
  for (let page = 0; page < KEYMAP_PAGES; page++) {
    pages.push(await wire.readRawPage(keymapReadRequest(family, profile, page, fnLayer)));
  }
  return concat(pages);
}

export { WireError };
