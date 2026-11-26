import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../bytes';
import { CameraSoftAP } from '../connection/cameraSoftAP';
import { DumlNotificationAssembler } from '../duml/assembler';
import { encodeFrame, makeFrame } from '../duml/frame';
import { resolveModel, ssidConflictsWithBody, usesCapturedLiveEnable } from '../status/cameraModel';
import { isPairApprovalRequest, pairApprovalResponse, pairingFrames, pairingOutcome, wifiStringReply } from './pairing';
import { acceptsGATT, CameraWifiResolution, FoundCameraIdentity, pocketWizardStep, SavedCameras, type SavedCameraRecord } from './savedCamera';
import { runStationJoin, StationJoinError, type StationJoinIO } from './stationJoin';
import { CameraWiFiQRCode } from './wifiQr';

const rec = (id: string, name: string, ssid: string | null, at = 0, model = 'Osmo Pocket 4 Pro'): SavedCameraRecord => ({
  id,
  advertisedName: name,
  modelName: model,
  modelId: null,
  lastSSID: ssid,
  lastConnectedAt: at,
  customName: null,
});

// Ported from fork Tests/OpenPocketViewCoreTests/CameraWiFiQRCodeTests.swift
describe('CameraWiFiQRCode', () => {
  it('encodes and escapes', () => {
    expect(CameraWiFiQRCode.payload('Test Camera', 'example-only')).toBe('WIFI:T:WPA;S:Test Camera;P:example-only;;');
    expect(CameraWiFiQRCode.payload('test;,:"\\', 'example;\\')).toBe('WIFI:T:WPA;S:test\\;\\,\\:\\"\\\\;P:example\\;\\\\;;');
    expect(CameraWiFiQRCode.payload('', 'x')).toBeNull();
    expect(CameraWiFiQRCode.payload('x', '')).toBeNull();
  });
  it('parses its own payloads', () => {
    for (const [s, p] of [
      ['Test Camera', 'example-only'],
      ['test;,:"\\', 'example;\\'],
    ]) {
      const parsed = CameraWiFiQRCode.parse(CameraWiFiQRCode.payload(s, p)!);
      expect(parsed).toEqual({ ssid: s, password: p, security: 'WPA', hidden: false });
    }
    expect(CameraWiFiQRCode.parse('https://example.com')).toBeNull();
    expect(CameraWiFiQRCode.parse('WIFI:T:nopass;H:true;S:Open;;')).toEqual({ ssid: 'Open', password: null, security: 'nopass', hidden: true });
  });
});

describe('BLE pairing decisions', () => {
  it('pairing frames use the body token', () => {
    const f = pairingFrames(resolveModel(0x21, null));
    expect(Array.from(f[0].payload)).toEqual([4, 0]);
    const pin = encodeFrame(f[1]);
    expect(pin.length).toBe(51);
    expect(Array.from(pin.slice(0, 11))).toEqual([0x55, 0x33, 0x04, 0xc2, 0x02, 0x07, 0x92, 0x80, 0x40, 0x07, 0x45]);
    const drone = pairingFrames(resolveModel(0x70, null))[1];
    expect(Array.from(drone.payload.slice(-8))).toEqual([7, ...utf8Encode('DJI FLY')]);
  });
  it('0x45 / 0x46 outcomes', () => {
    const r = (p: number[]) => makeFrame({ sender: 7, receiver: 2, seq: 0x8092, flags: 0xc0, cmdSet: 7, cmdId: 0x45, payload: p });
    expect(pairingOutcome(r([0, 1]))).toBe('paired');
    expect(pairingOutcome(r([0, 2]))).toBe('awaitApproval');
    expect(pairingOutcome(r([0, 6]))).toBe('deferred');
    expect(pairingOutcome(r([0]))).toBe('ignore');
    const approval = makeFrame({ sender: 7, receiver: 2, seq: 0x1234, flags: 0x40, cmdSet: 7, cmdId: 0x46, payload: [] });
    expect(pairingOutcome(approval)).toBe('approved');
    expect(isPairApprovalRequest(approval)).toBe(true);
    const ack = pairApprovalResponse(approval)!;
    expect([ack.flags, ack.seq, Array.from(ack.payload)]).toEqual([0xc0, 0x1234, [0]]);
    expect(pairApprovalResponse({ ...approval, flags: 0xc0 })).toBeNull();
  });
  it('wifi string replies (assembled across notifications)', () => {
    const ssid = utf8Encode('XtraEdgePro-2DCA16');
    const frame = encodeFrame(makeFrame({ sender: 7, receiver: 2, seq: 0x8007, flags: 0xc0, cmdSet: 7, cmdId: 7, payload: [0, ssid.length, ...ssid] }));
    const asm = new DumlNotificationAssembler();
    expect(asm.append(frame.slice(0, 10))).toEqual([]);
    const [f] = asm.append(frame.slice(10));
    expect(wifiStringReply(f.payload)).toEqual({ kind: 'value', value: 'XtraEdgePro-2DCA16' });
    expect(wifiStringReply([0xe0])).toEqual({ kind: 'refused', status: 0xe0 });
    expect(wifiStringReply([0x00, 0x00])).toEqual({ kind: 'empty', status: 0 });
  });
});

// Ported from fork Tests/OpenPocketViewCoreTests/SavedCameraTests.swift
describe('SavedCamera', () => {
  it('upsert keeps newest first and preserves custom name / model id', () => {
    let list = SavedCameras.upserting({ ...rec('a', 'A', 'OsmoA', 1), customName: 'Van', modelId: 0x22 }, []);
    list = SavedCameras.upserting(rec('b', 'B', null, 2), list);
    list = SavedCameras.upserting(rec('a', 'A', null, 3), list);
    expect(list.map((r) => r.id)).toEqual(['a', 'b']);
    expect(list[0].customName).toBe('Van');
    expect(list[0].lastSSID).toBe('OsmoA');
    expect(list[0].modelId).toBe(0x22);
    expect(SavedCameras.canonicalized([rec('x', '', null, 1), rec('x', '', null, 2)]).length).toBe(1);
    expect(SavedCameras.renaming('a', '  ', list)[0].customName).toBeNull();
    expect(SavedCameras.removing('a', list).map((r) => r.id)).toEqual(['b']);
    expect(SavedCameras.launchDestination([])).toBe('addCamera');
  });
  it('wifi creds do not cross bodies', () => {
    const memory = { cameraId: 'pocket', ssid: 'OsmoPocket4P-AAAA', password: 'pocket-pass' };
    const stolen = CameraWifiResolution.resolve({ cameraId: 'nano', savedSSID: null, memory, keychainSSID: null, keychainPassword: null });
    expect(stolen).toEqual({ ssid: null, password: null, source: 'none', skipBle: false });
    const own = CameraWifiResolution.resolve({ cameraId: 'pocket', savedSSID: 'OsmoPocket4P-AAAA', memory, keychainSSID: null, keychainPassword: null });
    expect(own).toEqual({ ssid: 'OsmoPocket4P-AAAA', password: 'pocket-pass', source: 'memory', skipBle: true });
    const nano = CameraWifiResolution.resolve({ cameraId: 'nano', savedSSID: 'OsmoNano-ABCD', memory, keychainSSID: 'OsmoNano-ABCD', keychainPassword: 'nano-pass' });
    expect(nano).toEqual({ ssid: 'OsmoNano-ABCD', password: 'nano-pass', source: 'keychain', skipBle: true });
  });
  it('ssid cannot be stolen from another saved body', () => {
    const saved = [rec('pocket', 'OsmoPocket4P-AAAA', 'OsmoPocket4P-AAAA'), rec('nano', 'OsmoNano-ABCD', null, 0, 'Osmo Nano')];
    expect(CameraWifiResolution.isSSIDOwnedByAnotherCamera('OsmoPocket4P-AAAA', 'nano', saved)).toBe(true);
    expect(CameraWifiResolution.isSSIDOwnedByAnotherCamera('OsmoNano-ABCD', 'nano', saved)).toBe(false);
    expect(CameraWifiResolution.isSSIDOwnedByAnotherCamera('OsmoPocket4P-AAAA', 'pocket', saved)).toBe(false);
  });
  it('found camera identity', () => {
    expect(FoundCameraIdentity.isGenericName('DJI camera')).toBe(true);
    expect(FoundCameraIdentity.shouldReplace('DJI camera', null, 'OsmoNano-ABCD', 0x19)).toBe(true);
    expect(FoundCameraIdentity.shouldReplace('OsmoNano-ABCD', 0x19, 'DJI camera', null)).toBe(false);
    expect(FoundCameraIdentity.shouldReplace('OsmoPocket4P-AAAA', 0x22, 'VanCam', 0x22)).toBe(true);
    expect(FoundCameraIdentity.shouldReplace('VanCam', 0x22, 'DJI camera', 0x22)).toBe(false);
    const next = FoundCameraIdentity.enriched('DJI camera', null, 'OsmoNano-ABCD', 0x19);
    expect(next).toEqual({ name: 'OsmoNano-ABCD', modelId: 0x19 });
    expect(usesCapturedLiveEnable(resolveModel(next.modelId, next.name))).toBe(true);
    expect(FoundCameraIdentity.listTitle('DJI camera', 'Osmo Nano')).toBe('Osmo Nano');
    expect(FoundCameraIdentity.listSubtitle('DJI camera', 'Osmo Pocket 4 Pro')).toContain('Pocket');
    expect(CameraSoftAP.isOsmoSoftAPSSID('HomeWiFi')).toBe(false);
  });
  it('pocket SSID conflicts with nano body', () => {
    expect(ssidConflictsWithBody('OsmoPocket4P-AAAA', 0x19, 'OsmoNano-ABCD')).toBe(true);
    expect(ssidConflictsWithBody('OsmoNano-ABCD', 0x22, 'OsmoPocket4P-AAAA')).toBe(true);
    expect(ssidConflictsWithBody('OsmoNano-ABCD', 0x19, 'OsmoNano-ABCD')).toBe(false);
    expect(ssidConflictsWithBody('DJI-XXXX', 0x19, 'OsmoNano-ABCD')).toBe(false);
  });
  it('renamed SoftAP uses live advertised SSID', () => {
    const memory = { cameraId: 'id', ssid: 'OsmoPocket4P-AAAA', password: 'pocket-pass' };
    const base = { cameraId: 'id', savedSSID: 'OsmoPocket4P-AAAA', memory, keychainSSID: 'OsmoPocket4P-AAAA', keychainPassword: 'pocket-pass' };
    expect(CameraWifiResolution.resolve({ ...base, advertisedName: 'VanCam' }).ssid).toBe('VanCam');
    expect(CameraWifiResolution.resolve({ ...base, advertisedName: 'DJI camera' }).ssid).toBe('OsmoPocket4P-AAAA');
  });
  it('GATT peer and wizard steps', () => {
    expect(acceptsGATT('n', 'n')).toBe(true);
    expect(acceptsGATT('p', 'n')).toBe(false);
    expect(acceptsGATT('p', null)).toBe(false);
    expect(pocketWizardStep({ kind: 'scanning' })).toBe(1);
    expect(pocketWizardStep({ kind: 'awaitingApproval' })).toBe(2);
    expect(pocketWizardStep({ kind: 'joiningWifi' })).toBe(3);
    expect(pocketWizardStep({ kind: 'openingDatalink' })).toBe(4);
    expect(pocketWizardStep({ kind: 'failed', reason: 'x' })).toBe(1);
  });
});

describe('StationJoin', () => {
  function io(replies: Record<string, number[][]>, opts: Partial<StationJoinIO> = {}): StationJoinIO & { sent: string[]; statuses: string[] } {
    const sent: string[] = [];
    const statuses: string[] = [];
    let seq = 0;
    return {
      sent,
      statuses,
      identity: [0, 4, 0x4f, 0x73],
      async exchange(f) {
        const key = `${f.cmdSet.toString(16)}/${f.cmdId.toString(16)}`;
        sent.push(key);
        const q = replies[key];
        if (!q || !q.length) throw new Error('timeout');
        return makeFrame({ sender: 7, receiver: 2, seq: f.seq, flags: 0xc0, cmdSet: f.cmdSet, cmdId: f.cmdId, payload: q.shift()! });
      },
      send: (f) => sent.push(`send ${f.cmdSet.toString(16)}/${f.cmdId.toString(16)}`),
      next: () => ++seq,
      status: (s) => statuses.push(s),
      hotspotReady: () => true,
      verifyOnNetwork: async () => false,
      sleep: async () => {},
      ...opts,
    };
  }
  const pro = resolveModel(0x22, null);
  it('AP → station → join', async () => {
    const x = io({ '7/39': [[0, 0], [0, 1]], '7/48': [[0, 0]], '7/47': [[0, 0]] });
    await expect(runStationJoin({ model: pro, ssid: 'Home', password: 'secret', hotspot: false }, x)).resolves.toBe('joined');
    expect(x.sent).toEqual(['send 2/e1', '7/39', '7/48', '7/39', '7/47']);
  });
  it('retries the 01 ff transition then rejects', async () => {
    const x = io({ '7/39': [[0, 1]], '7/47': [[1, 0xff], [1, 0xff], [1, 0xff]] });
    await expect(runStationJoin({ model: pro, ssid: 'Home', password: 'secret', hotspot: false }, x)).rejects.toBeInstanceOf(StationJoinError);
  });
  it('unsupported role and silent join', async () => {
    await expect(runStationJoin({ model: pro, ssid: 'H', password: 'p', hotspot: false }, io({ '7/39': [[5]] }))).rejects.toMatchObject({ failure: 'unsupportedRole' });
    await expect(runStationJoin({ model: pro, ssid: 'H', password: 'p', hotspot: false }, io({ '7/39': [[0, 1]] }))).rejects.toMatchObject({ failure: 'joinSilent' });
    await expect(
      runStationJoin({ model: pro, ssid: 'H', password: 'p', hotspot: false }, io({ '7/39': [[0, 1]] }, { verifyOnNetwork: async () => true })),
    ).resolves.toBe('verified');
  });
});
