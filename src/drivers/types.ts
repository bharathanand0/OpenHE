/**
 * Board-neutral driver layer.
 *
 * A driver speaks one keyboard family's protocol (libhmk, RongYuan, AULA ...)
 * and presents it through this interface, so the UI can ask what a board can
 * do (`capabilities`) instead of checking which model is plugged in.
 *
 * Units the UI sees are fixed regardless of the board:
 *  - travel in millimetres (drivers convert to/from their native steps),
 *  - keycodes in the UI keycode space (see `keycodes.ts`),
 *  - keys by index into `layout.keys` (drivers keep their own matrix mapping).
 */

import type { UiKeycode } from './keycodes';

export type DriverId = 'libhmk' | 'rongyuan' | 'aula-bytetech' | 'aula-xsyd';

/** One physical key in the board's layout, in keycap units. */
export type LayoutKey = {
  /** Index used everywhere else in the driver API. */
  index: number;
  /** Top-left position and size in key units (1U = one standard key). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Short legend, from the default keymap when the board does not give one. */
  label: string;
};

export type BoardLayout = {
  keys: LayoutKey[];
  /**
   * Where the key-to-matrix mapping came from: the board itself, a stored
   * layout matched against the board's keymap, or a plain grid of matrix
   * slots when nothing matched.
   */
  source?: 'board' | 'registry' | 'inferred' | 'grid';
  /** Overall size in key units. */
  width: number;
  height: number;
};

export type AdvancedKeyKind = 'nullBind' | 'dynamicKeystroke' | 'tapHold' | 'toggle' | 'macro';

export type DriverCapabilities = {
  profiles: number;
  layers: number;
  /** Full travel of the switch in millimetres. */
  travelMm: number;
  /** Smallest step the board stores for actuation/RT values, in millimetres. */
  travelStepMm: number;
  actuation: boolean;
  rapidTrigger: boolean;
  /** Separate press and release sensitivities. */
  rapidTriggerSplit: boolean;
  continuousRapidTrigger: boolean;
  advancedKeys: readonly AdvancedKeyKind[];
  maxAdvancedKeys: number;
  /** Keycodes one dynamic keystroke can bind. */
  dynamicKeystrokeBindings: number;
  macros: boolean;
  /** Live per-key travel readout. */
  travelStream: boolean;
  calibration: boolean;
  rgb: boolean;
  gamepad: boolean;
  pollingRates: readonly number[];
  /** Separate release point when rapid trigger is off. */
  releasePoint: boolean;
  bottomDeadzone: boolean;
  /** Writes the driver will send. Reads always work. */
  writable: { keymap: boolean; actuation: boolean; advancedKeys: boolean };
  /** Whether `getActuation`/`setActuation` work only on the board's active profile. */
  actuationActiveProfileOnly: boolean;
  /** Vendor ranges for the sliders, millimetres. */
  ranges?: Partial<Record<'actuation' | 'rapidTrigger' | 'deadzone', { min: number; max: number }>>;
};

export type DeviceInfo = {
  name: string;
  firmwareVersion: string;
  serial?: string;
  vendorId: number;
  productId: number;
};

/** Per-key actuation settings in board-neutral units. */
export type KeyActuation = {
  actuationMm: number;
  /** 0 disables rapid trigger. */
  rtPressMm: number;
  rtReleaseMm: number;
  continuous: boolean;
  /** Release point with rapid trigger off (`capabilities.releasePoint`). */
  releaseMm?: number;
  /** Distance from the bottom that counts as bottomed out (`capabilities.bottomDeadzone`). */
  bottomDeadzoneMm?: number;
};

export type TravelSample = {
  index: number;
  /** Raw sensor value, if the board exposes it. */
  raw?: number;
  travelMm: number;
};

export type AdvancedKey =
  | {
      kind: 'nullBind';
      layer: number;
      key: number;
      secondaryKey: number;
      behavior: 'last' | 'primary' | 'secondary' | 'neutral' | 'distance';
      bottomOutMm: number;
    }
  | {
      kind: 'dynamicKeystroke';
      layer: number;
      key: number;
      keycodes: UiKeycode[];
      /** Per keycode, the action at [press, bottom-out, release from bottom-out, release]. */
      actions: Array<[DksAction, DksAction, DksAction, DksAction]>;
      bottomOutMm: number;
    }
  | {
      kind: 'tapHold';
      layer: number;
      key: number;
      tap: UiKeycode;
      hold: UiKeycode;
      tappingTermMs: number;
      holdOnOtherKeyPress: boolean;
    }
  | { kind: 'toggle'; layer: number; key: number; keycode: UiKeycode; tappingTermMs: number }
  | { kind: 'macro'; layer: number; key: number; macro: number };

export type DksAction = 'hold' | 'press' | 'release' | 'tap';

export interface KeyboardDriver {
  readonly id: DriverId;
  readonly info: DeviceInfo;
  readonly capabilities: DriverCapabilities;
  readonly layout: BoardLayout;

  close(): Promise<void>;

  getProfile(): Promise<number>;

  getKeymap(profile: number, layer: number): Promise<UiKeycode[]>;
  setKeymap(profile: number, layer: number, keymap: readonly UiKeycode[]): Promise<void>;
  /** Default keymap of a layer, when the board publishes one. */
  defaultKeymap?(layer: number): UiKeycode[] | null;

  getActuation(profile: number): Promise<KeyActuation[]>;
  setActuation(profile: number, actuation: readonly KeyActuation[]): Promise<void>;

  getAdvancedKeys?(profile: number): Promise<AdvancedKey[]>;
  setAdvancedKeys?(profile: number, keys: readonly AdvancedKey[]): Promise<void>;

  /** One snapshot of every key's travel. */
  readTravel?(): Promise<TravelSample[]>;
  /** Push-style travel updates; resolves to a stop function. */
  subscribeTravel?(listener: (samples: TravelSample[]) => void): Promise<() => Promise<void>>;

  /** Label for a keycode only this board knows (driver-native codes). */
  keycodeLabel?(value: UiKeycode): string | null;
  /** Whether the board can store this keycode. */
  supportsKeycode?(value: UiKeycode): boolean;
  /** Keycodes this board offers beyond the shared catalog (layers, profiles ...). */
  extraKeycodes?(): Array<{ value: UiKeycode; label: string }>;

  recalibrate?(): Promise<void>;
  factoryReset?(): Promise<void>;
}

/** Thrown when a board rejects or does not answer a request. */
export class DriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverError';
  }
}
