/**
 * Face retouch (the editor's face stage): the maths every renderer follows. iOS
 * (`ios/Edit/PocketFaceRetouch.swift`, Core Image kernels), Android
 * (`android/.../edit/PocketFaceRetouch.kt`, a Media3 GL effect) and the web demo
 * (`features/picture/web/faceShader.ts`) port these functions line for line; the tests here pin
 * the numbers.
 *
 * Per frame, per face (up to MAX_FACES):
 *   1. landmarks — FACE_POINT_COUNT points (MediaPipe face-mesh indices FACE_LANDMARK_INDICES;
 *      iOS maps Apple Vision's regions onto the same points), normalized, top-left origin,
 *      smoothed over time by `FaceTracker` (One-Euro filter, hold-over for missed frames,
 *      interpolation between detections run at a lower rate).
 *   2. strengths — the clip's `FaceParams`, with Auto resolved per face from its size and the
 *      skin's exposure (`resolveFaceStrengths`).
 *   3. geometry — `buildRetouchGeometry`: the skin mask's shapes (face oval less eyes and mouth),
 *      the eye magnifiers and the jaw pushes, all in frame pixels, plus the bounds outside which
 *      nothing changes.
 *   4. pixels — smooth + brighten under the skin mask, then the warps (slim, eyes):
 *      `skinMask`, `brightenValue`, `retouchWarpSource` are the shader's reference.
 *
 * Strength 0 everywhere = no stage at all (identity, no detection work). Adapted from the
 * Sondr editor's retouch (`fav-devs/ai-cut` packages/editor-core/src/face), same owner.
 *
 * Pure TypeScript: no React / React Native imports.
 */
import type { FaceParams } from './model';

// ───────────────────────────── Landmarks ─────────────────────────────

/** The face's outline, clockwise in the picture from the top of the forehead (every other point of MediaPipe's 36). */
export const FACE_OVAL_INDICES = [10, 297, 284, 389, 454, 361, 397, 379, 400, 152, 176, 150, 172, 132, 234, 162, 54, 67] as const;

/**
 * The points a face carries, as MediaPipe face-mesh indices. "Right" and "left" are the person's
 * own: in an unmirrored shot their right eye is on the picture's left.
 */
export const FACE_LANDMARK_INDICES: readonly number[] = [
  ...FACE_OVAL_INDICES,
  // Right eye: outer corner, inner corner, top lid, bottom lid, iris centre.
  33, 133, 159, 145, 468,
  // Left eye.
  263, 362, 386, 374, 473,
  // Mouth: right corner, left corner, top of the upper lip, bottom of the lower lip.
  61, 291, 0, 17,
  // Nose tip.
  1,
  // Cheek apples (bare skin): right, left.
  50, 280,
];

export const FACE_POINT_COUNT = FACE_LANDMARK_INDICES.length;

/** Where each part starts in a face's points (FACE_LANDMARK_INDICES order). */
export const FACE_POINTS = { oval: 0, rightEye: 18, leftEye: 23, mouth: 28, noseTip: 32, rightCheek: 33, leftCheek: 34 } as const;

/** Positions in the oval. */
export const FACE_OVAL_POINTS = {
  forehead: 0,
  /** The widest points, beside the eyes: the person's left, then right. */
  leftSide: 4,
  rightSide: 14,
  chin: 9,
  /** Jaw points the slimming pulls in, from below the cheekbone down towards the chin. */
  leftJaw: [5, 6, 7],
  rightJaw: [13, 12, 11],
} as const;

/** Faces retouched per frame (the largest first). */
export const MAX_FACES = 3;

// ───────────────────────────── Strengths ─────────────────────────────

/** What the pixels get, 0…1 each (Auto resolved). */
export interface FaceStrengths {
  smooth: number;
  brighten: number;
  slim: number;
  eyes: number;
}

/** What Auto looks at, per face. */
export interface FaceScene {
  /** Face width over the frame's short side (0.1 = a wide shot, 0.5 = a close-up). */
  faceSize: number;
  /** The skin's luma, 0…1 in the stage's working encoding (Rec.709-like code values). */
  skinLuma: number;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** True when the face stage has nothing to do (no stage, no detection). */
export const faceIsIdentity = (p: FaceParams) => Math.max(p.auto, p.smooth, p.brighten, p.slim, p.eyes) <= 0.001;

/**
 * Auto at `amount`: a light, natural mix chosen from the face. Close-ups (where skin texture
 * shows) get more smoothing and a touch of eye; dim skin gets lifted, already-bright skin is left
 * alone; slimming stays subtle.
 */
export function autoFaceStrengths(amount: number, scene: FaceScene): FaceStrengths {
  const a = clamp01(amount);
  if (a <= 0) return { smooth: 0, brighten: 0, slim: 0, eyes: 0 };
  const close = clamp01((scene.faceSize - 0.12) / (0.45 - 0.12));
  const dim = clamp01((0.58 - scene.skinLuma) / 0.3);
  const bright = clamp01((scene.skinLuma - 0.72) / 0.14);
  return {
    smooth: a * (0.3 + 0.25 * close),
    brighten: a * (0.08 + 0.52 * dim) * (1 - bright),
    slim: a * 0.18,
    eyes: a * (0.08 + 0.12 * close),
  };
}

/** Two strengths together: neither undone, never past 1 (1 − (1 − a)(1 − b)). */
export const combineStrength = (a: number, b: number) => (b <= 0 ? clamp01(a) : a <= 0 ? clamp01(b) : 1 - (1 - clamp01(a)) * (1 - clamp01(b)));

/** The clip's face params for one face: the sliders with Auto added on top. */
export function resolveFaceStrengths(params: FaceParams, scene: FaceScene): FaceStrengths {
  const auto = autoFaceStrengths(params.auto, scene);
  return {
    smooth: combineStrength(params.smooth, auto.smooth),
    brighten: combineStrength(params.brighten, auto.brighten),
    slim: combineStrength(params.slim, auto.slim),
    eyes: combineStrength(params.eyes, auto.eyes),
  };
}

// ───────────────────────────── Geometry ─────────────────────────────

export interface RetouchEllipse {
  x: number;
  y: number;
  /** Along the eye line, then across it. */
  rx: number;
  ry: number;
}

/** A local translation: what is around (x, y) moves by (dx, dy), fading to nothing `pushRadius` away. */
export interface RetouchPush {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export interface RetouchGeometry {
  /** smooth: blend towards the smoothed skin; magnify: at the eye centres; brighten: the lift's gamma drop. */
  amounts: { smooth: number; magnify: number; brighten: number };
  /** Nothing changes outside: x0, y0, x1, y1 in frame pixels. */
  bounds: [number, number, number, number];
  /** The eye line's direction (cos, sin): ellipses' first axis. */
  axis: [number, number];
  faceWidth: number;
  /** The outline, x, y per point (18). */
  oval: Float32Array;
  /** Magnified circles on the irises: the person's right eye, then left. */
  eyes: [{ x: number; y: number; radius: number }, { x: number; y: number; radius: number }];
  /** Left out of the skin: each eye with its lids and lashes, and the lips. */
  eyeHoles: [RetouchEllipse, RetouchEllipse];
  mouth: RetouchEllipse;
  /** Cheek apples, x, y each (where the skin colour is measured). */
  cheeks: [number, number, number, number];
  /** Three each side along the jaw (zero-length when slim is 0). */
  pushes: RetouchPush[];
  pushRadius: number;
  /** The smoothing's reach and the skin edge's softness (brightening fades over twice as far). */
  smoothRadius: number;
  feather: number;
}

/** What 100 % means. */
export const RETOUCH_LIMITS = {
  /** Blend towards the edge-preserving blur. */
  smooth: 0.9,
  /** Magnification at the eye centre (0.22 = sampled from 78 % of the distance). */
  magnify: 0.22,
  /** Gamma drop of the skin lift (0.28 → skin^0.72). */
  brighten: 0.28,
  /** The jaw's pull at full slim, upper to lower, as shares of the face's width (neighbours overlap, so a jaw point moves about 1.6× this). */
  slim: [0.032, 0.028, 0.012] as const,
  /** No push is longer than this share of `pushRadius`: 3 × 0.2 × the falloff's steepest slope (1.54) < 1, so no fold. */
  maxPushOfRadius: 0.2,
} as const;

type Pt = [number, number];

/**
 * The frame's retouch for one face: `points` (FACE_POINT_COUNT x, y pairs, frame pixels),
 * `strengths` (resolved) scaled by `weight` (the face fading in or out). Null when there's
 * nothing to do: every strength 0, or a face under 8 px wide.
 */
export function buildRetouchGeometry({ points, strengths, weight = 1 }: { points: ArrayLike<number>; strengths: FaceStrengths; weight?: number }): RetouchGeometry | null {
  if (points.length < FACE_POINT_COUNT * 2) return null;
  const fade = clamp01(weight);
  const smooth = clamp01(strengths.smooth) * fade;
  const slim = clamp01(strengths.slim) * fade;
  const eyes = clamp01(strengths.eyes) * fade;
  const brighten = clamp01(strengths.brighten) * fade;
  if (smooth + slim + eyes + brighten < 1e-3) return null;

  const at = (i: number): Pt => [points[i * 2], points[i * 2 + 1]];
  const oval = (position: number) => at(FACE_POINTS.oval + position);
  const distance = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const middle = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

  const faceWidth = distance(oval(FACE_OVAL_POINTS.leftSide), oval(FACE_OVAL_POINTS.rightSide));
  if (!(faceWidth >= 8)) return null;

  const eyePoints = (start: number) => ({ outer: at(start), inner: at(start + 1), top: at(start + 2), bottom: at(start + 3), iris: at(start + 4) });
  const right = eyePoints(FACE_POINTS.rightEye);
  const left = eyePoints(FACE_POINTS.leftEye);
  const rightCentre = middle(right.outer, right.inner);
  const leftCentre = middle(left.outer, left.inner);
  const eyeLine = Math.hypot(leftCentre[0] - rightCentre[0], leftCentre[1] - rightCentre[1]) || 1;
  const axis: Pt = [(leftCentre[0] - rightCentre[0]) / eyeLine, (leftCentre[1] - rightCentre[1]) / eyeLine];

  // An ellipse's centre: along the face from its corners, across it from its top and bottom.
  const centreOf = (corners: Pt, across: Pt): Pt => {
    const along = (corners[0] - across[0]) * axis[0] + (corners[1] - across[1]) * axis[1];
    return [across[0] + axis[0] * along, across[1] + axis[1] * along];
  };
  const eyeHole = (eye: typeof right): RetouchEllipse => {
    const width = distance(eye.outer, eye.inner);
    const [x, y] = centreOf(middle(eye.outer, eye.inner), middle(eye.top, eye.bottom));
    return { x, y, rx: (width / 2) * 1.35, ry: Math.max((distance(eye.top, eye.bottom) / 2) * 2, width * 0.3) };
  };
  const magnified = (eye: typeof right) => ({ x: eye.iris[0], y: eye.iris[1], radius: distance(eye.outer, eye.inner) * 1.15 });

  const mouthRight = at(FACE_POINTS.mouth);
  const mouthLeft = at(FACE_POINTS.mouth + 1);
  const mouthTop = at(FACE_POINTS.mouth + 2);
  const mouthBottom = at(FACE_POINTS.mouth + 3);
  const [mouthX, mouthY] = centreOf(middle(mouthRight, mouthLeft), middle(mouthTop, mouthBottom));
  const mouthRx = (distance(mouthRight, mouthLeft) / 2) * 1.15;
  const mouth = { x: mouthX, y: mouthY, rx: mouthRx, ry: Math.max((distance(mouthTop, mouthBottom) / 2) * 1.25, mouthRx * 0.3) };

  // The jaw is pulled towards the face's middle line (forehead to chin), square to it.
  const pushRadius = faceWidth * 0.24;
  const maxPush = pushRadius * RETOUCH_LIMITS.maxPushOfRadius;
  const forehead = oval(FACE_OVAL_POINTS.forehead);
  const chin = oval(FACE_OVAL_POINTS.chin);
  const line: Pt = [chin[0] - forehead[0], chin[1] - forehead[1]];
  const lineLength = line[0] * line[0] + line[1] * line[1] || 1;
  const pushes: RetouchPush[] = [];
  for (const side of [FACE_OVAL_POINTS.leftJaw, FACE_OVAL_POINTS.rightJaw]) {
    side.forEach((position, order) => {
      const [x, y] = oval(position);
      const along = clamp01(((x - forehead[0]) * line[0] + (y - forehead[1]) * line[1]) / lineLength);
      const toward = [forehead[0] + line[0] * along - x, forehead[1] + line[1] * along - y];
      const length = Math.hypot(toward[0], toward[1]) || 1;
      // Never past the middle line, never longer than the warp can take without folding.
      const size = Math.min(slim * RETOUCH_LIMITS.slim[order] * faceWidth, maxPush, length * 0.5);
      pushes.push({ x, y, dx: (toward[0] / length) * size, dy: (toward[1] / length) * size });
    });
  }

  const ovalPoints = new Float32Array(FACE_OVAL_INDICES.length * 2);
  for (let i = 0; i < ovalPoints.length; i++) ovalPoints[i] = points[FACE_POINTS.oval * 2 + i];
  const eyeCircles: RetouchGeometry['eyes'] = [magnified(right), magnified(left)];

  const smoothRadius = Math.max(1, faceWidth * 0.028);
  const feather = faceWidth * 0.05;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const include = (x: number, y: number, reach: number) => {
    x0 = Math.min(x0, x - reach);
    y0 = Math.min(y0, y - reach);
    x1 = Math.max(x1, x + reach);
    y1 = Math.max(y1, y + reach);
  };
  for (let i = 0; i < FACE_OVAL_INDICES.length; i++) include(ovalPoints[i * 2], ovalPoints[i * 2 + 1], feather * 2 + smoothRadius);
  for (const push of pushes) include(push.x, push.y, pushRadius);
  for (const eye of eyeCircles) include(eye.x, eye.y, eye.radius);

  const rightCheek = at(FACE_POINTS.rightCheek);
  const leftCheek = at(FACE_POINTS.leftCheek);
  return {
    amounts: { smooth: smooth * RETOUCH_LIMITS.smooth, magnify: eyes * RETOUCH_LIMITS.magnify, brighten: brighten * RETOUCH_LIMITS.brighten },
    bounds: [x0, y0, x1, y1],
    axis,
    faceWidth,
    oval: ovalPoints,
    eyes: eyeCircles,
    eyeHoles: [eyeHole(right), eyeHole(left)],
    mouth,
    cheeks: [rightCheek[0], rightCheek[1], leftCheek[0], leftCheek[1]],
    pushes,
    pushRadius,
    smoothRadius,
    feather,
  };
}

// ───────────────────────────── Pixels (the shaders' reference) ─────────────────────────────

/**
 * Where the pixel at (x, y) takes its colour from under the warps: the jaw pulled in (a local
 * translation weighted (1 − d²/R²)², full at the point, smoothly none at `pushRadius`; the pushes'
 * sizes are capped so even all three of a side together cannot fold the picture) and the eyes
 * magnified (most at the centre, untouched at the radius).
 */
export function retouchWarpSource(g: RetouchGeometry, x: number, y: number): [number, number] {
  let sx = x;
  let sy = y;
  const radius2 = g.pushRadius * g.pushRadius;
  for (const push of g.pushes) {
    const d2 = (x - push.x) ** 2 + (y - push.y) ** 2;
    if (d2 >= radius2 || (push.dx === 0 && push.dy === 0)) continue;
    const w = (1 - d2 / radius2) ** 2;
    sx -= w * push.dx;
    sy -= w * push.dy;
  }
  if (g.amounts.magnify > 0) {
    for (const eye of g.eyes) {
      const dx = x - eye.x;
      const dy = y - eye.y;
      const r = Math.hypot(dx, dy) / Math.max(eye.radius, 0.001);
      if (r >= 1) continue;
      const k = (1 - r * r) ** 2 * g.amounts.magnify;
      sx -= dx * k;
      sy -= dy * k;
    }
  }
  return [sx, sy];
}

/** Signed distance from (x, y) to the closed outline: negative inside. */
export function outlineDistance(oval: ArrayLike<number>, x: number, y: number): number {
  const n = oval.length / 2;
  let nearest = Infinity;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = oval[i * 2];
    const ay = oval[i * 2 + 1];
    const bx = oval[j * 2];
    const by = oval[j * 2 + 1];
    const ex = bx - ax;
    const ey = by - ay;
    const wx = x - ax;
    const wy = y - ay;
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / Math.max(ex * ex + ey * ey, 1e-9)));
    nearest = Math.min(nearest, (wx - ex * t) ** 2 + (wy - ey * t) ** 2);
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return (inside ? -1 : 1) * Math.sqrt(nearest);
}

/** 0 at the ellipse's centre, 1 on its edge (axes along `axis` and across it). */
export function ellipseDistance(e: RetouchEllipse, axis: readonly [number, number], x: number, y: number): number {
  const dx = x - e.x;
  const dy = y - e.y;
  const along = dx * axis[0] + dy * axis[1];
  const across = -dx * axis[1] + dy * axis[0];
  return Math.hypot(along / Math.max(e.rx, 0.001), across / Math.max(e.ry, 0.001));
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Rec.709 Cb, Cr of an encoded colour. */
export const chroma = (rgb: readonly number[]): [number, number] => [
  -0.168736 * rgb[0] - 0.331264 * rgb[1] + 0.5 * rgb[2],
  0.5 * rgb[0] - 0.418688 * rgb[1] - 0.081312 * rgb[2],
];

export const luma709 = (rgb: readonly number[]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

/**
 * The skin mask at (x, y) (source position, after the warp's lookup) for a pixel of colour
 * `rgb` with the face's measured `skin` colour: `face` the oval with a soft edge, `glow` a wider
 * one for brightening, `holes` 0 in the eyes and lips, `tone` 1 where the colour is near the
 * skin's (the chroma check), `skin` = face × holes × tone.
 */
export function skinMask(g: RetouchGeometry, x: number, y: number, rgb: readonly number[], skin: readonly number[]) {
  const sd = outlineDistance(g.oval, x, y);
  const face = 1 - smoothstep(-g.feather, g.feather * 0.25, sd);
  const glow = 1 - smoothstep(-g.feather * 2, g.feather * 1.5, sd);
  const holes =
    smoothstep(1, 1.35, ellipseDistance(g.eyeHoles[0], g.axis, x, y)) *
    smoothstep(1, 1.35, ellipseDistance(g.eyeHoles[1], g.axis, x, y)) *
    smoothstep(1, 1.3, ellipseDistance(g.mouth, g.axis, x, y));
  const [cb, cr] = chroma(rgb);
  const [sb, sr] = chroma(skin);
  const tone = 1 - smoothstep(0.05, 0.13, Math.hypot(cb - sb, cr - sr));
  return { face, glow, holes, tone, skin: face * holes * tone };
}

/**
 * The skin lift for one encoded channel: a gamma of 1 − lift on the mid-tones, only ever up,
 * fading out above 0.8 so highlights (and HDR values over 1) are left as they are.
 */
export function brightenValue(v: number, lift: number): number {
  if (lift <= 0 || !(v > 0)) return v;
  const c = Math.min(v, 1);
  const up = Math.max(0, Math.pow(c, 1 - lift) - c);
  return v + up * (1 - smoothstep(0.8, 1, c));
}

/** How much the lift gets at a mask point: the wide glow, a little less in the eyes and lips, more on the skin's colour. */
export const brightenLift = (amount: number, m: { glow: number; holes: number; tone: number }) =>
  amount * m.glow * (0.85 + 0.15 * m.holes) * (0.35 + 0.65 * m.tone);

// ───────────────────────────── Uniform layout (Android, web) ─────────────────────────────

/** vec4s per face in the GL effect's `uFace` array. */
export const FACE_UNIFORM_VEC4 = 25;

/**
 * One face's uniforms, as the GLSL ports read them:
 *  0 amounts (smooth, magnify, brighten, smoothRadius) · 1 bounds · 2 frame (axis.x, axis.y,
 *  feather, pushRadius) · 3–4 eyes (x, y, radius, 0) · 5–6 eye holes · 7 mouth (x, y, rx, ry) ·
 *  8 skin colour (r, g, b, 1), or all 0 to have the shader sample the cheeks itself ·
 *  9–14 pushes (x, y, dx, dy) · 15–23 oval (two points each) · 24 cheeks (x, y, x, y).
 * Pixels with a top-left origin.
 */
export function packFaceUniforms(g: RetouchGeometry, skin?: readonly number[] | null): Float32Array {
  const out = new Float32Array(FACE_UNIFORM_VEC4 * 4);
  let o = 0;
  const put = (...v: number[]) => {
    for (let i = 0; i < 4; i++) out[o++] = v[i] ?? 0;
  };
  put(g.amounts.smooth, g.amounts.magnify, g.amounts.brighten, g.smoothRadius);
  put(...g.bounds);
  put(g.axis[0], g.axis[1], g.feather, g.pushRadius);
  for (const e of g.eyes) put(e.x, e.y, e.radius, 0);
  for (const e of [...g.eyeHoles, g.mouth]) put(e.x, e.y, e.rx, e.ry);
  if (skin) put(skin[0], skin[1], skin[2], 1);
  else put(0, 0, 0, 0);
  for (let i = 0; i < 6; i++) {
    const p = g.pushes[i];
    put(p?.x ?? 0, p?.y ?? 0, p?.dx ?? 0, p?.dy ?? 0);
  }
  for (let i = 0; i < 36; i += 4) put(g.oval[i], g.oval[i + 1], g.oval[i + 2], g.oval[i + 3]);
  put(...g.cheeks);
  return out;
}

// ───────────────────────────── Tracking ─────────────────────────────

/** One face from a detector: FACE_POINT_COUNT points, normalized (0…1, top-left origin). */
export interface DetectedFace {
  points: ArrayLike<number>;
  /** The cheeks' colour in the working encoding (0…1). */
  skin: readonly [number, number, number];
}

export interface TrackedFace {
  /** Normalized points (FACE_POINT_COUNT × x, y). */
  points: Float32Array;
  /** 1 while seen; falls to 0 once the face has been missed for `hold` seconds. */
  weight: number;
  skin: [number, number, number];
  scene: FaceScene;
}

export interface FaceTrackerOptions {
  /** One-Euro: the cutoff at rest (Hz) and how fast it opens with speed (per face width per second). */
  minCutoff?: number;
  beta?: number;
  derivativeCutoff?: number;
  /** A missed face is held this long, then fades out over `fade` seconds. */
  hold?: number;
  fade?: number;
  /** Detections older than this are not extrapolated past (seconds). */
  maxExtrapolate?: number;
  /** Frame width / height, so face widths are measured in square pixels. */
  aspect?: number;
  maxFaces?: number;
}

interface Track {
  filtered: Float32Array;
  velocity: number;
  lastT: number;
  lastSeen: number;
  width: number;
  skin: [number, number, number];
  history: { t: number; points: Float32Array }[];
}

const ovalCentre = (p: ArrayLike<number>): [number, number] => {
  let x = 0;
  let y = 0;
  for (let i = 0; i < FACE_OVAL_INDICES.length; i++) {
    x += p[i * 2];
    y += p[i * 2 + 1];
  }
  return [x / FACE_OVAL_INDICES.length, y / FACE_OVAL_INDICES.length];
};

/** Face width in frame heights (normalized x scaled by the aspect). */
const faceWidthOf = (p: ArrayLike<number>, aspect: number) => {
  const a = FACE_OVAL_POINTS.leftSide * 2;
  const b = FACE_OVAL_POINTS.rightSide * 2;
  return Math.hypot((p[a] - p[b]) * aspect, p[a + 1] - p[b + 1]);
};

const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

/**
 * Follows up to `maxFaces` faces across frames: matches each detection to the nearest track,
 * smooths its points with a One-Euro filter (the whole face with one cutoff, so its shape holds
 * while jitter goes; the cutoff opens as the face moves, so quick turns are followed), holds a
 * missed face for `hold` seconds then fades it, and gives the face at any time — interpolated
 * between detections, briefly extrapolated past the last one (preview detects at a lower rate
 * than it draws). A jump back in time (a seek) or a long gap starts afresh.
 */
export class FaceTracker {
  private tracks: Track[] = [];
  private lastUpdate = -Infinity;
  private readonly o: Required<FaceTrackerOptions>;

  constructor(options: FaceTrackerOptions = {}) {
    this.o = { minCutoff: 1.2, beta: 4, derivativeCutoff: 1, hold: 0.4, fade: 0.3, maxExtrapolate: 0.08, aspect: 16 / 9, maxFaces: MAX_FACES, ...options };
  }

  get count(): number {
    return this.tracks.length;
  }

  reset(): void {
    this.tracks = [];
    this.lastUpdate = -Infinity;
  }

  /** Detections for the frame at `t` seconds (presentation time). */
  update(t: number, faces: readonly DetectedFace[]): void {
    const o = this.o;
    if (this.tracks.length && (t < this.lastUpdate - 0.05 || t > this.lastUpdate + 1.5)) this.reset();
    this.lastUpdate = this.tracks.length ? Math.max(t, this.lastUpdate) : t;
    const free = new Set(this.tracks.map((_, i) => i));
    const sorted = [...faces].sort((a, b) => faceWidthOf(b.points, o.aspect) - faceWidthOf(a.points, o.aspect)).slice(0, o.maxFaces);
    for (const face of sorted) {
      const [cx, cy] = ovalCentre(face.points);
      const width = Math.max(1e-4, faceWidthOf(face.points, o.aspect));
      let best = -1;
      let bestD = Infinity;
      for (const i of free) {
        const [tx, ty] = ovalCentre(this.tracks[i].filtered);
        const d = Math.hypot((tx - cx) * o.aspect, ty - cy);
        if (d < bestD && d < width * 0.6) {
          best = i;
          bestD = d;
        }
      }
      if (best >= 0) {
        free.delete(best);
        this.step(this.tracks[best], t, face, width);
      } else if (this.tracks.length < o.maxFaces) {
        const filtered = Float32Array.from(face.points as ArrayLike<number>);
        this.tracks.push({ filtered, velocity: 0, lastT: t, lastSeen: t, width, skin: [...face.skin] as [number, number, number], history: [{ t, points: filtered.slice() }] });
      }
    }
    const gone = o.hold + o.fade;
    this.tracks = this.tracks.filter((tr) => t - tr.lastSeen <= gone);
  }

  private step(tr: Track, t: number, face: DetectedFace, width: number) {
    const o = this.o;
    const dt = t > tr.lastT ? t - tr.lastT : 1 / 30;
    const [fx, fy] = ovalCentre(tr.filtered);
    const [cx, cy] = ovalCentre(face.points);
    const speed = Math.hypot((cx - fx) * o.aspect, cy - fy) / dt / width;
    tr.velocity += alpha(o.derivativeCutoff, dt) * (speed - tr.velocity);
    const a = alpha(o.minCutoff + o.beta * tr.velocity, dt);
    for (let i = 0; i < tr.filtered.length; i++) tr.filtered[i] += a * (face.points[i] - tr.filtered[i]);
    tr.width = width;
    for (let k = 0; k < 3; k++) tr.skin[k] += 0.35 * (face.skin[k] - tr.skin[k]);
    if (t > tr.lastT || !tr.history.length) {
      tr.history.push({ t, points: tr.filtered.slice() });
      if (tr.history.length > 4) tr.history.shift();
    } else tr.history[tr.history.length - 1] = { t: tr.history[tr.history.length - 1].t, points: tr.filtered.slice() };
    tr.lastT = Math.max(tr.lastT, t);
    tr.lastSeen = Math.max(tr.lastSeen, t);
  }

  /** The faces at `t`. */
  sample(t: number): TrackedFace[] {
    const o = this.o;
    const out: TrackedFace[] = [];
    for (const tr of this.tracks) {
      const h = tr.history;
      if (!h.length) continue;
      let points: Float32Array;
      const last = h[h.length - 1];
      if (t >= last.t) {
        points = last.points.slice();
        if (h.length >= 2) {
          const prev = h[h.length - 2];
          const span = last.t - prev.t;
          const ahead = Math.min(t - last.t, o.maxExtrapolate);
          if (span > 1e-4 && ahead > 0) for (let i = 0; i < points.length; i++) points[i] += ((last.points[i] - prev.points[i]) / span) * ahead;
        }
      } else if (t <= h[0].t) {
        if (h[0].t - t > 0.1) continue;
        points = h[0].points.slice();
      } else {
        let i = h.length - 2;
        while (i > 0 && h[i].t > t) i--;
        const a = h[i];
        const b = h[i + 1];
        const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
        points = new Float32Array(a.points.length);
        for (let k = 0; k < points.length; k++) points[k] = a.points[k] + (b.points[k] - a.points[k]) * f;
      }
      const since = t - tr.lastSeen;
      const weight = since <= o.hold ? 1 : Math.max(0, 1 - (since - o.hold) / o.fade);
      if (weight <= 0) continue;
      out.push({ points, weight, skin: [...tr.skin] as [number, number, number], scene: { faceSize: tr.width / Math.min(1, o.aspect), skinLuma: luma709(tr.skin) } });
    }
    return out;
  }
}

/** One tracked face's retouch for a `width` × `height` frame (null: nothing to do). */
export function frameRetouch(face: TrackedFace, params: FaceParams, width: number, height: number): RetouchGeometry | null {
  const px = new Float32Array(face.points.length);
  for (let i = 0; i < px.length; i += 2) {
    px[i] = face.points[i] * width;
    px[i + 1] = face.points[i + 1] * height;
  }
  return buildRetouchGeometry({ points: px, strengths: resolveFaceStrengths(params, face.scene), weight: face.weight });
}
