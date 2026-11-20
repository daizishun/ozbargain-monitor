// 数据库：drizzle-orm + bun:sqlite，本地 SQLite 文件。
//
// DB_PATH 环境变量指定数据库文件位置（默认 ./data/app.db，相对于
// 运行目录）。首次启动时自动执行 drizzle/ 下的迁移建表，得到一个空库。

import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

export const dbPath = resolve(process.env.DB_PATH ?? "./data/app.db");
export const blobDir = resolve(process.env.BLOB_DIR ?? "./data/blobs");

mkdirSync(dirname(dbPath), { recursive: true });
mkdirSync(blobDir, { recursive: true });

const sqlite = new Database(dbPath);
export const db: BunSQLiteDatabase<typeof schema> = drizzle(sqlite, { schema });

const migrationsFolder = new URL("../../drizzle", import.meta.url).pathname;

/** 执行 drizzle/ 下的全部迁移（已执行过的会跳过，幂等）。 */
export function runMigrations(): void {
  migrate(db, { migrationsFolder });
}
