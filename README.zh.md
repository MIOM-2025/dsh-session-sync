# dsh-session-sync · 局域网会话同步

把 DSH 的**会话**在局域网内实时同步到另一台 DSH：两端都装本插件，一边点一下「连接」完成配对，
再在设置里勾选要同步的会话即可。同步直接写两边的本地会话目录，所以对方的会话会出现在自己的
会话列表里，并且可以直接用 HTTP 接口读取。

> 说明：你口述里的「绘画」这里按「会话（session）」实现。

## 安装

```bash
# 在插件目录所在机器上（本机已放好 ~/dsh-session-sync）
dsh plugin --profile web add link:~/dsh-session-sync
```

然后把 `dsh-session-sync` 加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，
重启 `dsh web`。打开「设置 → 会话同步」就能看到面板。

## 用法

1. A、B 两台都装好插件并打开面板，默认监听 `0.0.0.0:1111`（本机已按你的要求设成 1111）（同网段可直连）。
2. 在 A 面板填 B 的地址（如 `192.168.1.8:1111`）点「连接」：双方各自交换地址与令牌，
   面板「已配对设备」里都能看到对方（不会无限互相配对）。
3. 在任一台勾选要同步的会话。勾选后该会话的会话文件（`session.v4.jsonl.zstd`）会在约 2 秒内
   推到对端；对端继续编辑也会回推（按文件修改时间，后写者覆盖）。
4. 对端未勾选过的新会话，会出现在面板「对方设备上的会话」里，点「拉取」即可落到本地。
5. 面板上的「本机令牌/配对码」用于手动对齐；把 `allowPair` 关掉后只有带令牌的请求能配对。

## 两种使用方式

- **本地数据**：同步写两边的 `~/.dsh/sessions/...`，会话列表/标题/工作目录都跟着走。
- **联网调用**：同步服务本身就是 HTTP API，可被脚本或另一台 DSH 直接调用：
  `GET /ping`、`GET /sessions`、`GET /session?id=session-...`、`POST /push`、
  `POST /pair-request`；除 `/ping`、`/pair-request` 外都要带 `x-session-sync-token`。
  在 DSH 里也可以直接让 agent 调工具 `session_sync`（status/list/enable/disable/pair/sync/pull）。

## 勾选规则

- `enabled`（勾选）：本机主动推送这个会话，也接收对它的更新。
- `blocked`（取消勾选过）：明确拒绝这个会话的写入，对端推过来会被丢掉。
- `follow`（拉取/收到过）：跟随对端更新，但不会反向推送。

## 安全与限制

- 令牌即配对码，走明文 HTTP，只适合可信局域网；不要在公网暴露 1111。
- 没有冲突合并：同一会话两边同时改，按修改时间较晚的一份为准。
- 现状是整文件同步（zstd 会话文件通常几十 KB 到几 MB），不是逐 token 流式。
- Web 面板接口挂在 DSH 自己的 webserver 上（`/session-sync/api/...`），受 DSH 的同源策略保护。

## 开发

```bash
node test/engine.test.mjs   # 双引擎互推/实时更新/取消勾选/鉴权
node test/pair.test.mjs     # 自动配对、拉取、拒绝配对
```

## v0.2 实时共享（本次新增）

- **配对只要地址**：面板填 `192.168.1.8:1111` 点「连接」，双方自动互换地址和令牌。
- **本机 / 局域网**：面板一键切换，`仅本机` 只绑 127.0.0.1，`局域网` 绑 0.0.0.0，切换时服务不中断。
- **实时事件流**：勾选共享的会话，本机 `session/event` 会通过 SSE（`GET /live?id=...`）推给对端，
  对端在「实时查看」里能看到回复、工具调用、工具结果、轮次状态，延迟约 1 秒内。
- **远程指令**：`POST /command`，`{type:'stop'}` 让对端调用 `sessionController.cancel`，
  `{type:'message', text}` 让对端把消息送进该会话（`sessionController.prompt`）。
- **断线重连**：SSE 断开后 2 秒自动重连，重连时补发缓冲区里的事件。

已知边界：镜像进 DSH 原生侧边栏（把对方会话变成本机可点开的会话）还没做，目前实时视图在插件面板里；
文件拉取仍是整文件离线副本。

## 测试

```bash
node test/engine.test.mjs   # 文件同步/实时更新/取消勾选/鉴权
node test/pair.test.mjs     # 自动配对/拉取/拒绝配对
node test/live.test.mjs     # SSE 实时流/补发/远程停止/鉴权/网络切换
node test/ui.test.mjs       # 面板接口/工具/client bundle
node test/port.test.mjs     # 1111 端口真实监听
```

## v0.3 排队执行（安全边界）

两条铁律：**同一会话同一时刻只有一个写者、一条正在执行的操作。**

- **远端消息排队**：所有 `message` 指令进入队列，等当前回合 `turn/end` 结束后才开始下一条；
  执行完再同步，然后才处理队列里的下一条。面板会显示排队位置。
- **停止不排队**：`stop` 是中止而不是写入，立即调用 `sessionController.cancel`，否则停止就没意义。
- **回合中不同步**：会话正在跑回合时不推送、也不接收（避免读到/写到半截日志）；
  推送前对文件做二次 stat 校验，大小或 mtime 变了就跳过这一轮。
- **单写者保护**：本机勾选了某个会话，就拒绝对方推来的同一会话（`skipped: local owner`），
  从根上避免两边互相覆盖。
- **拉取副本只读**：拉取/镜像拿到的是快照，不要在本地继续跑同一个会话。
- 对应测试：`node test/queue.test.mjs`（排队顺序、停止直通、单写者拦截）。
