// 本地 blob 存储：替代原来平台托管的 ctx.blobs。
//
// 图片以文件形式存在 BLOB_DIR 下（默认 ./data/blobs），文件名就是
// key（deal-<nodeId>.jpg），content-type 存在同名 .meta.json 里。
// 对外通过 /blobs/:key 提供访问，getUrl 返回的就是这个路径。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blobDir } from "./db";
import type { BlobClient } from "./sdk";

function safeKey(key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || key.includes("..")) {
    throw new Error(`invalid blob key: ${key}`);
  }
  return key;
}

function metaPath(key: string): string {
  return join(blobDir, `${key}.meta.json`);
}

export function readBlob(key: string): { bytes: Buffer; contentType: string } | null {
  const safe = safeKey(key);
  const path = join(blobDir, safe);
  if (!existsSync(path)) return null;
  let contentType = "application/octet-stream";
  if (safe.endsWith(".jpg") || safe.endsWith(".jpeg")) contentType = "image/jpeg";
  else if (safe.endsWith(".png")) contentType = "image/png";
  else if (safe.endsWith(".webp")) contentType = "image/webp";
  else if (safe.endsWith(".gif")) contentType = "image/gif";
  if (existsSync(metaPath(safe))) {
    try {
      const meta = JSON.parse(readFileSync(metaPath(safe), "utf8")) as { contentType?: string };
      if (meta.contentType) contentType = meta.contentType;
    } catch {
      // 损坏的 meta 文件不影响图片本身，按扩展名推断。
    }
  }
  return { bytes: readFileSync(path), contentType };
}

export const blobs: BlobClient = {
  async put(key, bytes, options) {
    const safe = safeKey(key);
    mkdirSync(blobDir, { recursive: true });
    writeFileSync(join(blobDir, safe), bytes);
    writeFileSync(
      metaPath(safe),
      JSON.stringify({ contentType: options?.contentType ?? "image/jpeg" }),
    );
  },
  async getUrl(key) {
    return `/blobs/${encodeURIComponent(safeKey(key))}`;
  },
};
