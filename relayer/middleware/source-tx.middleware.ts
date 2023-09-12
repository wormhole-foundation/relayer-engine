/// <reference lib="dom" />
import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import { sleep } from "../utils";
import {
  CHAIN_ID_BSC,
  CHAIN_ID_SOLANA,
  ChainId,
  isEVMChain,
} from "@certusone/wormhole-sdk";
import { Logger } from "winston";
import { Environment } from "../environment";
import { LRUCache } from "lru-cache";
import { ParsedVaaWithBytes } from "../application.js";

export interface SourceTxOpts {
  wormscanEndpoint: string;
  retries: number;
}

export interface SourceTxContext extends Context {
  sourceTxHash?: string;
}

export const wormscanEndpoints: { [k in Environment]: string | undefined } = {
  [Environment.MAINNET]: "https://api.wormscan.io",
  [Environment.TESTNET]: "https://api.testnet.wormscan.io",
  [Environment.DEVNET]: undefined,
};

const defaultOptsByEnv: { [k in Environment]: Partial<SourceTxOpts> } = {
  [Environment.MAINNET]: {
    wormscanEndpoint: wormscanEndpoints[Environment.MAINNET],
    retries: 5,
  },
  [Environment.TESTNET]: {
    wormscanEndpoint: wormscanEndpoints[Environment.TESTNET],
    retries: 3,
  },
  [Environment.DEVNET]: {
    wormscanEndpoint: wormscanEndpoints[Environment.DEVNET],
    retries: 3,
  },
};

function ifVAAFinalized(vaa: ParsedVaaWithBytes) {
  const { consistencyLevel, emitterChain } = vaa;
  if (emitterChain === CHAIN_ID_SOLANA) {
    return consistencyLevel === 32;
  } else if (emitterChain === CHAIN_ID_BSC) {
    return consistencyLevel > 15;
  }
  return consistencyLevel !== 200 && consistencyLevel !== 201;
}

export function sourceTx(
  optsWithoutDefaults?: SourceTxOpts,
): Middleware<SourceTxContext> {
  let opts: SourceTxOpts;
  const alreadyFetchedHashes = new LRUCache({ max: 1_000 });

  return async (ctx, next) => {
    if (!opts) {
      // initialize options now that we know the environment from context
      opts = Object.assign({}, defaultOptsByEnv[ctx.env], optsWithoutDefaults);
    }
    const vaaId = `${ctx.vaa.id.emitterChain}-${ctx.vaa.id.emitterAddress}-${ctx.vaa.id.sequence}`;
    const txHashFromCache = alreadyFetchedHashes.get(vaaId) as
      | string
      | undefined;

    if (txHashFromCache) {
      ctx.logger?.debug(`Already fetched tx hash: ${txHashFromCache}`);
      ctx.sourceTxHash = txHashFromCache;
      await next();
      return;
    }

    const { emitterChain, emitterAddress, sequence } = ctx.vaa;
    ctx.logger?.debug("Fetching tx hash...");
    let txHash = await fetchVaaHash(
      emitterChain,
      emitterAddress,
      sequence,
      ctx.logger,
      ctx.env,
      opts.retries,
      opts.wormscanEndpoint,
    );
    if (txHash === "") {
      ctx.logger?.debug("Could not retrieve tx hash.");
    } else {
      // TODO look at consistency level before using cache? (not sure what the checks are)
      if (ifVAAFinalized(ctx.vaa)) {
        alreadyFetchedHashes.set(vaaId, txHash);
      }
      ctx.logger?.debug(`Retrieved tx hash: ${txHash}`);
    }
    ctx.sourceTxHash = txHash;
    await next();
  };
}

export async function fetchVaaHash(
  emitterChain: number,
  emitterAddress: Buffer,
  sequence: bigint,
  logger: Logger,
  env: Environment,
  retries: number = 3,
  baseEndpoint: string = wormscanEndpoints[env],
) {
  let attempt = 0;
  let txHash = "";
  do {
    let body;
    try {
      const res = await fetch(
        `${baseEndpoint}/api/v1/vaas/${emitterChain}/${emitterAddress.toString(
          "hex",
        )}/${sequence.toString()}`,
      );
      if (res.status === 404) {
        throw new Error("Not found yet.");
      }

      // Note that we're assuming the response is UTF8 encoded here.
      body = await res.text();
      if (!res.ok) {
        throw new Error(`Unexpected HTTP response. Status: ${res.status}`);
      }

      // TODO: consider restricting this code path further to just status 200 and a few others.
      txHash = JSON.parse(body).data?.txHash;
    } catch (error) {
      const httpBodyText =
        body !== undefined ? `\nHTTP response body: ${body}` : "";
      const errorMessage = `could not obtain txHash, attempt: ${attempt} of ${retries}.${httpBodyText}
Error: ${error}`;
      logger?.error(errorMessage);
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

  logger.debug("Source Transaction Hash: " + txHash || "Not Found");

  return txHash;
}
