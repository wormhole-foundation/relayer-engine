import * as http from "http";
import { setTimeout } from "timers/promises";
import { grpcResponseToBuffer } from "@cloudnc/grpc-web-testing-toolbox/base";
import { GetSignedVAAResponse } from "@certusone/wormhole-sdk-proto-node/lib/cjs/publicrpc/v1/publicrpc";
import { afterAll, beforeAll } from "@jest/globals";
import { getSignedVAA } from "@certusone/wormhole-sdk";
import { FailFastGrpcTransportFactory } from "../relayer/publicrpc/fail-fast-grpc-transport";

type WormholeMockConfig = {
  grpcUri: string;
};

/**
 * A mock for Wormhole's Public RPC.
 */
class WormholeMock {
  private httpServer?: http.Server;
  private started: boolean = false;
  private delayMs: number = 0;

  public async start(): Promise<WormholeMockConfig> {
    const httpAddress = "http://localhost:55899";
    this.delayMs = 0;
    if (this.started) {
      return Promise.resolve({ grpcUri: httpAddress });
    }

    // we use http because things are built around grpc-web
    this.httpServer = http.createServer(async (req, res) => {
      res.writeHead(200, { "Content-Type": "application/text" });
      await setTimeout(this.delayMs, null, { ref: false });
      res.end(
        grpcResponseToBuffer({
          message: GetSignedVAAResponse.encode({
            vaaBytes: Buffer.from(""),
          }).finish(),
        }),
      );
      return;
    });

    await new Promise(resolve =>
      this.httpServer?.listen(httpAddress.split(":")[2], () => resolve(null)),
    );
    this.started = true;

    return {
      grpcUri: httpAddress,
    };
  }

  public delayed(delayMs: number) {
    this.delayMs = delayMs;
  }

  public async stop() {
    this.httpServer?.close();
    this.started = false;
  }
}

describe("getSignedVaa", () => {
  const server = new WormholeMock();
  let url: string;

  beforeAll(async () => {
    url = (await server.start()).grpcUri;
  }, 10_000);

  beforeEach(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test("should work when using fast failed transport factory", async () => {
    const transport = FailFastGrpcTransportFactory(500);
    const vaaResponse = await getSignedVAA(
      url,
      "celo",
      "000000000000000000000000306b68267deb7c5dfcda3619e22e9ca39c374f84",
      "39296",
      { transport, metadata: { "grpc-timeout": "10S" } },
    );
    expect(vaaResponse).toBeDefined();
  }, 5_000);

  test("should fail when unable to connect using fast failed transport factory", async () => {
    await server.stop();
    const transport = FailFastGrpcTransportFactory(500);
    await expect(
      getSignedVAA(
        url,
        "avalanche",
        "000000000000000000000000306b68267deb7c5dfcda3619e22e9ca39c374f84",
        "39296",
        { transport, metadata: { "grpc-timeout": "10S" } },
      ),
    ).rejects.toThrow();
  });

  test("should fail when timeout is reached", async () => {
    const timeout = 100;
    server.delayed(timeout * 2);
    const transport = FailFastGrpcTransportFactory(timeout);
    await expect(
      getSignedVAA(
        url,
        "moonbeam",
        "306b68267deb7c5dfcda3619e22e9ca39c374f84",
        "0",
        { transport },
      ),
    ).rejects.toThrow();
  });
});
