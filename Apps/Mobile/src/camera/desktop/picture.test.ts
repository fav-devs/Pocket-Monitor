import { afterEach, describe, expect, it } from 'vitest';
import {
  SCOPE_HEADER,
  demandDesktopScopes,
  getDesktopScopeFrame,
  mergePlates,
  parseScopeFrame,
  resetDesktopScopesForTest,
  subscribeDesktopScopes,
} from './picture';
import { bundleFrom, ndFrom, platesFor } from '@/features/picture/desktop/scopeBundle';
import { mergeFolder } from '@/features/picture/desktop/lutFolder';

/** A version-1 `scope://samples` message, laid out as `pm_controller::scopes::tap` writes it. */
function message(opts: { blocks: number; columns?: number; levels?: number; bins?: number; sequence?: number; stops?: number; nd?: number; lights?: boolean }) {
  const columns = opts.columns ?? 4;
  const levels = opts.levels ?? 3;
  const bins = opts.bins ?? 2;
  const cells = columns * levels;
  let size = SCOPE_HEADER;
  for (const flag of [1, 2, 4, 8]) if (opts.blocks & flag) size += cells;
  if (opts.blocks & 16) size += 4 * 512;
  if (opts.blocks & 32) size += bins * bins;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set([80, 77, 83, 67], 0); // PMSC
  view.setUint8(4, 1);
  view.setUint8(5, opts.blocks);
  view.setUint16(6, columns, true);
  view.setUint16(8, levels, true);
  view.setUint16(10, bins, true);
  view.setUint32(12, opts.sequence ?? 1, true);
  view.setUint32(16, 1000, true);
  view.setFloat32(20, 41, true);
  view.setFloat32(24, opts.stops ?? NaN, true);
  // Lights: red clips, blue crushes, green balanced.
  view.setUint8(28, 1);
  view.setUint16(30, 65535, true);
  view.setUint16(34, 32768, true);
  view.setUint8(37, 1);
  view.setInt8(40, opts.nd ?? -1);
  view.setUint8(41, opts.lights ? 1 : 0);
  let at = SCOPE_HEADER;
  for (const flag of [1, 2, 4, 8])
    if (opts.blocks & flag) {
      bytes[at + flag] = 9; // a mark in each grid
      at += cells;
    }
  if (opts.blocks & 16) {
    view.setUint16(at + 2 * 10, 500, true); // luma bucket 10
    at += 4 * 512;
  }
  if (opts.blocks & 32) bytes[at] = 255;
  return buffer;
}

describe('scope://samples', () => {
  afterEach(() => {
    resetDesktopScopesForTest();
    delete (globalThis as { window?: unknown }).window;
  });

  it('parses every block the Rust side writes', () => {
    const frame = parseScopeFrame(message({ blocks: 0b111111, stops: 2.5, nd: 2, lights: true }))!;
    expect(frame).not.toBeNull();
    expect(frame.columns).toBe(4);
    expect(frame.levels).toBe(3);
    expect(frame.greyIre).toBeCloseTo(41);
    expect(frame.pictureStops).toBeCloseTo(2.5);
    expect(frame.ndStops).toBe(2);
    expect(frame.lights!.red.clip).toBe(true);
    expect(frame.lights!.red.level).toBeCloseTo(1);
    expect(frame.lights!.green.level).toBeCloseTo(0.5, 3);
    expect(frame.lights!.blue.crush).toBe(true);
    expect(frame.waveLuma![1]).toBe(9);
    expect(frame.waveRed![2]).toBe(9);
    expect(frame.waveBlue![8]).toBe(9);
    expect(frame.histogram!.luma[10]).toBe(500);
    expect(frame.vector![0]).toBe(255);
  });

  it('leaves out what was not asked and refuses what is not a frame', () => {
    const frame = parseScopeFrame(new Uint8Array(message({ blocks: 2 | 4 | 8 })))!;
    expect(frame.waveLuma).toBeNull();
    expect(frame.waveGreen).not.toBeNull();
    expect(frame.histogram).toBeNull();
    expect(frame.lights).toBeNull();
    expect(frame.pictureStops).toBeNull();
    expect(frame.ndStops).toBeNull();
    expect(parseScopeFrame(new ArrayBuffer(10))).toBeNull();
    const wrong = new Uint8Array(message({ blocks: 0 }));
    wrong[0] = 0;
    expect(parseScopeFrame(wrong)).toBeNull();
  });

  it('merges every consumer into one configure on one channel, and delivers the newest frame', async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    let callback: ((response: unknown) => void) | null = null;
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {
        transformCallback(cb: (response: unknown) => void) {
          callback = cb;
          return 42;
        },
        invoke(cmd: string, args?: Record<string, unknown>) {
          calls.push({ cmd, args });
          return Promise.resolve(null);
        },
      },
    };
    const plates = demandDesktopScopes({ waveform: 'RGB' });
    const ev = demandDesktopScopes({ nd: true });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('scopes_configure');
    expect(calls[0].args).toEqual({ plates: { waveform: 'RGB', nd: true }, channel: '__CHANNEL__:42' });

    let seen = 0;
    subscribeDesktopScopes(() => seen++);
    callback!({ message: message({ blocks: 0, sequence: 5 }), index: 1 });
    callback!({ message: message({ blocks: 0, sequence: 4 }), index: 0 }); // overtaken: dropped
    expect(getDesktopScopeFrame()!.sequence).toBe(5);
    expect(seen).toBe(1);

    plates.release();
    ev.release();
    await Promise.resolve();
    expect(calls.at(-1)!.args).toEqual({ plates: null, channel: '__CHANNEL__:42' });
    expect(getDesktopScopeFrame()).toBeNull();
  });

  it('takes the union of plates and the widest vector zoom', () => {
    expect(mergePlates([])).toBeNull();
    expect(mergePlates([{ waveform: null, histogram: false }])).toBeNull();
    expect(mergePlates([{ vectorscope: 2 }, { vectorscope: 4, histogram: true }, { lights: true, lightsThreshold: 0.05 }])).toEqual({
      vectorscope: 4,
      histogram: true,
      lights: true,
      lightsThreshold: 0.05,
    });
  });
});

describe('the desktop scope bundle', () => {
  it('carries the core readings in the phones shapes', () => {
    const frame = parseScopeFrame(message({ blocks: 16, stops: 2.4, nd: 2, lights: true }))!;
    const nd = ndFrom(frame)!;
    expect(nd.ndStops).toBe(2);
    expect(nd.ndLabel).toBe('ND4');
    expect(nd.needsGlass).toBe(true);
    expect(nd.stopsLabel).toContain('2.4');
    const bundle = bundleFrom(frame, null, 'rec709', 255);
    expect(bundle.traffic.red.clip).toBe(true);
    expect(bundle.pictureStops).toBeCloseTo(2.4);
    expect(bundle.samples.count).toBe(0);
    // The histogram is blurred (r = 2) like the phones' display, and blended next tick.
    expect(bundle.histogram.luma[10]).toBeCloseTo(100);
    expect(bundle.histogram.luma[13]).toBe(0);
    const next = bundleFrom(parseScopeFrame(message({ blocks: 16, sequence: 2 }))!, bundle, 'rec709', 255);
    expect(next.histogram.luma[10]).toBeGreaterThan(0);
    expect(next.desktopTrail?.sequence).toBe(1);
    // A new axis starts the blend and the trail again.
    const moved = bundleFrom(parseScopeFrame(message({ blocks: 16, sequence: 3 }))!, next, 'dlog', 223);
    expect(moved.desktopTrail).toBeNull();
  });

  it('asks for what the assists show', () => {
    const on = { WAVE: true, PARADE: false, HISTO: true, VECTOR: true, LIGHTS: false, ND: false, EV: true } as unknown as Parameters<typeof platesFor>[0];
    const options = {
      waveform: { mode: 'Luma' },
      parade: { mode: 'RGB' },
      vectorscope: { zoom: '2x' },
      histogram: { trafficLights: true },
      crushClip: 5,
    } as unknown as Parameters<typeof platesFor>[1];
    expect(platesFor(on, options)).toEqual({
      waveform: 'Luma',
      parade: null,
      histogram: true,
      vectorscope: 2,
      lights: true,
      lightsThreshold: 0.05,
      nd: true,
    });
  });

  it('lists the drop folder in the custom LUTs without losing web imports', () => {
    const custom = [
      { id: 'kodak-1', name: 'Kodak', size: 33, addedAt: 1 },
      { id: 'file:Gone.cube', name: 'Gone', size: 0, addedAt: 1 },
      { id: 'file:Keep.cube', name: 'Keep', size: 0, addedAt: 1 },
    ];
    const merged = mergeFolder(custom, {
      builtIn: [],
      files: [
        { id: 'file:Keep.cube', name: 'Keep' },
        { id: 'file:New.cube', name: 'New' },
      ],
      folder: 'C:\\luts',
      selected: null,
    }, 7);
    expect(merged.map((c) => c.id)).toEqual(['kodak-1', 'file:Keep.cube', 'file:New.cube']);
    expect(merged[2].addedAt).toBe(7);
  });
});
