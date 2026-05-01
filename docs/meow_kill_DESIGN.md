# 猫猫杀（Meow Kill）— 工程设计

**文档版本**：v0.2  
**依赖**：[`Modules/GENERIC_BACKEND_DESIGN.md`](../Modules/GENERIC_BACKEND_DESIGN.md)、规则口径 [`meow_kill_RULES.md`](./meow_kill_RULES.md)。  
**目标**：在现有 Nakama + Godot 架构上新增「猫猫杀」玩法，与斗地主（`ddz`）、掼蛋（`guandan`）**并行**；在线大厅增加「匹配猫猫杀」入口。

---

## 1. 与现有仓库的对齐方式

| 维度 | 做法 |
|------|------|
| **Match 注册** | 在 `Modules/src/main.ts` 的 `InitModule` 内增加 `registerMatch("meow_kill", meowKillMatchHandler)`（label 名可最终再定，须全项目唯一）。 |
| **匹配队列** | 复制 `games/guandan/mm_queue.ts` 模式：`meow_kill_mm_join` / `meow_kill_mm_poll` / `meow_kill_mm_cancel`；Storage collection 独立（如 `meow_kill_mm`）。 |
| **RPC 前缀** | 全局唯一，建议 `meow_kill_*` 或 `mmkill_*`。 |
| **客户端** | `scripts/online_session.gd` 增加 `MEOW_KILL_MATCH_LABEL`、`RPC_MEOW_KILL_MM_*`、`start_meow_kill_matchmaking_async()`；`current_game_id = "meow_kill"`。 |
| **大厅** | `scenes/multiplayer_lobby.tscn` + `scripts/multiplayer_lobby.gd`：新按钮「匹配猫猫杀」；`_on_matchmaker_succeeded` 或等价成功回调里按 `current_game_id` 切到 `res://scenes/meow_kill/main.tscn`（待建）。 |
| **内置 Matchmaker** | 若仍使用 `registerMatchmakerMatched`，需在**唯一回调**中按属性分流到 `matchCreate("meow_kill", …)`；若本玩法仅走自建 RPC 队列，则与掼蛋一致，不强制依赖内置匹配。 |

参考现有掼蛋常量位置（须保持独立前缀）：

```37:42:scripts/online_session.gd
const GUANDAN_MATCH_LABEL := "guandan"
const GUANDAN_MM_TICKET_PREFIX := "guandanmm_"
const RPC_GUANDAN_MM_JOIN := "guandan_mm_join"
const RPC_GUANDAN_MM_POLL := "guandan_mm_poll"
const RPC_GUANDAN_MM_CANCEL := "guandan_mm_cancel"
```

---

## 2. 玩法复杂度与分期策略

《三国杀》类游戏的难点在于：**阶段机 + 事件栈 + 任意时机技能 + 多目标锦囊 + 距离与装备**。不建议第一版就做全扩展。

建议分期：

| 阶段 | 范围 | 目的 |
|------|------|------|
| **M0** | 仅**自建匹配 + 进房 + 座位/回合壳**；可发简单广播 opcode | 打通 Godot ↔ Nakama 新 Match，大厅按钮可用。 |
| **M1** | **5 人身份局**固定配置；**标包子集**（例如 10～15 个武将、精简牌堆）；实现完整 **六阶段**、**杀闪桃**、少量锦囊、装备（武器距离 + 马）、濒死与死亡奖惩 | 可玩闭环，规则与 [`meow_kill_RULES.md`](./meow_kill_RULES.md) 锁定表一致。 |
| **M2** | 扩展武将技能引擎（触发时机表、锁定技、转换技等）、无懈可击插入结算、更多锦囊 | 接近完整标准体验。 |
| **M3** | 6～8 人、更多扩展包、观战、录像、AI | 视产品需求。 |

**人数**：首版匹配建议固定 **5 人**（1 主 1 忠 2 反 1 内），降低平衡与 UI 复杂度；服务端用 `requiredPlayers = 5`，不足则 AI 补位或等待（与掼蛋 AI 补位模式类似，需单独设计「猫猫杀 AI」难度）。

---

## 3. 服务端架构（TypeScript / Nakama）

建议目录：

```
Modules/src/games/meow_kill/
  match_state.ts      # 可序列化的完整局面（JSON）
  rules.ts            # 距离、合法目标、牌堆构成、身份分配表
  ai_logic.ts         # 牌手 AI：选杀目标、闪/桃、弃牌（全信息启发式）
  match_logic.ts      # 阶段推进、使用牌、伤害、摸弃牌、调用 AI
  match_handler.ts    # Nakama MatchLoop / MatchJoin / MatchTerminate
  mm_queue.ts         # 与 guandan 同模式的 Storage 队列
```

### 3.1 权威状态

- **仅服务端**推进游戏阶段、洗牌、发牌、结算伤害；客户端只发「意图」（选将、使用哪张牌、指定目标、取消、响应无懈/桃等）。  
- 所有随机（洗牌、身份、发将）在服务端 `nk` 运行时完成，与现有 `core/random.ts` 一致。  
- **Opcode**：新建独立枚举区间（勿与 `DDZ_OP_*`、`GD_*` 重叠），例如 `MK_OP_*` / `MK_REQ_*`。

### 3.2 推荐的状态机形状

1. **Room**：匹配 id、玩家 userId ↔ 座位、是否 AI。  
2. **Phase**：`turn_seat`、`round_phase`（`start|judge|draw|play|discard|end`）。  
3. **Zones**：全局牌堆、弃牌堆；每名玩家 `hand`、`equips`、`judges`、`general`（武将数据）。  
4. **Event stack**（M1 可简化）：  
   - M0：单线程「请求 → 立即结算」。  
   - M1+：使用牌 → 指定目标 → 询问闪/无懈/濒死桃 → 嵌套子步骤。

### 3.3 校验原则

- 每条客户端消息必须校验：**是否轮到该座位**、**阶段是否允许**、**目标是否合法**（距离、次数、卡牌效果）。  
- 非法请求返回 `rpcErr` 或 match 内错误 opcode，**不推进状态**。

### 3.4 与钱包

- 可与斗地主共用 `core/wallet.ts`；是否入场费、胜负结算留作配置（与现有游戏一致即可）。

### 3.5 牌手 AI（M1 白板局）

- **触发**：`match_handler.matchLoop` 在处理完真人消息后，每 tick 最多调用 `mkRunMeowAi` 若干次（与当前实现一致），依次处理「出闪询问 → 濒死求桃 → 当前回合出牌/弃牌」，直到无需 AI 或达上限。
- **信息假设**：当前 AI 使用**全信息**（服务端知晓全场身份），优先保证对局可跑通与阵营行为合理；后续可改为不完全信息 + 简单信念模型。
- **出杀**：在距离 1 内选「敌意分」最高的存活目标（反贼优先主、忠；主忠优先反、内；内奸优先反、忠，主公偏低以装忠）。
- **闪**：体力 ≤1 时若有闪必出；否则仅对「阵营意义下敌对」的攻击者出闪。
- **濒死桃**：自救必用；主↔忠、反↔反互救；内奸仅在存活人数 >2 时对主公出桃（装忠），不对反、忠出桃。
- **弃牌**：手牌数 > 体力时，优先弃 **杀**，再 **闪**，最后 **桃**（同优先级弃靠后的手牌索引，减少多次弃牌时索引错位问题）。
- **结算展示**：`phase === "finished"` 时快照中带 `roles_fully_revealed` 与全场 `role_public`；`winner` / `winner_label_zh` 供客户端展示终局文案。

---

## 4. Godot 客户端架构

建议目录：

```
scenes/meow_kill/main.tscn
scripts/meow_kill/
  main.gd              # 场景入口、订阅 match 消息
  table_layout.gd      # 逻辑座位 → 相对本家索引 d（绑定环状 plaque）
  session_sync.gd      # opcode → 本地模型（可选）
  ui_table.gd          # 座位、手牌、选目标高亮
  card_assets.gd       # 手牌/出牌区贴图路径（meowkill/big-card、card）
```

- **表现层**：根据服务端下发的公开信息渲染（手牌仅自己可见，他人只显示张数）。  
- **交互**：拖拽/点选出牌、链式选择目标；响应窗口（闪、无懈、桃）由服务端驱动超时。  
- **资源**：使用原创「猫猫」武将名与插画；卡牌效果文本可自写，与服务器逻辑一致即可。  
- **桌面布置**（5/8 人、HUD、中央出牌区）：见 **[`meow_kill_TABLE_LAYOUT.md`](./meow_kill_TABLE_LAYOUT.md)**。  
- **匹配等待**：与掼蛋一致 **10s** 后 AI 牌手补满 5 人开桌（`meow_kill/mm_queue.ts` 中 `MK_MM_WAIT_MS`）。

---

## 5. 协议草案（示例）

以下为设计用草稿，实现时再固化为 `match_state.ts` 中的类型。

**服务端 → 客户端（广播）**

- `state_snapshot`：全量或增量局面（建议后期做 delta，M0 可全量 JSON）。  
- `phase_changed`：当前行动者与阶段。  
- `prompt`：需要某座位响应（出闪、无懈、桃、选目标等）及截止时间。

**客户端 → 服务端**

- `ready` / `pick_general` / `play_cards` / `respond` / `pass` 等，payload 带 `seat`、`card_ids`、`targets`。

---

## 6. 测试与平衡

- **单元测试**：`rules.ts`（距离、合法杀目标、弃牌数）、牌堆洗牌与抽空重洗。  
- **集成**：本地双客户端 + 机器人补位，跑通一局 5 人。  
- **规则回归**：对照 [`meow_kill_RULES.md`](./meow_kill_RULES.md) 与《官方规则集》目录中的关键专题做 checklist。

---

## 7. 风险与依赖

| 风险 | 缓解 |
|------|------|
| 技能系统爆炸 | M1 只开少量武将；技能用数据驱动 + 时机表，避免硬编码 if-else 森林。 |
| 客户端作弊 | 逻辑只在服务端；客户端仅展示与发意图。 |
| 版权 | 美术与文案原创；不在客户端内置三国杀原画与逐字技能描述。 |
| 对局时长 | 5 人局 + 可选「思考时间」上限；断线重连需后续 story。 |

---

## 8. 小结

- **规则文档**：[`meow_kill_RULES.md`](./meow_kill_RULES.md)（含权威链接与身份局摘要）。  
- **工程落地**：新 Match `meow_kill` + 独立 mm RPC + Godot 大厅按钮与新场景；实现上按 **M0 → M1** 分期，先跑通 5 人标包子集闭环，再扩展技能与人数。
