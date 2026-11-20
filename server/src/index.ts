// 独立服务器入口：Bun.serve 提供 HTTP 接口 + 静态前端。
//
// 路由：
//   GET  /            -> 前端（client/dist/index.html）
//   GET  /assets/*    -> 前端构建产物
//   GET  /blobs/:key  -> deal 缩略图（本地文件存储，见 blobs.ts）
//   GET  /health      -> { ok: true }，供健康检查
//   POST /actions     -> { action, args }，按 server/src/actions.ts 里
//                        的定义做 zod 校验后调用 handler，返回 { data }
//                        或 { error }（与原来 createActionClient 的
//                        约定一致）。
//
// 启动时先执行 drizzle 迁移（空库自动建表），再启动服务。
// 定时刷新：每 3 小时调用一次 scheduledRefresh（与原来 space.json 里
// 的 managedCronJobs interval@3h 一致），它内部再按用户设置的间隔
// 决定是否真的抓取 RSS。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Actions } from "./actions";
import { blobs, readBlob } from "./blobs";
import { db, runMigrations } from "./db";
import type { Ctx } from "./sdk";

runMigrations();

const ctx: Ctx = {
  db: (() => db) as Ctx["db"],
  blobs,
  invalidateQueries() {},
};

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const CLIENT_DIST = new URL("../../client/dist", import.meta.url).pathname;

// 每 3 小时唤醒一次定时刷新（与原来平台的 managed cron 一致）。
setInterval(() => {
  void Actions.scheduledRefresh
    .handler(ctx, {})
    .catch((e) => console.error("[scheduledRefresh]", e));
}, 3 * 60 * 60 * 1000);

async function handleAction(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { action, args } = (body ?? {}) as { action?: unknown; args?: unknown };
  if (typeof action !== "string" || !(action in Actions)) {
    return Response.json({ error: `unknown action: ${String(action)}` }, { status: 404 });
  }
  const def = Actions[action as keyof typeof Actions];
  let parsedArgs: unknown;
  try {
    parsedArgs = def.request.parse(args ?? {});
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "invalid request" },
      { status: 400 },
    );
  }
  try {
    const data = await def.handler(ctx, parsedArgs as never);
    const validated = def.response.parse(data);
    return Response.json({ data: validated });
  } catch (e) {
    console.error(`[action ${action}]`, e);
    return Response.json(
      { error: e instanceof Error ? e.message : "action failed" },
      { status: 500 },
    );
  }
}

function serveFile(path: string, contentType: string): Response | null {
  if (!existsSync(path)) return null;
  return new Response(Bun.file(path), { headers: { "content-type": contentType } });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/actions") {
      return handleAction(req);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (req.method === "GET" && url.pathname.startsWith("/blobs/")) {
      const key = decodeURIComponent(url.pathname.slice("/blobs/".length));
      let blob: ReturnType<typeof readBlob>;
      try {
        blob = readBlob(key);
      } catch {
        return new Response("not found", { status: 404 });
      }
      if (!blob) return new Response("not found", { status: 404 });
      return new Response(blob.bytes, { headers: { "content-type": blob.contentType } });
    }
    if (req.method === "GET") {
      if (url.pathname === "/") {
        const index = serveFile(join(CLIENT_DIST, "index.html"), "text/html; charset=utf-8");
        if (index) return index;
      }
      if (url.pathname.startsWith("/assets/")) {
        const file = join(CLIENT_DIST, url.pathname.slice(1));
        const ext = file.split(".").pop() ?? "";
        const type =
          ext === "js"
            ? "text/javascript"
            : ext === "css"
              ? "text/css"
              : ext === "html"
                ? "text/html; charset=utf-8"
                : "application/octet-stream";
        const res = serveFile(file, type);
        if (res) return res;
      }
      // 其他未知 GET 路径回落到前端（单页应用）。
      const index = serveFile(join(CLIENT_DIST, "index.html"), "text/html; charset=utf-8");
      if (index) return index;
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`OzBargain 监测 running at http://${server.hostname}:${server.port}`);
