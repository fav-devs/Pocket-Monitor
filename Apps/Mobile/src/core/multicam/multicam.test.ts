import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RecoveryBudget,
  StationSubnet,
  candidateHosts,
  cleanupTargets,
  exclusionText,
  isExecutable,
  isRefused,
  planIsCurrent,
  planRecord,
  raceDeadline,
  recordNote,
  recordSummary,
  restoreWithRetry,
  validateStage,
  type JournalCamera,
  type RecordCandidate,
} from './index';

describe('StationSubnet (OpenCine StationSubnetTests)', () => {
  it('lists a /24 without the phone, in order', () => {
    const hosts = StationSubnet.hosts('192.168.1.20', '255.255.255.0')!;
    expect(hosts).toHaveLength(253);
    expect(hosts[0]).toBe('192.168.1.1');
    expect(hosts).not.toContain('192.168.1.20');
    expect(hosts[hosts.length - 1]).toBe('192.168.1.254');
  });
  it('honours exclusions and small masks', () => {
    expect(StationSubnet.hosts('172.20.10.1', '255.255.255.240', ['172.20.10.3'])).toEqual(
      Array.from({ length: 14 }, (_, i) => `172.20.10.${i + 1}`).filter((h) => h !== '172.20.10.1' && h !== '172.20.10.3'),
    );
  });
  it('refuses malformed input, non-contiguous masks and huge subnets', () => {
    expect(StationSubnet.hosts('192.168.1', '255.255.255.0')).toBeNull();
    expect(StationSubnet.hosts('192.168.1.300', '255.255.255.0')).toBeNull();
    expect(StationSubnet.hosts('10.0.0.2', '255.255.0.255')).toBeNull();
    expect(StationSubnet.hosts('10.0.0.2', '255.255.0.0')).toBeNull();
    expect(StationSubnet.hosts('10.0.0.2', '255.255.252.0')).toHaveLength(1021);
    expect(StationSubnet.hosts('10.0.0.2', '255.255.255.255')).toBeNull();
  });
  it('validates camera addresses', () => {
    expect(StationSubnet.validAddress('192.168.1.7')).toBe(true);
    expect(StationSubnet.validAddress('0.1.2.3')).toBe(false);
    expect(StationSubnet.validAddress('127.0.0.1')).toBe(false);
    expect(StationSubnet.validAddress('224.0.0.1')).toBe(false);
    expect(StationSubnet.validAddress('01.2.3')).toBe(false);
  });
  it('infers the probe subnet from the phone address', () => {
    expect(candidateHosts({ localAddress: '172.20.10.4', hotspot: false })).toHaveLength(13);
    expect(candidateHosts({ localAddress: null, hotspot: true })[0]).toBe('172.20.10.2');
    expect(candidateHosts({ localAddress: null, hotspot: false })).toEqual([]);
    expect(candidateHosts({ localAddress: '10.1.2.3', hotspot: false, excluding: ['10.1.2.1'] })[0]).toBe('10.1.2.2');
  });
});

describe('RecoveryBudget (OpenCine RecoveryTests)', () => {
  it('allows two attempts, then waits for the operator', () => {
    const b = new RecoveryBudget(2, 30_000);
    expect(b.beginAttempt()).toBe(true);
    expect(b.status).toEqual({ kind: 'recovering', attempt: 1, of: 2 });
    expect(b.beginAttempt()).toBe(true);
    expect(b.beginAttempt()).toBe(false);
    expect(b.status).toEqual({ kind: 'exhausted' });
    b.observe(true, 0);
    b.observe(true, 60_000);
    expect(b.exhausted).toBe(true);
    b.reset();
    expect(b.status).toEqual({ kind: 'healthy' });
  });
  it('restores the budget after 30 s healthy, not before', () => {
    const b = new RecoveryBudget();
    b.beginAttempt();
    b.observe(true, 1000);
    b.observe(true, 20_000);
    expect(b.used).toBe(1);
    b.observe(false, 21_000);
    b.observe(true, 22_000);
    b.observe(true, 51_999);
    expect(b.used).toBe(1);
    b.observe(true, 52_000);
    expect(b.used).toBe(0);
  });
});

describe('raceDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('returns the work result, the deadline value or the error value', async () => {
    const fast = raceDeadline(Promise.resolve('done'), 1000, 'late', 'error');
    await expect(fast).resolves.toBe('done');
    const slow = raceDeadline(new Promise<string>(() => {}), 1000, 'late', 'error');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(slow).resolves.toBe('late');
    await expect(raceDeadline(Promise.reject(new Error('x')), 1000, 'late', 'error')).resolves.toBe('error');
    expect(vi.getTimerCount()).toBe(0);
  });
});

const cam = (slot: number, over: Partial<RecordCandidate> = {}): RecordCandidate => ({ slot, name: `Cam ${slot + 1}`, live: true, busy: false, recording: false, ...over });

describe('RecordAll (strict plan)', () => {
  it('starts every idle camera when none records', () => {
    const p = planRecord([cam(2), cam(0), cam(1)]);
    expect(p).toMatchObject({ direction: 'start', requested: [0, 1, 2], targets: [0, 1, 2], satisfied: [], exclusions: [] });
    expect(isExecutable(p)).toBe(true);
  });
  it('stops when any camera records, counting idle ones as satisfied', () => {
    const p = planRecord([cam(0, { recording: true }), cam(1)]);
    expect(p).toMatchObject({ direction: 'stop', targets: [0], satisfied: [1] });
  });
  it('commands nothing when any requested camera cannot record', () => {
    const p = planRecord([cam(0), cam(1, { live: false }), cam(2, { busy: true }), cam(3, { recording: null })]);
    expect(isRefused(p)).toBe(true);
    expect(isExecutable(p)).toBe(false);
    expect(p.exclusions).toEqual([
      { slot: 1, reason: 'not-live' },
      { slot: 2, reason: 'busy' },
      { slot: 3, reason: 'recording-unknown' },
    ]);
    expect(exclusionText(p, (s) => `Cam ${s + 1}`)).toBe('Cam 2 is not connected · 2 more');
  });
  it('a tile press plans only that camera', () => {
    const p = planRecord([cam(0, { live: false }), cam(1)], 1);
    expect(p).toMatchObject({ requested: [1], targets: [1], exclusions: [] });
  });
  it('a photo mode refuses a start but not a stop', () => {
    expect(planRecord([cam(0, { photo: true })]).exclusions).toEqual([{ slot: 0, reason: 'photo-mode' }]);
    expect(planRecord([cam(0, { photo: true, recording: true })]).targets).toEqual([0]);
  });
  it('detects a stale plan', () => {
    const cams = [cam(0), cam(1)];
    const p = planRecord(cams);
    expect(planIsCurrent(p, cams)).toBe(true);
    expect(planIsCurrent(p, [cam(0), cam(1, { busy: true })])).toBe(false);
  });
  it('words outcomes and the group line', () => {
    expect(recordNote('confirmed', 'start')).toBe('Recording');
    expect(recordNote('confirmed', 'stop')).toBe('Recording stopped');
    expect(recordNote('refused', 'start')).toMatch(/rejected/);
    expect(recordNote('unconfirmed', 'start')).toBe('No confirmation · check camera');
    expect(recordNote('superseded', 'start')).toBeNull();
    expect(recordSummary('start', 3, 3, true)).toBe('Recording on 3 cameras');
    expect(recordSummary('stop', 2, 2, true)).toBe('Recording stopped');
    expect(recordSummary('start', 3, 2, false)).toBe('2 of 3 confirmed · check camera tiles');
  });
});

const jc = (slot: number, id: string): JournalCamera => ({ slot, id, name: id, model: 'osmo-pocket-3', experimental: false, lutEnabled: true });

describe('MultiviewStageJournal', () => {
  const stage = { version: 1, ssid: 'Studio', hotspot: false, layout: 'grid', focusedIndex: 1, fill: false, cameras: [jc(0, 'a'), jc(1, 'b')], pendingReset: [] };
  it('accepts a valid stage', () => {
    expect(validateStage(stage)).toMatchObject({ ssid: 'Studio', cameras: [{ id: 'a' }, { id: 'b' }] });
  });
  it('rejects duplicates, bad slots, bad focus and unknown versions', () => {
    expect(validateStage({ ...stage, version: 2 })).toBeNull();
    expect(validateStage({ ...stage, focusedIndex: 4 })).toBeNull();
    expect(validateStage({ ...stage, cameras: [jc(0, 'a'), jc(0, 'b')] })).toBeNull();
    expect(validateStage({ ...stage, cameras: [jc(0, 'a'), jc(1, 'a')] })).toBeNull();
    expect(validateStage({ ...stage, cameras: [jc(5, 'a')] })).toBeNull();
    expect(validateStage({ ...stage, cameras: [{ ...jc(0, 'a'), name: '' }] })).toBeNull();
    expect(validateStage(null)).toBeNull();
  });
  it('merges cleanup targets by id', () => {
    const merged = cleanupTargets([jc(0, 'a'), jc(1, 'b')], [{ ...jc(2, 'b'), name: 'B2' }, jc(3, 'c')]);
    expect(merged.map((c) => `${c.id}:${c.name}`)).toEqual(['a:a', 'b:B2', 'c:c']);
  });
});

describe('restoreWithRetry (MultiviewExit)', () => {
  it('retries only a deferred pairing, at most three attempts', async () => {
    const waits: number[] = [];
    let n = 0;
    const ok = await restoreWithRetry(async () => (++n < 3 ? 'deferred' : 'restored'), async () => void waits.push(n));
    expect(ok).toBe(true);
    expect(n).toBe(3);
    expect(waits).toEqual([1, 2]);
    n = 0;
    expect(await restoreWithRetry(async () => (++n, 'deferred'), async () => {})).toBe(false);
    expect(n).toBe(3);
    n = 0;
    expect(await restoreWithRetry(async () => (++n, 'failed'), async () => {})).toBe(false);
    expect(n).toBe(1);
    expect(await restoreWithRetry(async () => Promise.reject(new Error('x')), async () => {})).toBe(false);
  });
});
