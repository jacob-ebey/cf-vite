import { defineConfig } from "vite";

import cloudflare from "cf-vite";

export default defineConfig({
  builder: {
    async buildApp(builder) {
      await Promise.all([
        builder.build(builder.environments.ssr),
        builder.build(builder.environments.server),
      ]);
    },
  },
  environments: {
    ssr: {
      build: {
        outDir: "dist/ssr",
        rollupOptions: {
          input: "src/index.ts",
        },
      },
    },
    server: {
      build: {
        outDir: "dist/server",
        rollupOptions: {
          input: "src/counter.ts",
        },
      },
    },
  },
  plugins: [
    cloudflare({
      wranglerConfig: "wrangler.toml",
      dev: {
        ssr: {
          workers: [
            {
              entry: "src/index.ts",
            },
          ],
        },
        server: {
          durableObjects: {
            COUNTER: {
              entry: "src/counter.ts",
              className: "Counter",
            },
          },
        },
      },
    }),
  ],
});
