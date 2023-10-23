import { HttpClient, HttpClientError } from "./http-client.js";

/**
 * Client for the wormholescan API that never throws, but instead returns a WormholescanResult that may contain an error.
 */
export class WormholescanClient {
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
    });
  }

  public async listVaas(
    chain: number,
    emitterAddress: string,
    opts?: WormholescanOptions,
  ): Promise<WormholescanResult<WormholescanVaa[]>> {
    try {
      const response = await this.client.get<{ data: WormholescanVaa[] }>(
        `${
          this.baseUrl
        }api/v1/vaas/${chain}/${emitterAddress}?page=${this.getPage(
          opts,
        )}&pageSize=${this.getPageSize(opts)}`,
        opts,
      );
      return { data: response.data };
    } catch (err: Error | any) {
      return this.mapError(err);
    }
  }

  public async getVaa(
    chain: number,
    emitterAddress: string,
    sequence: bigint,
    opts?: WormholescanOptions,
  ): Promise<WormholescanResult<WormholescanVaa>> {
    try {
      const response = await this.client.get<{ data: WormholescanVaa }>(
        `${
          this.baseUrl
        }api/v1/vaas/${chain}/${emitterAddress}/${sequence.toString()}`,
        opts,
      );
      return { data: response.data };
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
};

export type WormholescanVaa = {
  id: string;
  sequence: bigint;
  vaa: Buffer;
  emitterAddr: string;
  emitterChain: number;
  txHash?: string;
};

export type WormholescanResult<T> = {
  error?: HttpClientError;
  data?: T;
};
