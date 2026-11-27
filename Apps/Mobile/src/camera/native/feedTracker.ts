/**
 * Live-feed bookkeeping for one connection: what the core `FeedWatchdog` needs to see
 * (`WatchdogSnapshot`), and the link chip values (fps, kbit/s, frame age, band, bars).
 * Pure: the session feeds it timestamps; nothing here touches I/O.
 *
 * Inputs and their resolution:
 * - DUML status age: exact, every `onDuml` frame.
 * - Video packet age: from 1 Hz `onStats` (`videoPacketsPerSec > 0` ⇒ video within that second).
 *   That is coarser than the native per-packet clock the Swift shells feed the watchdog; the 2 s
 *   stall threshold still holds because a stats tick with zero video ages the clock by ≥ 1 s.
 *   A native `lastVideoAgeMs` in `DatalinkStats` would make this exact (reported as a gap).
 * - Presented frames: only when the picture view reports them (`notePictureStats`); otherwise
 *   decoder ages stay unknown and the watchdog runs on transport ages alone.
 */
import type { DatalinkStats } from '@modules/pocket-native/src/types';
import { type WatchdogSnapshot, watchdogSnapshot } from '@/core/connection/feedWatchdog';
import {
  CameraLinkHealthScorer,
  cameraLinkPhase,
  LIVE_VIEW_TARGET_FPS,
  LinkSignalBars,
  linkBand,
} from '@/core/connection/linkHealth';
import type { CameraConnectionPhase } from '@/core/connection/phase';
import type { LinkHealthBand } from '../types';

export interface PictureStats {
  presentedFps: number;
  lastFrameAgeMs: number;
  width?: number;
  height?: number;
}

export interface LinkChip {
  videoFps: number;
  videoKbps: number;
  lastFrameAgeMs: number;
  linkBand: LinkHealthBand;
  signalBars: number;
}

const sinceS = (now: number, at: number | null) => (at == null ? null : Math.max(0, (now - at) / 1000));

export class FeedTracker {
  enabledAt: number | null = null;
  enableCount = 0;
  lastVideoAt: number | null = null;
  lastStatusAt: number | null = null;
  lastBleNotifyAt: number | null = null;
  lastCameraSetAt: number | null = null;
  lastZoomSetAt: number | null = null;
  lastFocusTrackSetAt: number | null = null;
  lastGimbalThrowAt: number | null = null;
  lastRebuildAt: number | null = null;
  lastStatsAt: number | null = null;
  lastPictureAt: number | null = null;
  videoPackets = 0;
  stickHeld = false;
  zoomHeld = false;
  pathReady = true;
  flowHealthy = false;
  /** Watchdog is held (media browsing, connect in flight, repair running). */
  repairBlocked = false;
  stats: DatalinkStats | null = null;
  picture: PictureStats | null = null;
  private pictureStatsAt: number | null = null;
  private bars = new LinkSignalBars();

  /** New datalink: transport ages from the old 5-tuple must not look like a live one. */
  resetTransport(now: number): void {
    this.lastVideoAt = null;
    this.lastStatusAt = null;
    this.stats = null;
    this.lastStatsAt = null;
    this.lastRebuildAt = now;
    this.flowHealthy = false;
  }

  noteEnable(now: number): void {
    this.enabledAt = now;
    this.enableCount += 1;
  }
  noteStatus(now: number): void {
    this.lastStatusAt = now;
  }
  noteStats(stats: DatalinkStats, now: number): void {
    this.stats = stats;
    this.lastStatsAt = now;
    if (stats.videoPacketsPerSec > 0) {
      this.lastVideoAt = now;
      this.videoPackets += stats.videoPacketsPerSec;
    }
  }
  notePicture(stats: PictureStats, now: number): void {
    this.picture = stats;
    this.pictureStatsAt = now;
    if (stats.presentedFps > 0 || stats.lastFrameAgeMs < 2000) this.lastPictureAt = now - Math.max(0, stats.lastFrameAgeMs);
  }

  get hadVideo(): boolean {
    return this.videoPackets > 0 || this.lastVideoAt != null;
  }

  /** True once live video has been seen since the last enable or rebuild. */
  videoFlowing(now: number): boolean {
    return this.lastVideoAt != null && now - this.lastVideoAt < 2500;
  }

  private pictureFresh(now: number): PictureStats | null {
    return this.picture && this.pictureStatsAt != null && now - this.pictureStatsAt < 3000 ? this.picture : null;
  }

  snapshot(now: number, live: boolean): WatchdogSnapshot {
    const pic = this.pictureFresh(now);
    const decodedAge = pic ? sinceS(now, this.lastPictureAt) : null;
    return watchdogSnapshot({
      now: now / 1000,
      lastDecodedFrameAge: decodedAge,
      lastVideoPacketAge: sinceS(now, this.lastVideoAt),
      lastStatusAge: sinceS(now, this.lastStatusAt),
      flowHealthy: this.flowHealthy,
      pathReady: this.pathReady,
      hasFormat: this.hadVideo,
      decoderFailed: false,
      live,
      sawPicture: this.hadVideo,
      hadVideo: this.hadVideo,
      lastBleNotifyAge: sinceS(now, this.lastBleNotifyAt),
      secondsSinceLastRebuild: sinceS(now, this.lastRebuildAt),
      secondsSinceLastEnable: sinceS(now, this.enabledAt),
      secondsSinceFocusTrackSet: sinceS(now, this.lastFocusTrackSetAt),
      secondsSinceZoomSet: sinceS(now, this.lastZoomSetAt),
      zoomPinchActive: this.zoomHeld,
      secondsSinceGimbalThrow: sinceS(now, this.lastGimbalThrowAt),
      gimbalStickHeld: this.stickHeld,
      secondsSinceCameraSet: sinceS(now, this.lastCameraSetAt),
      repairReady: !this.repairBlocked,
      tcpPokeReady: true,
    });
  }

  /** Link chip values for `ConnectionState`. */
  linkChip(now: number, phase: CameraConnectionPhase, recovering: boolean): LinkChip {
    const pic = this.pictureFresh(now);
    const flowing = this.videoFlowing(now);
    const fps = pic ? Math.round(pic.presentedFps) : 0;
    // Without picture stats the score uses the nominal live-view rate while video packets flow,
    // so bars reflect a working link; the fps chip itself stays at the measured value (0 = "—").
    const scoringFps = pic ? pic.presentedFps : flowing ? LIVE_VIEW_TARGET_FPS : 0;
    const rxAgeMs = this.stats ? this.stats.lastRxAgeMs + (this.lastStatsAt != null ? now - this.lastStatsAt : 0) : 0;
    const frameAgeMs = pic ? pic.lastFrameAgeMs + (this.pictureStatsAt != null ? now - this.pictureStatsAt : 0) : rxAgeMs;
    const health = CameraLinkHealthScorer.score({
      phase: cameraLinkPhase(phase, recovering, scoringFps),
      liveViewFPS: scoringFps,
      targetLiveViewFPS: LIVE_VIEW_TARGET_FPS,
      secondsSinceLastGoodFrame: frameAgeMs / 1000,
      isRecoveringStream: recovering,
    });
    return {
      videoFps: fps,
      videoKbps: this.stats ? Math.round((this.stats.rxBytesPerSec * 8) / 1000) : 0,
      lastFrameAgeMs: Math.round(frameAgeMs),
      linkBand: linkBand(health.linkHealthScore),
      signalBars: this.bars.update(health.linkHealthScore),
    };
  }
}
