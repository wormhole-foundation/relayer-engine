import * as http from "http";
import { setTimeout } from "timers/promises";
import { grpcResponseToBuffer } from "@cloudnc/grpc-web-testing-toolbox/base";
import { GetSignedVAAResponse } from "@certusone/wormhole-sdk-proto-node/lib/cjs/publicrpc/v1/publicrpc.js";

type WormholeMockConfig = {
  uri: string;
};

const httpAddress = "http://localhost:559" + Math.floor(Math.random() * 10);

/**
 * A mock for Wormholescan API.
 */
export class WormholeMock {
  private httpServer?: http.Server;
  private started: boolean = false;
  private responseQueue: Array<{
    status?: number;
    data?: any;
    headers?: Record<string, string>;
    delayMs?: number;
  }> = [];

  public async start(): Promise<WormholeMockConfig> {
    if (this.started) {
      return Promise.resolve({ uri: httpAddress });
    }

    // we use http because things are built around grpc-web
    this.httpServer = http.createServer(async (req, res) => {
      const queuedResponse = this.responseQueue?.shift();
      if (queuedResponse?.delayMs) {
        await setTimeout(queuedResponse.delayMs, null, { ref: false });
      }

      if (queuedResponse?.status && queuedResponse?.data) {
        res.writeHead(queuedResponse.status, queuedResponse.headers);
        res.end(JSON.stringify(queuedResponse.data));
        return;
      }

      if (req.url?.includes("GetSignedVAA")) {
        // Default response for getSignedVAA from guardian rpc.
        res.writeHead(200, { "Content-Type": "application/text" });
        res.end(
          grpcResponseToBuffer({
            message: GetSignedVAAResponse.encode({
              vaaBytes: Buffer.from(""),
            }).finish(),
          }),
        );
        return;
      }

      if (req.url?.includes("api/v1/vaas") && req.url?.includes("pageSize")) {
        // Wormholescan api.
        // List vaas. This could be further improved to return a dynamic list, or even statuses.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              {
                sequence: 10,
                vaa: "MQ==",
              },
              {
                sequence: 9,
                vaa: "Mg==",
              },
            ],
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
      return;
    });

    await new Promise(resolve =>
      this.httpServer?.listen(httpAddress.split(":")[2], () => resolve(null)),
    );
    this.started = true;

    return {
      uri: httpAddress,
    };
  }

  public delayed(delayMs: number) {
    this.responseQueue?.push({ delayMs });
  }

  public respondWith(
    status: number,
    data: any,
    headers?: Record<string, string>,
  ) {
    this.responseQueue.push({ status, data, headers });
  }

  public async stop() {
    await new Promise(resolve => this.httpServer!.close(resolve));
    this.started = false;
  }
}
