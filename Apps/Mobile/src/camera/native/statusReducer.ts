/**
 * Inbound DUML → decoded camera status → UI `CameraState`. Pure: decode is `src/core`
 * (`CameraStatusDecoder`, `GimbalStickMapping`, tracking wire) and the UI map is
 * `src/core/mapping.ts`; this class only holds the running records between frames.
 */
import { GimbalWire } from '@/core/commands/control';
import type { GimbalMode } from '@/core/commands/vocabulary';
import type { DumlFrame } from '@/core/duml/frame';
import { GimbalStick, GimbalStickMapping } from '@/core/gimbal/stick';
import type { GimbalNativePitchWire } from '@/core/gimbal/reach';
import { mapCameraState } from '@/core/mapping';
import type { CameraModel } from '@/core/status/cameraModel';
import { type CameraStatus, CameraStatusDecoder, emptyCameraStatus } from '@/core/status/cameraStatus';
import { parseTrackingPoll, TrackingBoxes, type TrackingPoll } from '@/core/status/trackingBox';
import type { CameraState } from '../types';

export interface Attitude {
  yawTenthDeg: number;
  /** Display pitch (look-up positive), `@20` negated. */
  pitchTenthDeg: number | null;
  /** Native absolute pitch `@0` (for `0x04/0x14` targets). */
  nativePitchTenthDeg: number | null;
  wire: GimbalNativePitchWire;
  /** Receipt time, ms. */
  at: number;
}

export class CameraStatusReducer {
  status: CameraStatus = emptyCameraStatus();
  readonly stick = new GimbalStickMapping();
  model: CameraModel | null;
  tracking: TrackingPoll | null = null;
  /** Commanded gimbal mode (wire only reports the family). */
  gimbalMode: GimbalMode = 'follow';
  attitude: Attitude | null = null;
  /** Last `0x02/0x80` push time, ms (playback bit lives there). */
  lastStatusPushAt: number | null = null;
  private faceChanged = false;

  constructor(model: CameraModel | null) {
    this.model = model;
  }

  reset(model: CameraModel | null): void {
    this.status = emptyCameraStatus();
    this.model = model;
    this.tracking = null;
    this.gimbalMode = 'follow';
    this.attitude = null;
    this.lastStatusPushAt = null;
    Object.assign(this.stick, new GimbalStickMapping());
  }

  /** Apply one inbound frame. Returns true when UI-visible state may have changed. */
  apply(frame: DumlFrame, now: number): boolean {
    let changed = CameraStatusDecoder.apply(frame, this.status, this.model);
    const key = (frame.cmdSet << 8) | frame.cmdId;
    const p = frame.payload;
    switch (key) {
      case 0x0280:
        this.lastStatusPushAt = now;
        break;
      case 0x0405: {
        if (GimbalStick.isAttitude(p)) {
          this.stick.applyAttitude(p);
          const layout = GimbalStick.attitudeLayout(p);
          const yaw = GimbalStick.yawTenthDeg(p);
          if (layout && yaw != null) {
            this.attitude = {
              yawTenthDeg: yaw,
              pitchTenthDeg: GimbalStick.pitchTenthDeg(p),
              nativePitchTenthDeg: GimbalStick.nativePitchTenthDeg(p),
              wire: GimbalStick.nativePitchWire(layout),
              at: now,
            };
          }
          const family = GimbalWire.modeFamily(p);
          if (family != null) this.gimbalMode = GimbalWire.modeFromFamily(family, this.gimbalMode);
          changed = true;
        }
        break;
      }
      case 0x0427:
        if (this.stick.noteBodyFace(this.status.gimbalFace)) this.faceChanged = true;
        changed = true;
        break;
      case 0x0450: {
        const params = GimbalWire.parseParams(p);
        if (params) this.gimbalMode = GimbalWire.modeFromGet(params, this.gimbalMode);
        break;
      }
      case 0x02a5: {
        const poll = parseTrackingPoll(p);
        if (poll) {
          this.tracking = poll;
          changed = true;
        }
        break;
      }
      case 0x0289: {
        const box = TrackingBoxes.parseLivePush(p);
        if (box) {
          this.tracking = { kind: 'locked', box };
          changed = true;
        }
        break;
      }
      default:
        break;
    }
    return changed;
  }

  /** True once since the last call when the body reported a face change (selfie/front). */
  takeFaceChanged(): boolean {
    const v = this.faceChanged;
    this.faceChanged = false;
    return v;
  }

  /** Overlay the decoded status onto the previous UI state. Identity/connection stay the session's. */
  reduce(prev: CameraState): CameraState {
    const next = mapCameraState(prev, {
      status: this.status,
      model: this.model,
      tracking: this.tracking,
      gimbal: {
        mode: this.gimbalMode,
        yawTenthDeg: this.stick.yawTenthDeg,
        pitchTenthDeg: this.stick.pitchTenthDeg,
        face: this.stick.face,
      },
    });
    // Tracking 'searching' is the session's own state until the camera reports a lock or idle.
    if (prev.tracking.status === 'searching' && this.tracking == null) next.tracking = prev.tracking;
    return next;
  }
}
