/** Numeric helpers matching Swift semantics. */

/** Swift `Double.rounded()` — round half away from zero (JS Math.round rounds half up). */
export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/** Swift `Int16(clamping:)`. */
export function clampI16(x: number): number {
  return clamp(Math.trunc(x), -32768, 32767);
}

/** Swift `UInt16(clamping:)`. */
export function clampU16(x: number): number {
  return clamp(Math.trunc(x), 0, 0xffff);
}

/** Wrap degrees into (-180, 180]. */
export function wrapAngle(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}
