/**
 * Feed watchdog: the bounded live-picture repair ladder (enable → VT/decoder rebuild →
 * reopen datalink → full rejoin → cooldown) and the grace windows that hold it.
 *
 * Source of truth: OpenCine `OpenCineCameraVocabulary/FeedWatchdog.swift` (see docs/feed-watchdog.md).
 *
 * NATIVE: the watchdog ticks ~1 Hz from a snapshot of native ingest/decoder ages. It may run in JS
 * (snapshot pulled from the native module) or be ported natively; the policy must stay identical.
 * `0x09/0xa8` repeats after first picture belong ONLY to this ladder.
 */

export const FOCUS_TRACK_VIDEO_GRACE = 4;
export const ZOOM_VIDEO_GRACE = 4;
export const GIMBAL_VIDEO_GRACE = 3;
/** `CameraSoftAP.firstPictureIDRGrace` */
export const FIRST_PICTURE_IDR_GRACE = 8;

export type WatchdogStage = 'idle' | 'resendEnable' | 'rebuildVT' | 'reopenDatalink' | 'fullRejoin' | 'cooldown';
export type WatchdogHold =
  | 'fired'
  | 'notLive'
  | 'pathNotReady'
  | 'repairNotReady'
  | 'repairDeadline'
  | 'rejoinCooldown'
  | 'gopReset'
  | 'controlGrace'
  | 'receiveAlive'
  | 'outputNotExpected'
  | 'accessUnitStale'
  | 'firstVideoWait'
  | 'rungWait'
  | 'rebuildBackoff'
  | 'cooldown';
export type WatchdogAction = 'none' | 'resendLiveViewEnable' | 'rebuildVTSession' | 'reopenDatalink' | 'fullSessionRejoin';

type Age = number | null;

export interface WatchdogSnapshot {
  now: number;
  lastDecodedFrameAge: Age;
  lastVideoPacketAge: Age;
  lastAccessUnitAge: Age;
  lastStatusAge: Age;
  flowHealthy: boolean;
  pathReady: boolean;
  hasFormat: boolean;
  decoderFailed: boolean;
  lastDecoderOutputAge: Age;
  decoderOutputExpected: boolean;
  referenceRecoveryNeeded: boolean;
  secondsSinceLastIrap: Age;
  repairReady: boolean;
  live: boolean;
  sawPicture: boolean;
  tcpPokeReady: boolean;
  displayedImageRemoved: boolean;
  lastBleNotifyAge: Age;
  secondsSinceLastRebuild: Age;
  hadVideo: boolean;
  secondsSinceLastEnable: Age;
  secondsSinceFocusTrackSet: Age;
  secondsSinceZoomSet: Age;
  zoomPinchActive: boolean;
  secondsSinceGimbalThrow: Age;
  gimbalStickHeld: boolean;
  secondsSinceCameraSet: Age;
}

/** Defaults match the Swift `Snapshot.init` defaults. */
export function watchdogSnapshot(
  s: Pick<WatchdogSnapshot, 'now' | 'lastDecodedFrameAge' | 'lastVideoPacketAge' | 'lastStatusAge' | 'flowHealthy' | 'pathReady' | 'hasFormat' | 'decoderFailed' | 'live' | 'sawPicture'> &
    Partial<WatchdogSnapshot>,
): WatchdogSnapshot {
  return {
    lastAccessUnitAge: null,
    tcpPokeReady: false,
    displayedImageRemoved: false,
    lastBleNotifyAge: null,
    secondsSinceLastRebuild: null,
    hadVideo: true,
    secondsSinceLastEnable: null,
    secondsSinceFocusTrackSet: null,
    secondsSinceZoomSet: null,
    zoomPinchActive: false,
    secondsSinceGimbalThrow: null,
    gimbalStickHeld: false,
    secondsSinceCameraSet: null,
    lastDecoderOutputAge: null,
    decoderOutputExpected: false,
    referenceRecoveryNeeded: false,
    secondsSinceLastIrap: null,
    repairReady: true,
    ...s,
  };
}

const graceHold = (grace: number) => (since: Age, video: Age, stall = 2) => {
  if (since == null || since < 0 || since >= grace) return false;
  if (video != null && video >= stall + grace) return false;
  return true;
};

export class FeedWatchdog {
  static readonly stallThreshold = 2;
  static readonly escalateAfter = 5;
  static readonly cooldownDuration = 15;
  static readonly decoderRepairDeadline = 16;
  static readonly enableAnswerWindow = 1.5;
  static readonly keyframeResendInterval = 2;
  static readonly keyframeRequestLimit = 2;
  static readonly rebuildBackoff = 60;
  static readonly cameraSetGrace = 4;
  static readonly analogLiftStale = 1.6;
  static readonly maxHeldRepairCycles = 3;

  stage: WatchdogStage = 'idle';
  private _lastActionAt = 0;
  private _lastHold: WatchdogHold | null = null;
  private encoderPauseEnableSent = false;

  get lastActionAt(): number {
    return this._lastActionAt;
  }
  get lastHold(): WatchdogHold | null {
    return this._lastHold;
  }
  get isRecovering(): boolean {
    return this.stage !== 'idle' && this.stage !== 'cooldown';
  }

  static udpReceiveAlive(s: WatchdogSnapshot): boolean {
    if (s.lastVideoPacketAge != null && s.lastVideoPacketAge < 2) return true;
    if (s.lastAccessUnitAge != null && s.lastAccessUnitAge < 2) return true;
    return false;
  }
  static controlReceiveAlive(s: WatchdogSnapshot): boolean {
    return s.lastStatusAge != null && s.lastStatusAge < 2;
  }
  static shouldHoldBind(pathReady: boolean, lastBleNotifyAge: Age): boolean {
    return pathReady && (lastBleNotifyAge ?? Infinity) < 2;
  }
  static hadVideo(videoPackets: number, lastVideoPacketAge: Age): boolean {
    return videoPackets > 0 || lastVideoPacketAge != null;
  }
  static enableRestartedVideo(secondsSinceLastEnable: Age, lastVideoPacketAge: Age): boolean {
    if (secondsSinceLastEnable == null || lastVideoPacketAge == null) return false;
    return lastVideoPacketAge + 0.05 < secondsSinceLastEnable;
  }
  static irapAnsweredLastEnable(s: WatchdogSnapshot): boolean {
    if (s.secondsSinceLastIrap == null || s.secondsSinceLastEnable == null) return false;
    return s.secondsSinceLastIrap < s.secondsSinceLastEnable;
  }
  static shouldHoldForGOPReset(secondsSinceLastEnable: Age, lastVideoPacketAge: Age = null): boolean {
    if (secondsSinceLastEnable == null || secondsSinceLastEnable >= FIRST_PICTURE_IDR_GRACE) return false;
    if (lastVideoPacketAge != null && lastVideoPacketAge > secondsSinceLastEnable + 2) return false;
    return true;
  }
  static shouldHoldForCameraSet(secondsSinceSet: Age, lastVideoPacketAge: Age = null): boolean {
    return graceHold(FeedWatchdog.cameraSetGrace)(secondsSinceSet, lastVideoPacketAge);
  }
  static shouldRequestKeyFrameForDecoderStart(startingHardwareDecoder: boolean, hasFormat: boolean, hasPicture: boolean): boolean {
    return startingHardwareDecoder && hasFormat && hasPicture;
  }
  static shouldSendEnableForAssistVTStart(secondsSinceLastEnable: number, hasPresentedPicture: boolean, liveViewEnableSends: number): boolean {
    if (secondsSinceLastEnable >= 1) return true;
    return hasPresentedPicture && liveViewEnableSends <= 1;
  }
  static shouldTreatLiveVideoAsStale(lastVideoPacketAge: Age, hadVideo: boolean, recovering = false): boolean {
    if (recovering) return true;
    if (lastVideoPacketAge == null) return hadVideo;
    return lastVideoPacketAge >= FeedWatchdog.analogLiftStale;
  }
  static shouldReleaseIDRHold(awaitingIDR: boolean, udpReceiveAlive: boolean, secondsSinceLastEnable: Age, hasPresentedPicture: boolean): boolean {
    if (!awaitingIDR || !udpReceiveAlive || !hasPresentedPicture || secondsSinceLastEnable == null) return false;
    return secondsSinceLastEnable >= FIRST_PICTURE_IDR_GRACE;
  }
  static shouldRepeatRecoverEnable(secondsSinceLastEnable: number, hadVideo = true): boolean {
    if (hadVideo) return false;
    return secondsSinceLastEnable >= 2;
  }
  static decoderRepairStep(
    secondsSinceRepairStart: number,
    secondsSinceLastEnable: number,
    secondsSinceLastIrap: Age,
    keyframeRequests: number,
  ): 'wait' | 'resendKeyframe' | 'rebuildEndpoint' | 'deadline' {
    if (secondsSinceRepairStart >= FeedWatchdog.decoderRepairDeadline) return 'deadline';
    const answered = secondsSinceLastIrap != null && secondsSinceLastIrap < secondsSinceLastEnable;
    if (answered || secondsSinceLastEnable < FeedWatchdog.keyframeResendInterval) return 'wait';
    return keyframeRequests < FeedWatchdog.keyframeRequestLimit ? 'resendKeyframe' : 'rebuildEndpoint';
  }
  static shouldHoldSessionRecovery(lastVideoPacketAge: Age): boolean {
    return (lastVideoPacketAge ?? Infinity) < 2;
  }
  static nextSessionHoldCycles(lastVideoPacketAge: Age, previousCycles: number, pictureSinceLastCycle: boolean): number {
    const cycles = (pictureSinceLastCycle ? 0 : Math.max(0, previousCycles)) + 1;
    if (!FeedWatchdog.shouldHoldSessionRecovery(lastVideoPacketAge) || cycles >= FeedWatchdog.maxHeldRepairCycles) return 0;
    return cycles;
  }
  static shouldPresentSample(hasPicture: boolean, awaitingIDR: boolean, isIDR: boolean): boolean {
    if (!hasPicture) return false;
    return awaitingIDR ? isIDR : true;
  }

  private static shouldHoldForControlGrace(s: WatchdogSnapshot, stalled: Age): boolean {
    const ownEnable =
      s.secondsSinceCameraSet != null && s.secondsSinceLastEnable != null && Math.abs(s.secondsSinceLastEnable - s.secondsSinceCameraSet) < 0.25;
    return (
      (!ownEnable && FeedWatchdog.shouldHoldForCameraSet(s.secondsSinceCameraSet, stalled)) ||
      graceHold(FOCUS_TRACK_VIDEO_GRACE)(s.secondsSinceFocusTrackSet, stalled) ||
      s.zoomPinchActive ||
      graceHold(ZOOM_VIDEO_GRACE)(s.secondsSinceZoomSet, stalled) ||
      s.gimbalStickHeld ||
      graceHold(GIMBAL_VIDEO_GRACE)(s.secondsSinceGimbalThrow, stalled)
    );
  }

  tick(s: WatchdogSnapshot): WatchdogAction {
    if (!s.live) {
      this.resetIdle();
      return this.hold('notLive');
    }
    if (!s.pathReady) return this.hold('pathNotReady');
    if (!s.repairReady) return this.hold('repairNotReady');

    const outputAge = s.lastDecoderOutputAge ?? s.lastDecodedFrameAge;
    const decoderSilent = s.decoderOutputExpected && s.sawPicture && (outputAge ?? 0) >= 2;
    const knownReferenceLoss = s.decoderOutputExpected && s.sawPicture && s.referenceRecoveryNeeded;
    const decoderNeedsRepair = decoderSilent || knownReferenceLoss;
    const assemblyStalled =
      s.sawPicture &&
      FeedWatchdog.udpReceiveAlive(s) &&
      s.lastAccessUnitAge != null &&
      s.lastAccessUnitAge >= 2 &&
      (s.lastDecodedFrameAge ?? 0) >= 2 &&
      (!s.decoderOutputExpected || decoderSilent);
    const outputAfterAction = outputAge != null ? s.now - outputAge > this._lastActionAt : false;
    if (this.stage === 'rebuildVT' && (decoderNeedsRepair || !outputAfterAction)) {
      if (s.now - this._lastActionAt < FeedWatchdog.decoderRepairDeadline) return this.hold('repairDeadline');
      return this.fire('fullSessionRejoin', s.now);
    }

    if (FeedWatchdog.udpReceiveAlive(s) && !assemblyStalled) {
      if (decoderNeedsRepair && (s.lastAccessUnitAge ?? Infinity) < 2) {
        if ((this.stage === 'fullRejoin' || this.stage === 'cooldown') && s.now - this._lastActionAt < FeedWatchdog.cooldownDuration) {
          return this.hold('rejoinCooldown');
        }
        if (!FeedWatchdog.irapAnsweredLastEnable(s) && FeedWatchdog.shouldHoldForGOPReset(s.secondsSinceLastEnable, s.lastVideoPacketAge)) {
          return this.hold('gopReset');
        }
        if (FeedWatchdog.shouldHoldForControlGrace(s, s.lastDecoderOutputAge ?? s.lastDecodedFrameAge)) return this.hold('controlGrace');
        return this.fire('rebuildVTSession', s.now);
      }
      this.resetIdle();
      const faultVisible = s.referenceRecoveryNeeded || s.decoderFailed;
      const repairable = s.decoderOutputExpected && s.sawPicture;
      if (decoderNeedsRepair) return this.hold('accessUnitStale');
      return this.hold(faultVisible && !repairable ? 'outputNotExpected' : 'receiveAlive');
    }

    const enableHadTime = (s.secondsSinceLastEnable ?? 0) >= 2;
    if (FeedWatchdog.shouldHoldForGOPReset(s.secondsSinceLastEnable, assemblyStalled && enableHadTime ? s.lastAccessUnitAge : s.lastVideoPacketAge)) {
      return this.hold('gopReset');
    }
    if (FeedWatchdog.shouldHoldForControlGrace(s, assemblyStalled ? s.lastAccessUnitAge : s.lastVideoPacketAge)) return this.hold('controlGrace');

    if (!s.hadVideo) {
      if (this.stage !== 'idle' && s.now - this._lastActionAt < FeedWatchdog.escalateAfter) return this.hold('firstVideoWait');
      switch (this.stage) {
        case 'idle':
          return this.fire('resendLiveViewEnable', s.now);
        case 'resendEnable':
          return this.fire('reopenDatalink', s.now);
        case 'cooldown':
          return this.hold('cooldown');
        default:
          this.stage = 'cooldown';
          this._lastActionAt = s.now;
          return this.hold('cooldown');
      }
    }

    if (this.stage === 'fullRejoin') {
      this.stage = 'cooldown';
      this._lastActionAt = s.now;
      return this.hold('cooldown');
    }
    const rungWait = this.stage === 'resendEnable' ? FeedWatchdog.enableAnswerWindow : FeedWatchdog.escalateAfter;
    if (this.stage !== 'idle' && s.now - this._lastActionAt < rungWait) return this.hold('rungWait');
    switch (this.stage) {
      case 'idle':
      case 'resendEnable':
      case 'rebuildVT':
        if ((FeedWatchdog.controlReceiveAlive(s) || assemblyStalled) && !this.encoderPauseEnableSent) {
          this.encoderPauseEnableSent = true;
          return this.fire('resendLiveViewEnable', s.now);
        }
        if (s.secondsSinceLastRebuild != null && s.secondsSinceLastRebuild < FeedWatchdog.rebuildBackoff) {
          if (s.secondsSinceLastRebuild < FeedWatchdog.escalateAfter) return this.hold('rebuildBackoff');
          return this.fire('fullSessionRejoin', s.now);
        }
        return this.fire('reopenDatalink', s.now);
      case 'reopenDatalink':
        return this.fire('fullSessionRejoin', s.now);
      default:
        if (s.now - this._lastActionAt >= FeedWatchdog.cooldownDuration) return this.fire('reopenDatalink', s.now);
        return this.hold('cooldown');
    }
  }

  stallLogLine(s: WatchdogSnapshot): string {
    const age = (v: Age) => (v == null ? 'none' : v.toFixed(1));
    const prefix = s.displayedImageRemoved ? 'feed: black' : 'feed: stall';
    return (
      `${prefix} lastFrame=${age(s.lastDecodedFrameAge)}s lastVideo=${age(s.lastVideoPacketAge)}s lastAU=${age(s.lastAccessUnitAge)}s ` +
      `lastStatus=${age(s.lastStatusAge)}s lastBle=${age(s.lastBleNotifyAge)}s flow=${s.flowHealthy ? 'ready' : 'dead'} ` +
      `tcp=${s.tcpPokeReady ? 1 : 0} path=${s.pathReady ? 1 : 0} format=${s.hasFormat ? 1 : 0} stage=${this.stage} recoverBlack=${s.displayedImageRemoved ? 1 : 0}`
    );
  }

  private fire(action: WatchdogAction, now: number): WatchdogAction {
    switch (action) {
      case 'resendLiveViewEnable':
        this.stage = 'resendEnable';
        break;
      case 'rebuildVTSession':
        this.stage = 'rebuildVT';
        break;
      case 'reopenDatalink':
        this.stage = 'reopenDatalink';
        break;
      case 'fullSessionRejoin':
        this.stage = 'fullRejoin';
        break;
    }
    this._lastActionAt = now;
    this._lastHold = 'fired';
    return action;
  }
  private hold(reason: WatchdogHold): WatchdogAction {
    this._lastHold = reason;
    return 'none';
  }
  private resetIdle(): void {
    this.stage = 'idle';
    this._lastActionAt = 0;
    this.encoderPauseEnableSent = false;
  }
}
