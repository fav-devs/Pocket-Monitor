/**
 * Livestream provisioning (Osmo publishes its own RTMP stream) and Pocket 4 Pro station Wi-Fi
 * commands + join policies.
 * Source of truth: OpenCine `OpenCineDJI/LivestreamCommands.swift`, `MulticamCommands.swift`.
 */
import { concat, putU16le, utf8Encode } from '../bytes';
import { type DumlFrame, packString } from '../duml/frame';

function fr(receiver: number, set: number, id: number, payload: ArrayLike<number>, seq: number): DumlFrame {
  return { sender: 2, receiver, seq: seq & 0xffff, flags: 0x40, cmdSet: set, cmdId: id, payload: Uint8Array.from(payload) };
}

export const MulticamCommands = {
  wifiWorkMode: (seq: number) => fr(7, 7, 0x39, [0], seq),
  /** Separate network role; does not select livestream shooting mode. */
  stationMode: (enabled: boolean, seq: number) => fr(7, 7, 0x48, [enabled ? 1 : 0], seq),
  /** BLE shooting-mode route observed on Pocket 4 Pro. Select before joining Wi-Fi. */
  videoMode: (seq: number) => fr(8, 2, 0xe1, [1], seq),
  /** Throws on empty / >32 B SSID or >63 B password. */
  join(ssid: string, password: string, seq: number): DumlFrame {
    if (!ssid || utf8Encode(ssid).length > 32 || utf8Encode(password).length > 63) throw new Error('invalidInput');
    return fr(7, 7, 0x47, concat(packString(ssid), packString(password)), seq);
  },
  prepare: (seq: number) => fr(8, 2, 0xe1, [0x1a], seq),
};

const eq = (a: ArrayLike<number>, b: number[]) => a.length === b.length && b.every((v, i) => a[i] === v);

/** Bounded retry for the Wi-Fi transition: `01 ff`, then `00 00`. */
export const MulticamJoinPolicy = {
  maximumAttempts: 3,
  prepareSettleSeconds: 10,
  replyTimeoutSeconds: 45,
  retryDelaySeconds: 5,
  decision(reply: ArrayLike<number>, attempt: number): 'connected' | 'retry' | 'rejected' {
    if (eq(reply, [0, 0]) || eq(reply, [0, 0, 0])) return 'connected';
    if (eq(reply, [1, 0xff]) && attempt < 3) return 'retry';
    return 'rejected';
  },
};

const isUnrecognizedRole = (r: ArrayLike<number> | null | undefined) => !!r && r.length === 2 && r[0] === 0 && r[1] > 1;

export const MulticamStationPolicy = {
  decision(reply: ArrayLike<number>, allowMissingQuery: boolean): 'alreadyStation' | 'setAndVerify' | 'setWithoutReadback' | 'reject' {
    if (eq(reply, [0, 1])) return 'alreadyStation';
    if (eq(reply, [0, 0])) return 'setAndVerify';
    if (eq(reply, [0xe0]) && allowMissingQuery) return 'setWithoutReadback';
    if (isUnrecognizedRole(reply)) return 'setAndVerify';
    return 'reject';
  },
  accessPointRestored(previous: ArrayLike<number> | null, current: ArrayLike<number> | null): boolean {
    if (!current) return false;
    if (eq(current, [0, 0])) return true;
    return isUnrecognizedRole(current) && !!previous && previous.length === current.length && eq(previous, Array.from(current));
  },
  acceptsSetter(reply: ArrayLike<number>, missingQuery: boolean): boolean {
    return eq(reply, [0, 0]) || (missingQuery && eq(reply, [0]));
  },
};

export type LivestreamCodec = 'AVC' | 'HEVC';

export const LivestreamCommands = {
  /** `02/E1 1A`: livestream shooting mode. */
  prepare: (seq: number) => MulticamCommands.prepare(seq),
  /** `02/8E 01 01 1A 00 01 01`: start publishing. */
  start: (seq: number) => fr(8, 0x02, 0x8e, [0x01, 0x01, 0x1a, 0x00, 0x01, 0x01], seq),
  /** `02/8E 01 01 1A 00 01 02`: end publishing (also the cleanup before every start). */
  end: (seq: number) => fr(8, 0x02, 0x8e, [0x01, 0x01, 0x1a, 0x00, 0x01, 0x02], seq),
  /** Nine encoder preset bytes: `0A [kbps u16le] [mode0] [mode1] [rate] 00 00 00`. */
  preset(frameRate: number, bitrateKbps: number, modeBytes: [number, number] = [0x02, 0x01]): number[] {
    const rate = frameRate === 25 ? 2 : frameRate === 30 ? 3 : 0;
    return [0x0a, bitrateKbps & 0xff, (bitrateKbps >> 8) & 0xff, modeBytes[0], modeBytes[1], rate, 0, 0, 0];
  },
  /** `08/78` version 00 (Pocket 3): `00 [bodyLen] [preset] [urlLen] [url]`. Throws `urlTooLong`. */
  configureDirectURL(url: string, preset: number[], seq: number): DumlFrame {
    const b = utf8Encode(url);
    if (b.length > 0xff) throw new Error('urlTooLong');
    const body = concat(preset, putU16le(b.length), b);
    return fr(8, 0x08, 0x78, concat([0x00], putU16le(body.length), body), seq);
  },
  /** `08/78` version 01 (Pocket 4 / 4 Pro): `01 [bodyLen] [preset] [jsonLen] [json]`. */
  configureJSON(url: string, preset: number[], codec: LivestreamCodec, seq: number): DumlFrame {
    if (utf8Encode(url).length > 0xff) throw new Error('urlTooLong');
    const json = utf8Encode(LivestreamCommands.settingsJSON(url, codec));
    const body = concat(preset, putU16le(json.length), json);
    return fr(8, 0x08, 0x78, concat([0x01], putU16le(body.length), body), seq);
  },
  settingsJSON(url: string, codec: LivestreamCodec): string {
    const escaped = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\//g, '\\/');
    return (
      `{"rtmpAddress":"${escaped}","codec":"${codec}","EnhancedRTMP":${codec === 'HEVC'},` +
      `"supportStopLive":false,"watermark":0,"orientation":"landscape"}`
    );
  },
};
