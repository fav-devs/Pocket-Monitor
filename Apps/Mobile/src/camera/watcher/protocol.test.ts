import { describe, expect, it } from 'vitest';
import {
  RELAY_BROWSE_TYPES,
  RelayFramingError,
  RelayKind,
  RelayStreamReader,
  controlAfterState,
  controlFromToken,
  decodeCommand,
  decodeControlToken,
  decodeFrameBlob,
  decodeHello,
  decodeJoinDenied,
  decodeRelayMessage,
  decodeState,
  encodeCommand,
  encodeFrameBlob,
  encodeHello,
  encodeRelayMessage,
  encodeState,
  focusPoint,
  hostAccepts,
  isWatchable,
  type RelayCommand,
} from './protocol';
import { WatcherRelayFrameFreshness, WatcherRelayRecovery } from './recovery';

const bytes = (...v: number[]) => Uint8Array.from(v);

describe('relay framing', () => {
  it('writes [u32be len+1][kind][payload]', () => {
    const wire = encodeRelayMessage(RelayKind.state, bytes(1, 2, 3, 4));
    expect([...wire]).toEqual([0, 0, 0, 5, 0x02, 1, 2, 3, 4]);
    const decoded = decodeRelayMessage(wire)!;
    expect(decoded.kind).toBe(RelayKind.state);
    expect(decoded.consumed).toBe(9);
    expect([...decoded.payload]).toEqual([1, 2, 3, 4]);
  });

  it('asks for more bytes on every short read', () => {
    const wire = encodeRelayMessage(RelayKind.state, bytes(1, 2, 3, 4));
    for (let n = 0; n < wire.length; n++) expect(decodeRelayMessage(wire.subarray(0, n))).toBeNull();
  });

  it('refuses an unknown kind rather than skipping it', () => {
    expect(() => decodeRelayMessage(bytes(0, 0, 0, 1, 0x7f))).toThrow(RelayFramingError);
  });

  it('refuses a zero length and an oversized payload', () => {
    expect(() => decodeRelayMessage(bytes(0, 0, 0, 0, 1))).toThrow(/too large/);
    expect(() => decodeRelayMessage(bytes(0x00, 0x80, 0x00, 0x02, 0x03))).toThrow(/too large/);
  });

  it('reassembles fragmented reads and takes two messages from one read in order', () => {
    const a = encodeRelayMessage(RelayKind.state, new TextEncoder().encode('first'));
    const b = encodeRelayMessage(RelayKind.controlToken, new TextEncoder().encode('second'));
    const stream = new Uint8Array([...a, ...b]);
    const reader = new RelayStreamReader();
    const out = [];
    for (let i = 0; i < stream.length; i += 3) out.push(...reader.append(stream.subarray(i, i + 3)));
    expect(out.map((m) => m.kind)).toEqual([RelayKind.state, RelayKind.controlToken]);
    expect(new TextDecoder().decode(out[1].payload)).toBe('second');
  });

  it('splits a frame payload into metadata and the access unit', () => {
    const unit = bytes(0, 0, 0, 1, 0x26, 0x01, 0x02);
    const blob = encodeFrameBlob({ codec: 1, isKeyframe: true, isRecording: false, extraMirrored: false, encodedAt: 4.5, parameterSets: ['QAE='] }, unit);
    const n = (blob[0] << 24) | (blob[1] << 16) | (blob[2] << 8) | blob[3];
    const meta = JSON.parse(new TextDecoder().decode(blob.subarray(4, 4 + n)));
    expect(meta).toEqual({ codec: 1, isKeyframe: true, isRecording: false, extraMirrored: false, encodedAt: 4.5, parameterSets: ['QAE='] });
    const back = decodeFrameBlob(blob)!;
    expect(back.meta.isKeyframe).toBe(true);
    expect([...back.accessUnit]).toEqual([...unit]);
  });

  it('reads an upstream frame without the optional fields', () => {
    const meta = new TextEncoder().encode('{"codec":1,"isKeyframe":false,"isRecording":true,"extraMirrored":false}');
    const payload = new Uint8Array([0, 0, 0, meta.length, ...meta, 9, 9]);
    const back = decodeFrameBlob(payload)!;
    expect(back.meta.encodedAt).toBeNull();
    expect(back.meta.isRecording).toBe(true);
    expect([...back.accessUnit]).toEqual([9, 9]);
  });
});

describe('relay messages', () => {
  it('hello carries only what is set, with Swift key names', () => {
    expect(JSON.parse(encodeHello({ version: 1, hostName: 'Pixel', passcode: '', watcherID: 'w1' }))).toEqual({ version: 1, hostName: 'Pixel', watcherID: 'w1' });
    expect(decodeHello('{"version":1,"hostName":"Studio","cameraName":"Pocket 3"}')).toEqual({
      version: 1,
      hostName: 'Studio',
      cameraName: 'Pocket 3',
      passcode: null,
      watcherID: null,
    });
    expect(decodeHello('{"hostName":"x"}')).toBeNull();
  });

  it('state writes every key the Swift decoder requires', () => {
    const json = JSON.parse(
      encodeState({
        isRecording: true,
        format: '4K/30',
        color: 'D-Log M',
        zoom: '2x',
        liveFPS: '25',
        batteryPercent: 80,
        cameraName: 'Pocket 3',
        iso: '800',
        shutter: '1/50',
        allowsControlRequests: true,
        controlOptions: { isoIndices: [0, 6], shutterDenominators: [50, 100], zoomHundredths: [100, 200] },
      }),
    );
    for (const key of ['isRecording', 'format', 'color', 'zoom', 'liveFPS', 'batteryPercent', 'cameraName', 'iso', 'shutter', 'allowsControlRequests']) {
      expect(json).toHaveProperty(key);
    }
    expect(json.controlOptions.isoIndices).toEqual([0, 6]);
    expect(json).not.toHaveProperty('cameraModel');
  });

  it('state decode tolerates newer optional fields and refuses a missing required one', () => {
    const base = { isRecording: false, format: '', color: '', zoom: '', liveFPS: '', batteryPercent: -1, cameraName: '', iso: '', shutter: '', allowsControlRequests: false };
    expect(decodeState(JSON.stringify({ ...base, batteryReading: { percent: 50 }, batteryExhausted: false }))?.allowsControlRequests).toBe(false);
    const { iso: _iso, ...missing } = base;
    expect(decodeState(JSON.stringify(missing))).toBeNull();
  });

  it('commands use the synthesized Codable shape', () => {
    const cases: [RelayCommand, unknown][] = [
      [{ kind: 'toggleRecording' }, { toggleRecording: {} }],
      [{ kind: 'setISO', index: 7 }, { setISO: { _0: 7 } }],
      [{ kind: 'setShutterDenom', denominator: 50 }, { setShutterDenom: { _0: 50 } }],
      [{ kind: 'setZoom', hundredths: 250 }, { setZoom: { _0: 250 } }],
      [{ kind: 'setColor', mode: 0x41 }, { setColor: { _0: 0x41 } }],
      [{ kind: 'setWhiteBalance', mode: 1, kelvin: 5600, tint: 0 }, { setWhiteBalance: { mode: 1, kelvin: 5600, tint: 0 } }],
      [
        { kind: 'tapFocus', cameraX: 250, cameraY: 750, coordinateWidth: 1000, coordinateHeight: 1000 },
        { tapFocus: { cameraX: 250, cameraY: 750, coordinateWidth: 1000, coordinateHeight: 1000 } },
      ],
    ];
    for (const [command, json] of cases) {
      expect(JSON.parse(encodeCommand(command))).toEqual(json);
      expect(decodeCommand(encodeCommand(command))).toEqual(command);
    }
    expect(decodeCommand('{"gimbal":{}}')).toBeNull();
  });

  it('token and refusal decode strictly', () => {
    expect(decodeControlToken('{"holderName":"Host","holderIsRecipient":false}')).toEqual({ holderName: 'Host', holderIsRecipient: false });
    expect(decodeControlToken('{"holderName":"Host"}')).toBeNull();
    expect(decodeJoinDenied('{"reason":"Wrong passcode.","passcodeRequired":true}')).toEqual({ reason: 'Wrong passcode.', passcodeRequired: true });
  });
});

describe('join and control rules', () => {
  it('browses both service types, ours first', () => {
    expect(RELAY_BROWSE_TYPES).toEqual(['_pocket-mon._tcp', '_opc-mon._tcp']);
    for (const t of RELAY_BROWSE_TYPES) expect(t.replace(/^_|\._tcp$/g, '').length).toBeLessThanOrEqual(15);
  });

  it('only an explicit zero hides a host', () => {
    expect(isWatchable(undefined)).toBe(true);
    expect(isWatchable('1')).toBe(true);
    expect(isWatchable('')).toBe(true);
    expect(isWatchable('0')).toBe(false);
  });

  it('host accepts the right passcode, refuses a wrong one and another version', () => {
    expect(hostAccepts({ version: 1, hostName: 'w' }, '')).toBeNull();
    expect(hostAccepts({ version: 1, hostName: 'w', passcode: '1234' }, ' 1234 ')).toBeNull();
    expect(hostAccepts({ version: 1, hostName: 'w', passcode: '0000' }, '1234')).toEqual({ reason: 'Wrong passcode.', passcodeRequired: true });
    expect(hostAccepts({ version: 2, hostName: 'w' }, '')?.passcodeRequired).toBe(false);
  });

  it('a host keeping control is the lease being free', () => {
    expect(controlFromToken({ holderName: 'Host', holderIsRecipient: false }, false).control).toBe('available');
    expect(controlFromToken({ holderName: 'Studio iPhone', holderIsRecipient: false }, true, 'Studio iPhone').control).toBe('requested');
    expect(controlFromToken({ holderName: 'Desk', holderIsRecipient: false }, false, 'Studio')).toEqual({ control: 'held-by', holder: 'Desk' });
    expect(controlFromToken({ holderName: 'Me', holderIsRecipient: true }, false).control).toBe('held');
  });

  it('a host that stops offering control keeps a lease already held', () => {
    expect(controlAfterState('held', false)).toBe('held');
    expect(controlAfterState('available', false)).toBe('not-offered');
    expect(controlAfterState('not-offered', true)).toBe('available');
    expect(controlAfterState('requested', true)).toBe('requested');
  });

  it('focus maps the fitted picture and compensates for mirror; letterbox does nothing', () => {
    expect(focusPoint(25, 75, 100, 100, false)).toEqual({ x: 250, y: 750 });
    expect(focusPoint(25, 75, 100, 100, true)).toEqual({ x: 750, y: 750 });
    expect(focusPoint(-1, 10, 100, 100, false)).toBeNull();
    expect(focusPoint(10, 10, 0, 100, false)).toBeNull();
  });
});

describe('watcher recovery', () => {
  it('retries three times with 1/2/4 s backoff, then is exhausted', () => {
    const r = new WatcherRelayRecovery(0);
    r.connected(0);
    expect(r.disconnected(1)).toBe('none');
    expect(r.tick(1.9)).toBe('none');
    expect(r.tick(2)).toBe('reconnect');
    expect(r.disconnected(3)).toBe('none');
    expect(r.tick(5)).toBe('reconnect');
    expect(r.disconnected(6)).toBe('none');
    expect(r.tick(9.99)).toBe('none');
    expect(r.tick(10)).toBe('reconnect');
    expect(r.disconnected(11)).toBe('exhausted');
  });

  it('a join that never answers times out after 15 s', () => {
    const r = new WatcherRelayRecovery(0);
    expect(r.tick(14.9)).toBe('none');
    expect(r.tick(15)).toBe('none');
    expect(r.retryAt).toBe(16);
  });

  it('telemetry cannot hide a stalled picture', () => {
    const r = new WatcherRelayRecovery(0);
    r.connected(0);
    for (let t = 1; t < 10; t++) r.received(t);
    expect(r.tick(9.9)).toBe('none');
    r.tick(10);
    expect(r.retryAt).not.toBeNull();
  });

  it('only ten seconds of continuing pictures reset the retry budget', () => {
    const r = new WatcherRelayRecovery(0);
    r.connected(0);
    r.disconnected(1);
    expect(r.tick(2)).toBe('reconnect');
    r.connected(2);
    for (let t = 2; t <= 11.5; t += 0.5) r.received(t, true);
    expect(r.retryCount).toBe(1);
    r.received(12, true);
    expect(r.retryCount).toBe(0);
  });

  it('stop cancels pending retries', () => {
    const r = new WatcherRelayRecovery(0);
    r.connected(0);
    r.disconnected(1);
    r.stop();
    expect(r.tick(100)).toBe('none');
  });

  it('flags growth in delivery delay, not an absolute offset', () => {
    const f = new WatcherRelayFrameFreshness();
    expect(f.isFallingBehind(100, 1000)).toBe(false);
    expect(f.isFallingBehind(101, 1001.7)).toBe(false);
    expect(f.isFallingBehind(102, 1002.8)).toBe(true);
    expect(f.isFallingBehind(null, 5)).toBe(false);
  });
});
