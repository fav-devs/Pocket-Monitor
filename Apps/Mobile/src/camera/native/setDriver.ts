/**
 * Live-control SETs (`0x02/*` in `isLiveCameraControl`) through the core latest-wins mailbox
 * (`CameraSetMailbox`): one generation on the wire per opcode, sliders coalesce, zoom pipelines,
 * a late ACK is accepted only for the open generation. This class owns the timers and the
 * promises; every decision is the mailbox's.
 */
import { CameraReplies, type CameraReply } from '@/core/commands/control';
import { CameraSetMailbox } from '@/core/commands/setMailbox';
import { type DumlFrame, opcodeKey } from '@/core/duml/frame';
import { type ClockTimer, type SessionClock, systemClock } from './clock';

export type SetResult =
  | { kind: 'ok' }
  | { kind: 'refused'; reply: CameraReply; message: string }
  | { kind: 'timeout' }
  /** A newer value for the same control replaced this one before it was answered. */
  | { kind: 'superseded' }
  /** No open datalink: nothing was sent. */
  | { kind: 'offline' };

type Resolve = (r: SetResult) => void;

/** Replies to a SET wait this long before the mailbox decides. */
export const SET_ACK_TIMEOUT_MS = 1000;

export class LiveSetDriver {
  private mailbox = new CameraSetMailbox();
  private pending = new Map<number, { frame: DumlFrame; waiters: Resolve[] }>();
  private open = new Map<number, { waiters: Resolve[]; timer: ClockTimer | null }>();
  private holdTimers = new Map<number, ClockTimer>();

  /**
   * @param send writes the frame (stamping its DUML seq) and returns the seq, or null when the
   *             datalink is not open.
   */
  constructor(
    private readonly send: (frame: DumlFrame) => number | null,
    private readonly now: () => number,
    /** Timer source (optional, additive): the session's clock; global timers by default. */
    private readonly clock: SessionClock = systemClock,
  ) {}

  private nowS(): number {
    return this.now() / 1000;
  }

  /** Submit a SET. `urgent` = a discrete chip / button (skips the slider coalesce hold). */
  submit(frame: DumlFrame, urgent: boolean): Promise<SetResult> {
    const key = opcodeKey(frame.cmdSet, frame.cmdId);
    return new Promise<SetResult>((resolve) => {
      const offer = this.mailbox.offer(key, urgent, this.nowS());
      if (offer === 'launch') {
        this.launch(key, frame, [resolve]);
        return;
      }
      const previous = this.pending.get(key);
      previous?.waiters.forEach((w) => w({ kind: 'superseded' }));
      this.pending.set(key, { frame, waiters: [resolve] });
      if (!this.mailbox.hasOpen(key)) this.scheduleHold(key);
    });
  }

  /** Offer an inbound reply. True when it settled one of our SETs. */
  reply(frame: DumlFrame): boolean {
    const key = opcodeKey(frame.cmdSet, frame.cmdId);
    if (!this.open.has(key) && !this.mailbox.hasOpen(key)) return false;
    const decision = this.mailbox.decideAck(key, frame.seq);
    if (decision !== 'accept' && decision !== 'acceptLate') return false;
    const gen = this.open.get(key);
    this.open.delete(key);
    if (gen?.timer) this.clock.clearTimeout(gen.timer);
    const parsed = CameraReplies.parse(frame.payload);
    const result: SetResult = CameraReplies.isSuccess(parsed)
      ? { kind: 'ok' }
      : { kind: 'refused', reply: parsed, message: CameraReplies.message(parsed) };
    gen?.waiters.forEach((w) => w(result));
    this.pump(key);
    return true;
  }

  /** Drop everything (disconnect / new datalink). Outstanding promises settle as offline. */
  reset(): void {
    for (const g of this.open.values()) {
      if (g.timer) this.clock.clearTimeout(g.timer);
      g.waiters.forEach((w) => w({ kind: 'offline' }));
    }
    for (const p of this.pending.values()) p.waiters.forEach((w) => w({ kind: 'offline' }));
    for (const t of this.holdTimers.values()) this.clock.clearTimeout(t);
    this.open.clear();
    this.pending.clear();
    this.holdTimers.clear();
    this.mailbox.reset();
  }

  private launch(key: number, frame: DumlFrame, waiters: Resolve[]): void {
    const superseded = this.open.get(key);
    if (superseded) {
      if (superseded.timer) this.clock.clearTimeout(superseded.timer);
      superseded.waiters.forEach((w) => w({ kind: 'superseded' }));
      this.open.delete(key);
    }
    this.mailbox.beginLaunch(key, this.nowS());
    const seq = this.send(frame);
    if (seq == null) {
      this.mailbox.cancel(key);
      waiters.forEach((w) => w({ kind: 'offline' }));
      return;
    }
    this.mailbox.noteTransmit(key, seq);
    const timer = this.clock.setTimeout(() => this.timeout(key), SET_ACK_TIMEOUT_MS);
    this.open.set(key, { waiters, timer });
  }

  private timeout(key: number): void {
    const gen = this.open.get(key);
    if (gen) gen.timer = null;
    const result = this.mailbox.timeout(key, false);
    // `waitLate`: the generation stays open so a late ACK still lands, but the caller is told now.
    gen?.waiters.forEach((w) => w({ kind: 'timeout' }));
    if (gen) gen.waiters = [];
    if (result === 'launchPending' || result === 'subscribeMatches') this.open.delete(key);
    this.pump(key);
  }

  private scheduleHold(key: number): void {
    if (this.holdTimers.has(key)) return;
    const wait = Math.max(0, this.mailbox.holdRemaining(key, this.nowS()) * 1000);
    this.holdTimers.set(
      key,
      this.clock.setTimeout(() => {
        this.holdTimers.delete(key);
        this.pump(key);
      }, wait),
    );
  }

  private pump(key: number): void {
    const p = this.pending.get(key);
    if (!p) return;
    if (this.mailbox.hasOpen(key) && !this.mailbox.isAwaitingLate(key)) return;
    const decision = this.mailbox.pendingLaunch(key, this.nowS());
    if (decision === 'immediate') {
      this.pending.delete(key);
      this.launch(key, p.frame, p.waiters);
    } else if (decision === 'afterHold') {
      this.scheduleHold(key);
    } else {
      // The mailbox forgot it (e.g. coalesced into a launch elsewhere): launch now.
      this.pending.delete(key);
      this.launch(key, p.frame, p.waiters);
    }
  }
}
