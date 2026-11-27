/**
 * Zoom: `cam_fov` decode, lens positions and the `0x02/0xB8` slider mapping.
 * Source of truth: OpenCine `OpenCineCameraVocabulary/CameraControl.swift` (`enum CamFov`) and the
 * DJI wire extension in `CameraControl+DJIWire.swift`.
 */
import { type ByteInput, u16le, u32le } from '../bytes';
import { roundHalfAway } from '../math';
import { ColorMode } from './vocabulary';

const JUMPS = [1, 3, 6, 12];

export const CamFov = {
  minFactor: 1,
  maxFactor: 18,
  jumps: JUMPS,
  rawAt1x: 12287,
  rawAt3x: 9368,
  rawAt12x: 2341,
  lens1x: 217,
  lens3x: 651,
  lens6x: 1302,
  lens12x: 2604,
  lens18x: 3906,
  slewTele: 100,
  slewWide: 300,
  teleEngage: 3,
  /** Camera can pause HEVC while the lens slews. */
  videoGrace: 4,
  zoomRatePerSecond: 3,
  zoomStepInterval: 0.05,

  clamp(factor: number, max = 18): number {
    return Math.min(Math.max(factor, 1), max);
  },

  /** Operator factor from `cam_fov` `@0`. */
  factorFromRaw(raw: number): number {
    if (raw === 0) return 1;
    if (raw >= CamFov.rawAt1x) return 1;
    if (raw <= CamFov.rawAt12x) return 12;
    if (raw >= CamFov.rawAt3x) {
      const t = (CamFov.rawAt1x - raw) / (CamFov.rawAt1x - CamFov.rawAt3x);
      return CamFov.clamp(1 + t * 2);
    }
    const t = (CamFov.rawAt3x - raw) / (CamFov.rawAt3x - CamFov.rawAt12x);
    return CamFov.clamp(3 + t * 9);
  },

  /** Operator factor from lens `@14`. */
  factorFromLens(lens: number): number | null {
    if (lens <= 0) return null;
    if (lens <= CamFov.lens1x) return 1;
    if (lens >= CamFov.lens18x) return 18;
    if (lens <= CamFov.lens3x) return CamFov.clamp(1 + ((lens - CamFov.lens1x) / (CamFov.lens3x - CamFov.lens1x)) * 2);
    return CamFov.clamp(3 + ((lens - CamFov.lens3x) / (CamFov.lens12x - CamFov.lens3x)) * 9);
  },

  /** Slider SET unit, piecewise through 1× / 3× / 12× / 18×. */
  lensPosition(factor: number): number {
    const f = CamFov.clamp(factor);
    const lerp = (a: number, b: number, t: number) => roundHalfAway(a + Math.min(Math.max(t, 0), 1) * (b - a));
    if (Math.abs(f - 1) < 0.001) return CamFov.lens1x;
    if (Math.abs(f - 12) < 0.001) return CamFov.lens12x;
    if (Math.abs(f - 18) < 0.001) return CamFov.lens18x;
    if (f <= 3) return lerp(CamFov.lens1x, CamFov.lens3x, (f - 1) / 2);
    if (f <= 12) return lerp(CamFov.lens3x, CamFov.lens12x, (f - 3) / 9);
    return lerp(CamFov.lens12x, CamFov.lens18x, (f - 12) / 6);
  },

  displayTenths(factor: number, ceiling = 18): number {
    return roundHalfAway(CamFov.clamp(factor, ceiling) * 10) / 10;
  },

  displayLabel(factor: number, ceiling = 18): string {
    const shown = CamFov.displayTenths(factor, ceiling);
    if (Math.abs(shown - ceiling) < 0.05) return `${roundHalfAway(ceiling)}×`;
    const nearest = roundHalfAway(shown);
    if (Math.abs(shown - nearest) < 0.05 && nearest >= 1 && nearest <= Math.max(ceiling, 18)) return `${nearest}×`;
    return `${shown.toFixed(1)}×`;
  },

  /** The remembered chip stop, kept inside what the current FORMAT allows. */
  stopWithinCycle(stop: number, stops: number[]): number {
    return CamFov.clamp(stop, stops.length ? stops[stops.length - 1] : 1);
  },

  /** Operator line when a new FORMAT pulls the zoom ceiling under the held factor. */
  ceilingNote(size: string, held: number, stops: number[]): string | null {
    const ceiling = stops[stops.length - 1];
    if (ceiling === undefined || !(CamFov.displayTenths(held) > ceiling + 0.05)) return null;
    return `${size} caps zoom at ${CamFov.displayLabel(ceiling)}`;
  },

  nextJump(factor: number, stops: number[] = JUMPS): number {
    const s = stops.length ? stops : JUMPS;
    for (const stop of s) if (factor < stop - 0.05) return stop;
    return s[0];
  },

  previousJump(factor: number, stops: number[] = JUMPS): number {
    const s = stops.length ? stops : JUMPS;
    for (const stop of [...s].reverse()) if (factor > stop + 0.05) return stop;
    return s[0];
  },

  chipWrite(factor: number): { kind: 'lens'; value: number } | null {
    const at = (f: number) => Math.abs(factor - f) < 0.1;
    if (at(1)) return { kind: 'lens', value: CamFov.lens1x };
    if (at(2)) return { kind: 'lens', value: CamFov.lensPosition(2) };
    if (at(3)) return { kind: 'lens', value: CamFov.lens3x };
    if (at(4)) return { kind: 'lens', value: CamFov.lensPosition(4) };
    if (at(6)) return { kind: 'lens', value: CamFov.lens6x };
    if (at(12)) return { kind: 'lens', value: CamFov.lens12x };
    if (at(18)) return { kind: 'lens', value: CamFov.lens18x };
    return null;
  },

  /** Lens is monotonic with the pinch; `cam_fov` @0 jumps at the 3× hop. */
  hybridFactor(raw: number, lens: number | null): number | null {
    if (lens != null) {
      const f = CamFov.factorFromLens(lens);
      if (f != null) return f;
    }
    return raw === 0 ? null : CamFov.factorFromRaw(raw);
  },

  matches(live: number, target: number): boolean {
    return Math.abs(CamFov.displayTenths(live) - CamFov.displayTenths(target)) < 0.15;
  },

  /** D-Log2 rejects every zoom SET: hop to D-Log on the first step off 1×. */
  colorModeForZoom(factor: number, current: ColorMode | null): ColorMode | null {
    if (current !== ColorMode.dLog2 || factor <= 1) return null;
    return ColorMode.dLog;
  },

  holdZoomWrite(factor: number, current: ColorMode | null, hopPending: boolean): boolean {
    if (hopPending) return true;
    return CamFov.colorModeForZoom(factor, current) != null;
  },

  zoomNeedsColorHopWhileRecording(factor: number, current: ColorMode | null, isRecording: boolean): boolean {
    return isRecording && CamFov.colorModeForZoom(factor, current) != null;
  },

  isJumpStop(factor: number, stops: number[] = JUMPS): boolean {
    const s = stops.length ? stops : JUMPS;
    const shown = CamFov.displayTenths(factor, Math.max(18, ...s));
    return s.some((stop) => Math.abs(shown - stop) < 0.05);
  },

  pinchFactor(anchor: number, magnification: number, max = 18): number {
    return CamFov.clamp(anchor * magnification, max);
  },

  pinchLens(factor: number): number {
    return CamFov.lensPosition(factor);
  },

  continuousReadout(live: number | null, preview: number | null, fallback: number, optimistic: number | null = null, ceiling = 18): number {
    return CamFov.clamp(preview ?? optimistic ?? live ?? fallback, ceiling);
  },

  readout(live: number | null, preview: number | null, fallback: number, optimistic: number | null = null, ceiling = 18): number {
    return CamFov.displayTenths(CamFov.continuousReadout(live, preview, fallback, optimistic, ceiling), ceiling);
  },

  shouldRestoreDLog2(factor: number): boolean {
    return CamFov.displayTenths(factor) <= 1.05;
  },

  shouldHoldWatchdog(secondsSinceSet: number | null, lastVideoPacketAge: number | null = null, pinchActive = false, stallThreshold = 2): boolean {
    if (pinchActive) return true;
    if (secondsSinceSet == null) return false;
    if (secondsSinceSet < 0 || secondsSinceSet >= CamFov.videoGrace) return false;
    if (lastVideoPacketAge != null && lastVideoPacketAge >= stallThreshold + CamFov.videoGrace) return false;
    return true;
  },

  // ---- DJI wire ----
  rawAt0(value: ByteInput): number | null {
    return value.length >= 4 ? u32le(value, 0) : null;
  },
  /** u16-LE `@14` when in the zoom range (100…4200). */
  lensAt14(value: ByteInput): number | null {
    if (value.length < 16) return null;
    const lens = u16le(value, 14);
    return lens >= 100 && lens <= 4200 ? lens : null;
  },
  factor(value: ByteInput): number | null {
    const raw = CamFov.rawAt0(value);
    return raw == null ? null : CamFov.factorFromRaw(raw);
  },
};
