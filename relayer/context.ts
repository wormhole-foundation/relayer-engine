import { ChainId, ParsedVaa } from "@certusone/wormhole-sdk";
import { Environment, FetchaVaasOpts, ParsedVaaWithBytes } from "./application";
import { Logger } from "winston";
import { ChainID } from "@certusone/wormhole-spydk/lib/cjs/proto/publicrpc/v1/publicrpc";

export type FetchVaaFn = (
  emitterChain: ChainId | string,
  emitterAddress: Buffer | string,
  sequence: bigint | string
) => Promise<ParsedVaaWithBytes>;

export type FetchVaasFn = (
  opts: FetchaVaasOpts
) => Promise<ParsedVaaWithBytes[]>;

export interface Context {
  vaa?: ParsedVaa;
  vaaBytes?: Buffer;

  fetchVaa: FetchVaaFn;
  fetchVaas: FetchVaasFn;
  processVaa: (vaa: Buffer) => Promise<void>;
  env: Environment;
  logger?: Logger;
  config: {
    spyFilters: {
      emitterFilter?: { chainId?: ChainID; emitterAddress?: string };
    }[];
  };
}
