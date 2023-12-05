import * as pkg from "@improbable-eng/grpc-web";
import * as http from "http";
import * as https from "https";

// @ts-ignore https://github.com/improbable-eng/grpc-web/issues/1171
const grpc = pkg.grpc ?? pkg.default.grpc;

/**
 * Transport factory for grpc-web that applies a timeout.
 * Also allows for some more customization of the underlying http request.
 * It's based on @improbable-eng/grpc-web-node-http-transport.
 *
 * @param timeoutMs -  value is passed directly to the timeout option of http.request
 * @param httpOptions - options passed directly to http.request
 * @returns the factory
 */
export function FailFastGrpcTransportFactory(
  timeoutMs: number = 10_000,
  httpOptions?: http.RequestOptions,
): pkg.grpc.TransportFactory {
  return function (opts: pkg.grpc.TransportOptions) {
    return new TimeoutableTransport(opts, timeoutMs, httpOptions);
  };
}

export class TimeoutError extends Error {}

class TimeoutableTransport implements pkg.grpc.Transport {
  private readonly timeoutMs: number;
  private readonly options: pkg.grpc.TransportOptions;
  private readonly httpOptions?: http.RequestOptions;
  private request?: http.ClientRequest;

  constructor(
    opts: pkg.grpc.TransportOptions,
    timeoutMs: number,
    httpOptions?: http.RequestOptions,
  ) {
    this.timeoutMs = timeoutMs;
    this.options = opts;
    this.httpOptions = httpOptions;
  }

  start(metadata: pkg.grpc.Metadata): void {
    const headers: Record<string, string> = {};
    metadata.forEach(function (key: string, values: string[]) {
      headers[key] = values.join(", ");
    });
    const url = new URL(this.options.url);
    const httpOptions = {
      ...this.httpOptions,
      protocol: url.protocol,
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      timeout: this.timeoutMs,
      method: "POST",
      headers: headers,
    };
    const requestBuilder =
      httpOptions.protocol === "https:" ? https.request : http.request;
    this.request = requestBuilder(httpOptions, res =>
      this.responseCallback(res),
    );
    this.request.on("error", err => this.options.onEnd(err));
    this.request.on("timeout", () => this.onTimeout());
  }

  onTimeout() {
    this.request?.destroy(
      new TimeoutError(`Request cancelled after ${this.timeoutMs}ms`),
    );
  }

  responseCallback(response: http.IncomingMessage): void {
    const headers = this.filterHeadersForUndefined(response.headers);
    // @ts-ignore (typing problem with @improbable-eng/grpc-web that they won't fix due to deprecation)
    this.options.onHeaders(new grpc.Metadata(headers), response.statusCode);
    response.on("data", chunk => {
      this.options.onChunk(this.toArrayBuffer(chunk));
    });
    response.on("end", () => {
      this.options.onEnd();
    });
  }

  sendMessage(msgBytes: Uint8Array): void {
    if (this.request === undefined) {
      throw new Error("Attempted to send a message without a request context");
    }

    if (
      !this.options.methodDefinition.requestStream &&
      !this.options.methodDefinition.responseStream
    ) {
      this.request.setHeader("Content-Length", msgBytes.byteLength);
    }
    this.request.write(this.toBuffer(msgBytes));
    this.request.end();
  }

  finishSend(): void {}

  cancel(): void {
    this.request?.destroy();
  }

  filterHeadersForUndefined(headers: http.IncomingHttpHeaders) {
    const filteredHeaders: http.IncomingHttpHeaders = {};
    for (const key in headers) {
      const value = headers[key];
      if (headers.hasOwnProperty(key) && value !== undefined) {
        filteredHeaders[key] = value;
      }
    }
    return filteredHeaders;
  }

  toArrayBuffer(buffer: Buffer) {
    const view = new Uint8Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      view[i] = buffer[i];
    }
    return view;
  }

  toBuffer(arrayBuffer: Uint8Array) {
    const buf = Buffer.alloc(arrayBuffer.byteLength);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = arrayBuffer[i];
    }
    return buf;
  }
}
