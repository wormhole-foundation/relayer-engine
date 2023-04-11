import { Logger } from "winston";
import { Middleware } from "../compose.middleware";
import { Context } from "../context";

export interface LoggingContext extends Context {
  logger: Logger;
}

export function logging(logger: Logger): Middleware<LoggingContext> {
  return async (ctx: LoggingContext, next) => {
    ctx.logger = ctx.vaa
      ? logger.child({
          emitterChain: ctx.vaa.emitterChain,
          emitterAddress: ctx.vaa.emitterAddress.toString("hex"),
          sequence: ctx.vaa.sequence,
        })
      : logger;

    ctx.logger.debug(`Starting VAA processing`);
    try {
      await next();
    } catch (e) {
      ctx.logger.debug(`Error during VAA processing`, e);
      throw e;
    } finally {
      ctx.logger.debug(`Finished VAA processing`);
    }
  };
}
