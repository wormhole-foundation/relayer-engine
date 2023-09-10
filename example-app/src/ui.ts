import { RelayerApp } from "@wormhole-foundation/relayer-engine";
import { RedisStorage } from "@wormhole-foundation/relayer-engine/storage/redis-storage";
import { Logger } from "winston";
import Koa from "koa";

export function runUI(
  relayer: RelayerApp<any>,
  store: RedisStorage,
  { port }: any,
  logger: Logger
) {
  const app = new Koa();

  app.use(store.storageKoaUI("/ui"));
  app.use(async (ctx, next) => {
    if (ctx.request.method !== "GET" && ctx.request.url !== "/metrics") {
      await next();
      return;
    }

    ctx.body = await store.registry.metrics();
  });

  port = Number(port) || 3000;
  app.listen(port, () => {
    logger.info(`Running on ${port}...`);
    logger.info(`For the UI, open http://localhost:${port}/ui`);
    logger.info("Make sure Redis is running on port 6379 by default");
  });
}
