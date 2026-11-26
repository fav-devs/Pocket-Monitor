/**
 * Camera model catalogue, body family, brand and declared capture profile.
 *
 * Source of truth: OpenCine `OpenCineCameraVocabulary/CameraModel.swift`,
 * `OpenCineDJI/CameraModel+DJIWire.swift`, `CameraModel+DJIProfile.swift`,
 * `DJICaptureCapabilityProfile.swift` and `CameraCaptureProfile.swift`.
 * The LUT/looks profile and `ControlFamily` support table are not ported (UI-only facts).
 */

export type CameraBodyFamily = 'pocket' | 'nano' | 'other';

export type CameraBrand = 'dji' | 'xtra' | 'unknown';

export interface CameraZoomProfile {
  stops: number[];
  /** ShootingMode raw values that restrict zoom. */
  restrictedModes: number[];
  restrictedStops: number[];
  /** VideoResolution raw → ceiling factor. */
  resolutionCeilings: Record<number, number>;
}

export interface CameraCaptureProfile {
  /** ColorMode raw values in wheel order. */
  colorModes: number[];
  colorModeLabels: Record<number, string>;
  shootingModeLabels: Record<number, string>;
  supportsFocusMode: boolean;
  supportsTapFocus: boolean;
  supportsAperture: boolean;
  hasGimbal: boolean;
  supportsZoom: boolean;
  isoAutoRangeFloor: number;
  /** ShootingMode raw → accepted [resolution, frameRate] raw pairs. */
  videoFormatFallbacks: Record<number, Array<[number, number]>>;
  zoom: CameraZoomProfile;
}

export interface CameraModel {
  name: string;
  datalinkPort: number;
  tcpPoke: boolean;
  wpa3: boolean;
  verified: boolean;
  isDrone: boolean;
  family: CameraBodyFamily;
  captureProfile: CameraCaptureProfile | null;
}

const compact = (s: string) => s.toLowerCase().replace(/ /g, '');

export const isAction6 = (m: CameraModel) => compact(m.name).includes('action6');
export const isPocket3 = (m: CameraModel) => {
  const n = compact(m.name);
  return n.includes('pocket3') || n.includes('muse');
};
export const isPocket4Pro = (m: CameraModel) => compact(m.name).includes('pocket4p');
export const usesNanoLiveViewGate = (m: CameraModel) => m.family === 'nano';

export function resolveFamily(modelId: number | null | undefined, name: string | null | undefined): CameraBodyFamily {
  if (modelId != null) {
    if (modelId === 0x0020 || modelId === 0x0021 || modelId === 0x0022) return 'pocket';
    if (modelId === 0x0019) return 'nano';
  }
  const n = compact(name ?? '');
  if (n.includes('pocket') || n.includes('muse')) return 'pocket';
  if (n.includes('nano') || n.includes('atto')) return 'nano';
  return 'other';
}

export function familyOfSSID(ssid: string): CameraBodyFamily {
  return resolveFamily(null, ssid);
}

/** True when GetSSID / cached SoftAP is clearly the other line (Pocket SSID on a Nano tap). */
export function ssidConflictsWithBody(ssid: string, modelId: number | null, advertisedName: string): boolean {
  const body = resolveFamily(modelId, advertisedName);
  const wifi = familyOfSSID(ssid);
  if (body === 'other' || wifi === 'other') return false;
  return body !== wifi;
}

// ColorMode raw values (Pocket 4 SET bytes; see commands/vocabulary.ts).
const CM_NORMAL = 0x3f;
const CM_HDR = 0x3c;
const CM_DLOG = 0x17;
const CM_DLOG2 = 0x41;
const CM_NORMAL10 = 0x3d;
const CM_DLOGM = 0x00;

export function colorModesForFamily(family: CameraBodyFamily): number[] {
  return family === 'nano' ? [CM_NORMAL, CM_NORMAL10, CM_DLOGM] : [CM_NORMAL, CM_HDR, CM_DLOG];
}

/** DJI comparison: 4 Pro D-Log2 / D-Log; Pocket 4 D-Log; Pocket 3 HLG / D-Log M; Nano captured wheel. */
export function catalogueColorModes(m: CameraModel): number[] {
  if (m.family === 'nano') return colorModesForFamily('nano');
  if (isAction6(m)) return [CM_NORMAL10, CM_DLOGM];
  const n = compact(m.name);
  if (n.includes('pocket4p') || n.includes('4pro')) return [CM_NORMAL, CM_HDR, CM_DLOG, CM_DLOG2];
  if (n.includes('pocket4')) return [CM_NORMAL, CM_HDR, CM_DLOG];
  if (isPocket3(m)) return [CM_NORMAL, CM_HDR, CM_DLOGM];
  return colorModesForFamily(m.family);
}

const LABELED_VIDEO_FPS = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06];
const pairs = (res: number[], fps: number[]): Array<[number, number]> =>
  res.flatMap((r) => fps.map((f) => [r, f] as [number, number]));

export function makeCaptureProfile(m: CameraModel): CameraCaptureProfile {
  const c = compact(m.name);
  const pro = c.includes('pocket4p') || c.includes('4pro');
  const pocket = m.family === 'pocket';
  const colorModeLabels: Record<number, string> = {};
  const shootingModeLabels: Record<number, string> = {};
  if (pocket) colorModeLabels[CM_DLOGM] = 'D-Log M';
  if (isPocket3(m)) shootingModeLabels[0x28] = 'Low-Light';
  if (m.family === 'nano') {
    colorModeLabels[CM_NORMAL] = 'Normal 8-bit';
    colorModeLabels[CM_DLOGM] = 'D-Log M 10-bit';
  }
  let formats: Record<number, Array<[number, number]>> = {};
  if (isPocket3(m)) {
    formats = {
      0x01: pairs([0x0a, 0x2d, 0x10, 0x69, 0x6a, 0x6b], LABELED_VIDEO_FPS),
      0x00: [
        [0x10, 0x0a],
        [0x10, 0x07],
        [0x2d, 0x07],
        [0x0a, 0x07],
        [0x0a, 0x08],
      ],
      0x28: pairs([0x0a, 0x10], [0x01, 0x02, 0x03]),
    };
  }
  const stops = pro ? [1, 3, 6, 12, 18] : pocket ? [1, 2, 4] : [1];
  const ceilings: Record<number, number> = {};
  if (isPocket3(m)) {
    for (const r of [0x2d, 0x43, 0x5f, 0x6a]) ceilings[r] = 3;
    for (const r of [0x10, 0x67, 0x7d, 0x6b, 0x6c]) ceilings[r] = 2;
  }
  return {
    colorModes: catalogueColorModes(m),
    colorModeLabels,
    shootingModeLabels,
    supportsFocusMode: pocket,
    supportsTapFocus: pocket,
    supportsAperture: isAction6(m),
    hasGimbal: pocket,
    supportsZoom: pocket,
    isoAutoRangeFloor: !pro && (c.includes('pocket4') || isPocket3(m)) ? 50 : 100,
    videoFormatFallbacks: formats,
    zoom: { stops, restrictedModes: [0x00, 0x02, 0x28], restrictedStops: pro ? [1, 3] : [1], resolutionCeilings: ceilings },
  };
}

function described(
  name: string,
  opts: Partial<Pick<CameraModel, 'datalinkPort' | 'tcpPoke' | 'wpa3' | 'verified' | 'isDrone'>> = {},
): CameraModel {
  const m: CameraModel = {
    name,
    datalinkPort: opts.datalinkPort ?? 9004,
    tcpPoke: opts.tcpPoke ?? true,
    wpa3: opts.wpa3 ?? false,
    verified: opts.verified ?? false,
    isDrone: opts.isDrone ?? false,
    family: resolveFamily(null, name),
    captureProfile: null,
  };
  m.captureProfile = makeCaptureProfile(m);
  return m;
}

/** `CameraModel(name:)` — catalogue facts from the name alone (no id / brand resolution). */
export const describeModel = (name: string) => described(name);

export const DEFAULT_MODEL = described('DJI Osmo camera');

export const MODELS_BY_ID: Readonly<Record<number, CameraModel>> = {
  0x0010: described('Osmo Action 2'),
  0x0012: described('Osmo Action 3'),
  0x0014: described('Osmo Action 4'),
  0x0015: described('Osmo Action 5 Pro', { verified: true }),
  0x0017: described('Osmo 360', { wpa3: true }),
  0x0018: described('Osmo Action 6', { verified: true }),
  0x0019: described('Osmo Nano', { verified: true }),
  0x0020: described('Osmo Pocket 3', { verified: true }),
  0x0021: described('Osmo Pocket 4', { verified: true }),
  0x0022: described('Osmo Pocket 4 Pro', { verified: true }),
  0x0070: described('Mavic 3', { datalinkPort: 9003, tcpPoke: false, verified: true, isDrone: true }),
  0x007e: described('DJI Neo 2', { datalinkPort: 9003, tcpPoke: false, isDrone: true }),
};

/** Model id -> scan-list name (Osmosis `BleConstants.MODEL_NAMES`). */
export const MODEL_NAMES_BY_ID: Readonly<Record<number, string>> = {
  0x0006: 'OsmoAction',
  0x0010: 'OsmoAction2',
  0x0012: 'OsmoAction3',
  0x0014: 'OsmoAction4',
  0x0015: 'OsmoAction5Pro',
  0x0017: 'Osmo360',
  0x0018: 'OsmoAction6',
  0x0019: 'OsmoNano',
  0x0020: 'OsmoPocket3',
  0x0021: 'OsmoPocket4',
  0x0022: 'OsmoPocket4Pro',
  0x0070: 'Mavic3',
  0x007e: 'Neo2',
};

const XTRA_NAMES: Record<number, string> = {
  0x0019: 'Xtra Atto',
  0x0014: 'Xtra Edge',
  0x0015: 'Xtra Edge Pro',
  0x0020: 'Xtra Muse',
};

function resolveIgnoringBrand(modelId: number | null | undefined, name: string | null | undefined): CameraModel {
  if (modelId != null && MODELS_BY_ID[modelId]) return MODELS_BY_ID[modelId];
  if (modelId != null && modelId >= 0x40) {
    return described(name != null ? `DJI drone (${name})` : 'DJI drone', { datalinkPort: 9003, tcpPoke: false, isDrone: true });
  }
  const n = compact(name ?? '');
  if (n.includes('pocket3') || n.includes('muse')) return MODELS_BY_ID[0x0020];
  if (n.includes('pocket4p')) return MODELS_BY_ID[0x0022];
  if (n.includes('pocket4')) return MODELS_BY_ID[0x0021];
  if (n.includes('360')) return MODELS_BY_ID[0x0017];
  if (n.includes('nano') || n.includes('atto')) return MODELS_BY_ID[0x0019];
  if (n.includes('action6')) return MODELS_BY_ID[0x0018];
  if (n.includes('action5') || n.includes('edgepro')) return MODELS_BY_ID[0x0015];
  if (n.includes('action4') || n.includes('edge')) return MODELS_BY_ID[0x0014];
  return described(name ? name : DEFAULT_MODEL.name);
}

/** Resolve by BLE model id, then by local name. Xtra brand runs 10004 / no-poke. */
export function resolveModel(
  modelId: number | null | undefined,
  name: string | null | undefined,
  brand: CameraBrand = 'unknown',
): CameraModel {
  const base = resolveIgnoringBrand(modelId, name);
  if (brand !== 'xtra') return base;
  const isEdgePro = modelId === 0x0015 || base.name.includes('Action 5');
  const xtraName = (modelId != null ? XTRA_NAMES[modelId] : undefined) ?? (isEdgePro ? 'Xtra Edge Pro' : `Xtra ${base.name}`);
  return described(xtraName, { datalinkPort: 10004, tcpPoke: false, wpa3: base.wpa3, verified: isEdgePro, isDrone: base.isDrone });
}

export const XTRA_OUI = 'EC:9E:EA';

export function brandOf(address: string | null | undefined, name: string | null | undefined, djiCid = false): CameraBrand {
  const oui = (address ?? '').toUpperCase().slice(0, 8);
  const n = (name ?? '').toLowerCase();
  if (oui === XTRA_OUI) return 'xtra';
  if (n.includes('xtra') || n.includes('edge')) return 'xtra';
  if (djiCid) return 'dji';
  for (const tell of ['osmo', 'nano', 'dji', 'pocket', 'action']) if (n.includes(tell)) return 'dji';
  return 'unknown';
}

/** SetPairingPIN token: a drone only releases WiFi creds for "DJI FLY". */
export const pairingToken = (m: CameraModel) => (m.isDrone ? 'DJI FLY' : 'osmo');

export function usesCapturedLiveEnable(m: CameraModel): boolean {
  const f = resolveFamily(null, m.name);
  if (f === 'pocket' || f === 'nano') return true;
  if (isAction6(m)) return true;
  const n = m.name.toLowerCase();
  return !n.includes('action') && !n.includes('360');
}

/** `0x09/0xa8` receiver. Nano and Action 6 are `0x41`; Pocket stays `0x08`. */
export const liveViewEnableReceiver = (m: CameraModel) => (m.family === 'nano' || isAction6(m) ? 0x41 : 0x08);
/** Pocket `0x02/0x68 08` before `0x09/0xa8`. Not Nano, not Action 6. */
export const sendsLiveViewPrepare = (m: CameraModel) => !usesNanoLiveViewGate(m) && !isAction6(m);
export const needsFirstPictureFormatPoke = (m: CameraModel) => isPocket3(m);

/** The other datalink config to try when `datalinkPort` never answers (9004+poke <-> 10004). */
export function alternateModel(m: CameraModel): CameraModel {
  return m.datalinkPort === 9004
    ? { ...m, datalinkPort: 10004, tcpPoke: false, verified: false }
    : { ...m, datalinkPort: 9004, tcpPoke: true, verified: false };
}

export const supportsAperture = (m: CameraModel) => m.captureProfile?.supportsAperture === true;
export const supportsZoom = (m: CameraModel) => m.captureProfile?.supportsZoom === true;
export const hasGimbal = (m: CameraModel) => m.captureProfile?.hasGimbal === true;
export const zoomStops = (m: CameraModel) => m.captureProfile?.zoom.stops ?? [1];
export const zoomMax = (m: CameraModel) => {
  const s = zoomStops(m);
  return s[s.length - 1] ?? 1;
};

/** Zoom choices for the current FORMAT / mode (`CameraZoomProfile.choices`). */
export function activeZoomStops(m: CameraModel, resolution: number | null, shootingMode: number): number[] {
  const z = m.captureProfile?.zoom;
  if (!z) return [1];
  const mode = shootingMode === 0x05 ? 0x17 : shootingMode;
  if (z.restrictedModes.includes(mode)) return z.restrictedStops;
  if (resolution == null || z.resolutionCeilings[resolution] == null) return z.stops;
  const ceiling = z.resolutionCeilings[resolution];
  const offered = z.stops.filter((s) => s <= ceiling);
  return offered.includes(ceiling) ? offered : [...offered, ceiling].sort((a, b) => a - b);
}

/** BLE GATT UUIDs and DJI company ids. */
export const BleConstants = {
  serviceFFF0: '0000FFF0-0000-1000-8000-00805F9B34FB',
  charFFF4: '0000FFF4-0000-1000-8000-00805F9B34FB',
  charFFF5: '0000FFF5-0000-1000-8000-00805F9B34FB',
  cccd: '00002902-0000-1000-8000-00805F9B34FB',
  djiCompanyIds: [0x08aa, 0xf7aa, 0xe5c0] as readonly number[],
  isDjiCompanyId(cid: number): boolean {
    return (this.djiCompanyIds as number[]).includes(cid);
  },
};
