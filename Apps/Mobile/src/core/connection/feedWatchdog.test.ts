import { describe, expect, it } from 'vitest';
import { GimbalStick } from '../gimbal/stick';
import { FeedWatchdog, watchdogSnapshot, type WatchdogSnapshot } from './feedWatchdog';

// Ported from OpenCine Tests/OpenCineCameraVocabularyTests/FeedWatchdogTests.swift
function snap(o: {
  now: number;
  frameAge: number;
  videoAge?: number | null;
  statusAge?: number | null;
  sawPicture?: boolean;
  displayedImageRemoved?: boolean;
  bleAge?: number | null;
  hadVideo?: boolean;
}): WatchdogSnapshot {
  const hadVideo = o.hadVideo ?? true;
  return watchdogSnapshot({
    now: o.now,
    lastDecodedFrameAge: o.frameAge,
    lastVideoPacketAge: o.videoAge !== undefined ? o.videoAge : hadVideo ? o.frameAge : null,
    lastStatusAge: o.statusAge !== undefined ? o.statusAge : 0.2,
    flowHealthy: true,
    pathReady: true,
    hasFormat: true,
    decoderFailed: false,
    live: true,
    sawPicture: o.sawPicture ?? true,
    displayedImageRemoved: o.displayedImageRemoved ?? false,
    lastBleNotifyAge: o.bleAge ?? null,
    hadVideo,
  });
}

describe('FeedWatchdog', () => {
  it('packet-only traffic uses bounded enable ladder when complete pictures stop', () => {
    const dog = new FeedWatchdog();
    const s = snap({ now: 100, frameAge: 3, videoAge: 0.01 });
    s.lastAccessUnitAge = 3;
    s.decoderOutputExpected = true;
    s.lastDecoderOutputAge = 3;
    expect(dog.tick(s)).toBe('resendLiveViewEnable');
    s.now = 101;
    expect(dog.tick(s)).toBe('none');
    s.now = 105;
    expect(dog.tick(s)).toBe('reopenDatalink');
    s.now = 106;
    s.lastAccessUnitAge = 0.01;
    s.lastDecoderOutputAge = 0.01;
    s.lastDecodedFrameAge = 0.01;
    expect(dog.tick(s)).toBe('none');
    expect(dog.stage).toBe('idle');
  });
  for (const hasFormat of [true, false]) {
    it(`continuous input with silent decoder requests one owned repair (hasFormat=${hasFormat})`, () => {
      const dog = new FeedWatchdog();
      const s = snap({ now: 100, frameAge: 3, videoAge: 0.01 });
      s.lastAccessUnitAge = 0.01;
      s.decoderOutputExpected = true;
      s.lastDecoderOutputAge = 3;
      s.hasFormat = hasFormat;
      expect(dog.tick(s)).toBe('rebuildVTSession');
      for (let sec = 1; sec < 16; sec++) {
        s.now = 100 + sec;
        s.lastDecoderOutputAge = 3 + sec;
        expect(dog.tick(s)).toBe('none');
      }
      s.now = 116;
      expect(dog.tick(s)).toBe('fullSessionRejoin');
    });
  }
  it('decoder repair resends keyframe then rebuilds endpoint', () => {
    const st = FeedWatchdog.decoderRepairStep;
    expect(st(1.9, 1.9, null, 1)).toBe('wait');
    expect(st(2, 2, null, 1)).toBe('resendKeyframe');
    expect(st(2, 2, 5, 1)).toBe('resendKeyframe');
    expect(st(3.9, 1.9, null, 2)).toBe('wait');
    expect(st(4, 2, null, 2)).toBe('rebuildEndpoint');
    expect(st(4, 2, 0.5, 2)).toBe('wait');
    expect(st(15.9, 15.9, 12, 1)).toBe('wait');
    expect(st(16, 16, 12, 1)).toBe('deadline');
    expect(st(16, 3, null, 1)).toBe('deadline');
  });
  it('session recovery holds while video packets arrive; bounded cycles', () => {
    expect(FeedWatchdog.shouldHoldSessionRecovery(0.03)).toBe(true);
    expect(FeedWatchdog.shouldHoldSessionRecovery(2)).toBe(false);
    expect(FeedWatchdog.shouldHoldSessionRecovery(null)).toBe(false);
    const next = (p: number, picture = false, video: number | null = 0.05) => FeedWatchdog.nextSessionHoldCycles(video, p, picture);
    expect([next(0), next(1), next(2), next(2, true), next(1, false, 2.5), next(0, false, null)]).toEqual([1, 2, 0, 1, 0, 0]);
  });
  it('missing format does not bypass startup readiness or grace', () => {
    const base = () => {
      const s = snap({ now: 100, frameAge: 3, videoAge: 0.01 });
      s.lastAccessUnitAge = 0.01;
      s.decoderOutputExpected = true;
      s.lastDecoderOutputAge = 3;
      s.hasFormat = false;
      return s;
    };
    const holds: Array<(s: WatchdogSnapshot) => void> = [
      (s) => (s.sawPicture = false),
      (s) => (s.decoderOutputExpected = false),
      (s) => (s.repairReady = false),
      (s) => (s.pathReady = false),
      (s) => (s.secondsSinceCameraSet = 0.1),
      (s) => (s.secondsSinceLastEnable = 0.1),
      (s) => (s.gimbalStickHeld = true),
      (s) => (s.zoomPinchActive = true),
      (s) => (s.lastDecoderOutputAge = 0.01),
    ];
    for (const h of holds) {
      const s = base();
      h(s);
      const dog = new FeedWatchdog();
      expect(dog.tick(s)).toBe('none');
      expect(dog.stage).toBe('idle');
    }
  });
  it('ignores hitch shorter than stall; waits for first picture while video flows', () => {
    const dog = new FeedWatchdog();
    expect(dog.tick(snap({ now: 10, frameAge: 1.5 }))).toBe('none');
    expect(dog.tick(snap({ now: 10, frameAge: 8, videoAge: 0.3, sawPicture: false }))).toBe('none');
    expect(dog.stage).toBe('idle');
  });
  it('packets flowing do not rejoin when present stuck', () => {
    const dog = new FeedWatchdog();
    const s = snap({ now: 10, frameAge: 2.6, videoAge: 0 });
    s.lastAccessUnitAge = 0;
    s.lastBleNotifyAge = 0.2;
    expect(dog.tick(s)).toBe('none');
    s.displayedImageRemoved = true;
    s.lastDecodedFrameAge = 4;
    expect(dog.tick(s)).toBe('none');
    expect(dog.stage).toBe('idle');
  });
  it('AF-C hunt / zoom slew with fresh status does not tear UDP', () => {
    const dog = new FeedWatchdog();
    const s = snap({ now: 10, frameAge: 4.2, videoAge: 4.2, statusAge: 0.3, bleAge: 0.2 });
    s.secondsSinceLastEnable = 20;
    s.secondsSinceFocusTrackSet = 1;
    expect(dog.tick(s)).toBe('none');
    expect(FeedWatchdog.controlReceiveAlive(s)).toBe(true);
    expect(FeedWatchdog.udpReceiveAlive(s)).toBe(false);
    s.secondsSinceFocusTrackSet = null;
    s.secondsSinceZoomSet = 1;
    expect(dog.tick(s)).toBe('none');
    s.secondsSinceZoomSet = 4.1;
    expect(dog.tick(s)).toBe('resendLiveViewEnable');
  });
  for (const gimbal of [false, true]) {
    it(`held control does not GOP-cut while finger is down (gimbal=${gimbal})`, () => {
      const dog = new FeedWatchdog();
      const s = snap({ now: 10, frameAge: 8, videoAge: 8, statusAge: 0.3, bleAge: 0.2 });
      s.secondsSinceLastEnable = 20;
      if (gimbal) {
        s.secondsSinceGimbalThrow = 8;
        s.gimbalStickHeld = true;
      } else {
        s.secondsSinceZoomSet = 8;
        s.zoomPinchActive = true;
      }
      expect(dog.tick(s)).toBe('none');
      s.gimbalStickHeld = false;
      s.zoomPinchActive = false;
      expect(dog.tick(s)).toBe('resendLiveViewEnable');
    });
  }
  it('gimbal throw holds encoder pause enable', () => {
    const dog = new FeedWatchdog();
    const s = snap({ now: 10, frameAge: 4.2, videoAge: 4.2, statusAge: 0.3, bleAge: 0.2 });
    s.secondsSinceLastEnable = 20;
    s.secondsSinceGimbalThrow = 1;
    expect(dog.tick(s)).toBe('none');
    expect(GimbalStick.shouldHoldWatchdog(2.9)).toBe(true);
    expect(GimbalStick.shouldHoldWatchdog(3)).toBe(false);
    expect(GimbalStick.shouldHoldWatchdog(0.1, 4.2)).toBe(true);
    expect(GimbalStick.shouldHoldWatchdog(0.1, 5.1)).toBe(false);
    s.secondsSinceGimbalThrow = 3.1;
    expect(dog.tick(s)).toBe('resendLiveViewEnable');
    const held = snap({ now: 10, frameAge: 5.1, videoAge: 5.1, statusAge: 0.3, bleAge: 0.2 });
    held.secondsSinceLastEnable = 20;
    held.secondsSinceGimbalThrow = 0.1;
    expect(new FeedWatchdog().tick(held)).toBe('resendLiveViewEnable');
  });
  it('packets without complete pictures do not renew the enable hold', () => {
    const dog = new FeedWatchdog();
    const s = snap({ now: 100, frameAge: 9, videoAge: 0.01 });
    s.lastAccessUnitAge = 9;
    s.decoderOutputExpected = true;
    s.lastDecoderOutputAge = 9;
    s.secondsSinceLastEnable = 5;
    expect(FeedWatchdog.shouldHoldForGOPReset(5, 9)).toBe(false);
    expect(dog.tick(s)).toBe('resendLiveViewEnable');
  });
  it('encoder pause with fresh status resends enable once per rung', () => {
    const dog = new FeedWatchdog();
    const s = snap({ now: 10, frameAge: 4.2, videoAge: 4.2, statusAge: 0.3, bleAge: 0.2 });
    s.secondsSinceLastEnable = 20;
    expect(dog.tick(s)).toBe('resendLiveViewEnable');
    s.now = 11;
    expect(dog.tick(s)).toBe('none');
    expect(dog.stage).toBe('resendEnable');
  });
  it('enable that produces no HEVC rebuilds UDP after one enable, then rejoins', () => {
    const dog = new FeedWatchdog();
    const s = snap({ now: 10, frameAge: 2.8, videoAge: 2.8, statusAge: 0, bleAge: 70 });
    s.secondsSinceLastEnable = 20;
    expect(dog.tick(s)).toBe('resendLiveViewEnable');
    const step = (now: number, age: number, enable: number, rebuild: number | null = null) => {
      s.now = now;
      s.lastDecodedFrameAge = s.lastVideoPacketAge = s.lastAccessUnitAge = age;
      s.lastStatusAge = 0;
      s.secondsSinceLastEnable = enable;
      s.secondsSinceLastRebuild = rebuild;
      return dog.tick(s);
    };
    expect(step(11.4, 4.2, 1.4)).toBe('none');
    expect(step(11.5, 4.3, 1.5)).toBe('reopenDatalink');
    expect(dog.isRecovering).toBe(true);
    expect(step(13.6, 6.4, 2.1, 2.1)).toBe('none');
    expect(step(16.6, 9.4, 5.1, 5.1)).toBe('fullSessionRejoin');
    expect(step(21.7, 14.5, 10.2, 10.2)).toBe('none');
    expect(dog.stage).toBe('cooldown');
    expect(dog.isRecovering).toBe(false);
    expect(FeedWatchdog.shouldRepeatRecoverEnable(2.1, true)).toBe(false);
  });
  for (const control of [0, 1, 2, 3]) {
    it(`control grace holds the faster reopen (${control})`, () => {
      const dog = new FeedWatchdog();
      const s = snap({ now: 10, frameAge: 2.8, videoAge: 2.8, statusAge: 0, bleAge: 0.2 });
      s.secondsSinceLastEnable = 20;
      expect(dog.tick(s)).toBe('resendLiveViewEnable');
      s.now = 11.6;
      s.lastDecodedFrameAge = s.lastVideoPacketAge = s.lastAccessUnitAge = 4.4;
      s.secondsSinceLastEnable = 1.6;
      if (control === 0) s.zoomPinchActive = true;
      else if (control === 1) s.gimbalStickHeld = true;
      else if (control === 2) s.secondsSinceFocusTrackSet = 0.5;
      else s.secondsSinceCameraSet = 0.5;
      expect(dog.tick(s)).toBe('none');
      expect(dog.stage).toBe('resendEnable');
    });
  }
  it('encoder pause does not flap UDP when BLE is stale', () => {
    const dog = new FeedWatchdog();
    const s = snap({ now: 10, frameAge: 4.2, videoAge: 4.2, statusAge: 0, bleAge: 70 });
    s.secondsSinceLastEnable = 20;
    expect(dog.tick(s)).toBe('resendLiveViewEnable');
    s.now = 15.1;
    s.lastDecodedFrameAge = s.lastVideoPacketAge = s.lastAccessUnitAge = 9.3;
    s.secondsSinceLastEnable = 5.1;
    s.secondsSinceLastRebuild = 2;
    expect(dog.tick(s)).toBe('none');
    s.now = 18.2;
    s.lastDecodedFrameAge = s.lastVideoPacketAge = s.lastAccessUnitAge = 12.4;
    s.secondsSinceLastEnable = 8.2;
    s.secondsSinceLastRebuild = 5.1;
    expect(dog.tick(s)).toBe('fullSessionRejoin');
  });
  it('not live resets', () => {
    const dog = new FeedWatchdog();
    const s = snap({ now: 10, frameAge: 4.2, videoAge: 4.2 });
    s.secondsSinceLastEnable = 20;
    dog.tick(s);
    s.live = false;
    expect(dog.tick(s)).toBe('none');
    expect(dog.stage).toBe('idle');
    expect(dog.lastHold).toBe('notLive');
    expect(dog.stallLogLine(s)).toContain('stage=idle');
  });
});
