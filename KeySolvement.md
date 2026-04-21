# 联网斗地主（Nakama 权威 Match）关键问题与处理

本文记录线上联机斗地主在接入 **服务端权威 Match**（`Modules/src/main.ts`）时踩过的**根因级**问题与对应修复，便于日后排查与回归。

---

## 1. `MatchMessage.data` 为 `ArrayBuffer`，直接当字符串解析会静默失败

**现象**：客户端发出的叫分 / 出牌等 opcode 在服务端「完全无反应」或状态不推进；日志里可能出现 JSON 解析失败或解析出乱串。

**根因**：Nakama 运行时传入的 `data` 往往是 **二进制 `ArrayBuffer`**。若用 `String(msg.data)` 再 `JSON.parse`，在多数环境下**不会**得到合法 UTF-8 文本，解析失败后被 `try/catch` 吃掉或走错误分支，导致整局逻辑不执行。

**处理**：在 `ddzMatchLoop` 侧统一用 **`decodeMatchData()`**（`TextDecoder`，失败时再按字节拼 Latin1/逐字节兜底）解码为字符串，再 `JSON.parse`。改完 `Modules/src/` 后必须 **`npm run build`** 并重启 Nakama（见 `NAKAMA_DEPLOY.md`）。

---

## 2. `userId` 大小写与 `seatByUserId` 键不一致 → `seatForUser === -1`

**现象**：发牌正常，但某客户端发出的 Match 消息全部被判定为「未知发送者」，叫牌轮卡住。

**根因**：RT / HTTP / JSON 各层里 `userId` 字符串大小写可能不一致；若服务端 `seatByUserId` 用一种形式键入、而 `msg.sender.userId` 是另一种形式，则 `seatForUser` 找不到座位。

**处理**：服务端对 userId 做 **`normUserId`（如统一 `toLowerCase()`）**，与客户端 `_net_norm_uid` 对齐后再查表。

---

## 3. 公共快照与私信顺序乱序 / 同 tick 多包

**现象**：叫牌 UI 显示「不该你叫」、或手牌与 `awaitSeat` 不一致。

**根因**：同一 `broadcast` 周期内先发公共快照、再发带手牌的私信；UDP/调度顺序下**私信可能先到**。若先应用手牌、公共状态仍是旧的，UI 会读错 `awaitSeat` / 座位。

**处理**（`scripts/main.gd`）：维护 **`_srv_last_applied_public_seq`**，私信若 **seq 大于**已落地的公共 seq 则进入 **`_srv_pending_private`**；公共快照落地后再按 seq **flush** 私信。

---

## 4. 其它备忘

- **`nk.secureRandomBytes` 兼容性**：部分运行环境需对随机字节做兼容封装，避免洗牌/种子生成失败。
- **底牌与牌背**：协议里对未公开牌使用 `-1` 等占位时，客户端需统一走牌背贴图，避免 `-1` 当有效 id 去加载资源。
- **`autoAdvanceRob` 后**：若仅改状态未 `broadcastState`，客户端仍停留在旧阶段，需在 tick 内补广播。
- **大厅等待期丢首包**：在 `OnlineSession` 侧对 DDZ RT 消息做**缓冲**，进主场景后 `replay_rt_ddz_buffer()` 重放。

---

## 5. 局间「继续比赛」（全员确认后重开发牌）

**需求**：结算后需 **三名玩家都点击「继续比赛」**，服务端从 **`resetRound`（重新洗牌、进入叫分）** 开始下一局，而不是仅本地关界面。

**实现要点**：

- 服务端增加 **`DDZ_REQ_CONTINUE`（opcode 14）**，状态里 **`continueReady[3]`** 随公共快照下发；仅在 **`phase === "finished"`** 时置位；三人齐则 **`resetRound(nk)`** 并 `broadcastState`。
- 客户端权威模式下发 **`send_ddz_authoritative_async(14, {})`**，结算区展示 **「全员继续：x/3」**；新局快照 **`phase !== "finished"`** 时关闭结算层并恢复交互。

---

## 6. 三真人：猫咪角色与昵称展示

**需求**：匹配成功后 **咪宝 / 毛睿睿 / 丑丑妹** 与三个逻辑座位 **随机绑定**；头像用对应猫咪资源；名牌为 **`猫咪名（用户昵称）`**（本机可加「· 你」）。

**实现要点**：客户端在 **`_server_authoritative`** 且三真人时，使用已有 **`_shuffle_seat_cats()`** 得到的 **`_seat_cat`**，结合 **`get_users_async`** 拉齐 **`_net_nick_by_uid`** 后刷新 **`_apply_name_plates()`**。

---

## 7. 部署提醒

修改服务端逻辑后请按 **`NAKAMA_DEPLOY.md`**：`cd Modules && npm run build`，再 **`docker compose restart nakama`**（或等价重启），否则容器内仍是旧的 `Modules/build/index.js`。
