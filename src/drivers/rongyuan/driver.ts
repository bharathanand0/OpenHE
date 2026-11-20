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
  type AdvancedKey,
  type LightEffect,
  type LightingInfo,
  type LightingState,
  type LightSetting,
  type LightZone,
  type MacroStep,
  type DeviceOptions,
  type BoardLayout,
  type DeviceInfo,
  type DriverCapabilities,
  type KeyActuation,
  type SwitchCatalogEntry,
  type SwitchSetup,
  type KeyboardDriver,
  type TravelSample
} from '../types';
import type { UiKeycode } from '../keycodes';
import { entryToUi, nativeEntryLabel, NativeEntries, uiToEntry, type Entry } from './keycodes';
import { decodeUiKeycode, uiHid, uiMomentaryLayer, uiMouseButton } from '../keycodes';
import {
  debouncePacket,
  familyOps,
  kbOptionsPacket,
  ledPacket,
  ledWire,
  LightOp,
  MACRO_ENTRY_TAG,
  macroFromBlob,
  macroPages,
  macroReadPacket,
  macroToBlob,
  macroWritePacket,
  parseKbOptions,
  parseLed,
  parseSide,
  RY_MACRO_SLOTS,
  sidePacket,
  type FamilyOps,
  type LedParam,
  type RyMacroEvent
} from './extras';
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
  /** Vendor light table name (light-layouts.json); absent: the common set. */
  light?: string;
  /** LEDPARAM flags nibble read the other way round (8 fixed, 7 rainbow). */
  ledFlagsSwapped?: boolean;
  /** Has an edge / side light. */
  sideLight?: boolean;
};

/** One vendor light table (sharkfin data/light-layouts.json). */
export type RyLightTable = {
  rgb: boolean;
  brightnessMax: number;
  effects: Array<{
    mode: number;
    speedMax?: number | null;
    rgb?: boolean;
    options?: Array<string | null> | null;
  }>;
};

export type RyDeps = {
  findSpec(id: number): Promise<RySpec | null>;
  loadLayout(name: string): Promise<RyLayoutFile | null>;
  loadLightTable?(name: string): Promise<RyLightTable | null>;
  /** The owner's answer on the flag order, kept per board (null: none). */
  flagChoice?: FlagChoiceStore;
};

export type FlagChoiceStore = {
  read(id: number): { swapped: boolean; dflt: boolean } | null;
  write(id: number, choice: { swapped: boolean; dflt: boolean } | null): void;
};

const YC500_HALL_REVISION = 0x0200;
const KEY_GAP_MS = 400;
const SETTING_GAP_MS = 1000;
const FLASH_PAGE_GAP_MS = 100;
const FLASH_SETTLE_MS = 2000;
const FLASH_COOLDOWN_MS = 10000;
/** Lighting is flash too: one write per second at most. */
const LIGHT_GAP_MS = 1000;

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
  private readonly ops: FamilyOps;
  private readonly factory: Array<Entry | null>;
  private flagsSwapped: boolean;
  private readonly lightTable: RyLightTable | null;
  private readonly flagStore: FlagChoiceStore | null;

  private constructor(
    private readonly wire: Wire,
    readonly info: DeviceInfo,
    readonly spec: RySpec,
    readonly family: Family,
    readonly revision: number | null,
    private readonly columns: Columns | null,
    resolved: {
      layout: BoardLayout;
      slots: number[];
      matchRate: number;
      factory?: Array<Entry | null>;
    },
    private readonly streamDevices: HidDeviceLike[],
    private readonly closeNode: () => Promise<void>,
    extras: { lightTable: RyLightTable | null; flagStore: FlagChoiceStore | null } = {
      lightTable: null,
      flagStore: null
    }
  ) {
    this.ops = familyOps(family);
    this.factory = resolved.factory ?? resolved.slots.map(() => null);
    this.lightTable = extras.lightTable;
    this.flagStore = extras.flagStore;
    // the owner's answer stands while the registry still says what it said then
    const dflt = !!spec.ledFlagsSwapped;
    const choice = this.flagStore?.read(spec.id) ?? null;
    if (choice && choice.dflt !== dflt) this.flagStore?.write(spec.id, null);
    this.flagsSwapped = choice && choice.dflt === dflt ? choice.swapped : dflt;
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
      advancedKeys: ['macro'],
      maxAdvancedKeys: RY_MACRO_SLOTS,
      dynamicKeystrokeBindings: 0,
      macros: true,
      travelStream: columns?.format === 'gen2' && !wire.relay && streamDevices.length > 0,
      calibration: false,
      rgb: true,
      gamepad: false,
      pollingRates: [],
      releasePoint: columns !== null,
      topDeadzone: false,
      bottomDeadzone: columns !== null,
      writable: { keymap: true, actuation: switchWrites, advancedKeys: true },
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
    const lightTable = spec.light ? ((await deps.loadLightTable?.(spec.light)) ?? null) : null;
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
      options.close ?? (async () => undefined),
      { lightTable, flagStore: deps.flagChoice ?? null }
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

  supportsKeycode(value: UiKeycode): boolean {
    return uiToEntry(value, this.natives) !== null;
  }

  keycodeLabel(value: UiKeycode): string | null {
    const d = decodeUiKeycode(value);
    if (d.type === 'layer') return 'Fn';
    if (d.type !== 'native') return null;
    const e = this.natives.entry(d.code);
    return e ? nativeEntryLabel(e) : null;
  }

  extraKeycodes(): Array<{ value: UiKeycode; label: string }> {
    return [{ value: uiMomentaryLayer(1), label: 'Fn' }];
  }

  /** Factory base layer from the layout file, where it gives every key's entry. */
  defaultKeymap(layer = 0): UiKeycode[] | null {
    if (layer !== 0 || this.factory.some(e => e === null)) return null;
    return this.factory.map(e => entryToUi(e!, this.natives));
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
      const press = f.toMm(Col.RT_PRESS, v(Col.RT_PRESS, slot));
      const release = f.toMm(Col.RT_LIFT, v(Col.RT_LIFT, slot));
      const bottom = f.toMm(Col.DEAD_BOTTOM, v(Col.DEAD_BOTTOM, slot));
      return {
        actuationMm: f.toMm(Col.TRAVEL, v(Col.TRAVEL, slot)),
        rapidTrigger: rt,
        // the firmware has no split flag: two different values are a split
        splitSensitivity: Math.abs(press - release) > 1e-6,
        rtPressMm: press,
        rtReleaseMm: release,
        continuous: false,
        // nor a dead zone switch: a zero bottom dead zone is "off"
        deadzoneEnabled: bottom > 0,
        topDeadzoneMm: 0,
        bottomDeadzoneMm: bottom,
        releaseMm: f.toMm(Col.LIFT, v(Col.LIFT, slot))
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
      const mode = cols.get(Col.MODE)?.[slot] ?? 0;
      set(Col.MODE, (mode & 0x7f) | (a.rapidTrigger ? MODE_RAPID_TRIGGER : 0));
      set(Col.TRAVEL, f.toWire(Col.TRAVEL, a.actuationMm));
      // sensitivities are written even with Rapid Trigger off, so turning it
      // back on restores them
      set(Col.RT_PRESS, f.toWire(Col.RT_PRESS, a.rtPressMm));
      set(Col.RT_LIFT, f.toWire(Col.RT_LIFT, a.splitSensitivity ? a.rtReleaseMm : a.rtPressMm));
      if (a.releaseMm !== undefined) set(Col.LIFT, f.toWire(Col.LIFT, a.releaseMm));
      set(Col.DEAD_BOTTOM, f.toWire(Col.DEAD_BOTTOM, a.deadzoneEnabled ? a.bottomDeadzoneMm : 0));
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

  /**
   * Switch Selector: the board's per-key switch model (column 252), offered
   * only where the board's registry record lists the vendor's switch models,
   * and written only with a listed code, as sharkfin does.
   */
  switchCatalog(): SwitchCatalogEntry[] {
    const listed = this.spec.switchTypes ?? [];
    if (!this.columns || !listed.length) return [];
    return [
      ...listed.map(t => ({
        id: `code-${t.code}`,
        name: t.name,
        brand: this.spec.company ?? 'RongYuan',
        travelMm: this.capabilities.travelMm,
        tunable: false
      })),
      {
        id: 'unset',
        name: 'Not set',
        brand: this.spec.company ?? 'RongYuan',
        travelMm: this.capabilities.travelMm,
        tunable: false
      }
    ];
  }

  private switchCodes: number[] | null = null;

  async getSwitchSetup(): Promise<SwitchSetup> {
    const f = this.columns;
    const listed = new Set((this.spec.switchTypes ?? []).map(t => t.code));
    if (!f || !listed.size) throw new DriverError('This board does not list switch models.');
    const codes = await this.wire.exclusive(async () => {
      const pages: Uint8Array[] = [];
      for (let page = 0; page < f.getPages(Col.SWITCH_TYPE); page++) {
        pages.push(await this.wire.readRawPage(f.readRequest(Col.SWITCH_TYPE, page)));
      }
      return f.decode(Col.SWITCH_TYPE, concat(pages));
    });
    this.switchCodes = codes;
    return {
      keySwitch: this.slots.map(slot =>
        listed.has(codes[slot]) ? `code-${codes[slot]}` : 'unset'
      ),
      tuning: {}
    };
  }

  async setSwitchSetup(setup: SwitchSetup): Promise<void> {
    const f = this.columns;
    if (!f || !this.capabilities.writable.actuation) {
      throw new DriverError(
        `Switch settings on ${this.info.name} can be read but not written yet.`
      );
    }
    this.requireConfirmedLayout();
    if (setup.keySwitch.length !== this.slots.length) {
      throw new RangeError('switch assignment length does not match the board');
    }
    const listed = new Set((this.spec.switchTypes ?? []).map(t => t.code));
    const before = this.switchCodes ?? (await this.getSwitchSetup(), this.switchCodes!);
    const next = [...before];
    setup.keySwitch.forEach((id, i) => {
      if (id === 'unset') return; // an unlisted code goes back as it was
      const code = Number(id.replace(/^code-/, ''));
      if (!listed.has(code)) throw new DriverError(`Switch "${id}" is not offered for this board.`);
      next[this.slots[i]] = code;
    });
    if (next.every((v, i) => v === before[i])) return;
    await this.wire.exclusive(async () => {
      const cooldown = this.lastFlash + FLASH_COOLDOWN_MS - this.wire.clock.now();
      if (cooldown > 0) await this.wire.clock.sleep(cooldown);
      for (const pkt of f.setAll(Col.SWITCH_TYPE, next, true)) {
        await this.wire.send(pkt);
        await this.wire.clock.sleep(FLASH_PAGE_GAP_MS);
      }
      await this.wire.clock.sleep(FLASH_SETTLE_MS);
      this.lastFlash = this.wire.clock.now();
      this.stamp();
    });
    this.switchCodes = next;
  }

  // ------------------------------------------------------------ lighting

  private get wireLed() {
    return ledWire(this.family, this.flagsSwapped, this.lightTable?.brightnessMax ?? 4);
  }

  lightingInfo(): LightingInfo {
    const table = this.lightTable;
    const effects: LightEffect[] = table
      ? table.effects
          .filter(e => e.mode in MODE_LABELS)
          .map(e => ({
            mode: e.mode,
            label: MODE_LABELS[e.mode],
            ...(e.options ? { options: e.options } : {}),
            color: !!e.rgb,
            speedMax: e.speedMax == null ? null : Math.min(e.speedMax, 4)
          }))
      : COMMON_EFFECTS;
    const backlight: LightZone = { effects, brightnessMax: Math.max(1, table?.brightnessMax ?? 4) };
    return {
      backlight,
      ...(this.spec.sideLight
        ? { side: { effects: SIDE_EFFECTS, brightnessMax: 4, offMode: 0 } }
        : {}),
      canSwitchOff: this.ops.kbOption !== null,
      flagOrder: {
        swapped: this.flagsSwapped,
        fromRegistry: this.flagsSwapped === !!this.spec.ledFlagsSwapped
      }
    };
  }

  setLightFlagOrder(swapped: boolean): void {
    this.flagsSwapped = swapped;
    const dflt = !!this.spec.ledFlagsSwapped;
    this.flagStore?.write(this.spec.id, swapped === dflt ? null : { swapped, dflt });
  }

  async getLighting(): Promise<LightingState> {
    return this.wire.exclusive(async () => {
      const led = parseLed(await this.wire.roundtrip(packet(LightOp.GET_LED)), this.wireLed);
      if (!led) throw new DriverError('The keyboard gave an unexpected lighting reply.');
      const state: LightingState = { backlight: toSetting(led) };
      if (this.spec.sideLight) {
        const side = parseSide(
          await this.wire.roundtrip(packet(LightOp.GET_SIDE)),
          this.flagsSwapped
        );
        if (side) state.side = toSetting(side);
      }
      const kb = this.ops.kbOption;
      if (kb) {
        const o = parseKbOptions(await this.wire.roundtrip(packet(kb.get, [0])), kb.get);
        if (o) {
          state.backlightOff = o.backlightOff;
          if (this.spec.sideLight) state.sideOff = o.sideLightOff;
        }
      }
      return state;
    });
  }

  private async lightWrite(pkt: Uint8Array) {
    await this.wire.exclusive(async () => {
      await this.gap(LIGHT_GAP_MS);
      await this.wire.send(pkt);
      this.stamp();
    });
  }

  async setBacklight(setting: LightSetting): Promise<void> {
    await this.lightWrite(ledPacket(fromSetting(setting), this.wireLed));
  }

  async setSideLight(setting: LightSetting): Promise<void> {
    if (!this.spec.sideLight) throw new DriverError(`${this.info.name} has no edge light.`);
    await this.lightWrite(sidePacket(fromSetting(setting), this.flagsSwapped));
  }

  async setLightsOff(off: { backlightOff?: boolean; sideOff?: boolean }): Promise<void> {
    const kb = this.ops.kbOption;
    if (!kb) throw new DriverError('This board turns its lights off with an effect, not a switch.');
    await this.wire.exclusive(async () => {
      await this.gap(LIGHT_GAP_MS);
      const cur = await this.wire.roundtrip(packet(kb.get, [0]));
      const o = parseKbOptions(cur, kb.get);
      if (!o) throw new DriverError('The keyboard gave an unexpected options reply.');
      if (off.backlightOff !== undefined) o.backlightOff = off.backlightOff;
      if (off.sideOff !== undefined) o.sideLightOff = off.sideOff;
      await this.wire.send(kbOptionsPacket(o, kb.set, cur));
      this.stamp();
    });
  }

  // ------------------------------------------------------------ settings

  async getOptions(): Promise<DeviceOptions> {
    return this.wire.exclusive(async () => {
      const out: DeviceOptions = {};
      const deb = await this.wire.roundtrip(packet(this.ops.getDebounce));
      if (deb[0] === this.ops.getDebounce) out.debounce = deb[this.ops.debounceAt];
      const kb = this.ops.kbOption;
      if (kb) {
        const o = parseKbOptions(await this.wire.roundtrip(packet(kb.get, [0])), kb.get);
        if (o) Object.assign(out, { winLock: o.winLock, wasdSwap: o.wasdSwap, macMode: o.macMode });
      }
      try {
        const auto = await this.wire.roundtrip(packet(LightOp.GET_AUTO_OS));
        if (auto[0] === LightOp.GET_AUTO_OS) out.autoOs = auto[1] === 1;
      } catch {
        // not every board answers; leave it out
      }
      return out;
    });
  }

  async setOptions(options: DeviceOptions): Promise<void> {
    await this.wire.exclusive(async () => {
      if (options.debounce !== undefined) {
        await this.gap(SETTING_GAP_MS);
        await this.wire.send(debouncePacket(this.ops, options.debounce));
        this.stamp();
      }
      const kb = this.ops.kbOption;
      if (kb && (options.winLock !== undefined || options.wasdSwap !== undefined)) {
        await this.gap(SETTING_GAP_MS);
        const cur = await this.wire.roundtrip(packet(kb.get, [0]));
        const o = parseKbOptions(cur, kb.get);
        if (!o) throw new DriverError('The keyboard gave an unexpected options reply.');
        if (options.winLock !== undefined) o.winLock = options.winLock;
        if (options.wasdSwap !== undefined) o.wasdSwap = options.wasdSwap;
        await this.wire.send(kbOptionsPacket(o, kb.set, cur));
        this.stamp();
      }
      if (options.autoOs !== undefined) {
        await this.gap(SETTING_GAP_MS);
        await this.wire.send(packet(LightOp.SET_AUTO_OS, [options.autoOs ? 1 : 0]));
        this.stamp();
      }
    });
  }

  /** Wipes every profile, keymap, macro and light setting on the board. */
  async factoryReset(): Promise<void> {
    if (this.wire.relay) throw new DriverError('Plug the keyboard in by cable to reset it.');
    await this.wire.exclusive(async () => {
      await this.gap(SETTING_GAP_MS);
      await this.wire.send(packet(this.ops.reset));
      await this.wire.clock.sleep(this.ops.resetSettleMs);
      this.stamp();
    });
    this.keymapCache.clear();
    this.columnsCache = null;
    this.switchCodes = null;
  }

  // ------------------------------------------------------------ macros

  private async readMacroBlob(slot: number): Promise<Uint8Array> {
    return this.wire.exclusive(async () => {
      const pages: Uint8Array[] = [];
      for (let page = 0; page < 4; page++)
        pages.push((await this.wire.readRawPage(macroReadPacket(slot, page))).subarray(0, 64));
      return concat(pages);
    });
  }

  /** Macro contents read or written this connection, by slot. */
  private readonly macroCache = new Map<number, Uint8Array>();

  private async macroBlob(slot: number): Promise<Uint8Array> {
    let blob = this.macroCache.get(slot);
    if (!blob) {
      blob = await this.readMacroBlob(slot);
      this.macroCache.set(slot, blob);
    }
    return blob;
  }

  /**
   * Macro keys on both layers: keymap entries `[9, mode, slot, 0]`. Each
   * carries `ryMacroSlot` so an unchanged macro keeps its slot (and any
   * mouse movement, which steps cannot show).
   */
  async getAdvancedKeys(profile: number): Promise<AdvancedKey[]> {
    this.checkProfile(profile);
    this.macroCache.clear();
    const out: AdvancedKey[] = [];
    for (const layer of [0, 1]) {
      const m = await this.matrix(profile, layer === 1, true);
      for (const [key, s] of this.slots.entries()) {
        const [tag, mode, slot] = entryAt(m, s);
        if (tag !== MACRO_ENTRY_TAG || slot >= RY_MACRO_SLOTS) continue;
        const macro = macroFromBlob(await this.macroBlob(slot));
        out.push({
          kind: 'macro',
          layer,
          key,
          steps: eventsToSteps(macro.events),
          mode: mode === 1 ? 'toggle' : mode === 2 ? 'hold' : macro.repeat > 1 ? 'repeat' : 'once',
          repeat: Math.max(1, Math.min(macro.repeat, 255)),
          ryMacroSlot: slot
        } as AdvancedKey);
      }
    }
    return out;
  }

  async setAdvancedKeys(profile: number, keys: readonly AdvancedKey[]): Promise<void> {
    this.checkProfile(profile);
    this.requireConfirmedLayout();
    if (keys.some(k => k.kind !== 'macro'))
      throw new DriverError('This board only stores macros as advanced keys.');
    const macros = keys as ReadonlyArray<
      Extract<AdvancedKey, { kind: 'macro' }> & { ryMacroSlot?: number }
    >;
    const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, '0')).join('');

    // each key's macro as a blob; an untouched one keeps its slot's exact bytes
    const wanted: Array<{ ak: (typeof macros)[number]; blob: Uint8Array; id: string }> = [];
    for (const ak of macros) {
      const repeat = ak.mode === 'repeat' ? Math.max(1, ak.repeat) : 1;
      const fresh = macroToBlob({ repeat, events: stepsToEvents(ak.steps) });
      let blob = fresh;
      if (ak.ryMacroSlot !== undefined) {
        const had = await this.macroBlob(ak.ryMacroSlot);
        const was = macroFromBlob(had);
        if (sameSteps(eventsToSteps(was.events), ak.steps) && Math.max(1, was.repeat) === repeat)
          blob = had;
      }
      wanted.push({ ak, blob, id: hex(blob) });
    }

    // slots the other profiles bind are not ours to overwrite
    const others = new Set<number>();
    for (let p = 0; p < this.spec.profiles; p++) {
      if (p === profile) continue;
      for (const fn of [false, true]) {
        const m = await this.matrix(p, fn);
        for (let s = 0; s * 4 < m.length; s++) {
          const e = entryAt(m, s);
          if (e[0] === MACRO_ENTRY_TAG && e[2] < RY_MACRO_SLOTS) others.add(e[2]);
        }
      }
    }

    const slotOf = new Map<string, number>();
    const taken = new Set<number>();
    const hints = new Set(
      macros.map(ak => ak.ryMacroSlot).filter((s): s is number => s !== undefined)
    );
    const writes: Array<{ slot: number; blob: Uint8Array }> = [];
    const place = (id: string, slot: number, blob: Uint8Array) => {
      slotOf.set(id, slot);
      taken.add(slot);
      if (hex(this.macroCache.get(slot) ?? new Uint8Array()) !== id) writes.push({ slot, blob });
    };
    // 1. a slot that already holds exactly this macro
    for (const w of wanted) {
      if (slotOf.has(w.id)) continue;
      const hint = w.ak.ryMacroSlot;
      const same = [hint, ...this.macroCache.keys()].find(
        s =>
          s !== undefined &&
          !taken.has(s) &&
          this.macroCache.get(s) &&
          hex(this.macroCache.get(s)!) === w.id
      );
      if (same !== undefined) place(w.id, same, w.blob);
    }
    // 2. its own old slot, if no other profile uses it; 3. a free slot
    for (const w of wanted) {
      if (slotOf.has(w.id)) continue;
      const hint = w.ak.ryMacroSlot;
      let slot = hint !== undefined && !taken.has(hint) && !others.has(hint) ? hint : -1;
      if (slot < 0) {
        slot =
          [...Array(RY_MACRO_SLOTS).keys()].find(
            s => !taken.has(s) && !others.has(s) && !hints.has(s)
          ) ??
          [...Array(RY_MACRO_SLOTS).keys()].find(s => !taken.has(s) && !others.has(s)) ??
          -1;
      }
      if (slot < 0)
        throw new DriverError(
          `The keyboard holds ${RY_MACRO_SLOTS} macros, and the other profiles use the rest.`
        );
      if (!this.macroCache.has(slot)) await this.macroBlob(slot);
      place(w.id, slot, w.blob);
    }

    for (const { slot, blob } of writes) {
      await this.wire.exclusive(async () => {
        const cooldown = this.lastFlash + FLASH_COOLDOWN_MS - this.wire.clock.now();
        if (cooldown > 0) await this.wire.clock.sleep(cooldown);
        const pages = macroPages(blob);
        for (let page = 0; page < pages; page++) {
          await this.wire.send(
            macroWritePacket(this.ops.setMacro, slot, page, page + 1 === pages, blob)
          );
          await this.wire.clock.sleep(FLASH_PAGE_GAP_MS);
        }
        this.lastFlash = this.wire.clock.now();
        this.stamp();
      });
      this.macroCache.set(slot, blob);
    }

    // bind the keys; a key that lost its macro goes back to its factory entry
    for (const layer of [0, 1]) {
      const fnLayer = layer === 1;
      const m = await this.matrix(profile, fnLayer);
      const next = new Map<number, Entry>();
      this.slots.forEach((s, key) => {
        if (entryAt(m, s)[0] === MACRO_ENTRY_TAG)
          next.set(key, fnLayer ? [0, 0, 0, 0] : (this.factory[key] ?? [0, 0, 0, 0]));
      });
      for (const w of wanted) {
        if (w.ak.layer === layer)
          next.set(w.ak.key, [MACRO_ENTRY_TAG, MODE_CODE[w.ak.mode], slotOf.get(w.id)!, 0]);
      }
      await this.writeEntries(profile, fnLayer, next);
    }
  }

  private async writeEntries(profile: number, fnLayer: boolean, entries: Map<number, Entry>) {
    const current = await this.matrix(profile, fnLayer);
    for (const [key, entry] of entries) {
      const slot = this.slots[key];
      if (slot === undefined || sameEntry(entryAt(current, slot), entry)) continue;
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

const MODE_CODE = { once: 0, repeat: 0, toggle: 1, hold: 2 } as const;

const repeatOf = (ak: Extract<AdvancedKey, { kind: 'macro' }>) =>
  ak.mode === 'repeat' ? Math.max(1, ak.repeat) : 1;

/** Board events as steps; mouse moves have no step form and are left out. */
function eventsToSteps(events: RyMacroEvent[]): MacroStep[] {
  const steps: MacroStep[] = [];
  for (const e of events) {
    if (e.kind === 'move') continue;
    const keycode = e.kind === 'key' ? uiHid(e.usage) : uiMouseButton(e.button + 1);
    steps.push({ keycode, action: e.pressed ? 'press' : 'release', delayMs: e.delayMs });
  }
  return steps;
}

function stepsToEvents(steps: readonly MacroStep[]): RyMacroEvent[] {
  const events: RyMacroEvent[] = [];
  for (const step of steps) {
    const d = decodeUiKeycode(step.keycode);
    const make = (pressed: boolean, delayMs: number): RyMacroEvent => {
      if (d.type === 'hid') return { kind: 'key', usage: d.usage, pressed, delayMs };
      if (d.type === 'mouse' && d.button >= 1 && d.button <= 5)
        return { kind: 'mouse', button: d.button - 1, pressed, delayMs };
      throw new DriverError('A macro step uses a key this keyboard cannot play in a macro.');
    };
    if (step.action === 'tap') events.push(make(true, 0), make(false, step.delayMs));
    else events.push(make(step.action === 'press', step.delayMs));
  }
  return events;
}

const sameSteps = (a: readonly MacroStep[], b: readonly MacroStep[]) =>
  JSON.stringify(stepsToEventsSafe(a)) === JSON.stringify(stepsToEventsSafe(b));

function stepsToEventsSafe(steps: readonly MacroStep[]): RyMacroEvent[] | null {
  try {
    return stepsToEvents(steps);
  } catch {
    return null;
  }
}

/** Effects by wire number (sharkfin lighting-modes.ts). */
const MODE_LABELS: Record<number, string> = {
  1: 'Static',
  2: 'Breathing',
  3: 'Spectrum cycle',
  4: 'Wave',
  5: 'Ripple',
  6: 'Star dots',
  7: 'Flow',
  8: 'Key shadow',
  9: 'Layers',
  10: 'Sine wave',
  11: 'Spring',
  12: 'Neon',
  14: 'Radiant',
  15: 'Loop',
  16: 'Color grid',
  17: 'Snowfall',
  18: 'Meteor',
  19: 'Silent snow',
  23: 'Train',
  24: 'Endless'
};

const fx = (mode: number, extra: Partial<LightEffect> = {}): LightEffect => ({
  mode,
  label: MODE_LABELS[mode],
  color: true,
  speedMax: 4,
  ...extra
});

/** The common set, for boards without a light table. */
const COMMON_EFFECTS: LightEffect[] = [
  fx(1, { speedMax: null }),
  fx(2),
  fx(3, { color: false }),
  fx(4, { options: ['Right', 'Left', 'Down', 'Up'] }),
  fx(5),
  fx(6),
  fx(7, { options: ['Zigzag', 'Spiral'] }),
  fx(8),
  fx(9),
  fx(10),
  fx(11, { options: ['Outward', 'Inward'] }),
  fx(12, { options: ['Right', 'Left'] }),
  fx(14),
  fx(15, { options: ['CCW', 'CW'] }),
  fx(16),
  fx(17),
  fx(18),
  fx(19)
];

const SIDE_EFFECTS: LightEffect[] = [
  { mode: 0, label: 'Off', color: false, speedMax: null },
  { mode: 1, label: 'Static', color: true, speedMax: null },
  { mode: 2, label: 'Breathing', color: true, speedMax: 4 },
  { mode: 3, label: 'Neon', color: false, speedMax: 4 },
  { mode: 4, label: 'Wave', color: true, speedMax: 4 },
  { mode: 5, label: 'Snake', color: true, speedMax: 4 }
];

const toSetting = (p: LedParam): LightSetting => ({
  mode: p.mode,
  speed: p.speed,
  brightness: p.brightness,
  option: p.option,
  rainbow: p.rainbow,
  color: (p.color[0] << 16) | (p.color[1] << 8) | p.color[2]
});

const fromSetting = (s: LightSetting): LedParam => ({
  mode: s.mode,
  speed: s.speed,
  brightness: s.brightness,
  option: s.option,
  rainbow: s.rainbow,
  color: [(s.color >> 16) & 0xff, (s.color >> 8) & 0xff, s.color & 0xff]
});

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
