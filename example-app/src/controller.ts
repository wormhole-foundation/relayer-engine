import { LoggingContext } from "wormhole-relay/lib/middleware/logger.middleware";
import { Next } from "wormhole-relay";

export class ApiController {
  processFundsTransfer = async (ctx: LoggingContext, next: Next) => {
    ctx.logger.info("chain middleware");
    ctx.logger.info(ctx.vaa!.sequence.toString());
    ctx.logger.info(ctx.vaa!.hash.toString("hex"));
    await next();
    ctx.logger.info("chain middleware - end");
  };
}
