import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHost, joinRoom, type LanRoom } from '../src/room.js';
import { encodeDataFrame } from '../src/wire.js';

vi.mock('../src/pairing.js', () => ({
  newId: () => crypto.randomUUID(),
  encodePairing: async (payload: unknown) => JSON.stringify(payload),
  decodePairing: async (token: string) => {
    const value = JSON.parse(token);
    if (value.expiresAt <= Date.now()) throw new Error('Expired pairing.');
    return value;
  },
}));

class FakeChannel extends EventTarget {
  label = 'lan-link';
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState = 'connecting';
  sent: (string | ArrayBuffer)[] = [];
  partner?: FakeChannel;
  send = vi.fn((frame: string | ArrayBuffer) => {
    if (this.readyState !== 'open') throw new Error('Not open.');
    this.sent.push(frame);
    if (this.partner?.readyState === 'open') {
      this.partner.dispatchEvent(new MessageEvent('message', { data: frame }));
    }
  });
  close = vi.fn(() => {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
    if (this.partner?.readyState !== 'closed') this.partner?.close();
  });
  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
}

class FakePC extends EventTarget {
  static instances: FakePC[] = [];
  static gather = true;
  static candidates = true;
  iceGatheringState = FakePC.gather ? 'complete' : 'gathering';
  connectionState = 'new';
  sctp = { maxMessageSize: 65_536 };
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  channel?: FakeChannel;
  constructor(readonly configuration: RTCConfiguration) {
    super();
    FakePC.instances.push(this);
  }
  createDataChannel = vi.fn(() => {
    this.channel = new FakeChannel();
    return this.channel;
  });
  createOffer = vi.fn(async () => ({
    type: 'offer' as const,
    sdp: 'v=0\r\n' + (FakePC.candidates ? 'a=candidate:1 1 udp 1 192.168.1.10 5000 typ host\r\n' : ''),
  }));
  createAnswer = vi.fn(async () => ({
    type: 'answer' as const,
    sdp: 'v=0\r\n' + (FakePC.candidates ? 'a=candidate:1 1 udp 1 192.168.1.11 5001 typ host\r\n' : ''),
  }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
  });
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = description;
  });
  close = vi.fn(() => { this.connectionState = 'closed'; });
  receiveChannel(channel: FakeChannel): void {
    const event = new Event('datachannel');
    Object.assign(event, { channel });
    this.dispatchEvent(event);
  }
  fail(): void {
    this.connectionState = 'failed';
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

const rooms: LanRoom[] = [];
function host(options: Parameters<typeof createHost>[0] = {}): LanRoom {
  const room = createHost(options);
  rooms.push(room);
  return room;
}
async function attach(room: LanRoom) {
  const offer = await room.createInvitation();
  const hostPC = FakePC.instances.at(-1)!;
  const joined = await joinRoom(offer);
  rooms.push(joined.room);
  const guestPC = FakePC.instances.at(-1)!;
  const guestChannel = new FakeChannel();
  guestPC.receiveChannel(guestChannel);
  const hostChannel = hostPC.channel!;
  hostChannel.partner = guestChannel;
  guestChannel.partner = hostChannel;
  await room.acceptAnswer(joined.answer);
  guestChannel.open();
  hostChannel.open();
  await ticks();
  return { ...joined, offer, hostPC, guestPC, hostChannel, guestChannel };
}
async function ticks(): Promise<void> {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}
function answerFor(offer: string): string {
  return JSON.stringify({ ...JSON.parse(offer), kind: 'answer', sdp: 'answer-sdp' });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', FakePC);
  FakePC.instances = [];
  FakePC.gather = true;
  FakePC.candidates = true;
});
afterEach(() => {
  for (const room of rooms.splice(0)) room.close();
  expect(vi.getTimerCount()).toBe(0);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('room lifecycle and pairing', () => {
  it('uses no ICE servers, waits for complete ICE, and cancels an in-flight invitation', async () => {
    FakePC.gather = false;
    const room = host();
    const invitation = room.createInvitation();
    const rejected = expect(invitation).rejects.toThrow(/closed|cancelled/);
    await ticks();
    const pc = FakePC.instances[0]!;
    expect(pc.configuration).toEqual({ iceServers: [], iceTransportPolicy: 'all' });
    expect(pc.localDescription).not.toBeNull();
    await expect(room.createInvitation()).rejects.toThrow(/current invitation/);
    room.cancelInvitation();
    await rejected;
    expect(pc.close).toHaveBeenCalledOnce();
    expect(room.state).toBe('waiting');
  });

  it('uses invitations once, rejects mismatches, and enforces room capacity including host', async () => {
    const room = host({ maxPeers: 2 });
    const offer = await room.createInvitation();
    const wrong = JSON.stringify({ ...JSON.parse(answerFor(offer)), pairId: 'wrong-pair-00001' });
    await expect(room.acceptAnswer(wrong)).rejects.toThrow(/match/);
    await room.acceptAnswer(answerFor(offer));
    await expect(room.acceptAnswer(answerFor(offer))).rejects.toThrow(/unused/);
    await expect(room.createInvitation()).rejects.toThrow(/full/);
    expect(room.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakePC.instances[0]!.close).toHaveBeenCalledOnce();
    expect(room.state).toBe('waiting');
  });

  it('expires and closes pending invitations and allows creating a fresh invitation', async () => {
    const room = host({ pairingTimeoutMs: 100 });
    const offer = await room.createInvitation();
    await vi.advanceTimersByTimeAsync(101);
    expect(FakePC.instances[0]!.close).toHaveBeenCalledOnce();
    await expect(room.acceptAnswer(answerFor(offer))).rejects.toThrow(/unused/);
    await expect(room.createInvitation()).resolves.toBeTypeOf('string');
  });

  it('bounds ICE gathering independently of invitation expiry and allows retrying', async () => {
    FakePC.gather = false;
    const room = host({ connectionTimeoutMs: 150, pairingTimeoutMs: 180_000 });
    const invitation = room.createInvitation();
    const rejected = expect(invitation).rejects.toThrow(/ICE gathering timed out.*retry pairing/);
    await ticks();
    await vi.advanceTimersByTimeAsync(151);
    await rejected;
    expect(FakePC.instances[0]!.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(room.state).toBe('waiting');
    FakePC.gather = true;
    await expect(room.createInvitation()).resolves.toBeTypeOf('string');
    expect(FakePC.instances).toHaveLength(2);
  });

  it('rejects complete ICE with no candidate rather than returning an unusable invitation', async () => {
    FakePC.candidates = false;
    const room = host();
    await expect(room.createInvitation()).rejects.toThrow(/No local ICE candidate.*retry pairing/);
    expect(FakePC.instances[0]!.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    FakePC.candidates = true;
    await expect(room.createInvitation()).resolves.toBeTypeOf('string');
  });

  it('keeps a guest available for scanning until pairing expiry', async () => {
    const room = host();
    const offer = await room.createInvitation();
    const joined = await joinRoom(offer);
    rooms.push(joined.room);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(joined.room.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(160_000);
    expect(joined.room.state).toBe('closed');
  });

  it('closes a guest collecting ICE when the caller cancels before joinRoom returns', async () => {
    const room = host();
    const offer = await room.createInvitation();
    FakePC.gather = false;
    const controller = new AbortController();
    const joining = joinRoom(offer, { signal: controller.signal });
    const rejected = expect(joining).rejects.toMatchObject({ name: 'AbortError' });
    await ticks();
    const guestPC = FakePC.instances.at(-1)!;
    expect(guestPC.localDescription?.type).toBe('answer');
    expect(guestPC.iceGatheringState).toBe('gathering');
    controller.abort();
    await rejected;
    expect(guestPC.close).toHaveBeenCalledOnce();
    // Only the independently owned host invitation remains active.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not create a connection for an already cancelled join', async () => {
    const room = host();
    const offer = await room.createInvitation();
    const controller = new AbortController();
    controller.abort();
    await expect(joinRoom(offer, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(FakePC.instances).toHaveLength(1);
  });

  it('releases the caller cancellation listener after answer generation succeeds', async () => {
    const room = host();
    const offer = await room.createInvitation();
    const controller = new AbortController();
    const joined = await joinRoom(offer, { signal: controller.signal });
    rooms.push(joined.room);
    controller.abort();
    expect(joined.room.state).toBe('connecting');
    expect(FakePC.instances.at(-1)!.close).not.toHaveBeenCalled();
  });

  it('synchronizes members, routes guest data through host, and closes the whole room with host', async () => {
    const room = host();
    const first = await attach(room);
    const second = await attach(room);
    expect(room.peers.map((peer) => peer.id)).toEqual([first.room.id, second.room.id]);
    expect(first.room.peers.map((peer) => peer.id)).toEqual([room.id, second.room.id]);
    expect(second.room.peers.map((peer) => peer.id)).toEqual([room.id, first.room.id]);
    const hostMessage = vi.fn();
    const firstMessage = vi.fn();
    const secondMessage = vi.fn();
    room.on('message', hostMessage);
    first.room.on('message', firstMessage);
    second.room.on('message', secondMessage);
    await first.room.send(second.room.id, 'direct');
    expect(secondMessage).toHaveBeenLastCalledWith({ from: first.room.id, data: 'direct' });
    expect(hostMessage).not.toHaveBeenCalled();
    await first.room.broadcast('all');
    expect(hostMessage).toHaveBeenCalledWith({ from: first.room.id, data: 'all' });
    expect(secondMessage).toHaveBeenCalledWith({ from: first.room.id, data: 'all' });
    expect(firstMessage).not.toHaveBeenCalled();
    first.room.close();
    await ticks();
    expect(room.peers.map((peer) => peer.id)).toEqual([second.room.id]);
    expect(second.room.peers.map((peer) => peer.id)).toEqual([room.id]);
    room.close();
    expect(second.room.state).toBe('closed');
    expect(room.peers).toEqual([]);
    expect(FakePC.instances.every((pc) => pc.close.mock.calls.length === 1)).toBe(true);
  });

  it('disconnects guests that inject host-only delivery or membership frames', async () => {
    const room = host();
    const joined = await attach(room);
    const errors = vi.fn();
    room.on('error', errors);
    joined.guestChannel.send(encodeDataFrame({ type: 'deliver', from: room.id }, 'forged') as ArrayBuffer);
    expect(errors).toHaveBeenCalledWith(expect.any(Error));
    expect(room.peers).toEqual([]);
    expect(joined.room.state).toBe('closed');
  });

  it('does not reopen a guest closed by its membership callback', async () => {
    const room = host();
    const offer = await room.createInvitation();
    const hostPC = FakePC.instances.at(-1)!;
    const joined = await joinRoom(offer);
    rooms.push(joined.room);
    const guestPC = FakePC.instances.at(-1)!;
    const guestChannel = new FakeChannel();
    guestPC.receiveChannel(guestChannel);
    guestChannel.partner = hostPC.channel;
    hostPC.channel!.partner = guestChannel;
    joined.room.on('peers', () => joined.room.close());
    await room.acceptAnswer(joined.answer);
    guestChannel.open();
    hostPC.channel!.open();
    await ticks();
    expect(joined.room.state).toBe('closed');
    expect(room.peers).toEqual([]);
  });
});

describe('sending and backpressure', () => {
  it('automatically transports large Unicode, binary and Blob messages under negotiated capacities', async () => {
    const room = host();
    const joined = await attach(room);
    joined.hostPC.sctp.maxMessageSize = 8192;
    const received: unknown[] = [];
    joined.room.on('message', ({ data }) => received.push(data));
    const text = '你好🌍'.repeat(30_000);
    const bytes = new Uint8Array(2 * 1024 * 1024 + 17).map((_, index) => index % 251);
    await room.send(joined.room.id, text);
    await room.send(joined.room.id, bytes);
    await room.send(joined.room.id, new Blob([bytes]));
    expect(received).toEqual([text, bytes.buffer, bytes.buffer]);
    const frames = joined.hostChannel.sent.filter((frame): frame is ArrayBuffer => frame instanceof ArrayBuffer);
    expect(frames.length).toBeGreaterThan(100);
    expect(frames.every((frame) => frame.byteLength <= 8192)).toBe(true);
  });

  it('reframes relayed messages for recipients with different negotiated capacities', async () => {
    const room = host();
    const first = await attach(room);
    const second = await attach(room);
    first.guestPC.sctp.maxMessageSize = 256 * 1024;
    second.hostPC.sctp.maxMessageSize = 4096;
    const received = vi.fn();
    second.room.on('message', received);
    const text = 'relay'.repeat(50_000);
    await first.room.send(second.room.id, text);
    for (let i = 0; i < 20; i++) await ticks();
    expect(received).toHaveBeenCalledWith({ from: first.room.id, data: text });
    expect(second.hostChannel.sent.filter(frame => frame instanceof ArrayBuffer)
      .every(frame => (frame as ArrayBuffer).byteLength <= 4096)).toBe(true);
  });

  it('rejects absent recipients without writing data', async () => {
    const room = host();
    const joined = await attach(room);
    const count = joined.hostChannel.sent.length;
    await expect(room.send('missing-peer-00001', 'x')).rejects.toThrow(/connected peer/);
    expect(joined.hostChannel.sent).toHaveLength(count);
  });

  it('preserves call order and snapshots mutable buffers before waiting', async () => {
    const room = host();
    const joined = await attach(room);
    joined.hostChannel.bufferedAmount = 2 * 1024 * 1024;
    const received: unknown[] = [];
    joined.room.on('message', ({ data }) => received.push(data));
    const bytes = new Uint8Array([1, 2, 3]);
    const first = room.send(joined.room.id, bytes);
    const second = room.send(joined.room.id, new Blob(['second']));
    const third = room.send(joined.room.id, 'third');
    bytes.fill(9);
    await ticks();
    expect(received).toEqual([]);
    joined.hostChannel.bufferedAmount = 0;
    joined.hostChannel.dispatchEvent(new Event('bufferedamountlow'));
    await Promise.all([first, second, third]);
    expect(received).toEqual([new Uint8Array([1, 2, 3]).buffer, new TextEncoder().encode('second').buffer, 'third']);
  });

  it('waits for capacity instead of rejecting when browser buffers are full', async () => {
    const room = host();
    const joined = await attach(room);
    joined.hostChannel.bufferedAmount = 2 * 1024 * 1024;
    const before = joined.hostChannel.sent.length;
    let completed = false;
    const sending = room.send(joined.room.id, new Uint8Array(3 * 1024 * 1024)).then(() => { completed = true; });
    await ticks();
    expect(completed).toBe(false);
    expect(joined.hostChannel.sent).toHaveLength(before);
    joined.hostChannel.bufferedAmount = 0;
    joined.hostChannel.dispatchEvent(new Event('bufferedamountlow'));
    await sending;
    expect(completed).toBe(true);
  });

  it('settles blocked and queued sends when their connection closes', async () => {
    const room = host();
    const joined = await attach(room);
    joined.hostChannel.bufferedAmount = 2 * 1024 * 1024;
    const first = room.send(joined.room.id, new Blob([new Uint8Array(1024 * 1024)]));
    const second = room.send(joined.room.id, 'later');
    const checked = Promise.all([expect(first).rejects.toThrow(/closed|disconnected/), expect(second).rejects.toThrow(/closed|disconnected/)]);
    await ticks();
    room.close();
    await checked;
  });

  it('allows cancelling the accepted answer while the channel is still connecting', async () => {
    const room = host();
    const offer = await room.createInvitation();
    await room.acceptAnswer(answerFor(offer));
    const pc = FakePC.instances.at(-1)!;
    room.cancelInvitation();
    expect(pc.close).toHaveBeenCalledOnce();
    expect(room.state).toBe('waiting');
    await expect(room.createInvitation()).resolves.toBeTypeOf('string');
  });
});

describe('flow controlled streams', () => {
  it('waits for receiver demand and preserves large stream content through the host relay', async () => {
    const relay = host(); const a = await attach(relay); const b = await attach(relay);
    b.hostPC.sctp.maxMessageSize = 4096;
    let incoming: import('../src/streams.js').IncomingStream | undefined;
    b.room.on('stream', value => { incoming = value; });
    const ordinary = vi.fn(); b.room.on('message', ordinary);
    const bytes = new Uint8Array(700_013).map((_, i) => i % 251);
    let complete = false;
    const sending = a.room.sendStream(b.room.id, new Blob([bytes]).stream(), { totalBytes: bytes.length, metadata: 'opaque' }).then(() => { complete = true; });
    for (let n = 0; n < 5; n++) await ticks();
    expect(incoming?.from).toBe(a.room.id); expect(incoming?.metadata).toBe('opaque'); expect(complete).toBe(false);
    const reader = incoming!.stream.getReader(); const parts: Uint8Array[] = [];
    for (;;) { const part = await reader.read(); if (part.done) break; parts.push(part.value); }
    await sending; reader.releaseLock();
    expect(new Uint8Array(await new Blob(parts.map(part => new Uint8Array(part))).arrayBuffer())).toEqual(bytes);
    expect(ordinary).not.toHaveBeenCalled(); expect(parts.every(part => part.length <= 256 * 1024)).toBe(true);
  });
  it('cancels blocked streams and keeps ordinary business messages separate', async () => {
    const room = host(); const guest = await attach(room);
    let incoming: import('../src/streams.js').IncomingStream | undefined;
    guest.room.on('stream', stream => { incoming = stream; });
    const messages = vi.fn(); guest.room.on('message', messages);
    const sending = room.sendStream(guest.room.id, new Blob(['waiting']).stream());
    const rejected = expect(sending).rejects.toMatchObject({ name: 'AbortError' });
    for (let n = 0; n < 5; n++) await ticks();
    await room.send(guest.room.id, JSON.stringify({ t: 'cancel', id: incoming!.id }));
    expect(messages).toHaveBeenCalledOnce();
    await incoming!.stream.cancel(); await rejected;
    expect(room.state).toBe('connected');
  });
  it('host removal aborts active work and guest cannot remove other peers', async () => {
    const room = host(); const guest = await attach(room);
    guest.room.on('stream', () => {});
    const pending = room.sendStream(guest.room.id, new Blob(['waiting']).stream());
    const rejected = expect(pending).rejects.toThrow(); await ticks();
    expect(() => guest.room.removePeer(room.id)).toThrow(); room.removePeer(guest.room.id); await rejected;
    expect(guest.room.state).toBe('closed'); expect(room.state).toBe('waiting');
  });
});
