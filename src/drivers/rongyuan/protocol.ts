/**
 * RongYuan ("ROYUAN") keyboard protocol, as established by sharkfin
 * (https://github.com/dniminenn/sharkfin, docs/PROTOCOL.md and
 * app/src-tauri/src/protocol/). Ported to TypeScript; the evidence notes
 * there say which parts were seen on hardware and which were read out of
 * firmware images.
 *
 * 64-byte feature reports, report ID 0, on the vendor collection 0xFFFF
 * usage 2 (usage 1 on a few boards). Two command families (yc500, gen2)
 * share opcodes that mean different things, so the family always comes from
 * the board's registry record, never from the USB product ID.
 */

export const RY_USAGE_PAGE = 0xffff;
export const RY_USAGES = [0x0002, 0x0001] as const;
export const RY_REPORT_LEN = 64;

export type Family = 'gen2' | 'yc500';

export const enum Checksum {
  Bit7,
  Bit8,
  None
}

/** `0xFF - (sum & 0xFF)` over bytes 0..6 (Bit7) or 0..7 (Bit8). */
export function applyChecksum(buf: Uint8Array, mode: Checksum): void {
  if (mode === Checksum.None) return;
  const end = mode === Checksum.Bit7 ? 7 : 8;
  let sum = 0;
  for (let i = 0; i < end; i++) sum += buf[i];
  buf[end] = 0xff - (sum & 0xff);
}

export function packet(
  opcode: number,
  payload: ArrayLike<number> = [],
  checksum = Checksum.Bit7
): Uint8Array {
  const buf = new Uint8Array(RY_REPORT_LEN);
  buf[0] = opcode;
  buf.set(payload, 1);
  applyChecksum(buf, checksum);
  return buf;
}

export const Op = {
  IDENTIFY: 0x8f,
  GET_REVISION: 0x80,
  GET_FN: 0x90,
  SET_FN: 0x10,
  // yc500 only
  YC_SET_PROFILE: 0x05,
  YC_GET_PROFILE: 0x85,
  YC_GET_KEYMATRIX: 0x89,
  YC_SET_KEY_ONE: 0x13,
  YC_SET_FN_ONE: 0x15,
  // gen2 only
  G2_SET_PROFILE: 0x04,
  G2_GET_PROFILE: 0x84,
  G2_SET_KEYMATRIX: 0x0a,
  G2_GET_KEYMATRIX: 0x8a
} as const;

export function profileOps(family: Family) {
  return family === 'gen2'
    ? { set: Op.G2_SET_PROFILE, get: Op.G2_GET_PROFILE }
    : { set: Op.YC_SET_PROFILE, get: Op.YC_GET_PROFILE };
}

/** `0x8F` reply: `[0x8F, id u32 LE, ...]`. A board that answers every probe with the request and byte 3 = 0xFF is not an id. */
export function parseDeviceId(reply: Uint8Array): number | null {
  const refused = packet(Op.IDENTIFY);
  refused[3] = 0xff;
  if (reply.length === refused.length && reply.every((b, i) => b === refused[i])) return null;
  if (reply.length < 5 || reply[0] !== Op.IDENTIFY) return null;
  return (reply[1] | (reply[2] << 8) | (reply[3] << 16) | (reply[4] << 24)) >>> 0;
}

/** `(reply[at+1] << 8) | reply[at]`; zero counts as no answer. */
export function revisionWord(reply: Uint8Array, at: number): number | null {
  const v = (reply[at + 1] << 8) | reply[at];
  return v !== 0 ? v : null;
}

/** Each nibble a decimal digit: 0x0814 is "8.14". */
export function formatRevision(v: number | null): string {
  return v === null
    ? 'unknown'
    : `${(v >> 8).toString(16)}.${(v & 0xff).toString(16).padStart(2, '0')}`;
}

/** Magnetic yc500 boards address profiles as `profile * 4 + sublayer`. */
export function yc500ProfileSlot(magnetic: boolean, profile: number, sublayer: number): number {
  return magnetic ? profile * 4 + sublayer : profile;
}

// ------------------------------------------------------------------ keymap

/** 128 slots x 4 bytes per layer, read as eight raw 64-byte pages. */
export const KEYMAP_SLOTS = 128;
export const KEYMAP_PAGES = 8;

export function keymapReadRequest(
  family: Family,
  profile: number,
  page: number,
  fnLayer: boolean,
  sublayer = 0,
  magnetic = true
) {
  if (family === 'gen2') {
    return fnLayer
      ? packet(Op.GET_FN, [0, profile, 0xff, page])
      : packet(Op.G2_GET_KEYMATRIX, [profile, 0xff, page, sublayer]);
  }
  return fnLayer
    ? packet(Op.GET_FN, [profile, page])
    : packet(Op.YC_GET_KEYMATRIX, [yc500ProfileSlot(magnetic, profile, sublayer), page]);
}

/** One slot. gen2 byte 5 applies and commits; byte 6 picks the sub-layer. */
export function keyWritePacket(
  family: Family,
  profile: number,
  slot: number,
  entry: readonly number[],
  fnLayer: boolean,
  sublayer = 0,
  magnetic = true
): Uint8Array {
  let buf: Uint8Array;
  if (family === 'gen2') {
    buf = fnLayer
      ? packet(Op.SET_FN, [0, profile, slot])
      : packet(Op.G2_SET_KEYMATRIX, [profile, slot, 0, 0, 1, sublayer]);
  } else {
    const op = fnLayer ? Op.YC_SET_FN_ONE : Op.YC_SET_KEY_ONE;
    buf = packet(op, [fnLayer ? profile : yc500ProfileSlot(magnetic, profile, sublayer), slot]);
  }
  buf.set(entry.slice(0, 4), 8);
  return buf;
}

// --------------------------------------------------------- switch columns

export const HALL_GET = 0xe5;
export const HALL_SET = 0x65;

export const Col = {
  TRAVEL: 0,
  LIFT: 1,
  RT_PRESS: 2,
  RT_LIFT: 3,
  DKS_START: 4,
  MT_TIME: 5,
  DEAD_BOTTOM: 6,
  MODE: 7,
  DKS_ACTIONS: 8,
  SNAP_PARTNER: 9,
  DKS_ACTIONS_ALL: 10,
  SWITCH_TYPE: 252
} as const;

export const MODE_RAPID_TRIGGER = 0x80;
export const Kind = {
  NORMAL: 0,
  DKS: 2,
  MOD_TAP: 3,
  TOGGLE_HOLD: 4,
  TOGGLE_TAP: 5,
  SNAP: 7
} as const;

/** `0x1B [flag]`, gen2: stream live travel as input reports `[5, 0x1B, lo, hi, slot]`. Cable only. */
export const TRAVEL_STREAM = 0x1b;
export const TRAVEL_REPORT_ID = 5;

export function parseTravelReport(
  reportId: number,
  data: Uint8Array
): { slot: number; counts: number } | null {
  if (reportId !== TRAVEL_REPORT_ID || data.length < 4 || data[0] !== TRAVEL_STREAM) return null;
  return { slot: data[3], counts: data[1] | (data[2] << 8) };
}

/** Firmware clamps at gen2 apply, mirrored so the UI never lies. */
const GEN2_MIN_TRAVEL_MM = 0.1;
const GEN2_MIN_RT_MM = 0.01;
const GEN2_MAX_DEAD_MM = 3.4;
/** The vendor's total travel for yc500 boards, tenths. */
const YC500_FULL_TRAVEL = 40;

/** gen2 count size by firmware version: tenths below 3.00, hundredths from 3.00, half-hundredths from 5.00. */
export function gen2UnitMm(revision: number | null): number {
  if (revision !== null && revision >= 0x0500) return 0.005;
  if (revision !== null && revision < 0x0300) return 0.1;
  return 0.01;
}

export const WRITE_COLUMNS = [
  Col.MODE,
  Col.TRAVEL,
  Col.LIFT,
  Col.RT_PRESS,
  Col.RT_LIFT,
  Col.DEAD_BOTTOM
] as const;
export const READ_COLUMNS = [
  ...WRITE_COLUMNS,
  Col.DKS_START,
  Col.MT_TIME,
  Col.SNAP_PARTNER
] as const;

/** The column format of one board: gen2 (u16 travel columns, 128 slots) or yc500 (bytes in tenths, 126 slots). */
export class Columns {
  private constructor(
    readonly format: Family,
    readonly unitMm: number
  ) {}

  static gen2(revision: number | null) {
    return new Columns('gen2', gen2UnitMm(revision));
  }

  static yc500() {
    return new Columns('yc500', 0.1);
  }

  get slots(): number {
    return this.format === 'gen2' ? 128 : 126;
  }

  wide(col: number): boolean {
    return (
      this.format === 'gen2' &&
      (col === Col.TRAVEL ||
        col === Col.LIFT ||
        col === Col.RT_PRESS ||
        col === Col.RT_LIFT ||
        col === Col.DKS_START ||
        col === Col.DEAD_BOTTOM)
    );
  }

  getPages(col: number): number {
    return this.wide(col) ? 4 : 2;
  }

  readRequest(col: number, page: number): Uint8Array {
    return packet(HALL_GET, [col, 1, page]);
  }

  decode(col: number, pages: Uint8Array): number[] {
    const out: number[] = [];
    if (this.wide(col)) {
      for (let i = 0; i < Math.min(pages.length >> 1, this.slots); i++)
        out.push(pages[2 * i] | (pages[2 * i + 1] << 8));
    } else {
      for (let i = 0; i < Math.min(pages.length, this.slots); i++) out.push(pages[i]);
    }
    return out;
  }

  toWire(col: number, mm: number): number {
    if (this.format === 'gen2') {
      let v = mm;
      if (col === Col.TRAVEL || col === Col.LIFT || col === Col.DKS_START)
        v = Math.max(v, GEN2_MIN_TRAVEL_MM);
      else if (col === Col.RT_PRESS || col === Col.RT_LIFT) v = Math.max(v, GEN2_MIN_RT_MM);
      else if (col === Col.DEAD_BOTTOM) v = Math.min(Math.max(v, 0), GEN2_MAX_DEAD_MM);
      return Math.min(65535, Math.max(0, Math.round(v / this.unitMm)));
    }
    const tenths = Math.round(mm * 10);
    const b =
      col === Col.DEAD_BOTTOM
        ? YC500_FULL_TRAVEL - tenths - 1
        : col === Col.DKS_START
          ? tenths - 2
          : tenths - 1;
    return Math.min(255, Math.max(0, b));
  }

  toMm(col: number, wire: number): number {
    if (this.format === 'gen2') return wire * this.unitMm;
    const tenths =
      col === Col.DEAD_BOTTOM
        ? YC500_FULL_TRAVEL - (wire + 1)
        : col === Col.DKS_START
          ? wire + 2
          : wire + 1;
    return Math.max(0, tenths) / 10;
  }

  /** One slot of one column; null when the slot is past the column (it would land in the next one). */
  setOne(col: number, slot: number, last: boolean, value: number): Uint8Array | null {
    if (slot < 0 || slot >= this.slots) return null;
    const buf = packet(HALL_SET, [col, 0, slot, last ? 1 : 0]);
    buf[8] = value & 0xff;
    if (this.wide(col)) buf[9] = (value >> 8) & 0xff;
    return buf;
  }

  setDksActions(slot: number, last: boolean, actions: readonly number[]): Uint8Array | null {
    if (slot < 0 || slot >= this.slots) return null;
    const buf = packet(HALL_SET, [Col.DKS_ACTIONS, 0, slot, last ? 1 : 0]);
    buf.set(actions.slice(0, 4), 8);
    return buf;
  }

  /** A whole column as bulk pages: 28 u16 or 56 bytes a page, `last` on the final page only. */
  setAll(col: number, values: readonly number[], last: boolean): Uint8Array[] {
    const vals = values.slice(0, this.slots);
    const wire: number[] = this.wide(col)
      ? vals.flatMap(v => [v & 0xff, (v >> 8) & 0xff])
      : vals.map(v => v & 0xff);
    const pages: Uint8Array[] = [];
    const n = Math.ceil(wire.length / 56);
    for (let i = 0; i < n; i++) {
      const buf = packet(HALL_SET, [col, 1, i, last && i + 1 === n ? 1 : 0]);
      buf.set(wire.slice(i * 56, i * 56 + 56), 8);
      pages.push(buf);
    }
    return pages;
  }
}

// ------------------------------------------------------- 2.4 GHz receiver

export const Receiver = {
  STATUS: 0xf7,
  SELECT: 0xf6,
  RELEASE: 0xfc,
  TARGET_KEYBOARD: 0x0a
} as const;

export type ReceiverStatus = {
  replyReady: boolean;
  keyboardBattery: number;
  keyboardOnline: boolean;
  canSend: boolean;
  hasKeyboard: boolean;
};

/** A receiver's status; null for anything else (a keyboard's reply). */
export function parseReceiverStatus(reply: Uint8Array): ReceiverStatus | null {
  if (reply.length < 9 || ![1, 2, 3].includes(reply[6])) return null;
  return {
    replyReady: reply[0] === 1,
    keyboardBattery: reply[1],
    keyboardOnline: reply[3] === 0,
    canSend: reply[5] === 1,
    hasKeyboard: reply[6] === 1 || reply[6] === 3
  };
}
