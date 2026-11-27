/**
 * Latest-wins SET mailbox and ACK gate for live camera control.
 *
 * One generation on the wire per opcode, except `0x02/0xB8` which pipelines at 20 Hz without
 * waiting for ACK (Mimo pinch). Sliders replace pending instead of enqueueing. A late ACK is
 * accepted only when its seq still belongs to the open generation; superseded seqs drop.
 *
 * Source of truth: OpenCine `OpenCineDJI/CameraSetMailbox.swift` (same as fork + `restore`/`cancel`).
 */
import { opcodeKey } from '../duml/frame';

export type MailboxOffer = 'launch' | 'coalescePending';
export type MailboxAck = 'accept' | 'acceptLate' | 'dropSuperseded' | 'dropUnknown';
export type MailboxTimeout = 'subscribeMatches' | 'waitLate' | 'launchPending' | 'idle';
export type MailboxPendingLaunch = 'immediate' | 'afterHold' | 'none';

interface Generation {
  seqs: Set<number>;
  awaitingLate: boolean;
}

const genEqual = (a: Generation | undefined, b: Generation | undefined) =>
  a === b ||
  (!!a && !!b && a.awaitingLate === b.awaitingLate && a.seqs.size === b.seqs.size && [...a.seqs].every((s) => b.seqs.has(s)));
const setEqual = (a: Set<number> | undefined, b: Set<number> | undefined) =>
  a === b || (!!a && !!b && a.size === b.size && [...a].every((s) => b.has(s)));

export class CameraSetMailbox {
  static readonly coalesceHold = 0.1;
  static readonly zoomCoalesceHold = 0.05;
  static readonly zoomOpcodeKey = opcodeKey(0x02, 0xb8);
  static readonly trackingPollOpcodeKey = opcodeKey(0x02, 0xa5);

  static coalesceHoldFor(key: number): number {
    return key === CameraSetMailbox.zoomOpcodeKey ? CameraSetMailbox.zoomCoalesceHold : CameraSetMailbox.coalesceHold;
  }
  static pipelinesWhileOpen(key: number): boolean {
    return key === CameraSetMailbox.zoomOpcodeKey;
  }
  /** Only a timeout of the latest open SET is uplink evidence. */
  static timeoutImpliesUplinkFailure(result: MailboxTimeout, key = 0): boolean {
    return result === 'waitLate' && !CameraSetMailbox.pipelinesWhileOpen(key) && key !== CameraSetMailbox.trackingPollOpcodeKey;
  }

  private open = new Map<number, Generation>();
  /** Pending latest-wins; `true` = chip / discrete, skip the coalesce hold. */
  private pending = new Map<number, boolean>();
  private superseded = new Map<number, Set<number>>();
  private lastLaunch = new Map<number, number>();

  clone(): CameraSetMailbox {
    const c = new CameraSetMailbox();
    for (const [k, g] of this.open) c.open.set(k, { seqs: new Set(g.seqs), awaitingLate: g.awaitingLate });
    for (const [k, v] of this.pending) c.pending.set(k, v);
    for (const [k, v] of this.superseded) c.superseded.set(k, new Set(v));
    for (const [k, v] of this.lastLaunch) c.lastLaunch.set(k, v);
    return c;
  }

  reset(): void {
    this.open.clear();
    this.pending.clear();
    this.superseded.clear();
    this.lastLaunch.clear();
  }

  /** Restore an unsent, refused registration for one key if nothing changed it since `expected`. */
  restore(key: number, previous: CameraSetMailbox, expected: CameraSetMailbox, preservingPending = false): boolean {
    if (
      !genEqual(this.open.get(key), expected.open.get(key)) ||
      !setEqual(this.superseded.get(key), expected.superseded.get(key)) ||
      this.lastLaunch.get(key) !== expected.lastLaunch.get(key) ||
      (!preservingPending && this.pending.get(key) !== expected.pending.get(key))
    )
      return false;
    const put = <V>(m: Map<number, V>, v: V | undefined) => (v === undefined ? m.delete(key) : m.set(key, v));
    const g = previous.open.get(key);
    put(this.open, g ? { seqs: new Set(g.seqs), awaitingLate: g.awaitingLate } : undefined);
    const s = previous.superseded.get(key);
    put(this.superseded, s ? new Set(s) : undefined);
    put(this.lastLaunch, previous.lastLaunch.get(key));
    if (!preservingPending) put(this.pending, previous.pending.get(key));
    return true;
  }

  /** Retire one control when a programmed take takes ownership of it. */
  cancel(key: number): void {
    this.supersedeOpen(key);
    this.pending.delete(key);
    this.lastLaunch.delete(key);
  }

  hasOpen(key: number): boolean {
    return this.open.has(key);
  }
  isOpenSeq(key: number, seq: number): boolean {
    return this.open.get(key)?.seqs.has(seq) === true;
  }
  isAwaitingLate(key: number): boolean {
    return this.open.get(key)?.awaitingLate === true;
  }
  holdRemaining(key: number, now: number): number {
    const last = this.lastLaunch.get(key);
    if (last === undefined) return 0;
    return Math.max(0, CameraSetMailbox.coalesceHoldFor(key) - (now - last));
  }

  private markPending(key: number, urgent: boolean): void {
    this.pending.set(key, (this.pending.get(key) ?? false) || urgent);
  }

  /** Queue or launch a SET. `urgent` is a chip tap / discrete write. */
  offer(key: number, urgent: boolean, now: number): MailboxOffer {
    const gen = this.open.get(key);
    if (gen && !gen.awaitingLate) {
      if (CameraSetMailbox.pipelinesWhileOpen(key)) return this.offerPipelined(key, urgent, now);
      this.markPending(key, urgent);
      return 'coalescePending';
    }
    const last = this.lastLaunch.get(key);
    const rateLimited = !urgent && !this.open.has(key) && last !== undefined && now - last < CameraSetMailbox.coalesceHoldFor(key);
    if (rateLimited) {
      this.markPending(key, urgent);
      return 'coalescePending';
    }
    this.pending.delete(key);
    return 'launch';
  }

  private offerPipelined(key: number, urgent: boolean, now: number): MailboxOffer {
    const last = this.lastLaunch.get(key);
    const held = !urgent && last !== undefined && now - last < CameraSetMailbox.coalesceHoldFor(key);
    if (held) {
      this.markPending(key, urgent);
      return 'coalescePending';
    }
    this.pending.delete(key);
    return 'launch';
  }

  beginLaunch(key: number, now: number): void {
    if (this.open.has(key)) this.supersedeOpen(key);
    this.pending.delete(key);
    this.lastLaunch.set(key, now);
    this.open.set(key, { seqs: new Set(), awaitingLate: false });
  }

  noteTransmit(key: number, seq: number): void {
    const g = this.open.get(key);
    if (!g) return;
    g.seqs.add(seq);
    this.superseded.get(key)?.delete(seq);
  }

  decideAck(key: number, seq: number): MailboxAck {
    const gen = this.open.get(key);
    if (gen) {
      if (gen.seqs.has(seq)) {
        this.open.delete(key);
        return gen.awaitingLate ? 'acceptLate' : 'accept';
      }
      return this.superseded.get(key)?.has(seq) ? 'dropSuperseded' : 'dropUnknown';
    }
    return this.superseded.get(key)?.has(seq) ? 'dropSuperseded' : 'dropUnknown';
  }

  timeout(key: number, subscribeMatches: boolean): MailboxTimeout {
    const gen = this.open.get(key);
    if (!gen) return 'idle';
    if (subscribeMatches) {
      this.open.delete(key);
      return this.pending.has(key) ? 'launchPending' : 'subscribeMatches';
    }
    if (this.pending.has(key)) {
      this.supersedeOpen(key);
      return 'launchPending';
    }
    gen.awaitingLate = true;
    return 'waitLate';
  }

  pendingLaunch(key: number, now: number): MailboxPendingLaunch {
    const urgent = this.pending.get(key);
    if (urgent === undefined) return 'none';
    if (urgent || this.holdRemaining(key, now) <= 0) {
      this.pending.delete(key);
      return 'immediate';
    }
    return 'afterHold';
  }

  private supersedeOpen(key: number): void {
    const seqs = this.open.get(key)?.seqs;
    if (seqs && seqs.size > 0) {
      let held = new Set(this.superseded.get(key) ?? []);
      for (const s of seqs) held.add(s);
      if (held.size > 64) held = new Set([...held].sort((a, b) => a - b).slice(-32));
      this.superseded.set(key, held);
    }
    this.open.delete(key);
  }
}
