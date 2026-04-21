# 斗地主 · 游戏进程与判定逻辑（单机 / 联网）

本文描述当前工程内**已实现**的流程与关键判定，便于对照 `main.gd`、`online_session.gd`、`Modules/src/main.ts` 检查逻辑错误。

**联网有两条路径（不要混用）：**

| 路径 | 场景 | 权威与同步 |
|------|------|------------|
| **A · 服务端权威（推荐）** | `online_match.tscn`（`_server_authoritative = true`） | 逻辑在 **Nakama TypeScript Match `ddz`**；客户端只展示与发操作（OpCode 10～13）；快照 **101 / 错误 102 / 结算 120** |
| **B · 房主 + ENet（旧）** | `main.tscn` 且 `OnlineSession` 已进 Match、**非**权威模式 | 仍以 **「房主权威 + MultiplayerSynchronizer 快照」** 为准（见下文 §4.2～4.4） |

单机始终使用 **`main.tscn`**，不经过 `online_match`。

---

## 1. 座位与轮转（核心设定）

### 1.1 三个逻辑座位 A / B / C

- 代码里用整数 **0、1、2** 表示三个座位，约定：**座位 0 = A（庄家位）**。
- **出牌与叫分的轮转顺序**始终为：**0 → 1 → 2 → 0**（按座位下标递增取模）。
- **庄家先叫牌**：叫分阶段循环 `i = 0, 1, 2` 依次进行，即 **从座位 A（0）开始**。

### 1.2 单机（2 AI）

- 人类固定为 **座位 0**（`HUMAN_INDEX`）；座位 1、2 为 AI。
- 三只猫咪（丑丑妹 / 咪宝 / 毛睿睿）在开局时 **随机打乱** 分配到座位 0、1、2（仅影响展示与 AI 风格）。

### 1.3 联网路径 B：2 真人 + 1 AI

1. **房主**在 **`_run_new_round()`** 开头（且 Match 内已能拿到 **≥2** 个 `user_id`）时调用 **`_net_host_roll_seats_and_cats_once()`**（每盘开局若 `seat_by_uid` 仍为空则执行；同一盘续局不重复）。**不在 `_ready` 里掷座位**：避免此时对端尚未 join，`user_id` 只有 1 个导致掷座失败、`ai_seat` 未写入，进而把 AI 误判为真人、叫牌卡在「等 RPC」而不走 AI 分支。
2. **掷座内容**（原条目标号顺延）：
   - 将两名真人的 `user_id` 与占位 **`__AI__`** 共三个标记 **随机打乱**，依次排到座位 0、1、2；`__AI__` 所在座位记为 **`_net_ai_logical_seat`**（AI 席）。
   - 将 **[0,1,2] 三只猫各出现一次** 随机打乱后，依次赋给 `_seat_cat[0..2]`（每席一个猫，**无重复**）。
   - 根据本机 `session.user_id` 在映射表里写入 **`_my_net_seat`**。
3. **客人**不执行随机；从房主下发的快照字段 **`seat_by_uid`**（`user_id` → 座位）与 **`ai_seat`** 解析出 `_net_seat_by_uid`、`_net_ai_logical_seat`、`_my_net_seat`（见 **`_net_apply_seat_layout_from_snapshot_maybe`**）；若快照缺 `ai_seat` 但 `seat_by_uid` 恰有两条，则 **未出现在映射里的座位** 推断为 AI。
4. **权威房主**仍由 Nakama `user_id` 字典序最小者担任（`online_session.is_rt_match_host()`），与「坐在哪一号座位」**无关**；房主只负责跑状态机并发快照。
5. **`_net_is_human_controlled_seat(s)`**：由 **`_net_effective_ai_seat()`** 得到 AI 席（含反推/兼容）；`s` 等于该席则为 AI，否则为真人。

### 1.4 联网路径 B：3 真人

- 三个 `user_id` 随机分配到座位 0、1、2（`perm.shuffle()`）。
- **`ai_seat = -1`**，三席均为真人。
- 三只猫同样 **全排列随机** 分配到三席（无重复）。

### 1.5 联网路径 A：3 真人（服务端权威）

- **座位**由服务端 Match 内 **`seatByUserId`** 分配（加入顺序与 `user_id` 排序），见 **`Modules/src/main.ts`** 中 `assignSeats`。
- 客户端在 **`_srv_apply_public_state`** / **`_srv_apply_private_hand`** 中写入 **`_net_seat_by_uid`**、**`_my_net_seat`**，**无 AI 席**（`_net_ai_logical_seat = -1`）。
- 猫名随机可在首帧快照后 **`_shuffle_seat_cats`**（与单机一致，仅展示）。

### 1.6 兼容旧快照（无 `seat_by_uid`，路径 B）

- 若快照中无 `seat_by_uid`：2 真人时退化为 **user_id 小者 seat0、大者 seat1、AI 固定 seat2**；3 真人时按排序顺序 seat0、1、2。新对局应带 **`v: 2`** 与 `seat_by_uid`，避免双端同时误判叫牌席。

---

## 2. UI 与逻辑座位

- **手牌区**始终显示 **`_hands[_local_seat()]`**（本机所坐逻辑座位的手牌）。
- **头像 / 昵称 / 分数 / 地主标 / 桌面上一手牌展示** 按 **「本机视角」** 旋转：下方 = 本机，右手 = `(本机+1)%3`，左手 = `(本机+2)%3`（与对手牌背条 `_refresh_opponent_strips` 一致）。
- 联网名牌：**猫名为该席角色名**；后缀为 **（你）/（联网）/（AI）**（路径 A 下对手多为「联网」）。

---

## 3. 单机流程（概要）

1. `_ready`：洗牌猫（若未联网）→ 发牌动画 → **`_run_new_round()`**。
2. **`_run_new_round`**：清状态、`_bidding_active = true`、发牌 → **`_run_bidding_phase()`**。
3. **叫分**：`i = 0..2`，轮到 `i == _local_seat()` 时弹出叫分 UI，否则 AI 自动叫。
4. **抢地主**：从叫分最高者的 **下家** 开始逆时针各问一圈（代码里 `candidate` 与 `step`）；人类本地 UI，否则 AI。
5. **`_apply_landlord_merge`**：地主合并底牌。
6. **`_turn = _landlord`**，进入出牌循环：**`_after_state_changed` → `_refresh_ui` → `_tick_ai`（仅 AI 且轮到 AI）**。
7. 出牌规则、压牌、过、`passes` 与上一轮首家逻辑见 `ddz_rules.gd` / `main.gd` 中 `_state_play` / `_state_pass`。
8. 终局 → **`_run_settlement_flow`** → 续局或回菜单。

---

## 4. 联网流程（概要）

### 4.1 进房

- **路径 A**：大厅「马上匹配」→ **`start_matchmaking_authoritative_async()`**（3～3 人）→ 服务端 **`registerMatchmakerMatched`** 创建 **`ddz` Match** → 进入 **`online_match.tscn`**；**不**建立 ENet，**不**跑本地 `_run_new_round`。
- **路径 B**：匹配成功进 **`main.tscn`**；**房主** `_ready` 内 **`_net_host_roll_seats_and_cats_once()`**（若适用）；**客人** `_my_net_seat` 初值 0，直到 **首帧快照** 应用 `seat_by_uid` 后修正。
- 路径 B 客人隐藏 `DealLayer`，等 **`_net_guest_booted`**（收到合法快照后置 true）。

### 4.2 路径 B · 房主

- 与单机相同跑 **`_run_new_round` / `_run_bidding_phase` / …**。
- 轮到 **非本机且为真人席** 时：设置 **`_net_awaits`**（含 **`bid`/`rob` 与 `await_seat`**）→ **`_net_broadcast_snapshot_if_host`** → **`_await_guest_bid_async` / `_await_guest_rob_async`**（等 RPC）。
- 任意状态变更后 **`call_deferred("_net_broadcast_snapshot_if_host")`**（部分路径显式调用）。
- 快照 **`_net_build_snapshot`**：含 `seq`、`hands`、`bidding`、`await_seat`、`seat_by_uid`、`ai_seat`、`seat_cat`、`turn`、`t_left_ms`、结算相关等。

### 4.3 路径 B · 客人

- **`match_state_snapshot`**：校验 `sender == 房主 user_id`（若已知）、`seq` 单调递增后 **`_net_apply_snapshot`**。
- **叫分/抢地主 UI**：仅当 **`await_seat == _local_seat()`** 且快照带 `bid`/`rob` 时显示；**不再**用「另一人类座位」推断，避免双端同时出现叫牌 UI。
- 出牌 / 过 / 超时：发 **`match_client_action`**；房主在 **`_on_net_client_action`** 用 **`_net_seat_for_user_id(sender)`** 校验是否为当前 `turn` 等。

### 4.4 路径 B · 结算

- 房主弹结算层并广播；客人凭快照同步结算 UI。
- **`settle_continue` / `settle_menu`**：非房主发 RPC；房主在已拒绝「发件人为房主」的前提下，**只要结算层可见即可开门闸**（房主不通过 RPC 给自己发结算）。

### 4.5 路径 A · 服务端权威（`online_match` + `Modules`）

- **状态**：服务端发 **OpCode 101** 公共快照（`phase`、`seatByUserId`、`bids`、`turn`、`lastPattern`、`lastPlayIds`、`handsCount` 等）及 **逐人私信** 手牌（payload 含 **`yourHand` / `yourSeat`**，与公共快照同 `seq`）。
- **客户端**：`main.gd` 中 **`_on_srv_ddz_message`** → **`_srv_apply_snapshot_message`** / **`_srv_apply_settlement_payload`**；操作通过 **`OnlineSession.send_ddz_authoritative_async`**（10 叫分 / 11 抢 / 12 出牌 / 13 过）。
- **错误 / 结算**：**102** 提示；**120** 广播结算（简展示于结算层）。
- **与路径 B 的差异**：无房主本地状态机、无 ENet、无 **`match_state_snapshot`（opcode 2）** 那条快照链；**斗地主规则以服务端 TS 为准**，与 `ddz_rules.gd` 设计对齐。

---

## 5. 已知设计注意点

- **Nakama 房主 ≠ 游戏座位 0**（路径 B）：房主只决定「谁发快照」；**庄家先叫**始终是 **游戏座位 0（A）**。
- **路径 A**：无「发快照的房主」；**Nakama `user_id` 字典序最小者** 仍是 Socket 层面的 `is_rt_match_host()`，但**不参与**出牌逻辑判定。
- 若将来在快照中附带 **对手显示名**，可在 `seat_by_uid` 之外增加 `names_by_uid` 等字段，再改名牌文案。
- 路径 B 快照 **`v`**：当前含 `seat_by_uid` 的构建为 **`v: 3`**（若代码仍为 `v: 2` 以仓库为准）。

---

## 6. 关键文件索引

| 内容 | 位置 |
|------|------|
| 单机 / 路径 B 核心逻辑 | `main.gd` |
| 路径 A：服务端权威开关与快照应用 | `main.gd` → `_server_authoritative`、`_srv_*`、`match_ddz_server` |
| 路径 A 场景（继承 `main.tscn`） | `online_match.gd`、`scenes/online_match.tscn` |
| 服务端 Match、发牌、叫抢、出牌校验 | `Modules/src/main.ts` |
| 座位随机、猫全排列（路径 B 房主） | `main.gd` → `_net_host_roll_seats_and_cats_once` |
| 快照中的 `seat_by_uid` / `ai_seat`（路径 B） | `main.gd` → `_net_build_snapshot` |
| 客人解析座位（路径 B） | `main.gd` → `_net_apply_seat_layout_from_snapshot_maybe` |
| 是否 AI 席（路径 B） | `main.gd` → `_net_is_human_controlled_seat` |
| user → 座位（路径 B RPC 校验） | `main.gd` → `_net_seat_for_user_id` |
| UI 视角映射 | `main.gd` → `_view_slot_for_logical` / `_logical_seat_for_view_slot` |
| 联机大厅 / Socket / Match / DDZ 发送 | `online_session.gd` |
| 大厅匹配入口（路径 A） | `multiplayer_lobby.gd` |

若你发现本文与代码不一致，以代码为准并建议同步修改本文件。
