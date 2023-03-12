import { Logger } from "winston";
import { Middleware } from "../compose.middleware";
import { Context } from "../context";

export class LoggingContext extends Context {
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
    await next();
  };
}
