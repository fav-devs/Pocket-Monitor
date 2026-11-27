/**
 * What the gestures do to the camera: the gesture, hand-control, face and clap parts of
 * `pm_controller::input::LiveInput` (`Apps/Desktop/crates/pm-controller/src/input.rs`), for
 * phones. Pure: it calls a {@link GestureTarget}, which the app binds to a `CameraSession`
 * (`gimbal.drive`, `control.zoomBy`, recording, recentre, flip, tracking).
 *
 * - A gesture does what the map says: recentre, flip, stop, record, face tracking; the presets
 *   are the desktop's, so phones say "NO PRESETS SAVED", as the desktop does with none saved.
 * - The stick hand drives the gimbal with the controller's rest zone. The throw is passed on when
 *   it changes and repeated every {@link HAND_BEAT} between readings, and let go
 *   {@link HAND_STALE} after the last reading (the desktop's heartbeat safety).
 * - The zoom hand holds a continuous zoom rate (`zoomBy`, the phones' hold-to-zoom) with the
 *   triggers' rest zone, stopped when the pinch ends or the readings stop. The desktop writes the
 *   dial with `zoom_trigger_step` instead; the phones' camera link has its own zoom-rate command.
 * - Calls go out only on a change or a heartbeat, never once per reading for nothing: the session
 *   itself streams the stick on the 40 Hz link.
 */
import type { GestureKey, GestureMap } from './gesture';
import type { Control } from './hand';
import type { FaceBox } from './vision';

/** A pinching hand's stick throw is repeated this often between readings. */
export const HAND_BEAT = 0.1;
/** A hand stick not read again for this long is let go (the models stopped answering). */
export const HAND_STALE = 0.5;
/** The controller's rest zone (`pad::REST`): throws below this are no throw. */
export const PAD_REST = 0.08;
/** Stick throws closer than this to the last one sent are not sent again before the heartbeat. */
const STICK_STEP = 0.02;

/** What the gestures can ask of the camera. */
export interface GestureTarget {
  /** Gimbal velocity, −1…1 each way (right and up positive); (0, 0) rests it. */
  drive(x: number, y: number): void;
  /** Continuous zoom, −1 (out) … 1 (in); 0 stops. */
  zoomBy(rate: number): void;
  recenter(): void;
  flip(): void;
  /** Stop a move in flight and let go of tracking. */
  stop(): void;
  /** Start recording, or stop it when recording. */
  toggleRecording(): void;
  /** Track this box (left, top, width, height of the picture). */
  trackFace(box: FaceBox): void;
  stopTracking(): void;
  /** Optional (additive). A marker on the take being recorded (it shows its own toast). */
  marker?(): void;
  /** A line for the operator ("GESTURE: RECENTRE"). */
  notice(text: string): void;
}

/** What the driver needs to know about the camera now. */
export interface GestureFacts {
  tracking: boolean;
  recording: boolean;
}

/** A held gesture on its way to recording: `HOLD TO START RECORDING` with its bar. */
export interface GestureHold {
  text: 'HOLD TO START RECORDING' | 'HOLD TO STOP RECORDING';
  /** 0…1 in tenths, as the bar fills. */
  fraction: number;
}

export class GestureDriver {
  /** What each gesture does. */
  map: GestureMap;
  /** The camera's own picture is being read, so a face can be found for the face gesture. */
  private faceFinder = false;
  private faceRequest = false;
  private holdValue: GestureHold | null = null;
  /** The hand's throw and when it was last read. */
  private handStick: { x: number; y: number; heard: number } | null = null;
  /** The throw last passed on, and when. */
  private stickSent: { x: number; y: number; at: number } | null = null;
  private zoomSent = 0;
  private zoomHeard = 0;

  constructor(
    private readonly target: GestureTarget,
    private readonly facts: () => GestureFacts,
    map: GestureMap,
  ) {
    this.map = map;
  }

  /** A gesture does what the map says (`LiveInput::gesture`). */
  gesture(gesture: GestureKey): void {
    switch (this.map[gesture]) {
      case 'nothing':
        return;
      case 'recenter':
        this.target.notice('GESTURE: RECENTRE');
        this.target.recenter();
        return;
      case 'flip':
        this.target.notice('GESTURE: FLIP');
        this.target.flip();
        return;
      case 'stop':
        this.target.notice('GESTURE: STOP');
        this.target.stop();
        return;
      case 'record':
        this.target.notice('GESTURE: RECORD');
        this.target.toggleRecording();
        return;
      case 'face_track':
        if (this.facts().tracking) {
          this.target.notice('FACE TRACKING OFF');
          this.target.stopTracking();
        } else if (this.faceFinder) {
          this.faceRequest = true;
          this.target.notice('LOOKING FOR YOUR FACE');
        } else {
          this.target.notice("FACE TRACKING NEEDS THE CAMERA'S PICTURE");
        }
        return;
      case 'marker':
        // The marker toast says what happened; no notice on top of it.
        this.target.marker?.();
        return;
      case 'next_preset':
      case 'previous_preset':
        // Gimbal presets live in the desktop app; a phone has none saved.
        this.target.notice('NO PRESETS SAVED');
        return;
    }
  }

  /** Whether the camera's own picture is being read for hands and faces (`set_face_finder`). */
  setFaceFinder(on: boolean): void {
    this.faceFinder = on;
    if (!on) {
      this.faceRequest = false;
      this.holdValue = null;
    }
  }

  /** True once after the face gesture asked for the face to be tracked. */
  takeFaceRequest(): boolean {
    const asked = this.faceRequest;
    this.faceRequest = false;
    return asked;
  }

  /** The record gesture's hold, while it fills. */
  hold(): GestureHold | null {
    return this.holdValue;
  }

  /**
   * A held pose part-way to firing (or none): shown while it is the one that records, between a
   * tenth and the whole of its hold (`gesture_progress`).
   */
  gestureProgress(progress: { gesture: GestureKey; fraction: number } | null): void {
    this.holdValue =
      progress && this.map[progress.gesture] === 'record' && progress.fraction >= 0.1 && progress.fraction < 1
        ? {
            text: this.facts().recording ? 'HOLD TO STOP RECORDING' : 'HOLD TO START RECORDING',
            fraction: Math.floor(progress.fraction * 10) / 10,
          }
        : null;
  }

  /** A pinching hand's control (`hand_control`): the stick hand drives, the zoom hand zooms. */
  handControl(control: Control, now: number): void {
    switch (control.kind) {
      case 'stick': {
        if (Math.abs(control.x) < PAD_REST && Math.abs(control.y) < PAD_REST) {
          this.handRelease();
          return;
        }
        const x = Math.round(control.x * 100) / 100;
        const y = Math.round(control.y * 100) / 100;
        this.handStick = { x, y, heard: now };
        const sent = this.stickSent;
        if (!sent || Math.abs(sent.x - x) >= STICK_STEP || Math.abs(sent.y - y) >= STICK_STEP || now - sent.at >= HAND_BEAT) this.sendStick(x, y, now);
        return;
      }
      case 'stickEnd':
        this.handRelease();
        return;
      case 'zoom': {
        const axis = Math.max(-1, Math.min(1, control.rate));
        const magnitude = Math.abs(axis);
        const shaped = magnitude < PAD_REST ? 0 : (Math.sign(axis) * (magnitude - PAD_REST)) / (1 - PAD_REST);
        const rate = Math.round(shaped * 20) / 20 + 0;
        this.zoomHeard = now;
        this.sendZoom(rate);
        return;
      }
      case 'zoomEnd':
        this.sendZoom(0);
        return;
    }
  }

  /** Whether a pinching hand is driving the gimbal. */
  handDriving(): boolean {
    return this.handStick != null;
  }

  /** The clock moved on: the hand stick's heartbeat, and letting go once the readings stop. */
  tick(now: number): void {
    const stick = this.handStick;
    if (stick) {
      if (now - stick.heard > HAND_STALE) this.handRelease();
      else if (!this.stickSent || now - this.stickSent.at >= HAND_BEAT) this.sendStick(stick.x, stick.y, now);
    }
    if (this.zoomSent !== 0 && now - this.zoomHeard > HAND_STALE) this.sendZoom(0);
  }

  /** Lets go of the stick and the zoom (gestures off, the picture off screen, the app in the background). */
  release(): void {
    this.handRelease();
    this.sendZoom(0);
    this.holdValue = null;
  }

  /** A double clap: the gimbal goes back to centre. */
  clap(): void {
    this.target.notice('CLAP: RECENTRE');
    this.target.recenter();
  }

  /** Tracks the face the reader found, as a drag of that box would. */
  trackFace(box: FaceBox): void {
    this.target.notice('FACE TRACKING');
    this.target.trackFace(box);
  }

  /** The face gesture found no face in time. */
  noFace(): void {
    this.target.notice('NO FACE FOUND');
  }

  private handRelease(): void {
    if (!this.handStick && !this.stickSent) return;
    this.handStick = null;
    this.stickSent = null;
    this.target.drive(0, 0);
  }

  private sendStick(x: number, y: number, now: number): void {
    this.stickSent = { x, y, at: now };
    this.target.drive(x, y);
  }

  private sendZoom(rate: number): void {
    if (rate === this.zoomSent) return;
    this.zoomSent = rate;
    this.target.zoomBy(rate);
  }
}
