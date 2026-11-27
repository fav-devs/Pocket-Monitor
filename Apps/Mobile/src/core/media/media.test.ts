import { describe, expect, it } from 'vitest';
import {
  AUDIO_FLOOR_DB,
  LogDisplayTransform,
  ScopeExposureCeiling,
  SceneToneMap,
  TRAFFIC_NONE,
  avoidChrome,
  calibratedClipByte,
  clampCenter,
  clipShelfByte,
  compensatingExposure,
  convertLog,
  cubeFrom,
  decibelsFromLinear,
  encode,
  evLabel,
  evMeterFraction,
  falseColorBand,
  falseColorBands,
  falseColorReference,
  falseColorTable,
  fitRect,
  formatCube,
  gridSegments,
  guideFrames,
  histogramDisplay,
  levelLabel,
  linearize,
  lookCube,
  mapCube,
  middleGrayPaperIRE,
  monitorPercent,
  ndChipLabel,
  ndReading,
  ndSuggestion,
  packCubeRGBA,
  parseCube,
  peakingOverlay,
  rectForRatio,
  remapHistogram,
  safeRect,
  sampleRGBA,
  scopeAnchors,
  scopeLevelAxis,
  signalNative,
  stepChannel,
  silentChannel,
  stopsFromEncoded,
  trafficLights,
  validatedImport,
  vectorBin,
  vectorscopeRaster,
  waveformIre,
  zebraCodeThresholds,
  zebraDisplayValue,
  zebraHighlightNative,
  zebraIreFromDisplay,
  type MonitorTransfer,
} from './index';

const close = (a: number, b: number, eps = 1e-4) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('transfer curves', () => {
  it('matches the published encodings of 0 and 18%', () => {
    close(encode(0, 'dlog2'), 0.062561, 1e-5);
    close(encode(0.18, 'dlog2'), 0.304985, 1e-5);
    close(encode(1, 'dlog2'), 0.454539, 1e-5);
    close(encode(0.18, 'dlog'), 408 / 1023, 2e-3);
    close(encode(0, 'dlog'), 0.0929, 1e-6);
    close(encode(0.18, 'rec709'), 0.409, 1e-3);
    close(middleGrayPaperIRE('dlog2'), 30.4985, 1e-3);
  });

  it('round-trips every curve', () => {
    for (const t of ['rec709', 'hdr', 'dlog', 'dlog2', 'dlogm'] as MonitorTransfer[]) {
      for (const lin of [0.02, 0.18, 0.9]) close(linearize(encode(lin, t), t), lin, 1e-6);
    }
  });

  it('reads 18% grey as zero stops and black as −∞', () => {
    close(stopsFromEncoded(encode(0.18, 'dlogm'), 'dlogm'), 0, 1e-6);
    expect(stopsFromEncoded(0, 'rec709')).toBe(-Infinity);
  });

  it('tone maps middle grey to display 0.42 and clamps white', () => {
    const tone = new SceneToneMap(42);
    close(tone.displayCode(0.18), 0.42, 0.01);
    expect(tone.displayCode(1000)).toBeLessThanOrEqual(1);
  });

  it('builds a monotone neutral display transform for log curves', () => {
    for (const t of ['dlog', 'dlog2', 'dlogm', 'hdr'] as MonitorTransfer[]) {
      const x = new LogDisplayTransform(t);
      let prev = -1;
      for (let i = 0; i <= 20; i++) {
        const [r, g, b] = x.map(i / 20, i / 20, i / 20);
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = y;
      }
      // Log grey lands near display 0.42.
      const grey = encode(0.18, t);
      close(x.map(grey, grey, grey)[1], 0.42, 0.06);
    }
    expect(new LogDisplayTransform('rec709').map(0.3, 0.4, 0.5)).toEqual([0.3, 0.4, 0.5]);
  });

  it('converts D-Log ↔ D-Log2 on neutral grey', () => {
    const g = encode(0.18, 'dlog');
    const out = convertLog(g, g, g, 'dlog', 'dlog2');
    close(out[1], encode(0.18, 'dlog2'), 2e-3);
  });
});

describe('scope axis', () => {
  it('uses the DJI live-tap ceilings', () => {
    expect(calibratedClipByte('dlog2', 1600)).toBe(247);
    expect(calibratedClipByte('dlog', 800)).toBe(223);
    expect(calibratedClipByte('rec709', 1600)).toBe(255);
    expect(calibratedClipByte('dlog2', 400)).toBeLessThan(247);
    expect(clipShelfByte(247)).toBe(240);
  });

  it('ratchets observed tap maxima within the noise allowance', () => {
    const c = new ScopeExposureCeiling();
    c.setISO(1600);
    expect(c.observeTapMax(248, 'dlog2')).toBe(248);
    expect(c.observeTapMax(255, 'dlog2')).toBe(248);
    expect(c.clipByte('dlog2')).toBe(248);
  });

  it('pins paper black to 0, grey to paper IRE and the ceiling to 100', () => {
    const a = scopeAnchors('dlog2', 247);
    close(monitorPercent(a.black, 'dlog2', 247), 0, 1e-6);
    close(monitorPercent(a.mid, 'dlog2', 247), 30.4985, 1e-3);
    close(monitorPercent(247 / 255, 'dlog2', 247), 100, 1e-6);
    close(signalNative(30.4985, 'dlog2', 247), a.mid, 1e-5);
    expect(waveformIre(1, 'dlog2', 247)).toBe(100);
    expect(waveformIre(16 / 255, 'dlog2', 247)).toBe(0);
  });

  it('keeps zebra 100% on the clip shelf', () => {
    close(zebraHighlightNative(100, 'dlog2', 247), 240 / 255, 1e-9);
    expect(zebraHighlightNative(105, 'dlog2', 247)).toBeGreaterThan(247 / 255);
  });

  it('converts zebra units both ways', () => {
    const v = zebraDisplayValue(55, 'Native', 'rec709', 255);
    close(zebraIreFromDisplay(v, 'Native', 'rec709', 255), 55, 0.6);
    expect(zebraDisplayValue(55.4, 'IRE', 'rec709', 255)).toBe(55);
    const z = zebraCodeThresholds({ highlight: true, highlightIRE: 99, midtone: true, midtoneIRE: 55 }, 'rec709', 255);
    expect(z.midtoneLower!).toBeLessThan(z.midtoneUpper!);
  });
});

function frame(width: number, height: number, fn: (x: number, y: number) => [number, number, number]) {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * width + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  return px;
}

describe('sampling and meters', () => {
  it('builds histograms and points from RGBA', () => {
    const s = sampleRGBA(frame(8, 4, () => [200, 100, 50]), 8, 4, 'rec709', 2);
    expect(s.count).toBe(8);
    expect(s.histRed[200]).toBe(8);
    expect(s.histLuma.reduce((a, b) => a + b, 0)).toBe(8);
  });

  it('lights clip lamps for a blown frame and stays neutral on grey', () => {
    const clipped = sampleRGBA(frame(10, 10, () => [255, 255, 255]), 10, 10, 'rec709', 1);
    const t = trafficLights({ red: clipped.histRed, green: clipped.histGreen, blue: clipped.histBlue, luma: clipped.histLuma }, 'rec709', 255);
    expect(t.red.clip && t.green.clip && t.blue.clip).toBe(true);
    const g = Math.round(encode(0.18, 'rec709') * 255);
    const grey = sampleRGBA(frame(10, 10, () => [g, g, g]), 10, 10, 'rec709', 1);
    const n = trafficLights({ red: grey.histRed, green: grey.histGreen, blue: grey.histBlue }, 'rec709', 255, 0, TRAFFIC_NONE);
    close(n.green.level, 0.5, 0.03);
    expect(n.green.clip).toBe(false);
  });

  it('remaps and smooths histograms while conserving count', () => {
    const s = sampleRGBA(frame(16, 16, (x) => [x * 16, x * 16, x * 16]), 16, 16, 'dlog2', 1);
    const axis = scopeLevelAxis('dlog2', 247);
    close(remapHistogram(s.histLuma, axis).reduce((a, b) => a + b, 0), 256, 1e-3);
    const d = histogramDisplay(s, null, axis);
    expect(d.luma.length).toBe(256);
  });

  it('suggests ND from the median', () => {
    expect(ndSuggestion(0.2)?.ndStops).toBe(0);
    expect(ndSuggestion(2.3)?.ndLabel).toBe('ND4');
    expect(ndSuggestion(5)?.ndLabel).toBe('ND32');
    expect(ndChipLabel(ndSuggestion(5), 'density')).toBe('ND 1.5');
    expect(ndChipLabel(ndSuggestion(-1), 'stops')).toBe('−1.0');
    const hot = sampleRGBA(frame(4, 4, () => [250, 250, 250]), 4, 4, 'dlog2', 1);
    expect(ndReading(hot.histLuma, 'dlog2')!.needsGlass).toBe(true);
  });

  it('formats EV and positions it on the meter', () => {
    expect(evLabel(0.04)).toBe('0.0');
    expect(evLabel(0.3)).toBe('+0.3');
    expect(evLabel(-0.7)).toBe('−0.7');
    expect(evMeterFraction(0)).toBe(0.5);
    expect(evMeterFraction(5)).toBe(0);
  });

  it('bins neutral pixels at the vectorscope centre', () => {
    expect(vectorBin(128, 128, 128)).toEqual([64, 64]);
    const s = sampleRGBA(frame(4, 4, () => [191, 0, 0]), 4, 4, 'rec709', 1);
    const raster = vectorscopeRaster(s, 1, 1);
    expect(raster).not.toBeNull();
  });
});

describe('false colour', () => {
  it('reads 18% Rec.709 grey as the IRE 18%MG band', () => {
    const ireValue = monitorPercent(encode(0.18, 'rec709'), 'rec709', 255);
    expect(falseColorBand(ireValue, 'ire', 'rec709')?.label).toBe('18%MG');
  });

  it('builds CineStop zones around grey and a clip band from the shelf', () => {
    const bands = falseColorBands('sceneStops', 'dlog2', 247 / 255);
    expect(bands[0].label).toBe('crush');
    expect(bands[bands.length - 1].label).toBe('clip');
    expect(falseColorBand(0, 'sceneStops', 'dlog2', 247 / 255)?.label).toBe('18%');
  });

  it('paints a full-frame table and a hole-only Limits table', () => {
    const video = falseColorTable('stops', 'rec709', 255);
    expect(video[255 * 4 + 3]).toBe(255);
    expect(video[255 * 4]).toBeGreaterThan(150); // 99–100 red
    const limits = falseColorTable('limits', 'rec709', 255);
    expect(limits[128 * 4 + 3]).toBe(0);
    expect(limits[255 * 4 + 3]).toBe(255);
    const ref = falseColorReference('cinestop', 'dlog2', 247, 'D-Log2');
    expect(ref.markers.at(-1)?.label).toBe('clip');
  });
});

describe('cube LUTs', () => {
  const identity = cubeFrom(3, (r, g, b) => [r, g, b]);

  it('parses, serializes and round-trips', () => {
    const text = formatCube(identity);
    const parsed = parseCube(text.replace(/\n/g, '\r\n'));
    expect(parsed.size).toBe(3);
    const m = mapCube(parsed, 0.25, 0.5, 0.75);
    close(m[0], 0.25);
    close(m[2], 0.75);
  });

  it('rejects broken files with operator copy', () => {
    expect(() => parseCube('0 0 0')).toThrow(/LUT_3D_SIZE/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow(/entries/);
    expect(() => parseCube('LUT_3D_SIZE 99')).toThrow(/unsupported/);
    expect(() => parseCube('LUT_3D_SIZE 2\nDOMAIN_MAX 2 2 2')).toThrow(/domain/);
    expect(() => validatedImport('LUT_3D_SIZE 2\nLUT_3D_SIZE 2')).toThrow();
    expect(() => validatedImport('LUT_3D_SIZE 2\n' + '3 0 0\n'.repeat(8))).toThrow(/outside/);
  });

  it('packs RGBA and applies looks and exposure', () => {
    expect(packCubeRGBA(identity).length).toBe(27 * 4);
    const mono = lookCube('Mono', 5);
    const [r, g, b] = mapCube(mono, 1, 0, 0);
    close(r, g);
    close(g, b);
    const pulled = compensatingExposure(identity, 1, 'rec709');
    expect(mapCube(pulled, 0.2, 0.2, 0.2)[0]).toBeGreaterThan(0.2);
  });
});

describe('audio ballistics', () => {
  it('attacks instantly, holds peaks and decays', () => {
    let ch = silentChannel();
    ch = stepChannel(ch, 1, 0.05);
    expect(ch.levelDB).toBe(0);
    ch = stepChannel(ch, 0, 1);
    expect(ch.levelDB).toBe(-26);
    expect(ch.peakDB).toBe(0);
    ch = stepChannel(ch, 0, 1);
    expect(ch.peakDB).toBeLessThan(0);
    expect(decibelsFromLinear(0)).toBe(AUDIO_FLOOR_DB);
  });
});

describe('framing', () => {
  const feed = { x: 0, y: 0, width: 1600, height: 900 };
  it('draws thirds, phi and diagonals', () => {
    expect(gridSegments(feed, { thirds: true, phi: false, diagonal: false })).toHaveLength(4);
    expect(gridSegments(feed, { thirds: true, phi: true, diagonal: true })).toHaveLength(10);
  });
  it('fits guide frames and safe areas', () => {
    const r = rectForRatio(feed, 2.39);
    close(r.width, 1600);
    close(r.height, 1600 / 2.39);
    expect(guideFrames(feed, ['16:9', '2.39:1'])[0].aspect).toBe('16:9');
    const s = safeRect(r, 90);
    close(s.width, 1440);
  });
  it('fits and fills pictures', () => {
    expect(fitRect({ width: 1000, height: 1000 }, 2, 'fit')).toEqual({ x: 0, y: 250, width: 1000, height: 500 });
    expect(fitRect({ width: 1000, height: 1000 }, 2, 'fill')).toEqual({ x: -500, y: 0, width: 2000, height: 1000 });
  });
  it('labels the level', () => {
    expect(levelLabel(0.02)).toBe('+0.0°');
    expect(levelLabel(-1.24)).toBe('−1.2°');
    expect(levelLabel(null)).toBe('—');
  });
});

describe('scope placement', () => {
  it('clamps and avoids chrome', () => {
    const bounds = { x: 0, y: 0, width: 800, height: 400 };
    const size = { width: 200, height: 100 };
    const c = clampCenter({ x: -100, y: -100 }, size, bounds);
    expect(c.x).toBe(100);
    const clamp = (p: { x: number; y: number }) => clampCenter(p, size, bounds);
    const moved = avoidChrome({ x: 400, y: 200 }, size, 12, [{ x: 350, y: 150, width: 100, height: 100 }], 8, clamp);
    expect(Math.abs(moved.x - 400) > 100 || Math.abs(moved.y - 200) > 50).toBe(true);
  });
});

describe('peaking', () => {
  it('fires on a sharp edge and not on flat grey', () => {
    const w = 32;
    const h = 32;
    const edge = new Float32Array(w * h).map((_, i) => ((i % w) < 16 ? 0.2 : 0.6));
    const flat = new Float32Array(w * h).fill(0.4);
    const sharp = peakingOverlay(edge, w, h, 'Med');
    expect(Math.max(...sharp.stroke)).toBeGreaterThan(0.5);
    expect(Math.max(...peakingOverlay(flat, w, h, 'Med').stroke)).toBe(0);
  });
});
