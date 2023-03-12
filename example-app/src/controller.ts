import { LoggingContext } from "wormhole-relayer/lib/middleware/logger.middleware";
import { Next } from "wormhole-relayer";
import { MyRelayerContext } from "./app";

export class ApiController {
  processFundsTransfer = async (ctx: MyRelayerContext, next: Next) => {
    let seq = ctx.vaa!.sequence.toString();
    ctx.logger.info(`chain middleware - ${seq}`);
    if (Math.random() < 0.8) {
      ctx.job.log("failed from processFundsTransfer");
      throw new Error("simulating failure");
    }
    await next();
  };
}
