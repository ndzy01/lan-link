/** One-use, short-lived signaling carried entirely by the two QR codes. */
export interface PairingPayload {
  version: 1;
  kind: 'offer' | 'answer';
  roomId: string;
  hostId: string;
  peerId: string;
  pairId: string;
  expiresAt: number;
  sdp: string;
}

const PREFIX = 'LAN1:';
// Keep a single QR within byte-mode capacity at medium error correction.
export const MAX_PAIRING_CHARACTERS = 2200;
const MAX_UNCOMPRESSED_BYTES = 32 * 1024;
const ID = /^[a-zA-Z0-9_-]{8,128}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function newId(): string {
  // getRandomValues also works in non-secure contexts; camera scanning does not.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validate(value: unknown): asserts value is PairingPayload {
  if (!value || typeof value !== 'object') throw new Error('这不是有效的配对二维码。');
  const data = value as Partial<PairingPayload>;
  if (data.version !== 1 || !['offer', 'answer'].includes(data.kind ?? '') ||
      ![data.roomId, data.hostId, data.peerId, data.pairId].every((id) => typeof id === 'string' && ID.test(id)) ||
      data.hostId === data.peerId ||
      typeof data.expiresAt !== 'number' || !Number.isSafeInteger(data.expiresAt) ||
      typeof data.sdp !== 'string' || !data.sdp.startsWith('v=0\r\n') ||
      !data.sdp.includes('m=application ') ||
      !data.sdp.includes('a=fingerprint:') ||
      !data.sdp.includes('a=ice-ufrag:') ||
      !data.sdp.includes('a=ice-pwd:') ||
      data.sdp.includes('\nm=audio ') || data.sdp.includes('\nm=video ')) {
    throw new Error('配对信息不完整或格式不正确，请重新生成二维码。');
  }
  if (data.expiresAt <= Date.now()) throw new Error('配对二维码已过期，请让房主重新生成。');
}

async function readLimited(stream: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error('配对信息过大，无法读取。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function ensureCompression(): void {
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持二维码配对压缩，请使用新版 Safari 或 Chrome。');
  }
}

export async function encodePairing(payload: PairingPayload): Promise<string> {
  validate(payload);
  ensureCompression();
  const bytes = encoder.encode(JSON.stringify(payload));
  if (bytes.byteLength > MAX_UNCOMPRESSED_BYTES) throw new Error('连接信息过大，无法生成单张二维码。');
  const compressed = await readLimited(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')),
    MAX_UNCOMPRESSED_BYTES,
  );
  const encoded = PREFIX + btoa(String.fromCharCode(...compressed));
  if (encoded.length > MAX_PAIRING_CHARACTERS) {
    throw new Error('连接信息无法装入单张二维码，请关闭多余的网络或 VPN 连接后重试。');
  }
  return encoded;
}

export async function decodePairing(token: string): Promise<PairingPayload> {
  const text = token.trim();
  if (!text.startsWith(PREFIX) || text.length > MAX_PAIRING_CHARACTERS ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(text.slice(PREFIX.length))) {
    throw new Error('这不是有效的配对二维码。');
  }
  ensureCompression();
  let payload: unknown;
  try {
    const compressed = Uint8Array.from(atob(text.slice(PREFIX.length)), (char) => char.charCodeAt(0));
    const bytes = await readLimited(
      new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate')),
      MAX_UNCOMPRESSED_BYTES,
    );
    payload = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error('配对二维码损坏或内容过大，请重新扫描。');
  }
  validate(payload);
  return payload;
}
