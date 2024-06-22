import { defineConfig } from "tsup";

export default [
  defineConfig({
    entry: ["src/do-runner.ts"],
    format: ["esm"],
    platform: "browser",
    external: ["cloudflare:workers"],
    noExternal: ["vite/module-runner"],
  }),
  defineConfig({
    entry: ["src/worker-runner.ts"],
    format: ["esm"],
    platform: "browser",
    external: ["cloudflare:workers"],
    noExternal: ["vite/module-runner"],
  }),
  defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    dts: true,
    external: [
      "@hattip/adapter-node",
      "miniflare",
      "node:events",
      "node:fs/promises",
      "node:path",
      "node:url",
      "wrangler",
      "vite",
    ],
  }),
];
