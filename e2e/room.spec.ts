import { expect, test, type Page } from '@playwright/test';
import type { LanRoom } from '../src/index.ts';

type CapturedMessage = {
  from: string;
  data: { kind: 'text'; value: string } | { kind: 'binary'; value: number[] };
};

type BrowserHarness = {
  room: LanRoom;
  messages: CapturedMessage[];
  peerEvents: string[][];
  errors: string[];
};

type TestGlobal = typeof globalThis & { __lanLinkTest: BrowserHarness };

// Only the test injects this harness. Production code exposes no room on window.
// Tokens are exchanged by the test as QR payloads; these tests exercise real
// RTCPeerConnection/DataChannel instances, not physical cameras or LAN devices.
async function initialize(page: Page, offer?: string): Promise<string | undefined> {
  await page.goto('./');
  return page.evaluate(async (invitation) => {
    const modulePath = '/dist/index.js';
    const api = await import(/* @vite-ignore */ modulePath) as typeof import('../src/index.ts');
    const joined = invitation ? await api.joinRoom(invitation) : undefined;
    const room = joined?.room ?? api.createHost();
    const harness: BrowserHarness = { room, messages: [], peerEvents: [], errors: [] };
    (globalThis as TestGlobal).__lanLinkTest = harness;
    room.on('message', ({ from, data }) => {
      harness.messages.push({
        from,
        data: typeof data === 'string'
          ? { kind: 'text', value: data }
          : { kind: 'binary', value: Array.from(new Uint8Array(data)) },
      });
    });
    room.on('peers', (peers) => harness.peerEvents.push(peers.map((peer) => peer.id).sort()));
    room.on('error', (error) => harness.errors.push(error.message));
    return joined?.answer;
  }, offer);
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const { room, messages, peerEvents, errors } = (globalThis as TestGlobal).__lanLinkTest;
    return {
      id: room.id,
      hostId: room.hostId,
      roomId: room.roomId,
      role: room.role,
      state: room.state,
      peers: room.peers.map((peer) => ({ ...peer })),
      messages: [...messages],
      peerEvents: [...peerEvents],
      errors: [...errors],
    };
  });
}

async function connect(host: Page, guest: Page): Promise<{ offer: string; answer: string }> {
  const offer = await host.evaluate(() => (globalThis as TestGlobal).__lanLinkTest.room.createInvitation());
  expect(offer).toMatch(/^LAN1:/);
  const answer = await initialize(guest, offer);
  expect(answer).toMatch(/^LAN1:/);
  await host.evaluate((token) => (globalThis as TestGlobal).__lanLinkTest.room.acceptAnswer(token), answer!);
  await expect.poll(async () => (await snapshot(host)).state).toBe('connected');
  await expect.poll(async () => (await snapshot(guest)).state).toBe('connected');
  return { offer, answer: answer! };
}

async function expectPeers(page: Page, ids: string[]): Promise<void> {
  await expect.poll(async () => (await snapshot(page)).peers.map((peer) => peer.id).sort()).toEqual([...ids].sort());
}

async function messages(page: Page): Promise<CapturedMessage[]> {
  return (await snapshot(page)).messages;
}

test.afterEach(async ({ context }) => {
  await Promise.all(context.pages().map((page) => page.evaluate(() => {
    (globalThis as Partial<TestGlobal>).__lanLinkTest?.room.close();
  }).catch(() => {})));
});

test('two real browser peers exchange text and binary with stable sender identity', async ({ page: host, context }) => {
  const guest = await context.newPage();
  await initialize(host);
  expect((await snapshot(host)).state).toBe('waiting');
  await connect(host, guest);
  const hostInfo = await snapshot(host);
  const guestInfo = await snapshot(guest);
  expect(hostInfo.role).toBe('host');
  expect(guestInfo.role).toBe('guest');
  expect(hostInfo.id).not.toBe(guestInfo.id);
  expect(guestInfo.hostId).toBe(hostInfo.id);
  expect(hostInfo.hostId).toBe(hostInfo.id);
  expect(guestInfo.roomId).toBe(hostInfo.roomId);
  await expectPeers(host, [guestInfo.id]);
  await expectPeers(guest, [hostInfo.id]);
  expect((await snapshot(guest)).peers).toEqual([{ id: hostInfo.id, role: 'host' }]);

  await host.evaluate(async (peerId) => {
    const { room } = (globalThis as TestGlobal).__lanLinkTest;
    await room.send(peerId, '房主 → 成员：你好 🌏');
    await room.send(peerId, new Uint8Array([0, 1, 127, 128, 255]).buffer);
  }, guestInfo.id);
  await guest.evaluate(async (peerId) => {
    const { room } = (globalThis as TestGlobal).__lanLinkTest;
    await room.send(peerId, '成员 → 房主：已收到 ✅');
    // A view with an offset must not accidentally transmit its whole buffer.
    await room.send(peerId, new Uint8Array([99, 4, 0, 255, 88]).subarray(1, 4));
  }, hostInfo.id);
  await expect.poll(() => messages(guest)).toEqual([
    { from: hostInfo.id, data: { kind: 'text', value: '房主 → 成员：你好 🌏' } },
    { from: hostInfo.id, data: { kind: 'binary', value: [0, 1, 127, 128, 255] } },
  ]);
  await expect.poll(() => messages(host)).toEqual([
    { from: guestInfo.id, data: { kind: 'text', value: '成员 → 房主：已收到 ✅' } },
    { from: guestInfo.id, data: { kind: 'binary', value: [4, 0, 255] } },
  ]);
  expect((await snapshot(host)).errors).toEqual([]);
  expect((await snapshot(guest)).errors).toEqual([]);
});

test('three peers synchronize membership and route guest messages without reflecting broadcasts', async ({ page: host, context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await initialize(host);
  await connect(host, first);
  await connect(host, second);
  const hostId = (await snapshot(host)).id;
  const firstId = (await snapshot(first)).id;
  const secondId = (await snapshot(second)).id;
  await expectPeers(host, [firstId, secondId]);
  await expectPeers(first, [hostId, secondId]);
  await expectPeers(second, [hostId, firstId]);

  await first.evaluate(async (peerId) => {
    await (globalThis as TestGlobal).__lanLinkTest.room.send(peerId, '只发给第二个成员');
  }, secondId);
  await expect.poll(() => messages(second)).toEqual([
    { from: firstId, data: { kind: 'text', value: '只发给第二个成员' } },
  ]);
  expect(await messages(host)).toEqual([]);
  expect(await messages(first)).toEqual([]);

  await first.evaluate(() => (globalThis as TestGlobal).__lanLinkTest.room.broadcast('成员广播'));
  await expect.poll(() => messages(host)).toEqual([
    { from: firstId, data: { kind: 'text', value: '成员广播' } },
  ]);
  await expect.poll(() => messages(second)).toEqual([
    { from: firstId, data: { kind: 'text', value: '只发给第二个成员' } },
    { from: firstId, data: { kind: 'text', value: '成员广播' } },
  ]);
  expect(await messages(first)).toEqual([]);

  await host.evaluate(() => (globalThis as TestGlobal).__lanLinkTest.room.broadcast('房主广播'));
  await expect.poll(() => messages(first)).toEqual([
    { from: hostId, data: { kind: 'text', value: '房主广播' } },
  ]);
  await expect.poll(async () => (await messages(second)).at(-1)).toEqual({
    from: hostId, data: { kind: 'text', value: '房主广播' },
  });
  expect((await messages(host)).length).toBe(1);

  await second.evaluate(() => (globalThis as TestGlobal).__lanLinkTest.room.close());
  expect((await snapshot(second)).state).toBe('closed');
  expect((await snapshot(second)).peers).toEqual([]);
  await expectPeers(host, [firstId]);
  await expectPeers(first, [hostId]);
  expect((await snapshot(host)).peerEvents).toContainEqual([firstId, secondId].sort());
  expect((await snapshot(first)).peerEvents).toContainEqual([hostId, secondId].sort());
  await first.evaluate((peerId) => (globalThis as TestGlobal).__lanLinkTest.room.send(peerId, '离开后仍可通信'), hostId);
  await expect.poll(async () => (await messages(host)).at(-1)).toEqual({
    from: firstId, data: { kind: 'text', value: '离开后仍可通信' },
  });
});

test('invalid and cancelled answers preserve existing peers; closing ends the room', async ({ page: host, context }) => {
  const activeGuest = await context.newPage();
  const pendingGuest = await context.newPage();
  await initialize(host);
  const accepted = await connect(host, activeGuest);
  const hostId = (await snapshot(host)).id;
  const activeId = (await snapshot(activeGuest)).id;
  const pendingOffer = await host.evaluate(() => (globalThis as TestGlobal).__lanLinkTest.room.createInvitation());
  const pendingAnswer = await initialize(pendingGuest, pendingOffer);

  for (const invalidAnswer of ['not-a-pairing-code', accepted.answer]) {
    const failure = await host.evaluate(async (token) => {
      try {
        await (globalThis as TestGlobal).__lanLinkTest.room.acceptAnswer(token);
        return null;
      } catch (error) {
        return String(error);
      }
    }, invalidAnswer);
    expect(failure).toBeTruthy();
    expect((await snapshot(host)).state).toBe('connected');
    await expectPeers(host, [activeId]);
  }

  await host.evaluate(() => (globalThis as TestGlobal).__lanLinkTest.room.cancelInvitation());
  const cancelledFailure = await host.evaluate(async (token) => {
    try {
      await (globalThis as TestGlobal).__lanLinkTest.room.acceptAnswer(token);
      return null;
    } catch (error) {
      return String(error);
    }
  }, pendingAnswer!);
  expect(cancelledFailure).toBeTruthy();
  await activeGuest.evaluate((peerId) => (globalThis as TestGlobal).__lanLinkTest.room.send(peerId, '取消不影响已连接成员'), hostId);
  await expect.poll(() => messages(host)).toEqual([
    { from: activeId, data: { kind: 'text', value: '取消不影响已连接成员' } },
  ]);

  // A fresh invitation is possible after cancellation, and closing also
  // disposes that pending invitation without waiting for its expiry timer.
  const freshOffer = await host.evaluate(() => (globalThis as TestGlobal).__lanLinkTest.room.createInvitation());
  expect(freshOffer).toMatch(/^LAN1:/);
  await host.evaluate(() => {
    const { room } = (globalThis as TestGlobal).__lanLinkTest;
    room.close();
    room.close();
  });
  expect((await snapshot(host)).state).toBe('closed');
  expect((await snapshot(host)).peers).toEqual([]);
  await expect.poll(async () => (await snapshot(activeGuest)).state).toBe('closed');
  expect((await snapshot(activeGuest)).peers).toEqual([]);
  const operations = await host.evaluate(async (peerId) => {
    const { room } = (globalThis as TestGlobal).__lanLinkTest;
    return (await Promise.allSettled([
      room.send(peerId, '不能发送'),
      room.broadcast('不能广播'),
      room.createInvitation(),
    ])).map((result) => result.status);
  }, activeId);
  expect(operations).toEqual(['rejected', 'rejected', 'rejected']);
});

test('large messages and pull-controlled streams preserve content in real browsers', async ({ page: host, context }) => {
  await initialize(host); const guest = await context.newPage(); await connect(host, guest);
  const guestId = (await snapshot(guest)).id; const payload = '大消息🌍'.repeat(9000);
  await host.evaluate(({ to, data }) => (globalThis as TestGlobal).__lanLinkTest.room.send(to, data), { to: guestId, data: payload });
  await expect.poll(async () => (await messages(guest))[0]?.data).toEqual({ kind: 'text', value: payload });
  await guest.evaluate(() => {
    (globalThis as any).__streamResult = null;
    (globalThis as TestGlobal).__lanLinkTest.room.on('stream', incoming => {
      void (async () => {
        const reader = incoming.stream.getReader(); let size = 0; let correct = true; let maxChunk = 0;
        for (;;) { const part = await reader.read(); if (part.done) break; maxChunk = Math.max(maxChunk, part.value.length);
          for (const byte of part.value) { if (byte !== size % 251) correct = false; size++; }
          await new Promise(resolve => setTimeout(resolve, 8));
        }
        (globalThis as any).__streamResult = { size, correct, maxChunk, metadata: incoming.metadata };
      })();
    });
  });
  await host.evaluate(async to => {
    const bytes = Uint8Array.from({ length: 1024 * 1024 + 7 }, (_, n) => n % 251);
    await (globalThis as TestGlobal).__lanLinkTest.room.sendStream(to, new Blob([bytes]).stream(), { totalBytes: bytes.length, metadata: 'business-defined' });
  }, guestId);
  await expect.poll(() => guest.evaluate(() => (globalThis as any).__streamResult)).toMatchObject({ size: 1024 * 1024 + 7, correct: true, metadata: 'business-defined' });
  expect(await guest.evaluate(() => (globalThis as any).__streamResult.maxChunk)).toBeLessThanOrEqual(256 * 1024);
});
