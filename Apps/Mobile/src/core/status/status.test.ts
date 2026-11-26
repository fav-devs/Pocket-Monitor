import { describe, expect, it } from 'vitest';
import { fromHex } from '../bytes';
import { Commands } from '../commands/commands';
import { ColorMode, IsoIndex, MINUS_SIGN, EvComp, ShootingMode } from '../commands/vocabulary';
import { BleAdvert } from '../ble/advert';
import { makeFrame } from '../duml/frame';
import { AUDIO_FLOOR_DB, CamAudioStatus } from './audio';
import { activeZoomStops, DEFAULT_MODEL, hasGimbal, needsFirstPictureFormatPoke, resolveModel, supportsZoom, usesCapturedLiveEnable, alternateModel, brandOf, liveViewEnableReceiver, sendsLiveViewPrepare } from './cameraModel';
import { CamCapColorMode, CamCapIso, CamCapShutter, CamCapVideoFormat } from './camCap';
import { CameraStatusDecoder, emptyCameraStatus, StatusQueries, SubscribePush } from './cameraStatus';

const frame = (cmdSet: number, cmdId: number, payload: number[] | Uint8Array, flags = 0) =>
  makeFrame({ sender: 0, receiver: 0, seq: 0, flags, cmdSet, cmdId, payload });
const push = (name: string, value: ArrayLike<number>) => SubscribePush.pack(name, value);

// Ported from OpenCine Tests/OpenCineDJITests/CoreLayerTests.swift
describe('BleAdvert', () => {
  it('pocket 4 pro new format', () => {
    const d = BleAdvert.decode([0, 0, 0, 0xee, 0, 0x04, 0xbd, 0x6e, 0x56, 0x20, 0xda, 0, 0, 0x10]);
    expect(d).toEqual({ modelId: 0x22, newFormat: true, rawProductType: 218 });
  });
  it('classic pocket 4', () => {
    const d = BleAdvert.decode([0x21, 0, 0, 0x58, 0xb8, 0, 0x11, 0x22, 0x33, 0x44]);
    expect(d.modelId).toBe(0x21);
    expect(d.newFormat).toBe(false);
  });
  it('empty is nil', () => {
    expect(BleAdvert.modelId([])).toBeNull();
    expect(BleAdvert.modelId([0, 0])).toBeNull();
  });
  it('manufacturer data with company id', () => {
    expect(BleAdvert.decodeManufacturerData([0xaa, 0x08, 0x21, 0x00])?.modelId).toBe(0x21);
    expect(BleAdvert.decodeManufacturerData([0x4c, 0x00, 0x21, 0x00])).toBeNull();
  });
});

describe('CameraModel', () => {
  it('body capabilities fail closed', () => {
    for (const id of [0x20, 0x21, 0x22]) {
      const m = resolveModel(id, null);
      expect(hasGimbal(m) && supportsZoom(m)).toBe(true);
      expect(m.captureProfile!.supportsTapFocus && m.captureProfile!.supportsFocusMode).toBe(true);
    }
    for (const m of [
      resolveModel(0x19, null),
      resolveModel(0x15, null),
      resolveModel(0x18, null),
      resolveModel(0x17, null),
      resolveModel(0x70, null),
      resolveModel(0x60, 'Mystery'),
      resolveModel(null, 'Some Camera'),
      DEFAULT_MODEL,
    ]) {
      expect(hasGimbal(m)).toBe(false);
      expect(supportsZoom(m)).toBe(false);
      expect(m.captureProfile!.supportsTapFocus).toBe(false);
    }
  });
  it('model resolves to pocket', () => {
    expect(resolveModel(0x22, null).name).toBe('Osmo Pocket 4 Pro');
    expect(resolveModel(0x22, null).datalinkPort).toBe(9004);
    expect(resolveModel(null, 'OsmoPocket3-A1B2').name).toBe('Osmo Pocket 3');
    expect(resolveModel(null, 'OsmoPocket4P-AAAA').name).toBe('Osmo Pocket 4 Pro');
    const nano = resolveModel(0x19, null);
    expect(nano.family).toBe('nano');
    expect(usesCapturedLiveEnable(nano)).toBe(true);
    expect(usesCapturedLiveEnable(DEFAULT_MODEL)).toBe(true);
    expect(usesCapturedLiveEnable(resolveModel(0x15, null))).toBe(false);
    expect(needsFirstPictureFormatPoke(resolveModel(0x20, null))).toBe(true);
    expect(needsFirstPictureFormatPoke(resolveModel(0x21, null))).toBe(false);
    expect(liveViewEnableReceiver(nano)).toBe(0x41);
    expect(liveViewEnableReceiver(resolveModel(0x18, null))).toBe(0x41);
    expect(liveViewEnableReceiver(resolveModel(0x21, null))).toBe(0x08);
    expect(sendsLiveViewPrepare(nano)).toBe(false);
    expect(sendsLiveViewPrepare(resolveModel(0x20, null))).toBe(true);
  });
  it('xtra brand runs 10004 / no poke', () => {
    const edge = resolveModel(0x0015, 'Xtra Edge Pro', brandOf('EC:9E:EA:00:11:22', null));
    expect(edge.name).toBe('Xtra Edge Pro');
    expect(edge.datalinkPort).toBe(10004);
    expect(edge.tcpPoke).toBe(false);
    expect(brandOf(null, 'OsmoPocket3', false)).toBe('dji');
    expect(alternateModel(resolveModel(0x21, null)).datalinkPort).toBe(10004);
  });
  it('pocket 4 pro asks 18x; pocket 3 ceilings per FORMAT', () => {
    expect(activeZoomStops(resolveModel(null, 'Osmo Pocket 4 Pro'), null, 1).slice(-1)[0]).toBe(18);
    const p3 = resolveModel(0x20, null);
    expect(activeZoomStops(p3, 0x0a, 1)).toEqual([1, 2, 4]);
    expect(activeZoomStops(p3, 0x2d, 1)).toEqual([1, 2, 3]);
    expect(activeZoomStops(p3, 0x10, 1)).toEqual([1, 2]);
    expect(activeZoomStops(p3, 0x0a, ShootingMode.slowMo)).toEqual([1]);
  });
});

describe('CameraStatusDecoder', () => {
  it('battery decode', () => {
    const p = new Array(40).fill(0);
    p[1] = 0x10;
    p[2] = 0x0f;
    p[20] = 85;
    p[27] = 1;
    p[32] = 1;
    const s = emptyCameraStatus();
    expect(CameraStatusDecoder.apply(frame(0x0d, 0x02, p), s)).toBe(true);
    expect(s.batteryPercent).toBe(85);
    expect(s.batteryMilliVolts).toBe(3856);
    expect(s.docked && s.charging).toBe(true);
    expect(StatusQueries.chargingReading(s)).toBe(true);
  });
  it('storage decode two stores', () => {
    const p = new Array(40).fill(0);
    const put = (v: number, i: number) => {
      p[i] = v & 0xff;
      p[i + 1] = (v >> 8) & 0xff;
    };
    put(64000, 6);
    put(32000, 10);
    put(48980, 24);
    put(1000, 28);
    const s = emptyCameraStatus();
    expect(CameraStatusDecoder.apply(frame(0x02, 0xdc, p), s)).toBe(true);
    expect([s.sdTotalMb, s.sdFreeMb, s.internalTotalMb]).toEqual([64000, 32000, 48980]);
  });
  it('single store confirms no internal', () => {
    const s = emptyCameraStatus();
    expect(CameraStatusDecoder.apply(frame(0x02, 0xdc, new Array(22).fill(1)), s)).toBe(true);
    expect(s.internalTotalMb).toBe(0);
  });
  it('playback zero storage does not erase known capacity', () => {
    const reported = new Array(22).fill(0);
    reported[7] = 0xfa;
    reported[11] = 0x7d;
    const s = emptyCameraStatus();
    CameraStatusDecoder.apply(frame(0x02, 0xdc, reported), s);
    expect([s.sdTotalMb, s.sdFreeMb]).toEqual([64000, 32000]);
    CameraStatusDecoder.apply(frame(0x02, 0xdc, new Array(22).fill(0)), s);
    expect([s.sdTotalMb, s.sdFreeMb]).toEqual([64000, 32000]);
    const none = emptyCameraStatus();
    CameraStatusDecoder.apply(frame(0x02, 0xdc, new Array(22).fill(0)), none);
    expect([none.sdTotalMb, none.sdFreeMb]).toEqual([0, 0]);
  });
  it('gimbal heartbeat swallowed', () => {
    expect(CameraStatusDecoder.apply(frame(0x04, 0x05, []), emptyCameraStatus())).toBe(true);
  });
  it('state info recording and mode', () => {
    const p = new Array(60).fill(0);
    p[0] = 0x01;
    p[5] = 0x10;
    p[9] = 0x08;
    p[57] = 0x01;
    const s = emptyCameraStatus();
    expect(s.recordingReported).toBe(false);
    expect(CameraStatusDecoder.apply(frame(0x02, 0x80, p), s)).toBe(true);
    expect(s.isRecording).toBe(false);
    expect(s.recordingReported).toBe(true);
    expect(s.shootingMode).toBe(1);
    expect(StatusQueries.shootingMode(s)).toBe(ShootingMode.video);
    p[0] = 0x81;
    p[29] = 8;
    CameraStatusDecoder.apply(frame(0x02, 0x80, p), s);
    expect(s.isRecording).toBe(true);
    expect(s.recordElapsedSec).toBe(8);
  });
  it('expo and fps pushes from live1', () => {
    const expo = new Array(46).fill(0);
    expo[2] = 0x40;
    expo[3] = 0x86;
    expo[5] = 0x04;
    expo[13] = 0xc8;
    expo[16] = 0xc8;
    const s = emptyCameraStatus();
    expect(CameraStatusDecoder.applySubscribePush(push('cam_expo_param', expo), s)).toBe(true);
    expect([s.iso, s.shutterDenom, s.isoIndex]).toEqual([200, 1600, IsoIndex.iso200]);
    expect(s.expoMode).toBeNull();
    expect(s.evComp).toBeNull();
    expo[6] = 0x10;
    expo[7] = 0x04;
    CameraStatusDecoder.applySubscribePush(push('cam_expo_param', expo), s);
    expect(s.expoMode).toBe(0x04);
    expect(s.evComp).toBe(0);
    expo[6] = 0x0f;
    expo[7] = 0x01;
    CameraStatusDecoder.applySubscribePush(push('cam_expo_param', expo), s);
    expect(s.expoMode).toBe(0x01);
    expect(s.evComp).toBe(-1);
    expect(EvComp.label(s.evComp!)).toBe(`${MINUS_SIGN}0.3`);
    CameraStatusDecoder.applySubscribePush(push('cam_video_param_v2', [0x10, 0x02, 0, 0, 0, 2, 1, 0, 0x11, 1]), s);
    expect(s.fps).toBe(25);
    expect(s.videoResolution).toBe(0x10);
    expect(s.videoFormat).toEqual({ resolution: 0x10, frameRate: 0x02 });
  });
  it('subscribe ack is ignored', () => {
    expect(CameraStatusDecoder.apply(frame(0x00, 0x99, [0], 0xc0), emptyCameraStatus())).toBe(false);
  });
  // MimoControlTests status parts
  it('8E GET replies land on status', () => {
    const s = emptyCameraStatus();
    expect(CameraStatusDecoder.apply(frame(2, 0x8e, [0, 0, 1, 0x0f, 0, 1, 7], 0xc0), s)).toBe(true);
    expect(s.isoLimit).toBe(0x07);
    CameraStatusDecoder.apply(frame(2, 0x8e, [0, 0, 1, 0x0f, 0, 1, 9], 0xc0), s);
    expect(s.isoLimit).toBe(0x09);
    CameraStatusDecoder.apply(frame(2, 0x8e, [0, 0, 1, 0x20, 0, 1, 2], 0xc0), s);
    expect(s.audioChannel).toBe(0x02);
    expect(CameraStatusDecoder.apply(frame(2, 0x8e, [0], 0xc0), s)).toBe(false);
    CameraStatusDecoder.apply(frame(2, 0x8e, [0, 0, 1, 0x38, 0, 1, 1], 0xc0), s);
    expect(s.selfieFlip).toBe(1);
    CameraStatusDecoder.apply(frame(2, 0x8e, [0, 0, 1, 0x38, 0, 1, 0], 0xc0), s);
    expect(s.selfieFlip).toBe(0);
    expect(CameraStatusDecoder.apply(frame(2, 0x8e, [0xe3], 0xc0), s)).toBe(false);
    expect(s.selfieFlip).toBe(0);
    CameraStatusDecoder.apply(frame(2, 0x8e, [0, 0, 1, 0x4c, 0, 1, 1], 0xc0), s);
    expect(s.vocalBoost).toBe(1);
    CameraStatusDecoder.apply(frame(2, 0x8e, [0, 0, 1, 0x3b, 0, 2, 1, 2], 0xc0), s);
    expect(s.focusTrack).toBe(2);
  });
  it('audio DSP reply lands on status', () => {
    const blob = new Array(26).fill(0);
    blob[0] = 0xc0;
    blob[1] = 0x04;
    blob[2] = 0xda;
    const s = emptyCameraStatus();
    expect(CameraStatusDecoder.apply(frame(2, 0xa0, [0, ...blob], 0xc0), s)).toBe(true);
    expect(Array.from(s.audioDspBlob!)).toEqual(blob);
    expect(s.audioAdjustment).toEqual({ kind: 'directional', value: 0xda });
    expect(s.windNR).toBe(0x1a);
    expect(s.directionalAudio).toBe(0xda);
    const w = blob.slice();
    w[2] = 0x18;
    const windOnly = emptyCameraStatus();
    CameraStatusDecoder.apply(frame(2, 0xa0, [0, ...w], 0xc0), windOnly);
    expect(windOnly.windNR).toBe(0x18);
    expect(windOnly.directionalAudio).toBeNull();
  });
  it('image effect: colour + white balance', () => {
    const effect = new Array(16).fill(0);
    effect[2] = 0x3f;
    effect[4] = 0x06;
    effect[5] = 0x1e;
    effect[7] = 0xfb;
    effect[8] = 0xff;
    const s = emptyCameraStatus();
    expect(CameraStatusDecoder.applySubscribePush(push('cam_image_effect', effect), s)).toBe(true);
    expect(s.colorMode).toBe(ColorMode.normal);
    expect(s.whiteBalanceKelvin).toBe(3000);
    expect(s.whiteBalanceTint).toBe(-5);
    const autoEffect = new Array(16).fill(0);
    autoEffect[2] = 0x3f;
    autoEffect[5] = 0x2e;
    autoEffect[6] = 0x01;
    autoEffect[7] = 0x14;
    CameraStatusDecoder.applySubscribePush(push('cam_image_effect', autoEffect), s);
    expect(s.whiteBalance).toEqual({ mode: 0, kelvin: 0, tint: 20 });
    expect(s.whiteBalanceKelvin).toBe(3000);
    expect(s.whiteBalanceTint).toBe(20);
  });
  it('lens state: focus mode, lens, zoom', () => {
    const s = emptyCameraStatus();
    expect(CameraStatusDecoder.applySubscribePush(push('cam_lens_state', [0xb2]), s)).toBe(true);
    expect(s.focusMode).toBe(0x02);
    const at12x = [0xff, 0x2f, 0, 0, 0, 0x1b, 0, 0, 1, 0, 0, 0, 0xa8, 0x1b, 0, 0, 1, 0x99, 0x31, 0, 0, 0, 0x1c, 0, 0];
    CameraStatusDecoder.applySubscribePush(push('cam_fov', at12x), s);
    expect(s.zoomFactorRaw).toBe(12287);
    expect(Math.abs(StatusQueries.zoomFactor(s)! - 1)).toBeLessThan(0.01);
    const lensBlob = new Array(16).fill(0);
    lensBlob[0] = 0xb2;
    lensBlob[14] = 0x42;
    lensBlob[15] = 0x0f;
    CameraStatusDecoder.applySubscribePush(push('cam_lens_state', lensBlob), s);
    expect(s.zoomLens).toBe(3906);
    expect(StatusQueries.zoomFactor(s)).toBe(18);
  });
  it('timecode @3..6', () => {
    const s = emptyCameraStatus();
    expect(CameraStatusDecoder.applySubscribePush(push('timecode_info', [0, 0, 0, 5, 0x16, 0x2f, 0x12, 0]), s)).toBe(true);
    expect(s.timecode).toEqual({ hours: 5, minutes: 22, seconds: 47, frames: 18 });
    expect(StatusQueries.timecodeLabel(s)).toBe('05:22:47:18');
  });
  it('firmware version token', () => {
    const s = emptyCameraStatus();
    const bytes = [...'sdk', 0, ...'name', 0, ...'01.02.0300'].map((c) => (typeof c === 'string' ? c.charCodeAt(0) : c));
    expect(CameraStatusDecoder.apply(frame(0, 0, bytes), s)).toBe(true);
    expect(s.firmware).toBe('01.02.0300');
  });
  it('subscribe push round-trips', () => {
    const p = SubscribePush.pack('cam_fov', [1, 2, 3, 4]);
    expect(SubscribePush.parse(p)).toEqual({ name: 'cam_fov', value: Uint8Array.from([1, 2, 3, 4]) });
    const f = Commands.subscribe('cam_fov', 0x69df, 0);
    expect(f.cmdId).toBe(0x99);
  });
});

// Ported from OpenCine Tests/OpenCineDJITests/CamCapTests.swift
describe('CamCap', () => {
  const shutter25p = fromHex(
    '016d000002000101001e00052180be00409f00009900889300a08f00808c00c48900d08700408600e28400e88300208300808200f48100908100408100f08000c88000a080007880006480005080003c80003280002880001e80001980000c80000a8000088000068000058000048000',
  );
  const shutter60p = fromHex(
    '0164000002000101001e00051e80be00409f00009900889300a08f00808c00c48900d08700408600e28400e88300208300808200f48100908100408100f08000c88000a080007880006480005080003c80003280000c80000a8000088000068000058000048000',
  );
  const shutter24p = fromHex(
    '0161000002000101001e00051d80be00409f00009900889300a08f00808c00c48900d08700408600e28400e88300208300808200f48100908100408100f08000c88000a080007880006480005080003c80000c80000a8000088000068000058000048000',
  );
  const isoDLog2 = [1, 8, 0, 0, 6, 3, 4, 5, 6, 7, 8];
  const isoAutoOnly = [1, 3, 0, 0, 1, 0];
  const videoFormatPocket4Pro = fromHex('0125000c1001001002001003001004001005001006000a06000a05000a04000a03000a02000a0100');

  it('25p list differs from 60p', () => {
    const p25 = CamCapShutter.parseDenoms(shutter25p);
    const p60 = CamCapShutter.parseDenoms(shutter60p);
    expect(p25.length && p60.length).toBeTruthy();
    expect(p25).not.toEqual(p60);
    expect(p25).toContain(25);
    expect(p60).not.toContain(25);
    expect(p60).not.toContain(40);
    expect(p60).not.toContain(30);
    expect(p60).toContain(50);
  });
  it('24p-like payload omits 1/50', () => {
    const p24 = CamCapShutter.parseDenoms(shutter24p);
    expect(p24).not.toContain(50);
    expect(p24).toContain(60);
    expect(p24).toContain(4);
  });
  it('wheel cannot offer speed missing from payload', () => {
    const available = CamCapShutter.parseDenoms(shutter60p);
    const wheel = CamCapShutter.wheelDenoms(available, 48);
    expect(wheel).toEqual(available);
    expect(wheel).not.toContain(48);
    expect(CamCapShutter.nearestDenom(48, wheel)).toBe(50);
    expect(CamCapShutter.nearestDenom(25, wheel)).toBe(12);
  });
  it('camera order is preserved and unique', () => {
    const d = CamCapShutter.parseDenoms(shutter25p);
    expect(d[0]).toBe(16000);
    expect(d[d.length - 1]).toBe(4);
    expect(new Set(d).size).toBe(d.length);
  });
  it('subscribe push caches shutter and iso', () => {
    const s = emptyCameraStatus();
    expect(CameraStatusDecoder.applySubscribePush(push('camcap_shutter', shutter25p), s)).toBe(true);
    expect(s.availableShutterDenoms).toContain(50);
    expect(CameraStatusDecoder.applySubscribePush(push('camcap_iso', isoDLog2), s)).toBe(true);
    expect(s.availableIsoIndices).toEqual([3, 4, 5, 6, 7, 8]);
    const before = s.availableShutterDenoms;
    expect(CameraStatusDecoder.applySubscribePush(push('camcap_shutter', [0]), s)).toBe(false);
    expect(s.availableShutterDenoms).toBe(before);
  });
  it('shutter steps open toward slower', () => {
    const d = [16000, 8000, 100, 50, 25, 4];
    expect(CamCapShutter.steppedDenom(50, 1, d)).toBe(25);
    expect(CamCapShutter.steppedDenom(50, -1, d)).toBe(100);
    expect(CamCapShutter.steppedDenom(16000, -1, d)).toBeNull();
    expect(CamCapShutter.steppedDenom(4, 1, d)).toBeNull();
    expect(CamCapShutter.steppedDenom(48, 1, d)).toBe(25);
  });
  it('iso auto only', () => {
    expect(CamCapIso.parseIndices(isoAutoOnly)).toEqual([0]);
    expect(CamCapIso.parseIndices(isoDLog2)).toEqual([3, 4, 5, 6, 7, 8]);
  });
  it('video format table is res/fps pairs', () => {
    const f = CamCapVideoFormat.parse(videoFormatPocket4Pro);
    expect(f.length).toBe(12);
    expect(f[0]).toEqual({ resolution: 0x10, frameRate: 1 });
    expect(f[11]).toEqual({ resolution: 0x0a, frameRate: 1 });
  });
  it('nano colour cap lists three captured modes', () => {
    const nano = resolveModel(0x19, null);
    expect(CamCapColorMode.parse([1, 4, 0, 3, 0, 0x3f, 0x3d], nano)).toEqual([ColorMode.normal, ColorMode.normal10, ColorMode.dLogM]);
  });
  it('pocket 3 fallback formats when no table', () => {
    const p3 = resolveModel(0x20, null);
    expect(CamCapVideoFormat.pickerFormats([], p3, 1).length).toBe(36);
    expect(CamCapVideoFormat.pickerFormats([], p3, 0).length).toBe(5);
    expect(CamCapVideoFormat.pickerFormats([], resolveModel(0x21, null), 1)).toEqual([]);
  });
});

// Ported from OpenCine Tests/OpenCineDJITests/AudioLevelMeterTests.swift
describe('CamAudioStatus', () => {
  const z = (n: number) => new Array(n).fill(0);
  const quiet = [
    0, 0, 0, 2, 0, 3, 0, 2, 0, 2, 0, 0x64, 0, 0x64,
    ...z(13), 0x0a,
    0x08, 0, 0, 0xf4, 0xff, 0x0c, 0, 0x01, ...z(6),
    ...z(14),
    0, 0, 0x0a, 0x08, 0, 0, 0xf4, 0xff, 0x0c, 0, 0x01, 0, 0, 0,
    ...z(14),
    ...z(13), 0x80,
    ...z(14),
    0, 0,
  ];
  const louder = quiet.slice();
  louder[3] = 8;
  louder[7] = 8;
  louder[9] = 9;
  it('fixtures are 114 bytes', () => {
    expect(quiet.length).toBe(114);
  });
  it('captured quiet is above the floor', () => {
    const l = CamAudioStatus.parse(quiet)!;
    const expected = AUDIO_FLOOR_DB * (1 - 2 / 14);
    expect(Math.abs(l.left.levelDB - expected)).toBeLessThan(1e-9);
    expect(Math.abs(l.right.levelDB - expected)).toBeLessThan(1e-9);
  });
  it('captured louder rises above quiet', () => {
    const q = CamAudioStatus.parse(quiet)!;
    const l = CamAudioStatus.parse(louder)!;
    expect(l.left.levelDB).toBeGreaterThan(q.left.levelDB);
    expect(Math.abs(l.left.levelDB - AUDIO_FLOOR_DB * (1 - 8 / 14))).toBeLessThan(1e-9);
    expect(Math.abs(l.right.levelDB - AUDIO_FLOOR_DB * (1 - 9 / 14))).toBeLessThan(1e-9);
  });
  it('fifteen segment fallback', () => {
    const l = CamAudioStatus.parse([7, 5, 11, 9])!;
    expect(Math.abs(l.left.levelDB - AUDIO_FLOOR_DB * (1 - 7 / 14))).toBeLessThan(1e-9);
    expect(Math.abs(l.left.peakDB - AUDIO_FLOOR_DB * (1 - 11 / 14))).toBeLessThan(1e-9);
  });
  it('subscribe push lands on status; unknown until reported', () => {
    const s = emptyCameraStatus();
    expect(s.audioMeters).toBeNull();
    expect(CameraStatusDecoder.apply(frame(0, 0x99, SubscribePush.pack('cam_audio_status_v2', louder), 0xc0), s)).toBe(true);
    expect(s.audioMeters!.right.levelDB).toBeGreaterThan(s.audioMeters!.left.levelDB);
  });
});
