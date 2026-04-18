# 斗地主（Godot）— 设计与实现说明

**文档版本**：与程序 **v1.0** 对齐。  
本文档描述 v1.0 的架构、规则范围与实现要点，供查阅与后续迭代参考。

---

## 1. 项目概览

| 项 | 说明 |
|----|------|
| 版本 | **1.0** |
| 引擎 | Godot 4.x（工程特征含 `4.6` / Forward Plus） |
| 玩法 | 三人斗地主；规则为代码内实现的牌型子集（见第 5 节） |
| 美术 | `CardsAssets/` 像素风牌面；`assets/avatars/` 角色头像 |
| 音频 | `audio/` 音效；`MusicAssets/` 开始菜单 BGM、对局 BGM（循环） |
| 启动 | `project.godot` → `scenes/start_menu.tscn` → 「开始游戏」→ `scenes/main.tscn` |

**v1.0 体验要点**：叫分/抢地主、猫草结算、三猫 AI 档位、人类提示出牌、出牌飞入桌面动画、对局日志、摸牌遮罩与发牌动画。

---

## 2. 目录与职责

```
CardGame/
├── project.godot
├── scenes/
│   ├── start_menu.tscn          # 开始界面
│   └── main.tscn                # 对局（手牌、叫分、出牌区、日志等）
├── scripts/
│   ├── start_menu.gd
│   ├── card_defs.gd             # CardDefs：牌 ID、点力、纹理
│   ├── deck.gd                  # 洗牌与发牌
│   ├── ddz_rules.gd             # Rules：牌型与 beats
│   ├── ddz_ai.gd                # AI：叫分/抢地主/跟牌、农民配合、省炸等
│   ├── ddz_ai_play.gd           # AI 首家出牌（按 ai_style）
│   └── main.gd                  # 对局状态机、UI、动画与结算
├── CardsAssets/                 # 卡牌 PNG
├── assets/avatars/              # 猫咪头像
├── audio/                       # 短音效（wav）
├── MusicAssets/                 # BGM（mp3）
└── docs/DESIGN.md               # 本文件
```

---

## 3. 界面与流程

### 3.1 开始界面

- 背景与装饰、标题「斗地主」、「开始游戏」进入对局。
- 使用 `MusicAssets/BGM.mp3` 作为菜单背景音乐（循环）。

### 3.2 术语：盘与局

- **一盘**：从进入对局主场景到返回开始菜单。**仅 `_ready` 时**随机三只猫的座位（`_shuffle_seat_cats`），**本盘内不换角**。
- **一局**：一次完整流程：发牌 → 叫地主/抢地主 → 出牌至胜出 → 结算。`_run_new_round`；「继续」「重新发牌」为**同一盘内的下一局**。

### 3.3 摸牌与叫地主

- 进入对局或「重新发牌」：`DealLayer` 摸牌遮罩约 1.65s，随后 `_run_new_round`。
- 展示底牌 → 三家叫 **0–3 分** → 最高分者为候选地主；可能进入 **抢地主**（每人一次机会，抢一次倍数 ×2）。
- 对局内使用 `MusicAssets/BGM2.mp3` 循环播放（`BgmPlayer`）。

### 3.4 角色与座位

- 座位 **0** 固定为人类操作位（下方），**1** 右上 AI，**2** 左上 AI。
- 猫咪 id：**丑丑妹(0)、咪宝(1)、毛睿睿(2)**，与 `CAT_NAMES`、头像一致；AI 行为与 **`style_from_cat_id`** 绑定：  
  **普通 / 凶**（咪宝）** / 怂**（毛睿睿）。

### 3.5 猫草与倍率

- 初始猫草 **5000**（`SCORE_START`）；结算按地主胜/负与农民胜/负规则增减（见 `main.gd` 常量）。
- **最终倍率** = **基础倍率（叫地主）** × **抢地主倍率** × **出牌加翻**（炸弹/王炸）。  
  - 叫地主选项为 **不叫 / 1倍 / 2倍 / 3倍**：三家都不叫时基础倍率为 **×1**；否则取本轮 **最高叫倍**（1～3）作为 `_mult_base`。  
  - 抢地主：每次抢 ×2，累乘为 `_mult_rob`。  
  - 出牌：炸弹每次 ×2、王炸每次 ×4，累乘为 `_mult_play`。  
  - 结算界面展示 **×基础 × 抢 × 出牌** 的明细与最终乘积。

---

## 4. 卡牌数据（`card_defs.gd`）

- 牌 ID **0–53**：四门花色 × 13 张 + 小王 52 + 大王 53。
- `ddz_rank_value`：3 最小 → 2 最大；王为 13、14。
- `texture_path_for` 映射至 `CardsAssets/`。

---

## 5. 规则层（`ddz_rules.gd`）

已实现牌型：`SINGLE`、`PAIR`、`TRIPLE`、`STRAIGHT`、`BOMB`、`ROCKET`、`TRIPLE_WITH_SINGLE`、`TRIPLE_WITH_PAIR`、`PAIR_STRAIGHT`、`FOUR_WITH_TWO`、`PLANE`（与代码中 `Kind` 一致）。

比大小：`beats(last, cur)` — 王炸 > 炸弹 > 同型比 `main`（及 `extra` 一致时）。

---

## 6. 发牌（`deck.gd`）

- 54 张洗牌；轮转发 17×3，底牌 3 张。

---

## 7. 对局状态机（`main.gd` 摘要）

- 核心变量：`_hands`、`_turn`、`_last`、`_last_player`、`_passes`、`_winner`、`_landlord`、`_seat_cat`、`_mult_base` / `_mult_rob` / `_mult_play`、`_round_multiplier`（三者之积）、`_match_round_index` 等。
- 人类出牌：`Rules.classify` + `Rules.beats`；**提示**按钮按当前座位猫咪档位调用 `DdzAi.find_free_lead` / `find_follow` 预选牌。
- **出牌动画**：`PlayAnimLayer` 上从手牌区/对手区飞向出牌区，落地后写入 `PlayCardsP*`；通过 **display/pending 签名** 避免仅「过」触发的重复刷新再次播动画。

---

## 8. AI（`ddz_ai.gd` + `ddz_ai_play.gd`）

- 叫倍/抢地主：基于 `hand_landlord_strength` 与档位阈值（仍输出 0～3，对应不叫与 1～3 倍基础）。
- 首家出牌顺序随 `ai_style`（凶/普通/怂）变化。
- 跟牌：农民配合、同型最小压、炸弹/王炸、省炸启发式。

---

## 9. 主界面 UI（v1.0）

- 顶栏对手、底部手牌扇形、出牌/提示/过/重新发牌（大尺寸按钮）、底牌、叫分、抢地主、日志、结算层。
- 对局结束可继续下一局或返回菜单（猫草归零时结束整盘）。

---

## 10. v1.0 功能清单（里程碑）

| 模块 | 内容 |
|------|------|
| 核心 | `CardDefs`、`Deck`、`Rules`、叫地主/抢地主、轮转与过、胜负与猫草结算 |
| AI | 扩展牌型跟牌、三档位猫咪、叫分/抢地主强度、记牌与农民配合 |
| UI | 开始菜单、对局主界面、手牌选牌、日志、摸牌与出牌动画、音效与双 BGM |
| 体验 | 盘/局与座位洗牌、炸弹/王炸倍数、人类提示、出牌飞入动画防重复刷新 |

---

## 11. 已知工程注意点

- `CardDefs` 使用 `class_name`；`deck.gd` 发牌写法避免部分 GDScript 解析问题。
- `ddz_rules` 以 `Rules` 形式被 `preload`。

---

## 12. 后续可跟踪项（未在 v1.0 承诺）

- 抢地主、叫分规则的进一步细调（如多轮叫分）与 **AI 强度** 数值调参。
- 更多牌型/规则与线上规则完全对齐（若产品需要）。
- 性能与可访问性（大屏、键位映射等）。

---

## 13. 文档维护

- 版本发布时请更新文首 **版本号** 与 **第 10 节**；目录与脚本变更请更新 **第 2 节**。
