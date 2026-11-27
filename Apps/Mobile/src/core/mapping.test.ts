import { describe, expect, it } from 'vitest';
import { initialCameraState } from '../camera/defaults';
import { fromHex } from './bytes';
import { makeFrame } from './duml/frame';
import {
  capabilitiesOf,
  evToThirds,
  formatOptions,
  mapCameraState,
  modelIdOf,
  resolutionLabel,
  thirdsToEv,
  uiColorMode,
  uiShootingMode,
  wireColorMode,
  wireIsoIndex,
  wireShootingMode,
} from './mapping';
import { ColorMode, IsoIndex, ShootingMode } from './commands/vocabulary';
import { resolveModel } from './status/cameraModel';
import { CameraStatusDecoder, emptyCameraStatus, SubscribePush } from './status/cameraStatus';

const push = (name: string, v: ArrayLike<number>) => makeFrame({ sender: 0, receiver: 0, seq: 0, flags: 0, cmdSet: 0, cmdId: 0x99, payload: SubscribePush.pack(name, v) });

describe('mapping', () => {
  it('model ids and capabilities', () => {
    expect(modelIdOf(resolveModel(0x20, null))).toBe('osmo-pocket-3');
    expect(modelIdOf(resolveModel(0x21, null))).toBe('osmo-pocket-4');
    expect(modelIdOf(resolveModel(0x22, null))).toBe('osmo-pocket-4-pro');
    expect(modelIdOf(resolveModel(0x19, null))).toBe('osmo-nano');
    expect(modelIdOf(resolveModel(0x18, null))).toBe('osmo-action-6');
    expect(modelIdOf(resolveModel(0x15, null))).toBe('unknown');
    const nano = capabilitiesOf(resolveModel(0x19, null));
    expect(nano.gimbal || nano.zoom || nano.tracking).toBe(false);
    expect(capabilitiesOf(resolveModel(0x18, null)).aperture).toBe(true);
    expect(capabilitiesOf(resolveModel(0x22, null)).gimbal).toBe(true);
  });
  it('value maps round-trip', () => {
    for (const m of [ShootingMode.video, ShootingMode.photo, ShootingMode.slowMo, ShootingMode.timeLapse, ShootingMode.hyperLapse, ShootingMode.superNight]) {
      expect(wireShootingMode(uiShootingMode(m))).toBe(m);
    }
    expect(wireShootingMode('panorama')).toBeNull();
    for (const c of [ColorMode.normal, ColorMode.hdr, ColorMode.dLog, ColorMode.dLog2, ColorMode.dLogM, ColorMode.normal10]) {
      expect(wireColorMode(uiColorMode(c)!)).toBe(c);
    }
    expect(evToThirds(-0.3)).toBe(-1);
    expect(evToThirds(0.7)).toBe(2);
    expect(thirdsToEv(-4)).toBe(-1.3);
    expect(evToThirds(9)).toBe(9);
    expect(wireIsoIndex('auto')).toBe(IsoIndex.auto);
    expect(wireIsoIndex(800)).toBe(IsoIndex.iso800);
    expect(wireIsoIndex(640, [IsoIndex.iso400, IsoIndex.iso800])).toBe(IsoIndex.iso800);
    expect(resolutionLabel(0x0a)).toBe('1080p');
    expect(resolutionLabel(0x67)).toBe('4K 4:3');
  });
  it('format options group camcap pairs', () => {
    const opts = formatOptions([
      { resolution: 0x10, frameRate: 1 },
      { resolution: 0x10, frameRate: 6 },
      { resolution: 0x0a, frameRate: 3 },
      { resolution: 0x10, frameRate: 3 },
    ]);
    expect(opts).toEqual([
      { resolution: '4K', width: 3840, height: 2160, fps: [24, 30, 60], aspect: '16:9' },
      { resolution: '1080p', width: 1920, height: 1080, fps: [30], aspect: '16:9' },
    ]);
  });
  it('decoded status lands on the UI state', () => {
    const model = resolveModel(0x22, null);
    const s = emptyCameraStatus();
    const expo = new Array(46).fill(0);
    expo[2] = 0x40;
    expo[3] = 0x86; // 1/1600
    expo[5] = 0x04;
    expo[6] = 0x12; // +0.7
    expo[7] = 0x04; // manual
    expo[16] = 0xc8; // ISO 200
    CameraStatusDecoder.apply(push('cam_expo_param', expo), s, model);
    CameraStatusDecoder.apply(push('cam_video_param_v2', [0x10, 0x02, 0, 0, 0, 2, 1, 0, 0x11, 1]), s, model);
    const effect = new Array(16).fill(0);
    effect[2] = 0x17; // D-Log
    effect[4] = 0x06;
    effect[5] = 0x38; // 5600K
    CameraStatusDecoder.apply(push('cam_image_effect', effect), s, model);
    CameraStatusDecoder.apply(push('camcap_video_format', fromHex('0125000c1001001002001003001004001005001006000a06000a05000a04000a03000a02000a0100')), s, model);
    const st = new Array(60).fill(0);
    st[0] = 0x81;
    st[5] = 0x10;
    st[29] = 12;
    st[57] = 0x01;
    CameraStatusDecoder.apply(makeFrame({ sender: 0, receiver: 0, seq: 0, flags: 0, cmdSet: 2, cmdId: 0x80, payload: st }), s, model);
    const bat = new Array(40).fill(0);
    bat[20] = 64;
    CameraStatusDecoder.apply(makeFrame({ sender: 0, receiver: 0, seq: 0, flags: 0, cmdSet: 0x0d, cmdId: 2, payload: bat }), s, model);
    const lens = new Array(16).fill(0);
    lens[0] = 0xb1;
    lens[14] = 0x8b;
    lens[15] = 0x02; // 651 = 3×
    CameraStatusDecoder.apply(push('cam_lens_state', lens), s, model);

    const prev = initialCameraState('osmo-pocket-4-pro');
    const ui = mapCameraState(prev, { status: s, model, gimbal: { mode: 'tiltLocked', yawTenthDeg: 125, pitchTenthDeg: -40 } });
    expect(ui.exposure.mode).toBe('manual');
    expect(ui.exposure.iso).toBe(200);
    expect(ui.exposure.isoAuto).toBe(false);
    expect(ui.exposure.shutterDenom).toBe(1600);
    expect(ui.exposure.ev).toBe(0.7);
    expect(ui.exposure.isoLimitOptions).toEqual([800, 1600, 3200, 6400]);
    expect(ui.format.resolution).toBe('4K');
    expect(ui.format.fps).toBe(25);
    expect(ui.format.colorMode).toBe('dlog');
    expect(ui.format.colorModeOptions).toEqual(['normal', 'hlg', 'dlog', 'dlog2']);
    expect(ui.format.options.map((o) => o.resolution)).toEqual(['4K', '1080p']);
    expect(ui.format.shootingMode).toBe('video');
    expect(ui.whiteBalance.preset).toBe('custom');
    expect(ui.whiteBalance.kelvin).toBe(5600);
    expect(ui.recording.recording).toBe(true);
    expect(ui.recording.elapsedSec).toBe(12);
    expect(ui.power.batteryPercent).toBe(64);
    expect(ui.focus.mode).toBe('afs');
    expect(ui.zoom.factor).toBe(3);
    expect(ui.zoom.stops).toEqual([1, 3, 6, 12, 18]);
    expect(ui.zoom.opticalMax).toBe(3);
    expect(ui.gimbal.mode).toBe('tilt-locked');
    expect(ui.gimbal.yaw).toBe(12.5);
    expect(ui.gimbal.pitch).toBe(-4);
    expect(ui.capabilities.gimbal).toBe(true);
    expect(prev.exposure.mode).toBe('auto'); // pure: input untouched
  });
  it('audio meters map to dBFS with silence at -120', () => {
    const s = emptyCameraStatus();
    s.audioMeters = { left: { levelDB: -60, peakDB: -30 }, right: { levelDB: -12, peakDB: -6 } };
    s.audioChannel = 0x01;
    s.windNR = 0x1a;
    s.directionalAudio = 0x3a;
    const ui = mapCameraState(initialCameraState(), { status: s, model: null });
    expect(ui.audio.left).toEqual({ rmsDb: -120, peakDb: -30 });
    expect(ui.audio.right).toEqual({ rmsDb: -12, peakDb: -6 });
    expect(ui.audio.channel).toBe('mono');
    expect(ui.audio.windReduction).toBe(true);
    expect(ui.audio.directional).toBe('front');
  });
});
