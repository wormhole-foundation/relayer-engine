import { rootLogger } from "./log.js";
import {
  Context,
  RelayerApp,
  RedisStorage,
} from "@wormhole-foundation/relayer-engine";

export function configRelayer<T extends Context>(
  app: RelayerApp<T>,
  store: RedisStorage
) {
  app.spy("localhost:7073");
  app.useStorage(store);
  app.logger(rootLogger);
}
