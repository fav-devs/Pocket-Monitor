/**
 * Where a marker lands in the file: the take's position by the camera's own recording time.
 *
 * The camera reports the take's elapsed time in whole seconds (`RecordingState.elapsedSec`, the
 * status push's `recordElapsedSec`). Each time that number steps to E, the camera's E-th second
 * has just begun, so `now − E` is when its first frame was, plus however late the report
 * reached the phone. Taking the earliest such estimate keeps the least-delayed report, so the
 * clock settles within one status interval of the camera's and stays there. Between reports the
 * phone's clock carries the fraction of a second, and the position never leaves [E, E + 1) of the
 * last report.
 *
 * A camera that reports no elapsed time (it stays 0) falls back to the phone's clock from when
 * REC was seen, backdated by {@link PHONE_START_OFFSET_SEC}: the time between the camera starting
 * to write and the REC state reaching the phone. Markers then say `timeSource: 'phone'`.
 *
 * Pure: the caller passes the time (ms epoch).
 */

/**
 * How long before the phone sees REC the camera's first frame is (seconds). The REC state
 * rides the 5 Hz status push, so on average it lands ~0.1 s after the camera starts, plus the
 * link. Measured on no device yet: check against a recorded clap on hardware.
 */
export const PHONE_START_OFFSET_SEC = 0.15;

/** Seconds of REC with no elapsed time reported before the phone clock is trusted instead. */
export const ELAPSED_GRACE_SEC = 2.5;

export interface TakePosition {
  /** Seconds since the take's first frame. */
  seconds: number;
  source: 'camera' | 'phone';
}

export class RecordingClock {
  private recording = false;
  /** When this phone saw REC begin. */
  private seenAt: number | null = null;
  /** Best estimate of the camera's first frame from its elapsed reports (ms epoch). */
  private anchor: number | null = null;
  private lastElapsed = -1;

  /** Feed every state update: REC on/off and the camera's elapsed seconds. */
  update(recording: boolean, elapsedSec: number, now: number): void {
    if (!recording) {
      this.recording = false;
      this.seenAt = null;
      this.anchor = null;
      this.lastElapsed = -1;
      return;
    }
    const e = Number.isFinite(elapsedSec) && elapsedSec >= 0 ? Math.floor(elapsedSec) : 0;
    if (!this.recording) {
      this.recording = true;
      this.seenAt = now;
      this.lastElapsed = -1;
    }
    if (e !== this.lastElapsed) {
      // A step (or the first report). A report of 0 says only "started by now".
      if (e > 0 || this.lastElapsed < 0) {
        const candidate = now - e * 1000;
        this.anchor = this.anchor == null ? candidate : Math.min(this.anchor, candidate);
      }
      // A camera that goes backwards started a new take under us.
      if (e < this.lastElapsed) this.anchor = now - e * 1000;
      this.lastElapsed = e;
    }
  }

  get isRecording(): boolean {
    return this.recording;
  }

  /** The camera has reported a running elapsed time (not just 0). */
  private cameraTimed(now: number): boolean {
    if (this.lastElapsed > 0) return true;
    return this.seenAt != null && (now - this.seenAt) / 1000 < ELAPSED_GRACE_SEC && this.anchor != null;
  }

  /** The take's position now, or null when not recording. */
  position(now: number): TakePosition | null {
    if (!this.recording || this.seenAt == null) return null;
    if (this.anchor != null && this.cameraTimed(now)) {
      let s = (now - this.anchor) / 1000;
      if (this.lastElapsed > 0) s = Math.min(Math.max(s, this.lastElapsed), this.lastElapsed + 0.999);
      return { seconds: Math.max(0, s), source: this.lastElapsed > 0 ? 'camera' : 'phone' };
    }
    return { seconds: Math.max(0, (now - this.seenAt) / 1000 + PHONE_START_OFFSET_SEC), source: 'phone' };
  }

  /** When the take's first frame was, by this clock (ms epoch), or null. */
  startedAt(now: number): number | null {
    const p = this.position(now);
    return p ? Math.round(now - p.seconds * 1000) : null;
  }
}
