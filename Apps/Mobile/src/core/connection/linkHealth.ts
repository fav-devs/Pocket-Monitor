/**
 * Link health score (0–100), 0–4 signal bars with hysteresis, the measured-FPS sampler, and the
 * UI link band.
 * Source of truth: fork `CameraLinkHealth.swift`, `LinkSignalBars.swift`, `FrameRateSampler.swift`.
 */
import type { LinkHealthBand } from '../../camera/types';
import { roundHalfAway } from '../math';
import type { CameraConnectionPhase } from './phase';

export type CameraLinkPhase = 'disconnected' | 'connecting' | 'connectedIdle' | 'streaming' | 'recovering' | 'demo';

export interface CameraLinkHealthInputs {
  phase: CameraLinkPhase;
  ptpRoundTripMilliseconds?: number | null;
  liveViewFPS?: number | null;
  targetLiveViewFPS?: number;
  secondsSinceLastGoodFrame?: number | null;
  consecutiveBadFrames?: number;
  recentCommandFailures?: number;
  isRecoveringStream?: boolean;
}

export interface CameraLinkHealthSnapshot {
  linkHealthScore: number;
  detailCaption: string;
}

const snapshot = (score: number, detailCaption: string): CameraLinkHealthSnapshot => ({
  linkHealthScore: Math.min(100, Math.max(0, score)),
  detailCaption,
});

export const CameraLinkHealthScorer = {
  latencyScore(ms: number): number {
    if (ms < 30) return 100;
    if (ms < 60) return 92;
    if (ms < 100) return 82;
    if (ms < 150) return 68;
    if (ms < 250) return 48;
    if (ms < 500) return 28;
    return 10;
  },
  frameDeliveryScore(actual: number, target: number): number {
    if (!(actual > 0) || !(target > 0)) return 0;
    return Math.min(1, actual / target) * 100;
  },
  frameFreshnessPenalty(s: number | null | undefined): number {
    if (s == null) return 0;
    if (s < 0.5) return 0;
    if (s < 1.5) return 8;
    if (s < 3) return 20;
    if (s < 5) return 35;
    return 55;
  },
  badFramePenalty(n: number): number {
    if (n <= 0) return 0;
    if (n <= 2) return 6;
    if (n <= 5) return 18;
    if (n <= 8) return 32;
    return 50;
  },
  commandFailurePenalty(n: number): number {
    if (n <= 0) return 0;
    if (n === 1) return 15;
    if (n === 2) return 30;
    return 50;
  },
  score(raw: CameraLinkHealthInputs): CameraLinkHealthSnapshot {
    const target = Math.max(1, raw.targetLiveViewFPS ?? 30);
    const bad = Math.max(0, raw.consecutiveBadFrames ?? 0);
    const failures = Math.max(0, raw.recentCommandFailures ?? 0);
    const recovering = raw.isRecoveringStream ?? false;
    switch (raw.phase) {
      case 'disconnected':
        return snapshot(0, 'Not connected');
      case 'demo':
        return snapshot(85, 'Demo session');
      case 'connecting':
        return snapshot(20, 'Connecting…');
    }
    const S = CameraLinkHealthScorer;
    const rtt = raw.ptpRoundTripMilliseconds ?? null;
    const latency = rtt != null ? S.latencyScore(rtt) : 0;
    const latencyDetail = rtt != null ? `${rtt.toFixed(0)} ms RTT` : null;
    const streaming = raw.phase === 'streaming' || raw.phase === 'recovering';
    let frameScore = 0;
    let frameDetail: string | null = null;
    if (raw.liveViewFPS != null && streaming) {
      frameScore = S.frameDeliveryScore(raw.liveViewFPS, target);
      frameDetail = `${raw.liveViewFPS.toFixed(1)} / ${target.toFixed(0)} FPS`;
    }
    let value: number;
    if (streaming) {
      const lc = latency > 0 ? latency : 70;
      value =
        frameScore * 0.55 +
        lc * 0.25 +
        20 -
        S.frameFreshnessPenalty(raw.secondsSinceLastGoodFrame) -
        S.badFramePenalty(bad) -
        S.commandFailurePenalty(failures) -
        (recovering ? 25 : 0);
    } else {
      const lc = latency > 0 ? latency : 60;
      value = lc * 0.75 + 25 - S.commandFailurePenalty(failures) - (recovering ? 25 : 0);
    }
    const detail = [frameDetail, latencyDetail].filter((x): x is string => !!x).join(' · ');
    return snapshot(roundHalfAway(value), detail || 'Command channel warm');
  },
};

export const LIVE_VIEW_TARGET_FPS = 25;

export function cameraLinkPhase(connection: CameraConnectionPhase, recovering: boolean, measuredFPS: number): CameraLinkPhase {
  if (connection.kind === 'failed') return 'disconnected';
  if (measuredFPS > 0) return recovering ? 'recovering' : 'streaming';
  if (connection.kind === 'idle') return 'disconnected';
  if (connection.kind === 'live') return 'connectedIdle';
  return 'connecting';
}

export function fpsChipLabel(connection: CameraConnectionPhase, recovering: boolean, formattedFPS: string, measuredFPS: number): string {
  if (connection.kind === 'failed') return 'FAIL';
  if (recovering) return 'RECOV';
  if (measuredFPS > 0) return formattedFPS;
  return connection.kind === 'idle' ? '—' : 'LINK';
}

export function isFeedWarming(hasPresentedPicture: boolean, measuredFPS = 0, rollingIntervals = 0): boolean {
  return !hasPresentedPicture || measuredFPS <= 0 || rollingIntervals < 8;
}

/** UI band for the link chip (contract `LinkHealthBand`). */
export function linkBand(score: number): LinkHealthBand {
  if (score >= 70) return 'stable';
  if (score >= 40) return 'watch';
  return 'poor';
}

/** 0–4 bars with hysteresis so a score at a band boundary does not flicker. */
export class LinkSignalBars {
  private _bars = 0;
  private readonly margin: number;
  constructor(hysteresisMargin = 6) {
    this.margin = Math.max(0, hysteresisMargin);
  }
  get bars(): number {
    return this._bars;
  }
  private static floorScore(bars: number): number {
    return 25 * (bars - 1) + 1;
  }
  private static rawBars(score: number): number {
    if (score <= 0) return 0;
    return Math.min(4, Math.max(1, Math.ceil(score / 25)));
  }
  update(score: number): number {
    const raw = LinkSignalBars.rawBars(score);
    const cur = this._bars;
    if (raw === cur) {
      /* hold */
    } else if (raw === 0 || cur === 0) this._bars = raw;
    else if (raw > cur) {
      if (score >= LinkSignalBars.floorScore(raw) + this.margin) this._bars = raw;
    } else if (score < LinkSignalBars.floorScore(cur) - this.margin) this._bars = raw;
    return this._bars;
  }
}

/** Rolling inter-frame FPS with a ~1 s display refresh. */
export class FrameRateSampler {
  private readonly windowSize: number;
  private readonly displayInterval: number;
  private intervals: number[] = [];
  private lastTimestamp: number | null = null;
  private lastDisplayTimestamp: number | null = null;
  private displayed = 0;

  constructor(windowSize = 30, displayRefreshInterval = 1.0) {
    this.windowSize = Math.max(1, windowSize);
    this.displayInterval = Math.max(0, displayRefreshInterval);
  }

  recordFrame(t: number): void {
    if (!Number.isFinite(t)) return;
    const prev = this.lastTimestamp;
    if (prev !== null && t <= prev) return;
    this.lastTimestamp = t;
    if (prev === null) return;
    this.intervals.push(t - prev);
    if (this.intervals.length > this.windowSize) this.intervals.shift();
    if (this.lastDisplayTimestamp !== null && t - this.lastDisplayTimestamp < this.displayInterval) return;
    this.displayed = this.currentFPS;
    this.lastDisplayTimestamp = t;
  }

  age(t: number, staleAfter = 2): void {
    if (!Number.isFinite(t) || this.lastTimestamp === null || t - this.lastTimestamp < staleAfter) return;
    this.displayed = 0;
    this.intervals = [];
    this.lastTimestamp = null;
    this.lastDisplayTimestamp = null;
  }

  get intervalCount(): number {
    return this.intervals.length;
  }
  get currentFPS(): number {
    if (!this.intervals.length) return 0;
    return 1 / (this.intervals.reduce((a, b) => a + b, 0) / this.intervals.length);
  }
  get displayFPS(): number {
    return this.displayed;
  }
  get formatted(): string {
    return this.displayed.toFixed(2);
  }
}
