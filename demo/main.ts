import QRCode from 'qrcode';
import { createHost, joinRoom, type LanRoom } from 'lan-link';
import { decodeQrImage, QrScanner } from 'lan-link/scanner';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}

const ui = {
  setup: element('setup'),
  status: element('connection-status'),
  create: element<HTMLButtonElement>('create-room'),
  join: element<HTMLButtonElement>('join-room'),
  home: element<HTMLAnchorElement>('home-link'),
  error: element('error-notice'),
  errorMessage: element('error-message'),
  roomSection: element('room-section'),
  roomHeading: element('room-heading'),
  roomDescription: element('room-description'),
  roomNote: element('room-note'),
  peers: element('peer-list'),
  leave: element<HTMLButtonElement>('leave-room'),
  add: element<HTMLButtonElement>('add-peer'),
  pairing: element('pairing-section'),
  pairingHeading: element('pairing-heading'),
  pairingDescription: element('pairing-description'),
  pairingStatus: element('pairing-status'),
  cancel: element<HTMLButtonElement>('cancel-pairing'),
  codePanel: element('code-panel'),
  codeHeading: element('code-heading'),
  codeLoading: element('code-loading'),
  codeFigure: element('code-figure'),
  code: element<HTMLCanvasElement>('pairing-code'),
  codeCaption: element('code-caption'),
  save: element<HTMLAnchorElement>('save-code'),
  outputDetails: element<HTMLDetailsElement>('output-details'),
  output: element<HTMLTextAreaElement>('pairing-output'),
  copy: element<HTMLButtonElement>('copy-code'),
  copyStatus: element('copy-status'),
  receive: element('receive-panel'),
  receiveHeading: element('receive-heading'),
  receiveDescription: element('receive-description'),
  scan: element<HTMLButtonElement>('start-scan'),
  import: element<HTMLButtonElement>('import-code'),
  file: element<HTMLInputElement>('code-file'),
  cameraNote: element('camera-note'),
  scannerPanel: element('scanner-panel'),
  scannerStatus: element('scanner-status'),
  video: element<HTMLVideoElement>('scanner-video'),
  input: element<HTMLTextAreaElement>('pairing-input'),
  pairingForm: element<HTMLFormElement>('pairing-form'),
  submitPairing: element<HTMLButtonElement>('submit-pairing'),
  messages: element('messages-section'),
  messageForm: element<HTMLFormElement>('message-form'),
  message: element<HTMLTextAreaElement>('message-input'),
  target: element<HTMLSelectElement>('message-target'),
  type: element<HTMLSelectElement>('message-type'),
  size: element('message-size'),
  send: element<HTMLButtonElement>('send-message'),
  log: element('message-log'),
  logEmpty: element('log-empty'),
};

type PairingMode = 'host-offer' | 'host-connecting' | 'guest-offer' | 'guest-answer' | null;
const scanner = new QrScanner(ui.video);
const encoder = new TextEncoder();
let room: LanRoom | null = null;
let subscriptions: (() => void)[] = [];
let pairingMode: PairingMode = null;
let generation = 0;
let scanGeneration = 0;
let busy = false;
let sending = false;
let joinAbort: AbortController | null = null;
let baselinePeers = new Set<string>();

function shortId(id: string): string { return id.slice(0, 8); }

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/[\u3400-\u9fff]/u.test(message)) return message;
  if (/expired|cancelled|no unused invitation/i.test(message)) return '配对码已过期或已使用。请取消本次配对，由房主重新生成邀请码。';
  if (/does not match|Joining requires/i.test(message)) return '这不是当前步骤需要的配对码。请确认邀请码与应答码来自同一次配对，再重新扫描。';
  if (/Room is full/i.test(message)) return '房间已满，最多支持 8 台设备。请先让一台设备离开，再重新邀请。';
  if (/timed out|failed|did not recover/i.test(message)) return '设备未能建立或保持连接。请确认在同一局域网、未开启设备隔离，再重新配对。';
  if (/closed|disconnected|left the room|not a connected peer|no connected peers/i.test(message)) return '连接已断开或对方已离开。请确认设备在线，重新配对后再发送。';
  if (/RTCPeerConnection|not supported/i.test(message)) return '当前浏览器不支持此连接方式，请使用新版 Safari 或 Chrome。';
  return '操作未完成。请检查连接并重试；配对失败时，可取消后重新生成二维码。';
}

function showError(error: unknown): void {
  ui.errorMessage.textContent = friendlyError(error);
  ui.error.hidden = false;
}

function clearError(): void { ui.error.hidden = true; ui.errorMessage.textContent = ''; }

function stopScanner(): void {
  scanGeneration += 1;
  scanner.stop();
  ui.scannerPanel.hidden = true;
  ui.scan.disabled = busy;
}

function clearCode(): void {
  ui.codeFigure.hidden = true;
  ui.save.hidden = true;
  ui.save.removeAttribute('href');
  ui.output.value = '';
  ui.copyStatus.textContent = '';
  ui.outputDetails.open = false;
}

function setBusy(value: boolean): void {
  busy = value;
  ui.scan.disabled = value;
  ui.import.disabled = value;
  ui.submitPairing.disabled = value;
  ui.input.disabled = value;
  ui.create.disabled = value;
  ui.join.disabled = value;
}

function updateSendState(): void {
  const bytes = encoder.encode(ui.message.value).byteLength;
  ui.size.textContent = `${bytes.toLocaleString('en-US')} 字节 · 自动分块传输`;
  ui.send.disabled = sending || !room || room.state !== 'connected' || !room.peers.length || !bytes;
  ui.send.textContent = sending ? '正在发送…' : '发送';
}

function renderRoom(): void {
  ui.setup.hidden = Boolean(room) || pairingMode !== null;
  ui.roomSection.hidden = !room;
  ui.messages.hidden = !room;
  ui.add.hidden = !room || room.role !== 'host' || room.state === 'closed' || pairingMode !== null;
  if (!room) {
    ui.status.textContent = pairingMode === 'guest-offer' ? '等待扫描邀请码' : '尚未连接';
    ui.status.dataset.connected = 'false';
    updateSendState();
    return;
  }
  const stateText = { waiting: '等待设备加入', connecting: '正在建立连接', connected: '已连接', closed: '连接已结束' };
  ui.status.textContent = room.state === 'connected' ? `已连接 ${room.peers.length + 1} 台设备` : stateText[room.state];
  ui.status.dataset.connected = String(room.state === 'connected');
  ui.roomHeading.textContent = room.role === 'host' ? '你是房主'
    : room.state === 'connected' ? '已加入房间'
      : room.state === 'closed' ? '房间连接已结束' : '正在加入房间';
  ui.roomDescription.textContent = `房间 ${shortId(room.roomId)} · 本机 ${shortId(room.id)}`;
  ui.leave.textContent = room.state === 'closed' ? '重新开始' : '离开房间';
  ui.roomNote.textContent = room.state === 'closed'
    ? '房间连接已经结束。点击“重新开始”即可再次配对。'
    : room.role === 'host'
      ? '请保持此页打开。房主离开后，所有设备之间的连接都会断开。'
      : '设备间的数据由房主转发。房主离开后，需要重新创建房间。';

  const members = [{ id: room.id, role: room.role }, ...room.peers.filter((peer) => peer.id !== room!.id)];
  ui.peers.replaceChildren(...members.map((peer) => {
    const item = document.createElement('li');
    item.textContent = `${peer.role === 'host' ? '房主' : '设备'} ${shortId(peer.id)}`;
    if (peer.id === room!.id) {
      const self = document.createElement('small');
      self.textContent = '本机';
      item.append(self);
    }
    return item;
  }));
  const previousTarget = ui.target.value;
  const everyone = document.createElement('option');
  everyone.value = '*';
  everyone.textContent = '所有其他设备';
  ui.target.replaceChildren(everyone, ...room.peers.filter((peer) => peer.id !== room!.id).map((peer) => {
    const option = document.createElement('option');
    option.value = peer.id;
    option.textContent = `${peer.role === 'host' ? '房主' : '设备'} ${shortId(peer.id)}`;
    return option;
  }));
  if ([...ui.target.options].some((option) => option.value === previousTarget)) ui.target.value = previousTarget;
  updateSendState();
}

function hidePairing(): void {
  generation += 1;
  joinAbort?.abort();
  joinAbort = null;
  pairingMode = null;
  setBusy(false);
  stopScanner();
  ui.pairing.hidden = true;
  ui.input.value = '';
  clearCode();
  renderRoom();
}

function completePairingIfConnected(): void {
  if (!room) return;
  if ((pairingMode === 'guest-answer' && room.state === 'connected') ||
      (pairingMode === 'host-connecting' && room.peers.some((peer) => !baselinePeers.has(peer.id)))) {
    hidePairing();
  }
}

function appendLog(direction: string, peer: string, data: string | ArrayBuffer): void {
  const entry = document.createElement('li');
  const metadata = document.createElement('span');
  metadata.className = 'log-meta';
  const size = typeof data === 'string' ? encoder.encode(data).byteLength : data.byteLength;
  metadata.textContent = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · ${direction} ${peer} · ${typeof data === 'string' ? '文本' : '二进制'} · ${size.toLocaleString('en-US')} 字节`;
  const content = document.createElement('pre');
  if (typeof data === 'string') content.textContent = data.length > 1200 ? `${data.slice(0, 1200)}\n…（仅展示前 1,200 个字符）` : data;
  else {
    content.className = 'binary-data';
    const bytes = new Uint8Array(data);
    content.textContent = [...bytes.subarray(0, 48)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ') + (bytes.length > 48 ? ' …' : '');
  }
  entry.append(metadata, content);
  ui.log.prepend(entry);
  while (ui.log.children.length > 100) ui.log.lastElementChild?.remove();
  ui.logEmpty.hidden = true;
}

function attachRoom(nextRoom: LanRoom): void {
  room = nextRoom;
  subscriptions = [
    nextRoom.on('state', () => {
      if (room !== nextRoom) return;
      if (nextRoom.state === 'closed') hidePairing();
      completePairingIfConnected();
      renderRoom();
    }),
    nextRoom.on('peers', () => {
      if (room !== nextRoom) return;
      completePairingIfConnected();
      renderRoom();
    }),
    nextRoom.on('message', ({ from, data }) => appendLog('收到', shortId(from), data)),
    nextRoom.on('error', (error) => {
      if (room !== nextRoom) return;
      showError(error);
      if (pairingMode === 'host-connecting' && /timed out|failed|closed|expired/i.test(error.message)) hidePairing();
      renderRoom();
    }),
  ];
  renderRoom();
}

function reset(): void {
  generation += 1;
  subscriptions.forEach((unsubscribe) => unsubscribe());
  subscriptions = [];
  room?.close();
  room = null;
  hidePairing();
  ui.log.replaceChildren();
  ui.logEmpty.hidden = false;
  ui.message.value = '';
  clearError();
  renderRoom();
}

async function displayCode(text: string, expectedGeneration: number): Promise<void> {
  ui.output.value = text;
  ui.copyStatus.textContent = '';
  const canvas = document.createElement('canvas');
  try {
    await QRCode.toCanvas(canvas, text, {
      errorCorrectionLevel: 'M', margin: 4, scale: 6,
      color: { dark: '#082b3aff', light: '#ffffffff' },
    });
    if (generation !== expectedGeneration) return;
    ui.code.width = canvas.width;
    ui.code.height = canvas.height;
    ui.code.getContext('2d')!.drawImage(canvas, 0, 0);
    ui.save.href = canvas.toDataURL('image/png');
    ui.save.hidden = false;
    ui.codeFigure.hidden = false;
  } catch {
    if (generation !== expectedGeneration) return;
    ui.outputDetails.open = true;
    throw new Error('连接信息无法生成单张二维码。请先使用配对文本；也可关闭多余的网络或 VPN 后重新配对。');
  } finally {
    if (generation === expectedGeneration) ui.codeLoading.hidden = true;
  }
}

async function createInvitation(): Promise<void> {
  const current = room;
  if (!current || current.role !== 'host' || pairingMode !== null) return;
  clearError();
  stopScanner();
  clearCode();
  pairingMode = 'host-offer';
  baselinePeers = new Set(current.peers.map((peer) => peer.id));
  const expectedGeneration = ++generation;
  ui.pairing.hidden = false;
  ui.cancel.hidden = false;
  ui.pairingHeading.textContent = '邀请一台设备';
  ui.pairingDescription.textContent = '一次只配对一台。完成连接后，可以继续邀请下一台设备。';
  ui.codePanel.hidden = false;
  ui.codeHeading.textContent = '1. 让对方扫描邀请码';
  ui.codeLoading.hidden = false;
  ui.codeCaption.textContent = '让加入设备点击“加入房间”扫描此码。二维码三分钟内有效，且只能使用一次。';
  ui.receive.hidden = false;
  ui.receiveHeading.textContent = '2. 扫描对方的应答码';
  ui.receiveDescription.textContent = '对方扫描后会显示应答码，再用这台设备扫描一次。';
  ui.pairingStatus.textContent = '正在收集本机连接信息，请稍候…';
  setBusy(true);
  renderRoom();
  try {
    const invitation = await current.createInvitation();
    if (generation !== expectedGeneration || room !== current) return;
    ui.pairingStatus.textContent = '邀请码已就绪，等待对方扫描。';
    await displayCode(invitation, expectedGeneration);
  } catch (error) {
    if (generation !== expectedGeneration) return;
    showError(error);
    if (!ui.output.value) {
      current.cancelInvitation();
      hidePairing();
    }
  } finally {
    if (generation === expectedGeneration) {
      ui.codeLoading.hidden = true;
      setBusy(false);
    }
  }
}

function beginJoin(): void {
  clearError();
  pairingMode = 'guest-offer';
  generation += 1;
  ui.pairing.hidden = false;
  ui.cancel.hidden = false;
  ui.pairingHeading.textContent = '加入房间';
  ui.pairingDescription.textContent = '先扫描房主的邀请码，再让房主扫描这台设备的应答码。';
  ui.codePanel.hidden = true;
  ui.receive.hidden = false;
  ui.receiveHeading.textContent = '1. 扫描房主的邀请码';
  ui.receiveDescription.textContent = '房主点击“创建房间”后，会显示邀请码。';
  ui.pairingStatus.textContent = '准备好后，打开相机或导入二维码图片。';
  renderRoom();
}

async function receivePairing(text: string): Promise<void> {
  if (busy || (pairingMode !== 'host-offer' && pairingMode !== 'guest-offer')) return;
  if (!text.trim()) { showError(new Error('请先扫描二维码，或粘贴对方的完整配对文本。')); return; }
  const mode = pairingMode;
  const current = room;
  const expectedGeneration = generation;
  const joining = mode === 'guest-offer' ? new AbortController() : null;
  if (joining) joinAbort = joining;
  clearError();
  stopScanner();
  setBusy(true);
  ui.pairingStatus.textContent = '正在读取配对信息…';
  try {
    if (mode === 'host-offer') {
      if (!current) return;
      await current.acceptAnswer(text.trim());
      if (generation !== expectedGeneration || room !== current) return;
      pairingMode = 'host-connecting';
      ui.codePanel.hidden = true;
      ui.receive.hidden = true;
      ui.cancel.hidden = true;
      ui.pairingHeading.textContent = '正在连接新设备';
      ui.pairingDescription.textContent = '双方配对信息已交换，请保持两个页面打开。';
      ui.pairingStatus.textContent = '应答已接收，正在建立数据通道…';
      completePairingIfConnected();
    } else {
      const result = await joinRoom(text.trim(), { signal: joining!.signal });
      if (generation !== expectedGeneration) { result.room.close(); return; }
      pairingMode = 'guest-answer';
      attachRoom(result.room);
      ui.codePanel.hidden = false;
      ui.codeHeading.textContent = '2. 请房主扫描这个应答码';
      ui.codeCaption.textContent = '将屏幕朝向房主设备，房主扫描后即可完成配对。';
      ui.codeLoading.hidden = false;
      ui.receive.hidden = true;
      ui.pairingHeading.textContent = '还差最后一次扫描';
      ui.pairingDescription.textContent = '请保持此页打开，让房主扫描下面的应答码。';
      ui.pairingStatus.textContent = '等待房主扫描应答码…';
      await displayCode(result.answer, expectedGeneration);
      completePairingIfConnected();
    }
  } catch (error) {
    if (generation !== expectedGeneration) return;
    showError(error);
    ui.pairingStatus.textContent = pairingMode === 'guest-answer'
      ? '可展开“查看本机配对文本”，将完整文本交给房主完成配对。'
      : mode === 'host-offer'
        ? '请重新扫描应答码；邀请码过期时，取消本次配对后重新邀请。'
        : '请重新扫描邀请码；邀请码过期时，请房主重新生成。';
  } finally {
    if (joinAbort === joining) joinAbort = null;
    if (generation === expectedGeneration) { setBusy(false); renderRoom(); }
  }
}

ui.create.addEventListener('click', () => {
  try { clearError(); attachRoom(createHost()); void createInvitation(); }
  catch (error) { showError(error); }
});
ui.join.addEventListener('click', beginJoin);
ui.add.addEventListener('click', () => { void createInvitation(); });
ui.cancel.addEventListener('click', () => {
  if (room?.role === 'host') { room.cancelInvitation(); hidePairing(); clearError(); }
  else reset();
});
ui.leave.addEventListener('click', () => {
  if (room?.role === 'host' && room.peers.length && !window.confirm('离开后，所有设备的连接都会断开。确定离开房间？')) return;
  reset();
});
ui.home.addEventListener('click', (event) => {
  if (room?.role === 'host' && room.peers.length && !window.confirm('返回主页会断开所有设备的连接。确定返回？')) {
    event.preventDefault();
    return;
  }
  reset();
});
element('dismiss-error').addEventListener('click', clearError);
element('stop-scan').addEventListener('click', stopScanner);
ui.scan.addEventListener('click', async () => {
  clearError();
  const expectedGeneration = generation;
  const expectedScanGeneration = ++scanGeneration;
  ui.scannerPanel.hidden = false;
  ui.scannerStatus.textContent = '正在打开相机…';
  ui.scan.disabled = true;
  try {
    const opened = await scanner.start((value) => {
      if (generation !== expectedGeneration || scanGeneration !== expectedScanGeneration) return;
      ui.scannerPanel.hidden = true;
      void receivePairing(value);
    }, (error) => {
      if (generation !== expectedGeneration || scanGeneration !== expectedScanGeneration) return;
      stopScanner();
      showError(error);
    });
    if (generation !== expectedGeneration || scanGeneration !== expectedScanGeneration) return;
    if (opened) ui.scannerStatus.textContent = '将对方的完整二维码放入画面';
    else stopScanner();
  } catch (error) {
    if (generation !== expectedGeneration || scanGeneration !== expectedScanGeneration) return;
    stopScanner();
    showError(error);
  }
});
ui.import.addEventListener('click', () => { stopScanner(); ui.file.click(); });
ui.file.addEventListener('change', async () => {
  const file = ui.file.files?.[0];
  ui.file.value = '';
  if (!file || busy) return;
  const expectedGeneration = generation;
  setBusy(true);
  clearError();
  try {
    const text = await decodeQrImage(file);
    if (generation !== expectedGeneration) return;
    setBusy(false);
    await receivePairing(text);
  } catch (error) {
    if (generation === expectedGeneration) showError(error);
  } finally {
    if (generation === expectedGeneration) setBusy(false);
  }
});
ui.pairingForm.addEventListener('submit', (event) => { event.preventDefault(); void receivePairing(ui.input.value); });
ui.copy.addEventListener('click', async () => {
  if (!ui.output.value) return;
  try {
    await navigator.clipboard.writeText(ui.output.value);
    ui.copyStatus.textContent = '已复制，可粘贴到对方设备。';
  } catch {
    ui.output.focus();
    ui.output.select();
    ui.copyStatus.textContent = '无法自动复制。已选中配对文本，请使用系统的“复制”。';
  }
});
ui.message.addEventListener('input', updateSendState);
ui.messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (ui.send.disabled || !room) return;
  const current = room;
  const text = ui.message.value;
  const target = ui.target.value;
  const data = ui.type.value === 'binary' ? encoder.encode(text).buffer : text;
  sending = true;
  updateSendState();
  clearError();
  try {
    if (target === '*') await current.broadcast(data);
    else await current.send(target, data);
    if (room !== current) return;
    appendLog('已提交发送至', target === '*' ? '所有其他设备' : shortId(target), data);
    if (ui.message.value === text) ui.message.value = '';
  } catch (error) { if (room === current) showError(error); }
  finally { sending = false; updateSendState(); }
});
element('clear-log').addEventListener('click', () => { ui.log.replaceChildren(); ui.logEmpty.hidden = false; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopScanner();
});
window.addEventListener('pagehide', reset);
window.addEventListener('beforeunload', (event) => {
  if (!room || room.state === 'closed' || !room.peers.length) return;
  event.preventDefault();
  event.returnValue = '';
});
if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
  ui.cameraNote.textContent = '当前地址无法使用相机。可导入二维码图片或使用下方配对文本；使用相机需 HTTPS 或 localhost。';
}
renderRoom();
