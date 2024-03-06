import {
  TokenBridge,
  canonicalAddress,
  toChainId,
} from "@wormhole-foundation/sdk";
import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";

(async function main() {
  // initialize relayer engine app, pass relevant config options
  const app = new StandardRelayerApp<StandardRelayerContext>(
    Environment.TESTNET,
    // other app specific config options can be set here for things
    // like retries, logger, or redis connection settings.
    {
      name: `ExampleRelayer`,
    },
  );

  // add a filter with a callback that will be
  // invoked on finding a VAA that matches the filter
  app.chain(toChainId("Solana")).address(
    "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe", // emitter address on Solana
    // callback function to invoke on new message
    async (ctx, next) => {
      ctx.logger.info(
        `Got a VAA with sequence: ${ctx.vaa?.sequence} from with txhash: ${ctx.sourceTxHash}`,
      );

      let { vaa } = ctx.tokenBridge;

      // only care about transfers
      // TODO: do something more interesting than logging like:
      // - redemption of VAA on target chain
      // - tracking transfer amounts over time
      switch (vaa.payloadLiteral) {
        case "TokenBridge:Transfer":
          ctx.logger.info(
            `Transfer processing for: \n` +
              `\tToken: ${vaa.payload.token.chain}:${canonicalAddress(
                vaa.payload.token,
              )}\n` +
              `\tAmount: ${vaa.payload.token.amount}\n` +
              `\tReceiver: ${vaa.payload.to.chain}:${canonicalAddress(
                vaa.payload.to,
              )}\n`,
          );
          break;
        case "TokenBridge:TransferWithPayload":
          const { payload } = vaa as TokenBridge.VAA<"TransferWithPayload">;
          ctx.logger.info(
            `Transfer processing for: \n` +
              `\tToken: ${payload.token.chain}:${canonicalAddress(
                payload.token,
              )}\n` +
              `\tAmount: ${payload.token.amount}\n` +
              `\tSender ${payload.from.toString()}\n` +
              `\tReceiver: ${payload.to.chain}:${canonicalAddress(
                payload.to,
              )}\n` +
              `\tPayload: ${payload.payload}\n`,
          );
          break;
      }

      // invoke the next layer in the middleware pipeline
      next();
    },
  );

  // start app, blocks until unrecoverable error or process is stopped
  await app.listen();
})();
