# 《喵家保卫战》(Meow-Home Siege) 详细设计稿 v0.1

> **类型**：2D 俯视角 · 生存肉鸽（Survivors-like） + 轻塔防 · 1–4 人联机协作
>
> **灵感对标**：*Vampire Survivors* 的反馈循环、*20 Minutes Till Dawn* 的选技深度、*Dome Keeper* 的"守点"张力。主题用猫咪世界观包装。
>
> **交付目标**：先做扎实的单机 MVP 验证核心手感，再扩展到联机——因为联机版的技术成本是单机的 **2–3 倍**，详见 §15 难度评估。

---

## 0. 设计原则

1. **反馈密度**：每 1–2 秒有一次正反馈（击杀爆炸、经验球吸入、升级三选一），5 分钟内至少 1 次"华丽过载"（满屏特效）。
2. **易学难精**：新手只用学"走位 + 选技能"；高手研究 Build 组合、仇恨拉扯、波次节奏。
3. **权威同步**：**Nakama Match 做权威模拟**（30Hz tick），客户端做插值与预测——否则几百怪物的位置/血量绝对会不同步。
4. **性能第一**：MultiMesh 渲染敌人、空间分区做仇恨、AI LOD 按距离降频；目标 **桌面 60fps @ 500 敌人**、**手机 30fps @ 250 敌人**。

---

## 1. 视角与技术选型

| 维度 | 选择 | 理由 |
|------|------|------|
| **维度** | **2D 俯视角 (Godot Node2D)** | 美术成本低、碰撞便宜、同屏 500+ 敌人可行；3D 对独立团队是陷阱 |
| **相机** | 跟随玩家 + 轻缓动；多人时跟随"队伍重心" | 让基地和玩家同时入镜 |
| **物理** | `Area2D` + `CharacterBody2D`；**不用 RigidBody** | 肉鸽里大量敌人用刚体会炸帧 |
| **渲染敌人** | `MultiMeshInstance2D` 或 `draw_texture_batch` | 同一种怪一个 draw call |
| **寻路** | 敌人**不用 NavigationAgent2D**，用简易 `(base_pos - self_pos).normalized()` 向量推进 + 局部避让；玩家鼠标点地才用 NavigationAgent2D | 500 只怪跑 A* 必然卡 |

---

## 2. 核心循环

```
 出生
  └→ 移动 / 自动攻击 ─┐
                      │
                      ▼
         击杀怪物 ─→ 掉落经验球
                      │
                      ▼
           靠近吸入经验 ─→ 升级
                      │
                      ▼
            三选一技能选择
                      │
                      ▼
         波次升级 / 新怪种 ─→ 回到移动
                      │
                      ▼
          20 分钟 Boss 战 ─→ 胜利 / 失败
```

- 单局时长：**15–20 分钟**（Survivors-like 黄金时长）
- 峰值乐趣点：10 分钟附近的"精英潮"与 20 分钟 Boss

---

## 3. 场景与地图

### 3.1 场景结构（单局）

```
Arena (Node2D)
├── Background (TileMap, y_sort)
├── HomeBase (StaticBody2D)          # 中央温馨小家（基地），有 HP
├── SpawnRing (Node2D)               # 屏幕外环形生怪点
├── Entities (Node2D)
│   ├── Players (YSortContainer)     # 1~4 名玩家
│   ├── Enemies (MultiMesh + data)   # 敌人实例化
│   ├── Projectiles (MultiMesh)      # 弹道
│   ├── XpOrbs (MultiMesh)           # 经验球
│   └── VFX (Node2D)                 # 爆炸/特效
└── UI (CanvasLayer)
    ├── HUD                           # HP、等级、经验条、计时、基地 HP
    ├── LevelUpPanel                  # 三选一
    ├── PauseMenu
    └── DamageNumbers                 # 伤害飘字
```

### 3.2 地图规格

- 固定 `2400 × 2400` 像素，**有边界**（不是无限地图，因为要守家）
- 基地在正中央，玩家出生围绕基地 150px 半径
- 怪物在屏幕外 300px 环形生成，自动向基地寻路

---

## 4. 玩家角色系统

### 4.1 多端输入（适配）

| 端 | 移动 | 近战朝向 | 选技 |
|----|------|----------|------|
| 桌面键盘 | WASD | 鼠标指向 | 1/2/3 或点击 |
| 桌面手柄 | 左摇杆 | 右摇杆 | 右摇杆指方向 + A 确定 |
| 移动端 | 左虚拟摇杆 | 右虚拟摇杆（可选"辅助瞄准"） | 点击卡面 |
| 点击寻路 | 鼠标长按地面，`NavigationAgent2D` 自动走 | — | — |

统一用 Godot `InputMap` 动作：`move_up/down/left/right/aim_*/confirm/cancel`，各端映射不同。

### 4.2 玩家属性

| 属性 | 基础 | 说明 |
|------|------|------|
| HP | 100 | 死亡进入"倒地"，队友 5 秒扶起 |
| 移速 | 180 px/s | 基准 |
| 攻速 Attack Rate | 1.0 次/s | 自动攻击间隔的倒数 |
| 射程 Range | 240 px | 自动扫描半径 |
| 伤害 Damage | 10 | 基础武器伤害 |
| 暴击率 | 5% | 暴击 ×2 |
| 幸运 Luck | 0 | 影响掉落与三选一池子 |
| 吸取半径 Pickup | 48 px | 经验球自动吸入半径 |

### 4.3 手感细节

- 移动有 0.08s 的加速、0.04s 的减速（轻微惯性，太重会失手感）
- 受伤有 0.2s 无敌帧 + 镜头震屏 `shake=2px, 0.08s`
- 死亡/倒地镜头色温偏冷
- 击杀溢出时慢放 `time_scale=0.6, 0.15s` 强化大爆炸

### 4.4 职业（4 种，决策 ✓）

| 职业 | 特色 | 基础武器 | 初始技能 |
|------|------|---------|---------|
| **橘猫守卫** | 肉盾 HP+50%，攻速慢 | 猫爪横斩（近战扇形） | 蹭腿光环：范围 120px 内队友减伤 10% |
| **奶牛刺客** | 脆皮但移速+30%、暴击+10% | 鱼骨飞镖（穿透投射） | 影步闪避：受伤后 0.2s 无敌 |
| **三花射手** | 均衡高输出 | 追踪羽毛球 | 多重投射：起手多 1 发 |
| **暹罗法师** | 范围 AOE | 毛线球爆炸（弹地爆炸） | 法力余烬：升级时额外 +5% 全伤害 |

玩家在大厅选职业；多人模式允许重复职业。

---

## 5. 自动战斗 (Auto-Battle)

### 5.1 扫描与选目标

```
每 0.1s（tick 10Hz）：
  candidates = spatial_hash.query(player.pos, player.range)
  if empty: skip attack
  target = argmin by mode:
    NEAREST  → 距离最近
    LOWEST_HP → HP 最低
    HIGHEST_THREAT → 对基地威胁最大（dist_to_base 小的优先）
  fire_weapon(target)
```

### 5.2 攻击形式

- **投射类**（默认）：生成 `Projectile`（非刚体，自己跑线性轨迹），碰到敌人 `Area2D` 结算
- **近战扇形**：以玩家为中心画扇形多边形，一次性结算帧内敌人
- **环绕类**（旋转猫爪）：绕玩家旋转的子弹，碰到敌人造成伤害+短 cd

所有攻击统一过 `apply_damage(attacker, victim, amount, type)`，方便 Buff/减伤挂钩。

---

## 6. 敌人 AI 与仇恨系统

### 6.1 AI 状态机（3 个状态）

```
MOVE_TO_BASE ──玩家进入感知圈──▶ CHASE_PLAYER
     ▲                              │
     │                              │
     └──────玩家出圈 2s──────────────┘
     
CHASE_PLAYER ──到达攻击距离──▶ ATTACK
                                 │
                                 └──目标离开或死亡──▶ 回到 MOVE_TO_BASE
```

- 所有敌人出生目标 = 基地
- 进入任一玩家"感知圈"（默认 160px）→ 切换为 CHASE 该玩家
- **玩家远离 2s** → 重新回到去基地（拉扯机制的基础）
- 敌人攻击力分两种：**对玩家伤害**（小）、**对基地伤害**（大）——这样即使玩家很强，也必须回家守

### 6.2 性能：AI LOD（关键）

敌人按距离分级：

| 级别 | 距离玩家 | tick 频率 | 行为 |
|------|---------|----------|------|
| L0 | < 200px | 30Hz | 完整状态机 + 避让 |
| L1 | 200–500 | 15Hz | 只更新移动向量 |
| L2 | 500+ | 5Hz | 只做向基地靠近 |

### 6.3 空间分区

- 维护一个 `SpatialHash`（格子 128px）
- 玩家选目标、敌人找玩家、经验球被吸，都查哈希不是遍历
- 每帧只更新移动过格子的敌人

### 6.4 敌人类型（10 种，v0）

| 名字 | HP | 速度 | 对玩家伤害 | 对基地伤害 | 体型 | 特性 |
|------|----|----|----|----|------|------|
| 小鼠丁 | 8 | 90 | 2 | 1 | S | 数量多 |
| 流浪犬 | 16 | 110 | 4 | 2 | M | 追击型 |
| 胖田鼠 | 40 | 60 | 6 | 4 | M | 硬 |
| 乌鸦 | 12 | 140 | 3 | 2 | S | 飞行，无视障碍 |
| 毛毛虫 | 60 | 40 | 3 | 3 | L | 死亡爆裂 3 只小毛虫 |
| 浣熊贼 | 80 | 100 | 5 | 10 | L | 偷罐头：拆家时额外造成基地 HP 伤害 |
| 魔影犬 | 120 | 130 | 8 | 5 | L | 冲锋；偶尔无视玩家 |
| 野猫叛徒 | 180 | 95 | 7 | 8 | L | 精英，掉落额外经验 |
| 巨蛇 | 400 | 70 | 15 | 20 | XL | 5 分钟小 Boss |
| 魔犬之王 | 6000 | 85 | 25 | 50 | XXL | 20 分钟终极 Boss |

### 6.5 "偷罐头"机制（玩法彩蛋）

- 基地门前摆 **5 罐罐头**（视觉上），每被拆一次丢一罐
- 每罐 = 基地 20% HP
- 浣熊类怪拆掉罐头后**捡起**罐头往屏幕外跑；玩家击杀它**能抢回**罐头
- 让"守"变成"夺回"，视觉和情感都比单纯扣血有张力

---

## 7. 经验与升级系统

### 7.1 经验球

- 怪死亡掉落，玩家进入 `Pickup` 半径自动吸入（加速飞入）
- 每 **10 个球**合并成 1 个大球（性能：避免屏幕上几百个球）
- 多人模式：经验球**所有玩家共享**（靠近任一人都吸入，计入团队总经验）

### 7.2 等级与选技

- 团队共享等级曲线：`xp_to_next(lv) = 10 * lv * 1.25^lv`
- 升级时**所有玩家同时暂停**，各自弹出**三选一**面板
- 独立选择，都选完才继续（联网版见 §12）
- 选技池：**自身职业池 + 通用池 + 稀有池**（Luck 越高稀有池概率越大）

### 7.3 技能系统（4 类 + 合成）

| 类别 | 示例 | 作用 |
|------|------|------|
| **主动武器** | 旋转猫爪、鱼骨飞镖、追踪羽毛 | 每人最多持有 **5 件** |
| **远程增益** | 多重投射 +1、穿透 +1、暴击 +5% | 每人最多 **5 件** |
| **防御设施** | 纸箱路障、激光网、猫抓柱 | 放在基地周围 |
| **团队光环** | 呼噜疗法、胆量警钟 | 团队共享 |

- 每件武器 / 增益最多 **+5 级**（5 级即"满级"）
- **合成机制**：当主动武器 + 特定增益都 `+5` 时，合成为"终极形态"（例：旋转猫爪+暴击项链 → 爪影风暴）
- 合成后腾出一个格子，再开新武器

### 7.4 技能池大小（v0 数量）

| 池 | 数量 | 说明 |
|----|------|------|
| 主动武器 | 8 | 扇形/投射/环绕/AOE 各 2 |
| 增益词条 | 15 | 攻速/伤害/范围/冷却/移速/吸取… |
| 防御设施 | 6 | 围绕基地 |
| 团队光环 | 4 | 联机专属效益更大 |
| **合计** | **33** | v0 足够跑 5–10 局不重复 |

---

## 8. 波次与难度曲线

难度用"**威胁值 Threat**"驱动，不是硬编码怪物表。每 `tick` 计算当前场上 `sum(enemy.threat)`，低于目标就刷怪：

```
target_threat(t_min) = 40 + t_min^1.6 * 12
```

### 8.1 阶段模板

| 阶段 | 分钟 | 主要怪种 | 事件 |
|------|------|----------|------|
| 适应期 | 0–2 | 小鼠丁、流浪犬 | 教学提示 |
| 集群期 | 2–5 | + 乌鸦、胖田鼠 | 3:30 鼠潮事件（同时刷 40 只） |
| 精英期 | 5–10 | + 浣熊贼、魔影犬 | 5:00 小 Boss 巨蛇 |
| 疯狂期 | 10–15 | + 野猫叛徒 | 12:00 基地门打开罐头系统 |
| 终战期 | 15–20 | 全部 | 20:00 魔犬之王 |

### 8.2 事件 (Event) 系统

波次不够刺激，加 **脚本事件**：
- `3:30 鼠潮`：屏幕四角同时冲出 40 只小鼠
- `8:00 飞鸟围城`：顶部刷乌鸦雨
- `12:00 罐头门开`：基地开放，浣熊贼开始出现
- `17:00 夜幕`：画面变暗，怪物攻击力 +20%，持续 60s

事件用简单 **时间驱动的 DSL**：`{ at_sec: 330, type: "spawn_burst", enemy: "rat", count: 40, pattern: "corners" }`

---

## 9. 胜负与结算

### 9.1 失败
- 基地 HP 归零
- **所有**玩家同时倒地 5s（单人模式下玩家死即失败）

### 9.2 胜利
- 撑过 20 分钟且击杀魔犬之王
- 结算屏：击杀数、DPS、保护贡献度（基地 HP 事件记录）、最高等级、持有技能图鉴

### 9.3 局外成长（可选 Phase 2）
- 金币（钱包复用 `Modules/src/core/wallet.ts`）
- 解锁新职业、新武器起手、新地图
- 图鉴：见过的怪、合成过的终极武器

---

## 10. 数据结构（GDScript 蓝图）

### 10.1 纯数据 State（可 JSON 序列化，联网友好）

```gdscript
class_name SiegeMatchState
extends RefCounted

var tick: int = 0                       # 30Hz tick 编号
var seed: int = 0
var phase: int = 0                      # 0=lobby 1=playing 2=ended
var elapsed_ms: int = 0
var home_hp: int = 1000
var cans_left: int = 5
var players: Array[PlayerState] = []    # 1..4
var enemies: Array[EnemyState] = []
var projectiles: Array[ProjectileState] = []
var xp_orbs: Array[OrbState] = []
var team_xp: int = 0
var team_level: int = 1
var pending_level_ups: Array[int] = []  # 待选玩家的 idx
var rng_stream: PackedInt32Array
var events_log: Array[Dictionary] = []
```

### 10.2 玩家状态

```gdscript
class_name PlayerState
extends RefCounted

var user_id: String
var class_id: StringName    # ginger/cow/calico/siamese
var pos: Vector2
var vel: Vector2
var input: Vector2          # 当前输入向量
var hp: int
var max_hp: int
var stats: Dictionary = {}  # damage/rate/range/pickup...
var weapons: Array[WeaponState] = []  # <=5
var buffs: Array[BuffState] = []       # <=5
var pending_choice: Array[StringName] = []   # 三选一候选
var down_state: int = 0     # 0 alive / 1 down / 2 dead
var revive_progress: float = 0.0
```

### 10.3 敌人状态（精简，**没有** Node，只有数据）

```gdscript
class_name EnemyState
extends RefCounted

var id: int
var kind: StringName
var pos: Vector2
var vel: Vector2
var hp: int
var target_kind: int         # 0=base 1=player
var target_id: int
var state: int               # 0=to_base 1=chase 2=attack
var cooldown_ms: int
var lod: int                 # 0/1/2
```

### 10.4 所有逻辑集中在一个 "纯函数"

```gdscript
# scripts/siege/apply_tick.gd
static func apply_tick(state: SiegeMatchState, inputs: Array[Dictionary]) -> SiegeMatchState
# inputs: 每个玩家这一 tick 的输入（move 向量、是否施放被动开关、选技结果）
# 输出新 state；内部：处理移动→敌人 AI→攻击→伤害→XP 吸入→生怪→事件
```

**关键：视图层订阅 `state.events_log` 增量渲染动画**——单机/联网共用一份 `apply_tick`。

---

## 11. 项目结构

```
scenes/siege/
  lobby.tscn                    # 联机房间大厅
  arena.tscn                    # 战斗场景
  player_class_select.tscn
  level_up_panel.tscn
  settlement.tscn               # 结算

scripts/siege/
  core/
    match_state.gd
    player_state.gd
    enemy_state.gd
    projectile_state.gd
    orb_state.gd
    apply_tick.gd               # 纯函数
    rng.gd
    spatial_hash.gd
  data/
    classes.gd                  # 4 职业静态数据
    weapons.gd                  # 8 武器
    buffs.gd                    # 15 词条
    enemies.gd                  # 10 怪
    events_timeline.gd          # 时间线脚本
  sim/
    ai_controller.gd            # 敌人 AI
    weapon_controller.gd
    combat.gd                   # apply_damage
    spawner.gd
  view/
    arena_controller.gd         # 驱动场景
    enemy_multimesh.gd
    projectile_multimesh.gd
    xp_multimesh.gd
    player_view.gd
    hud.gd
    level_up_panel.gd
    damage_numbers.gd
    camera_rig.gd
  input/
    input_map.gd
    mobile_joystick.gd
  net/
    client_net.gd               # 单机 no-op，联网委托 OnlineSession
    snapshot.gd
    interpolator.gd             # 位置插值
    predictor.gd                # 客户端预测（自己）
```

---

## 12. 网络架构（核心难点）

### 12.1 总体：**服务端权威模拟**

- Nakama Match Handler 在服务端以 **30Hz tick** 运行 `apply_tick`
- 服务端是唯一真理源；客户端只发"输入"，接收"快照"
- 客户端**不计算敌人 AI**（避免不同步）

### 12.2 协议

| 方向 | Opcode | payload | 频率 |
|------|--------|---------|------|
| C→S | `SIEGE_OP_INPUT` | `{tick, move_x, move_y, skill_btn, pick_idx?}` | 30Hz |
| S→C | `SIEGE_OP_SNAPSHOT` | 完整/增量快照 | 20Hz |
| S→C | `SIEGE_OP_EVENTS` | 动画事件列表（死亡、爆炸、升级） | 随需 |
| S→C | `SIEGE_OP_LEVELUP` | `{player_id, choices: [3张卡]}` | 事件 |
| C→S | `SIEGE_OP_PICK` | `{choice_idx}` | 事件 |

### 12.3 快照压缩（必须做）

- 敌人字段打包：`id:u16, kind:u8, x:i16, y:i16, hp:u8% (百分比), state:u4`——**每只 8 字节**
- 500 只敌人 = 4KB / 快照；20Hz = 80KB/s——边缘可承受
- 增量快照：只发"进入/离开/状态切换"的敌人，移动每 5 tick 一次全量

### 12.4 客户端侧

- **本地玩家**：预测（按输入立即更新位置），收到服务端快照后做 reconciliation
- **其他玩家和敌人**：用 `interpolator` 在 `t-100ms` 位置平滑插值（标准做法）
- **VFX 与音效**：订阅 events，**不要**依赖位置精确同步

### 12.5 抗网络卡顿

- 断线 10s 内客户端显示"队友掉线"占位，服务端保留槽位
- 超过 10s 该 slot 标记为掉线，不接输入，敌人继续打它

### 12.6 防作弊（联机关键）

- 服务端**独立**维护 hp、damage、pos；客户端任何"我打到了谁"都不可信
- 技能选择在服务端生成池、客户端只回传 `pick_idx`
- 鼠标点地寻路：客户端发目标点，服务端用 pathfinding 校验可达

---

## 13. 性能预算（60fps = 16.67ms/frame）

| 预算 | 目标 | 策略 |
|-----|------|------|
| 敌人 AI | < 2ms @ 500 敌 | SpatialHash + LOD + tick 10Hz |
| 敌人渲染 | < 3ms | MultiMesh（1 draw call/kind）|
| 投射物 | < 1ms @ 200 | MultiMesh + 线性轨迹 |
| 碰撞 | < 3ms | Area2D + 层分组，不用物理响应 |
| VFX | < 2ms | 粒子池、超过上限复用 |
| 脚本 GC | < 1ms | 复用池、避免 tick 内 `.new()` |
| UI / 其他 | < 2ms | HUD 30Hz 刷新 |

**手机端**目标降到 `250 敌 + 30fps`；画质设置三档。

---

## 14. 开发里程碑

| 里程碑 | 范围 | 预计工期（单人）|
|--------|------|----------------|
| **M0 设计冻结** | 本文档 + 技术验证（1 个 demo：100 敌在 60fps 跑） | 1 周 |
| **M1 单机核心** | 1 职业 + 3 武器 + 2 敌 + 经验升级 + 10 分钟短局 | 3–4 周 |
| **M2 单机扩展** | 4 职业 + 8 武器 + 15 词条 + 10 敌 + 事件 + Boss | 3–4 周 |
| **M3 打磨** | 美术资产、音效、手感调优、多端输入 | 3 周 |
| **M4 联机架构** | Nakama SiegeMatch + 快照 + 预测/插值 + 断线 | 4–6 周 |
| **M5 多人体验** | 1–4 人房间、技能选择同步、倒地救援、结算 | 2–3 周 |
| **M6 上线准备** | 性能回归、防作弊、反馈改进 | 2 周 |
| **总计** | | **18–23 周（≈ 5 个月）** |

---

## 15. 开发难度评估（认真）

### 15.1 按模块（★=1 人 1 周；总分 ★数≈实际工时指标）

| 模块 | 难度 | 说明 |
|------|------|------|
| 玩家控制/输入 | ★★ | 多端适配琐碎，但都是已有套路 |
| 敌人渲染（MultiMesh） | ★★★ | Godot 的 MultiMesh 2D 用法需要学习 |
| SpatialHash + LOD | ★★★ | 肉鸽性能线，但算法不难 |
| 敌人 AI 状态机 + 仇恨 | ★★★★ | 状态机简单，**性能优化**难；拉扯机制的调参要反复试 |
| 武器系统（8 个） | ★★★ | 每把武器独立逻辑，体力活 |
| 技能池 + 合成 | ★★★ | 数据驱动，主要是平衡 |
| 经验球聚合/吸入 | ★★ | 简单 |
| 波次 + 事件系统 | ★★★ | 时间线 DSL 需要调度 |
| Boss AI | ★★★★ | Boss 独立脚本，技能编排花时间 |
| 美术/音效/UI 打磨 | ★★★★★ | 独立团队的真·瓶颈 |
| **单机小计** | **★×32** | **≈ 8 周（单人全职）** |
| — | | |
| Nakama 30Hz 权威 tick | ★★★★★ | TS runtime 跑 30Hz + 几百实体，需要性能调优 |
| 快照协议 + 压缩 | ★★★★ | 字节级打包，容易出 bug |
| 客户端插值 | ★★★ | 标准套路但需要仔细 |
| 客户端预测 + 对账 | ★★★★★ | **整个项目最难的一块**，容易肉眼抖动 |
| 升级选技同步 | ★★★ | 暂停/恢复逻辑 + 超时兜底 |
| 断线重连 | ★★★ | 槽位保留、状态补发 |
| 防作弊 | ★★★ | 纯服务端计算，但要覆盖全 |
| 房间大厅/匹配 | ★★ | 复用 `ddz_mm_*` 模式 |
| **联网附加小计** | **★×28** | **≈ 7 周（单人全职）** |

> **纯单机版 ≈ 2 个月**、**完整联机版 ≈ 5 个月**（单人全职）。你现有的斗地主联网花了多少精力，联网肉鸽大概是 **2–3 倍**。

### 15.2 最大的 5 个风险

1. **性能深渊**（★★★★★）：500 敌 + 投射 + VFX + 联机同步，Godot 4 的 2D pipeline 在移动端会吃紧。**必须**先做一个 M0 的"500 静态怪乱晃 + 100 投射"性能 demo 验证。
2. **客户端预测抖动**（★★★★★）：本地玩家位置在网络波动下不晃是真功夫，容易做出来"像果冻"。Survivors-like 移动很密集，抖一下就很明显。
3. **Nakama TS runtime 性能上限**（★★★★）：Nakama Match Loop 是 JS/TS 单线程；30Hz × 500 实体 × 几百次碰撞要看实测。最坏情况你得把热点移出 runtime（比如写个 Go 扩展或接 C++）。
4. **平衡性**（★★★★）：武器 × 词条 × 合成矩阵组合爆炸，没 100+ 小时测不出来。
5. **美术/VFX 量**（★★★★★）：独立爆款 Survivors-like 好看都是靠暴力 VFX 和音效堆出来的，这部分没捷径。

### 15.3 我的建议路线

1. **先别急着联网**：花 2 个月做扎实的单机版，自己玩着上头了再说——很多肉鸽的爽感取决于单机手感，联网反而会稀释
2. **M0 两个硬性技术验证**（2 周）：
   - Demo A：`500 敌人 + 100 投射 @ 60fps`（Godot Native 2D 能不能撑）
   - Demo B：Nakama TS 写一个 30Hz 空 tick，看 CPU 占用多少
3. **联机先做 2 人**：2 人跑通再扩到 4 人，带宽和同步复杂度差很多
4. **考虑降维方案**：
   - 如果 Godot 单机性能不达标 → 换到 **主客机 P2P** 同步（主机即权威），减轻 Nakama 负担
   - 如果 TS 服务端跑不动 → 考虑把 sim 核放到 Go 写的 Nakama 自定义模块

---

## 16. 与现有工程的接入

| 现有资产 | 用途 |
|---------|------|
| `OnlineSession` autoload | 复用登录 / 会话 / RPC 封装 |
| `scripts/nakama_error_text.gd` | 错误码本地化 |
| `Modules/src/core/wallet.ts` | 金币系统（局外解锁） |
| `scripts/start_menu.gd` | 首页增加"喵家保卫战"入口 |
| `Modules/GENERIC_BACKEND_DESIGN.md` 的 A 模式 | `games/siege/` 并列斗地主 |

新加服务端：

```
Modules/src/games/siege/
  match_state.ts
  apply_tick.ts         # 核心：GD 与 TS 逻辑同源
  spawner.ts
  combat.ts
  enemies.ts            # 数据
  weapons.ts            # 数据
  snapshot.ts           # 序列化
  match_handler.ts      # 30Hz MatchLoop
  mm_queue.ts           # 1–4 人队列
```

- RPC 前缀 `siege_mm_*`
- Opcode `SIEGE_OP_*`
- `registerMatch("siege", siegeMatchHandler)` 追加到 `main.ts` 的 `InitModule`

---

## 17. 彩蛋与世界观调味

- **拟物化**：怪物不是简单"受击死亡"——浣熊"拿着罐头跑"、乌鸦"啄走布娃娃"、巨蛇"把地毯卷走"。被拿走的物品可以显示在 HUD 上，击杀对应敌人能夺回。
- **基地装饰**：拿到罐头 / 布娃娃 / 地毯回来后在家里变成装饰物，随局持续——局外解锁"家园设计"系统（Phase 2）。
- **季节 Flair**（与猫条抢夺战的 Daily Flair 异曲同工）：本机日期决定背景音乐与装饰（春樱/夏海/秋枫/冬雪）。
- **全队吃饭事件**：每 5 分钟，基地冒出一碗鱼罐头，有队友站上去 3 秒全队恢复 20% HP——鼓励聚拢而非完全散开。

---

## 18. 一句话总结

> **《喵家保卫战》= 我攻你守的双线策略**：一条线是"满屏特效的生存肉鸽自娱自乐"，一条线是"必须回家救房子的塔防张力"；猫咪拟物化让情感连接强于数值连接，Daily/季节 Flair 给每日上线理由。
>
> **代价**：实时联机 + 高密度模拟会把项目体量推到现有斗地主的 **2–3 倍**，强烈建议先做出扎实单机。

---

*本文档独立于 `meow_scramble_DESIGN.md`；两款游戏可共存于同一 Nakama 后端，参考 `Modules/GENERIC_BACKEND_DESIGN.md`。*
