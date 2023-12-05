import { setTimeout } from "timers/promises";
import { printError } from "../utils.js";

/**
 * A simple HTTP client with exponential backoff retries and 429 handling.
 */
export class HttpClient {
  private initialDelay: number = 1_000;
  private maxDelay: number = 60_000;
  private retries: number = 0;
  private timeout: number = 5_000;
  private cache: RequestCache = "default";

  constructor(options?: HttpClientOptions) {
    options?.initialDelay && (this.initialDelay = options.initialDelay);
    options?.maxDelay && (this.maxDelay = options.maxDelay);
    options?.retries && (this.retries = options.retries);
    options?.timeout && (this.timeout = options.timeout);
    options?.cache && (this.cache = options.cache);
  }

  public async get<T>(url: string, opts?: HttpClientOptions): Promise<T> {
    return this.executeWithRetry(url, "GET", opts);
  }

  private async execute<T>(
    url: string,
    method: string,
    opts?: HttpClientOptions,
  ): Promise<T> {
    let response;
    try {
      response = await fetch(url, {
        method: method,
        signal: AbortSignal.timeout(opts?.timeout ?? this.timeout),
        cache: opts?.cache ?? this.cache,
      });
    } catch (err) {
      // Connection / timeout error:
      throw new HttpClientError(printError(err));
    }

    if (!response.ok) {
      throw new HttpClientError(undefined, response, await response.json());
    }

    return await response.json();
  }

  private async executeWithRetry<T>(
    url: string,
    method: string,
    opts?: HttpClientOptions,
  ): Promise<T> {
    const maxRetries = opts?.retries ?? this.retries;
    let retries = 0;
    const initialDelay = opts?.initialDelay ?? this.initialDelay;
    const maxDelay = opts?.maxDelay ?? this.maxDelay;
    while (maxRetries >= 0) {
      try {
        return await this.execute(url, method, opts);
      } catch (err) {
        if (err instanceof HttpClientError) {
          if (retries < maxRetries) {
            const retryAfter = err.getRetryAfter(maxDelay, err);
            if (retryAfter) {
              await setTimeout(retryAfter, { ref: false });
            } else {
              const timeout = Math.min(
                initialDelay * 2 ** maxRetries,
                maxDelay,
              );
              await setTimeout(timeout, { ref: false });
            }
            retries++;
            continue;
          }
        }
        throw err;
      }
    }
    throw new Error("Failed to execute HTTP request.");
  }
}

export type HttpClientOptions = {
  initialDelay?: number;
  maxDelay?: number;
  retries?: number;
  timeout?: number;
  cache?: RequestCache;
};

export class HttpClientError extends Error {
  public readonly status?: number;
  public readonly data?: any;
  public readonly headers?: Headers;

  constructor(message?: string, response?: Response, data?: any) {
    super(message ?? `Unexpected status code: ${response?.status}`);
    this.status = response?.status;
    this.data = data;
    this.headers = response?.headers;
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Parses the Retry-After header and returns the value in milliseconds.
   * @param maxDelay
   * @param error
   * @throws {HttpClientError} if retry-after is bigger than maxDelay.
   * @returns the retry-after value in milliseconds.
   */
  public getRetryAfter(
    maxDelay: number,
    error: HttpClientError,
  ): number | undefined {
    const retryAfter = this.headers?.get("Retry-After");
    if (retryAfter) {
      const value = parseInt(retryAfter) * 1000; // header value is in seconds
      if (value <= maxDelay) {
        return value;
      }

      throw error;
    }
  }
}
