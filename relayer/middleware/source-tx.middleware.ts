/// <reference lib="dom" />
import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import { Environment } from "../application";
import { sleep } from "../utils";
import { ChainId, isEVMChain } from "@certusone/wormhole-sdk";

export interface SourceTxOpts {
  wormscanEndpoint: string;
  retries: 3;
}

export interface SourceTxContext extends Context {
  sourceTxHash?: string;
}

const defaultOptsByEnv = {
  [Environment.MAINNET]: {
    wormscanEndpoint: "https://api.wormscan.io",
  },
  [Environment.TESTNET]: {
    wormscanEndpoint: "https://api.testnet.wormscan.io",
  },
  [Environment.DEVNET]: {
    wormscanEndpoint: "",
  },
};

export function sourceTx(
  optsWithoutDefaults?: SourceTxOpts
): Middleware<SourceTxContext> {
  let opts: SourceTxOpts;
  return async (ctx, next) => {
    if (!opts) {
      opts = Object.assign({}, defaultOptsByEnv[ctx.env], optsWithoutDefaults);
    }

    const { emitterChain, emitterAddress, sequence } = ctx.vaa;
    let attempt = 0;
    let txHash = "";
    ctx.logger?.debug("Fetching tx hash...");
    do {
      try {
        txHash = await fetchVaaHash(
          opts.wormscanEndpoint,
          emitterChain,
          emitterAddress,
          sequence
        );
      } catch (e) {
        ctx.logger?.error(
          `could not obtain txHash, attempt: ${attempt} of ${opts.retries}.`,
          e
        );
        await sleep(attempt * 200); // linear wait
      }
    } while (attempt < opts.retries && !txHash);
    if (
      isEVMChain(ctx.vaa.emitterChain as ChainId) &&
      txHash &&
      !txHash.startsWith("0x")
    ) {
      txHash = `0x${txHash}`;
    }
    ctx.logger?.debug(
      txHash === ""
        ? "Could not retrive tx hash."
        : `Retrieved tx hash: ${txHash}`
    );
    ctx.sourceTxHash = txHash;
    await next();
  };
}

async function fetchVaaHash(
  baseEndpoint: string,
  emitterChain: number,
  emitterAddress: Buffer,
  sequence: bigint
) {
  const res = await fetch(
    `${baseEndpoint}/api/v1/vaas/${emitterChain}/${emitterAddress.toString(
      "hex"
    )}/${sequence.toString()}`
  );
  if (res.status === 404) {
    throw new Error("Not found yet.");
  } else if (res.status > 500) {
    throw new Error(`Got: ${res.status}`);
  }
  return (await res.json()).data?.txHash || "";
}
