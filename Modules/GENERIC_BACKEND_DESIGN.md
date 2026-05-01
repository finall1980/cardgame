# 多游戏共用 Nakama 后端：架构说明与运维

本文档描述「同一套 Nakama 部署、进程内多款游戏」的**当前仓库布局**、扩展方式，以及 **TypeScript 运行时如何构建、部署与重启**。更细的环境与排错见仓库根目录 [`NAKAMA_DEPLOY.md`](../NAKAMA_DEPLOY.md)。

---

## 1. 当前架构快照

| 维度 | 现状 |
|------|------|
| **入口** | `Modules/src/main.ts` 仅 `InitModule`：注册通用 RPC + 各游戏 `register*()`。 |
| **通用层** | `Modules/src/core/`：`wallet.ts`（全游戏共用游戏币）、`storage_queue.ts`、`random.ts`、`rpc_json.ts`。 |
| **斗地主** | `Modules/src/games/ddz/`：`match_state` / `rules` / `match_logic` / `match_handler`、`mm_queue`、`ai_server`；**Match/RPC 注册写在 `main.ts` 的 `InitModule` 内**（Nakama 限制，见 §2）。 |
| **构建** | TypeScript `outFile` → 单文件 `Modules/build/index.js`；**无 ES 模块**，靠 `tsconfig` 的 `files` **顺序**拼接全局脚本，供 Nakama 加载。 |
| **权威 Match** | `registerMatch("ddz", ddzMatchHandler)`，逻辑在 `games/ddz/match_handler.ts` 等文件中。 |
| **按游戏匹配** | 自建 RPC：`ddz_mm_join` / `ddz_mm_poll` / `ddz_mm_cancel`；队列 Storage 使用独立 collection（如 `ddz_mm`）。 |
| **内置 Matchmaker** | `registerMatchmakerMatched` **全局仅一个回调**；当前实现仍固定创建 `ddz` 对局；多游戏时需在此回调内按属性分流或弱化内置匹配。 |
| **游戏币** | 与玩法解耦：Storage `player` / `wallet`（并兼容旧键 `doudizhu` / `wallet` 的读取迁移）。 |

结论：新游戏在 `games/<游戏名>/` 增加模块，在 `main.ts` 的 `InitModule` 里增加一行注册即可；注意 **RPC 名全局唯一**、**队列 Storage 按游戏隔离**、**内置 Matchmaker 回调需统一分流**。

---

## 2. Nakama 侧约束（多游戏时必须知道）

1. **`InitModule` 里可注册多个 `registerMatch("不同名字", 不同 Handler)`**  
   例如：`ddz`、`gomoku` 各一套 Handler，互不影响。

2. **`registerMatchmakerMatched` 全局只能注册一个回调**  
   若多款游戏都用 Nakama **内置 Matchmaker**，须在**唯一回调**里根据 `matched` 的 **query / properties** 分支，调用对应的 `nk.matchCreate("游戏名", …)`。  
   若各游戏主要用 **自建 RPC 队列**（如 `ddz_mm_*`），可减轻该回调的分支复杂度。

3. **RPC 名称全局唯一**  
   新游戏建议前缀：`{gameId}_mm_join`，避免与 `ddz_mm_*`、`wallet_*` 冲突。

4. **Storage 键空间**  
   匹配队列、玩法状态按游戏分 collection/key（例如 `ddz_mm` 与 `other_mm`），避免串数据。

5. **JavaScript `InitModule` 里如何调用 `initializer`（Nakama 3.1+）**  
   `registerRpc`、`registerMatch`、`registerMatchmakerMatched` **必须在 `InitModule` 函数体内直接**调用 `initializer.*`，**不能**先包一层 `registerFoo(initializer)` 再在里层注册。否则运行时报错：`function key could not be extracted: not found`（见 [nakama#549](https://github.com/heroiclabs/nakama/issues/549)）。因此本仓库把全部注册语句写在 `main.ts` 的 `InitModule` 中。

---

## 3. 通用层职责（`src/core/`）

| 模块 | 作用 |
|------|------|
| `storage_queue.ts` | 全局 Storage 乐观锁 + 重试，供各游戏匹配队列复用。 |
| `rpc_json.ts` | 统一 RPC JSON 字符串（`rpcOk` / `rpcErr`）。 |
| `random.ts` | `secureRandomBytes` 回退、洗牌等。 |
| `wallet.ts` | 全游戏共用游戏币 RPC：`wallet_sync` / `wallet_buy` / `wallet_apply_delta`。 |

不宜强行通用化的部分：各游戏 **State、opcode、JSON 协议**；斗地主 **AI**（`games/ddz/ai_server.ts`）与牌型规则（`games/ddz/rules.ts`）。

---

## 4. 目录结构（与仓库一致）

```
Modules/src/
  main.ts                    # InitModule：须在此函数体内直接 initializer.register*（勿封装）
  core/
    storage_queue.ts
    rpc_json.ts
    random.ts
    wallet.ts
  games/
    ddz/
      match_state.ts
      rules.ts
      match_logic.ts
      match_handler.ts
      mm_queue.ts
      ai_server.ts
    <your_game>/             # 新游戏逻辑目录；注册仍追加在 main.ts InitModule 内
      ...
```

`tsconfig.json` 中 `files` 数组顺序即拼接顺序：**core → `games/ddz/*`（不含独立 index）→ `main.ts` → `games/ddz/ai_server.ts`（最后，依赖前述全局符号）**。

**InitModule 形态（与源码一致）：** 在 `main.ts` 内对 `initializer` 逐条 `registerRpc` / `registerMatch` / `registerMatchmakerMatched`。

---

## 5. 多游戏匹配策略（三种模式，可并存）

| 模式 | 做法 | 适用 |
|------|------|------|
| **A. 每游戏独立 RPC 队列** | 复制 `ddz_mm` 模式，换 collection 与 RPC 名；`matchCreate("游戏X", …)`。 | 与现有客户端最一致，易并行开发。 |
| **B. 统一 RPC，参数带 `gameId`** | 如 `universal_mm_join` payload `{ "game": "ddz" }`，服务端路由。 | RPC 少，校验成本略高。 |
| **C. 内置 Matchmaker 分流** | 在唯一 `registerMatchmakerMatched` 里读 `props` / `query` 决定 `matchCreate` 类型。 | 客户端已深度使用 `add_matchmaker_async` 时。 |

当前项目以 **A** 为主、**C** 为辅。

---

## 6. 协议与版本

- **Match 标签**：`ddz` 等保持短、稳定；客户端写死或配置下发。
- **Opcode**：每游戏独立空间；`DDZ_OP_*` / `DDZ_REQ_*` 仅适用于 `ddz` Match。
- **破坏性变更**：同一玩法内可用 JSON `v` 字段或新 opcode 段。

---

## 7. 构建、部署与重启服务

以下默认 **仓库根目录**（存在 `docker-compose.yml`）为工作目录；Nakama 通过卷挂载使用本地编译出的 `Modules/build/index.js`（以你实际 `docker-compose.yml` 中挂载路径为准，常见为挂载整个 `Modules` 目录）。

### 7.1 编译 TypeScript（每次改 `Modules/src/` 后必做）

```bash
cd Modules
npm install          # 首次或依赖变更
npm run build
```

确认产物：

```bash
ls -la build/index.js
```

### 7.2 首次启动 / 停止栈

在**仓库根目录**：

```bash
docker compose up -d              # 后台启动 Nakama、PostgreSQL 等
docker compose down               # 停止并删除容器（数据卷是否删除取决于 compose 配置）
docker compose logs -f nakama     # 跟踪 Nakama 日志
```

常用端口（与默认 compose 一致时）：

| 服务 | 端口 |
|------|------|
| Nakama API | **7350** |
| Nakama Console | **7351** |

数据库密码等可通过根目录 `.env`（如 `POSTGRES_PASSWORD`）配置，须与 compose 中引用一致。

### 7.3 只改了运行时（`Modules/src`）如何生效

Runtime 是挂载的文件，**一般不需要重建镜像**，只需重新编译并重启 Nakama 进程：

```bash
cd Modules && npm run build
cd .. && docker compose restart nakama
```

若 compose 里服务名不是 `nakama`，改为实际服务名（`docker compose ps` 查看）。

### 7.4 验证

- Console：`http://localhost:7351`（视部署调整主机与端口）。
- 日志中应能看到 `InitModule` 内打印的初始化信息（如 `Nakama runtime initialized (wallet + ddz).`）。

### 7.5 更多故障排查

数据库未就绪、`migrate` 失败、改用 Cockroach 等场景，见 **[`NAKAMA_DEPLOY.md`](../NAKAMA_DEPLOY.md)**。

---

## 8. 测试

- 牌型 / AI 可做单测；Match Handler 依赖 `nakama-runtime` 或集成环境。
- 仓库内若有 Godot / Nakama 联调测试工程，按该项目说明运行。

---

## 9. 小结

| 问题 | 结论 |
|------|------|
| 能否同一后端跑多款游戏？ | **能**：多 `registerMatch` + RPC/Storage 隔离 + 谨慎处理 `registerMatchmakerMatched`。 |
| 游戏币是否跨游戏共用？ | **是**：`core/wallet`，与「按游戏匹配队列」分离。 |
| 新游戏从哪下手？ | 新建 `games/<id>/`，实现 `registerYourGame`，在 **`main.ts` 预留行** 调用；匹配队列可复用 `mutateGlobalStorage` 模式。 |

---

## 10. 参考（仓库内）

| 说明 | 位置 |
|------|------|
| 入口 | `Modules/src/main.ts` → `InitModule` |
| 斗地主 Match / mm RPC 注册 | `Modules/src/main.ts` → `InitModule` 内直接 `initializer.register*` |
| 自建斗地主匹配 | `Modules/src/games/ddz/mm_queue.ts` |
| 运维备忘（环境、排错） | [`NAKAMA_DEPLOY.md`](../NAKAMA_DEPLOY.md) |
| Godot 客户端 RPC / 玩法常量 | `scripts/online_session.gd`（`AUTHORITY_GAME_MATCH_LABEL`、`RPC_MM_*`、`RPC_WALLET_*`） |
