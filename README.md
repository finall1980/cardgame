# 三猫斗地主（CardGame）

使用 **Godot 4.6** 与 **GDScript** 实现的单机三人斗地主（斗地主规则 + 三只猫咪角色）。工程名：`DouDizhu`。

## 功能概览

- **流程**：开始菜单 → 对局（摸牌动画 → 叫地主选倍 → 抢地主 → 轮流出牌 → 结算）
- **角色**：丑丑妹、咪宝、毛睿睿；座位与猫身份每**盘**随机，局间不换角
- **AI**：两路 AI 按猫咪风格区分进攻性；人类可使用 **提示**（按当前档位逻辑预选牌）
- **规则**：标准斗地主牌型，含炸弹、王炸；**最终倍率** = 叫地主基础倍率 × 抢地主 × 出牌阶段炸弹/王炸加翻；结算展示倍率明细，**猫草**按倍率结算
- **界面**：牌桌背景图、全局主题、头像圆形描边；右上角 **设置**（BGM 音量、重新发牌、返回开始界面）；出牌区 **提示 / 出牌 / 过**
- **对话**：座位旁 **圆角矩形** 气泡（代码绘制，白底描边），带尾巴朝向头像
- **弹窗**：设置内操作使用与牌桌风格一致的 **确认对话框**（非系统原生样式）

规则说明与牌型细节见仓库根目录 [rule.md](rule.md)，设计与流程见 [docs/DESIGN.md](docs/DESIGN.md)。

## 环境要求

- [Godot 4.6](https://godotengine.org/download/)（与 `project.godot` 中 `config/features` 一致）

## 运行方式

1. 在 Godot 中 **导入** 本目录（需含 `project.godot`）
2. 按 **F5** 运行，或确保主场景为 `scenes/start_menu.tscn`（默认已配置）

## 目录结构（节选）

| 路径 | 说明 |
|------|------|
| `scenes/` | `start_menu.tscn`、`main.tscn`、`seat_speech_bubble.tscn` 等 |
| `scripts/` | `main.gd` 主流程、`ddz_rules.gd`、`ddz_ai.gd`、`deck.gd`、`card_defs.gd`、`seat_speech_bubble.gd`、`play_line_builder.gd` |
| `theme/` | `game_theme.tres` 等全局 UI 主题 |
| `CardsAssets/` | 牌面、牌背、牌桌背景 `cardbg.png` 等 |
| `assets/` | 头像、UI 贴图等 |
| `audio/`、`MusicAssets/` | 音效与 BGM（含 mp3） |
| `shaders/` | 如头像圆环 `avatar_circle.gdshader` |

## Git 使用说明

```bash
# 克隆（将 URL 换成你的远程地址）
git clone <仓库 URL> CardGame
cd CardGame

# 提交并推送
git add -A
git status
git commit -m "说明本次改动的完整句子"
git push origin main
```

首次推送前请在托管平台（GitHub / GitLab 等）创建空仓库，并按提示配置 `git remote add origin …`。

> 说明：Godot 会在本地生成 `.godot/` 与导入缓存，已通过 `.gitignore` 忽略；请勿提交 **`WebApp/`** 导出目录（已忽略，体积大且可重新导出）。

## 许可

若仓库根目录未附带 `LICENSE` 文件，以仓库所有者声明为准；第三方美术与音频素材请遵守各自版权与授权范围。
