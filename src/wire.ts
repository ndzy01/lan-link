export const MAX_DATA_HEADER_BYTES = 512;
const MAX_CONTROL_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type PeerInfo = Readonly<{ id: string; role: 'host' | 'guest' }>;
export type MessageData = string | ArrayBuffer | ArrayBufferView | Blob;
export type ReceivedData = string | ArrayBuffer;
export type WireMessage =
  | { type: 'route'; to: string | null; data: ReceivedData; lane: 'message' | 'stream' }
  | { type: 'deliver'; from: string; data: ReceivedData; lane: 'message' | 'stream' }
  | { type: 'members'; peers: readonly PeerInfo[] }
  | { type: 'close' };

export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalid(): never {
  throw new Error('Invalid LAN Link protocol message.');
}

export function dataByteLength(data: MessageData): number {
  let size: number;
  if (typeof data === 'string') size = encoder.encode(data).byteLength;
  else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) size = data.byteLength;
  else if (typeof Blob !== 'undefined' && data instanceof Blob) size = data.size;
  else throw new TypeError('Data must be a string, ArrayBuffer, ArrayBufferView, or Blob.');
  return size;
}

/** Copy mutable buffers at send() time; Blob is already immutable. */
export function snapshotData(data: MessageData): string | ArrayBuffer | Blob {
  dataByteLength(data);
  if (typeof data === 'string' || data instanceof Blob) return data;
  const view = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return Uint8Array.from(view).buffer;
}

export function encodeDataFrame(
  destination: { type: 'route'; to: string | null } | { type: 'deliver'; from: string },
  data: string | ArrayBuffer | Blob,
  lane: 'message' | 'stream' = 'message',
): ArrayBuffer | Blob {
  dataByteLength(data);
  const address = destination.type === 'route' ? destination.to : destination.from;
  if (!(destination.type === 'route' && address === null) && !validId(address)) invalid();
  const header = encoder.encode(JSON.stringify({
    v: 1,
    t: destination.type,
    ...(destination.type === 'route' ? { to: destination.to } : { from: destination.from }),
    kind: typeof data === 'string' ? 'text' : 'binary', lane,
  }));
  if (data instanceof Blob) {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, header.byteLength);
    return new Blob([prefix, header, data]);
  }
  const payload = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
  const output = new Uint8Array(4 + header.byteLength + payload.byteLength);
  new DataView(output.buffer).setUint32(0, header.byteLength);
  output.set(header, 4);
  output.set(payload, 4 + header.byteLength);
  return output.buffer;
}

export function encodeMembers(peers: readonly PeerInfo[]): string {
  const frame = JSON.stringify({ v: 1, t: 'members', peers });
  // Use the same validator for locally generated control packets.
  decodeFrame(frame);
  return frame;
}

export function decodeFrame(frame: unknown): WireMessage {
  if (typeof frame === 'string') {
    if (encoder.encode(frame).byteLength > MAX_CONTROL_BYTES) invalid();
    let value: unknown;
    try { value = JSON.parse(frame); } catch { invalid(); }
    if (!object(value) || value.v !== 1) invalid();
    if (value.t === 'close' && exactKeys(value, ['v', 't'])) return { type: 'close' };
    if (value.t !== 'members' || !exactKeys(value, ['v', 't', 'peers']) ||
        !Array.isArray(value.peers) || value.peers.length === 0) invalid();
    const ids = new Set<string>();
    let hosts = 0;
    const peers: PeerInfo[] = value.peers.map((peer: unknown) => {
      if (!object(peer) || !exactKeys(peer, ['id', 'role']) || !validId(peer.id) ||
          (peer.role !== 'host' && peer.role !== 'guest') || ids.has(peer.id)) invalid();
      ids.add(peer.id);
      if (peer.role === 'host') hosts++;
      return Object.freeze({ id: peer.id, role: peer.role });
    });
    if (hosts !== 1) invalid();
    return { type: 'members', peers: Object.freeze(peers) };
  }
  if (!(frame instanceof ArrayBuffer) ||
      frame.byteLength < 4) invalid();
  const headerLength = new DataView(frame).getUint32(0);
  if (headerLength === 0 || headerLength > MAX_DATA_HEADER_BYTES ||
      4 + headerLength > frame.byteLength) invalid();
  let header: unknown;
  try {
    header = JSON.parse(decoder.decode(new Uint8Array(frame, 4, headerLength)));
  } catch { invalid(); }
  if (!object(header) || header.v !== 1 || !['message', 'stream'].includes(header.lane as string) || (header.kind !== 'text' && header.kind !== 'binary')) invalid();
  if (header.t === 'route') {
    if (!exactKeys(header, ['v', 't', 'to', 'kind', 'lane']) ||
        !(header.to === null || validId(header.to))) invalid();
  } else if (header.t === 'deliver') {
    if (!exactKeys(header, ['v', 't', 'from', 'kind', 'lane']) || !validId(header.from)) invalid();
  } else invalid();
  const bytes = frame.slice(4 + headerLength);
  let data: ReceivedData = bytes;
  if (header.kind === 'text') {
    try { data = decoder.decode(bytes); } catch { invalid(); }
  }
  return header.t === 'route'
    ? { type: 'route', to: header.to as string | null, data, lane: header.lane as 'message' | 'stream' }
    : { type: 'deliver', from: header.from as string, data, lane: header.lane as 'message' | 'stream' };
}
