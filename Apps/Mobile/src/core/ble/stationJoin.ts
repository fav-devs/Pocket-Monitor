/**
 * Station Wi-Fi join (camera joins a shared network or the phone's Personal Hotspot over BLE),
 * experimental on Pocket 4 Pro / Pocket 4 / Pocket 3 / Nano.
 * Source of truth: OpenCine `OpenCineDJI/StationJoin.swift`. I/O is injected so it runs on any
 * BLE transport (native module) and in tests.
 */
import { hex } from '../bytes';
import { MulticamCommands, MulticamJoinPolicy, MulticamStationPolicy, MulticamSupport } from '../commands/livestream';
import type { DumlFrame } from '../duml/frame';
import type { CameraModel } from '../status/cameraModel';

export type StationJoinOutcome = 'joined' | 'verified';
export type StationJoinFailure = 'rejected' | 'unsupportedRole' | 'roleRefused' | 'roleStarting' | 'joinSilent' | 'joinRejected' | 'hotspotUnavailable';

export const STATION_JOIN_MESSAGES: Record<StationJoinFailure, string> = {
  rejected: 'Camera could not complete this step. Check the Wi-Fi details and try again.',
  unsupportedRole: 'This camera did not report a supported Wi-Fi mode. Shared Wi-Fi setup is experimental for this model.',
  roleRefused: 'The camera did not accept shared Wi-Fi mode.',
  roleStarting: 'Camera Wi-Fi is still starting. Retry with the camera nearby.',
  joinSilent: 'Camera Wi-Fi did not respond. Retry setup with the camera nearby.',
  joinRejected:
    'The camera could not join the Wi-Fi. Check the password and that the network is in range. WPA3-only networks refuse some cameras: use WPA2/WPA3 with PMF optional.',
  hotspotUnavailable: 'Enable Personal Hotspot and Allow Others to Join, then retry. The hotspot network is not available yet.',
};

export class StationJoinError extends Error {
  constructor(readonly failure: StationJoinFailure) {
    super(STATION_JOIN_MESSAGES[failure]);
  }
}
/** Thrown by `verifyOnNetwork` when the camera answered but can never join. */
export class StationVerifyFinal extends Error {}

export interface StationJoinIO {
  /** Identity reply (GetSSID payload) already read; must start `00` and be > 2 bytes. */
  identity: ArrayLike<number>;
  exchange(frame: DumlFrame, timeoutSeconds: number): Promise<DumlFrame>;
  send(frame: DumlFrame): void;
  next(): number;
  status(text: string): void;
  hotspotReady(): boolean;
  verifyOnNetwork(): Promise<boolean>;
  log?(line: string): void;
  sleep(seconds: number): Promise<void>;
}

export interface StationJoinOptions {
  model: CameraModel;
  ssid: string;
  password: string;
  hotspot: boolean;
  experimental?: boolean;
  probeExistingStation?: boolean;
}

const eq = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

export async function runStationJoin(o: StationJoinOptions, io: StationJoinIO): Promise<StationJoinOutcome> {
  const log = io.log ?? (() => {});
  const experimental = o.experimental ?? false;
  if (io.identity.length <= 2 || io.identity[0] !== 0) throw new StationJoinError('rejected');
  MulticamCommands.join(o.ssid, o.password, 0); // validates input (throws)
  if (MulticamSupport.hasPreview(o.model) && !experimental) {
    io.status('Selecting Video mode');
    io.send(MulticamCommands.videoMode(io.next()));
    await io.sleep(2);
  }
  const role = (await io.exchange(MulticamCommands.wifiWorkMode(io.next()), 12)).payload;
  const decision = MulticamStationPolicy.decision(role, experimental || MulticamSupport.acceptsMissingRoleQuery(o.model, role));
  const missingRoleQuery = decision === 'setWithoutReadback';
  log(`station role ${hex(role)} experimental=${experimental} decision=${decision}`);
  if (decision === 'alreadyStation' && o.probeExistingStation && (!o.hotspot || io.hotspotReady())) {
    io.status('Finding camera on Wi-Fi');
    if (await io.verifyOnNetwork()) return 'verified';
  }
  if (decision !== 'alreadyStation') {
    if (decision === 'reject') throw new StationJoinError('unsupportedRole');
    const switched = (await io.exchange(MulticamCommands.stationMode(true, io.next()), 12)).payload;
    log(`station switch reply ${hex(switched)}`);
    if (!MulticamStationPolicy.acceptsSetter(switched, missingRoleQuery)) throw new StationJoinError('roleRefused');
    if (!missingRoleQuery) {
      let ready = false;
      for (let i = 0; i < 6; i++) {
        const reported = (await io.exchange(MulticamCommands.wifiWorkMode(io.next()), 12)).payload;
        if (eq(reported, [0, 1])) {
          ready = true;
          break;
        }
        log(`station role readback ${hex(reported)}`);
        if (!eq(reported, [0, 0]) && !eq(reported, role)) throw new StationJoinError('rejected');
        await io.sleep(2);
      }
      if (!ready) throw new StationJoinError('roleStarting');
    }
  }
  io.status('Waiting for camera Wi-Fi');
  await io.sleep(MulticamJoinPolicy.prepareSettleSeconds);
  for (let attempt = 1; attempt <= MulticamJoinPolicy.maximumAttempts; attempt++) {
    io.status(`Joining Wi-Fi · attempt ${attempt} of ${MulticamJoinPolicy.maximumAttempts}`);
    let joined: DumlFrame;
    try {
      joined = await io.exchange(MulticamCommands.join(o.ssid, o.password, io.next()), MulticamJoinPolicy.replyTimeoutSeconds);
    } catch {
      log('join reply timeout; checking verified LAN identity');
      if (!o.hotspot || io.hotspotReady()) {
        try {
          if (await io.verifyOnNetwork()) return 'verified';
        } catch (e) {
          if (e instanceof StationVerifyFinal) throw e;
        }
      }
      if (attempt < MulticamJoinPolicy.maximumAttempts) {
        await io.sleep(MulticamJoinPolicy.retryDelaySeconds);
        continue;
      }
      throw new StationJoinError('joinSilent');
    }
    log(`Wi-Fi join attempt=${attempt} result=${Array.from(joined.payload.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    const d = MulticamJoinPolicy.decision(joined.payload, attempt);
    if (d === 'retry') {
      io.status('Retrying Wi-Fi connection');
      await io.sleep(MulticamJoinPolicy.retryDelaySeconds);
      continue;
    }
    if (d === 'rejected') throw new StationJoinError('joinRejected');
    break;
  }
  if (o.hotspot) {
    io.status('Waiting for Personal Hotspot');
    let waited = 0;
    while (!io.hotspotReady() && waited < 15) {
      await io.sleep(0.25);
      waited += 0.25;
    }
    if (!io.hotspotReady()) throw new StationJoinError('hotspotUnavailable');
  }
  return 'joined';
}
