/**
 * Camera SoftAP facts and the datalink session policies (first picture ladder, handshake
 * timeouts, keepalive / command-timeout UDP rebuild rules, enable-once).
 *
 * Source of truth: OpenCine `OpenCineCameraVocabulary/CameraSoftAP.swift` (`CameraSoftAP`,
 * `CameraSoftAPSwitch`). Read docs/live-session.md before changing any rule here.
 *
 * NATIVE: these rules gate the native datalink's socket lifecycle. The native module should call
 * the same decisions (ported verbatim) on its UDP queue; JS uses them for orchestration/tests.
 */
import { FeedWatchdog, FIRST_PICTURE_IDR_GRACE } from './feedWatchdog';

type Age = number | null;

export interface InterfaceAddress {
  name: string;
  ipv4: string;
}

export type DatalinkFlowHealth = 'ready' | 'writeRejected' | 'notReady' | 'cancelled' | 'pathLost';
export type FirstPictureStep = 'wait' | 'resendEnable' | 'pokeRecordingFormat' | 'rebuildUDP' | 'rejoin';
export type HandshakeTimeoutStep = 'keepSocket' | 'rebindUDP' | 'fail';

export const CameraSoftAP = {
  host: '192.168.2.1',
  remotePort: 9004,
  rebuildCooldown: 5,
  commandTimeoutWindow: 5,
  commandTimeoutRebuildCount: 2,
  firstPictureIDRGrace: FIRST_PICTURE_IDR_GRACE,
  firstPictureResendWhileLive: 5,
  firstPictureFormatPokeMinSettle: 0.8,
  firstPictureFormatPokePinWait: 2,
  handshakeSendsPerBind: 20,
  handshakeSendIntervalMilliseconds: 350,
  handshakePollMilliseconds: 20,
  handshakeSettleMilliseconds: 400,
  handshakeRebindLimit: 3,
  handshakeRetryPauseMilliseconds: 500,
  handshakeOpenRetryLimit: 6,

  /** 192.168.2.2…254 — the DHCP lease the camera SoftAP hands out. */
  isAssociatedIPv4(ip: string): boolean {
    const p = ip.split('.');
    if (p.length !== 4 || p[0] !== '192' || p[1] !== '168' || p[2] !== '2' || !/^[+-]?\d+$/.test(p[3])) return false;
    const h = parseInt(p[3], 10);
    return h >= 2 && h <= 254;
  },
  isPathReady(localIPv4s: string[]): boolean {
    return localIPv4s.some((ip) => CameraSoftAP.isAssociatedIPv4(ip));
  },
  isOsmoSoftAPSSID(ssid: string): boolean {
    const n = ssid.toLowerCase().replace(/ /g, '');
    return ['osmo', 'dji', 'pocket', 'nano', 'atto'].some((t) => n.includes(t));
  },
  cameraAddresses(addrs: InterfaceAddress[]): InterfaceAddress[] {
    return addrs.filter((a) => CameraSoftAP.isAssociatedIPv4(a.ipv4));
  },
  cameraLocalIPv4(addrs: InterfaceAddress[]): string | null {
    return CameraSoftAP.cameraAddresses(addrs)[0]?.ipv4 ?? null;
  },
  describe(addrs: InterfaceAddress[]): string {
    return addrs
      .filter((a) => a.name !== 'lo0')
      .map((a) => `${a.name}:${a.ipv4}`)
      .join(',');
  },
  isPersonalHotspotHosting(addrs: InterfaceAddress[]): boolean {
    return addrs.some((a) => a.name.startsWith('bridge') || a.ipv4 === '172.20.10.1');
  },
  shouldRebuildFlow: (h: DatalinkFlowHealth) => h !== 'ready',

  shouldRecoverAfterForeground(secondsSinceLastPresented: Age, videoFresh = false, statusFresh = false, stall = 2): boolean {
    if (videoFresh || statusFresh) return false;
    return secondsSinceLastPresented == null ? true : secondsSinceLastPresented >= stall;
  },
  shouldEscalateForegroundRecover(secondsSinceLastPresented: Age, videoFresh = false, statusFresh = false, grace = FIRST_PICTURE_IDR_GRACE): boolean {
    if (videoFresh || statusFresh) return false;
    return secondsSinceLastPresented == null ? true : secondsSinceLastPresented >= grace;
  },
  shouldKeepaliveRebuildUDP(o: {
    flowNeedsRebuild: boolean;
    rebuildInFlight: boolean;
    secondsSinceLastRebuild: Age;
    videoFresh?: boolean;
    sawPicture?: boolean;
    statusFresh?: boolean;
    secondsSinceLastEnable?: Age;
    pathReady?: boolean;
  }): boolean {
    if (!(o.sawPicture ?? true)) return false;
    if (!(o.pathReady ?? true)) return false;
    if (!o.flowNeedsRebuild || o.rebuildInFlight || (o.videoFresh ?? false)) return false;
    if (o.statusFresh ?? false) return false;
    if (FeedWatchdog.shouldHoldForGOPReset(o.secondsSinceLastEnable ?? null, null)) return false;
    if (o.secondsSinceLastRebuild != null && o.secondsSinceLastRebuild < 5) return false;
    return true;
  },
  shouldRebuildAfterCommandTimeouts(o: {
    timeoutsInWindow: number;
    downlinkFresh: boolean;
    videoFresh: boolean;
    rebuildInFlight: boolean;
    secondsSinceLastRebuild: Age;
    statusFresh?: boolean;
  }): boolean {
    if (o.videoFresh || (o.statusFresh ?? false)) return false;
    if (o.timeoutsInWindow < 2 || !o.downlinkFresh || o.rebuildInFlight) return false;
    if (o.secondsSinceLastRebuild != null && o.secondsSinceLastRebuild < 5) return false;
    return true;
  },
  isCanceledReceive(message: string): boolean {
    const m = message.toLowerCase();
    return message.includes('error 89') || m.includes('canceled') || m.includes('cancelled');
  },
  shouldCountReceiveError: (isLive: boolean, canceled: boolean) => isLive && !canceled,
  shouldRearmAfterError: (isLive: boolean) => isLive,
  canSendHandshake: (receiveArmed: boolean, connectionReady: boolean) => receiveArmed && connectionReady,

  /** Pocket 3 first-picture ladder (see docs/live-session.md "Pocket 3 first picture"). */
  firstPictureStep(o: {
    videoPackets: number;
    enableSends: number;
    secondsSinceLastEnable: number;
    secondsSinceLastVideo?: Age;
    secondsSinceLastRebuild?: Age;
    needsRecordingFormatPoke?: boolean;
    alreadyPokedRecordingFormat?: boolean;
    recordingFormatPokeInFlight?: boolean;
    isRecording?: boolean;
    hasPresentedPicture?: boolean;
  }): FirstPictureStep {
    const lastVideo = o.secondsSinceLastVideo ?? null;
    const lastRebuild = o.secondsSinceLastRebuild ?? null;
    if (o.hasPresentedPicture) return 'wait';
    if (o.enableSends < 1) return 'resendEnable';
    if (o.recordingFormatPokeInFlight) return 'wait';
    if (o.secondsSinceLastEnable < 2) return 'wait';
    const hadVideo = FeedWatchdog.hadVideo(o.videoPackets, lastVideo);
    if (
      CameraSoftAP.shouldPokeRecordingFormat({
        needsPoke: o.needsRecordingFormatPoke ?? false,
        alreadyPoked: o.alreadyPokedRecordingFormat ?? false,
        isRecording: o.isRecording ?? false,
        hadVideo,
        enableSends: o.enableSends,
        secondsSinceLastEnable: o.secondsSinceLastEnable,
      })
    )
      return 'pokeRecordingFormat';
    const videoFresh = hadVideo && (lastVideo ?? Infinity) < 2;
    if (!hadVideo) {
      if (o.secondsSinceLastEnable < FIRST_PICTURE_IDR_GRACE) return 'wait';
      if (o.enableSends >= 4) return 'rejoin';
      if (o.enableSends >= 2) {
        if (lastRebuild != null && lastRebuild < 5) return 'wait';
        return 'rebuildUDP';
      }
      return 'resendEnable';
    }
    if (o.secondsSinceLastEnable < FIRST_PICTURE_IDR_GRACE) {
      if (videoFresh && o.enableSends === 1 && o.secondsSinceLastEnable >= 5) return 'resendEnable';
      return 'wait';
    }
    if (videoFresh) {
      if (o.enableSends === 1) return 'resendEnable';
      if (o.secondsSinceLastEnable >= FeedWatchdog.decoderRepairDeadline) return 'rejoin';
      return 'wait';
    }
    if (lastRebuild != null && lastRebuild < 5) return 'wait';
    if (o.enableSends >= 4) return 'rejoin';
    if (lastRebuild != null) return 'rejoin';
    return 'rebuildUDP';
  },
  shouldPokeRecordingFormat(o: {
    needsPoke: boolean;
    alreadyPoked: boolean;
    isRecording: boolean;
    hadVideo: boolean;
    enableSends: number;
    secondsSinceLastEnable: number;
  }): boolean {
    if (!o.needsPoke || o.alreadyPoked || o.isRecording || o.enableSends < 1) return false;
    if (o.secondsSinceLastEnable < 2) return false;
    if (!o.hadVideo) return true;
    return o.secondsSinceLastEnable >= 5;
  },
  shouldDeferRecordingFormatPoke: (hasKnownRecordingFormat: boolean, secondsSinceLastEnable: number) =>
    !hasKnownRecordingFormat && secondsSinceLastEnable < FIRST_PICTURE_IDR_GRACE,
  shouldForceEnableAfterUDPRebuild: (hadVideo: boolean) => !hadVideo,
  shouldRearmLiveIngestAfterUDPRebuild: (wasAccepting: boolean) => wasAccepting,
  /** Tracked SETs skip a not-ready socket without burning seq; untracked writes still stamp. */
  shouldStampCommandSeq(hasConnection: boolean, connectionReady: boolean, trackCommand: boolean): boolean {
    if (!hasConnection) return false;
    return trackCommand ? connectionReady : true;
  },
  shouldIngestLiveVideo: (ingestArmed: boolean) => ingestArmed,
  shouldBeginIDRHoldOnEnable: (hasPresentedPicture: boolean) => !hasPresentedPicture,
  /** Enable-once: `0x09/0xa8` at connect only when the path is ready and it has not been sent. */
  shouldSendLiveViewEnable: (pathReady: boolean, alreadySent: boolean) => pathReady && !alreadySent,
  shouldSendLiveViewEnableAfterHandshake: (alreadySent: boolean) => !alreadySent,
  shouldSendLiveViewPrepare: (usesNanoLiveViewGate: boolean) => !usesNanoLiveViewGate,
  shouldExitPlaybackBeforeLiveEnable: (inPlayback: boolean) => inPlayback,
  shouldContinueFirstPictureAfterStrayPlayback: (hasPicture: boolean) => !hasPicture,
  isPresentedPictureFresh(secondsSinceLastPresented: Age, stall = 2): boolean {
    return secondsSinceLastPresented != null && secondsSinceLastPresented >= 0 && secondsSinceLastPresented < stall;
  },
  shouldRunFirstPictureRecover(secondsSinceLastPresented: Age, alreadySettled: boolean): boolean {
    if (alreadySettled) return false;
    return !CameraSoftAP.isPresentedPictureFresh(secondsSinceLastPresented);
  },
  shouldMarkFirstPictureSettled: (secondsSinceLastPresented: Age) => CameraSoftAP.isPresentedPictureFresh(secondsSinceLastPresented),
  shouldGiveUpOpenRetry: (attempts: number) => attempts >= 6,
  handshakeTimeoutStep(pathReady: boolean, rebindsUsed: number, inboundDatagrams = 0, rebindLimit = 3, sendRoundsUsed = 0): HandshakeTimeoutStep {
    if (!pathReady || sendRoundsUsed >= rebindLimit + 1) return 'fail';
    if (inboundDatagrams > 0) return 'keepSocket';
    if (rebindsUsed < rebindLimit) return 'rebindUDP';
    return 'fail';
  },
  shouldKickAfterHandshakeTimeout: (pathReady: boolean) => !pathReady,
  shouldReuseDatalink: (isClosed: boolean) => !isClosed,
  /** A cancelled `open()` must not publish LIVE. */
  shouldCommitLiveHandshake: (driverOwned: boolean, isClosed: boolean, isCancelled: boolean) => driverOwned && !isClosed && !isCancelled,
};

export const CameraSoftAPSwitch = {
  joinDeadlineSeconds: 90,
  joinRetryPauseSeconds: 10,
  frequencyHint:
    'On 5.8 GHz the camera Wi-Fi can take about a minute to appear. Try again, or set the camera to 2.4 GHz (Settings, Wireless, Frequency) for a faster join.',
  shouldRetryJoin: (secondsLeft: number) => secondsLeft > 10,
  retryDropsConfiguration: (applyAnswered: boolean) => applyAnswered,
  isAlreadyJoined: (currentSSID: string | null, target: string, pathReady: boolean) => pathReady && currentSSID === target && target !== '',
  isOnTarget(currentSSID: string | null, target: string): boolean {
    if (!currentSSID) return true;
    return currentSSID === target;
  },
  isCameraNetwork: (ssid: string, known: string[] = []) => ssid.toLowerCase().startsWith('osmo') || known.includes(ssid),
  ssidToKick(currentSSID: string | null, target: string, known: string[] = []): string | null {
    if (!currentSSID || currentSSID === target || !CameraSoftAPSwitch.isCameraNetwork(currentSSID, known)) return null;
    return currentSSID;
  },
};
