# 掼蛋（Guan Dan）— 规则整理与工程设计

**文档版本**：v0.2（规则口径已确认：庄家队级牌为全场级 / 顺子 A 只顶 TJQKA / 红心级牌允许参与同花顺）  
**依赖**：通用后端 [`Modules/GENERIC_BACKEND_DESIGN.md`](../Modules/GENERIC_BACKEND_DESIGN.md)；已实现范例 [`docs/DESIGN.md`](./DESIGN.md)（斗地主）。  
**目标**：在同一套 Nakama 后端 / Godot 客户端上新增「掼蛋」玩法，复用通用层（钱包、Storage 队列、JSON RPC、随机数），与斗地主并存互不影响。

---

## 0. 名词速览

| 简称 | 含义 |
|------|------|
| **一副** | 标准 54 张（52 花色 + 小王 + 大王） |
| **一副牌局** | 掼蛋用 **两副** = 108 张 |
| **队** | 4 人分 2 队；对家（对角）为队友 |
| **级牌 / 打的牌** | 当前己方要打到的点数，如「打 2」「打 7」「打 A」 |
| **主级 / 红心级牌** | 级牌中**红桃花色**的那张，具备万能替代功能（逢人配） |
| **百搭（逢人配）** | 红心级牌的别称；在组牌时可代替除大小王外的任意牌 |
| **头游 / 二游 / 三游 / 末游** | 一局中依次出完手牌的 1/2/3/4 名 |
| **贡牌 / 还贡** | 末游把最大牌给头游，头游回一张≤10的牌 |
| **过 A** | 打到 A 后必须再以 A 级牌赢下一局才算真正「毕业」 |

---

## 1. 掼蛋规则整理

> 不同地区存在若干变体；本节选定**用于实现**的一套具体规则，记作「**本实现规则**」。差异点在末尾「变体与可选规则」列出，可作为后续配置项。

### 1.1 基础

1. **人数与队伍**：4 人，分成 2 队。座位 0/2 为一队，1/3 为一队，队友永远坐对家（对角）。
2. **用牌**：2 副标准牌共 **108 张**（含 4 张小王、4 张大王）。
3. **起手牌**：每人 **27 张**。
4. **出牌顺序**：逆时针（或固定顺时针，按客户端一致即可），**头游后的下家先出**；每局首发由特殊规则决定（见 §1.6）。
5. **胜负**：先「打过 A」的一方获胜整场（match）。

### 1.2 牌面大小（非级牌情况下）

从小到大：
```
3 < 4 < 5 < 6 < 7 < 8 < 9 < 10 < J < Q < K < A < 2 < 小王 < 大王
```

> 注意：**2 并不是最大点数**——2 之上还有小王、大王、以及「当前级牌」（见下）。

### 1.3 级牌（关键规则）

- 每队在开局约定一个「当前级牌」，**起始打 2**。
- 级牌的**所有 4 张**（本局两副牌里，该点数的 ♠♥♣♦ 共 8 张里的双方「各自」4 张，实际上 **在牌堆里共 8 张级牌**）点力被抬升到：
  
  比 **A** 大，比 **小王** 小（不同队的级牌点力处理见下行）。
- 本实现规则采用「**全场统一级牌**」简化：*本局由本局**庄家队**的级牌为准*（双方级牌不同时，常见地方规则中只有庄家队级牌被抬高；为降低实现复杂度，本实现第一版**全场只使用一个级牌**，即庄家队的级牌）。
- **红心级牌（♥× 当前级数）**：一局内 **2 张**。它们：
  - 点力等同其它 3 张同点级牌（都比 A 大、比小王小）；
  - **可作为万能百搭**，在组牌时替代除大/小王外的任意一张。

  例：打 7 时，♥7 既可当作 ♥7 组「级牌对」，也可以当作 3、K、A、♠Q 之类的任意一张参与顺子/三带/飞机等。
- **可组合范围（本实现最终口径）**：
  - 红心级牌**不能**参与**天王炸（见 1.4.10）**；
  - 红心级牌**可以**参与**同花顺**（只要它替代的那张在对应花色的连续位置上即可；它自身是 ♥，因此只有「替代非 ♥ 花色的同花顺」时才是真正的「百搭」，否则它就是本色一张）；
  - 红心级牌可以参与普通 n 炸（n≥4）的 1–2 张替代；
  - 红心级牌用于非炸弹牌型时不改变牌型结构，仍只计 1 张；
  - 同一牌型里最多**同时使用 2 张红心级牌**（因为总共只有 2 张）。

### 1.4 牌型

| # | 名称 | 张数 | 形态 | 例 |
|---|------|------|------|----|
| 1 | 单张（Single） | 1 | 任意 1 张 | ♣5 / 大王 |
| 2 | 对子（Pair） | 2 | 同点 2 张 | 55 |
| 3 | 三同张（Triple） | 3 | 同点 3 张 | 777 |
| 4 | 三带二（Full House） | 5 | 三同张 + 对子 | 77788 |
| 5 | 顺子（Straight） | 5 | 连续 5 张点数，**最小 34567、最高顶 TJQKA**；**A 只顶不接 2** | 34567 / TJQKA |
| 6 | 连对（Tube / 木板） | 6 | 连续 3 对 | 445566 |
| 7 | 钢板（Plate） | 6 | 连续 2 个三同张 | 333444 |
| 8 | 同花顺（Straight Flush，称「火箭/同花顺炸」） | 5 | 顺子 + 同花色 | ♠3♠4♠5♠6♠7 |
| 9 | 炸弹（Bomb） | ≥4 | 同点 n 张，n=4,5,6,7,8…（可到 8，含百搭） | 4444 / 55555 / 666666 |
| 10 | 天王炸（King Bomb） | 4 | 2 小王 + 2 大王 | 小小大大 |

**说明**：
- **顺子**：严格 5 张，点数连续；**A 只能作最大顶**（`TJQKA`），**不允许 A-2-3-4-5**。因此顺子主点数范围是 `7..A`（共 5 档）。
- **连对、钢板**：同样以 **3 为最低**、**A 仅作顶**（A 不接 2）。连对范围 `5..A`（4 档）、钢板范围 `4..A`（11 档）。
- **级牌（包括红心级牌）不能作为顺子 / 连对 / 钢板的「点数来源」参与顺序排列**（级牌点力被抬高，不再位于原 3–A 序列中）；但**红心级牌作为百搭可替代顺子 / 连对 / 钢板中缺失的一张/一对非级牌点**。
- **同花顺**：5 张同花色顺子，花色可为 ♠♥♣♦ 任一；主点数范围与普通顺子相同（`7..A`）。允许用 ≤2 张红心级牌做百搭——它既可以作为♥花色顺子的「本色一张」，也可以替代其他花色顺子中缺失的一张点数（此时仍计作该位置的花色，满足「全部同花」）。
- **三带二**：三同张与对子分别计算，比较时只比三同张点；对子不可为王（`小王 小王` 仅能作「小王对」单独出，不是「带」的 pair）。

### 1.4.1 「大」的顺序（仅在比大小时使用）

- 非炸弹牌型：仅同型同长度（同张数）之间可比；比较主点数（Straight/Tube/Plate 取最大点，三带二取三同张点）。
- 炸弹（Bomb 与 Straight Flush、King Bomb）之间的相互压制，见 §1.5。

### 1.5 比大小与「炸弹链」

从小到大：

```
普通 4 炸 <
普通 5 炸 <
同花顺（5 张）<
普通 6 炸 <
普通 7 炸 <
普通 8 炸 <
天王炸（最大，永远压一切）
```

**同张数**的炸弹之间按点数大小比：4444 < 5555 < … < AAAA < 2222 < **（级牌 8 张）** < 小王 4 张 ≈（注：实现见下）。

> 说明：小/大王的 4 张（同点）炸弹在某些地方被当做 4 炸处理；小 4 大 4 之间大 > 小。**本实现规则**：小王 4 炸、大王 4 炸都属于普通 4 炸，点数值分别为 **rankValue(小王)=15、大王=16**。天王炸仅指 **2 小王 + 2 大王** 的特殊 4 张组合。

**规则**：

1. **跟牌必须同型同长**；否则必须出**能压它的炸弹链**中更大一档。
2. 炸弹链中**大张数**压**小张数**；同张数比点数。
3. **同花顺**恒压任何**普通 4 炸、5 炸**，但被 **6 炸及以上 / 天王炸** 压。
4. **天王炸**压一切。
5. **过（Pass）**：非首家可选过；首家必须出牌（出完胜出除外）。
6. **一圈全过回到最后出牌者**，由其重新**自由出**（领出）。

### 1.6 一局的流程

1. **洗牌、发牌**：108 张洗牌，每人 27 张。
2. **确定本局级牌与庄家**：
   - 开场第一局：级牌固定为 **2**；由上一场结果或随机指定**双方各自的庄家**；第一局可默认「座位 0 先出」。
   - 此后每局：**由头游决定**（详见升级 §1.7）。
3. **贡牌阶段**（**非第一局**才有）：
   - **单贡**（上局头游、二游不同队，即「单下」）：上局**末游**将自己手中**最大的一张非红心级牌**（大王 > 小王 > 级牌 > A > …）进贡给上局**头游**。头游从手中**挑一张点数 ≤ 10（含 10）的牌**还回（可还任意花色）。
   - **双贡**（上局**头游+二游**同队，即「双下」）：末游与三游**各进贡一张最大牌**给头游与二游；头游、二游各还一张 ≤ 10 的牌。
   - **抗贡**：若贡牌方手中握有**2 张大王**（双贡时任一家握有 2 张大王即可抗贡整桌），本局免贡；**当有一方抗贡成功，由上局末游先出**（否则由上局头游先出）。
4. **出牌阶段**：从先出者开始，按序轮转（遇到已胜出者跳过）。
5. **结束判定**：只要**某一队两人都出完**，本局结束，确定 1/2/3/4 名。
6. **升级结算**：按名次组合升级（见 §1.7）。
7. **准备下一局**：刷新级牌 / 庄家，回到 §1.6.2。

### 1.7 升级规则

以 **头游所在队** 为结算对象：

| 头游队友名次 | 说明 | 升级数 |
|--------------|------|--------|
| 二游 | 「双上」，对手最弱 | **+3 级** |
| 三游 | 对手一人先出 | **+2 级** |
| 末游 | 对手已拿二游 | **+1 级** |

**输方不升级**。升到 **A** 后必须**再以 A 级牌赢一局（本队拿到头游）** 才算毕业，即「过 A」；若打 A 没赢，级牌原地不变继续打 A，**若输方当局是末游、二游位置不变通过 A 这局**等具体判定见「变体与可选规则」。

### 1.8 规则口径汇总（已确认 / 变体）

**已确认（本实现）**：

| 项 | 口径 |
|----|------|
| 级牌范围 | 双方各自级牌独立记录，**本局以庄家队级牌为全场级**；另一队级牌不抬高点力（非级牌） |
| 顺子 / 连对 / 钢板 | **A 只顶不接 2**；最小顺子 `34567`，顺子主点 `7..A` |
| 红心级牌参与同花顺 | **允许** 1–2 张作为百搭（花色视为对应同花顺的花色） |
| 红心级牌参与天王炸 | **不允许**（天王炸仅 `2 小王 + 2 大王`） |
| 红心级牌参与普通 n 炸 | **允许** 1–2 张替代 |
| 过 A | 必须「打 A 这局拿头游」才过；否则级牌停在 A，继续打 A |
| 输方升级 | 不升级（卡在当前级） |
| 贡牌最大牌判断 | 按 `rankValue` 降序取**最大**，**红心级牌不参与被贡**（即使点力为 14，也跳过）；若剩余全部是红心级牌（极罕见）则贡一张红心级牌 |
| 还贡 | 从「点数 ≤ 10」的牌中任选一张；客户端默认建议「最小点数」的一张 |

**待后续可切换（本版本不开放）**：

| 项 | 备选 |
|----|------|
| 双方级牌同时抬高 | 更贴近线上玩法；需要 `rankValue` 接受双 `levelRank` 入参 |
| A-2-3-4-5 顺子 | 需要在 `rules.ts` 顺子枚举里额外允许这一档 |
| 托管 / 超时策略 | M4 里加「超时 Pass / 超时贡最大 / 超时还最小」 |

---

## 2. 工程总览

### 2.1 在通用后端中的定位

沿用 `GENERIC_BACKEND_DESIGN.md` 的模式 **A（每游戏独立 RPC 队列）** + **C（可在 `registerMatchmakerMatched` 内分流）**。
本游戏的所有服务端代码位于 **`Modules/src/games/guandan/`**，`tsconfig.json` 的 `files` 数组按下列顺序追加；入口注册只在 **`main.ts` 的 `InitModule`** 内追加 `initializer.register*` 几行。

### 2.2 命名空间（全局唯一）

| 资源 | ddz | guandan（新） |
|------|-----|---------------|
| Match label | `"ddz"` | `"guandan"` |
| Storage collection（匹配队列） | `ddz_mm` | `guandan_mm` |
| Storage collection（段位/历史，可选） | - | `guandan_rank` |
| RPC 前缀 | `ddz_mm_*` | `guandan_mm_*` |
| Opcode: 快照 / 错误 / 结算 | 101 / 102 / 120 | **201 / 202 / 220** |
| Opcode: 客户端请求 | 10–14 | **30–39** |
| AI match entity | `ddzAiServer` | `guandanAiServer` |

> **为什么错开 opcode？** 客户端 `online_session.gd` 目前把 101/102/120 直接 emit 给 `match_ddz_server`；我们将在客户端加 `match_gd_server` 一路，用 201/202/220。避免与 ddz 快照混淆、便于同一客户端同时观察两个玩法（目前不会同时存在，但隔离更安全）。

### 2.3 目录结构（新增）

```
Modules/src/games/guandan/
  match_state.ts     # const / enum / interface GdMatchState
  rules.ts           # 牌型识别、比大小、百搭匹配
  match_logic.ts     # 发牌、贡牌、轮转、结算、升级、AI 调度
  match_handler.ts   # Nakama Match Handler（matchInit/Join/Leave/Loop/Signal/Terminate）
  mm_queue.ts        # 自建队列 RPC：guandan_mm_join/poll/cancel
  ai_server.ts       # 服务端补位 AI（启发式）
scripts/guandan/
  card_defs.gd       # 0–107 id → (suit, rank) 映射；红心级牌标记
  rules.gd           # 与服务端 rules.ts 对齐的本地规则工具
  hand_sort.gd       # 按级牌抬高后的点力排序
  net_sync.gd        # Nakama RT 回调→本地状态机
  match_replica.gd   # 本地影像（hand、turn、last、phase、level_card…）
  main.gd            # 主场景状态机 + UI（对应 scenes/guandan/main.tscn）
  ai.gd              # 单机/离线调试用 AI（联机时实际由服务端 AI 触发）
scenes/guandan/
  main.tscn          # 4 人桌
  start_menu_entry   # 在 start_menu.tscn 里新增入口按钮
```

> **构建**：`tsconfig.json` 的 `files` 追加在 `mm_queue.ts` 之后、`main.ts` 之前：

```
./src/games/guandan/match_state.ts
./src/games/guandan/rules.ts
./src/games/guandan/match_logic.ts
./src/games/guandan/match_handler.ts
./src/games/guandan/mm_queue.ts
```

`games/guandan/ai_server.ts` 与 ddz 同策略放在 `main.ts` 之后（依赖前向全局符号）。

### 2.4 `main.ts` 注册增量

```ts
// 在现有 ddz 注册之后
initializer.registerMatch("guandan", guandanMatchHandler);
initializer.registerRpc("guandan_mm_join", rpcGuandanMmJoin);
initializer.registerRpc("guandan_mm_poll", rpcGuandanMmPoll);
initializer.registerRpc("guandan_mm_cancel", rpcGuandanMmCancel);
```

**关于 `registerMatchmakerMatched`**：Nakama 限制只能注册一个回调。当前 ddz 的回调固定 `matchCreate("ddz", …)`；加入掼蛋后改为：

```ts
initializer.registerMatchmakerMatched(function (ctx, logger, nk, matched) {
    // 读取 matched.users[i].stringProperties["game"]（或 query）分流
    const game = matchmakerPickGame(matched); // "ddz" | "guandan"
    if (game === "guandan") {
        return nk.matchCreate("guandan", { expect_humans: String(matched.length) });
    }
    return nk.matchCreate("ddz", { expect_humans: String(matched.length) });
});
```

> 客户端短期只用**自建 RPC 队列**，上述分流仅为将来 `add_matchmaker_async` 路径留门。

---

## 3. 数据与协议

### 3.1 卡牌 id（服务端/客户端统一）

掼蛋 108 张，采用 **`0..107` 线性 id**：

```
deck 1: id  0..53  （与斗地主一致：0..51 花色牌、52 小王、53 大王）
deck 2: id 54..107 （与 deck 1 完全同义，+54 偏移）
```

帮助函数（TypeScript / GDScript 逻辑相同）：

```
function baseId(id) { return id < 54 ? id : id - 54 }
function rawRank(id) { return baseId(id) < 52 ? baseId(id) % 13 : 13 + (baseId(id) - 52) }
// rawRank: 3→0 … A→11 … 2→12 … 小王→13 … 大王→14
function suit(id)    { const b = baseId(id); return b < 52 ? Math.floor(b / 13) : -1 } // 0=♠ 1=♥ 2=♣ 3=♦ -1=王
function isHeartLevelCard(id, levelRank) { return suit(id) === 1 && rawRank(id) === levelRank }
```

**`rankValue(id, levelRank)`**（用于比大小的点力）：

| 情况 | 返回值 |
|------|--------|
| 大王 | 16 |
| 小王 | 15 |
| `rawRank == levelRank`（级牌，含 ♥ 级牌） | **14** |
| `rawRank == 12`（2） | 13 |
| `rawRank == 11`（A） | 12 |
| 其它 `rawRank r`（3–K） | `r`（0–10） |

> 与斗地主共用的 `card_defs.gd` 不扩展；在 `scripts/guandan/card_defs.gd` 里独立实现，避免污染 ddz 使用。

### 3.2 服务端状态（`match_state.ts`）

```ts
type GdPhase =
  | "waiting"       // 等玩家/AI 补位
  | "deal"          // 发牌动画窗口
  | "tribute_wait"  // 贡牌（等待末/三游点选最大牌，允许抗贡）
  | "return_wait"   // 还贡（等头/二游选 ≤10 的牌）
  | "play"          // 正常出牌
  | "finished";     // 本场升到毕业

interface GdHandPattern {
  kind: number;           // GD_KIND_*
  main: number;           // 主点力（按 levelRank 抬高后的 rankValue）
  len: number;            // 牌张数（或顺子长度等）
  // 炸弹链比较辅助
  bombTier: number;       // 0=非炸 1=4炸 2=5炸 3=同花顺 4=6炸 5=7炸 6=8炸 7=天王炸
  wildUsed: number;       // 本手用了几张红心级牌当百搭
}

interface GdTeam {
  seats: [number, number];  // 0&2 or 1&3
  level: number;            // 当前级牌 rawRank：2→0, 3→1 ... 2 表示 "打4"
  overALocked: boolean;     // 已升到 A，等待「过 A」
}

interface GdMatchState {
  presences: { [userId: string]: nkruntime.Presence };
  seatByUserId: { [userId: string]: number }; // 0..3
  isAiSeat: boolean[];
  expectHumans: number; // 1..4（剩余由 AI 补）
  phase: GdPhase;

  // 队伍（常驻整场）
  teams: [GdTeam, GdTeam];  // teams[0] = 座位 0/2；teams[1] = 座位 1/3
  dealerTeam: number;       // 本局以该队级牌为全场级牌；0 或 1
  levelRankActive: number;  // 本局生效级牌（来自 teams[dealerTeam].level）

  // 发牌
  hands: number[][];        // 4 × 27
  dealTrace: { seat: number; card: number }[]; // 客户端可播发牌动画

  // 贡/还贡
  tribute: {
    mode: "none" | "single" | "double" | "resist";
    // 单贡：payers=[末游] receivers=[头游]；双贡 payers=[三游,末游] receivers=[头游,二游]
    payers: number[]; receivers: number[];
    given: { [seat: string]: number };   // seat -> cardId（已进贡完成）
    returned: { [seat: string]: number };// seat -> cardId（已还贡）
    pendingPayer: number;    // -1 表示不等
    pendingReceiver: number; // -1 表示不等
  };

  // 出牌
  turn: number;                  // 当前应出牌座位
  finishedOrder: number[];       // 本局已出完的座位顺序（1→4）
  lastPattern: GdHandPattern | null;
  lastPlayer: number;
  lastPlayIds: number[];
  passes: number;

  // 比赛层
  lastRoundWinnerSeat: number;   // 上一局头游，用于下一局首出
  lastRoundSingleDown: boolean;  // 上一局是否单下（决定贡牌模式）
  lastRoundDoubleDown: boolean;

  // 节奏
  seq: number;
  aiPlayDelayUntilMs: number;

  // 结算
  winnerTeam: number;            // -1 未定；0/1 已毕业

  errorLog: string[];
}
```

### 3.3 Opcode / REQ

服务端 → 客户端：

| Opcode | 名称 | 负载主要字段 |
|--------|------|---------------|
| **201** `GD_OP_SNAPSHOT` | 对局公共快照 | `phase / level / dealer / turn / last / finishedOrder / seatCats / tribute / handsLens / selfHand` |
| **202** `GD_OP_ERROR` | 错误（非法出牌、不在回合等） | `code / msg` |
| **220** `GD_OP_SETTLEMENT` | 本局结算 | `order / tributeNext / levels / winnerTeam / overA` |

客户端 → 服务端（`send_match_state_raw_async(op_code=REQ, …)`）：

| Opcode | 名称 | 负载 |
|--------|------|------|
| **30** `GD_REQ_PLAY`          | 出牌 | `{ ids: int[], pattern_hint?: {…} }` |
| **31** `GD_REQ_PASS`          | 过 | `{}` |
| **32** `GD_REQ_TRIBUTE`       | 贡牌 | `{ id: int }` |
| **33** `GD_REQ_TRIBUTE_RESIST`| 声明抗贡（有双大王时） | `{}` |
| **34** `GD_REQ_RETURN`        | 还贡 | `{ id: int }` |
| **35** `GD_REQ_CONTINUE`      | 结算后点「继续」 | `{}` |
| **36** `GD_REQ_DECLARE_WILD`  | 出牌中声明红心级牌替代哪张 | `{ wild_ids: int[], as_cards: [{rank:int, suit:int}] }` |

**关于 `GD_REQ_DECLARE_WILD`**：只在客户端组出牌时把红心级牌当百搭使用时必须一并发送，指明它在本手中扮演什么牌（服务端依据此声明与 `rules.ts` 校验）。若客户端未声明但仍出含 ♥ 级牌的手，服务端尝试**自动最优替代**（按「使牌型成立且主点数最小」策略）；不成功则报 `GD_OP_ERROR`。

> Opcode 201/202/220/30–36 **全局唯一**，与 ddz 101/102/120/10–14 不冲突。

### 3.4 快照 JSON（示例）

```json
{
  "v": 1,
  "phase": "play",
  "dealer_team": 0,
  "level_active": 4,         // rawRank（如"打 7" → 4）
  "levels": [4, 2],          // teams[0..1].level
  "turn": 2,
  "last": { "player": 1, "kind": 4, "main": 8, "len": 3, "ids": [...], "wild_used": 0 },
  "hand_lens": [17, 20, 0, 21],
  "finished": [2],
  "self_seat": 0,
  "self_hand": [0, 3, 5, 7, 8, 23, 54, 57, ...],
  "seat_cats": [0, 1, 2, 0],
  "tribute": null,
  "seq": 1234
}
```

---

## 4. 规则层（`rules.ts` / `rules.gd`）关键算法

### 4.1 牌型识别

入参：`ids: number[]`、`levelRank: number`。步骤：

1. 分离 `wilds`（♥级牌）与 `normals`（其它 106 张）。
2. `n = ids.length`，快捷路径：
   - `n == 1` → SINGLE；若 `isKingBombCandidate(ids)` 先尝试天王炸。
   - `n == 2` → PAIR（同 rawRank；双王不作对）。
3. `n == 4` 时优先试 **天王炸**（2 小王 + 2 大王），再试 4 炸。
4. **炸弹识别**：`normals + wilds` 同 rawRank → 4..8 炸。若 `wilds.length > 0` 但仍满足 `normal rank 全相同` 即可；**天王炸不允许 wild**。
5. **同花顺**（允许 ≤2 张红心级牌做百搭）：`n == 5` 且 `wilds.length <= 2`，枚举**顶点 top ∈ {7..A}**（rawRank 4..11）、花色 s ∈ {♠,♥,♣,♦}：
   - 目标位为 5 个点数 `[top-4, top-3, top-2, top-1, top]`（严格不过顶，A 即 rawRank 11）；
   - `normals` 中花色为 s 且 rawRank 落在目标位的牌逐一命中对应位置；
   - 未命中的位置由 wilds 补齐（每张 wilds 填一个空位；wilds 本身是 ♥，但**作为百搭时花色视为 s**，以满足同花约束）；
   - 若 `s == ♥` 且目标位含红心级牌**原本点数（即 rawRank == levelRank）**：此情形在本实现中**禁止**——因为该位置应是一张 `♥×levelRank` 的「非级牌」，但该花色点数已被抬成级牌，矛盾；换言之：**当级牌点力恰好落在顺子序列内时，该花色的同花顺该序列不可成立**（例：打 7 时，♥ 花色的 34567/45678 等含位置 7 的 ♥ 同花顺无法构造）。
6. **三带二 / 顺子 / 连对 / 钢板**：统一先枚举「候选主点」，再用百搭填 0–wilds 个空位。由于每类形态点数 ≤6、百搭 ≤2，暴力枚举即可（组合数 ≤ O(8)）。**顺子/连对/钢板的点序列里不能含 `levelRank`（级牌已被抬点，不在原 3–A 序列）**；百搭填位填的是「非级牌点」。
7. 输出 `GdHandPattern`；设 `bombTier`：
   - 普通 4 炸 = 1；5 炸 = 2；同花顺 = 3；6 炸 = 4；7 炸 = 5；8 炸 = 6；天王炸 = 7。

> **建议工程化**：把第 6 步的「带百搭的组合识别」做成统一辅助 `tryWithWilds(patternShape, normals, wilds)`，其中 `patternShape` 是一组 `(rank, count)` 目标模板。

### 4.2 比大小 `beats(last, cur, levelRank)`

```
if cur.kind == INVALID: false
if last.kind == PASS:    cur != INVALID
if cur.bombTier > 0 && last.bombTier > 0:
    if cur.bombTier != last.bombTier: return cur.bombTier > last.bombTier
    return cur.main > last.main         // 同 tier 比点（天王炸双方都 tier=7 但只可能一手）
if cur.bombTier > 0 && last.bombTier == 0: return true
if cur.bombTier == 0 && last.bombTier > 0: return false
if cur.kind != last.kind || cur.len != last.len: return false
return cur.main > last.main
```

### 4.3 合法性校验（服务端权威）

- 手牌包含所出的所有 id；
- 牌型识别结果非 INVALID；
- 与 `last` 可比（当非首出时）；
- 若含 ♥级牌，客户端 `GD_REQ_DECLARE_WILD` 声明（若缺省则服务端自动分配）。

---

## 5. Match Handler 主流程

### 5.1 `matchInit`

- 读取 `params.expect_humans`；
- `teams = [{seats:[0,2], level:12, overALocked:false}, {seats:[1,3], level:12, overALocked:false}]`（**`level` 字段存 rawRank**：按 §3.1 编码 3=0 … A=11、2=12。起始「打 2」故 `level=12`）；
- `dealerTeam` 随机；`levelRankActive = teams[dealerTeam].level = 12`。
- 升级时 `level` 的走法（注意不是线性 +n）：`2 → 3 → 4 → … → A`，rawRank 轨迹为 `12 → 0 → 1 → 2 → … → 11`。因此实现升级推进建议用显式 `nextLevel(rank, step)` 查表：`order=[12,0,1,2,3,4,5,6,7,8,9,10,11]`，在其中以当前档位为索引 `idx`，取 `order[min(idx+step, order.length-1)]`（卡在 A=11 上等待「过 A」）。

### 5.2 `matchJoinAttempt` / `matchJoin`

- 按加入顺序占 0..3 座；满 `expectHumans` 后**不立即开局**，等待 `AI_FILL_DELAY_MS`（≈ 8–12s）让同队列的玩家也有机会加入；
- 到时仍缺人，`isAiSeat[...]=true`，推进到 `phase=deal`。

### 5.3 `matchLoop`

每 tick：

- 若 `phase == deal` → 发牌→生成 `dealTrace`→进入 `tribute_wait`（首局跳过直接 `play`）。
- `phase == tribute_wait / return_wait`：处理 AI 自动贡 / 还贡；玩家未响应在 `TRIBUTE_TIMEOUT_MS`（30s）后**自动选择最大牌 / 最小合法牌**。
- `phase == play`：
  - `turn` 是 AI 座位 → `ai_server.decide(...)`；
  - 超时 `PLAY_TURN_TIMEOUT_MS`（30s） 后**自动过**（首家自动出最小合法单张）。
- 任何阶段产生新事件 `seq++`，广播 `GD_OP_SNAPSHOT`。

### 5.4 `matchSignal` / RPC 处理

通过 `send_match_state_raw_async` 接收 REQ。单独函数校验→修改 state→广播。

### 5.5 本局结算（`finalizeRound`）

1. 统计 `finishedOrder` → 1/2/3/4 名；
2. 判断「单下/双下」→ 下一局贡牌模式；
3. 调用 `applyLevelUp(teams, order)`：
   - 头游队友名次 2 → +3
   - 名次 3 → +2
   - 名次 4 → +1
   - **过 A**：若头游队 `teams[t].level == rawA(=11)`（即上一局就是打 A）且本局头游属于 t，才算毕业；否则 level 停在 11（继续打 A）。
4. 构造 `GD_OP_SETTLEMENT` 广播；
5. 三人点「继续」（`GD_REQ_CONTINUE`）后 `phase = deal` 开新局。

---

## 6. 匹配队列（`mm_queue.ts`）

模板**完整复制** ddz `mm_queue.ts`，改：

```
DDZ_MM_COLLECTION         → "guandan_mm"
DDZ_MM_STATE_KEY          → "queue_state"
ddzmm_ 前缀               → "gdmm_"
ddzMmProcessQueueCore     → 4 人成局；累计 ≥4 即 matchCreate("guandan", expect_humans=4)
                            仅 2–3 人等待超过 GD_MM_WAIT_MS（例如 30s）时，用 AI 补位开局
rpcDdzMmJoin/Poll/Cancel  → rpcGuandanMmJoin/Poll/Cancel
```

关键数字：

| 常量 | 值 | 说明 |
|------|----|------|
| `GD_MM_WAIT_MS` | 30000 | 单人/2–3人等 30s 后用 AI 补位 |
| `GD_MM_MAX_AI` | 3 | 最多 3 个 AI（至少 1 个真人） |

---

## 7. 服务端 AI（`ai_server.ts`）

- **目标**：跟 ddz AI 同一量级的成本（启发式，单次决策 <5ms）。
- **输入**：`state` + `self seat` + `levelRank`。
- **输出**：`PLAY` / `PASS` / `TRIBUTE choice` / `RETURN choice`。

### 7.1 叫牌层不需要

掼蛋不像斗地主有叫地主，首局随机庄家或沿用上一场末游；**无叫倍**。

### 7.2 出牌策略（v0）

1. **把手牌按牌型预拆**：  
   先拆出所有「炸弹 / 同花顺 / 天王炸」→ 保留；  
   剩余部分贪心拆顺子（长度≥5）→ 连对（≥3 对）→ 钢板（≥2 个 3 同张）→ 三带二 → 三 → 对 → 单。
2. **首出（free lead）**：选**张数最多且非炸弹**的一手。
3. **跟牌**：
   - 枚举「能压 `last` 的最小同型手」；
   - 若没有、手数少且对家已出完：可考虑炸；
   - 否则过。
4. **红心级牌（百搭）**：
   - 只在没有同 rawRank 的原牌时替代；
   - 组炸优先保留到「必须炸」时用。
5. **配合**（队友）：
   - 若 `lastPlayer` 是队友且为 free lead，不主动盖（除非手里只剩大牌）；
   - 末游/三游已确定时专攻出完速度。

### 7.3 贡牌/还贡

- 贡最大：按 `rankValue(id, levelRank)` 降序，排除 `isHeartLevelCard` 后取第一；若全部是红心级牌（罕见），则贡一张红心级牌。
- 抗贡：若手中大王数 ≥2，自动 `GD_REQ_TRIBUTE_RESIST`（双贡按规则任一付方有 2 大王也抗贡）。
- 还贡：从 `<=10` 的牌里选**花色最多**或**对己拆牌损伤最小**的那张（先简化为「随机选点数最小的一张」）。

> v1 AI 先实现 §7.2~§7.3 的朴素版，目标是能完整跑完一局即可；强度调优另起迭代。

---

## 8. 客户端（Godot）

### 8.1 `scripts/online_session.gd` 增量

```gdscript
# —— 掼蛋服务端权威常量 ——（与 ddz 并列）
const GD_OP_SNAPSHOT := 201
const GD_OP_ERROR := 202
const GD_OP_SETTLEMENT := 220
const GD_REQ_PLAY := 30
const GD_REQ_PASS := 31
const GD_REQ_TRIBUTE := 32
const GD_REQ_TRIBUTE_RESIST := 33
const GD_REQ_RETURN := 34
const GD_REQ_CONTINUE := 35
const GD_REQ_DECLARE_WILD := 36

# 新增一路服务端事件信号
signal match_gd_server(op_code: int, data: Dictionary)
```

在 `_on_rt_match_state` 里：

```gdscript
if opc == GD_OP_SNAPSHOT or opc == GD_OP_ERROR or opc == GD_OP_SETTLEMENT:
    match_gd_server.emit(opc, dict)
    return
```

> 现在 ddz 和 guandan 是「同客户端二选一」，未来如果 `AUTHORITY_GAME_MATCH_LABEL` 需要按入口切换，引入 `current_game_id` 成员变量，`start_matchmaking_authoritative_async()` 里用 `RPC_MM_JOIN_TABLE[current_game_id]`。

### 8.2 新场景 `scenes/guandan/main.tscn`

- **顶部**：对家（座位 2 / 玩家对面），小头像+手牌张数；
- **左右**：两边队友/对手，小头像+张数；
- **底部**：本人手牌扇形（+选牌高亮），出牌 / 过 / 提示 按钮；
- **中央**：本轮最后一手（`lastPlayIds`），左右两侧显示「桌上还在本圈的人」；
- **右上**：当前级牌（例如「打 7」）、两队级别条；
- **状态层**：贡牌面板（等待对话框）、结算弹窗。

### 8.3 本地规则层 `scripts/guandan/rules.gd`

- 与 `rules.ts` **保持同逻辑**，用于本机组牌高亮、「提示」预选、合法性预判（服务端仍为权威）。
- 每次 `levelRankActive` 变化后重新构建「点力表」并对手牌排序。

### 8.4 入口

- `scenes/start_menu.tscn` 增加一个「掼蛋（联机）」按钮（`scripts/start_menu.gd` 内以 `current_game_id = "guandan"` 进入匹配流）。
- 暂不提供单机 4 人演示（可作 M3）。

---

## 9. 钱包与段位

### 9.1 钱包结算

对齐 ddz，`GD_OP_SETTLEMENT` 附带 `delta_per_seat: int[4]`。客户端仍走 `RPC_WALLET_APPLY_DELTA`。

- 推荐初版：
  - 升 3 级（双上）：头游 / 二游 各 +1000；三游 / 末游 各 –500
  - 升 2 级：头游 +600、二游 +200、三游 -200、末游 -600
  - 升 1 级：头游 +400、二游 +100、三游 +100、末游 -600
  - 毕业（整场胜）：头游方额外 +2000。

### 9.2 段位（可选 M3）

Storage collection `guandan_rank`：记录「当前进度级、最高级、毕业次数」，供大厅 / 战绩页读取。

### 9.3 掼蛋 AI 能力分级与强化路线

当前实现（`Modules/src/games/guandan/ai_server.ts`）已具备：**领出**（小单/对/三/王/炸）、**跟牌**（单/对/三/炸弹/天王炸、顺子/连对/三带等子集爆搜 + 大炸兜底），以及贡/还/抗。仍显「呆」主要因为 **缺少 2v2 配合与长程规划**。

| 能力层 | 含义 | 落地思路 |
|--------|------|----------|
| **L0 规则不犯错** | 只出合法牌、不拆错炸 | 已由 `rules.ts` + 现有 `gdAiPickPlay` 覆盖；继续靠单测锁回归。 |
| **L1 记牌 + 场况** | 己手 + 明牌/贡还信息 + 各席已出张数，推断未现大牌概率 | 在 `GdMatchState` 或 AI 层维护 `playedMask`；跟牌时避免无谓小牌送对手、终局不剩怪牌。 |
| **L2 队友协同** | 认队友、**送游**（队友剩少张时出小/让牌权）、**卡下家**（对手大贡方压牌） | 在 `free lead` 与 `pass` 决策增加 `teamMatesCardsEst / opponentThreat` 启发：队友 ≤6 张时优先生单张小牌或顺过；上家为对手大牌时少浪费炸弹。 |
| **L3 牌型价值** | 长牌/钢板/同花顺的期望墩值，拆与不拆 | 对当前手牌做多方案 simulate 1 墩（蒙特卡洛或查表）选期望损失最小。 |
| **L4 残局** | 双方牌极少时的穷举/DP | 手牌张数 ≤8 时切换精确搜索。 |

**推荐迭代顺序（与客户端「智能托管」体验挂钩）：** 先 **L1 记牌**（成本低、立即可感）→ **L2 送游启发**（掼蛋灵魂）→ 再视性能做 **L3**，最后残局 L4。实现上可保持 `gdAiPickPlay` 为壳，在 `free lead` / `follow` 前插入「重排序候选」层，不破坏现有 `gdApplyPlay` 管线。

**已落地（`ai_server.ts`）：** `gdTallyVisibleRanksInHandsAndTable` + `gdGhostRanksDealtOrPlayed` 作记牌面；`gdAiIsPartnerControllingTrick`：跟牌时若当前赢家是队友则 **不压、直接 pass**（送游核心）。`gdAiPickPlay` 里保留 `ghost` 供后续「敢不敢上炸」等扩展。领出仍用原「小单→对→三→王→炸」序，可继续按 `_mateHandLen` 做细调。

**L3 + L4（已落地，见 `ai_server.ts` 注释与实现）：**  
- **L3**：`gdAiEvaluateRemainingHand` + `gdAiFollowPlayPenalty` / 领出 `gdAiLeadFreeBonus`；`gdAiPickBestPlayL3` 在**多候选**中择优。`gdBruteFindAllBeatingPlays` + `gdAiBruteBestBeatingL3`（手牌 `≤10` 张时枚举多解，否则退回「找第一个能压」）。`gdAiFollowBombCandidates` 覆盖「非上家为炸时**所有**可压原生炸/天王」再 L3 选。  
- **L4**：`gdAiTryFreeLeadL4` 在 **手牌 ≤12 张** 时对自由领出做 **2^n 子集** 枚举，有 **一手出完** 则直接出；同花顺/天王/复杂压牌在炸链分支前**先试** L3 爆搜。  

**复杂牌型领出 / 跟牌（扩展）：**  
- 领出统一分 `gdScoreFreeLeadIds`：在 L3 估值上增加 `gdLeadPatternTypeBonus`（顺子、连对、钢板、三带二、同花顺轻奖；动大炸仍罚）。  
- 手牌 **≤12**：子集穷举（原 8 张已扩至 12，即 4096 次以内）。手牌 **>12**：对 k=4…8 做组合枚举（有总步数上限），与 `gdAiLead` 基准三取一最高。  
- 跟牌 L3 增加 `gdFollowLinePatternBonus`，多解爆搜时略倾向顺、连对、钢板、三带二。  

（客户端可写「残局、多解跟牌有估值」等，避免承诺「全信息博弈最优」。）

---

## 10. 里程碑

| 里程碑 | 目标 | 交付 |
|--------|------|------|
| **M0** | 服务端骨架 + 本地规则 | `rules.ts` 牌型/比大小/单测；`match_state.ts`；`main.ts` 注册；RPC 能跑通；客户端仅打印快照 |
| **M1** | 完整单局 | 发牌、贡/还贡、出牌合法化、结算、升级；服务端 AI v0；4 人纯 AI 桌能跑到「打过 A」 |
| **M2** | 客户端完整 UI | 扇形手牌、选牌、百搭声明、贡牌 UI、结算动画、聊天 |
| **M3** | 匹配 & 队列 | `guandan_mm_*` 全链路、AI 补位超时、钱包结算接入 |
| **M4** | 段位/战绩 & 体验优化 | `guandan_rank`、断线重连、超时托管、手势动效 |

---

## 11. 参考 & 交叉引用

- 通用后端 [`Modules/GENERIC_BACKEND_DESIGN.md`](../Modules/GENERIC_BACKEND_DESIGN.md)
- 斗地主设计 [`docs/DESIGN.md`](./DESIGN.md)
- 入口与 RPC 约束：`Modules/src/main.ts`、`Modules/src/games/ddz/*`
- 客户端联机常量：`scripts/online_session.gd`
- 部署/排错：[`NAKAMA_DEPLOY.md`](../NAKAMA_DEPLOY.md)

---

## 12. 待定 / 风险清单

1. **百搭声明体验**：客户端要在选牌后给出「红心级牌替代成？」面板，交互成本略高，本版先走「服务端自动最优替代」（按「使牌型成立且主点最小、且允许成同花顺/炸时优先大牌型」的顺序枚举），待 M2 UI 再考虑主动声明。
2. **断线与托管**：M2 前，掉线玩家默认过 / 贡最大 / 还最小；完整体验见 M4。
3. **三人桌 / 两人桌变体**：当前设计只支持 4 人；若要复用 2v2 逻辑做「2 人简化版」需新增 match label `guandan2`。
4. **Nakama 超时**：Match Handler 的 `matchLoop` tickRate 建议与 ddz 对齐（1Hz 或 2Hz），避免额外 CPU。
5. **`registerMatchmakerMatched` 仅一个**：引入掼蛋后必须在这唯一回调里按 `matched` 属性分流到 `ddz` / `guandan`；若实现改动错漏，表现将是「匹配成功后加入到错误 label 的 Match」——务必在 M3 加入日志验证。
