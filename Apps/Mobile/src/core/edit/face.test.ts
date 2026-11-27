import { describe, expect, it } from 'vitest';
import { demoStudioFace } from '../../features/picture/web/demoFace';
import {
  FACE_POINT_COUNT,
  FACE_UNIFORM_VEC4,
  FaceTracker,
  RETOUCH_LIMITS,
  autoFaceStrengths,
  brightenLift,
  brightenValue,
  buildRetouchGeometry,
  combineStrength,
  ellipseDistance,
  faceIsIdentity,
  frameRetouch,
  outlineDistance,
  packFaceUniforms,
  resolveFaceStrengths,
  retouchWarpSource,
  skinMask,
  type DetectedFace,
  type FaceStrengths,
} from './face';
import { defaultFace, hasColor, normalizeEdit, previewPlan } from './index';

const W = 1280;
const H = 720;
const face = (t = 0) => demoStudioFace(t, W, H);
const norm = (px: Float32Array) => px.map((v, i) => (i % 2 ? v / H : v / W));
const SKIN = [0.7, 0.52, 0.44] as const;
const all = (v: number): FaceStrengths => ({ smooth: v, brighten: v, slim: v, eyes: v });
const zero = all(0);

describe('face params', () => {
  it('a clip with every face strength at 0 is identity (no face stage)', () => {
    expect(faceIsIdentity(defaultFace())).toBe(true);
    expect(faceIsIdentity({ ...defaultFace(), auto: 0.0005 })).toBe(true);
    expect(faceIsIdentity({ ...defaultFace(), eyes: 0.2 })).toBe(false);
    const e = normalizeEdit({ face: { ...defaultFace(), smooth: 0.5 } });
    expect(hasColor(e)).toBe(true);
    expect(previewPlan(e, { width: 1920, height: 1080 }, { compare: true, hdrSource: false }).split).not.toBeNull();
  });

  it('Auto 0 leaves the sliders as they are', () => {
    const p = { auto: 0, smooth: 0.4, brighten: 0.2, slim: 0.1, eyes: 0.7 };
    expect(resolveFaceStrengths(p, { faceSize: 0.3, skinLuma: 0.5 })).toEqual({ smooth: 0.4, brighten: 0.2, slim: 0.1, eyes: 0.7 });
  });

  it('Auto adds a light mix: more smoothing on close-ups, more lift on dim skin, none on bright skin', () => {
    expect(autoFaceStrengths(0, { faceSize: 0.3, skinLuma: 0.3 })).toEqual(zero);
    const wide = autoFaceStrengths(1, { faceSize: 0.1, skinLuma: 0.5 });
    const close = autoFaceStrengths(1, { faceSize: 0.5, skinLuma: 0.5 });
    expect(close.smooth).toBeGreaterThan(wide.smooth);
    expect(close.eyes).toBeGreaterThan(wide.eyes);
    const dim = autoFaceStrengths(1, { faceSize: 0.3, skinLuma: 0.25 });
    const lit = autoFaceStrengths(1, { faceSize: 0.3, skinLuma: 0.6 });
    const hot = autoFaceStrengths(1, { faceSize: 0.3, skinLuma: 0.9 });
    expect(dim.brighten).toBeGreaterThan(0.5);
    expect(lit.brighten).toBeLessThan(0.15);
    expect(hot.brighten).toBe(0);
    // Natural: Auto never pushes anything past 60 %, slimming stays subtle.
    for (const s of [wide, close, dim, lit, hot]) for (const v of Object.values(s)) expect(v).toBeLessThanOrEqual(0.6);
    expect(close.slim).toBeLessThan(0.2);
    // Half Auto is half of full Auto.
    expect(autoFaceStrengths(0.5, { faceSize: 0.3, skinLuma: 0.25 }).brighten).toBeCloseTo(dim.brighten / 2, 6);
  });

  it('sliders stay adjustable with Auto on and never pass 100 %', () => {
    const scene = { faceSize: 0.3, skinLuma: 0.3 };
    const a = resolveFaceStrengths({ auto: 1, smooth: 0, brighten: 0, slim: 0, eyes: 0 }, scene);
    const b = resolveFaceStrengths({ auto: 1, smooth: 0.5, brighten: 0.5, slim: 0.5, eyes: 0.5 }, scene);
    const c = resolveFaceStrengths({ auto: 1, smooth: 1, brighten: 1, slim: 1, eyes: 1 }, scene);
    for (const k of ['smooth', 'brighten', 'slim', 'eyes'] as const) {
      expect(b[k]).toBeGreaterThan(a[k]);
      expect(c[k]).toBe(1);
    }
    expect(combineStrength(0.5, 0.5)).toBeCloseTo(0.75, 9);
    expect(combineStrength(2, -1)).toBe(1);
  });
});

describe('retouch geometry', () => {
  it('is null at strength 0 and for faces too small to touch', () => {
    expect(buildRetouchGeometry({ points: face(), strengths: zero })).toBeNull();
    expect(buildRetouchGeometry({ points: face(), strengths: all(1), weight: 0 })).toBeNull();
    const tiny = face().map((v) => v * 0.01);
    expect(buildRetouchGeometry({ points: tiny, strengths: all(1) })).toBeNull();
    expect(buildRetouchGeometry({ points: new Float32Array(10), strengths: all(1) })).toBeNull();
  });

  it('scales its amounts by strength and the RETOUCH_LIMITS', () => {
    const g = buildRetouchGeometry({ points: face(), strengths: { smooth: 0.5, brighten: 1, slim: 0, eyes: 0.5 } })!;
    expect(g.amounts.smooth).toBeCloseTo(0.5 * RETOUCH_LIMITS.smooth, 6);
    expect(g.amounts.brighten).toBeCloseTo(RETOUCH_LIMITS.brighten, 6);
    expect(g.amounts.magnify).toBeCloseTo(0.5 * RETOUCH_LIMITS.magnify, 6);
    expect(g.pushes.every((p) => p.dx === 0 && p.dy === 0)).toBe(true);
    expect(g.faceWidth).toBeGreaterThan(100);
    // The eye line of an upright face is level, left to right in the picture.
    expect(g.axis[0]).toBeCloseTo(1, 3);
    // Bounds hold the whole outline.
    for (let i = 0; i < g.oval.length; i += 2) {
      expect(g.oval[i]).toBeGreaterThan(g.bounds[0]);
      expect(g.oval[i]).toBeLessThan(g.bounds[2]);
      expect(g.oval[i + 1]).toBeGreaterThan(g.bounds[1]);
      expect(g.oval[i + 1]).toBeLessThan(g.bounds[3]);
    }
  });

  it('slim pulls the jaw towards the centre line, clamped', () => {
    const g = buildRetouchGeometry({ points: face(), strengths: { ...zero, slim: 1 } })!;
    const cx = (g.bounds[0] + g.bounds[2]) / 2;
    expect(g.pushes).toHaveLength(6);
    for (const p of g.pushes) {
      // Towards the middle: the push and (centre − point) agree in x.
      expect(Math.sign(p.dx)).toBe(Math.sign(cx - p.x));
      expect(Math.hypot(p.dx, p.dy)).toBeLessThanOrEqual(g.pushRadius * RETOUCH_LIMITS.maxPushOfRadius + 1e-6);
      expect(Math.hypot(p.dx, p.dy)).toBeLessThanOrEqual(0.032 * g.faceWidth + 1e-6);
    }
  });
});

describe('warp', () => {
  const g = buildRetouchGeometry({ points: face(), strengths: { smooth: 0, brighten: 0, slim: 1, eyes: 1 } })!;

  it('is identity where the effects are off and outside their reach', () => {
    const off = buildRetouchGeometry({ points: face(), strengths: { smooth: 1, brighten: 1, slim: 0, eyes: 0 } })!;
    for (const [x, y] of [[300, 300], [g.eyes[0].x + 3, g.eyes[0].y - 2], [g.pushes[0].x, g.pushes[0].y]]) {
      expect(retouchWarpSource(off, x, y)).toEqual([x, y]);
    }
    // Far outside the face, nothing moves (the background doesn't bend).
    for (const [x, y] of [[g.bounds[0] - 1, g.bounds[1] - 1], [g.bounds[2] + 1, (g.bounds[1] + g.bounds[3]) / 2], [1200, 600]]) {
      expect(retouchWarpSource(g, x, y)).toEqual([x, y]);
    }
  });

  it('magnifies around each eye (samples come from nearer the centre)', () => {
    const e = g.eyes[0];
    const [sx] = retouchWarpSource(g, e.x + e.radius * 0.4, e.y);
    expect(sx).toBeLessThan(e.x + e.radius * 0.4);
    expect(sx).toBeGreaterThan(e.x);
    expect(retouchWarpSource(g, e.x, e.y)).toEqual([e.x, e.y]);
  });

  it('pulls the jaw in: a jaw pixel shows what was further out', () => {
    const p = g.pushes[1];
    const [sx, sy] = retouchWarpSource(g, p.x, p.y);
    const moved = Math.hypot(sx - p.x, sy - p.y);
    expect(moved).toBeGreaterThanOrEqual(Math.hypot(p.dx, p.dy) - 1e-6);
    expect(moved).toBeLessThan(0.06 * g.faceWidth);
    expect((sx - p.x) * p.dx + (sy - p.y) * p.dy).toBeLessThan(0);
  });

  it('never folds: the mapping keeps a positive Jacobian across the face at full strength', () => {
    const [x0, y0, x1, y1] = g.bounds;
    let worst = Infinity;
    for (let y = y0; y <= y1; y += 3) {
      for (let x = x0; x <= x1; x += 3) {
        const a = retouchWarpSource(g, x, y);
        const bx = retouchWarpSource(g, x + 0.5, y);
        const by = retouchWarpSource(g, x, y + 0.5);
        const det = ((bx[0] - a[0]) * (by[1] - a[1]) - (bx[1] - a[1]) * (by[0] - a[0])) / 0.25;
        worst = Math.min(worst, det);
      }
    }
    expect(worst).toBeGreaterThan(0.3);
  });
});

describe('skin mask and lift', () => {
  const g = buildRetouchGeometry({ points: face(), strengths: all(1) })!;
  const cheek = [g.cheeks[0], g.cheeks[1]] as const;

  it('covers the cheeks, leaves out the eyes, the lips and everything outside', () => {
    expect(skinMask(g, cheek[0], cheek[1], SKIN, SKIN).skin).toBeGreaterThan(0.95);
    expect(skinMask(g, g.eyeHoles[0].x, g.eyeHoles[0].y, SKIN, SKIN).skin).toBe(0);
    expect(skinMask(g, g.mouth.x, g.mouth.y, SKIN, SKIN).skin).toBe(0);
    expect(skinMask(g, 1200, 100, SKIN, SKIN).skin).toBe(0);
    // The chroma check: a blue shirt or green background inside the oval is not skin.
    expect(skinMask(g, cheek[0], cheek[1], [0.1, 0.2, 0.6], SKIN).skin).toBeLessThan(0.01);
    expect(skinMask(g, cheek[0], cheek[1], [0.2, 0.6, 0.2], SKIN).tone).toBe(0);
  });

  it('measures the outline and ellipses as a shader would', () => {
    const cx = (g.bounds[0] + g.bounds[2]) / 2;
    const cy = (g.bounds[1] + g.bounds[3]) / 2;
    expect(outlineDistance(g.oval, cx, cy)).toBeLessThan(0);
    expect(outlineDistance(g.oval, 5, 5)).toBeGreaterThan(0);
    expect(Math.abs(outlineDistance(g.oval, g.oval[8], g.oval[9]))).toBeLessThan(1e-3);
    const e = g.eyeHoles[1];
    expect(ellipseDistance(e, g.axis, e.x, e.y)).toBe(0);
    expect(ellipseDistance(e, g.axis, e.x + e.rx * g.axis[0], e.y + e.rx * g.axis[1])).toBeCloseTo(1, 6);
  });

  it('lifts mid-tones only, keeps black, white and HDR highlights', () => {
    expect(brightenValue(0.4, 0)).toBe(0.4);
    expect(brightenValue(0, 0.3)).toBe(0);
    expect(brightenValue(0.4, 0.28)).toBeGreaterThan(0.45);
    expect(brightenValue(1, 0.28)).toBe(1);
    expect(brightenValue(3.5, 0.28)).toBe(3.5);
    for (let v = 0; v <= 1.2; v += 0.01) {
      expect(brightenValue(v, 0.28)).toBeGreaterThanOrEqual(v);
      expect(brightenValue(v + 0.01, 0.28)).toBeGreaterThanOrEqual(brightenValue(v, 0.28) - 1e-9);
    }
    const m = skinMask(g, cheek[0], cheek[1], SKIN, SKIN);
    expect(brightenLift(g.amounts.brighten, m)).toBeCloseTo(g.amounts.brighten, 2);
    expect(brightenLift(g.amounts.brighten, skinMask(g, 1200, 100, SKIN, SKIN))).toBe(0);
  });
});

describe('uniform layout', () => {
  it('packs one face in FACE_UNIFORM_VEC4 vec4s, oval then cheeks last', () => {
    const g = buildRetouchGeometry({ points: face(), strengths: all(0.5) })!;
    const u = packFaceUniforms(g, SKIN);
    expect(u.length).toBe(FACE_UNIFORM_VEC4 * 4);
    expect(Array.from(u.subarray(0, 4))).toEqual(Array.from(new Float32Array([g.amounts.smooth, g.amounts.magnify, g.amounts.brighten, g.smoothRadius])));
    expect(u[12]).toBeCloseTo(g.eyes[0].x, 3);
    expect(u[32]).toBeCloseTo(SKIN[0], 6);
    expect(u[35]).toBe(1);
    expect(u[36]).toBeCloseTo(g.pushes[0].x, 3);
    expect(Array.from(u.subarray(60, 96))).toEqual(Array.from(g.oval));
    expect(Array.from(u.subarray(96))).toEqual(Array.from(new Float32Array(g.cheeks)));
    // No colour given: the shader samples the cheeks itself.
    expect(Array.from(packFaceUniforms(g).subarray(32, 36))).toEqual([0, 0, 0, 0]);
  });
});

describe('face tracker', () => {
  const det = (t: number, dx = 0, noise = 0, seed = 1): DetectedFace => {
    const p = norm(face(0));
    let s = seed * 9301 + Math.round(t * 1000);
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    for (let i = 0; i < p.length; i += 2) {
      p[i] += dx + noise * rand();
      p[i + 1] += noise * rand();
    }
    return { points: p, skin: SKIN };
  };
  const centreX = (p: ArrayLike<number>) => {
    let x = 0;
    for (let i = 0; i < 36; i += 2) x += p[i];
    return x / 18;
  };

  it('takes out frame-to-frame jitter on a still face', () => {
    const tr = new FaceTracker();
    const raw: number[] = [];
    const out: number[] = [];
    for (let f = 0; f < 90; f++) {
      const t = f / 30;
      const d = det(t, 0, 0.004);
      tr.update(t, [d]);
      if (f > 10) {
        raw.push(d.points[20]);
        out.push(tr.sample(t)[0].points[20]);
      }
    }
    const jitter = (a: number[]) => a.slice(1).reduce((s, v, i) => s + Math.abs(v - a[i]), 0) / (a.length - 1);
    expect(jitter(out)).toBeLessThan(jitter(raw) * 0.4);
  });

  it('follows a moving face closely (the cutoff opens with speed)', () => {
    const tr = new FaceTracker();
    for (let f = 0; f <= 30; f++) tr.update(f / 30, [det(f / 30, f * 0.01)]);
    const shown = centreX(tr.sample(1)[0].points);
    const truth = centreX(det(1, 0.3).points);
    expect(Math.abs(shown - truth)).toBeLessThan(0.02);
  });

  it('interpolates between lower-rate detections and extrapolates only briefly', () => {
    const tr = new FaceTracker({ minCutoff: 1000 });
    tr.update(0, [det(0, 0)]);
    tr.update(0.1, [det(0.1, 0.01)]);
    tr.update(0.2, [det(0.2, 0.02)]);
    const mid = centreX(tr.sample(0.15)[0].points);
    expect(mid).toBeCloseTo((centreX(det(0, 0.01).points) + centreX(det(0, 0.02).points)) / 2, 4);
    const ahead = centreX(tr.sample(0.25)[0].points) - centreX(det(0, 0.02).points);
    expect(ahead).toBeCloseTo(0.005, 3);
    const far = centreX(tr.sample(0.6)[0].points) - centreX(det(0, 0.02).points);
    expect(far).toBeCloseTo(0.008, 3);
  });

  it('holds a missed face, then fades it out', () => {
    const tr = new FaceTracker();
    tr.update(0, [det(0)]);
    tr.update(0.1, []);
    expect(tr.sample(0.1)[0].weight).toBe(1);
    expect(tr.sample(0.4)[0].weight).toBe(1);
    const fading = tr.sample(0.55)[0].weight;
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(1);
    expect(tr.sample(0.75)).toHaveLength(0);
    tr.update(0.8, []);
    expect(tr.count).toBe(0);
  });

  it('starts afresh after a seek back', () => {
    const tr = new FaceTracker();
    for (let f = 0; f < 10; f++) tr.update(1 + f / 30, [det(1 + f / 30, 0.2)]);
    tr.update(0.2, [det(0.2, 0)]);
    expect(centreX(tr.sample(0.2)[0].points)).toBeCloseTo(centreX(det(0, 0).points), 6);
  });

  it('keeps up to three faces, largest first, each its own track', () => {
    const tr = new FaceTracker();
    const shifted = (dx: number, scale: number): DetectedFace => {
      const p = norm(face(0));
      const cx = centreX(p);
      for (let i = 0; i < p.length; i += 2) p[i] = cx + (p[i] - cx) * scale + dx;
      return { points: p, skin: SKIN };
    };
    const faces = [shifted(0, 1), shifted(0.3, 0.6), shifted(0.55, 0.5), shifted(0.75, 0.4)];
    tr.update(0, faces);
    tr.update(1 / 30, faces);
    const got = tr.sample(1 / 30);
    expect(got).toHaveLength(3);
    expect(got[0].scene.faceSize).toBeGreaterThan(got[1].scene.faceSize);
  });

  it('gives a frame retouch in frame pixels from a tracked face', () => {
    const tr = new FaceTracker();
    tr.update(0, [det(0)]);
    const [f] = tr.sample(0);
    expect(f.points).toHaveLength(FACE_POINT_COUNT * 2);
    expect(frameRetouch(f, defaultFace(), W, H)).toBeNull();
    const g = frameRetouch(f, { ...defaultFace(), auto: 1 }, W, H)!;
    expect(g.amounts.smooth).toBeGreaterThan(0);
    expect(g.faceWidth).toBeCloseTo(buildRetouchGeometry({ points: face(0), strengths: all(1) })!.faceWidth, 0);
  });
});
