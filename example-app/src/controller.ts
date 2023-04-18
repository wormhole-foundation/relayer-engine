import { Next } from "@wormhole-foundation/relayer-engine";
import { MyRelayerContext } from "./app";

export class ApiController {
  processFundsTransfer = async (ctx: MyRelayerContext, next: Next) => {
    let seq = ctx.vaa!.sequence.toString();
    ctx.logger.info(`chain middleware - ${seq} - ${ctx.sourceTxHash}`);

    await ctx.kv.withKey(["counter"], async ({ counter }) => {
      ctx.logger.debug(`Original counter value ${counter}`);
      counter = (counter ? counter : 0) + 1;
      ctx.logger.debug(`Counter value after update ${counter}`);
      return {
        newKV: { counter },
        val: counter,
      };
    });
    await next();
  };
}
