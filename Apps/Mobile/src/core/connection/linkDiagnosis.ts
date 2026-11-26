/**
 * Link failure diagnosis (observe-only cross-check of the watchdog).
 * Source of truth: OpenCine `OpenCineDJI/LinkDiagnosis.swift` (same as fork).
 */
import { CamFov } from '../commands/camFov';
import { GimbalStick } from '../gimbal/stick';
import { FeedWatchdog, FOCUS_TRACK_VIDEO_GRACE, type WatchdogAction, type WatchdogSnapshot } from './feedWatchdog';

export type LinkFailure = 'none' | 'bleLost' | 'softAPLost' | 'udpFlowDead' | 'encoderPaused' | 'decoderWedged' | 'presentStalled';
export type LinkRepair = 'none' | 'resendEnable' | 'rebindUDP' | 'rehandshake' | 'rejoinSoftAP' | 'fullReconnect';

type Age = number | null;
const BLE_LOST_AGE = 8;

export interface LinkDiagnosisInputs {
  pathReady: boolean;
  bleNotifyAge: Age;
  videoAge: Age;
  statusAge: Age;
  flowHealthy: boolean;
  decoderFailed: boolean;
  udpReceiveAlive: boolean;
  hadVideo: boolean;
  secondsSinceLastEnable: Age;
  secondsSinceFocusTrackSet: Age;
  secondsSinceZoomSet?: Age;
  zoomPinchActive?: boolean;
  secondsSinceGimbalThrow?: Age;
  gimbalStickHeld?: boolean;
  presentAge?: Age;
  secondsSinceCameraSet?: Age;
}

export const LinkDiagnoser = {
  diagnose(i: LinkDiagnosisInputs): LinkFailure {
    if (!i.pathReady) return 'softAPLost';
    if (i.decoderFailed) return 'decoderWedged';
    if (i.udpReceiveAlive && i.presentAge != null && i.presentAge > 2) return 'presentStalled';
    if (FeedWatchdog.shouldHoldForGOPReset(i.secondsSinceLastEnable, i.videoAge)) return 'none';
    const ft = i.secondsSinceFocusTrackSet;
    if (ft != null && ft >= 0 && ft < FOCUS_TRACK_VIDEO_GRACE) return 'none';
    if (CamFov.shouldHoldWatchdog(i.secondsSinceZoomSet ?? null, null, i.zoomPinchActive ?? false)) return 'none';
    if (GimbalStick.shouldHoldWatchdog(i.secondsSinceGimbalThrow ?? null, i.videoAge, i.gimbalStickHeld ?? false)) return 'none';
    if (FeedWatchdog.shouldHoldForCameraSet(i.secondsSinceCameraSet ?? null, i.videoAge)) return 'none';
    if (i.hadVideo && (i.statusAge ?? Infinity) < 2 && !i.udpReceiveAlive) return 'encoderPaused';
    if ((i.bleNotifyAge == null || i.bleNotifyAge > BLE_LOST_AGE) && !i.udpReceiveAlive && (i.statusAge ?? Infinity) >= 2) return 'bleLost';
    if (!i.flowHealthy || !i.udpReceiveAlive) return 'udpFlowDead';
    return 'none';
  },
  repair(f: LinkFailure): LinkRepair {
    switch (f) {
      case 'encoderPaused':
        return 'resendEnable';
      case 'udpFlowDead':
        return 'rebindUDP';
      case 'softAPLost':
        return 'rejoinSoftAP';
      case 'bleLost':
        return 'fullReconnect';
      default:
        return 'none';
    }
  },
  diagnoseSnapshot(s: WatchdogSnapshot): LinkFailure {
    return LinkDiagnoser.diagnose({
      pathReady: s.pathReady,
      bleNotifyAge: s.lastBleNotifyAge,
      videoAge: s.lastVideoPacketAge,
      statusAge: s.lastStatusAge,
      flowHealthy: s.flowHealthy,
      decoderFailed: s.decoderFailed,
      udpReceiveAlive: FeedWatchdog.udpReceiveAlive(s),
      hadVideo: s.hadVideo,
      secondsSinceLastEnable: s.secondsSinceLastEnable,
      secondsSinceFocusTrackSet: s.secondsSinceFocusTrackSet,
      secondsSinceZoomSet: s.secondsSinceZoomSet,
      zoomPinchActive: s.zoomPinchActive,
      secondsSinceGimbalThrow: s.secondsSinceGimbalThrow,
      gimbalStickHeld: s.gimbalStickHeld,
      presentAge: s.lastDecodedFrameAge,
      secondsSinceCameraSet: s.secondsSinceCameraSet,
    });
  },
  agrees(watchdog: WatchdogAction, repair: LinkRepair): boolean {
    if (watchdog === 'none') return repair === 'none';
    if (watchdog === 'resendLiveViewEnable') return repair === 'resendEnable';
    if (watchdog === 'reopenDatalink' || watchdog === 'rebuildVTSession') return repair === 'rebindUDP';
    if (watchdog === 'fullSessionRejoin') return repair === 'fullReconnect' || repair === 'rejoinSoftAP';
    return false;
  },
  observeLine(s: WatchdogSnapshot, watchdog: WatchdogAction): string {
    const failure = LinkDiagnoser.diagnoseSnapshot(s);
    const repair = LinkDiagnoser.repair(failure);
    const age = (v: Age) => (v == null ? 'none' : v.toFixed(1));
    return (
      `feed: observe diagnose=${failure} repair=${repair} watchdog=${watchdog} disagree=${LinkDiagnoser.agrees(watchdog, repair) ? 0 : 1} ` +
      `lastFrame=${age(s.lastDecodedFrameAge)}s lastVideo=${age(s.lastVideoPacketAge)}s lastStatus=${age(s.lastStatusAge)}s lastBle=${age(s.lastBleNotifyAge)}s`
    );
  },
};
