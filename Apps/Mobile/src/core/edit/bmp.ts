/**
 * Small RGBA frames as `data:image/bmp` URIs (look thumbnails). BMP needs no compression, so a
 * 96×54 card is ~16 KB of base64 built in a few milliseconds on every platform, and iOS, Android
 * and browsers all decode it.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

/** 24-bit bottom-up BMP from top-down RGBA8 rows. */
export function rgbaToBmp(width: number, height: number, rgba: ArrayLike<number>): Uint8Array {
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowBytes * height;
  const size = 54 + pixelBytes;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; // B
  out[1] = 0x4d; // M
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, pixelBytes, true);
  dv.setInt32(38, 2835, true);
  dv.setInt32(42, 2835, true);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    let dst = 54 + y * rowBytes;
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      out[dst++] = rgba[s + 2];
      out[dst++] = rgba[s + 1];
      out[dst++] = rgba[s];
    }
  }
  return out;
}

export const bmpDataUri = (width: number, height: number, rgba: ArrayLike<number>) => `data:image/bmp;base64,${base64(rgbaToBmp(width, height, rgba))}`;

/** Nearest-neighbour downscale of RGBA8 (cover crop to the target aspect). */
export function coverResize(src: { width: number; height: number; rgba: ArrayLike<number> }, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const sa = src.width / src.height;
  const ta = width / height;
  let cw = src.width;
  let ch = src.height;
  if (sa > ta) cw = src.height * ta;
  else ch = src.width / ta;
  const ox = (src.width - cw) / 2;
  const oy = (src.height - ch) / 2;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(oy + ((y + 0.5) / height) * ch));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(ox + ((x + 0.5) / width) * cw));
      const s = (sy * src.width + sx) * 4;
      const d = (y * width + x) * 4;
      out[d] = src.rgba[s];
      out[d + 1] = src.rgba[s + 1];
      out[d + 2] = src.rgba[s + 2];
      out[d + 3] = 255;
    }
  }
  return out;
}

/**
 * A stand-in frame when no real frame can be read (native demo picture): sky, foliage, skin and
 * a grey ramp, enough to tell looks apart.
 */
export function swatchFrame(width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const fy = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x++) {
      const fx = x / Math.max(1, width - 1);
      let r: number;
      let g: number;
      let b: number;
      if (fy < 0.45) {
        // Sky: blue to pale at the horizon.
        const t = fy / 0.45;
        r = 70 + 120 * t;
        g = 130 + 90 * t;
        b = 210 + 30 * t;
      } else if (fy < 0.75) {
        // Hill: greens, with a warm skin-tone patch at the left third.
        const skin = Math.hypot(fx - 0.3, (fy - 0.6) * 1.6) < 0.14;
        if (skin) {
          r = 214;
          g = 160;
          b = 128;
        } else {
          r = 60 + 40 * fx;
          g = 120 + 30 * (1 - fy);
          b = 50;
        }
      } else {
        // Ground: a grey ramp.
        const v = 30 + 200 * fx;
        r = v;
        g = v;
        b = v;
      }
      const d = (y * width + x) * 4;
      out[d] = r;
      out[d + 1] = g;
      out[d + 2] = b;
      out[d + 3] = 255;
    }
  }
  return out;
}
