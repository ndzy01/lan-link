import { describe, expect, it } from 'vitest';
import {
  dataByteLength, decodeFrame, encodeDataFrame, encodeMembers,
  snapshotData,
} from '../src/wire.js';

const HOST = 'host-00000001';
const GUEST = 'guest-0000001';

describe('wire protocol', () => {
  it('round-trips text, empty payloads, and binary without JSON business assumptions', () => {
    for (const data of ['你好 🌍', '', new Uint8Array([0, 255, 128, 1]).buffer]) {
      expect(decodeFrame(encodeDataFrame({ type: 'route', to: HOST }, data)))
        .toEqual({ type: 'route', to: HOST, data, lane: 'message' });
    }
    expect(decodeFrame(encodeDataFrame({ type: 'deliver', from: GUEST }, 'hello')))
      .toEqual({ type: 'deliver', from: GUEST, data: 'hello', lane: 'message' });
  });

  it('measures UTF-8 bytes without imposing a business message ceiling', () => {
    expect(dataByteLength('你')).toBe(3);
    expect(dataByteLength(new Uint8Array(2_000_000))).toBe(2_000_000);
    expect(dataByteLength('你'.repeat(100_000))).toBe(300_000);
    expect(dataByteLength(new Blob([new Uint8Array(100_000)]))).toBe(100_000);
  });

  it('copies only the addressed view and frames Blob without reading the whole payload', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const copied = snapshotData(new DataView(bytes.buffer, 1, 2));
    bytes.fill(0);
    expect([...new Uint8Array(copied as ArrayBuffer)]).toEqual([20, 30]);
    const frame = encodeDataFrame({ type: 'route', to: HOST }, new Blob([new Uint8Array([5, 6])]));
    expect(frame).toBeInstanceOf(Blob);
    expect(decodeFrame(await (frame as Blob).arrayBuffer()))
      .toEqual({ type: 'route', to: HOST, data: new Uint8Array([5, 6]).buffer, lane: 'message' });
  });

  it('rejects truncated envelopes, unbounded headers, and unknown message fields', () => {
    expect(() => decodeFrame(new ArrayBuffer(3))).toThrow(/protocol/);
    const frame = encodeDataFrame({ type: 'route', to: null }, 'ok');
    new DataView(frame as ArrayBuffer).setUint32(0, 999999);
    expect(() => decodeFrame(frame)).toThrow(/protocol/);
    expect(() => decodeFrame('{"v":1,"t":"close","extra":true}')).toThrow(/protocol/);
    expect(() => decodeFrame('{"v":1,"t":"route","to":null,"from":"forged-user","data":"x"}'))
      .toThrow(/protocol/);
    expect(() => decodeFrame('not json')).toThrow(/protocol/);
  });

  it('rejects duplicate members and accepts exactly one authoritative host', () => {
    const peers = [{ id: HOST, role: 'host' as const }, { id: GUEST, role: 'guest' as const }];
    expect(decodeFrame(encodeMembers(peers))).toEqual({ type: 'members', peers });
    expect(() => encodeMembers([...peers, peers[1]!])).toThrow(/protocol/);
    expect(() => encodeMembers([{ id: GUEST, role: 'guest' }])).toThrow(/protocol/);
    expect(() => encodeMembers([{ id: HOST, role: 'host' }, { id: GUEST, role: 'host' }]))
      .toThrow(/protocol/);
  });
});
