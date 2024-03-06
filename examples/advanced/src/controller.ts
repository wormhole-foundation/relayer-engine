import { Next } from "@wormhole-foundation/relayer-engine";
import { MyRelayerContext } from "./app.js";
import { TokenBridge, canonicalAddress } from "@wormhole-foundation/sdk";

export class Controller {
  redeemVaa = async (ctx: MyRelayerContext, next: Next) => {
    let seq = ctx.vaa!.sequence.toString();
    ctx.logger.info(`chain middleware - ${seq} - ${ctx.sourceTxHash}`);

    const { vaa } = ctx.tokenBridge;

    // only care about transfers
    switch (vaa.payloadLiteral) {
      case "TokenBridge:Transfer":
        ctx.logger.info(
          `Transfer processing for: \n` +
            `\tToken: ${vaa.payload.token.chain}:${canonicalAddress(
              vaa.payload.token
            )}\n` +
            `\tAmount: ${vaa.payload.token.amount}\n` +
            `\tReceiver: ${vaa.payload.to.chain}:${canonicalAddress(
              vaa.payload.to
            )}\n`
        );
        break;
      case "TokenBridge:TransferWithPayload":
        const { payload } = vaa as TokenBridge.VAA<"TransferWithPayload">;
        ctx.logger.info(
          `Transfer processing for: \n` +
            `\tToken: ${payload.token.chain}:${canonicalAddress(
              payload.token
            )}\n` +
            `\tAmount: ${payload.token.amount}\n` +
            `\tSender ${payload.from.toString()}\n` +
            `\tReceiver: ${payload.to.chain}:${canonicalAddress(
              payload.to
            )}\n` +
            `\tPayload: ${payload.payload}\n`
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
