import { Next, RelayerApp } from "wormhole-relay";

import { CHAIN_ID_SOLANA } from "@certusone/wormhole-sdk";
import {
  logging,
  LoggingContext,
} from "wormhole-relay/lib/middleware/logger.middleware";
import { rootLogger } from "./log";
import { ApiController } from "./controller";

async function main() {
  const app = new RelayerApp<LoggingContext>();

  app.spy("localhost:7073");
  app.logger(rootLogger);

  app.use(logging(rootLogger)); // <-- logging middleware

  const fundsCtrl = new ApiController();

  app
    .chain(CHAIN_ID_SOLANA)
    .address(
      "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
      fundsCtrl.processFundsTransfer
    );

  await app.listen();
}

main();
