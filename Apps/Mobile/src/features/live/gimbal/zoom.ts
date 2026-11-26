import type { CameraSession, ZoomState } from '@/camera';

/** `MonitorZoomTapStops`: ordinary taps cycle the optical range; double taps the long end. */
export function zoomTapStops(z: ZoomState): { single: number[]; extended: number[] } {
  const stops = Array.from(new Set(z.stops.filter((s) => s > 0 && s <= z.max))).sort((a, b) => a - b);
  if (stops.length <= 3) return { single: stops, extended: [] };
  const opticalCut = Math.max(z.opticalMax, 3);
  const single = stops.filter((s) => s <= opticalCut + 0.01);
  const extended = stops.filter((s) => s > opticalCut + 0.01);
  return { single, extended };
}

/** Next stop above `current`, wrapping to the first. A readback within 0.05 counts as at it. */
export function nextStop(stops: number[], current: number): number | null {
  if (stops.length === 0) return null;
  return stops.find((s) => s > current + 0.05) ?? stops[0];
}

/** L1/R1: one stop out/in. Out does not wrap to tele; in does not wrap to wide. */
export function stepStop(z: ZoomState, direction: 1 | -1): number | null {
  const stops = Array.from(new Set(z.stops)).sort((a, b) => a - b);
  if (direction > 0) return stops.find((s) => s > z.factor + 0.05) ?? null;
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i] < z.factor - 0.05) return stops[i];
  return null;
}

let rampToken = 0;

/**
 * `MonitorZoomPresetRamp`: a preset tap asks for the zoom over time, sampled linearly at the
 * zoom pump cadence. A new ramp (or any zoom input) cancels the old one.
 */
export function rampZoom(session: CameraSession, to: number, seconds: number): void {
  const token = ++rampToken;
  const from = session.getState().zoom.factor;
  if (!(seconds > 0)) {
    session.control.setZoom(to).catch(() => {});
    return;
  }
  const start = Date.now();
  const step = () => {
    if (token !== rampToken) return;
    const t = Math.min(1, (Date.now() - start) / (seconds * 1000));
    session.control.setZoom(from + (to - from) * t).catch(() => {});
    if (t < 1) setTimeout(step, 50);
  };
  step();
}

export function cancelZoomRamp() {
  rampToken++;
}

/** Log-scale position (0…1) of a factor on the dial ruler. */
export function zoomToUnit(z: ZoomState, factor: number) {
  if (z.max <= z.min) return 0;
  return Math.log(factor / z.min) / Math.log(z.max / z.min);
}

export function unitToZoom(z: ZoomState, u: number) {
  const t = Math.min(1, Math.max(0, u));
  return z.min * Math.pow(z.max / z.min, t);
}
