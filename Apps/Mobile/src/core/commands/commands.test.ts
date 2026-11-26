import { describe, expect, it } from 'vitest';
import { isCommandReply, isLiveCameraControl, opcodeKey, shouldHoldReply, FLAG_NOTIFY, FLAG_REQUEST, RX_CAMERA } from '../duml/frame';
import { GimbalStick, GimbalStickMapping } from '../gimbal/stick';
import { resolveModel } from '../status/cameraModel';
import { CamFov } from './camFov';
import { captureCommand, Commands, gimbalModeFrames, subscriptionPayload, SUBSCRIPTION_KEYS } from './commands';
import { AudioDspBlob, CameraParams, CameraReplies, ExpoParam, GimbalPrepRestore, GlamourEffect, parseFocusTrackReply, WhiteBalanceWire } from './control';
import { LivestreamCommands, MulticamCommands, MulticamJoinPolicy, MulticamStationPolicy } from './livestream';
import {
  ColorMode,
  ColorModes,
  EvComp,
  FocusTrackMode,
  GimbalSpeed,
  IsoIndex,
  IsoIndexes,
  IsoLimit,
  isoLimitCeiling,
  isoLimitLabel,
  MINUS_SIGN,
  ShootingMode,
  VideoFormats,
  VideoFrameRate,
  VideoResolution,
  wbAuto,
  wbCustom,
} from './vocabulary';
import { whiteBalancePayload } from './commands';

const arr = (u: ArrayLike<number>) => Array.from(u);

// Ported from OpenCine Tests/OpenCineDJITests/MimoControlTests.swift (command + parser vectors).
describe('camera control builders', () => {
  it('shutter packs u16 denom', () => {
    expect(Commands.setShutter(4).cmdId).toBe(0x28);
    expect(arr(Commands.setShutter(4).payload)).toEqual([0x01, 0x04, 0x80, 0x00, 0x00, 0x00, 0x40]);
    expect(arr(Commands.setShutter(50).payload)).toEqual([0x01, 0x32, 0x80, 0x00, 0x00, 0x00, 0x40]);
    expect(arr(Commands.setShutter(1600).payload)).toEqual([0x01, 0x40, 0x86, 0x00, 0x00, 0x00, 0x40]);
    expect(arr(Commands.setShutter(16000).payload)).toEqual([0x01, 0x80, 0xbe, 0x00, 0x00, 0x00, 0x40]);
    expect(Commands.setShutter(40).receiver).toBe(RX_CAMERA);
    expect(Commands.setShutter(40).flags).toBe(FLAG_REQUEST);
  });
  it('shutter parses expo @2 not @16', () => {
    const expo = new Array(46).fill(0);
    expo[2] = 0x80;
    expo[3] = 0xbe;
    expo[16] = 0xc8;
    expect(ExpoParam.shutterDenom(expo)).toBe(16000);
    expect(ExpoParam.isoValue(expo)).toBe(200);
  });
  it('iso index pack and parse', () => {
    expect(arr(Commands.setIsoIndex(IsoIndex.auto).payload)).toEqual([0]);
    expect(arr(Commands.setIsoIndex(IsoIndex.iso100).payload)).toEqual([3]);
    expect(arr(Commands.setIsoIndex(IsoIndex.iso25600).payload)).toEqual([0x0b]);
    expect(IsoIndexes.value(IsoIndex.iso1600)).toBe(1600);
    const expo = new Array(46).fill(0);
    expo[5] = 0x0b;
    expo[13] = 0xc8;
    expo[17] = 0x64;
    expect(ExpoParam.isoIndex(expo)).toBe(IsoIndex.iso25600);
    expect(ExpoParam.isoValue(expo)).toBe(25600);
  });
  it('ev comp pack and parse', () => {
    expect(Commands.setEv(0).cmdId).toBe(0x2e);
    expect(arr(Commands.setEv(0).payload)).toEqual([0x10]);
    expect(arr(Commands.setEv(EvComp.fromRaw(0x11)!).payload)).toEqual([0x11]);
    expect(arr(Commands.setEv(EvComp.fromRaw(0x0f)!).payload)).toEqual([0x0f]);
    expect(EvComp.fromRaw(0x00)).toBeNull();
    expect(EvComp.label(-9)).toBe(`${MINUS_SIGN}3.0`);
    expect(EvComp.label(9)).toBe('+3.0');
    expect(EvComp.fromLabel('0.0')).toBe(0);
    expect(EvComp.fromLabel('+1.0')).toBe(3);
    expect(EvComp.fromLabel(`${MINUS_SIGN}1.3`)).toBe(-4);
    const expo = new Array(46).fill(0);
    expo[6] = 0x12;
    expo[7] = 0x01;
    expect(ExpoParam.evComp(expo)).toBe(2);
    expect(EvComp.label(2)).toBe('+0.7');
    expect(ExpoParam.expoMode(expo)).toBe(0x01);
  });
  it('iso limit get reply and colour ranges', () => {
    expect(IsoLimit.max800).toBe(0x04);
    expect(isoLimitCeiling(IsoLimit.max800)).toBe(800);
    expect(isoLimitLabel(IsoLimit.max800, 400)).toBe('400–800');
    const reply = [0x00, 0x00, 0x01, 0x0f, 0x00, 0x01, 0x07];
    expect(CameraParams.parseGetReply(reply)).toEqual({ pid: 0x0f, value: 0x07 });
    expect(ColorModes.offersIsoAuto(ColorMode.normal)).toBe(true);
    expect(ColorModes.offersIsoAuto(ColorMode.dLog2)).toBe(false);
    expect(ColorModes.isoAutoLimits(ColorMode.dLog2)).toEqual([]);
    expect(ColorModes.isoIndices(ColorMode.dLog2).includes(IsoIndex.auto)).toBe(false);
  });
  it('colour mode pack (per body)', () => {
    expect(arr(Commands.setColorMode(ColorMode.normal).payload)).toEqual([0x3f]);
    expect(arr(Commands.setColorMode(ColorMode.hdr).payload)).toEqual([0x3c]);
    expect(arr(Commands.setColorMode(ColorMode.dLog).payload)).toEqual([0x17]);
    expect(arr(Commands.setColorMode(ColorMode.dLog2).payload)).toEqual([0x41]);
    expect(arr(Commands.setColorMode(ColorMode.normal10).payload)).toEqual([0x3d]);
    expect(arr(Commands.setColorMode(ColorMode.dLogM).payload)).toEqual([0x00]);
    const nano = resolveModel(0x0019, null);
    expect(arr(Commands.setColorMode(ColorMode.normal, nano).payload)).toEqual([0x00]);
    expect(arr(Commands.setColorMode(ColorMode.normal10, nano).payload)).toEqual([0x3f]);
    expect(arr(Commands.setColorMode(ColorMode.dLogM, nano).payload)).toEqual([0x3d]);
    const effect = new Array(16).fill(0);
    effect[2] = 0x41;
    expect(ColorModes.parseImageEffect(effect)).toBe(ColorMode.dLog2);
  });
  it('focus track is pid 3B', () => {
    expect(arr(Commands.getFocusTrack().payload)).toEqual([0x00, 0x01, 0x3b, 0x00]);
    expect(arr(Commands.setFocusTrack(FocusTrackMode.default).payload)).toEqual([1, 1, 0x3b, 0, 2, 1, 0]);
    expect(arr(Commands.setFocusTrack(FocusTrackMode.registeredPriority).payload)).toEqual([1, 1, 0x3b, 0, 2, 1, 3]);
    expect(parseFocusTrackReply([0, 0, 1, 0x3b, 0, 2, 1, 2])).toBe(FocusTrackMode.subjectLock);
  });
  it('white balance pack and parse', () => {
    expect(Commands.setWhiteBalanceAuto().cmdId).toBe(0x2c);
    expect(arr(Commands.setWhiteBalanceAuto().payload)).toEqual([0, 0, 0, 0, 0]);
    expect(arr(Commands.setWhiteBalanceAuto(20).payload)).toEqual([0, 0, 0, 0x14, 0]);
    expect(arr(Commands.setWhiteBalanceAuto(-25).payload)).toEqual([0, 0, 0, 0xe7, 0xff]);
    expect(whiteBalancePayload({ mode: 0, kelvin: 5600, tint: 20 })).toEqual([0, 0, 0, 0x14, 0]);
    expect(arr(Commands.setWhiteBalanceCustom(3000, 0).payload)).toEqual([0x06, 0x1e, 0, 0, 0]);
    expect(arr(Commands.setWhiteBalanceCustom(4200, 20).payload)).toEqual([0x06, 0x2a, 0, 0x14, 0]);
    expect(arr(Commands.setWhiteBalanceCustom(2000, -5).payload)).toEqual([0x06, 0x14, 0, 0xfb, 0xff]);
    expect(arr(Commands.setWhiteBalanceCustom(10000, 100).payload)).toEqual([0x06, 0x64, 0, 0x64, 0]);
    expect(arr(Commands.setWhiteBalanceCustom(10000, -100).payload)).toEqual([0x06, 0x64, 0, 0x9c, 0xff]);
    const effect = new Array(16).fill(0);
    effect[2] = 0x3f;
    effect[4] = 0x06;
    effect[5] = 0x1e;
    effect[7] = 0xfb;
    effect[8] = 0xff;
    expect(WhiteBalanceWire.parseImageEffect(effect)).toEqual(wbCustom(3000, -5));
    const autoEffect = new Array(16).fill(0);
    autoEffect[4] = 0;
    autoEffect[5] = 0x2e;
    autoEffect[6] = 0x01;
    autoEffect[7] = 0x14;
    expect(WhiteBalanceWire.parseImageEffect(autoEffect)).toEqual(wbAuto(20));
    expect(WhiteBalanceWire.autoKelvin([0, 0, 0, 0, 0, 0x23, 0x04, 0, 0])).toBe(3500);
  });
  it('audio channel / vocal boost / selfie flip 8E', () => {
    expect(arr(Commands.getAudioChannel().payload)).toEqual([0, 1, 0x20, 0]);
    expect(arr(Commands.setAudioChannel(0x02).payload)).toEqual([1, 1, 0x20, 0, 1, 2]);
    expect(arr(Commands.setAudioChannel(0x01).payload)).toEqual([1, 1, 0x20, 0, 1, 1]);
    expect(arr(Commands.setAudioChannel(0x03).payload)).toEqual([1, 1, 0x20, 0, 1, 3]);
    expect(arr(Commands.getVocalBoost().payload)).toEqual([0, 1, 0x4c, 0]);
    expect(arr(Commands.setVocalBoost(1).payload)).toEqual([1, 1, 0x4c, 0, 1, 1]);
    expect(arr(Commands.getSelfieFlip().payload)).toEqual([0, 1, 0x38, 0]);
    const onReply = [0, 0, 1, 0x38, 0, 1, 1];
    expect(CameraParams.isSelfieFlipGetReply(2, 0x8e, onReply)).toBe(true);
    expect(CameraParams.isSelfieFlipGetReply(2, 0x8e, [0, 0, 1, 0x20, 0, 1, 2])).toBe(false);
    expect(CameraParams.isSelfieFlipGetReply(2, 0xa0, onReply)).toBe(false);
    expect(CameraParams.parseGetReply([0x00])).toBeNull();
  });
  it('glamour is pid 39 blob', () => {
    const offReply = [
      0x00, 0x00, 0x01, 0x39, 0x00, 0x3e, 0x0f, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x14, 0x02, 0x00, 0x01,
      0x19, 0x03, 0x00, 0x01, 0x46, 0x04, 0x00, 0x01, 0x32, 0x05, 0x00, 0x01, 0x32, 0x06, 0x00, 0x01, 0x32, 0x07, 0x00,
      0x01, 0x00, 0x08, 0x00, 0x01, 0x00, 0x09, 0x00, 0x01, 0x00, 0x0a, 0x00, 0x01, 0x14, 0x0b, 0x00, 0x01, 0x00, 0x0c,
      0x00, 0x01, 0x00, 0x0d, 0x00, 0x01, 0x00, 0x0e, 0x00, 0x01, 0x00,
    ];
    const off = GlamourEffect.blob(offReply)!;
    expect(off.length).toBe(62);
    expect(GlamourEffect.isEnabled(off)).toBe(false);
    expect(arr(GlamourEffect.disabled(off)!)).toEqual(arr(off));
    const on = Uint8Array.from(off);
    on[5] = 1;
    expect(GlamourEffect.isEnabled(on)).toBe(true);
    expect(arr(GlamourEffect.disabled(on)!)).toEqual(arr(off));
    const set = Commands.setGlamour(on);
    expect(arr(set.payload.slice(0, 5))).toEqual([1, 1, 0x39, 0, 0x3e]);
    expect(arr(set.payload.slice(5))).toEqual(arr(on));
    expect(CameraParams.parseGetReply(offReply)).toBeNull();
  });
  it('audio DSP blob patches only byte 2', () => {
    expect(Commands.audioDspGet().cmdId).toBe(0xa0);
    expect(Commands.audioDspGet().payload.length).toBe(0);
    const blob = new Array(26).fill(0);
    blob[0] = 0xc0;
    blob[1] = 0x04;
    blob[2] = 0xda;
    blob[3] = 0x05;
    expect(arr(AudioDspBlob.blob([0, ...blob])!)).toEqual(blob);
    const windOn = AudioDspBlob.patchWind(blob, 0x1a);
    expect(windOn[2]).toBe(0xda);
    expect(windOn[0]).toBe(0xc0);
    const windBlob = blob.slice();
    windBlob[2] = 0x18;
    expect(AudioDspBlob.patchWind(windBlob, 0x1a)[2]).toBe(0x1a);
    expect(AudioDspBlob.patchDirectional(blob, 0x3a)[2]).toBe(0x3a);
    expect(AudioDspBlob.patchWind(blob, 0x18)[2]).toBe(0x18);
    expect(Commands.audioDspSet(windOn).cmdId).toBe(0x9f);
    expect(AudioDspBlob.wind(0x3a)).toBe(0x1a);
    expect(AudioDspBlob.directional(0x1a)).toBeNull();
  });
  it('video format pack and parse', () => {
    expect(Commands.setVideoFormat({ resolution: VideoResolution.p1080, frameRate: VideoFrameRate.fps24 }).cmdId).toBe(0x18);
    expect(VideoFormats.parseVideoParamV2([0x0a, 0x05, 0, 0, 0, 2, 1, 0, 0x11, 1])).toEqual({ resolution: 0x0a, frameRate: 0x05 });
    expect(VideoFormats.trailer(VideoFrameRate.fps240, ShootingMode.slowMo)).toEqual([0, 8, 0]);
    expect(VideoFormats.trailer(VideoFrameRate.fps120, ShootingMode.slowMo)).toEqual([0, 4, 0]);
    expect(VideoFormats.trailer(VideoFrameRate.fps120, ShootingMode.video)).toEqual([0, 0, 0]);
    expect(VideoFormats.firstPictureEncoderKick({ resolution: 0x10, frameRate: 2 })).toEqual({ resolution: 0x0a, frameRate: 2 });
  });
  it('capture command picks record vs shutter', () => {
    const p3 = resolveModel(0x0020, null);
    const p4 = resolveModel(0x0021, null);
    expect(arr(captureCommand(ShootingMode.photo, p4, false).payload)).toEqual([1]);
    expect(captureCommand(ShootingMode.photo, p4, false).cmdId).toBe(0x01);
    expect(captureCommand(ShootingMode.timeLapse, p3, true).cmdId).toBe(0x01);
    expect(arr(captureCommand(ShootingMode.timeLapse, p3, true).payload)).toEqual([0]);
    expect(captureCommand(ShootingMode.timeLapse, p4, false).cmdId).toBe(0x02);
    expect(arr(captureCommand(ShootingMode.video, p4, true).payload)).toEqual([0]);
  });
  it('shooting mode raw refuses untabled values; photo byte per body', () => {
    expect(Commands.setShootingModeRaw(0x0c)).toBeNull();
    expect(arr(Commands.setShootingModeRaw(0x05)!.payload)).toEqual([0x05]);
    expect(arr(Commands.setShootingMode(ShootingMode.photo, resolveModel(0x0019, null)).payload)).toEqual([0x05]);
    expect(arr(Commands.setShootingMode(ShootingMode.photo, resolveModel(0x0021, null)).payload)).toEqual([0x17]);
    expect(arr(Commands.setShootingMode(ShootingMode.photo).payload)).toEqual([0x17]);
  });
  it('reply oracle', () => {
    expect(CameraReplies.parse([0])).toBe('ok');
    expect(CameraReplies.parse([0xd9])).toBe('wrongState');
    expect(CameraReplies.parse([0xe3])).toBe('badParameter');
    expect(CameraReplies.parse([0xe0])).toBe('unsupported');
    expect(CameraReplies.message(CameraReplies.parse([0x42]))).toBe('camera reply 0x42');
  });
  it('command reply flags and opcode key', () => {
    expect(isCommandReply(0xc0)).toBe(true);
    expect(isCommandReply(0x80)).toBe(true);
    expect(isCommandReply(0x40)).toBe(false);
    expect(opcodeKey(0x02, 0x28)).toBe(0x0228);
    expect(isLiveCameraControl(0x02, 0x2e)).toBe(true);
    expect(isLiveCameraControl(0x02, 0xb8)).toBe(true);
    expect(shouldHoldReply(0x02, 0xa6)).toBe(true);
    expect(isLiveCameraControl(0x09, 0xa8)).toBe(false);
    expect(arr(Commands.setIsoIndex(IsoIndex.iso1600).payload)).toEqual([0x07]);
  });
  it('subscription payload sizes (fov 29, base 30, video_format 38)', () => {
    expect(subscriptionPayload('camcap_fov', 0x69df).length).toBe(29);
    expect(subscriptionPayload('cam_storage', 0x69df).length).toBe(30);
    expect(subscriptionPayload('camcap_video_format', 0x69df).length).toBe(38);
    expect(arr(subscriptionPayload('cam_fov', 0x69df).slice(0, 15))).toEqual([2, 2, 0, 0, 0xdf, 0x69, 0, 0, 0, 0, 0, 13, 0, 7, 0]);
    expect(SUBSCRIPTION_KEYS).toContain('cam_audio_status_v2');
  });
  it('live view enable bytes and receivers', () => {
    const f = Commands.liveViewEnable(0);
    expect(f.receiver).toBe(0x08);
    expect([f.cmdSet, f.cmdId]).toEqual([0x09, 0xa8]);
    expect(arr(f.payload)).toEqual([0, 4, 2, 0, 0, 0, 0, 0, 0, 0]);
    expect(Commands.liveViewEnable(0, Commands.liveViewEnableReceiverNano).receiver).toBe(0x41);
    expect(arr(Commands.liveViewPrepare().payload)).toEqual([0x08]);
    expect(arr(Commands.nanoLiveViewGate(true).payload).slice(-1)).toEqual([3]);
  });
  it('media favourite / delete payloads', () => {
    expect(arr(Commands.deleteMedia(0x11223344, 2).payload)).toEqual([1, 0x44, 0x33, 0x22, 0x11, 2, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]);
    expect(arr(Commands.setMediaFavorite(5, true, 2).payload)).toEqual([1, 1, 5, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0]);
    expect(arr(Commands.setMediaFavorite(5, false, 2, resolveModel(0x0018, null)).payload)).toEqual([
      1, 0, 5, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0,
    ]);
    expect(Commands.mediaList(2, 0x40000000).payload[13]).toBe(0x40);
  });
});

describe('gimbal builders', () => {
  it('flip / modes / stick', () => {
    const flip = Commands.gimbalFlip();
    expect([flip.cmdSet, flip.cmdId]).toEqual([0x04, 0x4c]);
    expect(arr(flip.payload)).toEqual([0xfe, 0x09]);
    expect(flip.receiver).toBe(0x04);
    expect(arr(Commands.gimbalFollowFamily().payload)).toEqual([2, 8]);
    expect(arr(Commands.gimbalFpv().payload)).toEqual([1, 8]);
    const stick = Commands.gimbalStick(GimbalStick.center, GimbalStick.center);
    expect(stick.flags).toBe(FLAG_NOTIFY);
    expect(arr(stick.payload)).toEqual([0, 4, 0, 0, 0, 4, 0, 0x80, 0x22, 0]);
    expect(arr(Commands.gimbalStick(GimbalStick.max, GimbalStick.min).payload)).toEqual([0x26, 0x06, 0, 0, 0xda, 0x01, 0, 0x80, 0x22, 0]);
    expect(arr(Commands.gimbalRecenter().payload)).toEqual([0xfe, 0x08]);
    expect(gimbalModeFrames('tiltLocked').map((f) => arr(f.payload))).toEqual([
      [2, 8],
      [0, 4, 1, 1],
    ]);
  });
  it('stick encoding', () => {
    expect(GimbalStick.sensitivityGain(4)).toBe(1);
    expect(GimbalStick.sensitivityGain(1)).toBe(0.25);
    expect(GimbalStick.clampedSensitivity(0)).toBe(1);
    expect(GimbalStick.clampedSensitivity(9)).toBe(5);
    const slow = GimbalStick.encode(1, 0, { sensitivity: 1 });
    expect(slow.axis0).toBe(1024);
    expect(slow.axis1).toBeGreaterThan(1024);
    expect(slow.axis1).toBeLessThan(GimbalStick.encode(1, 0).axis1);
    expect(GimbalStick.axis(0.8, 5)).toBeGreaterThan(GimbalStick.axis(0.8, 4));
    expect(GimbalStick.axis(1, 5)).toBe(GimbalStick.max);
    expect(GimbalStick.encode(0, 0)).toEqual({ axis0: 1024, axis1: 1024 });
    expect(GimbalStick.axis(1)).toBe(GimbalStick.max);
    expect(GimbalStick.axis(-1)).toBe(GimbalStick.min);
    const linearHalf = Math.round(1024 + 0.5 * 550);
    expect(GimbalStick.axis(0.5)).toBeLessThan(linearHalf);
    expect(GimbalStick.axisLinear(0.5)).toBe(linearHalf);
    expect(GimbalStick.encode(1, 0)).toEqual({ axis0: 1024, axis1: GimbalStick.max });
    expect(GimbalStick.encode(0, 1)).toEqual({ axis0: GimbalStick.max, axis1: 1024 });
    expect(GimbalStick.encode(0, -1)).toEqual({ axis0: GimbalStick.min, axis1: 1024 });
    expect(GimbalStick.encode(1, 0, { invertPan: true })).toEqual({ axis0: 1024, axis1: GimbalStick.min });
    expect(GimbalStick.invertPanFor('selfie')).toBe(true);
    expect(GimbalStick.invertPanFor(null)).toBe(false);
  });
  it('attitude decode', () => {
    const lookDown = [0xb7, 0xfa, 0, 0, 0x01, 0, 0x86, 0, 0x02, 0, 0, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0xb3, 0x01, ...new Array(28).fill(0)];
    expect(GimbalStick.yawTenthDeg(lookDown)).toBe(1);
    expect(GimbalStick.pitchTenthDeg(lookDown)).toBe(-435);
    expect(GimbalStick.i16LE(lookDown, 6)).toBe(134);
    const nearLevel = [...new Array(20).fill(0), 0xf3, 0xff, ...new Array(28).fill(0)];
    expect(GimbalStick.pitchTenthDeg(nearLevel)).toBe(13);
    expect(GimbalStick.pitchTenthDeg(nearLevel.slice(0, 22))).toBeNull();
    expect(GimbalStick.yawTenthDeg([...lookDown, 0])).toBeNull();
    expect(GimbalStick.nativePitchTenthDeg(lookDown)).toBe(-1353);
    expect(GimbalStick.attitudeAngleDump([0x10, 0x06, 0, 0, 0x13, 0])).toContain('@4=19');
    const ignored = new GimbalStickMapping({ yawTenthDeg: 5, pitchTenthDeg: 7 });
    ignored.applyAttitude(lookDown.slice(0, 22));
    expect([ignored.yawTenthDeg, ignored.pitchTenthDeg]).toEqual([5, 7]);
    const pitched = new GimbalStickMapping();
    const att = new Array(50).fill(0);
    att[4] = 0xe8;
    att[5] = 0x03;
    att[20] = 0x30;
    att[21] = 0xf8;
    pitched.applyAttitude(att);
    expect(pitched.yawTenthDeg).toBe(1000);
    expect(pitched.pitchTenthDeg).toBe(2000);
    expect(pitched.commanded180).toBe(true);
  });
  it('emit cadence', () => {
    expect(GimbalStick.shouldEmit(true, false, 1, 0)).toBe(true);
    expect(GimbalStick.shouldEmit(true, false, 1.02, 1)).toBe(false);
    expect(GimbalStick.shouldEmit(true, false, 1.04, 1)).toBe(true);
    expect(GimbalStick.shouldEmit(false, true, 1.01, 1)).toBe(true);
    expect(GimbalStick.shouldEmitOnSocket(true, false, true)).toBe(true);
    expect(GimbalStick.shouldEmitOnSocket(false, false, true)).toBe(false);
    expect(GimbalStick.shouldEmitOnSocket(true, true, false)).toBe(false);
  });
  it('timed target', () => {
    const f = Commands.gimbalTimedTarget(10, -5.5, 1.2)!;
    expect(f.cmdId).toBe(0x14);
    expect(arr(f.payload)).toEqual([100, 0, 0, 0, 0xc9, 0xff, 0x05, 12]);
    expect(Commands.gimbalTimedTarget(300, 0, 1)).toBeNull();
    expect(Commands.gimbalTimedTarget(0, 0, 0.05)).toBeNull();
    expect(Commands.gimbalTimedTarget(0, 0, 1.25)).toBeNull();
    expect(Commands.gimbalTimedTarget(0, 200, 1)).toBeNull();
    expect(Commands.gimbalTimedTarget(0, 200, 1, 0, 'continuous')).not.toBeNull();
  });
  it('prep restore', () => {
    const r = new GimbalPrepRestore();
    expect(r.prep(GimbalSpeed.slow, 'tiltLocked').map((f) => arr(f.payload))).toEqual([
      [0, 4, 1, 0],
      [0, 5, 1, 0],
    ]);
    r.prep(GimbalSpeed.fast, 'follow');
    expect(r.restore(false, 10)).toBeNull();
    const out = r.restore(false, 11)!;
    expect(out.speed).toBe(GimbalSpeed.slow);
    expect(out.frames.map((f) => arr(f.payload))).toEqual([
      [0, 5, 1, 2],
      [0, 4, 1, 1],
    ]);
    expect(r.isHolding).toBe(false);
  });
});

describe('CamFov', () => {
  const atWide = [0x25, 0x09, 0, 0, 0x25, 0x05, 0, 0, 1, 0, 0, 0, 0x3b, 0x3e, 0, 0, 1, 0xe8, 0x12, 0, 0, 0xac, 0x0a, 0, 0];
  const at12x = [0xff, 0x2f, 0, 0, 0, 0x1b, 0, 0, 1, 0, 0, 0, 0xa8, 0x1b, 0, 0, 1, 0x99, 0x31, 0, 0, 0, 0x1c, 0, 0];
  it('parses factor at 0', () => {
    expect(CamFov.rawAt0(atWide)).toBe(2341);
    expect(Math.abs(CamFov.factor(atWide)! - 12)).toBeLessThan(0.01);
    expect(CamFov.rawAt0(at12x)).toBe(CamFov.rawAt1x);
    expect(CamFov.displayLabel(CamFov.factorFromRaw(CamFov.rawAt1x))).toBe('1×');
    expect(CamFov.displayLabel(CamFov.factorFromRaw(CamFov.rawAt12x))).toBe('12×');
    expect(Math.abs(CamFov.factorFromRaw(CamFov.rawAt3x) - 3)).toBeLessThan(0.02);
    for (const [f, l] of [
      [2.29, '2.3×'],
      [5.3, '5.3×'],
      [5.34, '5.3×'],
      [5.36, '5.4×'],
      [2.89, '2.9×'],
      [2.9, '2.9×'],
      [2.95, '3×'],
    ] as const)
      expect(CamFov.displayLabel(f)).toBe(l);
    expect([2.3, 3, 6, 12].map((f) => CamFov.nextJump(f))).toEqual([3, 6, 12, 1]);
    expect(CamFov.lensPosition(2.2)).toBe(477);
    expect(CamFov.lensPosition(6.7)).toBe(1454);
    expect(arr(Commands.setZoomLens(217).payload)).toEqual([0x0a, 0x4e, 0xd9, 0]);
    expect(arr(Commands.setZoomLens(2604).payload)).toEqual([0x0a, 0x4e, 0x2c, 0x0a]);
    expect(arr(Commands.setZoom(2.2).payload)).toEqual([0x0a, 0x4e, 0xdd, 0x01]);
    expect(arr(Commands.setZoom(6.7).payload)).toEqual([0x0a, 0x4e, 0xae, 0x05]);
    expect(arr(Commands.setZoom(3).payload)).toEqual([0x0a, 0x4e, 0x8b, 0x02]);
    expect(arr(Commands.setZoom(18).payload)).toEqual([0x0a, 0x4e, 0x42, 0x0f]);
    expect(arr(Commands.setZoomSlew(300).payload)).toEqual([3, 0, 0x2c, 1]);
    expect(CamFov.chipWrite(6)).toEqual({ kind: 'lens', value: CamFov.lens6x });
    expect(CamFov.holdZoomWrite(1.02, ColorMode.dLog2, false)).toBe(true);
    expect(CamFov.holdZoomWrite(1.1, ColorMode.dLog, false)).toBe(false);
    expect(CamFov.holdZoomWrite(1, ColorMode.dLog2, false)).toBe(false);
    expect(CamFov.colorModeForZoom(3, ColorMode.dLog2)).toBe(ColorMode.dLog);
    expect(CamFov.colorModeForZoom(1, ColorMode.dLog2)).toBeNull();
    expect(CamFov.zoomNeedsColorHopWhileRecording(1.1, ColorMode.dLog2, true)).toBe(true);
    expect(CamFov.zoomNeedsColorHopWhileRecording(3, ColorMode.dLog2, false)).toBe(false);
    expect(CamFov.shouldRestoreDLog2(1)).toBe(true);
    expect(CamFov.shouldRestoreDLog2(2.9)).toBe(false);
    const lensBlob = new Array(16).fill(0);
    lensBlob[14] = 0xd9;
    expect(CamFov.lensAt14(lensBlob)).toBe(217);
  });
  it('hybrid readout snaps tele and ticks tenths', () => {
    expect(CamFov.displayTenths(2.286)).toBe(2.3);
    expect(CamFov.displayTenths(2.95)).toBe(3);
    expect(CamFov.readout(5.36, null, 1)).toBe(5.4);
    expect(CamFov.readout(2.29, 5.3, 1)).toBe(5.3);
    expect(CamFov.continuousReadout(1.534, null, 1)).toBe(1.534);
    expect(CamFov.readout(1, 1.53, 1)).toBe(1.5);
    expect(CamFov.isJumpStop(1) && CamFov.isJumpStop(12)).toBe(true);
    expect(CamFov.isJumpStop(2.3)).toBe(false);
    expect(Math.abs(CamFov.pinchFactor(2.3, 1.1) - 2.53)).toBeLessThan(0.001);
    expect(CamFov.pinchLens(2.15)).not.toBe(CamFov.pinchLens(2.16));
    expect(CamFov.matches(12, 12)).toBe(true);
    expect(CamFov.matches(3, 12)).toBe(false);
    expect(CamFov.shouldHoldWatchdog(3.9)).toBe(true);
    expect(CamFov.shouldHoldWatchdog(4)).toBe(false);
    expect(CamFov.shouldHoldWatchdog(8, null, true)).toBe(true);
    let last = -1;
    for (let t = 10; t <= 120; t++) {
      const f = t / 10;
      expect(CamFov.displayTenths(f)).toBe(f);
      const lens = CamFov.pinchLens(f);
      expect(lens).toBeGreaterThan(last);
      last = lens;
    }
  });
});

// Ported from LivestreamCommandsTests.swift + MulticamTests (goldens re-derived from the Swift
// builders since the TSV fixture is not in the upstream checkout).
describe('livestream / multicam', () => {
  const url = 'rtmp://172.20.10.1:1935/live/abcd';
  it('frames', () => {
    expect(arr(LivestreamCommands.prepare(1).payload)).toEqual([0x1a]);
    expect(LivestreamCommands.prepare(1).receiver).toBe(8);
    expect(arr(LivestreamCommands.start(2).payload)).toEqual([1, 1, 0x1a, 0, 1, 1]);
    expect(arr(LivestreamCommands.end(3).payload)).toEqual([1, 1, 0x1a, 0, 1, 2]);
    const p3 = LivestreamCommands.preset(25, 6000);
    expect(p3).toEqual([0x0a, 0x70, 0x17, 0x02, 0x01, 0x02, 0, 0, 0]);
    const v0 = LivestreamCommands.configureDirectURL(url, p3, 6);
    expect([v0.cmdSet, v0.cmdId]).toEqual([0x08, 0x78]);
    expect(v0.payload[0]).toBe(0);
    expect(v0.payload[1] | (v0.payload[2] << 8)).toBe(9 + 2 + url.length);
    const v1 = LivestreamCommands.configureJSON(url, LivestreamCommands.preset(30, 6000), 'HEVC', 4);
    expect(v1.payload[0]).toBe(1);
    expect(LivestreamCommands.settingsJSON(url, 'HEVC')).toBe(
      '{"rtmpAddress":"rtmp:\\/\\/172.20.10.1:1935\\/live\\/abcd","codec":"HEVC","EnhancedRTMP":true,"supportStopLive":false,"watermark":0,"orientation":"landscape"}',
    );
    expect(() => LivestreamCommands.configureDirectURL('rtmp://' + 'a'.repeat(300), p3, 1)).toThrow('urlTooLong');
  });
  it('multicam join and station policy', () => {
    expect(() => MulticamCommands.join('', 'x', 1)).toThrow();
    expect(arr(MulticamCommands.join('ab', 'cd', 1).payload)).toEqual([2, 0x61, 0x62, 2, 0x63, 0x64]);
    expect(MulticamJoinPolicy.decision([0, 0], 1)).toBe('connected');
    expect(MulticamJoinPolicy.decision([1, 0xff], 1)).toBe('retry');
    expect(MulticamJoinPolicy.decision([1, 0xff], 3)).toBe('rejected');
    expect(MulticamStationPolicy.decision([0, 1], false)).toBe('alreadyStation');
    expect(MulticamStationPolicy.decision([0, 8], false)).toBe('setAndVerify');
    expect(MulticamStationPolicy.decision([0xe0], true)).toBe('setWithoutReadback');
    expect(MulticamStationPolicy.accessPointRestored([0, 8], [0, 8])).toBe(true);
    expect(MulticamStationPolicy.accessPointRestored(null, [0, 8])).toBe(false);
  });
});
