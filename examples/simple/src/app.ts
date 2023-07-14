import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";
import { CHAIN_ID_SOLANA, TokenBridgePayload } from "@certusone/wormhole-sdk";

(async function main() {
  // initialize relayer engine app, pass relevant config options
  const app = new StandardRelayerApp<StandardRelayerContext>(
    Environment.TESTNET,
    // other app specific config options can be set here for things
    // like retries, logger, or redis connection settings.
    {
      name: "ExampleRelayer",
    },
  );

  // add a filter with a callback that will be
  // invoked on finding a VAA that matches the filter
  app.chain(CHAIN_ID_SOLANA).address(
    "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe", // emitter address on Solana
    // callback function to invoke on new message
    async (ctx, next) => {
      ctx.logger.info(
        `Got a VAA with sequence: ${ctx.vaa?.sequence} from with txhash: ${ctx.sourceTxHash}`,
      );

      const {payload} = ctx.tokenBridge

      // only care about transfers
      switch (payload?.payloadType) {
        case TokenBridgePayload.Transfer:
          ctx.logger.info(`Transfer processing for: \n` +
            `\tToken: ${payload.tokenChain}:${payload.tokenAddress.toString('hex')}\n` +
            `\tAmount: ${payload.amount}\n` +
            `\tReceiver: ${payload.toChain}:${payload.to.toString('hex')}\n`);
          // TODO: redeem
          break;
        case TokenBridgePayload.TransferWithPayload:
          ctx.logger.info(`Transfer processing for: \n` +
            `\tToken: ${payload.tokenChain}:${payload.tokenAddress.toString('hex')}\n` +
            `\tAmount: ${payload.amount}\n` +
            `\tSender ${payload.fromAddress?.toString('hex')}\n` +
            `\tReceiver: ${payload.toChain}:${payload.to.toString('hex')}\n`+
            `\tPayload: ${payload.tokenTransferPayload.toString('hex')}\n`);
          // TODO: redeem
          break;
      }

      // invoke the next layer in the middleware pipeline
      next();
    },
  );

  // rando token transfer VAA from Sol
  const tmpvaa = Buffer.from("AQAAAAABAJhoIpjSRXkgBWn36i/ULs79LzTVnCusLvAvB27UO8CRB2vhOHrQweHWXnZAoUKpeIZ2VtvmLwSLMvAYa4Oy/SMBZLGAxQAAc38AATsmQJ+Kre0/XdyhhGlapqD6gpsMhcr4SFYySJbSFMqYAAAAAAAAXc8gAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACYloABpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAEAAW2a5rLTM8HWUwGlnaPu04jKXcYMsSSWWEt1y+axX9vtACC+6/ZVk+zI95lF4zZqA44cLkY+fu0ikgdvAuPVrcr6rXsiYmFzaWNfcmVjaXBpZW50Ijp7InJlY2lwaWVudCI6ImMyVnBNV1ptWkd0dGR6Sm1jbkE0TW1zM09EaDZlWGx0Ym5kNWRuSmphemRuY1hremF6Um1OMk5sIn19", 'base64')
  // start app, blocks until unrecoverable error or process is stopped
  app.listen();
  await app.processVaa(tmpvaa)
})();
