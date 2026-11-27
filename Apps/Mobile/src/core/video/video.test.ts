import { describe, expect, it } from 'vitest';
import { fromHex } from '../bytes';
import { HevcDepacketizer } from './depacketizer';
import { accessUnitCarriesKeyframe, codecOfNAL, detectCodec, nalUnits, stripDjiMarker } from './nal';

const arr = (u: ArrayLike<number> | null) => (u ? Array.from(u) : null);
const marker = [0, 0, 1, 0xff, ...new Array(13).fill(0)];
const slice = [0, 0, 1, 0x02, 0xaa, 0xbb];

// Ported from OpenCine Tests/OpenCineDJITests/HevcTests.swift and DeclaredVideoFrameTests.swift
describe('Annex-B helpers', () => {
  it('strips DJI frame marker and keeps AVC SPS', () => {
    expect(arr(stripDjiMarker([...marker, ...slice]))).toEqual(slice);
    const sps = Array.from(fromHex('6764001facb402802dd3501040106d0a1350'));
    expect(arr(stripDjiMarker([...marker, 0, 0, 0, 1, ...sps]))).toEqual([0, 0, 1, ...sps]);
  });
  it('private Nano metadata cannot create false slice NALs', () => {
    const sps = [0x67, 0x42, 0xaa];
    const picture = [0x65, 0xbb];
    const metadata = new Array(25).fill(0x22);
    metadata.splice(4, 5, 0, 0, 1, 0x41, 0xff);
    const privateSEI = [0, 0, 1, 6, 0xf0, 25, ...metadata, 0x80];
    const au = [0, 0, 0, 1, ...sps, ...privateSEI, 0, 0, 0, 1, ...picture];
    expect(nalUnits(au).map(arr)).toEqual([sps, picture]);
    expect(nalUnits(privateSEI)).toEqual([]);
    const ordinarySEI = [6, 5, 1, 0x22, 0x80];
    expect(nalUnits([0, 0, 1, ...ordinarySEI]).map(arr)).toEqual([ordinarySEI]);
  });
  it('codec detection never latches AVC on HEVC IDR_N_LP', () => {
    expect(codecOfNAL(0x40)).toBe('hevc');
    expect(codecOfNAL(0x67)).toBe('avc');
    expect(codecOfNAL(0x28)).toBeNull();
    expect(codecOfNAL(0x41)).toBeNull();
    expect(detectCodec([0, 0, 1, 0x28, 1, 0, 0, 1, 0x40, 1])).toBe('hevc');
    expect(accessUnitCarriesKeyframe([0, 0, 1, 0x20, 1], 'hevc')).toBe(true); // BLA_W_LP
    expect(accessUnitCarriesKeyframe([0, 0, 1, 0x02, 1], 'hevc')).toBe(false);
    expect(accessUnitCarriesKeyframe([0, 0, 1, 0x65, 1], 'avc')).toBe(true);
  });
});

describe('HevcDepacketizer (group mode)', () => {
  const pkt = (frame: number, pos: number, body: number[]) => {
    const p = new Array(20).fill(0);
    p[6] = 2;
    p[16] = frame;
    p[18] = Math.floor(pos / 2);
    p[17] = (pos & 1) << 7;
    return [...p, ...body];
  };
  const frame = [...marker, ...slice];
  it('groups fragments and emits stripped AU', () => {
    const dp = new HevcDepacketizer();
    expect(dp.feed(pkt(0x10, 0, frame.slice(0, 10)))).toBeNull();
    expect(dp.feed(pkt(0x10, 1, frame.slice(10)))).toBeNull();
    expect(arr(dp.feed(pkt(0x11, 0, marker)))).toEqual(slice);
  });
  it('drops frame with missing fragment', () => {
    const dp = new HevcDepacketizer();
    dp.feed(pkt(0x20, 0, marker));
    dp.feed(pkt(0x20, 2, slice));
    expect(dp.feed(pkt(0x21, 0, marker))).toBeNull();
    expect(dp.droppedIncomplete).toBe(1);
  });
  it('accepts frames not starting at 0, frame counter wrap, dup fragment, reused frame number', () => {
    const a = new HevcDepacketizer();
    a.feed(pkt(0x10, 128, frame.slice(0, 10)));
    a.feed(pkt(0x10, 129, frame.slice(10)));
    expect(arr(a.feed(pkt(0x11, 0, marker)))).toEqual(slice);
    const b = new HevcDepacketizer();
    b.feed(pkt(0xff, 0, frame.slice(0, 10)));
    b.feed(pkt(0xff, 1, frame.slice(10)));
    expect(arr(b.feed(pkt(0x00, 0, marker)))).toEqual(slice);
    const c = new HevcDepacketizer();
    c.feed(pkt(0x10, 0, frame.slice(0, 10)));
    c.feed(pkt(0x10, 0, frame.slice(0, 10)));
    c.feed(pkt(0x10, 1, frame.slice(10)));
    expect(arr(c.feed(pkt(0x11, 0, marker)))).toEqual(slice);
    expect(c.droppedIncomplete).toBe(0);
    const d = new HevcDepacketizer();
    d.feed(pkt(0x10, 0, frame.slice(0, 10)));
    d.feed(pkt(0x10, 1, frame.slice(10)));
    expect(arr(d.feed(pkt(0x10, 0, frame)))).toEqual(slice);
  });
  it('ignores non-video packets', () => {
    const cmd = new Array(30).fill(0);
    cmd[6] = 5;
    expect(new HevcDepacketizer().feed(cmd)).toBeNull();
  });
});

describe('HevcDepacketizer (declared size mode)', () => {
  function packets(sl: number[], group = 255, firstSeq = 65520): number[][] {
    const n = sl.length;
    const bytes = [0, 0, 1, 255, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24, 0x90, 0x11, 0, 0, 0, 0, 0, 0, ...sl];
    const count = Math.ceil(bytes.length / 64);
    const out: number[][] = [];
    for (let i = 0; i < count; i++) {
      const p = new Array(20).fill(0);
      const seq = (firstSeq + i * 8) & 0xffff;
      p[4] = seq & 255;
      p[5] = seq >> 8;
      p[6] = 2;
      p[16] = (group + Math.floor(i / 63)) & 0xff;
      p[17] = Math.min(63, count - Math.floor(i / 63) * 63) | (((i % 63) % 2) << 7);
      p[18] = Math.floor((i % 63) / 2);
      out.push([...p, ...bytes.slice(i * 64, (i + 1) * 64)]);
    }
    return out;
  }
  const big = [0, 0, 1, 0x65, ...new Array(9000).fill(0xaa)];
  it('joins three transport groups into one picture', () => {
    const dp = new HevcDepacketizer();
    const out = packets(big)
      .map((p) => dp.feed(p))
      .filter((x) => x);
    expect(out.map(arr)).toEqual([big]);
    expect(dp.droppedIncomplete).toBe(0);
  });
  it('missing continuation rejects whole picture; next frame recovers', () => {
    const dp = new HevcDepacketizer();
    const out = packets(big)
      .filter((_, i) => i !== 64)
      .map((p) => dp.feed(p))
      .filter((x) => x);
    expect(out).toEqual([]);
    expect(dp.droppedIncomplete).toBe(1);
    const small = [0, 0, 1, 0x65, 0xaa];
    expect(arr(dp.feed(packets(small, 8, 4000)[0]))).toEqual(small);
  });
  it('duplicates do not emit twice', () => {
    const dp = new HevcDepacketizer();
    const out: Array<Uint8Array | null> = [];
    for (const p of packets(big)) for (let k = 0; k < 2; k++) out.push(dp.feed(p));
    expect(out.filter((x) => x).map(arr)).toEqual([big]);
  });
  it('next marker rejects truncated picture', () => {
    const dp = new HevcDepacketizer();
    for (const p of packets(big).slice(0, 63)) expect(dp.feed(p)).toBeNull();
    const small = [0, 0, 1, 0x41, 0xbb];
    expect(arr(dp.feed(packets(small, 9, 9000)[0]))).toEqual(small);
    expect(dp.droppedIncomplete).toBe(1);
  });
  it('invalid declared length cannot emit or poison next picture', () => {
    const dp = new HevcDepacketizer();
    const small = [0, 0, 1, 0x65, 0xbb];
    expect(arr(dp.feed(packets(small)[0]))).toEqual(small);
    const invalid = packets(small, 2, 100)[0];
    invalid.splice(24, 4, 255, 255, 255, 255);
    expect(dp.feed(invalid)).toBeNull();
    expect(arr(dp.feed(packets(small, 3, 108)[0]))).toEqual(small);
  });
  it('malformed first marker never falls back to group emission', () => {
    const dp = new HevcDepacketizer();
    const small = [0, 0, 1, 0x65, 0xcc];
    const invalid = packets(small, 255, 100)[0];
    invalid.splice(24, 4, 255, 255, 255, 255);
    expect(dp.feed(invalid)).toBeNull();
    const cont = invalid.slice();
    cont[4] = 108;
    cont[16] = 9;
    cont.splice(20, 4, 1, 2, 3, 4);
    expect(dp.feed(cont)).toBeNull();
    expect(arr(dp.feed(packets(small, 10, 116)[0]))).toEqual(small);
  });
});
