/**
 * Watcher relay wire contract (docs/watcher-relay.md, OpenPocketViewCore `WatcherRelayProtocol`,
 * `WatcherRelayFraming`, `WatcherRelayMessages`). Pure TypeScript: no React, no native imports.
 *
 * The native relay module (modules/pocket-native `PocketRelay`) owns sockets, framing and video on
 * the hot path; it mirrors these bytes. JS builds and reads the small JSON messages (hello, state,
 * control token, join refusal, commands) so their shapes are tested here and match the Swift
 * `Codable` encodings byte-for-byte in meaning:
 *
 * - every non-optional Swift field is always written (the Swift decoder requires it);
 * - `Data` is a base64 string; enums with associated values use Swift's synthesized shape
 *   (`{"setISO":{"_0":7}}`, `{"toggleRecording":{}}`).
 */

/** Our apps advertise this type (also in app.json `NSBonjourServices`). */
export const RELAY_SERVICE_TYPE = '_pocket-mon._tcp';
/** Upstream OpenPocketCine iPhones advertise this one. Watchers browse both. */
export const RELAY_LEGACY_SERVICE_TYPE = '_opc-mon._tcp';
export const RELAY_BROWSE_TYPES = [RELAY_SERVICE_TYPE, RELAY_LEGACY_SERVICE_TYPE] as const;

export const RELAY_VERSION = 1;
export const RELAY_MAX_PAYLOAD = 8 * 1024 * 1024;
export const RELAY_HEADER_BYTES = 5;
export const RELAY_TXT_CAMERA = 'c';
export const RELAY_TXT_WATCHABLE = 'w';
export const RELAY_HEVC_CODEC = 1;
/**
 * Pocket Monitor hosts forward the camera bitstream; a Nano sends AVC. Codec 2 is this app's
 * extension: upstream watchers only take `1` (they would refuse an AVC feed).
 */
export const RELAY_AVC_CODEC = 2;

export const RelayKind = {
  hello: 0x01,
  state: 0x02,
  frame: 0x03,
  controlToken: 0x04,
  joinDenied: 0x05,
  requestControl: 0x10,
  releaseControl: 0x11,
  command: 0x12,
} as const;
export type RelayKind = (typeof RelayKind)[keyof typeof RelayKind];
const KINDS = new Set<number>(Object.values(RelayKind));

/** The relay never sends credentials in Bonjour: only the camera name and the watchable flag. */
export function isWatchable(flag: string | null | undefined): boolean {
  return flag !== '0';
}

// ───────────────────────────── Framing ─────────────────────────────

export class RelayFramingError extends Error {
  constructor(
    readonly reason: 'payload-too-large' | 'unknown-kind',
    readonly value: number,
  ) {
    super(reason === 'unknown-kind' ? `unknown relay kind 0x${value.toString(16)}` : `relay payload too large (${value})`);
  }
}

/** `[u32be payload length + 1][u8 kind][payload]`. */
export function encodeRelayMessage(kind: RelayKind, payload: Uint8Array): Uint8Array {
  const declared = payload.length + 1;
  const out = new Uint8Array(RELAY_HEADER_BYTES + payload.length);
  out[0] = (declared >>> 24) & 0xff;
  out[1] = (declared >>> 16) & 0xff;
  out[2] = (declared >>> 8) & 0xff;
  out[3] = declared & 0xff;
  out[4] = kind;
  out.set(payload, RELAY_HEADER_BYTES);
  return out;
}

export interface DecodedRelayMessage {
  kind: RelayKind;
  payload: Uint8Array;
  consumed: number;
}

/** The next complete message at the front of `buffer`, `null` when more bytes are needed. Throws on a bad header. */
export function decodeRelayMessage(buffer: Uint8Array): DecodedRelayMessage | null {
  if (buffer.length < RELAY_HEADER_BYTES) return null;
  const declared = ((buffer[0] << 24) >>> 0) + (buffer[1] << 16) + (buffer[2] << 8) + buffer[3];
  if (declared < 1) throw new RelayFramingError('payload-too-large', declared);
  if (declared - 1 > RELAY_MAX_PAYLOAD) throw new RelayFramingError('payload-too-large', declared - 1);
  const total = 4 + declared;
  if (buffer.length < total) return null;
  const kind = buffer[4];
  if (!KINDS.has(kind)) throw new RelayFramingError('unknown-kind', kind);
  return { kind: kind as RelayKind, payload: buffer.subarray(RELAY_HEADER_BYTES, total), consumed: total };
}

/** Stream reassembly for tests and the demo transport (native keeps its own). */
export class RelayStreamReader {
  private buffer = new Uint8Array(0);

  append(bytes: Uint8Array): DecodedRelayMessage[] {
    const next = new Uint8Array(this.buffer.length + bytes.length);
    next.set(this.buffer, 0);
    next.set(bytes, this.buffer.length);
    this.buffer = next;
    const out: DecodedRelayMessage[] = [];
    for (;;) {
      const message = decodeRelayMessage(this.buffer);
      if (!message) break;
      out.push({ ...message, payload: message.payload.slice() });
      this.buffer = this.buffer.subarray(message.consumed);
    }
    return out;
  }
}

// ───────────────────────────── Messages ─────────────────────────────

export interface RelayHello {
  version: number;
  hostName: string;
  cameraName?: string | null;
  passcode?: string | null;
  watcherID?: string | null;
}

export interface RelayJoinDenied {
  reason: string;
  passcodeRequired: boolean;
}

export interface RelayControlOptions {
  isoIndices: number[];
  shutterDenominators: number[];
  zoomHundredths: number[];
}

export interface RelayState {
  isRecording: boolean;
  format: string;
  color: string;
  zoom: string;
  liveFPS: string;
  batteryPercent: number;
  cameraName: string;
  iso: string;
  shutter: string;
  allowsControlRequests: boolean;
  controlOptions?: RelayControlOptions | null;
  cameraModel?: string | null;
  isNano?: boolean | null;
}

export interface RelayControlToken {
  holderName: string;
  holderIsRecipient: boolean;
}

export interface RelayFrameMetadata {
  codec: number;
  isKeyframe: boolean;
  parameterSets?: string[] | null;
  isRecording: boolean;
  extraMirrored: boolean;
  encodedAt?: number | null;
  /** Pocket Monitor extension: the host is replaying frames behind live so a joiner can decode. */
  catchUp?: boolean | null;
}

export type RelayCommand =
  | { kind: 'toggleRecording' }
  | { kind: 'tapFocus'; cameraX: number; cameraY: number; coordinateWidth: number; coordinateHeight: number }
  | { kind: 'setISO'; index: number }
  | { kind: 'setShutterDenom'; denominator: number }
  | { kind: 'setWhiteBalance'; mode: number; kelvin: number; tint: number }
  | { kind: 'setColor'; mode: number }
  | { kind: 'setZoom'; hundredths: number };

export const defaultRelayState: RelayState = {
  isRecording: false,
  format: '',
  color: '',
  zoom: '',
  liveFPS: '',
  batteryPercent: -1,
  cameraName: '',
  iso: '',
  shutter: '',
  allowsControlRequests: true,
};

const int = (v: number) => (Number.isFinite(v) ? Math.round(v) : 0);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const ints = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).map(int) : []);

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function encodeHello(hello: RelayHello): string {
  const out: Record<string, unknown> = { version: hello.version, hostName: hello.hostName };
  if (hello.cameraName != null) out.cameraName = hello.cameraName;
  if (hello.passcode != null && hello.passcode !== '') out.passcode = hello.passcode;
  if (hello.watcherID != null && hello.watcherID !== '') out.watcherID = hello.watcherID;
  return JSON.stringify(out);
}

export function decodeHello(json: string): RelayHello | null {
  const v = parse(json);
  if (!isObject(v)) return null;
  const version = num(v.version);
  const hostName = str(v.hostName);
  if (version == null || hostName == null) return null;
  return { version: int(version), hostName, cameraName: str(v.cameraName), passcode: str(v.passcode), watcherID: str(v.watcherID) };
}

export function decodeJoinDenied(json: string): RelayJoinDenied | null {
  const v = parse(json);
  if (!isObject(v)) return null;
  const reason = str(v.reason);
  const passcodeRequired = bool(v.passcodeRequired);
  if (reason == null || passcodeRequired == null) return null;
  return { reason, passcodeRequired };
}

export function encodeJoinDenied(denied: RelayJoinDenied): string {
  return JSON.stringify({ reason: denied.reason, passcodeRequired: denied.passcodeRequired });
}

export function decodeControlToken(json: string): RelayControlToken | null {
  const v = parse(json);
  if (!isObject(v)) return null;
  const holderName = str(v.holderName);
  const holderIsRecipient = bool(v.holderIsRecipient);
  if (holderName == null || holderIsRecipient == null) return null;
  return { holderName, holderIsRecipient };
}

export function encodeControlToken(token: RelayControlToken): string {
  return JSON.stringify({ holderName: token.holderName, holderIsRecipient: token.holderIsRecipient });
}

/** Every required key, so an upstream Swift decoder accepts it. Optional keys only when set. */
export function encodeState(state: RelayState): string {
  const out: Record<string, unknown> = {
    isRecording: state.isRecording,
    format: state.format,
    color: state.color,
    zoom: state.zoom,
    liveFPS: state.liveFPS,
    batteryPercent: int(state.batteryPercent),
    cameraName: state.cameraName,
    iso: state.iso,
    shutter: state.shutter,
    allowsControlRequests: state.allowsControlRequests,
  };
  if (state.controlOptions) {
    out.controlOptions = {
      isoIndices: state.controlOptions.isoIndices.map(int),
      shutterDenominators: state.controlOptions.shutterDenominators.map(int),
      zoomHundredths: state.controlOptions.zoomHundredths.map(int),
    };
  }
  if (state.cameraModel != null) out.cameraModel = state.cameraModel;
  if (state.isNano != null) out.isNano = state.isNano;
  return JSON.stringify(out);
}

/** Lenient on the optional fields (newer hosts add some), strict on the required ones. */
export function decodeState(json: string): RelayState | null {
  const v = parse(json);
  if (!isObject(v)) return null;
  const isRecording = bool(v.isRecording);
  const batteryPercent = num(v.batteryPercent);
  const allowsControlRequests = bool(v.allowsControlRequests);
  const text = ['format', 'color', 'zoom', 'liveFPS', 'cameraName', 'iso', 'shutter'].map((k) => str(v[k]));
  if (isRecording == null || batteryPercent == null || allowsControlRequests == null || text.some((t) => t == null)) return null;
  const [format, color, zoom, liveFPS, cameraName, iso, shutter] = text as string[];
  const options = isObject(v.controlOptions)
    ? {
        isoIndices: ints(v.controlOptions.isoIndices),
        shutterDenominators: ints(v.controlOptions.shutterDenominators),
        zoomHundredths: ints(v.controlOptions.zoomHundredths),
      }
    : null;
  return {
    isRecording,
    format,
    color,
    zoom,
    liveFPS,
    batteryPercent: int(batteryPercent),
    cameraName,
    iso,
    shutter,
    allowsControlRequests,
    controlOptions: options,
    cameraModel: str(v.cameraModel),
    isNano: bool(v.isNano),
  };
}

/** Swift's synthesized `Codable` for `WatcherRelayCommand`. */
export function encodeCommand(command: RelayCommand): string {
  switch (command.kind) {
    case 'toggleRecording':
      return JSON.stringify({ toggleRecording: {} });
    case 'tapFocus':
      return JSON.stringify({
        tapFocus: {
          cameraX: int(command.cameraX),
          cameraY: int(command.cameraY),
          coordinateWidth: int(command.coordinateWidth),
          coordinateHeight: int(command.coordinateHeight),
        },
      });
    case 'setISO':
      return JSON.stringify({ setISO: { _0: int(command.index) } });
    case 'setShutterDenom':
      return JSON.stringify({ setShutterDenom: { _0: int(command.denominator) } });
    case 'setWhiteBalance':
      return JSON.stringify({ setWhiteBalance: { mode: int(command.mode), kelvin: int(command.kelvin), tint: int(command.tint) } });
    case 'setColor':
      return JSON.stringify({ setColor: { _0: int(command.mode) } });
    case 'setZoom':
      return JSON.stringify({ setZoom: { _0: int(command.hundredths) } });
  }
}

export function decodeCommand(json: string): RelayCommand | null {
  const v = parse(json);
  if (!isObject(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1) return null;
  const key = keys[0];
  const body = v[key];
  if (!isObject(body)) return null;
  const one = num(body._0);
  switch (key) {
    case 'toggleRecording':
      return { kind: 'toggleRecording' };
    case 'tapFocus': {
      const [x, y, w, h] = ['cameraX', 'cameraY', 'coordinateWidth', 'coordinateHeight'].map((k) => num(body[k]));
      if (x == null || y == null || w == null || h == null) return null;
      return { kind: 'tapFocus', cameraX: int(x), cameraY: int(y), coordinateWidth: int(w), coordinateHeight: int(h) };
    }
    case 'setISO':
      return one == null ? null : { kind: 'setISO', index: int(one) };
    case 'setShutterDenom':
      return one == null ? null : { kind: 'setShutterDenom', denominator: int(one) };
    case 'setWhiteBalance': {
      const [mode, kelvin, tint] = ['mode', 'kelvin', 'tint'].map((k) => num(body[k]));
      if (mode == null || kelvin == null || tint == null) return null;
      return { kind: 'setWhiteBalance', mode: int(mode), kelvin: int(kelvin), tint: int(tint) };
    }
    case 'setColor':
      return one == null ? null : { kind: 'setColor', mode: int(one) };
    case 'setZoom':
      return one == null ? null : { kind: 'setZoom', hundredths: int(one) };
    default:
      return null;
  }
}

/** `[u32be meta length][meta JSON][Annex-B access unit]`. */
export function encodeFrameBlob(meta: RelayFrameMetadata, accessUnit: Uint8Array): Uint8Array {
  const json: Record<string, unknown> = {
    codec: meta.codec,
    isKeyframe: meta.isKeyframe,
    isRecording: meta.isRecording,
    extraMirrored: meta.extraMirrored,
  };
  if (meta.parameterSets?.length) json.parameterSets = meta.parameterSets;
  if (meta.encodedAt != null) json.encodedAt = meta.encodedAt;
  if (meta.catchUp) json.catchUp = true;
  const metaBytes = new TextEncoder().encode(JSON.stringify(json));
  const out = new Uint8Array(4 + metaBytes.length + accessUnit.length);
  const n = metaBytes.length;
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  out.set(metaBytes, 4);
  out.set(accessUnit, 4 + n);
  return out;
}

export function decodeFrameBlob(payload: Uint8Array): { meta: RelayFrameMetadata; accessUnit: Uint8Array } | null {
  if (payload.length < 4) return null;
  const n = ((payload[0] << 24) >>> 0) + (payload[1] << 16) + (payload[2] << 8) + payload[3];
  if (4 + n > payload.length) return null;
  const v = parse(new TextDecoder().decode(payload.subarray(4, 4 + n)));
  if (!isObject(v)) return null;
  const codec = num(v.codec);
  const isKeyframe = bool(v.isKeyframe);
  const isRecording = bool(v.isRecording);
  const extraMirrored = bool(v.extraMirrored);
  if (codec == null || isKeyframe == null || isRecording == null || extraMirrored == null) return null;
  const sets = Array.isArray(v.parameterSets) ? v.parameterSets.filter((s): s is string => typeof s === 'string') : null;
  return {
    meta: { codec: int(codec), isKeyframe, isRecording, extraMirrored, parameterSets: sets, encodedAt: num(v.encodedAt), catchUp: bool(v.catchUp) },
    accessUnit: payload.subarray(4 + n),
  };
}

// ───────────────────────────── Join and control rules ─────────────────────────────

export const RelayCopy = {
  versionMismatch: 'Update the app on both devices to watch this feed.',
  wrongPasscode: 'Wrong passcode.',
  hostStopped: 'The host ended this shared feed.',
  fellBehind: 'The shared feed fell behind live delivery.',
  exhausted: 'Could not reconnect. Check that both devices are on the same camera Wi-Fi and sharing is on.',
} as const;

/** `WatcherRelayJoin.hostAccepts`. */
export function hostAccepts(hello: RelayHello, requiredPasscode: string): RelayJoinDenied | null {
  if (hello.version !== RELAY_VERSION) return { reason: RelayCopy.versionMismatch, passcodeRequired: false };
  const need = requiredPasscode.trim();
  if (!need) return null;
  if (hello.passcode === need) return null;
  return { reason: RelayCopy.wrongPasscode, passcodeRequired: true };
}

/** Who holds camera control on a shared feed, from this watcher's side. */
export type RelayControl = 'not-offered' | 'available' | 'requested' | 'held' | 'held-by';

/**
 * The lease as a token describes it (`pm-controller/src/phone.rs`). A host that keeps control names
 * itself "Host" (or, on some builds, its own name): that is the lease being free, not another
 * watcher holding it.
 */
export function controlFromToken(token: RelayControlToken, wasRequested: boolean, hostName?: string): { control: RelayControl; holder: string } {
  const holder = token.holderName.trim();
  if (token.holderIsRecipient) return { control: 'held', holder: '' };
  const hostHolds = !holder || holder.toLowerCase() === 'host' || (!!hostName && holder === hostName.trim());
  if (!hostHolds) return { control: 'held-by', holder };
  return { control: wasRequested ? 'requested' : 'available', holder: '' };
}

/** Whether the host still offers control, without losing a lease this watcher holds. */
export function controlAfterState(current: RelayControl, allows: boolean): RelayControl {
  if (allows) return current === 'not-offered' ? 'available' : current;
  return current === 'held' ? 'held' : 'not-offered';
}

/** `WatcherFocusPoint.map`: fitted picture point → camera 0…1000 coordinates, mirror compensated. */
export function focusPoint(x: number, y: number, width: number, height: number, mirrored: boolean): { x: number; y: number } | null {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  if (x < 0 || y < 0 || x > width || y > height) return null;
  const nx = x / width;
  return { x: Math.round((mirrored ? 1 - nx : nx) * 1000), y: Math.round((y / height) * 1000) };
}
