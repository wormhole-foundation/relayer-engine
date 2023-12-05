import { afterAll, beforeAll, beforeEach, test } from "@jest/globals";
import { getSignedVAA } from "@certusone/wormhole-sdk";
import { FailFastGrpcTransportFactory } from "../relayer/rpc/fail-fast-grpc-transport.js";
import { WormholeMock } from "./infrastructure/mock-wormscan-api.js";

describe("getSignedVaa", () => {
  const server = new WormholeMock();
  let url: string;

  beforeAll(async () => {
    url = (await server.start()).uri;
  }, 10_000);

  beforeEach(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test("should work when using fast failed transport factory", async () => {
    const transport = FailFastGrpcTransportFactory();
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
