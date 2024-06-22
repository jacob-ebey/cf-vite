import { DurableObject } from "cloudflare:workers";

import { CloudflareModuleRunner } from "./module-runner.js";
import type { RunnerEnv, RunnerFetchMetadata } from "./shared.js";
import { RUNNER_INIT_PATH } from "./shared.js";

// Only a single WorkerRunner is created by the plugin per vite environment
// This acts as the "fetch()" entypoint for development. It is called with
// server.environments.ssr.dispatchFetch(
//   "src/index.ts",
//   new Request("https://localhost:5173/")
// );

export class WorkerRunner extends DurableObject<RunnerEnv> {
  #runner: CloudflareModuleRunner | undefined;

  async fetch(request: Request) {
    try {
      const url = new URL(request.url);
      switch (url.pathname) {
        case RUNNER_INIT_PATH:
          const [client, server] = Object.values(new WebSocketPair());
          (server as any).accept();
          this.#runner = new CloudflareModuleRunner(this.env, server);
          return new Response(null, { status: 101, webSocket: client });
        default:
          if (!this.#runner) {
            throw new Error("CloudflareModuleRunner not initialized");
          }
          const { entry } = JSON.parse(
            request.headers.get("x-vite-fetch")!
          ) as RunnerFetchMetadata;

          const mod = await this.#runner.import(entry);
          const handler = mod.default as ExportedHandler;
          if (!handler?.fetch) {
            throw new Error("");
          }

          return handler.fetch(request, this.env, {
            passThroughOnException: () => {
              console.warn(
                "passThroughOnException does nothing in cf-vite dev mode"
              );
            },
            waitUntil: (promise) => this.ctx.waitUntil(promise),
          });
      }
    } catch (e) {
      console.error(e);
      let body = "[vite workerd module runner error]\n";
      if (e instanceof Error) {
        body += `${e.stack ?? e.message}`;
      }
      return new Response(body, { status: 500 });
    }
  }
}
