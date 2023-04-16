/// <reference lib="dom" />
import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import { Environment } from "../application";
import { sleep } from "../utils";
import { ChainId, isEVMChain } from "@certusone/wormhole-sdk";
import { Logger } from "winston";

export interface SourceTxOpts {
  wormscanEndpoint: string;
  retries: 3;
}

export interface SourceTxContext extends Context {
  sourceTxHash?: string;
}

export const wormscanEndpoints = {
  [Environment.MAINNET]: "https://api.wormscan.io",
  [Environment.TESTNET]: "https://api.testnet.wormscan.io",
  [Environment.DEVNET]: "",
};

const defaultOptsByEnv = {
  [Environment.MAINNET]: {
    wormscanEndpoint: wormscanEndpoints[Environment.MAINNET],
  },
  [Environment.TESTNET]: {
    wormscanEndpoint: wormscanEndpoints[Environment.TESTNET],
  },
  [Environment.DEVNET]: {
    wormscanEndpoint: wormscanEndpoints[Environment.DEVNET],
  },
};

export function sourceTx(
  optsWithoutDefaults?: SourceTxOpts,
): Middleware<SourceTxContext> {
  let opts: SourceTxOpts;
  return async (ctx, next) => {
    if (!opts) {
      // initialize options now that we know the environment from context
      opts = Object.assign({}, defaultOptsByEnv[ctx.env], optsWithoutDefaults);
    }

    const { emitterChain, emitterAddress, sequence } = ctx.vaa;
    ctx.logger?.debug("Fetching tx hash...");
    let txHash = await fetchVaaHash(
      emitterChain,
      emitterAddress,
      sequence,
      opts.retries,
      ctx.logger,
      ctx.env,
      opts.wormscanEndpoint,
    );
    ctx.logger?.debug(
      txHash === ""
        ? "Could not retrive tx hash."
        : `Retrieved tx hash: ${txHash}`,
    );
    ctx.sourceTxHash = txHash;
    await next();
  };
}

export async function fetchVaaHash(
  emitterChain: number,
  emitterAddress: Buffer,
  sequence: bigint,
  retries: number,
  logger: Logger,
  env: Environment,
  baseEndpoint: string = wormscanEndpoints[env],
) {
  let attempt = 0;
  let txHash = "";
  do {
    try {
      const res = await fetch(
        `${baseEndpoint}/api/v1/vaas/${emitterChain}/${emitterAddress.toString(
          "hex",
        )}/${sequence.toString()}`,
      );
      if (res.status === 404) {
        throw new Error("Not found yet.");
      } else if (res.status > 500) {
        throw new Error(`Got: ${res.status}`);
      }
      return (await res.json()).data?.txHash || "";
    } catch (e) {
      logger?.error(
        `could not obtain txHash, attempt: ${attempt} of ${retries}.`,
        e,
      );
      await sleep((attempt + 1) * 200); // linear wait
    }
  } while (++attempt < retries && !txHash);

  if (
    isEVMChain(emitterChain as ChainId) &&
    txHash &&
    !txHash.startsWith("0x")
  ) {
    txHash = `0x${txHash}`;
  }

  return txHash;
}
