/**
 * Builders for the DUML frames of the connection spine and camera control, byte-for-byte.
 * BLE frames carry a message id in `seq`; datalink frames carry the running `dumlSeq` there
 * (the datalink sequencer / native queue overwrites it).
 *
 * Source of truth: OpenCine `Sources/OpenCineDJI/Commands.swift` (upstream; adds Action 6 favourite
 * tail, timed gimbal targets with the continuous pitch wire and direction lock vs the fork).
 */
import { concat, putF32le, putU16le, putU32le, utf8Encode } from '../bytes';
import { type DumlFrame, FLAG_NOTIFY, FLAG_REQUEST, FLAG_RESPONSE, packString, RX_1C, RX_CAMERA, RX_SESSION, RX_WIFI, SENDER_APP } from '../duml/frame';
import { GimbalReach, type GimbalNativePitchWire, nativePitchRange } from '../gimbal/reach';
import { roundHalfAway } from '../math';
import { type CameraModel, isAction6, isPocket3, supportsAperture } from '../status/cameraModel';
import { CamFov } from './camFov';
import {
  APERTURE_CAPABILITY_KEY,
  APERTURE_STATE_KEY,
  type ApertureStrategy,
  type AudioChannel,
  type ColorMode,
  ColorModes,
  EvComp,
  type ExpoMode,
  type FocusMode,
  type FocusTrackMode,
  type FovSetting,
  type GimbalSpeed,
  type GimbalTiltLock,
  GimbalTiltLock as GTL,
  type IsoIndex,
  type IsoLimit,
  SHOOTING_MODE_TABLED_RAW,
  type ShootingMode,
  ShootingModes,
  type VideoFormat,
  VideoFormats,
  type VocalBoost,
  type WhiteBalance,
  WhiteBalanceMode,
  wbAuto,
  wbCustom,
} from './vocabulary';

export const DEFAULT_IDENTIFIER = '284ae5b8d76b3375a04a6417ad71bea3';

/** Status keys to subscribe to (`0x00/0x99`), starting at subId 0x69DF. Order is load-bearing. */
export const SUBSCRIPTION_KEYS = [
  'camcap_mode_profile',
  'camcap_video_format',
  'camcap_fov',
  'camcap_iso',
  'camcap_shutter',
  'camcap_photo_storage_format',
  'camcap_color_mode',
  'cam_storage',
  'cam_status',
  'timecode_info',
  'cam_expo_param',
  'cam_video_param_v2',
  'cam_record_time',
  'cam_image_effect',
  'cam_lens_state',
  'cam_fov',
  'cam_audio_status_v2',
] as const;
export const FIRST_SUB_ID = 0x69df;

/** Base keys plus body-only ones, appended so base subIds never move. */
export function subscriptionKeysFor(model: CameraModel | null | undefined): string[] {
  if (!model || !supportsAperture(model)) return [...SUBSCRIPTION_KEYS];
  return [...SUBSCRIPTION_KEYS, APERTURE_STATE_KEY, APERTURE_CAPABILITY_KEY];
}

export const rx = (type: number, id: number) => ((id << 5) | type) & 0xff;

function frame(receiver: number, cmdSet: number, cmdId: number, payload: ArrayLike<number>, seq: number, flags = FLAG_REQUEST): DumlFrame {
  return { sender: SENDER_APP, receiver, seq: seq & 0xffff, flags, cmdSet, cmdId, payload: Uint8Array.from(payload) };
}
const camera = (cmd: number, payload: ArrayLike<number>, seq = 0) => frame(RX_CAMERA, 0x02, cmd, payload, seq);
const gimbal = (cmd: number, payload: ArrayLike<number>, seq = 0, flags = FLAG_REQUEST) => frame(rx(0x04, 0), 0x04, cmd, payload, seq, flags);

/** `0x02/0x8E` pids (Osmosis §14 / Mimo). */
export const CameraParam = {
  fov: 0x0009,
  isoLimit: 0x000f,
  audioChannel: 0x0020,
  selfieFlip: 0x0038,
  glamour: 0x0039,
  focusTrack: 0x003b,
  apertureStrategy: 0x0044,
  vocalBoost: 0x004c,
} as const;
export type CameraParam = (typeof CameraParam)[keyof typeof CameraParam];

export const Commands = {
  // ---- BLE session sequence (written to fff5, paced) ----
  /** `0x00/0x2b` -> session. `04 00` wakes before pairing. */
  sessionWake: (id = 0x802b) => frame(RX_SESSION, 0x00, 0x2b, [0x04, 0x00], id),
  /** `01 01` repeats as keepalive. */
  sessionKeepalive: (id = 0x802b) => frame(RX_SESSION, 0x00, 0x2b, [0x01, 0x01], id),
  /** `0x07/0x45` SetPairingPIN. Reply `[00 01]` already paired, `[00 02]` approve on camera. */
  setPairingPin: (pin: string, identifier = DEFAULT_IDENTIFIER, id = 0x8092) =>
    frame(RX_WIFI, 0x07, 0x45, concat(packString(identifier), packString(pin)), id),
  /** The camera's first-time approval arrives as a `0x07/0x46` request; answer with this response. */
  pairApprovalAck: (seq: number) => frame(RX_WIFI, 0x07, 0x46, [0x00], seq, FLAG_RESPONSE),
  /** `0x53/0x10` -> type 0x1C. The camera answers `01 00 00 00` and wakes its AP. */
  session5310: (id = 0x8053) => frame(RX_1C, 0x53, 0x10, [0, 0, 0, 0], id),
  getWifiSsid: (id = 0x8007) => frame(RX_WIFI, 0x07, 0x07, [], id),
  getWifiPassword: (id = 0x800e) => frame(RX_WIFI, 0x07, 0x0e, [], id),

  // ---- Datalink registration ----
  /** `0x00/0x81` device-info, cmdType 4 (flags 0x80) -> DM368 (type 0x08, id 2). */
  appDeviceInfo(seq: number): DumlFrame {
    const b = new Array(62).fill(0);
    b[1] = 0x41;
    b[2] = 0x50;
    b[3] = 0x50;
    b[41] = 0x02;
    b[50] = 0x02;
    b[51] = 0x08;
    return frame(rx(0x08, 2), 0x00, 0x81, b, seq, 0x80);
  },
  /** `0x00/0x88` app-presence, re-sent ~1 Hz -> DM368 (type 0x08, id 1). */
  appPresenceFrame: (seq: number) =>
    frame(rx(0x08, 1), 0x00, 0x88, [0x17, 0x00, 0x46, 0x23, 0x7c, 0x41, 0x50, 0x50, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02], seq),
  /** `0x03/0xDA` gimbal init -> Gimbal (type 0x03, id 0). */
  gimbalInit: (seq: number) => frame(rx(0x03, 0), 0x03, 0xda, [0x05, 0xff, 0xff, 0xff, 0xff], seq),
  /** `0x00/0x99` status subscription -> DM368 (type 0x08, id 1). */
  subscribe: (key: string, subId: number, seq: number) => frame(rx(0x08, 1), 0x00, 0x99, subscriptionPayload(key, subId), seq),

  /** `0x02/0x0c` enter playback `01 01 00 01`. */
  enterPlayback: (seq = 0) => camera(0x0c, [0x01, 0x01, 0x00, 0x01], seq),
  /** `0x02/0x0c` leave playback `01 01 00 00`. */
  exitPlayback: (seq = 0) => camera(0x0c, [0x01, 0x01, 0x00, 0x00], seq),

  /** `0x00/0x26` media list. Cursor at bytes 10–13; counter at byte 4. */
  mediaList: (counter: number, cursor: number, seq = 0) => frame(RX_CAMERA, 0x00, 0x26, mediaListPayload(counter, cursor), seq),
  /** `0x00/0x26` stream trigger `4a040e10…`. */
  mediaListTrigger: (seq = 0) => frame(RX_CAMERA, 0x00, 0x26, MEDIA_LIST_TRIGGER, seq),
  /** `0x00/0x28` delete: `[count][handles][counter:u32] 00 [count:u32] 01 01 00 00`. */
  deleteMedia: (handle: number, counter: number, seq = 0) =>
    frame(RX_CAMERA, 0x00, 0x28, [0x01, ...putU32le(handle), ...putU32le(counter), 0x00, ...putU32le(1), 0x01, 0x01, 0x00, 0x00], seq),
  /** `0x02/0xBF` star. Action 6 carries its own fixed tail. */
  setMediaFavorite(handle: number, on: boolean, counter: number, model?: CameraModel | null, seq = 0): DumlFrame {
    if (model && isAction6(model)) {
      return camera(0xbf, [0x01, on ? 1 : 0, ...putU32le(handle), 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00], seq);
    }
    return camera(0xbf, [0x01, 0x01, ...putU32le(handle), ...putU32le(counter), 0x00, on ? 1 : 0, 0x00, 0x00, 0x00], seq);
  },

  /** Pocket live-view enable target (system type 0x08, id 0). */
  liveViewEnableReceiverPocket: rx(0x08, 0),
  /** Nano and Action 6 live-view enable target. */
  liveViewEnableReceiverNano: 0x41,
  /**
   * `0x09/0xa8` **start live view** / IDR. Enable ONCE at connect; repeats belong only to the
   * watchdog (re-sending every second resets the GOP and the IDR never lands).
   */
  liveViewEnable: (seq: number, receiver = rx(0x08, 0)) => frame(receiver, 0x09, 0xa8, [0x00, 0x04, 0x02, 0, 0, 0, 0, 0, 0, 0], seq),
  /** Nano `0x02/0x09` sent with every enable (`…03`) and with feed stop (`…04`). Not on Pocket. */
  nanoLiveViewGate: (start: boolean, seq = 0) => camera(0x09, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, start ? 0x03 : 0x04], seq),

  // ---- Camera control ----
  /** `0x02/0x02` start recording `[01]`. Not a toggle. */
  recordStart: (seq = 0) => camera(0x02, [0x01], seq),
  recordStop: (seq = 0) => camera(0x02, [0x00], seq),
  /** `0x02/0x01` shutter `[01]`. */
  shootPhoto: (seq = 0) => camera(0x01, [0x01], seq),
  shutterTrigger: (start: boolean, seq = 0) => camera(0x01, [start ? 1 : 0], seq),
  /** `0x02/0xE1` shooting mode (Photo byte is body-specific). */
  setShootingMode: (mode: ShootingMode, model?: CameraModel | null, seq = 0) => camera(0xe1, [ShootingModes.wireByte(mode, model)], seq),
  /** Raw form: refuses anything outside the tabled set (sweeping froze a Nano). */
  setShootingModeRaw(raw: number, seq = 0): DumlFrame | null {
    if (!SHOOTING_MODE_TABLED_RAW.has(raw)) return null;
    return camera(0xe1, [raw], seq);
  },
  /** `0x02/0x8E` GET = `00 01 <pid:u16-LE>`. */
  paramGet: (pid: CameraParam, seq = 0) => camera(0x8e, [0x00, 0x01, pid & 0xff, pid >> 8], seq),
  /** `0x02/0x8E` SET = `01 01 <pid:u16-LE> <len:u8> <value…>`. */
  paramSet: (pid: CameraParam, value: ArrayLike<number>, seq = 0) =>
    camera(0x8e, [0x01, 0x01, pid & 0xff, pid >> 8, value.length & 0xff, ...Array.from(value)], seq),
  setIsoLimit: (limit: IsoLimit, seq = 0) => Commands.paramSet(CameraParam.isoLimit, [limit], seq),
  getIsoLimit: (seq = 0) => Commands.paramGet(CameraParam.isoLimit, seq),
  /** `0x02/0x2E` 1-byte EV (`0x10` = 0.0). `thirds` is −9…+9. */
  setEv: (thirds: number, seq = 0) => camera(0x2e, [EvComp.raw(thirds)], seq),
  setFov: (fov: FovSetting, seq = 0) => Commands.paramSet(CameraParam.fov, [fov], seq),
  /** `0x22` AE Meter Set `[02]` (spot). First of the tap-focus burst. */
  tapFocusPrepare: (seq = 0) => camera(0x22, [0x02], seq),
  /** `0x30` Focus Region Set: x,y float32 LE + 13× `00` (21 B). */
  tapFocusPoint: (x: number, y: number, seq = 0) => camera(0x30, [...putF32le(x), ...putF32le(y), ...new Array(13).fill(0)], seq),
  /** `0x32` AE Meter Region Set: `00 02 01 00` + xy + 8× `00`. */
  tapFocusCommit: (x: number, y: number, seq = 0) =>
    camera(0x32, [0x00, 0x02, 0x01, 0x00, ...putF32le(x), ...putF32le(y), ...new Array(8).fill(0)], seq),
  /** `0x68` `[08]`. Same bytes as `liveViewPrepare`. */
  tapFocusLiveHint: (seq = 0) => camera(0x68, [0x08], seq),
  /** Pocket `0x02/0x68 08` immediately before the first `0x09/0xa8`. Not on Nano / Action 6. */
  liveViewPrepare: (seq = 0) => camera(0x68, [0x08], seq),
  /** `0x02/0xA6` drag-to-track SET. `01 00 00` + u16-LE id + 4×f32 LE. */
  setTrackingBox: (id: number, x: number, y: number, width: number, height: number, seq = 0) =>
    camera(0xa6, [0x01, 0x00, 0x00, ...putU16le(id), ...putF32le(x), ...putF32le(y), ...putF32le(width), ...putF32le(height)], seq),
  /** `0x02/0xA6` clear — 21× `00`. */
  clearTrackingBox: (seq = 0) => camera(0xa6, new Array(21).fill(0), seq),
  /** `0x02/0xA5` GET `00`. */
  pollTracking: (seq = 0) => camera(0xa5, [0x00], seq),
  /** `0x02/0x28` shutter SET: `01` + u16-LE `(denom | 0x8000)` + `00 00 00 40`. */
  setShutter(denom: number, seq = 0): DumlFrame {
    const enc = (Math.min(Math.max(Math.trunc(denom), 0), 0xffff) | 0x8000) & 0xffff;
    return camera(0x28, [0x01, enc & 0xff, enc >> 8, 0x00, 0x00, 0x00, 0x40], seq);
  },
  /** `0x02/0x2A` ISO index (`00` Auto). */
  setIsoIndex: (index: IsoIndex, seq = 0) => camera(0x2a, [index], seq),
  /** `0x02/0x42` color (body-specific byte). */
  setColorMode: (mode: ColorMode, model?: CameraModel | null, seq = 0) => camera(0x42, [ColorModes.wireByte(mode, model)], seq),
  /** `0x02/0x24` focus. Single `01`, Continuous `02`. */
  setFocusMode: (mode: FocusMode, seq = 0) => camera(0x24, [mode], seq),
  getFocusTrack: (seq = 0) => Commands.paramGet(CameraParam.focusTrack, seq),
  /** SET `01 01 3B 00 02 01 <mode>`. */
  setFocusTrack: (mode: FocusTrackMode, seq = 0) => Commands.paramSet(CameraParam.focusTrack, [0x01, mode], seq),
  /** `0x02/0x2C` white balance `[mode][K/100 u16-LE][tint i16-LE]`. */
  setWhiteBalance: (wb: WhiteBalance, seq = 0) => camera(0x2c, whiteBalancePayload(wb), seq),
  setWhiteBalanceAuto: (tint = 0, seq = 0) => Commands.setWhiteBalance(wbAuto(tint), seq),
  setWhiteBalanceCustom: (kelvin: number, tint: number, seq = 0) => Commands.setWhiteBalance(wbCustom(kelvin, tint), seq),
  getAudioChannel: (seq = 0) => Commands.paramGet(CameraParam.audioChannel, seq),
  setAudioChannel: (ch: AudioChannel, seq = 0) => Commands.paramSet(CameraParam.audioChannel, [ch], seq),
  getGlamour: (seq = 0) => Commands.paramGet(CameraParam.glamour, seq),
  /** SET the 62-byte glamour blob. Only use to force Off. */
  setGlamour: (blob: ArrayLike<number>, seq = 0) => Commands.paramSet(CameraParam.glamour, blob, seq),
  getSelfieFlip: (seq = 0) => Commands.paramGet(CameraParam.selfieFlip, seq),
  getVocalBoost: (seq = 0) => Commands.paramGet(CameraParam.vocalBoost, seq),
  setVocalBoost: (v: VocalBoost, seq = 0) => Commands.paramSet(CameraParam.vocalBoost, [v], seq),
  /** `0x02/0xA0` GET audio-DSP blob (empty payload). */
  audioDspGet: (seq = 0) => camera(0xa0, [], seq),
  /** First-live / audio-sheet probes. */
  audioStateGets: () => [Commands.getAudioChannel(), Commands.getVocalBoost(), Commands.audioDspGet()],
  /** `0x02/0x9F` SET = the 26-byte GET blob. */
  audioDspSet: (blob: ArrayLike<number>, seq = 0) => camera(0x9f, blob, seq),
  /** `0x02/0x18` res+fps: `[res][fps_idx]` + trailer. */
  setVideoFormat: (format: VideoFormat, shootingMode?: ShootingMode | null, seq = 0) =>
    camera(0x18, VideoFormats.setPayload(format, shootingMode), seq),
  /** `0x02/0xb8` slider SET `0A 4E` + u16-LE lens. */
  setZoomLens: (position: number, seq = 0) => camera(0xb8, [0x0a, 0x4e, position & 0xff, (position >> 8) & 0xff], seq),
  setZoom: (factor: number, seq = 0) => Commands.setZoomLens(CamFov.lensPosition(factor), seq),
  /** Held zoom `01 rate direction 00`; rate clamps 72…78. */
  setZoomRate: (rate: number, increasing: boolean, seq = 0) => camera(0xb8, [0x01, Math.min(78, Math.max(72, rate)), increasing ? 1 : 0, 0], seq),
  setZoomSlew: (value: number, seq = 0) => camera(0xb8, [0x03, 0x00, value & 0xff, (value >> 8) & 0xff], seq),
  setZoomStop: (seq = 0) => camera(0xb8, [0xff, 0x00, 0x00, 0x00], seq),
  /** `0x02/0x1E` expo mode: `01 00` auto, `04 00` manual. */
  setExpoMode: (mode: ExpoMode, seq = 0) => camera(0x1e, [mode, 0x00], seq),
  /** Action 6 aperture strategy SET (`0x8E` pid `0x0044`). */
  setApertureStrategy: (s: ApertureStrategy, seq = 0) => Commands.paramSet(CameraParam.apertureStrategy, [s], seq),

  // ---- Gimbal (`rcv=0x04`). Flip/mode/speed ACK flags `0x80`; stick flags `0x00`, no ACK. ----
  gimbalRecenter: (seq = 0) => gimbal(0x4c, [0xfe, 0x08], seq),
  /** `FE 09` — front ↔ selfie toggle. */
  gimbalFlip: (seq = 0) => gimbal(0x4c, [0xfe, 0x09], seq),
  gimbalFollowFamily: (seq = 0) => gimbal(0x4c, [0x02, 0x08], seq),
  gimbalFpv: (seq = 0) => gimbal(0x4c, [0x01, 0x08], seq),
  gimbalDirectionLock: (seq = 0) => gimbal(0x4c, [0x00, 0x08], seq),
  /** `0x04/0x01` notify, 10 B. Axes u16-LE @0/@4, center 1024 ±550, trailer `00 80 22 00`. */
  gimbalStick: (axis0: number, axis1: number, seq = 0) =>
    gimbal(0x01, [...putU16le(axis0), 0x00, 0x00, ...putU16le(axis1), 0x00, 0x80, 0x22, 0x00], seq, FLAG_NOTIFY),
  /** Native absolute angle `0x04/0x14`: yaw/pitch i16-LE tenths, mode 0x05, duration tenths. */
  gimbalTimedTarget(yawDeg: number, nativePitchDeg: number, duration: number, seq = 0, wire: GimbalNativePitchWire = 'wrapped'): DumlFrame | null {
    const [lo, hi] = nativePitchRange(wire);
    if (
      !Number.isFinite(yawDeg) ||
      !Number.isFinite(nativePitchDeg) ||
      !Number.isFinite(duration) ||
      yawDeg < GimbalReach.panMinDeg ||
      yawDeg > GimbalReach.panMaxDeg ||
      nativePitchDeg < lo ||
      nativePitchDeg > hi ||
      duration < 0.1 ||
      duration > 25.5 ||
      Math.abs(duration * 10 - roundHalfAway(duration * 10)) >= 1e-6
    )
      return null;
    return gimbal(
      0x14,
      [...putU16le(roundHalfAway(yawDeg * 10)), 0, 0, ...putU16le(roundHalfAway(nativePitchDeg * 10)), 0x05, roundHalfAway(duration * 10)],
      seq,
      FLAG_NOTIFY,
    );
  },
  /** Relative zero over 100 ms replaces the current timed move. */
  gimbalTimedStop: (seq = 0) => gimbal(0x14, [0, 0, 0, 0, 0, 0, 0x04, 1], seq, FLAG_NOTIFY),
  /** `0x04/0x50` GET `01 04 05`. */
  gimbalParamsGet: (seq = 0) => gimbal(0x50, [0x01, 0x04, 0x05], seq),
  setGimbalSpeed: (speed: GimbalSpeed, seq = 0) => gimbal(0x50, [0x00, 0x05, 0x01, speed], seq),
  setGimbalTiltLock: (lock: GimbalTiltLock, seq = 0) => gimbal(0x50, [0x00, 0x04, 0x01, lock], seq),
};

/** `[02 02 00 00][subId u32-LE][00 00 00][innerLen u16-LE][nameLen u16-LE][name][00 00 00 00]`. */
export function subscriptionPayload(name: string, subId: number): Uint8Array {
  const nb = utf8Encode(name);
  return concat([0x02, 0x02, 0x00, 0x00], putU32le(subId), [0, 0, 0], putU16le(nb.length + 6), putU16le(nb.length), nb, [0, 0, 0, 0]);
}

export function whiteBalancePayload(wb: WhiteBalance): number[] {
  const kHundreds = wb.mode === WhiteBalanceMode.auto ? 0 : Math.min(Math.max(Math.trunc(Math.max(wb.kelvin, 0) / 100), 0), 0xffff);
  const t = Math.min(Math.max(wb.tint, -32768), 32767) & 0xffff;
  return [wb.mode, kHundreds & 0xff, kHundreds >> 8, t & 0xff, t >> 8];
}

export const MEDIA_LIST_INTERNAL_COUNTER = 2;
const MEDIA_LIST_TEMPLATE = [
  0x4a, 0x00, 0x2a, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x2d, 0x00, 0x0d, 0x01, 0x00, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00,
];
export const MEDIA_LIST_TRIGGER = [0x4a, 0x04, 0x0e, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00];
export function mediaListPayload(counter: number, cursor: number): number[] {
  const p = MEDIA_LIST_TEMPLATE.slice();
  p[4] = counter & 0xff;
  const c = putU32le(cursor);
  p[10] = c[0];
  p[11] = c[1];
  p[12] = c[2];
  p[13] = c[3];
  return p;
}

/** Choose record vs shutter from the documented mode, not a photo/video boolean. */
export function captureCommand(mode: ShootingMode | null, model: CameraModel | null, isRecording: boolean): DumlFrame {
  if (mode != null && ShootingModes.isPhoto(mode)) return Commands.shootPhoto();
  if (model && (isPocket3(model) || isAction6(model)) && mode != null && ShootingModes.usesShutterTriggerOnPocket3(mode)) {
    return Commands.shutterTrigger(!isRecording);
  }
  return isRecording ? Commands.recordStop() : Commands.recordStart();
}

/** SET frames for a gimbal mode (`GimbalControl.setModeFrames`). */
export function gimbalModeFrames(mode: 'follow' | 'tiltLocked' | 'fpv' | 'directionLock'): DumlFrame[] {
  switch (mode) {
    case 'follow':
      return [Commands.gimbalFollowFamily(), Commands.setGimbalTiltLock(GTL.unlocked)];
    case 'tiltLocked':
      return [Commands.gimbalFollowFamily(), Commands.setGimbalTiltLock(GTL.locked)];
    case 'fpv':
      return [Commands.gimbalFpv()];
    case 'directionLock':
      return [Commands.gimbalDirectionLock()];
  }
}
