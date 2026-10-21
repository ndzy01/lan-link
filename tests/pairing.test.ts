import { describe, expect, it } from 'vitest';
import { decodePairing, encodePairing, newId, type PairingPayload } from '../src/pairing.js';

const offer = (): PairingPayload => ({
  version: 1, kind: 'offer', roomId: newId(), hostId: newId(), peerId: newId(), pairId: newId(),
  expiresAt: Date.now() + 180_000,
  sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA:BB\r\na=ice-ufrag:test\r\na=ice-pwd:secret-for-test\r\n',
});

describe('QR pairing envelope', () => {
  it('round trips connection identity, expiry, and SDP without an external service', async () => {
    const payload = offer();
    expect(await decodePairing(await encodePairing(payload))).toEqual(payload);
  });
  it('rejects expired codes both when creating and when reading', async () => {
    const payload = offer();
    const token = await encodePairing(payload);
    const previous = Date.now;
    Date.now = () => payload.expiresAt + 1;
    try {
      await expect(decodePairing(token)).rejects.toThrow('过期');
      await expect(encodePairing(payload)).rejects.toThrow('过期');
    } finally { Date.now = previous; }
  });
  it('rejects unrelated, corrupt, and oversized input', async () => {
    for (const token of ['https://example.test', 'LAN1:AAAA', 'LAN1:' + 'A'.repeat(2300)]) {
      await expect(decodePairing(token)).rejects.toThrow();
    }
  });
  it('does not accept audio/video signaling or identical device identities', async () => {
    const payload = offer();
    await expect(encodePairing({ ...payload, peerId: payload.hostId })).rejects.toThrow();
    await expect(encodePairing({ ...payload, sdp: payload.sdp + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' })).rejects.toThrow();
  });
  it('bounds decompression before parsing an untrusted QR', async () => {
    const stream = new Blob(['A'.repeat(100_000)]).stream().pipeThrough(new CompressionStream('deflate'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    const token = 'LAN1:' + btoa(String.fromCharCode(...bytes));
    await expect(decodePairing(token)).rejects.toThrow('过大');
  });
});
