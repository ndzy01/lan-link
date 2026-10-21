# lan-link

业务无关的浏览器 WebRTC 通信模块。两台或多台设备在同一局域网内，通过**双方各扫一次**交换连接信息，无需信令服务器、STUN 或 TURN。业务内容只通过 DataChannel 传输。

核心模块不依赖界面框架；扫码工具通过 `lan-link/scanner` 单独导出。仓库包含移动端优先的演示页，不包含业务界面或数据存储。

## 配对与多设备

1. A 创建房间，生成本次邀请二维码。
2. B 在演示页选择加入，扫描 A 的邀请，生成应答二维码。
3. A 扫描 B 的应答，双方等待连接成功。
4. 添加 C 时，A 生成新的邀请，与 C 再互扫一次。

邀请默认 3 分钟有效，只供一台设备使用。二维码承载连接信息，不是可用系统相机直接打开的网页链接；双方先打开演示页，再使用页内扫码。也支持导入二维码图片和手动交换配对文本。

房间采用星形结构。房主分别与成员建立连接，成员之间的单发和广播由房主转发。默认房间上限 8 台设备（含房主），可配置；这不是已验收的性能容量。房主必须保持在线，退出会关闭整个房间。普通成员离开不影响其他成员。断开后重新配对，不实现房主迁移或自动重连。

同一 Wi-Fi 不代表设备一定互通：访客网络、客户端隔离、VPN、防火墙和浏览器网络权限可能阻断连接。没有中继兜底时，连接失败会通过状态和错误事件报告。

## 业务接入

通过 npm 版本依赖接入：

```sh
pnpm add lan-link@0.1.0
```

包根入口和 `lan-link/scanner` 均提供编译后的 ESM 与 TypeScript 类型。调用方不需要构建库源码；本地验证未发布修改时可先运行 `pnpm pack`，再安装生成的 tgz。

```ts
import { createHost, joinRoom } from 'lan-link';

// A：生成邀请，将字符串绘制成二维码。
const host = createHost();
const invitation = await host.createInvitation();

// B：扫描邀请后生成应答，将应答绘制成二维码。
const { room: guest, answer } = await joinRoom(invitation);

const unsubscribe = host.on('message', ({ from, data }) => {
  // data 是 string 或 ArrayBuffer；结构和含义由业务方定义。
  console.log(from, data);
});

guest.on('state', async (state) => {
  if (state === 'connected') {
    await guest.send(guest.hostId, JSON.stringify({ type: 'ready' }));
  }
});

// A：扫描应答。先注册事件，再交换应答并等待 connected / peers。
await host.acceptAnswer(answer);

// 向所有当前已连接的其他设备发送；没有自己回环的消息。
// await host.broadcast(new Uint8Array([1, 2, 3]));

// 页面退出时释放连接、队列、监听器及计时器。
// unsubscribe();
// guest.close();
// host.close();
```

监听业务事件应尽早注册；需要在事件注册前后都判断时，读取 `room.state` 与 `room.peers` 获取当前快照。二维码生成本身是异步操作，界面应阻止重复提交，并允许取消尚未完成的邀请。

| 接口 | 用途 |
| --- | --- |
| `createHost(options?)` | 创建房间 |
| `joinRoom(invitation, options?)` | 接收邀请，返回成员实例和应答 |
| `room.createInvitation()` | 房主生成一份邀请；同一时间仅一份待处理邀请 |
| `room.acceptAnswer(answer)` | 房主接收当前邀请对应的应答 |
| `room.cancelInvitation()` | 取消当前待处理邀请，保留已连接成员 |
| `room.send(peerId, data)` | 向指定在线设备发送 |
| `room.broadcast(data)` | 向全部其他在线设备发送 |
| `room.sendStream(peerId, source, options?)` | 发送可拉取的二进制流，支持取消、偏移、总长和进度 |
| `room.removePeer(peerId)` | 仅房主可断开指定成员 |
| `room.on(event, listener)` | 监听事件，返回取消监听函数 |
| `room.close()` | 幂等退出并清理资源 |

事件包括 `message`、`stream`、`peers`、`state`、`error`。`peers` 不包含自身。`state` 为 `waiting`、`connecting`、`connected` 或 `closed`。消息携带 `from`，房主以实际连接身份标记来源，不采用成员自行声明的发送者身份。

可配置 `maxPeers`、`pairingTimeoutMs`、`connectionTimeoutMs`。成员生成应答后会保留扫码时间，不会因等待房主扫描而提前触发默认 20 秒连接超时。

加入方可以用 `joinRoom(invitation, { signal: controller.signal })` 取消正在生成应答的配对。取消会立即关闭对应连接；成功返回后，使用 `room.close()` 管理房间生命周期。

## 数据与交付语义

- 发送支持 `string`、`ArrayBuffer`、`ArrayBufferView` 和 `Blob`；接收为文本或 `ArrayBuffer`。
- 不设置固定的单条业务消息上限。按本次协商的 `pc.sctp.maxMessageSize` 自动分帧并还原原类型；转发时分别适配接收连接。普通消息会整体重组，大文件应使用流接口。
- 流接口使用 `ReadableStream<Uint8Array>`。接收端每次拉取授权下一个分块，内部调度窗口最多 256 KiB；这是单次在途缓冲预算，不是文件总大小或业务消息上限。
- `stream` 事件提供 `from/id/offset/totalBytes/metadata/stream`；metadata 为业务自定义字符串。接收方消费或取消流，无监听器时自动取消。续传需要业务持久保存断点，并创建新的流从已确认位置继续。
- 使用可靠、有序的 DataChannel；缓冲繁忙时等待 `bufferedamountlow`。业务应等待发送 Promise，避免自行无限发起未完成的消息。
- `send()` / `broadcast()` 完成只表示消息帧已提交给本机 DataChannel，**不是远端业务处理成功的确认**。需要确认、重试或去重时，由业务协议实现。
- 不提供离线消息、数据持久化或跨设备事务；房主能读取转发数据。WebRTC 通道本身加密，但这不是成员之间绕过房主的端到端加密协议。
- 配对二维码包含短期连接信息，只展示给希望加入的设备，不发布到公共日志或长期保存。

## 开发与演示

使用 Node.js 24 和 pnpm 11，在本仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm build             # Rslib：ESM + .d.ts，输出 dist/
pnpm typecheck
pnpm test
pnpm check:package     # 打包后从独立消费目录校验入口和类型
pnpm dev:demo          # http://localhost:5290/demo/
# 另一个终端，使用上面的预览服务：
pnpm test:e2e
pnpm build:demo        # demo-dist/demo/index.html + demo-dist/assets/
```

`pnpm dev` 持续构建库，演示页引用包导出，以便在真实浏览器中验证 Rslib 产物。
端口 5290 使用 `strictPort`，被占用时明确失败。浏览器测试使用调用方启动的预览服务，通过 `TEST_BASE_URL` 指定地址；CI 启动自己的临时服务并在结束时关闭。`TEST_ARTIFACTS` 可指定截图目录，默认写入忽略的 `artifacts/e2e/`。

库构建采用 [Rslib](https://rslib.rs/zh/guide/start/quick-start) 的 ESM bundleless 模式，两个公开入口均输出 JavaScript 和类型声明。演示构建与库产物分开，单独部署完整 `demo-dist/` 即可。

手机页内摄像头扫码需要 **HTTPS**；`http://192.168.x.x` 通常不能申请相机。`localhost` 仅适合本机调试。可以把静态演示部署到 HTTPS 后在同一局域网内使用，或由可信的局域网 HTTPS 服务提供。没有信令服务器不意味着不需要加载页面。此演示不实现离线安装，首次页面加载仍需可达的静态资源服务。

演示的“返回项目主页”默认指向本 GitHub 仓库。通过 `VITE_PROJECT_HOME_URL` 配置部署环境的主页；自定义时浏览器测试同时设置 `TEST_PROJECT_HOME`。演示不依赖 games 仓库或其本地服务。

## 验收边界

自动化测试使用真实浏览器的 WebRTC 连接，分别检查文字、二进制、多人转发、退出和失败路径。测试中交换二维码字符串不代表真实摄像头互扫通过；图片解码也不能替代两台设备的真实扫描。

当前测试覆盖普通数据自动分帧、不同接收能力的转发、流式拉取与取消、配对生命周期。应用的 IndexedDB 保存确认和文件断点属于业务层，见 [games 中的五子棋和聊天](https://github.com/ndzy01/games)。测试通过不等于真机扫码或实际局域网验收；发布结果以当次验收记录为准。

iOS Safari、Android Chrome、主屏幕 PWA、实际局域网互通、权限弹窗和快速连点等真机行为须单独验收。相机扫码以安全来源及设备授权为前提。

参考：[WebRTC 连接与信令](https://webrtc.org/getting-started/peer-connections)、[DataChannel](https://webrtc.org/getting-started/data-channels)、[相机的安全来源要求](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。

## 仓库边界

五子棋、聊天、房主后台、IndexedDB 与 CacheStorage 存储由业务应用实现，应用与业务浏览器测试保留在 [games](https://github.com/ndzy01/games) 仓库。包名为 `lan-link`，许可证标记为 `UNLICENSED`，保留所有权利。公开源码和 npm 分发不构成开源授权，使用前请取得权利人许可。

发布步骤：确认版本号 → `pnpm install --frozen-lockfile` → `pnpm typecheck && pnpm test && pnpm build && pnpm check:package` → 浏览器测试 → `pnpm publish --access public`。发布者须完成 npm 认证和所需的双因素验证。CI 只做检查，不持有发布凭据。
