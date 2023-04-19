import { ChainId, SignedVaa } from "@certusone/wormhole-sdk";
import {
  Environment,
  RelayerEvents,
  FetchaVaasOpts,
  ParsedVaaWithBytes,
  ListenerFn,
} from "./application";
import { Logger } from "winston";
import { ChainID } from "@certusone/wormhole-spydk/lib/cjs/proto/publicrpc/v1/publicrpc";
import { RelayJob } from "./storage/storage";

export type FetchVaaFn = (
  emitterChain: ChainId | string,
  emitterAddress: Buffer | string,
  sequence: bigint | string,
  opts?: { retryTimeout?: number; retries?: number },
) => Promise<ParsedVaaWithBytes>;

export type FetchVaasFn = (
  opts: FetchaVaasOpts,
) => Promise<ParsedVaaWithBytes[]>;

export interface Context {
  vaa?: ParsedVaaWithBytes;
  vaaBytes?: SignedVaa;
  locals: Record<any, any>;
  fetchVaa: FetchVaaFn;
  fetchVaas: FetchVaasFn;
  processVaa: (vaa: Buffer) => Promise<void>;
  env: Environment;
  logger?: Logger;
  on: (eventName: RelayerEvents, listener: ListenerFn) => void;
  config: {
    spyFilters: {
      emitterFilter?: { chainId?: ChainID; emitterAddress?: string };
    }[];
  };
}
