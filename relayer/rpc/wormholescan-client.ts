import { HttpClient, HttpClientError } from "./http-client.js";

export interface Wormholescan {
  listVaas: (
    chain: number,
    emitterAddress: string,
    opts?: WormholescanOptions,
  ) => Promise<WormholescanResult<WormholescanVaa[]>>;
  getVaa: (
    chain: number,
    emitterAddress: string,
    sequence: bigint,
    opts?: WormholescanOptions,
  ) => Promise<WormholescanResult<WormholescanVaa>>;
}

/**
 * Client for the wormholescan API that never throws, but instead returns a WormholescanResult that may contain an error.
 */
export class WormholescanClient implements Wormholescan {
  private baseUrl: URL;
  private defaultOptions?: WormholescanOptions;
  private client: HttpClient;

  constructor(baseUrl: URL, defaultOptions?: WormholescanOptions) {
    this.baseUrl = baseUrl;
    this.defaultOptions = defaultOptions;
    this.client = new HttpClient({
      timeout: defaultOptions?.timeout,
      retries: defaultOptions?.retries,
      initialDelay: defaultOptions?.initialDelay,
      maxDelay: defaultOptions?.maxDelay,
      cache: defaultOptions?.noCache ? "no-cache" : "default",
    });
  }

  public async listVaas(
    chain: number,
    emitterAddress: string,
    opts?: WormholescanOptions,
  ): Promise<WormholescanResult<WormholescanVaa[]>> {
    try {
      const response = await this.client.get<{
        data: WormholescanVaaResponse[];
      }>(
        `${
          this.baseUrl
        }api/v1/vaas/${chain}/${emitterAddress}?page=${this.getPage(
          opts,
        )}&pageSize=${this.getPageSize(opts)}`,
        opts,
      );

      return {
        data: response.data.map(v => {
          return {
            ...v,
            vaa: Buffer.from(v.vaa, "base64"),
          };
        }),
      };
    } catch (err: Error | any) {
      return { error: err, data: [] };
    }
  }

  public async getVaa(
    chain: number,
    emitterAddress: string,
    sequence: bigint,
    opts?: WormholescanOptions,
  ): Promise<WormholescanResult<WormholescanVaa>> {
    try {
      const response = await this.client.get<{ data: WormholescanVaaResponse }>(
        `${
          this.baseUrl
        }api/v1/vaas/${chain}/${emitterAddress}/${sequence.toString()}`,
        opts,
      );
      return {
        data: {
          ...response.data,
          vaa: Buffer.from(response.data.vaa, "base64"),
        },
      };
    } catch (err: Error | any) {
      return this.mapError(err);
    }
  }

  public async getTransaction(
    chain: number,
    emitterAddress: string,
    sequence: bigint,
    opts?: WormholescanOptions,
  ): Promise<WormholescanResult<WormholescanTransaction>> {
    try {
      const response = await this.client.get<WormholescanTransaction>(
        `${
          this.baseUrl
        }api/v1/transactions/${chain}/${emitterAddress}/${sequence.toString()}`,
        opts,
      );

      return {
        data: response,
      };
    } catch (err: Error | any) {
      return this.mapError(err);
    }
  }

  private mapError(err: Error | any) {
    if (err instanceof HttpClientError) {
      return { error: err };
    }

    return { error: new HttpClientError(err.message) };
  }

  private getPage(opts?: WormholescanOptions) {
    return opts?.page ?? this.defaultOptions?.page ?? 0;
  }

  private getPageSize(opts?: WormholescanOptions) {
    return opts?.pageSize ?? this.defaultOptions?.pageSize ?? 10;
  }
}

export type WormholescanOptions = {
  pageSize?: number;
  page?: number;
  retries?: number;
  initialDelay?: number;
  maxDelay?: number;
  timeout?: number;
  noCache?: boolean;
};

/**
 * Raw response model.
 */
interface WormholescanVaaResponse {
  id: string;
  sequence: bigint;
  vaa: string;
  emitterAddr: string;
  emitterChain: number;
  txHash?: string;
}

/**
 * Parsed response model.
 */
export type WormholescanVaa = {
  id: string;
  sequence: bigint;
  vaa: Buffer;
  emitterAddr: string;
  emitterChain: number;
  txHash?: string;
};

/**
 * Wormhole Transaction response
 */

export interface WormholescanTransactionResponse {
  id: string;
  timestamp: string;
  txHash: string;
  emitterChain: number;
  emitterAddress: string;
  emitterNativeAddress: string;
  tokenAmount: string;
  usdAmount: string;
  symbol: string;
  payload: Payload;
  standardizedProperties: StandardizedProperties;
  globalTx: GlobalTransaction;
}

export type WormholescanTransaction = {
  id: string;
  timestamp: string;
  txHash: string;
  emitterChain: number;
  emitterAddress: string;
  emitterNativeAddress: string;
  tokenAmount: string;
  usdAmount: string;
  symbol: string;
  payload: Payload;
  standardizedProperties: StandardizedProperties;
  globalTx: GlobalTransaction;
};

export type GlobalTransaction = {
  id: string;
  originTx: {
    txHash: string;
    from: string;
    status: string;
    attribute: null | string;
  };
  destinationTx: {
    chainId: number;
    status: string;
    method: string;
    txHash: string;
    from: string;
    to: string;
    blockNumber: string;
    timestamp: string;
    updatedAt: string;
  };
};

interface StandardizedProperties {
  amount: string;
  appIds: string[];
  fee: string;
  feeAddress: string;
  feeChain: number;
  fromAddress: string;
  fromChain: number;
  toAddress: string;
  toChain: number;
  tokenAddress: string;
  tokenChain: number;
}

interface Payload {
  amount: string;
  fee: string;
  fromAddress: null | string;
  parsedPayload: null | string;
  payload: string;
  payloadType: number;
  toAddress: string;
  toChain: number;
  tokenAddress: string;
  tokenChain: number;
}

export type WormholescanResult<T> =
  | {
      error: HttpClientError;
    }
  | {
      data: T;
    };
