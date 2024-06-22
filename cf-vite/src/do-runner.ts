import { DurableObject } from "cloudflare:workers";

import { CloudflareModuleRunner } from "./module-runner.js";
import type { RunnerEnv } from "./shared.js";
import { RUNNER_INIT_PATH } from "./shared.js";

declare class ConstructableDurableObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: any);
}

declare global {
  var __cloudflareModuleRunner: CloudflareModuleRunner | undefined;
  var __cloudflareClass: typeof ConstructableDurableObject | undefined;
}
globalThis.__cloudflareClass = globalThis.__cloudflareClass;
globalThis.__cloudflareModuleRunner = globalThis.__cloudflareModuleRunner;

const __CLOUDFLARE_ENTRY = "__ENTRY__";
const __CLOUDFLARE_CLASS_NAME = "__CLASS_NAME__";

export class DoRunner extends DurableObject<RunnerEnv> {
  #instance: DurableObject | undefined;

  constructor(ctx: DurableObjectState, env: RunnerEnv) {
    super(ctx, env);

    if (__cloudflareClass) {
      this.#instance = new __cloudflareClass!(
        ctx,
        env
      ) as unknown as typeof this;

      const proxyKeys = new Set(
        Object.getOwnPropertyNames(__cloudflareClass!.prototype)
      );
      proxyKeys.delete("constructor");
      proxyKeys.delete("fetch");

      return new Proxy(this.#instance, {
        get: (target, prop, receiver) => {
          if (proxyKeys.has(prop as string)) {
            const self = this;
            return async (...args: any[]) => {
              const instance = await this.#getInstance();
              return (instance as any)[prop](...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as DoRunner;
    }
  }

  async #getClass(): Promise<typeof ConstructableDurableObject> {
    if (!__cloudflareModuleRunner) {
      throw new Error("Vite module runner not initialized");
    }
    const mod = await __cloudflareModuleRunner.import(__CLOUDFLARE_ENTRY);
    const Class = mod[__CLOUDFLARE_CLASS_NAME];

    for (const key of Object.keys(Class.prototype)) {
      if (key === "fetch" || key === "constructor") continue;
      Reflect.deleteProperty(this, key);
      Reflect.deleteProperty(DoRunner.prototype, key);
      const rpcProxy = async (...args: any[]) => {
        const instance = await this.#getInstance();
        return (instance as any)[key](...args);
      };
      Reflect.defineProperty(this, key, {
        get: () => rpcProxy,
      });
      Reflect.defineProperty(DoRunner.prototype, key, {
        get: () => rpcProxy,
      });
    }

    return Class;
  }

  async #getInstance() {
    const Class = await this.#getClass();
    if (!__cloudflareClass || __cloudflareClass !== Class || !this.#instance) {
      this.#instance = undefined;
      this.#instance = new Class(this.ctx, this.env);
    }
    __cloudflareClass = Class;
    return this.#instance!;
  }

  async fetch(request: Request) {
    try {
      const url = new URL(request.url);
      switch (url.pathname) {
        case RUNNER_INIT_PATH:
          const [client, server] = Object.values(new WebSocketPair());
          (server as any).accept();
          __cloudflareModuleRunner = new CloudflareModuleRunner(
            this.env,
            server
          );
          __cloudflareClass = await this.#getClass();

          return new Response(null, { status: 101, webSocket: client });
        default:
          const instance = await this.#getInstance();
          if (!instance.fetch) {
            return new Response("fetch() missing in durable object");
          }
          return instance.fetch(request);
      }
    } catch (e) {
      console.error(e);
      let body = "[vite workerd durable object runner error]\n";
      if (e instanceof Error) {
        body += `${e.stack ?? e.message}`;
      }
      return new Response(body, { status: 500 });
    }
  }
}
