/**
 * Leaving camera playback and bringing live view back (Mimo's "Back to live view"), and what a
 * browse may do when the body refuses playback.
 *
 * Source of truth: OpenCine `OpenCineDJI/MediaLiveResume.swift` (`MediaLiveResume`,
 * `MediaBrowsePolicy`) and `OpenCineDJIApple/DjiAppleMediaLiveReturn.swift` (the loop). The
 * desktop's `opc-media/resume.rs` is the older form without `waitForPicture` / `exhausted`;
 * upstream wins.
 *
 * `0x02/0x0c 01 01 00 00` exits playback. Enable (`0x09/0xa8`) while still in playback ACKs
 * `E0`/`D6` and produces no video, so the loop keeps exiting until the `0x02/0x80` playback bit
 * clears, then enables once, and repeats the enable only after a keyframe interval without a
 * picture (Pocket has no periodic GOP).
 */
import { FeedWatchdog } from '../connection/feedWatchdog';

export const MEDIA_RESUME_MAX_EXIT_ATTEMPTS = 8;
/** Pause after each exit attempt. */
export const MEDIA_RESUME_EXIT_PAUSE_MS = 180;
/** Pause after an enable, and between picture checks. */
export const MEDIA_RESUME_ENABLE_PAUSE_MS = 100;

export type MediaResumeAction = 'exitPlayback' | 'enableLiveView' | 'waitForPicture' | 'done' | 'exhausted';

export interface MediaResumeInput {
  attempt: number;
  inPlayback: boolean;
  exitAcknowledged: boolean;
  pictureFresh: boolean;
  enableSent?: boolean;
  deadlineExpired?: boolean;
  keyframeResendDue?: boolean;
}

export const MediaLiveResume = {
  maxExitAttempts: MEDIA_RESUME_MAX_EXIT_ATTEMPTS,

  /** One tick of the post-media resume loop. An exhausted exit budget never enables. */
  action(i: MediaResumeInput): MediaResumeAction {
    if (i.pictureFresh && !i.inPlayback) return 'done';
    if (i.deadlineExpired) return 'exhausted';
    if (i.inPlayback || !i.exitAcknowledged) return i.attempt > MEDIA_RESUME_MAX_EXIT_ATTEMPTS ? 'exhausted' : 'exitPlayback';
    return i.enableSent && !i.keyframeResendDue ? 'waitForPicture' : 'enableLiveView';
  },

  /** Opening and closing media each retire a live-picture requirement. */
  isCurrentPictureOwner(generation: number, currentGeneration: number, browsing: boolean): boolean {
    return generation === currentGeneration && !browsing;
  },

  /** Keepalive while the operator is already on live view but the camera still says playback. */
  strayPlaybackAction(browsing: boolean, inPlayback: boolean): MediaResumeAction | null {
    return !browsing && inPlayback ? 'exitPlayback' : null;
  },

  /** Leftover GOP packets are not a live picture: only one presented after the resume started. */
  isPictureFresh(lastPresentedAt: number | null | undefined, since: number): boolean {
    return lastPresentedAt != null && lastPresentedAt >= since;
  },
};

/** What to do after `0x02/0x0c` enter-playback. The newest page needs no playback. */
export interface MediaBrowsePolicy {
  listNewestPage: boolean;
  listOlderPages: boolean;
  /** Keep the browse flag so a failed `0x02/0x0c` (Pocket 3 E0 after a take) cannot arm stray exit. */
  keepBrowsing: boolean;
}

export const afterEnterPlayback = (entered: boolean): MediaBrowsePolicy => ({ listNewestPage: true, listOlderPages: entered, keepBrowsing: true });

export type MediaReturnResult = 'restored' | 'exhausted' | 'superseded';

export interface MediaReturnIO {
  /** Milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** False once the session, link or browse that started the return is gone. */
  isCurrent(): boolean;
  inPlayback(): boolean;
  pictureFresh(): boolean;
  /** One `0x02/0x0c` exit; true when the camera acknowledged it. */
  exitPlayback(): Promise<boolean>;
  /** One live start (`0x02/0x68` prepare + `0x09/0xa8`); true when it was written. */
  enableLiveView(): boolean;
}

/**
 * The return loop (`DjiAppleMediaLiveReturn.run`). The picture budget starts with the first
 * live-view request; exiting playback is bounded by the attempt count, so a slow gallery exit
 * does not spend the picture's time.
 */
export async function runMediaLiveReturn(
  io: MediaReturnIO,
  options: { timeoutMs?: number; keyframeResendMs?: number } = {},
): Promise<MediaReturnResult> {
  const timeoutMs = options.timeoutMs ?? FeedWatchdog.decoderRepairDeadline * 1000;
  const resendMs = options.keyframeResendMs ?? FeedWatchdog.keyframeResendInterval * 1000;
  let deadline: number | null = null;
  let lastEnableAt: number | null = null;
  let attempt = 1;
  let exitAcknowledged = false;
  let enableSent = false;
  while (io.isCurrent()) {
    const now = io.now();
    const action = MediaLiveResume.action({
      attempt,
      inPlayback: io.inPlayback(),
      exitAcknowledged,
      pictureFresh: io.pictureFresh(),
      enableSent,
      deadlineExpired: deadline != null && now >= deadline,
      keyframeResendDue: lastEnableAt != null && now - lastEnableAt >= resendMs,
    });
    switch (action) {
      case 'done':
        return 'restored';
      case 'exhausted':
        return 'exhausted';
      case 'exitPlayback': {
        const acknowledged = await io.exitPlayback();
        // An exit completion retired while suspended cannot send an enable.
        if (!io.isCurrent()) return 'superseded';
        exitAcknowledged = acknowledged || exitAcknowledged;
        attempt += 1;
        await io.sleep(MEDIA_RESUME_EXIT_PAUSE_MS);
        break;
      }
      case 'enableLiveView': {
        deadline = deadline ?? now + timeoutMs;
        const accepted = io.enableLiveView();
        enableSent = accepted || enableSent;
        // A refused resend must not delay the next one by another keyframe interval.
        if (accepted) lastEnableAt = now;
        await io.sleep(MEDIA_RESUME_ENABLE_PAUSE_MS);
        break;
      }
      case 'waitForPicture':
        await io.sleep(MEDIA_RESUME_ENABLE_PAUSE_MS);
        break;
    }
  }
  return 'superseded';
}
