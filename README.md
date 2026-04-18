# CardGame — 斗地主（Godot）

单机三人斗地主，使用 Godot 4.x 与 **GDScript**。当前发布版本：**v1.0**。

## 功能概览

- **流程**：开始菜单 → 对局（摸牌 → 叫地主选倍 → 抢地主 → 出牌 → 结算）
- **角色**：三只猫咪（丑丑妹、咪宝、毛睿睿），座位每盘随机；**咪宝 / 毛睿睿 / 丑丑妹** 对应 AI 档位 **凶 / 怂 / 普通**
- **人类**：固定下方座位；**提示** 按当前档位 AI 逻辑预选牌
- **规则**：常见牌型 + 炸弹/王炸；**最终倍率** = 叫地主基础倍率（不叫/1～3 倍）× 抢地主 × 出牌（炸弹/王炸）；结算时展示倍率明细；猫草按最终倍率结算
- **表现**：手牌扇形、出牌区飞牌动画、音效、菜单与对局 BGM（循环）

详细说明见 [docs/DESIGN.md](docs/DESIGN.md)。

## 环境要求

- [Godot 4.x](https://godotengine.org/)（工程使用 **4.6** 特性标记）

## 运行方式

1. 用 Godot 编辑器 **导入** 本仓库目录（含 `project.godot`）
2. 运行项目（F5），或从 **`scenes/start_menu.tscn`** 作为主场景启动（默认已在 `project.godot` 中配置）

## 资源与目录

| 路径 | 说明 |
|------|------|
| `scenes/` | `start_menu`、`main` 主场景 |
| `scripts/` | 规则、AI、主流程与 `CardDefs` |
| `CardsAssets/` | 牌面图 |
| `assets/avatars/` | 角色头像 |
| `audio/` | 短音效 |
| `MusicAssets/` | BGM（mp3） |

## 许可

若未另行附带 LICENSE 文件，默认以仓库所有者声明为准；引用素材请遵守各自版权。

## 仓库

- 远程：`git@github.com:finall1980/cardgame.git`
