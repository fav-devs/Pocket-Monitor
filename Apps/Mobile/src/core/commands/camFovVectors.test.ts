import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeZoomStops, describeModel } from '../status/cameraModel';
import { CamFov } from './camFov';
import { VideoResolutions } from './vocabulary';

// Golden vectors shared with the Swift core: Tests/Fixtures/camfov-vectors.tsv
// (port of Tests/OpenPocketViewCoreTests/CamFovVectorTests.swift).
const text = readFileSync(path.resolve(__dirname, '../../../../../Tests/Fixtures/camfov-vectors.tsv'), 'utf8');
const vectors = text
  .split('\n')
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split('\t'));
const num = (f: string) => (f === '-' ? null : Number(f));
const list = (f: string) => (f === '-' ? [] : f.split(',').map(Number));
const close = (a: number | null, b: number | null) => (a == null || b == null ? a == null && b == null : Math.abs(a - b) < 1e-4);
const res = (f: string) => (f === '-' ? null : parseInt(f, 16));

/**
 * This fork's fixture predates upstream OpenCine's 18× Pocket 4 Pro ceiling (November 2026
 * firmware, `CamFov.maxFactor = 18`, lens18x = 3906). We port upstream, so these rows are asserted
 * against the upstream value instead. Everything else must match the fixture exactly.
 */
function upstreamOverride(row: string[]): string | null {
  if (row[0] === 'factorLens' && row[1] === '3000') return String(3 + ((3000 - 651) / (2604 - 651)) * 9);
  if (row[0] === 'lensPosition' && Number(row[1]) >= 18) return '3906';
  if (row[0] === 'activeZoomStops' && row[1] === 'Osmo Pocket 4 Pro' && row[row.length - 1] === '1.0000,3.0000,6.0000,12.0000') return '1,3,6,12,18';
  return null;
}

describe('CamFov golden vectors', () => {
  it('fixture is present and covers every kind', () => {
    expect(vectors.length).toBeGreaterThan(250);
    expect(new Set(vectors.map((v) => v[0]))).toEqual(
      new Set(['factorRaw', 'factorLens', 'lensPosition', 'displayLabel', 'displayTenths', 'matches', 'nextJump', 'previousJump', 'stopWithinCycle', 'pocket3ZoomMax', 'sizeTitle', 'activeZoomStops', 'ceilingNote']),
    );
  });
  it('TS core matches every vector', () => {
    const failures: string[] = [];
    const check = (ok: boolean, label: string) => {
      if (!ok) failures.push(label);
    };
    for (const row of vectors) {
      const want = upstreamOverride(row) ?? row[row.length - 1];
      const label = row.join(' | ');
      switch (row[0]) {
        case 'factorRaw':
          check(close(CamFov.factorFromRaw(Number(row[1])), num(want)), label);
          break;
        case 'factorLens':
          check(close(CamFov.factorFromLens(Number(row[1])), num(want)), label);
          break;
        case 'lensPosition':
          check(String(CamFov.lensPosition(Number(row[1]))) === want, label);
          break;
        case 'displayLabel':
          check(CamFov.displayLabel(Number(row[1])) === want, `${label} got ${CamFov.displayLabel(Number(row[1]))}`);
          break;
        case 'displayTenths':
          check(close(CamFov.displayTenths(Number(row[1])), num(want)), label);
          break;
        case 'matches':
          check(CamFov.matches(Number(row[1]), Number(row[2])) === (want === 'true'), label);
          break;
        case 'nextJump':
          check(close(CamFov.nextJump(Number(row[1]), list(row[2])), num(want)), label);
          break;
        case 'previousJump':
          check(close(CamFov.previousJump(Number(row[1]), list(row[2])), num(want)), label);
          break;
        case 'stopWithinCycle':
          check(close(CamFov.stopWithinCycle(Number(row[1]), list(row[2])), num(want)), label);
          break;
        case 'pocket3ZoomMax':
          check(close(VideoResolutions.pocket3ZoomMax(res(row[1])!), num(want)), label);
          break;
        case 'sizeTitle':
          check(VideoResolutions.sizeTitle(res(row[1])!) === want, label);
          break;
        case 'activeZoomStops': {
          const model = describeModel(row[1]);
          check(model.family === row[2], `family ${label}`);
          const got = activeZoomStops(model, res(row[3]), row[4] === '-' ? -1 : Number(row[4]));
          const exp = list(want);
          check(got.length === exp.length && got.every((g, i) => close(g, exp[i])), `${label} got ${got}`);
          break;
        }
        case 'ceilingNote':
          check((CamFov.ceilingNote(row[1], Number(row[2]), list(row[3])) ?? '-') === want, label);
          break;
        default:
          check(false, `unknown kind ${row[0]}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
