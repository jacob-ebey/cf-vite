import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  async getCount() {
    return (await this.ctx.storage.get<number>("count")) || 0;
  }
  increment() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const count = (await this.getCount()) + 1;
      await this.ctx.storage.put("count", count);
      return count;
    });
  }
}
