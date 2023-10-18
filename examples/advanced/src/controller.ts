import { Next } from "@wormhole-foundation/relayer-engine";
import { TokenBridgePayload } from "@certusone/wormhole-sdk";
import { MyRelayerContext } from "./app.js";

export class Controller {
  redeemVaa = async (ctx: MyRelayerContext, next: Next) => {
    let seq = ctx.vaa!.sequence.toString();
    ctx.logger.info(`chain middleware - ${seq} - ${ctx.sourceTxHash}`);

    const { payload } = ctx.tokenBridge;

    // only care about transfers
    switch (payload?.payloadType) {
      case TokenBridgePayload.Transfer:
        ctx.logger.info(
          `Transfer processing for: \n` +
            `\tToken: ${payload.tokenChain}:${payload.tokenAddress.toString(
              "hex"
            )}\n` +
            `\tAmount: ${payload.amount}\n` +
            `\tReceiver: ${payload.toChain}:${payload.to.toString("hex")}\n`
        );
        break;
      case TokenBridgePayload.TransferWithPayload:
        ctx.logger.info(
          `Transfer processing for: \n` +
            `\tToken: ${payload.tokenChain}:${payload.tokenAddress.toString(
              "hex"
            )}\n` +
            `\tAmount: ${payload.amount}\n` +
            `\tSender ${payload.fromAddress?.toString("hex")}\n` +
            `\tReceiver: ${payload.toChain}:${payload.to.toString("hex")}\n` +
            `\tPayload: ${payload.tokenTransferPayload.toString("hex")}\n`
        );
        break;
    }

    // redeem vaa

    await next();
  };

  incrCounter = async (ctx: MyRelayerContext) => {
    await ctx.kv.withKey(["counter"], async ({ counter }) => {
      ctx.logger.debug(`Original counter value ${counter}`);
      counter = (counter ? counter : 0) + 1;
      ctx.logger.debug(`Counter value after update ${counter}`);
      return {
        newKV: { counter },
        val: counter,
      };
    });
  };
}
