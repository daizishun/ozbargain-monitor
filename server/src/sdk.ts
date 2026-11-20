// 本地 SDK 替代层：替代原来 `@hatch/space-sdk` 的服务端接口。
//
// 原项目是 Muse 内部的 TypeScript space，`defineAction` / `z` / `Ctx`
// 来自内部包 `@hatch/space-sdk`（GitHub 上没有）。本项目只用到了它
// 的一小部分：
//   - `defineAction`：只是把 { request, response, description, handler }
//     原样包起来，真正的校验由 server/src/index.ts 在收到请求时做。
//   - `z`：直接 re-export zod。
//   - `Ctx.db`：原来是 `ctx.db<typeof schema>()` 返回 drizzle 实例；
//     这里改成一个泛型函数，调用方式不变，返回同一个 drizzle 实例。
//   - `Ctx.blobs`：原来是平台托管的 blob 存储；这里是本地文件存储
//    （server/src/blobs.ts），图片存在 BLOB_DIR 下，由 /blobs/:key 提供。
//   - `Ctx.invalidateQueries`：原来通知所有打开的客户端刷新 React
//     Query；独立部署没有这个通道，客户端本来就会在 mutation 成功后
//     自己 invalidateQueries，所以这里是 no-op。

import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { z } from "zod";

export { z };

export interface BlobPutOptions {
  contentType?: string;
}

export interface BlobClient {
  put(key: string, bytes: Uint8Array, options?: BlobPutOptions): Promise<void>;
  getUrl(key: string): Promise<string>;
}

/** Per-invocation context passed to every action handler. */
export interface Ctx {
  readonly db: <TSchema extends Record<string, unknown>>() => BunSQLiteDatabase<TSchema>;
  readonly blobs: BlobClient;
  /** No-op standalone（见文件头注释）; kept so actions.ts 不用改。 */
  invalidateQueries(): void;
}

export interface ActionDefinition<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  request: Req;
  response: Res;
  description?: string;
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}

export function defineAction<Req extends z.ZodType, Res extends z.ZodType>(spec: {
  description?: string;
  request: Req;
  response: Res;
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}): ActionDefinition<Req, Res> {
  return {
    request: spec.request,
    response: spec.response,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    handler: spec.handler,
  };
}

/** The shape `server/src/actions.ts` must satisfy (keeps stray exports out). */
export type ActionsModule = Record<string, ActionDefinition<z.ZodType, z.ZodType>>;
