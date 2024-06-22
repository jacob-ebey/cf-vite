import type { Counter } from "./counter.js";

interface Env {
  COUNTER: DurableObjectNamespace<Counter>;
}

export default {
  async fetch(request, env) {
    const counter = env.COUNTER.get(env.COUNTER.idFromName("global"));

    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case "GET /":
        return new Response(html(await counter.getCount()), {
          headers: { "Content-Type": "text/html" },
        });
      case "POST /":
        await counter.increment();
        return new Response("", {
          status: 302,
          headers: {
            Location: "/",
          },
        });
      default:
        return new Response("Not Found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;

const html = (count: number) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Counter</title>
  </head>
  <body>
    <h1>Durable Object Counter</h1>
    <p>Count: ${count}</p>
    <form method="post">
      <button type="submit">Increment</button>
    </form>
  </body>
</html>`;
