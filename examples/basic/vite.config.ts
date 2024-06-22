import { defineConfig } from "vite";

import cloudflare from "cf-vite";

export default defineConfig({
  environments: {
    ssr: {
      build: {
        rollupOptions: {
          input: "src/index.ts",
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
      },
    }),
  ],
});
