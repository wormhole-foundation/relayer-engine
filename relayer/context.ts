import {
  FetchaVaasOpts,
  ListenerFn,
  ParsedVaaWithBytes,
  RelayerEvents,
} from "./application.js";
import { Logger } from "winston";
import { Environment } from "./environment.js";
import { ChainId } from "@wormhole-foundation/sdk";

export type FetchVaaFn = (
  emitterChain: ChainId | string,
  emitterAddress: Uint8Array | string,
  sequence: bigint | string,
  opts?: { retryTimeout?: number; retries?: number },
) => Promise<ParsedVaaWithBytes>;

export type FetchVaasFn = (
  opts: FetchaVaasOpts,
) => Promise<ParsedVaaWithBytes[]>;

export interface Context {
  vaa?: ParsedVaaWithBytes;
  vaaBytes?: Uint8Array;
  locals: Record<any, any>;
  fetchVaa: FetchVaaFn;
  fetchVaas: FetchVaasFn;
  processVaa: (vaa: Buffer) => Promise<void>;
  env: Environment;
  logger?: Logger;
  on: (eventName: RelayerEvents, listener: ListenerFn) => void;
  config: {
    spyFilters: {
      emitterFilter?: { chainId?: ChainId; emitterAddress?: string };
    }[];
  };
}
