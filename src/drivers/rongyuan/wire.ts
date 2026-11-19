/**
 * The conversation with a RongYuan board over feature reports, ported from
 * sharkfin's wire.rs: write pacing, reply retries, and the 2.4 GHz
 * receiver's relay.
 */

import {
  packet,
  parseDeviceId,
  parseReceiverStatus,
  Op,
  Receiver,
  RY_REPORT_LEN
} from './protocol';

/** The raw primitives a backend provides. */
export interface FeatureNode {
  sendFeature(buf: Uint8Array): Promise<void>;
  receiveFeature(): Promise<Uint8Array>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
};

/** Faster than this stalls the control endpoint until re-enumeration. */
export const MIN_WRITE_GAP_MS = 12;
const SETTLE_MS = 10;
const REPLY_TRIES = 5;
const RECEIVER_SEND_DEADLINE_MS = 500;
const RECEIVER_READ_DEADLINE_MS = 1000;
const RECEIVER_TICK_MS = 5;
const RECEIVER_REST_MS = 10;

export class WireError extends Error {
  constructor(
    message: string,
    readonly kind: 'no-handshake' | 'keyboard-offline' | 'receiver-busy' | 'protocol' = 'protocol'
  ) {
    super(message);
    this.name = 'WireError';
  }
}

export class Wire {
  /** Traffic goes through a receiver's relay. */
  relay = false;
  private selected = false;
  private lastWrite = -Infinity;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly node: FeatureNode,
    readonly clock: Clock = realClock
  ) {}

  /** Serialise every exchange: the board answers one request at a time. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async rawSend(buf: Uint8Array) {
    const since = this.clock.now() - this.lastWrite;
    if (since < MIN_WRITE_GAP_MS) await this.clock.sleep(MIN_WRITE_GAP_MS - since);
    this.lastWrite = this.clock.now();
    await this.node.sendFeature(buf);
  }

  private async rawRead(): Promise<Uint8Array> {
    const wire = await this.node.receiveFeature();
    if (wire.length < 8) throw new WireError(`short feature report (${wire.length} bytes)`);
    const out = new Uint8Array(RY_REPORT_LEN);
    // tolerate platforms that keep the report-ID byte
    if (wire[0] === 0 && wire.length === RY_REPORT_LEN + 1) out.set(wire.subarray(1));
    else out.set(wire.subarray(0, RY_REPORT_LEN));
    return out;
  }

  private async receiverStatus() {
    await this.rawSend(packet(Receiver.STATUS));
    await this.clock.sleep(RECEIVER_REST_MS);
    return parseReceiverStatus(await this.rawRead());
  }

  private async relaySend(buf: Uint8Array) {
    const deadline = this.clock.now() + RECEIVER_SEND_DEADLINE_MS;
    let ready = false;
    for (;;) {
      const s = await this.receiverStatus();
      if (s && !s.keyboardOnline)
        throw new WireError(
          'The receiver is paired, but the keyboard is asleep or off.',
          'keyboard-offline'
        );
      if (s?.canSend) {
        ready = true;
        break;
      }
      if (this.clock.now() >= deadline) break;
      await this.clock.sleep(RECEIVER_TICK_MS);
    }
    if (!ready) {
      this.selected = false;
      throw new WireError('The receiver did not accept a packet to relay.', 'receiver-busy');
    }
    if (!this.selected) {
      await this.rawSend(packet(Receiver.SELECT, [Receiver.TARGET_KEYBOARD]));
      await this.clock.sleep(RECEIVER_REST_MS);
      this.selected = true;
    }
    await this.rawSend(buf);
  }

  private async relayRead(): Promise<Uint8Array> {
    const deadline = this.clock.now() + RECEIVER_READ_DEADLINE_MS;
    for (;;) {
      const s = await this.receiverStatus();
      if (s?.replyReady) break;
      if (this.clock.now() >= deadline)
        throw new WireError('No reply through the receiver.', 'no-handshake');
      await this.clock.sleep(RECEIVER_TICK_MS);
    }
    await this.rawSend(packet(Receiver.RELEASE));
    await this.clock.sleep(RECEIVER_REST_MS);
    return this.rawRead();
  }

  send(buf: Uint8Array): Promise<void> {
    return this.relay ? this.relaySend(buf) : this.rawSend(buf);
  }

  read(): Promise<Uint8Array> {
    return this.relay ? this.relayRead() : this.rawRead();
  }

  /** Send, then wait for a reply that echoes the opcode. */
  async roundtrip(pkt: Uint8Array): Promise<Uint8Array> {
    await this.send(pkt);
    for (let attempt = 0; attempt < REPLY_TRIES; attempt++) {
      await this.clock.sleep(SETTLE_MS * (attempt + 1));
      const reply = await this.read();
      if (reply[0] === pkt[0]) return reply;
    }
    throw new WireError(`No answer to 0x${pkt[0].toString(16)}`, 'no-handshake');
  }

  /** Bulk reads whose replies are raw pages, no opcode echo. */
  async readRawPage(pkt: Uint8Array): Promise<Uint8Array> {
    await this.send(pkt);
    await this.clock.sleep(SETTLE_MS);
    return this.read();
  }

  private async tryIdentify(): Promise<number | null> {
    for (let i = 0; i < 3; i++) {
      try {
        const id = parseDeviceId(await this.roundtrip(packet(Op.IDENTIFY)));
        if (id !== null) return id;
      } catch {
        // retry
      }
    }
    return null;
  }

  /**
   * `0x8F` identify. A node that does not answer by cable is asked whether
   * it is a receiver, and identify is repeated through the relay when it is
   * one with a keyboard awake.
   */
  async identify(allowRelay = true): Promise<number> {
    const direct = await this.tryIdentify();
    if (direct !== null) return direct;
    if (!allowRelay)
      throw new WireError('The device did not answer the identify handshake.', 'no-handshake');
    const status = await this.receiverStatus();
    if (!status)
      throw new WireError('The device did not answer the identify handshake.', 'no-handshake');
    if (!status.hasKeyboard || !status.keyboardOnline) {
      throw new WireError(
        'The receiver is paired, but the keyboard is asleep or off.',
        'keyboard-offline'
      );
    }
    this.relay = true;
    this.selected = false;
    const relayed = await this.tryIdentify();
    if (relayed === null) {
      this.relay = false;
      throw new WireError('The keyboard did not answer through the receiver.', 'no-handshake');
    }
    return relayed;
  }
}
