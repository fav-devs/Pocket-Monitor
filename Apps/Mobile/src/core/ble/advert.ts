/**
 * Decodes a DJI BLE advertisement's manufacturer payload (company id already stripped) into a
 * classic model id. New-format adverts leave the classic byte at zero and carry a 16-bit product
 * type at bytes 10–11; selector is bit 2 of byte 5.
 * Source of truth: OpenCine `OpenCineDJI/BleAdvert.swift` (same as fork).
 */
import type { ByteInput } from '../bytes';
import { BleConstants } from '../status/cameraModel';

const PRODUCT_TYPE_TO_MODEL_ID: Record<number, number> = {
  40: 0x0006,
  143: 0x0010,
  231: 0x0012,
  203: 0x0014,
  235: 0x0015,
  224: 0x0017,
  223: 0x0018,
  222: 0x0019,
  145: 0x0020,
  219: 0x0021,
  218: 0x0022,
  229: 0x0087,
};

export interface BleAdvertDecoded {
  modelId: number | null;
  newFormat: boolean;
  rawProductType: number | null;
}

function productType(p: ByteInput): number | null {
  if (p.length <= 5 || (p[5] & 0x04) === 0) return null;
  if (p.length < 12) return null;
  return p[10] | (p[11] << 8);
}

function legacyModelId(p: ByteInput): number | null {
  if (p.length < 2) return null;
  const id = p[0] | (p[1] << 8);
  return id === 0 ? null : id;
}

export const BleAdvert = {
  decode(payload: ByteInput): BleAdvertDecoded {
    const pt = productType(payload);
    if (pt != null) {
      const mapped = PRODUCT_TYPE_TO_MODEL_ID[pt] ?? null;
      if (mapped != null || legacyModelId(payload) == null) return { modelId: mapped, newFormat: true, rawProductType: pt };
    }
    return { modelId: legacyModelId(payload), newFormat: false, rawProductType: pt };
  },
  modelId(payload: ByteInput): number | null {
    return BleAdvert.decode(payload).modelId;
  },
  /**
   * Raw manufacturer data as iOS/Android hand it over (company id little-endian first).
   * Returns null when the company id is not DJI's.
   */
  decodeManufacturerData(raw: ByteInput): (BleAdvertDecoded & { companyId: number }) | null {
    if (raw.length < 2) return null;
    const cid = raw[0] | (raw[1] << 8);
    if (!BleConstants.isDjiCompanyId(cid)) return null;
    return { ...BleAdvert.decode(Array.prototype.slice.call(raw, 2) as number[]), companyId: cid };
  },
};
