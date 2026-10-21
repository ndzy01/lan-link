import { decodePairing, encodePairing, newId, type PairingPayload } from './pairing.js';
import { decodeFrame, encodeDataFrame, encodeMembers, snapshotData, validId,
  type MessageData, type PeerInfo, type ReceivedData } from './wire.js';
import { StreamBroker, type StreamOptions, type IncomingStream } from './streams.js';
import { ChannelAssembler, ChannelQueue } from './channel.js';

export type { MessageData, PeerInfo, ReceivedData } from './wire.js';
export type RoomState = 'waiting' | 'connecting' | 'connected' | 'closed';
export type RoomOptions = {
  maxPeers?: number;
  pairingTimeoutMs?: number;
  connectionTimeoutMs?: number;
  /** Cancels joinRoom while decoding/generating pairing information, before it returns. */
  signal?: AbortSignal;
};
export type RoomEvents = {
  stream: IncomingStream;
  message: { from: string; data: ReceivedData };
  peers: readonly PeerInfo[];
  state: RoomState;
  error: Error;
};
export interface LanRoom {
  readonly id: string;
  readonly hostId: string;
  readonly roomId: string;
  readonly role: 'host' | 'guest';
  readonly peers: readonly PeerInfo[];
  readonly state: RoomState;
  createInvitation(): Promise<string>;
  acceptAnswer(token: string): Promise<void>;
  cancelInvitation(): void;
  send(peerId: string, data: MessageData): Promise<void>;
  broadcast(data: MessageData): Promise<void>;
  sendStream(peerId: string, source: ReadableStream<Uint8Array>, options?: StreamOptions): Promise<void>;
  removePeer(peerId: string): void;
  close(): void;
  on<K extends keyof RoomEvents>(event: K, listener: (value: RoomEvents[K]) => void): () => void;
}

type Settings = Required<Omit<RoomOptions, 'signal'>>;
const CHANNEL_LABEL = 'lan-link';

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function settings(options: RoomOptions): Settings {
  const result = {
    maxPeers: options.maxPeers ?? 8,
    pairingTimeoutMs: options.pairingTimeoutMs ?? 180_000,
    connectionTimeoutMs: options.connectionTimeoutMs ?? 20_000,
  };
  if (!Number.isSafeInteger(result.maxPeers) || result.maxPeers < 2) {
    throw new RangeError('maxPeers must be an integer of at least 2, including the host.');
  }
  for (const key of ['pairingTimeoutMs', 'connectionTimeoutMs'] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0 || result[key] > 2_147_483_647) {
      throw new RangeError(`${key} must be a positive timer duration.`);
    }
  }
  return result;
}

type Link = {
  peerId: string;
  pc: RTCPeerConnection;
  abort: AbortController;
  channel?: RTCDataChannel;
  queue?: ChannelQueue;
  assembler: ChannelAssembler;
  admitted: boolean;
  answerUsed: boolean;
  pair: PairingPayload;
  expiryTimer?: ReturnType<typeof setTimeout>;
  connectionTimer?: ReturnType<typeof setTimeout>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  cleanup: (() => void)[];
};

function abortable<T>(operation: Promise<T>, ...signals: AbortSignal[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      for (const signal of signals) signal.removeEventListener('abort', cancel);
    };
    const cancel = () => { cleanup(); reject(new Error('Connection was closed.')); };
    if (signals.some((signal) => signal.aborted)) {
      operation.catch(() => {});
      cancel();
      return;
    }
    for (const signal of signals) signal.addEventListener('abort', cancel, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function completeDescription(link: Link, timeoutMs: number): Promise<string> {
  const { pc, abort } = link;
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', changed);
        abort.signal.removeEventListener('abort', cancelled);
      };
      const changed = () => {
        if (pc.iceGatheringState === 'complete') { cleanup(); resolve(); }
      };
      const cancelled = () => { cleanup(); reject(new Error('Pairing was cancelled or expired.')); };
      if (abort.signal.aborted) { cancelled(); return; }
      pc.addEventListener('icegatheringstatechange', changed);
      abort.signal.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Local ICE gathering timed out. Check the local network and retry pairing.'));
      }, timeoutMs);
      changed();
    });
  }
  if (abort.signal.aborted || !pc.localDescription?.sdp) {
    throw new Error('No complete local connection description is available.');
  }
  if (!/^a=candidate:/m.test(pc.localDescription.sdp)) {
    throw new Error('No local ICE candidate is available. Check the local network and retry pairing.');
  }
  return pc.localDescription.sdp;
}

class Room implements LanRoom {
  readonly id: string;
  readonly hostId: string;
  readonly roomId: string;
  readonly role: 'host' | 'guest';
  private currentState: RoomState;
  private currentPeers: readonly PeerInfo[] = Object.freeze([]);
  private config: Settings;
  private links = new Map<string, Link>();
  private pending?: Link;
  private listeners = new Map<keyof RoomEvents, Set<(value: never) => void>>();
  private abort = new AbortController();
  private outgoing: Promise<void> = Promise.resolve();
  private streams = new StreamBroker(
    (peer, data) => this.sendData(peer, data, 'stream'),
    (stream) => { if (this.listeners.get('stream')?.size) this.emit('stream', stream); else void stream.stream.cancel(); },
  );
  private syncingMembers = false;
  private syncAgain = false;

  constructor(options: RoomOptions, offer?: PairingPayload) {
    this.config = settings(options);
    this.role = offer ? 'guest' : 'host';
    this.hostId = offer?.hostId ?? newId();
    this.id = offer?.peerId ?? this.hostId;
    this.roomId = offer?.roomId ?? newId();
    this.currentState = offer ? 'connecting' : 'waiting';
  }
  get state(): RoomState { return this.currentState; }
  get peers(): readonly PeerInfo[] { return this.currentPeers; }
  on<K extends keyof RoomEvents>(event: K, listener: (value: RoomEvents[K]) => void): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) { listeners = new Set(); this.listeners.set(event, listeners); }
    const callback = listener as (value: never) => void;
    listeners.add(callback);
    return () => { listeners.delete(callback); };
  }
  private emit<K extends keyof RoomEvents>(event: K, value: RoomEvents[K]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      // Business callbacks cannot break protocol handling or resource cleanup.
      try { listener(value as never); } catch (error) {
        if (event !== 'error') this.emit('error', errorOf(error));
      }
    }
  }
  private setState(state: RoomState): void {
    if (state === this.currentState || this.currentState === 'closed') return;
    this.currentState = state;
    this.emit('state', state);
  }
  private assertLive(): void {
    if (this.state === 'closed') throw new Error('Room is closed.');
  }
  private assertHost(): void {
    this.assertLive();
    if (this.role !== 'host') throw new Error('Only the host can manage invitations.');
  }
  private activeLinks(): Link[] {
    return [...this.links.values()].filter((link) => link.admitted && !link.abort.signal.aborted);
  }
  private refreshHostState(): void {
    if (this.role !== 'host' || this.state === 'closed') return;
    this.setState(this.activeLinks().length ? 'connected'
      : [...this.links.values()].some((link) => link.answerUsed) ? 'connecting' : 'waiting');
  }
  private listen(
    link: Link, target: EventTarget, event: string, listener: EventListener,
  ): void {
    target.addEventListener(event, listener);
    link.cleanup.push(() => target.removeEventListener(event, listener));
  }
  private createLink(pair: PairingPayload, peerId: string): Link {
    const pc = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all' });
    const link: Link = {
      peerId, pc, abort: new AbortController(), admitted: false,
      answerUsed: false, pair, cleanup: [], assembler: new ChannelAssembler(),
    };
    this.links.set(peerId, link);
    link.expiryTimer = setTimeout(() => {
      this.failLink(link, new Error('Pairing invitation expired.'));
    }, Math.max(0, pair.expiresAt - Date.now()));
    this.listen(link, pc, 'connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.failLink(link, new Error('Peer connection failed or closed.'));
      } else if (pc.connectionState === 'disconnected') {
        if (!link.disconnectTimer) link.disconnectTimer = setTimeout(() => {
          this.failLink(link, new Error('Peer connection did not recover.'));
        }, this.config.connectionTimeoutMs);
      } else {
        clearTimeout(link.disconnectTimer);
        link.disconnectTimer = undefined;
        if (pc.connectionState === 'connected' && !link.admitted) this.startConnectionTimer(link);
      }
    });
    return link;
  }
  private startConnectionTimer(link: Link): void {
    if (link.connectionTimer || link.admitted || link.abort.signal.aborted) return;
    link.connectionTimer = setTimeout(() => {
      this.failLink(link, new Error('Peer connection timed out.'));
    }, this.config.connectionTimeoutMs);
  }
  private bindChannel(link: Link, channel: RTCDataChannel): void {
    if (link.channel || channel.label !== CHANNEL_LABEL || channel.ordered !== true ||
        channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
      channel.close();
      this.failLink(link, new Error('Expected exactly one reliable, ordered LAN Link channel.'));
      return;
    }
    link.channel = channel;
    channel.binaryType = 'arraybuffer';
    link.queue = new ChannelQueue(channel, () => link.pc.sctp?.maxMessageSize, (error) => this.failLink(link, error));
    this.listen(link, channel, 'open', () => this.channelOpened(link));
    this.listen(link, channel, 'close', () => this.failLink(link, new Error('Peer data channel closed.')));
    this.listen(link, channel, 'error', () => this.failLink(link, new Error('Peer data channel failed.')));
    this.listen(link, channel, 'message', (event) => this.receive(link, (event as MessageEvent).data));
    if (channel.readyState === 'open') this.channelOpened(link);
  }
  private channelOpened(link: Link): void {
    if (this.state === 'closed' || link.abort.signal.aborted || link.admitted) return;
    if (this.role === 'host') {
      if (!link.answerUsed) {
        this.failLink(link, new Error('Channel opened without an accepted answer.'));
        return;
      }
      this.admit(link);
      this.syncMembers();
      this.refreshHostState();
    }
    // A guest becomes connected only after the host's membership snapshot.
  }
  private admit(link: Link): void {
    link.admitted = true;
    if (this.pending === link) this.pending = undefined;
    clearTimeout(link.expiryTimer);
    clearTimeout(link.connectionTimer);
    link.expiryTimer = undefined;
    link.connectionTimer = undefined;
  }
  private disposeLink(link: Link): void {
    if (link.abort.signal.aborted) return;
    link.abort.abort();
    clearTimeout(link.expiryTimer);
    clearTimeout(link.connectionTimer);
    clearTimeout(link.disconnectTimer);
    for (const cleanup of link.cleanup) cleanup();
    link.cleanup = [];
    link.queue?.close();
    link.assembler.clear();
    link.channel?.close();
    link.pc.close();
    this.links.delete(link.peerId);
    if (this.pending === link) this.pending = undefined;
  }
  private failLink(link: Link, error: Error): void {
    if (link.abort.signal.aborted || this.state === 'closed') return;
    const admitted = link.admitted;
    this.disposeLink(link);
    this.emit('error', error);
    if (this.role === 'guest') this.close();
    else {
      if (admitted) this.syncMembers();
      this.refreshHostState();
    }
  }
  private setPeers(peers: readonly PeerInfo[]): void {
    const next = Object.freeze(peers.map((peer) => Object.freeze({ ...peer })));
    if (JSON.stringify(next) === JSON.stringify(this.currentPeers)) return;
    for (const peer of this.currentPeers) if (!next.some(item => item.id === peer.id)) this.streams.removePeer(peer.id);
    this.currentPeers = next;
    this.emit('peers', next);
  }
  private syncMembers(): void {
    if (this.syncingMembers) { this.syncAgain = true; return; }
    this.syncingMembers = true;
    try {
      do {
        this.syncAgain = false;
        const guests = this.activeLinks().map((link): PeerInfo => ({ id: link.peerId, role: 'guest' }));
        this.setPeers(guests);
        const frame = encodeMembers([{ id: this.hostId, role: 'host' }, ...guests]);
        for (const link of this.activeLinks()) {
          void link.queue!.enqueue(frame).catch((error) => this.failLink(link, errorOf(error)));
        }
      } while (this.syncAgain && this.state !== 'closed');
    } finally {
      this.syncingMembers = false;
    }
  }
  async createInvitation(): Promise<string> {
    this.assertHost();
    if (this.links.size + 1 >= this.config.maxPeers) throw new Error('Room is full.');
    if (this.pending) throw new Error('Cancel or finish the current invitation before creating another.');
    const pair: PairingPayload = {
      version: 1, kind: 'offer', roomId: this.roomId, hostId: this.hostId,
      peerId: newId(), pairId: newId(), expiresAt: Date.now() + this.config.pairingTimeoutMs, sdp: '',
    };
    const link = this.createLink(pair, pair.peerId);
    this.pending = link;
    try {
      this.listen(link, link.pc, 'datachannel', (event) => {
        (event as RTCDataChannelEvent).channel.close();
        this.failLink(link, new Error('Unexpected additional data channel.'));
      });
      this.bindChannel(link, link.pc.createDataChannel(CHANNEL_LABEL, { ordered: true }));
      const offer = await abortable(link.pc.createOffer(), link.abort.signal);
      await abortable(link.pc.setLocalDescription(offer), link.abort.signal);
      pair.sdp = await completeDescription(link, this.config.connectionTimeoutMs);
      return await abortable(encodePairing(pair), link.abort.signal);
    } catch (error) {
      this.failLink(link, errorOf(error));
      throw error;
    }
  }
  async acceptAnswer(token: string): Promise<void> {
    this.assertHost();
    const link = this.pending;
    if (!link || link.answerUsed) throw new Error('There is no unused invitation.');
    const answer = await abortable(decodePairing(token), link.abort.signal);
    this.assertLive();
    if (this.pending !== link || link.answerUsed || link.abort.signal.aborted) {
      throw new Error('Invitation was already used, cancelled, or expired.');
    }
    const offer = link.pair;
    if (answer.kind !== 'answer' || answer.roomId !== offer.roomId || answer.hostId !== offer.hostId ||
        answer.peerId !== offer.peerId || answer.pairId !== offer.pairId || answer.expiresAt !== offer.expiresAt) {
      throw new Error('Answer does not match the current invitation.');
    }
    link.answerUsed = true;
    clearTimeout(link.expiryTimer);
    link.expiryTimer = undefined;
    this.startConnectionTimer(link);
    this.refreshHostState();
    try {
      await abortable(link.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp }), link.abort.signal);
    } catch (error) {
      this.failLink(link, errorOf(error));
      throw error;
    }
  }
  cancelInvitation(): void {
    this.assertHost();
    if (this.pending) this.disposeLink(this.pending);
    this.refreshHostState();
  }
  async join(offer: PairingPayload): Promise<string> {
    const link = this.createLink(offer, this.hostId);
    try {
      this.listen(link, link.pc, 'datachannel', (event) => {
        this.bindChannel(link, (event as RTCDataChannelEvent).channel);
      });
      await abortable(link.pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp }), link.abort.signal);
      const answer = await abortable(link.pc.createAnswer(), link.abort.signal);
      await abortable(link.pc.setLocalDescription(answer), link.abort.signal);
      const sdp = await completeDescription(link, this.config.connectionTimeoutMs);
      return await abortable(encodePairing({ ...offer, kind: 'answer', sdp }), link.abort.signal);
    } catch (error) {
      this.failLink(link, errorOf(error));
      this.close();
      throw error;
    }
  }
  private receive(link: Link, frame: unknown): void {
    if (this.state === 'closed' || link.abort.signal.aborted) return;
    try {
      const assembled = link.assembler.accept(frame);
      if (assembled === undefined) return;
      const message = decodeFrame(assembled);
      if (this.role === 'guest') {
        if (message.type === 'close') { this.close(); return; }
        if (message.type === 'members') {
          const host = message.peers.find((peer) => peer.id === this.hostId);
          const self = message.peers.find((peer) => peer.id === this.id);
          if (host?.role !== 'host' || self?.role !== 'guest') {
            throw new Error('Host supplied an invalid room membership.');
          }
          this.admit(link);
          this.setPeers(message.peers.filter((peer) => peer.id !== this.id));
          this.setState('connected');
          return;
        }
        if (message.type !== 'deliver' || !link.admitted ||
            !this.peers.some((peer) => peer.id === message.from)) {
          throw new Error('Unexpected message from host.');
        }
        this.deliver(message.from, message.data, message.lane);
        return;
      }
      if (message.type !== 'route' || !link.admitted || message.to === link.peerId) {
        throw new Error('Unexpected message from guest.');
      }
      if (message.to === null || message.to === this.id) {
        this.deliver(link.peerId, message.data, message.lane);
      }
      const targets = message.to === null
        ? this.activeLinks().filter((target) => target !== link)
        : message.to === this.id ? [] : [this.links.get(message.to)].filter(
          (target): target is Link => Boolean(target?.admitted),
        );
      if (message.to !== null && message.to !== this.id && targets.length === 0) {
        this.emit('error', new Error('Message recipient has left the room.'));
        return;
      }
      const delivered = encodeDataFrame({ type: 'deliver', from: link.peerId }, message.data, message.lane);
      for (const target of targets) {
        void target.queue!.enqueue(delivered).catch((error) => this.failLink(target, errorOf(error)));
      }
    } catch (error) {
      this.failLink(link, errorOf(error));
    }
  }
  private deliver(from: string, data: ReceivedData, lane: 'message' | 'stream'): void {
    if (lane === 'stream') this.streams.receive(from, data);
    else this.emit('message', { from, data });
  }
  removePeer(peerId: string): void {
    this.assertHost();
    const link = this.links.get(peerId);
    if (!link?.admitted) throw new Error('Recipient is not a connected peer.');
    this.disposeLink(link); this.syncMembers(); this.refreshHostState();
  }
  async sendStream(peerId: string, source: ReadableStream<Uint8Array>, options?: StreamOptions): Promise<void> {
    this.assertLive();
    if (!this.peers.some(peer => peer.id === peerId)) throw new Error('Recipient is not a connected peer.');
    return this.streams.sendStream(peerId, source, options);
  }
  async send(peerId: string, data: MessageData): Promise<void> {
    this.assertLive();
    if (!validId(peerId) || !this.peers.some((peer) => peer.id === peerId)) {
      throw new Error('Recipient is not a connected peer.');
    }
    return this.sendData(peerId, data);
  }
  async broadcast(data: MessageData): Promise<void> {
    this.assertLive();
    if (this.state !== 'connected') throw new Error('Room has no connected peers.');
    return this.sendData(null, data);
  }
  private async sendData(to: string | null, data: MessageData, lane: 'message' | 'stream' = 'message'): Promise<void> {
    const snapshot = snapshotData(data);
    const targets = this.role === 'guest' ? [this.links.get(this.hostId)!]
      : to === null ? this.activeLinks() : [this.links.get(to)!];
    for (const link of targets) {
      if (!link?.admitted || !link.queue) throw new Error('Peer is disconnected.');
    }
    const signals = [this.abort.signal, ...targets.map((link) => link.abort.signal)];
    const task = this.outgoing.then(async () => {
      this.assertLive();
      if (signals.some((signal) => signal.aborted)) throw new Error('Peer is disconnected.');
      const frame = encodeDataFrame(
        this.role === 'host' ? { type: 'deliver', from: this.id } : { type: 'route', to }, snapshot, lane,
      );
      await Promise.all(targets.map((link) => abortable(link.queue!.enqueue(frame), ...signals)));
    });
    const result = abortable(task, ...signals);
    this.outgoing = result.catch(() => {});
    return result;
  }
  close(): void {
    if (this.state === 'closed') return;
    // Closing a host ends the room; guests never migrate the host role.
    this.streams.close();
    this.abort.abort();
    this.currentState = 'closed';
    for (const link of [...this.links.values()]) this.disposeLink(link);
    this.setPeers([]);
    this.emit('state', 'closed');
    this.listeners.clear();
  }
}

export function createHost(options: RoomOptions = {}): LanRoom {
  return new Room(options);
}

export async function joinRoom(
  token: string, options: RoomOptions = {},
): Promise<{ room: LanRoom; answer: string }> {
  const { signal } = options;
  const cancelled = () => new DOMException('Pairing was cancelled.', 'AbortError');
  if (signal?.aborted) throw cancelled();
  let offer: PairingPayload;
  try {
    offer = await (signal ? abortable(decodePairing(token), signal) : decodePairing(token));
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw error;
  }
  if (signal?.aborted) throw cancelled();
  if (offer.kind !== 'offer') throw new Error('Joining requires an invitation, not an answer.');
  if (offer.hostId === offer.peerId) throw new Error('Host and guest identities must differ.');
  const room = new Room(options, offer);
  const cancel = () => room.close();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) throw cancelled();
    const answer = await room.join(offer);
    if (signal?.aborted) throw cancelled();
    return { room, answer };
  } catch (error) {
    room.close();
    if (signal?.aborted) throw cancelled();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
