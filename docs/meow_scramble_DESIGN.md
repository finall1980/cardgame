# 《猫条抢夺战》(Meow-nergy Scramble) 详细设计稿 v0.1

> 主题：两只猫咪指挥官在猫咪江湖里抢夺「猫条」这种硬通货。上手 3 分钟、一局 8–12 分钟，数值区间全部落在 `1–5`，心理战重于数值战。
>
> 单机优先、权威状态机写法、后续零改动接入 Nakama。

---

## 0. 设计原则

1. **小数值、大博弈**：所有数值落在 `1–5`，玩家能心算；深度来自"信息不对称 + 一次性资源 + 单一总攻"的组合。
2. **拟主题化命名**：不用 HP/攻击力，用**猫条 / 喵气 / Paw / Focus**，关键词叫**呼噜/炸毛/蹭腿**等，保持世界观密度。
3. **逻辑核心与表现层解耦**：状态变更只经 `apply(action) → {state, events[]}` 这一纯函数；UI 只消费 `events[]` 播放动画——单机/联网共用一份逻辑核。
4. **新手 5 分钟能打完第一局**：教学关里只教 4 件事（猫咪/特技/抢条/反应窗口）。

---

## 1. 核心循环与胜负

### 1.1 猫条池 —— 非固定（决策 #1 ✓）

- 开局双方各 `5` 根猫条，桌面"争夺池"合计 `10` 根。
- **允许池外生成**：少数特技和 `呼噜` 关键词可以从"零食储备"（无限）里新增猫条入场——用来支撑"8 根胜利"的门槛，也让回复路线不是纯粹摆烂。

### 1.2 胜利条件（优先级自上而下）

1. 对方猫条 `= 0` → **立胜**
2. 自己猫条 `≥ 8` → **立胜**
3. 牌库耗尽后每回合开始扣 `1` 根"饥饿"猫条，先归 `0` 者负（长局兜底）

### 1.3 时长

- 单机不设硬时钟；联网版加 `45s` 软限 + `10s` 反应窗口限时。

---

## 2. 资源系统

| 资源 | 初始 | 上限 | 规则 |
|------|------|------|------|
| **猫条 Treats** | 5 | 8（达到即胜） | 既是血量也是胜利条件；少数牌允许消耗猫条作为副资源 |
| **喵气 Meow-nergy** | 0 | **10** | 醒盹 `+3`；**未用保留到下回合**（决策 #3 ✓） |
| **手牌 Hand** | 起手 4 | **5**（决策 #4 ✓） | 超限时"猫把它推下桌"，公开弃掉最新抽的那张 |
| **前线槽 Frontline** | 0 | 2 | 第 3 只替换上场时旧猫回弃堆（有 `粘人` 者回手牌） |

> 喵气保留是"虚晃一枪"的经济基础，也契合"猫咪蓄力扑抓"的世界观。

---

## 3. 回合结构 —— 四阶段（核心）

每回合严格切成 4 阶段；阶段边界就是"对手能不能插手"的边界：

| 阶段 | 谁能操作 | 发生 |
|------|----------|------|
| **1. 醒盹 Wakeup** | 自动 | 喵气 `+3`、抽 `1`、己方所有猫解锁冷却、结算 `OnTurnStart` 关键词 |
| **2. 调度 Deploy** | **仅自己** | 任意顺序打出猫咪/非反应特技、替换前线；对手**不能**插手 |
| **3. 抢夺 Pounce** | 自己发动 + 对手反应 | **至多一次**总攻；对手在反应窗口打 `Reaction` 特技；攻击猫进入冷却 |
| **4. 小憩 Catnap** | 自动 | 结算回合末效果、手牌超限、环境牌衰减；交出回合 |

### 3.1 "虚晃一枪"的机制根基

- Deploy 阶段 → 对手不能插手；Pounce 阶段 → 对手才能反应。
- 你可以在 Deploy 连打 3 张特技看起来"堆 buff"，但 Pounce 里**选择不发动**，直接 Catnap——对手的反应牌被冻结，下回合节奏被你打乱。
- 对手知道你会虚晃，就不敢留反应牌；于是你可以真总攻。
- **这一层心理博弈就是这个游戏最核心的深度来源**。

### 3.2 反应窗口 (Reaction Window)

- 只在 Pounce 阶段开启；开启时长单机 = 玩家自行按钮，联网 = 8 秒软限。
- 每次总攻**只允许对方打 1 张反应牌**（避免反应链膨胀）。
- 反应牌结算在攻击结算之前。

---

## 4. 战斗结算模型（方案 A，决策 #2 ✓）

### 4.1 流程

1. 攻击方指定：`来源猫 → 目标（敌猫 或 敌猫窝）`
2. **反应窗口**开启
3. 结算：
   - 目标是猫：**同步互殴**，双方 Paw 互扣对方 Focus；Focus ≤ 0 离场
   - 目标是猫窝 + 敌有前线：**强制清兵**，必须先选一只敌猫作为目标
   - 目标是空猫窝：`Paw` 根猫条从对方猫窝飞到己方猫窝
4. 触发 `OnAttack / OnDamaged / OnFaint` 关键词

### 4.2 连抢连击 Combo（★ 爽感增强点）

- 单回合内若通过"空猫窝直抢 + `偷袭伸爪` 额外攻击 + `抢食推盘`"在一回合内从对方那抢到 `≥ 3` 根猫条，触发 **Combo**：
  - 屏幕中央弹出 "连抢 ×N!" + 猫咪胜利爪印彩带
  - 下回合 `+1` 喵气作为节奏奖励（不超过上限 10）
- 作用：**奖励大胆爆发**，让"all-in 抢夺"有独立的视觉记忆点。

---

## 5. 关键词系统（精选 8 个）

先圈定 8 个核心关键词，其余效果统一用"触发点 + 文本描述"实现，避免关键词膨胀：

| 关键词 | 触发点 | 效果 |
|--------|--------|------|
| **蹭腿 Rally** | 入场 | 己方其他猫 Focus `+1` |
| **呼噜 Purr** | 每回合开始 | 从零食储备 `+1` 猫条 |
| **炸毛 Hiss** | 被攻击时 | 本回合 Paw `+1` |
| **假寐 Stealth** | 入场后 1 回合 | 不能被指定、不能攻击；解除当回合抽 1 |
| **闪电爪 Quick** | — | 入场当回合即可攻击（破冷却） |
| **九命 Nine Lives** | 首次阵亡 | Focus 重置为 1，仅生效 1 次 |
| **粘人 Clingy** | 被替换下场 | 回到手牌而非弃堆 |
| **碰瓷 Counter** | 被攻击 | 攻击方猫条 `-1` 转给自己 |

---

## 6. 初始卡表 v0（20 张，双方共享牌池）

单机 v1 不开放构筑（决策 #5 ✓）：每人从这 20 张里随机抽 20 张洗为个人牌库（保底 5 种猫咪），确保新手平衡。

### 6.1 猫咪卡（10 种）

| 名字 | 喵气 | Paw | Focus | 关键词/额外 |
|-|-|-|-|-|
| 小奶橘 | 1 | 1 | 2 | 闪电爪 |
| 花纹虎斑 | 2 | 2 | 2 | — |
| 碰瓷橘 | 3 | 1 | 3 | 碰瓷 |
| 纸箱怪盗 | 3 | 2 | 2 | 假寐 |
| 三花指挥官 | 4 | 2 | 3 | 蹭腿 |
| 狸花游击 | 4 | 3 | 2 | 闪电爪 |
| 英短老爷 | 4 | 1 | 5 | — |
| 九命黑猫 | 5 | 2 | 3 | 九命 |
| 橘猫巨无霸 | 5 | 3 | 5 | — |
| 缅因王座 | 6 | 4 | 4 | 入场：本回合不能攻击；呼噜 |

### 6.2 特技卡（10 种）

| 名字 | 喵气 | 标签 | 效果 |
|-|-|-|-|
| 舔毛整备 | 1 | Buff | 一只己方猫 Focus `+2` |
| 逗猫棒 | 1 | Draw | 抽 2 张 |
| 激光笔乱舞 | 2 | Control | 随机令对方一只猫本回合不能攻击 |
| **纸箱隐匿者** | 2 | **Reaction** | 取消对方本次总攻（仅 Pounce 反应窗口可打） |
| 投喂小鱼干 | 2 | Heal | 猫条 `+1`（从池外生成） |
| 偷袭伸爪 | 3 | Attack | 指定己方一只猫立刻进行一次额外攻击（本回合第二次） |
| 猫抓沙发 | 3 | Control | 破坏对方一张环境牌；若没有则抽 1 张 |
| 抢食推盘 | 3 | Attack | 从对方猫窝直接抢 `2` 根，忽略前线（不算"总攻"，每回合限 1 张） |
| 打翻花瓶 | 4 | Env | 本回合双方所有猫 Paw `+1`，回合末失效 |
| 猫薄荷狂欢 | 4 | Env | 己方所有猫 Paw `×2`；回合末这些猫回牌库底 |

### 6.3 数值原则

- 猫咪 `Paw + Focus ≈ cost + 1`，带关键词的裸值略低。
- 特技 1–2 喵气=节奏牌，3–4 喵气=胜负手。
- **只有 1 张反应类**在本卡池，避免反应链过深。
- 每张"直抢/额外抢"类（`抢食推盘`/`偷袭伸爪`）独立限 `1 次/回合`，堆 Combo 要靠综合打牌而非重复叠加。

---

## 7. 牌库 / 抽弃牌

- 牌库 20 张；起手 4（v1 不做 Mulligan，v2 加入）。
- 每回合醒盹抽 1；牌库空后每回合开始扣 1 根"饥饿"猫条。
- 弃牌堆可见**数量**，不可见**内容**（除 `猫抓沙发` 等明确揭示的效果）。

---

## 8. 桌面日彩蛋 Daily Flair（★ 重玩性增强点）

- 每个本机日期（基于 `OS.get_unix_time_from_datetime_string(...)` 计算自然日）产生一个**全局 Modifier**，对当天所有单机局生效。
- 采用不影响平衡的"味道调料"（Flavor Modifier），而非强数值：

| Flair | 效果 |
|-|-|
| 🐟 鱼干日 | 每局开始各方免费抽 1 张 `投喂小鱼干` |
| 📦 纸箱日 | 所有带 `假寐` 猫咪入场即抽 1 |
| 🌙 夜猫日 | 本局喵气上限改为 `8`（双方），节奏更紧凑 |
| 🎀 铃铛日 | 每次总攻造成伤害时播放"叮"的音效，猫条 `+0`（纯装饰） |
| ☀️ 晒太阳日 | 每回合醒盹多 `+1` 喵气，双方对称 |

- 作用：**日常登录仪式感 + 话题度**，玩家会说"今天是纸箱日，快速上一局"。
- 设计上任何玩家即使不登录 Nakama 也能体验 Flair（单机根据本地时间算），联网版再考虑"服务端同步 Flair"。

---

## 9. 单机 AI（三档，接口统一，决策 #6 ✓）

统一接口：`AI.decide(state) -> Action[]`——将来联网对手直接换成服务端权威 AI。

| 档位 | 策略 | 用途 |
|-|-|-|
| **新手** | 规则式：按喵气从高到低尝试出牌，有猫位就摆猫，Pounce 永远发动 | 教学局 / 首局 |
| **普通** | 启发式：评估函数 = `k1·猫条差 + k2·前线Paw∑差 + k3·前线Focus∑差 + k4·手牌差 + k5·喵气差 + k6·反应牌估值`；对本回合所有可行动作序列做**深度 1** 的搜索（我方行动序列 × 对方反应） | 日常 |
| **困难** | 浅层 MCTS：决策数 ≤ 8 时穷举；否则 200 次模拟；对方手牌按"剩余牌库分布"随机补齐 | 挑战 |

- 三档共用一个"从 state 生成合法动作"的 `enumerate_legal_actions(state)`——降低维护成本。

---

## 10. Godot 场景与脚本结构

### 10.1 场景骨架（横屏）

```
scenes/meow/meow_match.tscn
└─ MeowMatch (Control)
   ├── Table (Node2D)                  # 桌布、花瓶、灯光等装饰
   ├── OpponentZone (Node2D)
   │   ├── OpponentHomeBox             # 猫窝：猫条数字 + 堆叠贴图
   │   ├── OpponentHandRow             # 只显示数量的背面牌
   │   └── OpponentFrontline           # 2 个猫位
   ├── PlayerZone (Node2D)
   │   ├── PlayerFrontline
   │   ├── PlayerHandRow               # 扇形
   │   ├── PlayerHomeBox
   │   └── EnergyOrb                   # 喵气球：蓄力发光
   ├── PhaseBanner                     # "醒盹/调度/抢夺/小憩" 横幅
   ├── HistoryTicker                   # 最近 5 次操作日志
   ├── FlairBadge                      # 右上角当日 Flair 图标
   └── UI
       ├── BtnEndPhase
       ├── BtnPounce                   # 仅 Pounce 阶段显示
       ├── TutorialOverlay
       └── FlyingLayer                 # 猫条、数字飞行动画专用层
```

### 10.2 脚本目录

```
scripts/meow/
  meow_card_defs.gd              # 静态卡表、贴图路径
  cat_card_data.gd               # Resource：单张卡定义
  match_state.gd                 # 纯数据 State
  player_state.gd
  cat_on_board.gd
  actions.gd                     # Action 枚举/构造
  apply_action.gd                # 纯函数 apply(state, action) → {state, events}
  rules.gd                       # 合法性校验、enumerate_legal_actions
  effects/                       # 每张特技一个 script（script_id → 具体效果）
  ai/
    ai_iface.gd
    ai_rookie.gd                 # 新手
    ai_normal.gd                 # 启发式 + 深度1
    ai_hard.gd                   # 浅层 MCTS
  ui/
    match_controller.gd          # 主控，订阅 events 驱动动画
    card_view.gd
    cat_on_board_view.gd
    frontline_slot.gd
    home_box.gd
    energy_orb.gd
    phase_banner.gd
    flying_effects.gd            # 猫条飞、数字飘
  daily_flair.gd                 # 本地日期计算 + Flair 选择
  net_sync.gd                    # 联网预留，单机为 no-op
```

---

## 11. 数据结构蓝图（GDScript）

### 11.1 卡牌资源

```gdscript
# scripts/meow/cat_card_data.gd
class_name CatCardData
extends Resource

enum Kind { KITTY, TRICK }
enum TrickTag { BUFF, DRAW, CONTROL, REACTION, HEAL, ATTACK, ENV }

@export var id: StringName
@export var display_name: String
@export var kind: Kind
@export var cost: int
@export_multiline var description: String
@export var paw: int = 0            # 仅 KITTY
@export var focus: int = 0          # 仅 KITTY
@export var keywords: Array[StringName] = []
@export var trick_tags: Array[TrickTag] = []
@export var script_id: StringName   # 指向 effects/ 下的脚本
@export var art_path: String        # 卡面贴图
```

### 11.2 运行期状态（**无节点引用**，可直接 JSON 序列化）

```gdscript
# scripts/meow/match_state.gd
class_name MeowMatchState
extends RefCounted

var seed: int = 0
var turn_idx: int = 0
var active_side: int = 0        # 0/1
var phase: int = 0              # 0..3 Wakeup/Deploy/Pounce/Catnap
var players := [PlayerState.new(), PlayerState.new()]
var environment: Array[CatCardData] = []
var pending_pounce: Dictionary = {}   # Pounce 阶段对方反应窗口用
var combo_count_this_turn: int = 0    # 本回合抢到的猫条累计（Combo 计算）
var flair: StringName = &""           # 当日 Flair id
var history: Array[Dictionary] = []   # 事件流（UI 从此重放动画）
var rng_stream: PackedInt32Array      # 可重放的随机流
```

```gdscript
# scripts/meow/player_state.gd
class_name PlayerState
extends RefCounted

var treats: int = 5
var energy: int = 0
var deck: Array[CatCardData] = []
var hand: Array[CatCardData] = []
var frontline: Array[CatOnBoard] = []   # len <= 2
var discard: Array[CatCardData] = []
var used_pounce_this_turn: bool = false
var used_push_plate_this_turn: bool = false
```

```gdscript
# scripts/meow/cat_on_board.gd
class_name CatOnBoard
extends RefCounted

var data: CatCardData
var current_focus: int
var temp_paw_bonus: int = 0       # 环境/Buff 临时加成
var cooldown: bool = true         # 入场默认不能攻击（闪电爪除外）
var flags: Dictionary = {}        # nine_lives_triggered 等
```

### 11.3 Action / Event 示例

```gdscript
# Action 示例
{ "type": "play_card", "hand_idx": 2, "target": {"kind": "self_cat", "slot": 0} }
{ "type": "pounce",    "src_slot": 1, "target": {"kind": "enemy_cat", "slot": 0} }
{ "type": "pounce",    "src_slot": 1, "target": {"kind": "enemy_home"} }
{ "type": "react",     "hand_idx": 0 }   # 反应窗口
{ "type": "end_phase" }

# Event 示例（UI 消费）
{ "type": "card_drawn", "side": 0, "card_id": "ginger_giant" }
{ "type": "cat_spawned", "side": 0, "slot": 1, "card_id": "ginger_giant" }
{ "type": "attack_resolved", "src": {...}, "dst": {...}, "paw_to_dst": 3, "paw_to_src": 2 }
{ "type": "treats_moved", "from": 1, "to": 0, "count": 3 }
{ "type": "combo_triggered", "side": 0, "count": 4 }
{ "type": "cat_fainted", "side": 1, "slot": 0, "card_id": "calico" }
{ "type": "phase_changed", "phase": 2 }
```

---

## 12. 动画与音效清单（MVP）

| 场景 | 手法 | 时长 |
|-|-|-|
| 抽牌 | 牌背从牌库飞到手牌扇形位 | 0.35s |
| 打牌 | 放大 → 飞向目标 → 消失 | 0.40s |
| 对决 | 双猫向中间弹撞 + shake + 数字飘字 | 0.45s |
| 抢条成功 | 猫条精灵抛物线从对方猫窝飞向己方 | 0.55s |
| Combo 触发 | 屏幕中央 "连抢 ×N!" 彩带爆发 | 1.0s |
| 喵气增加 | 喵气球外环脉动发光 | 0.25s |
| 阶段切换 | 中屏横幅浮动淡入淡出 | 0.50s |
| 猫咪阵亡 | "断片"文字弹出 + 星星旋转 | 0.40s |
| Flair 出场 | 对局开场 1.5s 的 Flair 图标弹出 + 音效 | 1.5s |

音效关键词（先占坑，后续按需制作）：抽牌 *swish*、打牌 *pop*、攻击 *thud*、抢条 *pling*、Combo *fanfare*、阵亡 *swirl*、喵气 *chime*。

---

## 13. 联网化预留（Phase 2）

按 `Modules/GENERIC_BACKEND_DESIGN.md` §5 的 A 模式，与斗地主并列：

```
Modules/src/games/meow/
  match_state.ts
  rules.ts
  match_logic.ts        # 对应 GD 的 apply_action.gd，同一份测试用例
  match_handler.ts
  mm_queue.ts
  ai_server.ts
```

- RPC 前缀 `meow_mm_*`，Storage collection `meow_mm`
- Opcode 空间 `MEOW_OP_*`，与 `DDZ_OP_*` 完全隔离
- `registerMatch("meow", meowMatchHandler)` 追加在 `Modules/src/main.ts` 的 `InitModule` 内
- `registerMatchmakerMatched` 唯一回调里按 `properties.game_id` 分流到对应 `matchCreate`
- GD 版与 TS 版的 `apply_action` 共享 **一份 JSON 测试用例**（`test_suite/meow/apply_cases.json`），保证端一致

---

## 14. 开发里程碑

| 里程碑 | 范围 | 交付 |
|-|-|-|
| **M0** | 设计冻结 | 本文档通过评审 |
| **M1** | 数据层 | `CatCardData` + 20 张卡录入 + `apply_action` 单测（含 30 条用例） |
| **M2** | 单机可玩（灰框 UI） | 场景骨架 + 新手 AI + 打牌/攻击/结算/胜负闭环 |
| **M3** | 美术·动画·音效·新手教程 | "能给朋友试玩"版本 |
| **M4** | 普通 / 困难 AI + Combo + Daily Flair | 有重玩性的完整单机 |
| **M5** | 联网化 | 服务端 `games/meow/` + 客户端 `scripts/meow/net_sync.gd` + 大厅入口 |

---

## 15. 与现有工程的接入点

### 15.1 主菜单（`scenes/start_menu.tscn` / `scripts/start_menu.gd`）
- `_on_single_player_pressed()` 现跳转 `main.tscn`（斗地主）。v1 改为弹"选游戏"子菜单：斗地主 / **猫条抢夺战**；或在首页加第 5 个 `TextureButton`。

### 15.2 资源存放
- 卡面图：`CardsAssets/meow/*.png`（与斗地主扑克牌图分离）
- 猫条精灵、猫窝贴图、猫气球：`assets/meow/ui/`
- BGM：`MusicAssets/meow_bgm.mp3`

### 15.3 复用
- `scripts/nakama_error_text.gd`、`OnlineSession` autoload 均可复用
- 钱包（`Modules/src/core/wallet.ts`）可在 M5 用来做"牌背皮肤"等小额消费

---

## 16. 后续扩展（不在 v0 范围）

- **猫咪性格系统**：社恐/社牛，影响场上猫数 → Focus 修正，阵型博弈。
- **构筑模式**：20 张起手、卡池扩到 40，每牌最多 2 张。
- **周常 Flair**：7 天轮播的大型桌面规则（例：本周前线 = 3 槽）。
- **天梯与段位**：联网分数榜，按赛季结算。
- **合作模式**：双人联手挑战 Boss 猫（猫条 HP 20 的 BOSS）。

---

## 17. 一句话总结

> 把**炉石的出牌节奏 × 昆特的单一回合高潮 × 猫猫拟人化语汇**拧在一起，用 5 张手牌 / 一次总攻 / 反应窗口 / 虚晃一枪四件事，堆出简单但深的博弈感；日彩蛋和连抢连击保证"每日一局"和"爆发爽感"。

---

*本文档与后端 `Modules/GENERIC_BACKEND_DESIGN.md` 对齐；联网化章节随该文档升级。*
