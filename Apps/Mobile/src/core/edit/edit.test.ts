import { describe, expect, it } from 'vitest';
import { mapCube, parseCube, formatCube, cubeFrom } from '../media/cubeLut';
import {
  LOOKS,
  LOOK_CATEGORIES,
  applyCubeToRGBA,
  applyPreset,
  base64,
  bmpDataUri,
  compareSplit,
  composeEditCube,
  cropRect,
  defaultCrop,
  defaultEdit,
  editCubeKey,
  exportFileName,
  exportLabel,
  exportOverall,
  exportPlan,
  exportReducer,
  hasGeometry,
  idleExport,
  isIdentity,
  lookById,
  lookCubeFor,
  mapLook,
  normalizeEdit,
  outputAspect,
  outputSize,
  panBy,
  presetFrom,
  presetList,
  previewLayout,
  previewPlan,
  resetTool,
  revertTool,
  rgbaToBmp,
  rotateKeepingFrame,
  sCurve,
  setTrimPoint,
  sourceToOutput,
  toolEdited,
  zoomTo,
  type ClipEdit,
} from '.';

const UHD = { width: 3840, height: 2160 };
const noFlip = { h: false, v: false };

describe('edit model', () => {
  it('defaults are identity', () => {
    expect(isIdentity(defaultEdit())).toBe(true);
    expect(normalizeEdit(undefined)).toEqual(defaultEdit());
  });

  it('normalizes stored edits: clamps, drops junk, keeps valid fields', () => {
    const e = normalizeEdit({
      look: 'pro-clear',
      lookStrength: 3,
      rotation: 45 as never,
      volume: -1,
      crop: { aspect: 'bogus' as never, zoom: 9, panX: 4, panY: -4 },
      face: { smooth: 2 } as never,
    });
    expect(e.lookStrength).toBe(1);
    expect(e.rotation).toBe(0);
    expect(e.volume).toBe(0);
    expect(e.crop).toEqual({ aspect: 'original', zoom: 4, panX: 1, panY: -1 });
    expect(e.face.smooth).toBe(1);
    expect(e.face.eyes).toBe(0);
  });

  it('trim shorter than the minimum or covering the clip is dropped', () => {
    expect(normalizeEdit({ trim: { start: 2, end: 2.2 } }, 10).trim).toBeNull();
    expect(normalizeEdit({ trim: { start: 0, end: 10 } }, 10).trim).toBeNull();
    expect(normalizeEdit({ trim: { start: 1, end: 20 } }, 10).trim).toEqual({ start: 1, end: 10 });
  });

  it('trim points keep a minimum length', () => {
    let e = setTrimPoint(defaultEdit(), 'start', 4, 10);
    expect(e.trim).toEqual({ start: 4, end: 10 });
    e = setTrimPoint(e, 'end', 3, 10);
    expect(e.trim!.end).toBeCloseTo(4.5);
  });

  it('✕ reverts only the open tool; Reset clears it', () => {
    const before: ClipEdit = { ...defaultEdit(), look: 'pro-clear', volume: 1.5 };
    const during: ClipEdit = { ...before, look: 'mono-silver', lookStrength: 0.4, volume: 0.5 };
    const reverted = revertTool(during, before, 'filter');
    expect(reverted.look).toBe('pro-clear');
    expect(reverted.lookStrength).toBe(1);
    expect(reverted.volume).toBe(0.5);
    expect(resetTool(during, 'volume').volume).toBe(1);
    expect(toolEdited(during, 'filter')).toBe(true);
    expect(toolEdited(resetTool(during, 'filter'), 'filter')).toBe(false);
  });

  it('revert deep-copies the crop', () => {
    const before = defaultEdit();
    const reverted = revertTool({ ...before, crop: { ...before.crop, zoom: 2 } }, before, 'aspect');
    reverted.crop.zoom = 3;
    expect(before.crop.zoom).toBe(1);
  });

  it('rotating swaps a portrait/landscape crop and turns the pan', () => {
    const e = rotateKeepingFrame({ ...defaultEdit(), crop: { aspect: '16:9', zoom: 2, panX: 0.5, panY: 0.25 } });
    expect(e.rotation).toBe(90);
    expect(e.crop.aspect).toBe('9:16');
    expect(e.crop.panX).toBeCloseTo(-0.25);
    expect(e.crop.panY).toBeCloseTo(0.5);
    expect(rotateKeepingFrame(rotateKeepingFrame(rotateKeepingFrame(e))).rotation).toBe(0);
  });
});

describe('presets', () => {
  it('captures look, aspect, rotation, volume, face; not trim or pan', () => {
    const e: ClipEdit = {
      ...defaultEdit(),
      look: 'film-matte',
      lookStrength: 0.6,
      lut: 'my-lut',
      crop: { aspect: '1:1', zoom: 2, panX: 0.3, panY: 0 },
      rotation: 180,
      volume: 1.4,
      trim: { start: 1, end: 3 },
    };
    const p = presetFrom(e, '  Moody ', 'p1', 5);
    expect(p).toMatchObject({ id: 'p1', name: 'Moody', look: 'film-matte', lookStrength: 0.6, lut: 'my-lut', aspect: '1:1', rotation: 180, volume: 1.4 });
    const target: ClipEdit = { ...defaultEdit(), trim: { start: 2, end: 8 } };
    const applied = applyPreset(target, p);
    expect(applied.look).toBe('film-matte');
    expect(applied.crop).toEqual(defaultCrop('1:1'));
    expect(applied.trim).toEqual({ start: 2, end: 8 });
  });

  it('list CRUD', () => {
    const a = presetFrom(defaultEdit(), 'A', 'a');
    const b = presetFrom(defaultEdit(), 'B', 'b');
    let list = presetList.add([], a);
    list = presetList.add(list, b);
    expect(list.map((p) => p.id)).toEqual(['b', 'a']);
    list = presetList.add(list, { ...a, name: 'A2' });
    expect(list.map((p) => p.name)).toEqual(['A2', 'B']);
    list = presetList.rename(list, 'b', 'Bee');
    expect(list[1].name).toBe('Bee');
    expect(presetList.rename(list, 'b', '   ')).toBe(list);
    list = presetList.remove(list, 'a');
    expect(list.map((p) => p.id)).toEqual(['b']);
    expect(presetList.nextName([{ ...a, name: 'Preset 2' }])).toBe('Preset 3');
  });
});

describe('looks', () => {
  it('ids are unique, every category is used, names are ours', () => {
    const ids = new Set(LOOKS.map((l) => l.id));
    expect(ids.size).toBe(LOOKS.length);
    for (const c of LOOK_CATEGORIES.filter((c) => c.id !== 'original')) expect(LOOKS.some((l) => l.category === c.id)).toBe(true);
    // No DJI Mimo filter names.
    for (const l of LOOKS) expect(l.name).not.toMatch(/spring|summer|autumn|winter/i);
  });

  it('every look maps into 0…1 and keeps black-ish blacks', () => {
    for (const l of LOOKS) {
      for (const [r, g, b] of [
        [0, 0, 0],
        [1, 1, 1],
        [0.5, 0.3, 0.2],
        [0.1, 0.9, 0.4],
      ] as const) {
        const m = mapLook(l.params, r, g, b);
        for (const v of m) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
      expect(Math.max(...mapLook(l.params, 0, 0, 0))).toBeLessThan(0.15);
    }
  });

  it('mono looks are grey on the neutral axis and colourless', () => {
    const [r, g, b] = mapLook(lookById('mono-silver')!.params, 0.8, 0.2, 0.1);
    expect(r).toBeCloseTo(g, 5);
    expect(g).toBeCloseTo(b, 5);
  });

  it('warm looks warm a neutral grey', () => {
    const [r, , b] = mapLook(lookById('pro-golden')!.params, 0.5, 0.5, 0.5);
    expect(r).toBeGreaterThan(b);
    const [r2, , b2] = mapLook(lookById('cine-arctic')!.params, 0.5, 0.5, 0.5);
    expect(b2).toBeGreaterThan(r2);
  });

  it('s-curve is monotonic with fixed ends and pivot', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = sCurve(i / 100, 1.4);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(sCurve(0, 1.4)).toBe(0);
    expect(sCurve(1, 1.4)).toBe(1);
    expect(sCurve(0.45, 1.4)).toBeCloseTo(0.45);
  });

  it('generated cubes are valid .cube files', () => {
    const cube = lookCubeFor(LOOKS[0], 17);
    expect(cube.size).toBe(17);
    expect(cube.rgb.length).toBe(17 ** 3 * 3);
    const round = parseCube(formatCube(cube));
    expect(round.size).toBe(17);
    expect(mapCube(round, 0.3, 0.6, 0.2)[1]).toBeCloseTo(mapCube(cube, 0.3, 0.6, 0.2)[1], 4);
  });

  it('composed cube: none → null; strength mixes toward identity', () => {
    expect(composeEditCube({ look: null, lookStrength: 1, custom: null, customStrength: 1 })).toBeNull();
    const look = lookById('mono-high')!;
    const full = composeEditCube({ look, lookStrength: 1, custom: null, customStrength: 0, size: 9 })!;
    const half = composeEditCube({ look, lookStrength: 0.5, custom: null, customStrength: 0, size: 9 })!;
    const p = [0.75, 0.25, 0.25] as const;
    const f = mapCube(full, ...p);
    const h = mapCube(half, ...p);
    for (let c = 0; c < 3; c++) expect(h[c]).toBeCloseTo((p[c] + f[c]) / 2, 2);
  });

  it('composed cube runs the custom LUT before the look', () => {
    // Custom: swap red and blue. Look: none at 0 strength → pure custom.
    const swap = cubeFrom(5, (r, g, b) => [b, g, r]);
    const only = composeEditCube({ look: null, lookStrength: 0, custom: swap, customStrength: 1, size: 5 })!;
    const m = mapCube(only, 1, 0, 0);
    expect(m[0]).toBeCloseTo(0);
    expect(m[2]).toBeCloseTo(1);
    // With a mono look after it, the result is the mono of the swapped colour.
    const both = composeEditCube({ look: lookById('mono-silver')!, lookStrength: 1, custom: swap, customStrength: 1, size: 17 })!;
    const expected = mapLook(lookById('mono-silver')!.params, 0.2, 0.5, 0.9);
    const got = mapCube(both, 0.9, 0.5, 0.2);
    expect(got[0]).toBeCloseTo(expected[0], 1);
  });

  it('cube keys change with strength and are null without colour', () => {
    expect(editCubeKey(defaultEdit())).toBeNull();
    const a = editCubeKey({ look: 'pro-clear', lookStrength: 1, lut: null, lutStrength: 1 });
    const b = editCubeKey({ look: 'pro-clear', lookStrength: 0.5, lut: null, lutStrength: 1 });
    expect(a).not.toBe(b);
    expect(editCubeKey({ look: 'pro-clear', lookStrength: 0, lut: null, lutStrength: 1 })).toBeNull();
  });

  it('applies a cube to RGBA keeping alpha', () => {
    const cube = lookCubeFor(lookById('mono-silver')!, 9);
    const out = applyCubeToRGBA(cube, [255, 0, 0, 77]);
    expect(out[0]).toBe(out[1]);
    expect(out[3]).toBe(77);
  });
});

describe('geometry', () => {
  it('original aspect at zoom 1 is the full frame', () => {
    expect(cropRect(UHD, 0, defaultCrop())).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(outputSize(UHD, 0, defaultCrop())).toEqual(UHD);
    expect(outputSize(UHD, 90, defaultCrop())).toEqual({ width: 2160, height: 3840 });
  });

  it('9:16 from a 16:9 clip is a centred full-height strip', () => {
    const r = cropRect(UHD, 0, defaultCrop('9:16'));
    expect(r.h).toBeCloseTo(1);
    expect(r.w * 3840).toBeCloseTo(2160 * (9 / 16));
    expect(r.x + r.w / 2).toBeCloseTo(0.5);
    const out = outputSize(UHD, 0, defaultCrop('9:16'));
    expect(out.width % 2).toBe(0);
    expect(out.height).toBe(2160);
    expect(outputAspect(UHD, 0, defaultCrop('9:16'))).toBeCloseTo(9 / 16);
  });

  it('pan reaches the edges and no further', () => {
    const left = cropRect(UHD, 0, { aspect: '1:1', zoom: 1, panX: -1, panY: 0 });
    expect(left.x).toBeCloseTo(0);
    const right = cropRect(UHD, 0, { aspect: '1:1', zoom: 1, panX: 1, panY: 0 });
    expect(right.x + right.w).toBeCloseTo(1);
  });

  it('zoom shrinks the crop about its centre', () => {
    const c = zoomTo(UHD, 0, defaultCrop('16:9'), 2);
    const r = cropRect(UHD, 0, c);
    expect(r.w).toBeCloseTo(0.5);
    expect(r.x).toBeCloseTo(0.25);
  });

  it('low-res caps the long side', () => {
    const out = outputSize(UHD, 0, defaultCrop(), 1280);
    expect(out).toEqual({ width: 1280, height: 720 });
  });

  it('dragging moves the content with the finger', () => {
    const crop = { aspect: '1:1' as const, zoom: 1, panX: 0, panY: 0 };
    const moved = panBy(UHD, 0, crop, noFlip, 0.1, 0);
    // Finger right → content right → crop moves left.
    expect(moved.panX).toBeLessThan(0);
    const flipped = panBy(UHD, 0, crop, { h: true, v: false }, 0.1, 0);
    expect(flipped.panX).toBeGreaterThan(0);
  });

  it('preview layout puts the crop exactly in the frame', () => {
    const crop = { aspect: '1:1' as const, zoom: 1, panX: 1, panY: 0 };
    const frame = { width: 300, height: 300 };
    const l = previewLayout(UHD, 0, crop, noFlip, frame);
    // Box is the whole picture at frame scale: 16:9 over a 300 tall frame.
    expect(l.box.height).toBeCloseTo(300);
    expect(l.box.width).toBeCloseTo(300 * (16 / 9));
    // Panned right: the box's right edge meets the frame's right edge.
    expect(l.box.left + l.box.width).toBeCloseTo(300);
    const turned = previewLayout(UHD, 90, defaultCrop(), noFlip, { width: 216, height: 384 });
    expect(turned.inner.width).toBeCloseTo(384);
    expect(turned.inner.height).toBeCloseTo(216);
    expect(turned.inner.rotate).toBe(90);
  });

  it('source → output mapping follows rotate, crop, flip', () => {
    // 90° cw: the source's top-left corner lands top-right.
    const p = sourceToOutput(UHD, 90, defaultCrop(), noFlip, 0, 0);
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(0);
    const q = sourceToOutput(UHD, 0, defaultCrop(), { h: true, v: false }, 0, 0);
    expect(q.x).toBeCloseTo(1);
  });

  it('compare split puts the original on the screen’s left for every rotation and flip', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      for (const h of [false, true]) {
        const flip = { h, v: false };
        const crop = { aspect: '1:1' as const, zoom: 1.5, panX: 0.4, panY: -0.2 };
        const split = compareSplit(UHD, rotation, crop, flip);
        // Two source points either side of the line: the one on the "original" side must land
        // on the left half of the output.
        const eps = 0.01;
        const onLine = split.at;
        const origCoord = split.originalLow ? onLine - eps : onLine + eps;
        const other = split.originalLow ? onLine + eps : onLine - eps;
        // Hold the other axis at the crop's centre in source space (pick a point on screen centre).
        const centre = (axisVal: number) => {
          // brute: scan the other axis for a point inside the output frame
          for (let t = 0; t <= 1; t += 0.01) {
            const [u, v] = split.axis === 'x' ? [axisVal, t] : [t, axisVal];
            const o = sourceToOutput(UHD, rotation, crop, flip, u, v);
            if (o.x > 0 && o.x < 1 && o.y > 0.2 && o.y < 0.8) return o;
          }
          return null;
        };
        const a = centre(origCoord);
        const b = centre(other);
        expect(a && a.x).toBeLessThan(0.5);
        expect(b && b.x).toBeGreaterThan(0.5);
      }
    }
  });
});

describe('plans', () => {
  it('preview plan: compare only with colour; tone-map only for HDR sources', () => {
    const e: ClipEdit = { ...defaultEdit(), look: 'pro-clear', hdr: 'sdr' };
    expect(previewPlan(e, UHD, { compare: true, hdrSource: true })).toMatchObject({ lutKey: expect.any(String), toneMapSdr: true, split: { axis: 'x' } });
    expect(previewPlan(defaultEdit(), UHD, { compare: true, hdrSource: false }).split).toBeNull();
    expect(previewPlan(e, UHD, { compare: false, hdrSource: false }).toneMapSdr).toBe(false);
  });

  it('export plan carries the geometry and output size', () => {
    const e: ClipEdit = { ...defaultEdit(), rotation: 90, crop: defaultCrop('1:1'), volume: 0, trim: { start: 1, end: 4 } };
    const p = exportPlan(e, { sourceUri: 'file:///a.mp4', sourceSize: UHD, fileName: 'DJI_0001.MP4', quality: 'original', hdrSource: true });
    expect(p.width).toBe(p.height);
    expect(p.width).toBe(2160);
    expect(p.rotation).toBe(90);
    expect(p.outputName).toBe('DJI_0001_edit.mp4');
    expect(p.keepHdr).toBe(true);
    expect(p.geometryIdentity).toBe(false);
    expect(hasGeometry(e)).toBe(true);
    const plain = exportPlan(defaultEdit(), { sourceUri: 'x', sourceSize: UHD, fileName: 'a b.mov', quality: 'low-res', hdrSource: false });
    expect(plain.width).toBe(1280);
    expect(plain.keepHdr).toBe(false);
    expect(exportFileName('a b.mov')).toBe('a_b_edit.mp4');
  });
});

describe('export job', () => {
  it('download → render → save → done', () => {
    let s = exportReducer(idleExport(), { type: 'start', id: 'j', itemId: 'i', quality: 'original', needsDownload: true });
    expect(s.phase).toBe('downloading');
    s = exportReducer(s, { type: 'download', fraction: 0.5 });
    expect(exportOverall(s)).toBeCloseTo(0.2);
    expect(exportLabel(s)).toBe('Downloading original 50%');
    s = exportReducer(s, { type: 'render', fraction: 0.5 });
    expect(s.phase).toBe('rendering');
    expect(exportOverall(s)).toBeCloseTo(0.4 + 0.275);
    // Progress never goes backwards.
    s = exportReducer(s, { type: 'render', fraction: 0.2 });
    expect(s.fraction).toBe(0.5);
    s = exportReducer(s, { type: 'saving' });
    s = exportReducer(s, { type: 'done', outputUri: 'file:///out.mp4' });
    expect(s.phase).toBe('done');
    expect(exportOverall(s)).toBe(1);
    // A second start while idle-able works; dismiss clears.
    expect(exportReducer(s, { type: 'dismiss' }).phase).toBe('idle');
  });

  it('cancel and fail only while running; start is ignored while running', () => {
    let s = exportReducer(idleExport(), { type: 'start', id: 'j', itemId: 'i', quality: 'low-res', needsDownload: false });
    expect(s.phase).toBe('rendering');
    expect(exportReducer(s, { type: 'start', id: 'k', itemId: 'i', quality: 'original', needsDownload: true }).id).toBe('j');
    expect(exportReducer(s, { type: 'dismiss' })).toBe(s);
    const c = exportReducer(s, { type: 'cancel' });
    expect(c.phase).toBe('cancelled');
    expect(exportReducer(c, { type: 'fail', error: 'x' }).phase).toBe('cancelled');
    const f = exportReducer(s, { type: 'fail', error: 'Disk full' });
    expect(exportLabel(f)).toBe('Disk full');
  });
});

describe('bmp thumbnails', () => {
  it('base64 matches the platform encoder', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 9]);
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('writes a padded bottom-up 24-bit BMP', () => {
    // 1×2: top red, bottom blue.
    const bmp = rgbaToBmp(1, 2, [255, 0, 0, 255, 0, 0, 255, 255]);
    expect(bmp.length).toBe(54 + 8);
    expect(String.fromCharCode(bmp[0], bmp[1])).toBe('BM');
    // First stored row is the bottom (blue) as BGR.
    expect([bmp[54], bmp[55], bmp[56]]).toEqual([255, 0, 0]);
    expect([bmp[58], bmp[59], bmp[60]]).toEqual([0, 0, 255]);
    expect(bmpDataUri(1, 1, [1, 2, 3, 255])).toMatch(/^data:image\/bmp;base64,Qk/);
  });
});
