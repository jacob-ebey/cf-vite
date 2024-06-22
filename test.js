import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

async function spawnDevServer(dir) {
  let devServer = await createServer({
    root: path.resolve(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "examples"),
      dir
    ),
  });

  return {
    fetch(env, path = "/", init, entry = "src/index.ts") {
      return devServer.environments[env].dispatchFetch(
        entry,
        new Request(`http://localhost${path}`, init)
      );
    },
    async close() {
      await devServer.close();
    },
  };
}

test("basic", async (t) => {
  const server = await spawnDevServer("basic");
  t.after(async () => {
    await server.close();
  });

  assert.strictEqual(await (await server.fetch("ssr")).text(), "Hello, World!");
});

test("durable-object", async (t) => {
  const server = await spawnDevServer("durable-object");
  t.after(async () => {
    await server.close();
  });

  const initialHtml = await (await server.fetch("ssr")).text();
  const [, initialCountStr] = initialHtml.match(/Count: (\d+)/);
  const initialCount = Number.parseInt(initialCountStr, 10);
  await server.fetch("ssr", "/", { method: "POST" });
  const resultHtml = await (await server.fetch("ssr")).text();
  const [, resultCountStr] = resultHtml.match(/Count: (\d+)/);
  const resultCount = Number.parseInt(resultCountStr, 10);

  assert.strictEqual(initialCount + 1, resultCount);
});

test("multi-env", async (t) => {
  const server = await spawnDevServer("multi-env");
  t.after(async () => {
    await server.close();
  });

  const initialHtml = await (await server.fetch("ssr")).text();
  const [, initialCountStr] = initialHtml.match(/Count: (\d+)/);
  const initialCount = Number.parseInt(initialCountStr, 10);
  await server.fetch("ssr", "/", { method: "POST" });
  const resultHtml = await (await server.fetch("ssr")).text();
  const [, resultCountStr] = resultHtml.match(/Count: (\d+)/);
  const resultCount = Number.parseInt(resultCountStr, 10);

  assert.strictEqual(initialCount + 1, resultCount);
});
