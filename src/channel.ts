/** Fragmentation is internal; these are scheduling budgets, not message limits. */
const MAGIC = 0x4c414e32;
const HEADER = 28;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export type ChannelFrame = string | ArrayBuffer | Blob;

export function frameBudget(negotiated: number | undefined, size: number): number {
  // A missing SCTP value uses SDP's default receive limit. Infinity means no
  // negotiated ceiling, not permission to fill the browser's entire send buffer.
  const capability = negotiated === Infinity || negotiated === 0 ? Infinity
    : negotiated === undefined ? 65_536 : negotiated;
  if (!(capability > HEADER) || Number.isNaN(capability)) {
    throw new Error('Negotiated SCTP message capacity is too small for framing.');
  }
  return Math.floor(Math.min(capability, Math.max(4096, Math.min(size + HEADER, 256 * 1024))));
}

/** Reliable ordered channel: only one fragmented message is in flight per link. */
export class ChannelAssembler {
  private active?: { id: number; total: number; offset: number; text: boolean; chunks: Uint8Array[] };
  clear(): void { this.active = undefined; }
  accept(frame: unknown): string | ArrayBuffer | undefined {
    if (!(frame instanceof ArrayBuffer) || frame.byteLength < 4 || new DataView(frame).getUint32(0) !== MAGIC) {
      if (this.active) throw new Error('Interrupted fragmented message.');
      if (typeof frame !== 'string' && !(frame instanceof ArrayBuffer)) throw new Error('Invalid channel frame.');
      return frame;
    }
    if (frame.byteLength <= HEADER) throw new Error('Truncated fragment.');
    const view = new DataView(frame);
    const id = view.getUint32(4);
    const total = view.getFloat64(8);
    const offset = view.getFloat64(16);
    const flags = view.getUint32(24);
    const length = frame.byteLength - HEADER;
    if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(offset) || offset < 0 ||
        flags > 1 || offset + length > total) throw new Error('Invalid fragment extent.');
    if (!this.active) {
      if (offset !== 0) throw new Error('Missing initial fragment.');
      this.active = { id, total, offset: 0, text: flags === 1, chunks: [] };
    }
    const active = this.active;
    if (active.id !== id || active.total !== total || active.offset !== offset || active.text !== (flags === 1)) {
      throw new Error('Out-of-order or inconsistent fragment.');
    }
    // Do not allocate a claimed total before receiving it.
    active.chunks.push(new Uint8Array(frame, HEADER));
    active.offset += length;
    if (active.offset < total) return;
    this.active = undefined;
    const bytes = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of active.chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
    return active.text ? decoder.decode(bytes) : bytes.buffer;
  }
}

/** Backpressure waits for capacity instead of rejecting a valid large message. */
export class ChannelQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private sequence = 0;
  private waiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  constructor(
    private channel: RTCDataChannel,
    private capacity: () => number | undefined,
    private fail: (error: Error) => void,
  ) {
    channel.addEventListener('bufferedamountlow', this.wake);
  }
  enqueue(frame: ChannelFrame): Promise<void> {
    const task = this.tail.then(() => this.transmit(frame));
    this.tail = task.catch(() => {});
    return task;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener('bufferedamountlow', this.wake);
    for (const waiter of this.waiters) waiter.reject(new Error('Peer is disconnected.'));
    this.waiters.clear();
  }
  private assertOpen(): void {
    if (this.closed || this.channel.readyState !== 'open') throw new Error('Peer is disconnected.');
  }
  private wake = (): void => {
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  };
  private async write(frame: string | ArrayBuffer, window: number): Promise<void> {
    this.assertOpen();
    const size = typeof frame === 'string' ? encoder.encode(frame).byteLength : frame.byteLength;
    this.channel.bufferedAmountLowThreshold = Math.floor(window / 2);
    while (this.channel.bufferedAmount + size > window) {
      await new Promise<void>((resolve, reject) => this.waiters.add({ resolve, reject }));
      this.assertOpen();
    }
    try {
      if (typeof frame === 'string') this.channel.send(frame);
      else this.channel.send(frame);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.close();
      this.fail(failure);
      throw failure;
    }
  }
  private async transmit(frame: ChannelFrame): Promise<void> {
    this.assertOpen();
    const text = typeof frame === 'string';
    const source = text ? encoder.encode(frame) : frame instanceof Blob ? frame : new Uint8Array(frame);
    const size = source instanceof Blob ? source.size : source.byteLength;
    const budget = frameBudget(this.capacity(), size);
    const window = Math.max(64 * 1024, budget * 4);
    if (size <= budget) {
      await this.write(typeof frame === 'string' ? frame : frame instanceof Blob ? await frame.arrayBuffer() : frame, window);
      return;
    }
    const id = this.sequence++ >>> 0;
    for (let offset = 0; offset < size;) {
      this.assertOpen();
      const end = Math.min(size, offset + budget - HEADER);
      const bytes = source instanceof Blob
        ? new Uint8Array(await source.slice(offset, end).arrayBuffer()) : source.subarray(offset, end);
      const part = new Uint8Array(HEADER + bytes.byteLength);
      const view = new DataView(part.buffer);
      view.setUint32(0, MAGIC); view.setUint32(4, id);
      view.setFloat64(8, size); view.setFloat64(16, offset); view.setUint32(24, text ? 1 : 0);
      part.set(bytes, HEADER);
      await this.write(part.buffer, window);
      offset = end;
    }
  }
}
