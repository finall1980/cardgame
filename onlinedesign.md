# 三猫斗地主 · Nakama 网络对战设计（草案）

> 首页底部按钮布局暂不改动。本文档描述：**基于 Nakama 的联机对战** + **客户端驱动 AI（房主机器跑 AI）** 的总体设计与分步落地路线。  
> 实现顺序：**先简单、可跑通，再迭代**。

---

## 1. 目标与约束

### 1.1 目标

- 在现有 **单机斗地主**（`main.gd` 等）逻辑之上，增加 **网络对战** 路径。
- **三人局**：斗地主固定 3 个座位；允许 **2 真人 + 1 AI**（或未来 3 真人）。
- **匹配**：当前阶段 **不设匹配条件**（不按段位、延迟筛选）；**两名真人匹配成功即可开局**（第三人由 AI 补齐）。
- **AI 低成本方案**：**客户端驱动 AI** — 由 **房主（Master Client）** 的 Godot 进程执行现有/简化的 AI 逻辑，通过 Nakama Match 把「AI 的决策」以与普通玩家相同的消息形式发给其他客户端，从而无需独立 AI 服务器。

### 1.2 约束与假设

- 服务端 **Nakama** 已可连（项目里 `OnlineSession` + `authenticate_email` 等已具备）。
- **不做**「服务端完整牌局权威校验」的第一版（成本高）；第一版以 **房主为逻辑中心 + 广播状态** 为主，接受一定信任模型（见 §7 风险）。
- 与现有 **单机模式** 并存：`OnlineSession.offline_mode` / 是否进入 `main` 前已登录等保持独立，网络对局使用 **单独场景或 `main` 内分支**（实现阶段再定，见 §6）。

---

## 2. 核心概念

| 概念 | 含义 |
|------|------|
| **Match** | Nakama 的实时对战单元（`socket.join_match_async` / `create_match` 等），内有 `match_id`、参与者 `presences`。 |
| **房主 / Master Client** | **Match 参与者列表中排序第一位的客户端**（项目约定；与 Nakama 文档中「列表顺序」一致即可，实现时用服务端下发的 `presence` 顺序或进入顺序固化）。房主负责：驱动 AI、汇总合法操作、向 Match 发 **权威意图**（见 §4）。 |
| **Seat（座位）** | 斗地主 3 人，座位索引 `0..2`；需映射 `user_id` / `session` ↔ seat。房主可固定占 seat 0（约定简化），其余按加入顺序。 |
| **AI 占位** | 某一 seat 无真人时，由 **房主** 在本地跑 `DdzAi`（或薄封装），把结果编码为 **出牌/叫分/过** 等与真人相同的 `op` 消息发出。其他客户端 **不跑** 该 seat 的 AI，只展示与校验简单规则（可选）。 |

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Nakama Server                            │
│  Match 状态存储（轻量）+ 消息中继 + 可选 RPC/Match Handler    │
└───────────────▲───────────────────────────────▲─────────────┘
                │ Match 消息 (send/receive)    │
    ┌───────────┴──────────┐         ┌──────────┴──────────┐
    │  客户端 A（房主）     │         │  客户端 B（客人）   │
    │  - 发「局状态」快照   │         │  - 收快照 / 他人 op │
    │  - 收客人 op         │         │  - 发本人 op        │
    │  - 本地跑 AI seat    │         │  - 不跑 AI          │
    └──────────────────────┘         └─────────────────────┘
```

- **信令与状态**：优先使用 Nakama **Realtime Match** 的 `match_data`（二进制或 JSON）， opcode 区分消息类型。
- **「谁说了算」**：第一版由 **房主** 判定回合、合法牌型、是否结束；房主广播 **新状态**（或增量事件）。服务端不做完整牌逻辑时可接受「防作弊弱」。

---

## 4. 消息与状态（逻辑层设计）

### 4.1 原则

- 所有参与者 **只通过 Match 消息** 同步意图与状态；**禁止** 客人客户端私自改「当前轮到谁、手牌张数」等关键字段而不经广播。
- **AI 的每一步** 在房主上生成后，以 **统一格式的 `PlayerAction`** 发出，并带 `seat_id`（或 `user_id`），这样客人端 **无差别渲染**，无需区分「真人 / AI」网络路径。

### 4.2 建议 Opcode 划分（示例）

| Opcode | 方向 | 说明 |
|--------|------|------|
| `1` | 客人 → 全员（经房主转发或直连广播） | `Intent`：叫分 / 出牌 / 过 / 抢地主等（与现有 `main.gd` 阶段对齐的精简版）。 |
| `2` | 房主 → 全员 | `StateSnapshot`：完整或增量局状态（手牌是否下发见 §5）。 |
| `3` | 系统/房主 | `RoomMeta`：seat 分配、谁是房主、是否已开局。 |
| `4` | 房主 | `Error`/`Reject`：非法操作回执。 |

（具体数字在实现时可改为枚举 + 常量；第一版可用 JSON 字符串降低调试成本，再改为 `PackedByteArray`/`StreamPeerBuffer`。）

### 4.3 状态快照内容（第一版最小集）

- `phase`：等待匹配 / 发牌 / 叫地主 / 出牌 / 结算。
- `landlord_seat`、`current_turn_seat`。
- 各 seat **剩余张数**（必传）；**手牌明文** 是否下发给非本人：第一版可 **仅房主存全量**，客人只收「自己的手牌」+ 公开信息（桌面上一手牌、底牌翻开与否等），减少泄露与同步量（与单机 UI 改造点相关，见 §6）。

---

## 5. 匹配与开局流程（当前：无条件 + 2 人即开）

### 5.1 匹配策略（MVP）

1. 玩家登录后进入 **「联机大厅」**（新 UI 或现有弹层扩展）：点击 **开始匹配**。
2. 客户端调用 Nakama **Matchmaker**（`add_matchmaker_async`）或 **自建 Match + 邀请码**（更简单可先 Matchmaker）。
3. **Matchmaker  ticket**：当前不设属性条件；`min_count = 2`, `max_count = 2`（只匹配两名真人）；匹配成功后由 Nakama 创建 **Match**，两客户端 `join`。
4. **第三人 AI**：Match 内 `presences` 只有 2 人时，房主在 `RoomMeta` 或首条 `StateSnapshot` 中标记 `seat_ai = 2`（举例），并在该局内 **始终由房主** 生成该 seat 的操作。

> 若后续改为「3 真人」或「1 真人 + 2 AI」，只需扩展 seat 分配与 `presences` 数量判断，**Master AI 规则不变**。

### 5.2 房主判定（与 Nakama 对齐）

- **约定**：Match 建立后，服务端返回的参与者列表（或 `join` 后 `presences` 排序）中 **索引 0** 为房主 / Master Client。
- 实现时需在 **所有客户端** 用同一规则计算 `is_host`，避免争议；若 Nakama 版本对顺序不稳定，可改为：**创建 Match 的 presence 为房主**（`create_match` 路径），并在首包 `RoomMeta` 写明 `host_user_id`。

---

## 6. 与现有 Godot 工程的关系

| 模块 | 建议 |
|------|------|
| `scripts/main.gd` | 单机逻辑重、耦合 UI；网络版建议 **新场景** `online_table.tscn`（或 `main_online.gd`）**复用** `ddz_rules.gd` / `ddz_ai.gd`，通过适配层把「输入源」从本地 `_tick_ai` 改为「Match 消息 + 房主本地 AI」。 |
| `DdzAi` | 房主仅在 `seat == ai_seat` 时调用；输入上下文与单机一致即可。 |
| `OnlineSession` | 继续维护 `session`、`socket`（待接）；增加 `match_id`、`is_match_host`、`my_seat` 等字段（实现阶段细化）。 |
| `start_menu` | 仅负责进线；**匹配 UI** 可新场景或子面板。 |

**分阶段建议**：先 **不** 改动现有单机 `main.tscn` 主流程，新增 **联机对局场景** 跑通「匹配 → 进房 → 发一条测试消息 → 房主广播快照」；再逐步把牌局阶段迁入。

---

## 7. 风险与后续增强

| 风险 | 缓解（后续迭代） |
|------|------------------|
| 房主掉线 | 暂停 / 转移房主（Nakama `match_leave` + 选新 host）或整局解散；MVP 可提示「房主离开，对局结束」。 |
| 作弊 | MVP 信任房主；后续可加 **服务端 Authoritative** 或 **关键操作签名校验**（工作量大）。 |
| 状态不同步 | 快照带 `tick`/`seq`；客人以房主快照为准强制纠正。 |
| 延迟 | AI 由房主执行无额外 RTT；真人操作可走同一 tick 合并。 |

---

## 8. 分阶段实现路线（推荐顺序）

### Phase 0：基础连通

- `OnlineSession` 持有 **NakamaSocket**（与 HTTP `NakamaClient` 并存），登录后 `connect_async` / `join_match_async` 测试。
- 控制台或 UI 显示：socket 已连接、`match_id`、本机是否房主。

### Phase 1：空 Match + 手动 second client

- 房主 `create_match`，客人 `join_match`（或 matchmaker 2 人）。
- 双向收发 **一条** `match_data`（opcode 测试），验证序列化。

### Phase 2：`RoomMeta` + seat + 2 人 + AI 占位

- 首包广播 seat、host、`ai_seat`。
- 客人 UI 显示「你是 seat X」；房主显示「你是 host」。

### Phase 3：最小牌局同步（简化规则）

- 仅同步：**轮到谁、出一手牌（牌 id 列表）、过**；不先做完整叫分抢地主，或先做固定规则。
- 房主合并意图 + 调用 `DdzAi` 填 AI seat + 广播 `StateSnapshot`。

### Phase 4：对齐现有斗地主阶段

- 叫地主 / 抢地主 / 倍数 / 结算与单机一致；快照字段扩展。
- 可选：录像 `match_state` 调试。

### Phase 5：匹配体验与健壮性

- 断线重连、重进 Match、超时未操作由房主代「过」等。

---

## 9. 文档维护

- 实现过程中若 Nakama API 版本、Match 参与者顺序与本文不一致，**以实际 API 行为为准** 更新 §5.2 / §2。
- 消息 opcode 与字段以代码中的 `const` / 单一 `serializer` 模块为最终源，本文仅作初始约定。

---

## 10. 参考（工程内已有）

- `scripts/online_session.gd`：HTTP Client、会话。
- `addons/com.heroiclabs.nakama/`：官方插件（`NakamaSocket`、`join_match_async`、`match_data_send` 等）。
- `scripts/ddz_ai.gd`、`scripts/ddz_rules.gd`：房主侧可复用。

---

*文档版本：初稿 · 与「首页按钮暂不调整」并行，联机实现以本设计为基线迭代。*
