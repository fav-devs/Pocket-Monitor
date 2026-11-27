import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { CameraWiFiQRCode } from '@/core/ble/wifiQr';
import { encodeQr, qrPath } from './qr';

const require = createRequire(import.meta.url);

/** Rasterizes a matrix with a quiet zone, as a camera would see it. */
function raster(m: { size: number; modules: boolean[] }, scale = 5, quiet = 4) {
  const px = (m.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let y = 0; y < m.size; y++)
    for (let x = 0; x < m.size; x++)
      if (m.modules[y * m.size + x])
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const o = (((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx) * 4;
            data[o] = data[o + 1] = data[o + 2] = 0;
          }
  return { data, width: px, height: px, colorSpace: 'srgb' as const };
}

describe('Wi-Fi join code', () => {
  it('picks the smallest version and refuses what does not fit', () => {
    expect(encodeQr('A')?.size).toBe(21);
    expect(encodeQr('x'.repeat(60))?.size).toBe(33);
    expect(encodeQr('x'.repeat(214))).toBeNull();
    expect(qrPath({ size: 2, modules: [true, false, false, true] })).toBe('M0 0h1v1h-1zM1 1h1v1h-1z');
  });

  it('decodes back to the payload (zxing, the reader expo-camera uses on web)', async () => {
    const zx = await import('zxing-wasm/reader');
    zx.prepareZXingModule({ overrides: { wasmBinary: readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')) } as never, fireImmediately: true });
    const payloads = [
      CameraWiFiQRCode.payload('OsmoPocket3-1A2B', '12345678')!,
      CameraWiFiQRCode.payload('Pocket 4 Pro ;x', 'p:ss\\word-with-a-long-tail-0123456789')!,
      'x'.repeat(150),
      'é'.repeat(90),
    ];
    for (const text of payloads) {
      const results = await zx.readBarcodes(raster(encodeQr(text)!) as never, { formats: ['QRCode'] });
      expect(results[0]?.text).toBe(text);
    }
  });
});
