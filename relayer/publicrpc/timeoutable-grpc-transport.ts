import { grpc } from "@improbable-eng/grpc-web";
import * as http from "http";
import * as https from "https";

export function FastFailedGrpcTransportFactory(connectTimeoutMs: number = 10_000, readTimeoutMs: number = 10_000): grpc.TransportFactory {
    return function (opts: grpc.TransportOptions) {
        return new TimeoutableTransport(opts, connectTimeoutMs, readTimeoutMs);
    };
}

class TimeoutableTransport implements grpc.Transport {
    private readonly connectTimeoutMs: number;
    private readonly readTimeoutMs: number;
    private readonly options: grpc.TransportOptions;
    private request?: http.ClientRequest;

    constructor(opts: grpc.TransportOptions, connectTimeoutMs: number, readTimeoutMs: number) {
        this.connectTimeoutMs = connectTimeoutMs;
        this.readTimeoutMs = readTimeoutMs;
        this.options = opts;
    }

    start(metadata: grpc.Metadata): void {
        const headers: Record<string, string> = {};
        metadata.forEach(function (key, values) {
            headers[key] = values.join(", ");
        });
        const url = new URL(this.options.url);
        const httpOptions = {
            protocol: url.protocol,
            host: url.hostname,
            port: url.port,
            path: url.pathname, 
            headers: headers,
            method: "POST",
            timeout: this.connectTimeoutMs,
        };
        const requestBuilder = httpOptions.protocol === "https:" ? https.request : http.request;
        this.request = requestBuilder(httpOptions, (res) => this.responseCallback(res));
        this.request.on("error", (err) => {
            this.options.onEnd(err);
        });
    }

    responseCallback(response: http.IncomingMessage): void {
        var headers = this.filterHeadersForUndefined(response.headers);
        this.options.onHeaders(new grpc.Metadata(headers), response.statusCode);
        response.on("data", (chunk) => {
            this.options.onChunk(this.toArrayBuffer(chunk));
        });
        response.on("end", () => {
            this.options.onEnd();
        });
    }

    sendMessage(msgBytes: Uint8Array): void {
        if (!this.options.methodDefinition.requestStream && !this.options.methodDefinition.responseStream) {
            this.request.setHeader("Content-Length", msgBytes.byteLength);
        }
        this.request.write(this.toBuffer(msgBytes));
        this.request.end();
    }

    finishSend(): void { }

    cancel(): void {
        this.request?.destroy();
    }

    filterHeadersForUndefined(headers: http.IncomingHttpHeaders) {
        const filteredHeaders: http.IncomingHttpHeaders = {};
        for (const key in headers) {
            var value = headers[key];
            if (headers.hasOwnProperty(key)) {
                if (value !== undefined) {
                    filteredHeaders[key] = value;
                }
            }
        }
        return filteredHeaders;
    }
    toArrayBuffer(buf: Buffer) {
        var view = new Uint8Array(buf.length);
        for (var i = 0; i < buf.length; i++) {
            view[i] = buf[i];
        }
        return view;
    }
    toBuffer(ab: Uint8Array) {
        var buf = Buffer.alloc(ab.byteLength);
        for (var i = 0; i < buf.length; i++) {
            buf[i] = ab[i];
        }
        return buf;
    }

}
