# Nakama 本地部署（备忘）

在**仓库根目录**（`docker-compose.yml` 所在目录）操作。

## 1. 编译游戏逻辑（TypeScript → `Modules/build/index.js`）

每次改了 `Modules/src/` 后都要重新编译，否则容器里仍是旧逻辑。

```bash
cd Modules
npm install
npm run build
```

核对：

```bash
ls -la ../Modules/build/index.js
```

## 2. 启动 / 停止

```bash
cd /path/to/CardGame   # 仓库根目录
docker compose up -d     # 后台启动 Nakama + Postgres
docker compose down      # 停止并删容器（数据卷保留）
docker compose logs -f nakama   # 看 Nakama 日志
```

## 3. 端口

| 服务 | 端口 |
|------|------|
| Nakama API | **7350** |
| Nakama Console（网页管理） | **7351** |

改数据库密码：可在根目录建 `.env`，写 `POSTGRES_PASSWORD=你的密码`（需与 compose 里一致）。

## 4. 改了 runtime 以后

```bash
cd Modules && npm run build
docker compose restart nakama
```

（不重建镜像，只重启 Nakama 容器以重新加载挂载的 `Modules/build`。）

## 5. 故障：`migrate up` 报 `connection refused`（数据库）

含义：Nakama 连 `database.address` 时，**对端没有在监听**（或尚未就绪）。

**若使用本仓库的 `docker-compose.yml`（PostgreSQL）**

- 先确认数据库容器已起来且健康：`docker compose ps`（`postgres` 应为 `healthy`）。
- 再看日志：`docker compose logs postgres`、`docker compose logs nakama`。
- 不要单独只起 `nakama`：需先起 `postgres`，且本 compose 已用 `depends_on: condition: service_healthy`，一般应等库就绪后再跑 migrate。

**若你改用 CockroachDB（日志里出现 `cockroachdb:26257`）**

- 本仓库默认 **不是** Cockroach 方案；需自备 compose，并保证：
  1. **Cockroach 容器已启动**且 `26257` 已监听（`docker compose logs cockroachdb` 无持续报错）。
  2. **Nakama 在 Cockroach 就绪之后再启动**：给 `cockroachdb` 配 `healthcheck`，`nakama` 使用 `depends_on: cockroachdb: condition: service_healthy`（或启动脚本里 `sleep`/重试 migrate），避免「库还没起来就先 migrate」。
- 单机开发更省事的做法：直接用本文件的 **Postgres + 本仓库 compose**，不必上 Cockroach。

**快速自检**

```bash
docker compose ps -a
docker compose logs cockroachdb 2>/dev/null || true
docker compose logs postgres 2>/dev/null || true
docker compose logs nakama
```
