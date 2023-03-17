/// <reference lib="dom" />
import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import { Environment } from "../application";
import { sleep } from "../utils";

export interface SourceTxOpts {
  wormscanEndpoint: string;
  retries: 3;
}

export interface SourceTxContext extends Context {
  sourceTxHash?: string;
}

const defaultOptsByEnv = {
  [Environment.MAINNET]: {
    wormscanEndpoint: "https://api.wormscan.io"
  },
  [Environment.TESTNET]: {
    wormscanEndpoint: "https://api.testnet.wormscan.io"
  },
  [Environment.DEVNET]: {
    wormscanEndpoint: ""
  }
};

export function sourceTx(opts?: SourceTxOpts): Middleware<SourceTxContext> {

  return async (ctx, next) => {
    opts = Object.assign({}, defaultOptsByEnv[ctx.env], opts);

    const {emitterChain, emitterAddress, sequence} = ctx.vaa;
    let attempt = 0;
    let txHash = "";
    do {
      try {
        const res = await fetch(`${opts.wormscanEndpoint}/api/v1/vaas/${emitterChain}/${emitterAddress.toString("hex")}/${sequence.toString()}`);
        if (res.status === 404) {
          throw new Error("Not found yet.")
        } else if (res.status > 500) {
          throw new Error(`Got: ${res.status}`);
        }
        const vaaRes = await res.json();
        txHash = vaaRes.data?.txHash;
      } catch (e) {
        ctx.logger?.error(`could not obtain txHash, attempt: ${attempt} of ${opts.retries}.`, e);
        await sleep(attempt * 100); // linear wait
      }
    } while (attempt < opts.retries && txHash === "");
    ctx.sourceTxHash = txHash;
    await next();
  };
}
