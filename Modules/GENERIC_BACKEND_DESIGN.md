# 多游戏共用 Nakama 后端：现状评估与改造思路

本文档面向「同一套 Nakama 部署、同一进程内运行多款游戏」的演进，基于当前仓库 `Modules/src/main.ts` + `ddz_ai_server.ts` 的实现归纳。

---

## 1. 当前架构快照

| 维度 | 现状 |
|------|------|
| **构建** | TypeScript `outFile` 单文件 `build/index.js`，入口为 `InitModule`（与 Nakama `main.js` 约定一致）。 |
| **权威 Match** | `initializer.registerMatch("ddz", ddzMatchHandler)`，斗地主规则、状态机、广播协议全部写在本文件（及 AI 子文件）。 |
| **匹配** | 自定义 RPC：`ddz_mm_join` / `ddz_mm_poll` / `ddz_mm_cancel`，用 **Storage** 持久化队列与 ticket 结果；`nk.matchCreate("ddz", {...})` 创建对局。 |
| **内置 Matchmaker** | `registerMatchmakerMatched`：当前仅服务斗地主，固定 `nk.matchCreate("ddz", …)`。 |
| **游戏逻辑耦合** | 牌型、阶段、`DdzMatchState`、`DDZ_OP_*` / `DDZ_REQ_*` 与斗地主强绑定；`ddz_ai_server.ts` 仅服务本玩法。 |

结论：**可以在同一后端里再挂其它游戏**，但需要做**分层与注册隔离**；**不能直接**把现有 `main.ts` 称为「通用引擎」，它是**以斗地主为中心的单体模块**。

---

## 2. Nakama 侧约束（多游戏时必须知道）

1. **`InitModule` 里可注册多个 `registerMatch("不同名字", 不同 Handler)`**  
   例如：`ddz`、`gomoku`、`party_lobby` 各一套 Handler，互不影响。

2. **`registerMatchmakerMatched` 全局只能注册一个回调**  
   若继续使用 Nakama **内置 Matchmaker**（`add_matchmaker_async` 等），需要在**唯一回调里分支**：根据 `matched` 上的 **query / properties** 决定创建哪种 `nk.matchCreate("游戏名", …)`。  
   若每款游戏**只用自建 RPC 队列**（类似现有 `ddz_mm_*`），则可弱化对内置 Matchmaker 的依赖，减少回调里的分支复杂度。

3. **RPC 名称全局唯一**  
   新游戏建议带前缀：`{gameId}_mm_join`，避免与现有 `ddz_mm_*` 冲突。

4. **Storage 键空间**  
   队列状态、配置等应按游戏隔离，例如 `ddz_mm` 与 `othergame_mm` 不同 collection/key，避免串数据。

---

## 3. 哪些可以抽成「通用层」

下列与斗地主规则无关，可沉淀为共享模块（目录名示例：`src/core/` 或 `src/shared/`）：

- **存储队列 + 乐观锁/重试**：当前 `ddzMmMutateState` / `ddzMmLoadState` / `ddzMmSaveState` 的模式可泛化为 `mutateStorage<T>(collection, key, fn)`。
- **Ticket 生成、Poll/Cancel 的 RPC 形态**：参数校验、JSON 响应格式 `{ ok, status, match_id, error }` 可模板化。
- **安全随机**：`nk.secureRandomBytes` 回退逻辑已是通用工具函数。
- **Match Handler 空壳**：`matchInit` / `matchJoin` / `matchLeave` / `matchLoop` / `matchTerminate` 的**调用结构**相同，差异在**状态类型与循环内分发**，适合用「每游戏一个 Handler 对象」而非复制粘贴。

**不宜强行通用化的部分**：

- 具体游戏的 **State 结构、opcode、JSON 协议**（应每游戏独立定义，仅约定命名规范）。
- 斗地主 **AI 与牌型判定**（保留在 `games/ddz/` 下即可）。

---

## 4. 推荐目标结构（目录与职责）

```
Modules/src/
  main.ts                 # 仅 InitModule：组装注册表、调用各游戏 register()
  core/
    storage_queue.ts      # 泛化 Storage 读写 + 重试
    rpc_json.ts           # 统一 JSON 响应、错误码
    random.ts
    types.ts              # 可选：公共类型
  games/
    ddz/
      index.ts            # registerDdz(initializer, nk, logger) 注册 match + rpc + matchmaker
      match_state.ts      # 从 main.ts 拆出的状态与常量（可选）
      match_handler.ts   # ddzMatchLoop 等
      ai_server.ts        # 原 ddz_ai_server.ts
      mm_queue.ts         # 原 ddz_mm_* 逻辑，依赖 core/storage_queue
    other_game/
      index.ts
      ...
```

**InitModule 形态示例（概念）：**

```ts
// 伪代码
import { registerDdz } from "./games/ddz";
import { registerOther } from "./games/other_game";

function InitModule(ctx, logger, nk, initializer) {
  registerDdz(initializer, logger, nk);
  registerOther(initializer, logger, nk);
  registerMatchmakerRouter(initializer, logger, nk); // 若需要多游戏内置 matchmaker
}
```

演进可以**分阶段**：先抽 `core/storage_queue`，再把 `ddz_mm_*` 迁到 `games/ddz/mm_queue.ts`，最后拆 `main.ts` 中的 match 逻辑。

---

## 5. 多游戏匹配策略（三种模式，可并存）

| 模式 | 做法 | 适用 |
|------|------|------|
| **A. 每游戏独立 RPC 队列** | 复制 `ddz_mm` 模式，换 collection 与 RPC 名；`matchCreate("游戏X", …)`。 | 与现有客户端最一致，易并行开发。 |
| **B. 统一 RPC，参数带 `gameId`** | 如 `universal_mm_join` payload `{ "game": "ddz" }`，服务端路由到不同队列与 `matchCreate`。 | RPC 数量少，但需严格校验与版本字段。 |
| **C. 内置 Matchmaker 分流** | 在唯一 `registerMatchmakerMatched` 里读 `props` / `query` 决定创建哪种 Match。 | 适合客户端已用 `add_matchmaker_async` 且多游戏共用池子。 |

当前项目以 **A** 为主、**C** 为辅；新游戏可沿用 **A**，待稳定后再考虑 **B** 做薄封装。

---

## 6. 协议与版本

- **Match 标签**：`ddz`、`reversi` 等保持短、稳定；客户端写死或通过配置下发。
- **Opcode**：每游戏独立编号空间，文档中说明 `DDZ_OP_*` 仅适用于 `ddz` Match。
- **破坏性变更**：同一游戏内可用 `v` 字段或新 opcode 段；跨游戏不复用同一 opcode 含义。

---

## 7. 测试与部署

- **单元测试**：牌型/AI 可测；Match Handler 需 `nakama-runtime` mock 或集成测试（项目里可逐步加）。
- **部署**：仍单文件 `build/index.js` 上传即可；若未来拆成多 chunk，需确认 Nakama JS 加载方式（当前为单 bundle）。

---

## 8. 小结

| 问题 | 结论 |
|------|------|
| 现有代码能否「直接当通用后端」？ | **不能**；需按游戏拆分模块并统一注册。 |
| 能否在同一后端跑多款游戏？ | **能**；通过多个 `registerMatch` + 隔离的 RPC/Storage + 谨慎处理 `registerMatchmakerMatched`。 |
| 建议第一步 | 抽 **Storage 队列工具** + 把 **斗地主** 迁到 `games/ddz/`，`InitModule` 变薄；新游戏按 `games/<name>/` 增加。 |

---

## 9. 参考（仓库内）

- 入口注册：`Modules/src/main.ts` 末尾 `InitModule`
- 自建匹配 RPC：`rpcDdzMmJoin` / `Poll` / `Cancel`
- 队列存储：`DDZ_MM_COLLECTION` 与 `ddzMmMutateState`

若后续需要「同一文档内画出 RPC 与 Match 依赖关系图」，可在此基础上补一张 mermaid 流程图。
