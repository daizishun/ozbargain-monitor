// 仅执行数据库迁移（`bun run migrate`）。`bun run start` 启动时
// 也会自动执行迁移，这个脚本是给只想建库 / 升级表结构时用的。

import { runMigrations } from "./db";

runMigrations();
console.log("migrations applied");
