# OzBargain 监测

OzBargain 首页热门 deal 监测工具：定时抓取 OzBargain 首页推荐 RSS，按热度分、票数增速等指标展示 deals，支持收藏、隐藏、关键词关注和票数走势查看。

- 前端：React 19 + TanStack Query + Tailwind CSS
- 服务端：Bun + drizzle-orm + SQLite（本地文件数据库）
- 数据：来自 OzBargain 公开 RSS（https://www.ozbargain.com.au/feed），不含任何账号信息

## 安装

需要 [Bun](https://bun.sh/) 1.3+。

```bash
bun install
```

## 编译

```bash
bun run build
```

分别构建服务端（`server/dist/index.js`）和前端（`client/dist/`）。

开发模式（前端改动后需重新 `bun run build:client`）：

```bash
bun run dev
```

## 运行

```bash
bun run start
```

默认监听 `http://localhost:3000`，浏览器打开即可使用。首次启动时自动执行 `drizzle/` 下的迁移，在 `data/app.db` 生成一个空库，并创建 `data/blobs/` 存放 deal 缩略图。

只想建库 / 升级表结构而不启动服务：

```bash
bun run migrate
```

类型检查：

```bash
bun run typecheck
```

## 环境变量

复制 `.env.example` 为 `.env` 后修改（Bun 启动时会自动读取 `.env`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `DB_PATH` | `./data/app.db` | SQLite 数据库文件路径（相对于运行目录） |
| `BLOB_DIR` | `./data/blobs` | deal 缩略图存放目录 |

## 数据说明

- 数据来自 OzBargain 公开 RSS，服务端定时抓取（每 3 小时检查一次，按设置里的自动刷新间隔决定是否抓取），缓存在本地 SQLite 里；打开页面只读缓存，不产生额外流量。
- 本地数据库首次启动时是空库，打开页面后会自动抓取一次当前首页。
- deal 缩略图在刷新时下载到本地 `BLOB_DIR`，页面不直接外链原图。
- 热度分（0–99）：18×log₁₀(1+票) + 14×log₁₀(1+评论) + 10×log₁₀(1+点击)，再 ×0.75 取整封顶。
- 7 天没再上首页的 deal 会自动移出监控（收藏的保留）；快照保留 14 天，用于走势图。
- 所有数据都在本地，不上传到任何第三方。

## 接口

- `GET /`：前端页面
- `GET /health`：健康检查，返回 `{ "ok": true }`
- `GET /blobs/:key`：deal 缩略图
- `POST /actions`：`{ "action": "<动作名>", "args": {...} }`，返回 `{ "data": ... }` 或 `{ "error": ... }`。动作：`getBoard`、`refreshDeals`、`scheduledRefresh`、`toggleFavorite`、`setHidden`、`saveSettings`（定义见 `server/src/actions.ts`）。
