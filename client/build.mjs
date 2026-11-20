// Client bundle: Bun.build() 打包 client/index.html 到 client/dist/。
// 与原来 SDK 的 buildClient 相同的配置：生产模式、tailwind 插件、
// 资产命名 assets/[name]-[hash].[ext]。
//
// Bun 会把 import 的资产写成裸路径 `./<name>-<hash>.<ext>`，但文件实际
// 在 `assets/` 子目录下，所以构建后要把这些引用重写为 `./assets/...`
//（否则浏览器请求会 404）。这个重写是幂等的。

import { basename } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const OUTDIR = "./client/dist";

const result = await Bun.build({
  entrypoints: ["./client/index.html"],
  outdir: OUTDIR,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("buildClient() failed; see logged diagnostics");
}

const assetFiles = result.outputs
  .filter((output) => output.kind === "asset")
  .map((output) => basename(output.path));

for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) continue;
  let text = await output.text();
  let changed = false;
  for (const name of assetFiles) {
    const bare = `./${name}`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`./assets/${name}`);
      changed = true;
    }
  }
  if (changed) {
    await Bun.write(output.path, text);
  }
}
