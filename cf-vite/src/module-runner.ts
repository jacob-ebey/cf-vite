import { ModuleRunner } from "vite/module-runner";

import type { RunnerEnv } from "./shared.js";

export class CloudflareModuleRunner extends ModuleRunner {
  constructor(env: RunnerEnv, webSocket: WebSocket) {
    super(
      {
        root: env.VITE_ROOT,
        sourcemapInterceptor: "prepareStackTrace",
        transport: {
          fetchModule: async (id, importer) => {
            const response = await env.VITE_FETCH_MODULE.fetch(
              new Request("https://vite-fetch-module/", {
                method: "POST",
                body: JSON.stringify([id, importer, env.VITE_ENVIRONMENT]),
              })
            );
            if (!response.ok) {
              return {
                externalize: id,
              };
            }
            return await response.json();
          },
        },
        hmr: {
          connection: {
            isReady: () => true,
            onUpdate(callback) {
              webSocket.addEventListener("message", (event) => {
                callback(JSON.parse(event.data));
              });
            },
            send(messages) {
              webSocket.send(JSON.stringify(messages));
            },
          },
        },
      },
      {
        runInlinedModule: async (context, transformed, id) => {
          const codeDefinition = `'use strict';async (${Object.keys(
            context
          ).join(",")})=>{{`;
          const code = `${codeDefinition}${transformed}\n}}`;
          const fn = env.VITE_UNSAFE_EVAL.eval(code, id);
          await fn(...Object.values(context));
          Object.freeze(context.__vite_ssr_exports__);
        },
        runExternalModule: async (filepath) => {
          return import(filepath);
        },
      }
    );
  }
}
