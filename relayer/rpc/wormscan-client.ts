import { HttpClient, HttpClientError } from "./http-client";

export class WormscanClient {
  private baseUrl: URL;
  private defaultOptions?: WormscanOptions;
  private client: HttpClient;

  constructor(baseUrl: URL, defaultOptions?: WormscanOptions) {
    this.baseUrl = baseUrl;
    this.defaultOptions = defaultOptions;
    this.client = new HttpClient({
      timeout: defaultOptions?.timeout,
      retries: defaultOptions?.retries,
      initialDelay: defaultOptions?.initialDelay,
      maxDelay: defaultOptions?.maxDelay,
    });
  }

  /**
   * @throws {HttpClientError} If the request fails.
   */
  public async listVaas(
    chain: number,
    emitterAddress: string,
    opts?: WormscanOptions,
  ): Promise<WormscanResult<WormscanVaa[]>> {
    try {
      const response = await this.client.get<{ data: WormscanVaa[] }>(
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

  /**
   * @throws {HttpClientError} If the request fails.
   */
  public async getVaa(
    chain: number,
    emitterAddress: string,
    sequence: bigint,
    opts?: WormscanOptions,
  ): Promise<WormscanResult<WormscanVaa>> {
    try {
      const response = await this.client.get<{ data: WormscanVaa }>(
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

  private getPage(opts?: WormscanOptions) {
    return opts?.page ?? this.defaultOptions?.page ?? 0;
  }

  private getPageSize(opts?: WormscanOptions) {
    return opts?.pageSize ?? this.defaultOptions?.pageSize ?? 10;
  }
}

export type WormscanOptions = {
  pageSize?: number;
  page?: number;
  retries?: number;
  initialDelay?: number;
  maxDelay?: number;
  timeout?: number;
};

export type WormscanVaa = {
  id: string;
  sequence: bigint;
  vaa: Buffer;
  emitterAddr: string;
  emitterChain: number;
  txHash?: string;
};

export type WormscanResult<T> = {
  error?: HttpClientError;
  data?: T;
};
