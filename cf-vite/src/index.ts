import EventEmitter from "node:events";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createMiddleware } from "@hattip/adapter-node/native-fetch";
import {
  Miniflare,
  MiniflareOptions,
  Response as MiniflareResponse,
  WorkerOptions,
} from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import {
  CustomPayload,
  DevEnvironment,
  DevEnvironmentSetup,
  type PluginOption,
  type ResolvedConfig,
  type UserConfig,
} from "vite";

import { RUNNER_INIT_PATH, RunnerFetchMetadata } from "./shared.js";

type EnvironmentOptions = NonNullable<UserConfig["environments"]>[string];

export type CloudflareDevDurableObjectOptions = {
  entry: string;
  className: string;
};

export type CloudflareDevWorkerOptions = {
  entry: string;
  /**
   * The express path pattern to match for requests to the dev server
   * that will be handled by this worker.
   * @default ""
   */
  route?: string;
};

export type CloudflareDevEnvOptions = {
  durableObjects?: Record<string, CloudflareDevDurableObjectOptions>;
  workers?: CloudflareDevWorkerOptions[];
};

export type CloudflareOptions = {
  dev: Record<string, CloudflareDevEnvOptions>;
  doNotServe?: boolean;
  wranglerConfig?: string;
};

export default function cloudflare({
  dev,
  doNotServe,
  wranglerConfig,
}: CloudflareOptions): PluginOption {
  const environments = Object.keys(dev);

  let miniflare: Miniflare;
  let config: ResolvedConfig;
  const devEnvs = new Map<string, WorkerdDevEnvironment>();
  const webSockets = new Map<string, WebSocket[]>();
  const getMiniflare = async () => {
    if (!miniflare) {
      miniflare = await createMiniflare(
        dev,
        wranglerConfig,
        devEnvs,
        webSockets,
        config
      );
    }
    return miniflare;
  };

  return [
    {
      name: "cf-vite",
      config(userConfig) {
        return {
          environments: Object.fromEntries(
            environments.map((env) => {
              const userEnv = userConfig.environments?.[env];
              return [
                env,
                {
                  webCompatible:
                    userEnv && "webCompatible" in userEnv
                      ? userEnv.webCompatible
                      : true,
                  build: {
                    ssr: true,
                    rollupOptions: {
                      external: [
                        "cloudflare:email",
                        "cloudflare:sockets",
                        "cloudflare:workers",
                      ],
                    },
                  },
                  dev: {
                    createEnvironment: (name, config) => {
                      const env = new WorkerdDevEnvironment(
                        name,
                        config,
                        dev,
                        getMiniflare,
                        () => webSockets.get(name) || []
                      );
                      devEnvs.set(name, env);
                      return env;
                    },
                  },
                  resolve: {
                    mainFields: ["module"],
                    conditions: ["workerd"],
                    externalConditions: ["workerd", "module"],
                    noExternal: true,
                    external: [
                      "cloudflare:email",
                      "cloudflare:sockets",
                      "cloudflare:workers",
                    ],
                  },
                } satisfies EnvironmentOptions,
              ];
            })
          ),
        };
      },
      configResolved(resolved) {
        config = resolved;
      },
      configureServer(server) {
        if (doNotServe) return;
        return () => {
          for (const env of environments) {
            const { workers } = dev[env];
            if (workers) {
              for (const { entry, route = "" } of workers) {
                const devEnvironment = server.environments[
                  env
                ] as WorkerdDevEnvironment;
                server.middlewares.use(route, (req, res) => {
                  req.url = req.originalUrl ?? req.url;
                  return createMiddleware(
                    (c) => devEnvironment.dispatchFetch(entry, c.request),
                    { alwaysCallNext: false }
                  )(req, res);
                });
              }
            }
          }
        };
      },
      hotUpdate(ctx) {
        if (environments.includes(ctx.environment.name)) {
          for (const mod of ctx.modules) {
            ctx.environment.moduleGraph.invalidateModule(mod);
          }
          const devEnv = devEnvs.get(ctx.environment.name);
          devEnv?.hot.send({
            type: "full-reload",
          });

          return [];
        }
      },
    },
    {
      name: "cf-vite-externals",
      enforce: "pre",
    },
  ];
}

class WorkerdDevEnvironment extends DevEnvironment {
  #getMiniflare: () => Promise<Miniflare>;

  constructor(
    name: string,
    config: ResolvedConfig,
    dev: Record<string, CloudflareDevEnvOptions>,
    getMiniflare: () => Promise<Miniflare>,
    getWebSockets: () => WebSocket[]
  ) {
    const eventEmitter = new EventEmitter();
    super(name, config, {
      hot: {
        off: (eventName: string, listener: (...args: any[]) => void) => {
          eventEmitter.removeListener(eventName, listener);
        },
        on: (eventName: string, listener: (...args: any[]) => void) => {
          eventEmitter.addListener(eventName, listener);
        },
        async close() {
          for (const webSocket of getWebSockets()) {
            webSocket.close();
          }
        },
        async listen() {
          await getMiniflare();
          for (const webSocket of getWebSockets()) {
            webSocket.addEventListener("message", (event) => {
              const payload = JSON.parse(
                typeof event.data === "string"
                  ? event.data
                  : new TextDecoder().decode(event.data)
              ) as CustomPayload;
              eventEmitter.emit(payload.event, payload.data);
            });
          }
        },
        send(...args: any[]) {
          let payload: any;
          if (typeof args[0] === "string") {
            payload = {
              type: "custom",
              event: args[0],
              data: args[1],
            };
          } else {
            payload = args[0];
          }
          for (const webSocket of getWebSockets()) {
            webSocket.send(JSON.stringify(payload));
          }
        },
      },
    } satisfies DevEnvironmentSetup);

    this.#getMiniflare = getMiniflare;
  }

  override async close() {
    await super.close();
    try {
      await (await this.#getMiniflare()).dispose();
    } catch {}
  }

  async dispatchFetch(entry: string, request: Request) {
    const miniflare = await this.#getMiniflare();
    const VITE_RUNNER = await miniflare.getDurableObjectNamespace(
      `VITE_RUNNER__${this.name}`
    );
    const stub = VITE_RUNNER.get(VITE_RUNNER.idFromName(""));

    const headers = new Headers(request.headers);
    headers.set(
      "x-vite-fetch",
      JSON.stringify({ entry } satisfies RunnerFetchMetadata)
    );

    const res = await stub.fetch(request.url, {
      method: request.method,
      headers,
      body: request.body === null ? undefined : (request.body as any),
      redirect: "manual",
      duplex: request.body !== null ? "half" : undefined,
    });
    return new Response(res.body as BodyInit, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers as Headers,
    });
  }
}

async function createMiniflare(
  dev: Record<string, CloudflareDevEnvOptions>,
  wranglerConfig: string | undefined,
  devEnvs: Map<string, WorkerdDevEnvironment>,
  webSockets: Map<string, WebSocket[]>,
  config: ResolvedConfig
) {
  const durableObjectRunnerScriptPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "do-runner.js"
  );
  const durableObjectRunnerScript = await fsp.readFile(
    durableObjectRunnerScriptPath,
    "utf8"
  );
  const workerRunnerScriptPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "worker-runner.js"
  );

  const environments = Object.keys(dev);
  const workers: WorkerOptions[] = [];
  const runnerDOs: string[] = [];

  const miniflareOptions = wranglerConfig
    ? unstable_getMiniflareWorkerOptions(
        path.resolve(config.root, wranglerConfig)
      )
    : null;

  const {
    bindings,
    d1Databases,
    durableObjects: _durableObjects,
    kvNamespaces,
    r2Buckets,
    serviceBindings,
    compatibilityDate,
    compatibilityFlags,
    ...workerOptions
  } = miniflareOptions?.workerOptions || {};
  const durableObjects = (_durableObjects || {}) as Record<
    string,
    { className: string; scriptName: string }
  >;

  for (const env of environments) {
    const doName = `VITE_RUNNER__${env}`;
    runnerDOs.push(doName);
    workers.push({
      modulesRoot: "/",
      unsafeEvalBinding: "VITE_UNSAFE_EVAL",
      d1Databases,
      kvNamespaces,
      r2Buckets,
      compatibilityDate,
      compatibilityFlags,
      name: doName,
      bindings: {
        ...bindings,
        VITE_ENVIRONMENT: env,
        VITE_ROOT: config.root,
      },
      durableObjects: {
        ...durableObjects,
        [doName]: "WorkerRunner",
      },
      serviceBindings: {
        ...serviceBindings,
        VITE_FETCH_MODULE: async (request) => {
          const [id, importer, devEnv] = (await request.json()) as [
            string,
            string,
            string
          ];
          const devEnvToUse = devEnvs.get(devEnv);
          try {
            if (!devEnvToUse) {
              throw new Error(`DevEnvironment ${devEnv} not found`);
            }
            const result = await devEnvToUse.fetchModule(id, importer);
            return new MiniflareResponse(JSON.stringify(result));
          } catch (error) {
            return new MiniflareResponse(JSON.stringify({ externalize: id }));
          }
        },
      },
      modules: [
        {
          type: "ESModule",
          path: workerRunnerScriptPath,
        },
      ],
    });

    for (const [binding, { className, entry }] of Object.entries(
      dev[env].durableObjects ?? {}
    )) {
      const scriptName = `VITE_DO_RUNNER_${binding}`;
      durableObjects[binding] = {
        scriptName,
        className: "DoRunner",
      };
      runnerDOs.push(binding);

      durableObjects[binding] = {
        scriptName,
        className: "DoRunner",
      };

      workers.push({
        modulesRoot: "/",
        unsafeEvalBinding: "VITE_UNSAFE_EVAL",
        d1Databases,
        kvNamespaces,
        r2Buckets,
        compatibilityDate,
        compatibilityFlags,
        name: scriptName,
        durableObjects: {
          [binding]: "DoRunner",
        },
        bindings: {
          ...bindings,
          VITE_ENVIRONMENT: env,
          VITE_ROOT: config.root,
        },
        serviceBindings: {
          ...serviceBindings,
          VITE_FETCH_MODULE: async (request) => {
            const [id, importer, devEnv] = (await request.json()) as [
              string,
              string,
              string
            ];
            const devEnvToUse = devEnvs.get(devEnv);
            try {
              if (!devEnvToUse) {
                throw new Error(`DevEnvironment ${devEnv} not found`);
              }
              const result = await devEnvToUse.fetchModule(id, importer);
              return new MiniflareResponse(JSON.stringify(result));
            } catch (error) {
              return new MiniflareResponse(JSON.stringify({ externalize: id }));
            }
          },
        },
        modules: [
          {
            type: "ESModule",
            path: durableObjectRunnerScriptPath,
            contents: durableObjectRunnerScript
              .replace("__ENTRY__", entry)
              .replace("__CLASS_NAME__", className),
          },
        ],
      });
    }
  }

  const miniflareInitOptions = {
    // ...workerOptions,
    unsafeEvalBinding: "VITE_UNSAFE_EVAL",
    cachePersist: true,
    d1Persist: true,
    kvPersist: true,
    r2Persist: true,
    durableObjectsPersist: true,
    cache: true,
    workers: workers.map((worker) => {
      return {
        ...worker,
        durableObjects: {
          ...Object.fromEntries(
            Object.entries(durableObjects || {}).filter(
              ([, v]) =>
                (v as { scriptName: string })?.scriptName !== worker.name
            )
          ),
          ...worker.durableObjects,
        },
      };
    }),
  } satisfies MiniflareOptions;

  const miniflare = new Miniflare(miniflareInitOptions);

  for (const env of environments) {
    const { durableObjects, workers } = dev[env];
    for (const { entry } of workers || []) {
      const VITE_RUNNER = await miniflare.getDurableObjectNamespace(
        `VITE_RUNNER__${env}`
      );
      const stub = VITE_RUNNER.get(VITE_RUNNER.idFromName(""));
      const response = await stub.fetch(
        "https://vite-init-runner" + RUNNER_INIT_PATH,
        {
          headers: {
            Upgrade: "websocket",
          },
        }
      );
      if (!response.webSocket) {
        throw new Error("Failed to initialize runner HMR");
      }
      const webSocket = response.webSocket as unknown as WebSocket;
      (webSocket as any).accept();
      webSockets.set(
        env,
        ((arr) => {
          arr.push(webSocket);
          return arr;
        })(webSockets.get(env) || [])
      );
    }

    for (const [binding, { entry }] of Object.entries(durableObjects || {})) {
      const VITE_RUNNER = await miniflare.getDurableObjectNamespace(binding);
      const stub = VITE_RUNNER.get(VITE_RUNNER.idFromName(""));

      const response = await stub.fetch(
        "https://vite-init-runner" + RUNNER_INIT_PATH,
        {
          headers: {
            Upgrade: "websocket",
          },
        }
      );

      if (!response.webSocket) {
        throw new Error("Failed to initialize runner HMR");
      }
      const webSocket = response.webSocket as unknown as WebSocket;
      (webSocket as any).accept();
      webSockets.set(
        env,
        ((arr) => {
          arr.push(webSocket);
          return arr;
        })(webSockets.get(env) || [])
      );
    }
  }

  return miniflare;
}
