# CardGame（三猫棋牌 · Godot × Nakama）

本仓库是一套 **Godot 4.6** 客户端 + **Nakama** 服务端逻辑（TypeScript Runtime）的工程：除本地可玩的斗地主外，已扩展 **联机匹配大厅、钱包与资料、掼蛋、猫猫杀** 等多种玩法与设计文档。**权威对局逻辑**在 `Modules` 编译产物中跑的 Match / RPC。

## 内容概览

| 层级 | 说明 |
|------|------|
| **客户端** | Godot 主菜单 `scenes/start_menu.tscn`；单机斗地主或登录后进入 `multiplayer_lobby` 匹配；各玩法独立主场景（见下表）。 |
| **联机** | `scripts/online_session.gd`（Autoload `OnlineSession`）管理 Nakama 会话、匹配、钱包同步与房间 Realtime。 |
| **服务端** | `Modules/src/` TypeScript → `Modules/build/index.js`，由 Nakama 挂载；注册 **斗地主 / 掼蛋 / 猫猫杀** Match 与对应匹配 RPC、钱包相关 RPC 等。 |
| **Web 导出** | `WebApp/`：Godot HTML5 导出 + `serve.py` 静态服务；云部署说明见 `WebApp/DEPLOY.md`。 |

## 玩法与入口（客户端）

| 玩法 | 场景 / 脚本（节选） | 服务端 Match 名 |
|------|---------------------|-----------------|
| 斗地主（单机 + 联机） | `scenes/main.tscn`、`scripts/main.gd` | `ddz` |
| 掼蛋 | `scenes/guandan/main.tscn`、`scripts/guandan/` | `guandan` |
| 猫猫杀 | `scenes/meow_kill/main.tscn`、`scripts/meow_kill/` | `meow_kill` |
| 联机大厅 | `scenes/multiplayer_lobby.tscn`、`scripts/multiplayer_lobby.gd` | —（匹配后按 `current_game_id` 切场景） |

设计文档分散在 `docs/`（如 `guandan_DESIGN.md`、`meow_kill_*.md` 等）；斗地主规则摘要见根目录 [rule.md](rule.md)。

## 环境要求

- **运行游戏**：与 `project.godot` 一致，推荐 [Godot 4.6](https://godotengine.org/download/)（特性 `4.6 / Forward Plus`）。
- **编译 Nakama 模块**：Node.js + npm，用于 `Modules` 下 TypeScript 构建。
- **本地或服务器跑 Nakama**：Docker（仓库根目录 `docker-compose.yml`；当前编排包含 **Nakama、CockroachDB、Prometheus**）。部署步骤与端口说明仍以 [NAKAMA_DEPLOY.md](NAKAMA_DEPLOY.md) 为准；若编排与备忘文档不一致，**以仓库内实际 `docker-compose.yml` 为准**，自行调整挂载路径与环境变量。

## 快速开始（仅客户端）

1. 用 Godot 打开本仓库（含 `project.godot`）。
2. **F5** 运行；主场景为 `scenes/start_menu.tscn`。

单机斗地主可不启 Nakama；**联机、匹配、钱包**需在客户端配置 Nakama 地址（见 `online_session.gd` 与相关场景），且服务端已加载最新 `Modules/build/index.js`。

## Nakama 模块（服务端逻辑）

```bash
cd Modules
npm install
npm run build          # 输出 Modules/build/index.js
npm test               # 可选：规则等单测（tsconfig.test.json）
```

将构建目录挂载到 Nakama `--runtime.path`（具体见 `docker-compose.yml` volumes 与你的服务器路径）。

已注册玩法入口见 `Modules/src/main.ts`（节选）：钱包 RPC，`ddz` / `guandan` / `meow_kill` Match，以及各玩法 `*_mm_*` 匹配 RPC 等。

## Web 导出（可选）

Godot Web 导出到 `WebApp/` 后，可用：

```bash
cd WebApp
python3 serve.py --bind 0.0.0.0 -p 8765
```

HTTPS、证书与 nginx/caddy 反代详见 [WebApp/DEPLOY.md](WebApp/DEPLOY.md)。

## 目录结构（扩展版）

```
CardGame/
├── scenes/              # 各玩法与大厅、起始菜单场景
├── scripts/             # GDScript（含 online_session、各玩法入口逻辑）
├── Modules/             # Nakama TS 运行时源码与 build/index.js
├── addons/               # Nakama Godot SDK 等插件
├── assets/、CardsAssets/、meowkill/   # 贴图与桌游素材（按玩法引用）
├── WebApp/              # HTML5 导出与 serve.py
├── docs/                # 各玩法与设计备忘
├── docker-compose.yml    # Nakama / DB / Prometheus 本地编排示例
├── NAKAMA_DEPLOY.md     # TS 编译、启停与排错备忘
├── rule.md               # 斗地主规则摘要
├── project.godot
└── README.md
```

更多历史设计见 [docs/DESIGN.md](docs/DESIGN.md)（若以仓库内为准）。

## Git 与协作

```bash
git clone <仓库 URL>
cd CardGame
# 开发与提交
git add -A && git status
git commit -m "动词开头、说明本次改动的完整句子。"
git push origin main
```

- Godot 本地缓存目录（如 `.godot/`）一般由 `.gitignore` 忽略，勿手提交。
- 大体积导出目录若不希望进库，请在 `.gitignore` 中保持排除规则。

## 许可与素材

仓库根若无 `LICENSE`，以所有者声明为准。第三方美术 / 音效 / 字体请遵循各自许可证；线上使用需注意 Nakama、Godot Web 与各素材的商用条款。

---

**一句话**：本项目是「**一只 Godot 壳 + Nakama 权威局**」的多玩法棋牌工程；改规则先动 `Modules/src/games/` 与用户端场景脚本，别忘了 `npm run build` 后重启或 reload Nakama Runtime。
