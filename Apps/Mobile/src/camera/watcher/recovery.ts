/**
 * Watcher-only recovery, ported from OpenPocketViewCore `WatcherRelayRecovery` and
 * `WatcherRelayFrameFreshness` (docs/watcher-relay.md "Watcher monitor and recovery").
 *
 * Bounded retries with 1/2/4 s backoff, a 15 s join deadline, separate 5 s telemetry and picture
 * silence deadlines once accepted (10 s for the first picture), and only ten seconds of continuing
 * picture delivery resets the retry budget. It never asks the camera for anything: a watcher has no
 * camera session.
 *
 * Times are monotonic seconds supplied by the caller.
 */
export type RecoveryAction = 'none' | 'reconnect' | 'exhausted';

export class WatcherRelayRecovery {
  static readonly maximumRetries = 3;
  static readonly joinTimeout = 15;
  static readonly silenceTimeout = 5;
  static readonly backoff = [1, 2, 4] as const;

  private _retryCount = 0;
  private _retryAt: number | null = null;
  private deadline: number | null;
  private pictureDeadline: number | null = null;
  private lastPicture: number | null = null;
  private stableSince: number | null = null;
  private accepted = false;
  private stopped = false;

  constructor(now: number) {
    this.deadline = now + WatcherRelayRecovery.joinTimeout;
  }

  get retryCount() {
    return this._retryCount;
  }

  get retryAt() {
    return this._retryAt;
  }

  get isStopped() {
    return this.stopped;
  }

  /** The host accepted the join (its hello arrived). */
  connected(now: number) {
    this.accepted = true;
    this.stableSince = null;
    this.lastPicture = null;
    this.pictureDeadline = now + 10;
    this.deadline = now + WatcherRelayRecovery.silenceTimeout;
    this._retryAt = null;
  }

  /** Any message from the host; `picture` when a picture arrived. Telemetry alone cannot hide a stalled picture. */
  received(now: number, picture = false) {
    if (!this.accepted || this.stopped || this._retryAt != null) return;
    this.deadline = now + WatcherRelayRecovery.silenceTimeout;
    if (picture) {
      if (this.lastPicture == null || now - this.lastPicture > 2) this.stableSince = now;
      this.lastPicture = now;
      this.pictureDeadline = now + WatcherRelayRecovery.silenceTimeout;
      if (this.stableSince != null && now - this.stableSince >= 10) this._retryCount = 0;
    }
  }

  /** The connection dropped. Schedules the next retry, or reports the budget spent. */
  disconnected(now: number): RecoveryAction {
    if (this.stopped || this._retryAt != null) return 'none';
    this.accepted = false;
    this.stableSince = null;
    this.lastPicture = null;
    this.pictureDeadline = null;
    this.deadline = null;
    if (this._retryCount >= WatcherRelayRecovery.maximumRetries) {
      this.stopped = true;
      return 'exhausted';
    }
    this._retryAt = now + WatcherRelayRecovery.backoff[this._retryCount];
    this._retryCount += 1;
    return 'none';
  }

  tick(now: number): RecoveryAction {
    if (this.stopped) return 'none';
    if (this._retryAt != null && now >= this._retryAt) {
      this._retryAt = null;
      this.deadline = now + WatcherRelayRecovery.joinTimeout;
      return 'reconnect';
    }
    if (this.pictureDeadline != null && now >= this.pictureDeadline) return this.disconnected(now);
    if (this.deadline != null && now >= this.deadline) return this.disconnected(now);
    return 'none';
  }

  /** Leave, a passcode prompt or a final failure: no more retries. */
  stop() {
    this.stopped = true;
    this.pictureDeadline = null;
    this.deadline = null;
    this._retryAt = null;
  }
}

/** Growth in delivery delay without synchronized clocks. Not an absolute latency meter. */
export class WatcherRelayFrameFreshness {
  static readonly maximumAddedDelay = 0.75;
  private minimumOffset: number | null = null;

  isFallingBehind(encodedAt: number | null | undefined, receivedAt: number): boolean {
    if (encodedAt == null || !Number.isFinite(encodedAt) || !Number.isFinite(receivedAt)) return false;
    const offset = receivedAt - encodedAt;
    this.minimumOffset = Math.min(this.minimumOffset ?? offset, offset);
    return offset - this.minimumOffset > WatcherRelayFrameFreshness.maximumAddedDelay;
  }
}
