import { describe, expect, it } from 'vitest';
import { CameraSoftAP, CameraSoftAPSwitch } from './cameraSoftAP';
import { LinkDiagnoser, type LinkDiagnosisInputs } from './linkDiagnosis';
import { CameraLinkHealthScorer, cameraLinkPhase, FrameRateSampler, fpsChipLabel, LIVE_VIEW_TARGET_FPS, LinkSignalBars } from './linkHealth';
import { CameraPathRecovery } from './pathRecovery';
import { ConnectTimeline, phaseLabel, toUIConnectionPhase } from './phase';

// Ported from fork Tests/OpenPocketViewCoreTests: LinkSignalBarsTests, FrameRateSamplerTests,
// CameraPathRecoveryTests, CameraLinkHealthTests, LinkDiagnosisTests, ConnectTimeline.
describe('LinkSignalBars', () => {
  it('quartile thresholds from reset', () => {
    for (const [score, exp] of [
      [0, 0],
      [1, 1],
      [25, 1],
      [26, 2],
      [50, 2],
      [51, 3],
      [75, 3],
      [76, 4],
      [100, 4],
    ])
      expect(new LinkSignalBars().update(score)).toBe(exp);
  });
  it('hysteresis holds', () => {
    const f = new LinkSignalBars();
    expect([74, 77, 74, 81, 82, 74, 70, 69].map((s) => f.update(s))).toEqual([3, 3, 3, 3, 4, 4, 4, 3]);
  });
  it('multi-band drop and zero bypass', () => {
    const f = new LinkSignalBars();
    expect([95, 30].map((s) => f.update(s))).toEqual([4, 2]);
    const g = new LinkSignalBars();
    expect([90, 0, 85].map((s) => g.update(s))).toEqual([4, 0, 4]);
  });
});

describe('FrameRateSampler', () => {
  it('zero before frames; two frames ~30', () => {
    const s = new FrameRateSampler();
    expect(s.currentFPS).toBe(0);
    s.recordFrame(0);
    s.recordFrame(0.033333);
    expect(Math.abs(s.currentFPS - 30)).toBeLessThan(0.5);
  });
  it('smooths over window', () => {
    const s = new FrameRateSampler(8);
    let t = 0;
    s.recordFrame(t);
    for (let i = 0; i < 6; i++) {
      t += 0.02;
      s.recordFrame(t);
      t += 0.04;
      s.recordFrame(t);
    }
    expect(Math.abs(s.currentFPS - 33.3)).toBeLessThan(1.5);
  });
  it('ignores non-monotonic, formats, throttles, ages', () => {
    const s = new FrameRateSampler();
    s.recordFrame(0.1);
    s.recordFrame(0.133);
    s.recordFrame(0);
    expect(Math.abs(s.currentFPS - 30)).toBeLessThan(0.5);
    const f = new FrameRateSampler();
    f.recordFrame(0);
    f.recordFrame(0.04);
    expect(f.formatted).toBe('25.00');
    f.age(2.04);
    expect(f.formatted).toBe('0.00');
    f.recordFrame(3);
    f.recordFrame(3.04);
    expect(f.formatted).toBe('25.00');
    const th = new FrameRateSampler(30, 1);
    th.recordFrame(0);
    th.recordFrame(0.04);
    let t = 0.04;
    while (t < 0.96) {
      t += 0.02;
      th.recordFrame(t);
    }
    expect(Math.abs(th.displayFPS - 25)).toBeLessThan(0.1);
    expect(th.currentFPS).toBeGreaterThan(45);
    while (t < 1.3) {
      t += 0.02;
      th.recordFrame(t);
    }
    expect(Math.abs(th.displayFPS - 50)).toBeLessThan(2);
  });
});

describe('CameraPathRecovery', () => {
  const loss = (p: CameraPathRecovery, at: number) => p.tick(at, false, false, true, false);
  it('transient flap does not reconnect', () => {
    const p = new CameraPathRecovery();
    expect(loss(p, 10)).toBe(false);
    expect(loss(p, 17.9)).toBe(false);
    expect(p.tick(18, true, false, true, false)).toBe(false);
    expect(loss(p, 19)).toBe(false);
    expect(loss(p, 26.9)).toBe(false);
  });
  it('sustained loss requests once after 8 s', () => {
    const p = new CameraPathRecovery();
    expect([10, 17.9, 18, 19, 100].map((t) => loss(p, t))).toEqual([false, false, true, false, false]);
  });
  it('fresh video resets; inactive scene; repair in flight', () => {
    const p = new CameraPathRecovery();
    loss(p, 10);
    expect(p.tick(17, false, true, true, false)).toBe(false);
    expect([18, 25.9, 26].map((t) => loss(p, t))).toEqual([false, false, true]);
    const q = new CameraPathRecovery();
    loss(q, 10);
    q.tick(18, false, false, true, true);
    expect(loss(q, 19)).toBe(true);
    expect(loss(q, 20)).toBe(false);
  });
  it('invalid or rewound clock', () => {
    const p = new CameraPathRecovery();
    expect([10, NaN, 100, 5, 12.9, 13].map((t) => loss(p, t))).toEqual([false, false, false, false, false, true]);
  });
});

describe('CameraLinkHealth', () => {
  it('scores', () => {
    expect(CameraLinkHealthScorer.score({ phase: 'disconnected' }).linkHealthScore).toBe(0);
    expect(
      CameraLinkHealthScorer.score({ phase: 'streaming', ptpRoundTripMilliseconds: 45, liveViewFPS: 29.5, targetLiveViewFPS: 30, secondsSinceLastGoodFrame: 0.03 })
        .linkHealthScore,
    ).toBeGreaterThanOrEqual(80);
    const healthy = CameraLinkHealthScorer.score({ phase: 'streaming', liveViewFPS: 25, targetLiveViewFPS: LIVE_VIEW_TARGET_FPS, secondsSinceLastGoodFrame: 0.04 });
    expect(healthy.linkHealthScore).toBeGreaterThanOrEqual(70);
    expect(new LinkSignalBars().update(healthy.linkHealthScore)).toBeGreaterThanOrEqual(3);
    expect(healthy.detailCaption).toBe('25.0 / 25 FPS');
  });
  it('fps chip label and link phase', () => {
    expect(fpsChipLabel({ kind: 'idle' }, false, '25.00', 0)).toBe('—');
    expect(fpsChipLabel({ kind: 'openingDatalink' }, false, '25.00', 0)).toBe('LINK');
    expect(fpsChipLabel({ kind: 'live' }, false, '25.00', 25)).toBe('25.00');
    expect(fpsChipLabel({ kind: 'live' }, true, '25.00', 25)).toBe('RECOV');
    expect(fpsChipLabel({ kind: 'failed', reason: 'timeout' }, false, '25.00', 25)).toBe('FAIL');
    expect(cameraLinkPhase({ kind: 'idle' }, false, 25)).toBe('streaming');
    expect(cameraLinkPhase({ kind: 'live' }, true, 12)).toBe('recovering');
    expect(cameraLinkPhase({ kind: 'failed', reason: 'x' }, false, 25)).toBe('disconnected');
  });
});

describe('LinkDiagnoser', () => {
  const d = (o: Partial<LinkDiagnosisInputs> = {}) =>
    LinkDiagnoser.diagnose({
      pathReady: true,
      bleNotifyAge: 0.2,
      videoAge: 0.1,
      statusAge: 0.1,
      flowHealthy: true,
      decoderFailed: false,
      udpReceiveAlive: true,
      hadVideo: true,
      secondsSinceLastEnable: 20,
      secondsSinceFocusTrackSet: null,
      ...o,
    });
  it('classifies', () => {
    expect(d()).toBe('none');
    expect(d({ pathReady: false, decoderFailed: true, udpReceiveAlive: false })).toBe('softAPLost');
    expect(d({ decoderFailed: true, presentAge: 4 })).toBe('decoderWedged');
    expect(d({ presentAge: 2.5 })).toBe('presentStalled');
    expect(d({ presentAge: 2 })).toBe('none');
    expect(d({ bleNotifyAge: 9, statusAge: 0.3, udpReceiveAlive: false })).toBe('encoderPaused');
    expect(d({ statusAge: 0.3, udpReceiveAlive: false, secondsSinceLastEnable: 2.5 })).toBe('none');
    expect(d({ statusAge: 3, udpReceiveAlive: false, secondsSinceLastEnable: 8 })).toBe('udpFlowDead');
    expect(d({ statusAge: 0.3, udpReceiveAlive: false, secondsSinceFocusTrackSet: 1.8 })).toBe('none');
    expect(d({ statusAge: 3, udpReceiveAlive: false, secondsSinceFocusTrackSet: 4 })).toBe('udpFlowDead');
    expect(d({ statusAge: 0.3, udpReceiveAlive: false, secondsSinceGimbalThrow: 1 })).toBe('none');
    expect(d({ statusAge: 3, udpReceiveAlive: false, secondsSinceGimbalThrow: 3 })).toBe('udpFlowDead');
    expect(d({ statusAge: 0.3, udpReceiveAlive: false, gimbalStickHeld: true })).toBe('none');
    expect(d({ statusAge: 0.3, udpReceiveAlive: false, secondsSinceZoomSet: 1.8 })).toBe('none');
    expect(d({ statusAge: 3, udpReceiveAlive: false, secondsSinceZoomSet: 4 })).toBe('udpFlowDead');
    expect(d({ statusAge: 0.3, udpReceiveAlive: false, secondsSinceCameraSet: 1 })).toBe('none');
    expect(d({ bleNotifyAge: 8.1, statusAge: 3, udpReceiveAlive: false })).toBe('bleLost');
    expect(d({ bleNotifyAge: null, statusAge: null, udpReceiveAlive: false })).toBe('bleLost');
    expect(LinkDiagnoser.repair('bleLost')).toBe('fullReconnect');
    expect(LinkDiagnoser.agrees('fullSessionRejoin', 'rejoinSoftAP')).toBe(true);
    expect(LinkDiagnoser.agrees('none', 'resendEnable')).toBe(false);
  });
});

describe('ConnectTimeline / phase', () => {
  it('lines', () => {
    const t = new ConnectTimeline(10);
    expect(t.line()).toBe('connect:');
    t.mark('gatt', 10.4);
    t.mark('pair', 11.1);
    expect(t.line()).toBe('connect: gatt=0.40s pair=1.10s');
  });
  it('maps to the UI phase', () => {
    expect(toUIConnectionPhase({ kind: 'connectingGatt' })).toBe('bluetooth');
    expect(toUIConnectionPhase({ kind: 'awaitingApproval' })).toBe('authorizing');
    expect(toUIConnectionPhase({ kind: 'readingWifiCreds' })).toBe('wifi-handoff');
    expect(toUIConnectionPhase({ kind: 'live' })).toBe('live-start');
    expect(toUIConnectionPhase({ kind: 'live' }, { pictureLive: true })).toBe('live');
    expect(toUIConnectionPhase({ kind: 'live' }, { recovering: true })).toBe('recovering');
    expect(phaseLabel({ kind: 'failed', reason: 'x' })).toBe('Failed: x');
  });
});

describe('CameraSoftAP', () => {
  it('addresses and SSIDs', () => {
    expect(CameraSoftAP.isAssociatedIPv4('192.168.2.23')).toBe(true);
    expect(CameraSoftAP.isAssociatedIPv4('192.168.2.1')).toBe(false);
    expect(CameraSoftAP.isAssociatedIPv4('192.168.3.23')).toBe(false);
    expect(CameraSoftAP.isPathReady(['10.0.0.2', '192.168.2.5'])).toBe(true);
    expect(CameraSoftAP.isOsmoSoftAPSSID('OsmoPocket3-ABCD')).toBe(true);
    expect(CameraSoftAP.cameraLocalIPv4([{ name: 'en0', ipv4: '192.168.2.9' }])).toBe('192.168.2.9');
    expect(CameraSoftAP.isPersonalHotspotHosting([{ name: 'bridge100', ipv4: '172.20.10.1' }])).toBe(true);
    expect(CameraSoftAPSwitch.ssidToKick('OsmoNano-1', 'OsmoPocket3-2')).toBe('OsmoNano-1');
    expect(CameraSoftAPSwitch.ssidToKick('HomeWiFi', 'OsmoPocket3-2')).toBeNull();
    expect(CameraSoftAPSwitch.isOnTarget(null, 'x')).toBe(true);
  });
  it('first picture ladder', () => {
    const fp = CameraSoftAP.firstPictureStep;
    expect(fp({ videoPackets: 0, enableSends: 1, secondsSinceLastEnable: 1, hasPresentedPicture: true })).toBe('wait');
    expect(fp({ videoPackets: 0, enableSends: 0, secondsSinceLastEnable: 9 })).toBe('resendEnable');
    expect(fp({ videoPackets: 0, enableSends: 1, secondsSinceLastEnable: 3 })).toBe('wait');
    expect(fp({ videoPackets: 0, enableSends: 1, secondsSinceLastEnable: 9 })).toBe('resendEnable');
    expect(fp({ videoPackets: 0, enableSends: 2, secondsSinceLastEnable: 9 })).toBe('rebuildUDP');
    expect(fp({ videoPackets: 0, enableSends: 2, secondsSinceLastEnable: 9, secondsSinceLastRebuild: 2 })).toBe('wait');
    expect(fp({ videoPackets: 0, enableSends: 4, secondsSinceLastEnable: 9 })).toBe('rejoin');
    expect(fp({ videoPackets: 0, enableSends: 1, secondsSinceLastEnable: 2, needsRecordingFormatPoke: true })).toBe('pokeRecordingFormat');
    expect(fp({ videoPackets: 10, enableSends: 1, secondsSinceLastEnable: 5.5, secondsSinceLastVideo: 0.1 })).toBe('resendEnable');
    expect(fp({ videoPackets: 10, enableSends: 2, secondsSinceLastEnable: 16, secondsSinceLastVideo: 0.1 })).toBe('rejoin');
    expect(fp({ videoPackets: 10, enableSends: 2, secondsSinceLastEnable: 9, secondsSinceLastVideo: 5 })).toBe('rebuildUDP');
    expect(fp({ videoPackets: 10, enableSends: 2, secondsSinceLastEnable: 9, secondsSinceLastVideo: 5, secondsSinceLastRebuild: 7 })).toBe('rejoin');
  });
  it('rebuild rules', () => {
    expect(
      CameraSoftAP.shouldRebuildAfterCommandTimeouts({ timeoutsInWindow: 2, downlinkFresh: true, videoFresh: true, rebuildInFlight: false, secondsSinceLastRebuild: null }),
    ).toBe(false);
    expect(
      CameraSoftAP.shouldRebuildAfterCommandTimeouts({ timeoutsInWindow: 2, downlinkFresh: true, videoFresh: false, rebuildInFlight: false, secondsSinceLastRebuild: null }),
    ).toBe(true);
    expect(CameraSoftAP.shouldKeepaliveRebuildUDP({ flowNeedsRebuild: true, rebuildInFlight: false, secondsSinceLastRebuild: null, statusFresh: true })).toBe(false);
    expect(CameraSoftAP.shouldKeepaliveRebuildUDP({ flowNeedsRebuild: true, rebuildInFlight: false, secondsSinceLastRebuild: null })).toBe(true);
    expect(CameraSoftAP.shouldKeepaliveRebuildUDP({ flowNeedsRebuild: true, rebuildInFlight: false, secondsSinceLastRebuild: null, sawPicture: false })).toBe(false);
    expect(CameraSoftAP.handshakeTimeoutStep(true, 0, 1)).toBe('keepSocket');
    expect(CameraSoftAP.handshakeTimeoutStep(true, 0)).toBe('rebindUDP');
    expect(CameraSoftAP.handshakeTimeoutStep(true, 3)).toBe('fail');
    expect(CameraSoftAP.handshakeTimeoutStep(false, 0, 5)).toBe('fail');
    expect(CameraSoftAP.shouldStampCommandSeq(true, false, true)).toBe(false);
    expect(CameraSoftAP.shouldStampCommandSeq(true, false, false)).toBe(true);
    expect(CameraSoftAP.shouldSendLiveViewEnable(true, true)).toBe(false);
    expect(CameraSoftAP.shouldCommitLiveHandshake(true, false, true)).toBe(false);
  });
});
