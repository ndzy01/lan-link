import { newId } from './pairing.js';
import { validId, type ReceivedData } from './wire.js';
export type StreamOptions = {
  id?: string; offset?: number; totalBytes?: number; metadata?: string;
  signal?: AbortSignal; onProgress?: (bytes: number) => void;
};
export type IncomingStream = {
  from: string; id: string; offset: number; totalBytes?: number; metadata: string;
  stream: ReadableStream<Uint8Array>;
};
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const validSize = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const aborted = () => new DOMException('Stream cancelled or peer disconnected.', 'AbortError');
type Waiter = { expected: number | 'end'; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Input = { peer: string; id: string; position: number; total?: number; credit: boolean; controller: ReadableStreamDefaultController<Uint8Array> };

/** One pull credit per chunk bounds receiver buffering; application storage ACKs are separate. */
export class StreamBroker {
  private inputs = new Map<string, Input>();
  private outputs = new Map<string, AbortController>();
  private waiters = new Map<string, Waiter>();
  constructor(private send: (peer: string, data: string | ArrayBuffer) => Promise<void>, private emit: (stream: IncomingStream) => void) {}
  private key(peer: string, id: string): string { return `${peer}/${id}`; }
  private control(peer: string, message: object): Promise<void> { return this.send(peer, JSON.stringify(message)); }
  private wait(key: string, expected: number | 'end', signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = () => settle(aborted());
      const settle = (error?: Error) => {
        const waiter = this.waiters.get(key);
        if (waiter?.resolve !== ok) return;
        clearTimeout(waiter.timer); this.waiters.delete(key); signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve();
      };
      const ok = () => settle();
      const timer = setTimeout(() => settle(new Error('Stream receiver timed out.')), 60_000);
      this.waiters.set(key, { expected, resolve: ok, reject: settle, timer });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  async sendStream(peer: string, source: ReadableStream<Uint8Array>, options: StreamOptions = {}): Promise<void> {
    const id = options.id ?? newId(); const offset = options.offset ?? 0;
    if (!validId(id) || !validSize(offset) || (options.totalBytes !== undefined && (!validSize(options.totalBytes) || options.totalBytes < offset))) throw new Error('Invalid stream metadata.');
    const key = this.key(peer, id);
    if (this.outputs.has(key)) throw new Error('Stream ID is already active.');
    const abort = new AbortController(); this.outputs.set(key, abort);
    const cancel = () => abort.abort(); options.signal?.addEventListener('abort', cancel, { once: true });
    const reader = source.getReader();
    const stopReader = () => { void reader.cancel(aborted()).catch(() => {}); };
    abort.signal.addEventListener('abort', stopReader, { once: true });
    if (options.signal?.aborted) abort.abort();
    let position = offset;
    try {
      if (abort.signal.aborted) throw aborted();
      let ack = this.wait(key, offset, abort.signal); ack.catch(() => {});
      await this.control(peer, { t: 'open', id, offset, total: options.totalBytes, metadata: options.metadata ?? '' }); await ack;
      for (;;) {
        const part = await reader.read();
        if (abort.signal.aborted) throw aborted();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw new TypeError('Stream chunks must be Uint8Array.');
        // This is a scheduling window, independent of file size and SCTP frame size.
        for (let start = 0; start < part.value.byteLength; start += 256 * 1024) {
          const payload = part.value.subarray(start, start + 256 * 1024);
          const header = encoder.encode(JSON.stringify({ id, offset: position }));
          const frame = new Uint8Array(4 + header.byteLength + payload.byteLength);
          new DataView(frame.buffer).setUint32(0, header.byteLength); frame.set(header, 4); frame.set(payload, 4 + header.byteLength);
          position += payload.byteLength;
          if (!validSize(position) || (options.totalBytes !== undefined && position > options.totalBytes)) throw new Error('Stream exceeds its declared size.');
          ack = this.wait(key, position, abort.signal); ack.catch(() => {});
          await this.send(peer, frame.buffer); await ack; options.onProgress?.(position);
        }
      }
      if (options.totalBytes !== undefined && position !== options.totalBytes) throw new Error('Stream ended before its declared size.');
      ack = this.wait(key, 'end', abort.signal); ack.catch(() => {});
      await this.control(peer, { t: 'end', id, offset: position }); await ack;
    } catch (error) {
      void this.control(peer, { t: 'cancel', id }).catch(() => {});
      throw error;
    } finally {
      abort.abort(); abort.signal.removeEventListener('abort', stopReader);
      options.signal?.removeEventListener('abort', cancel); this.outputs.delete(key);
      try { reader.releaseLock(); } catch {}
    }
  }
  receive(peer: string, data: ReceivedData): void {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength < 5) throw new Error('Truncated stream chunk.');
      const n = new DataView(data).getUint32(0);
      if (n > 1024 || n + 4 >= data.byteLength) throw new Error('Invalid stream header.');
      const header = JSON.parse(decoder.decode(new Uint8Array(data, 4, n)));
      const key = this.key(peer, header.id); const input = this.inputs.get(key);
      if (!input) return; // A cancelled stream can have a final chunk in flight.
      const bytes = new Uint8Array(data.slice(4 + n));
      if (!input.credit || header.offset !== input.position || bytes.byteLength > 256 * 1024 || (input.total !== undefined && input.position + bytes.byteLength > input.total)) throw new Error('Invalid stream sequence.');
      input.credit = false; input.position += bytes.byteLength; input.controller.enqueue(bytes);
      return;
    }
    const value = JSON.parse(data);
    if (!value || !validId(value.id)) throw new Error('Invalid stream control.');
    const key = this.key(peer, value.id);
    if (value.t === 'ack') {
      const waiter = this.waiters.get(key);
      if (waiter && waiter.expected === value.offset) waiter.resolve();
    } else if (value.t === 'cancel') {
      this.cancelKey(key);
    } else if (value.t === 'open') {
      if (!validSize(value.offset) || (value.total !== undefined && (!validSize(value.total) || value.total < value.offset)) || typeof value.metadata !== 'string' || this.inputs.has(key)) throw new Error('Invalid stream offer.');
      const stream = new ReadableStream<Uint8Array>({
        start: controller => this.inputs.set(key, { peer, id: value.id, position: value.offset, total: value.total, credit: false, controller }),
        pull: () => {
          const input = this.inputs.get(key);
          if (!input || input.credit) return;
          input.credit = true;
          void this.control(peer, { t: 'ack', id: value.id, offset: input.position }).catch(() => this.cancelKey(key));
        },
        cancel: () => { this.inputs.delete(key); void this.control(peer, { t: 'cancel', id: value.id }).catch(() => {}); },
      }, { highWaterMark: 0 });
      this.emit({ from: peer, id: value.id, offset: value.offset, totalBytes: value.total, metadata: value.metadata, stream });
    } else if (value.t === 'end') {
      const input = this.inputs.get(key);
      if (!input) return;
      if (input.position !== value.offset || (input.total !== undefined && input.position !== input.total)) throw new Error('Incomplete stream.');
      this.inputs.delete(key); input.controller.close();
      void this.control(peer, { t: 'ack', id: value.id, offset: 'end' }).catch(() => {});
    } else throw new Error('Unknown stream control.');
  }
  private cancelKey(key: string): void {
    this.waiters.get(key)?.reject(aborted()); this.outputs.get(key)?.abort();
    const input = this.inputs.get(key); this.inputs.delete(key);
    if (input) { try { input.controller.error(aborted()); } catch {} }
  }
  removePeer(peer: string): void {
    for (const key of new Set([...this.inputs.keys(), ...this.outputs.keys()])) if (key.startsWith(`${peer}/`)) this.cancelKey(key);
  }
  close(): void { for (const key of new Set([...this.inputs.keys(), ...this.outputs.keys()])) this.cancelKey(key); }
}
