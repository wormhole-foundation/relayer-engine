import { beforeEach, beforeAll, afterAll, describe, test } from "@jest/globals";
import { WormholescanClient } from "../../relayer/rpc/wormholescan-client.js";
import { WormholeMock } from "../infrastructure/mock-wormscan-api.js";
import { HttpClientError } from "../../relayer/rpc/http-client.js";
import tassert from "typed-assert";

let client: WormholescanClient;
let timeout: number = 100; // 100ms

function assertPropertyIsDefined<T, K extends string>(
  x: T,
  prop: K,
  message: string,
): asserts x is Extract<T, { [key in K]: unknown }> {
  if (typeof x !== "object" || x === null || !(prop in x)) {
    throw new Error(message);
  }
}

describe("wormholescan-client", () => {
  const server = new WormholeMock();
  let url: string;

  beforeAll(async () => {
    url = (await server.start()).uri;
    client = new WormholescanClient(new URL(url), { retries: 0, timeout });
  }, 10_000);

  beforeEach(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test("should list vaas", async () => {
    const vaasResponse = await client.listVaas(
      8,
      "6241ffdc032b693bfb8544858f0403dec86f2e1720af9f34f8d65fe574b6238c",
    );

    assertPropertyIsDefined(
      vaasResponse,
      "data",
      "Data field is missing from response.",
    );

    expect(vaasResponse.data?.length).toBeGreaterThan(0);
    expect(vaasResponse.data[0].vaa.toString()).not.toContain("object");
  });

  test("should get transaction", async () => {
    const txResponse = await client.getTransaction(
      8,
      "67e93fa6c8ac5c819990aa7340c0c16b508abb1178be9b30d024b8ac25193d45",
      6043n,
    );

    assertPropertyIsDefined(
      txResponse,
      "data",
      "Data field is missing from response.",
    );

    expect(txResponse.data.payload).toBeDefined();
    expect(txResponse.data.id).toEqual(
      "8/67e93fa6c8ac5c819990aa7340c0c16b508abb1178be9b30d024b8ac25193d45/6043",
    );
    expect(txResponse.data.globalTx).toBeDefined();
    expect(txResponse.data.standardizedProperties).toBeDefined();
    expect(txResponse.data.globalTx.id).toEqual(
      "8/67e93fa6c8ac5c819990aa7340c0c16b508abb1178be9b30d024b8ac25193d45/6043",
    );
    expect(txResponse.data.globalTx.originTx.txHash).toEqual(
      "F5SMRRBTH4R325BRVYX2DWD4LPGY42IO6OQNZRK2H4Z4VQ77UUPQ",
    );
    expect(txResponse.data.globalTx.originTx.from).toEqual(
      "BM26KC3NHYQ7BCDWVMP2OM6AWEZZ6ZGYQWKAQFC7XECOUBLP44VOYNBQTA",
    );
  });

  test("should fail if request fails and no retries set", async () => {
    const expectedStatus = 500;
    server.respondWith(expectedStatus, { message: "Internal Server Error" });
    const vaasResponse = await client.listVaas(8, "100", { retries: 0 });

    assertPropertyIsDefined(
      vaasResponse,
      "error",
      "Expected an internal server error.",
    );
    expect((vaasResponse.error as HttpClientError).status).toBe(expectedStatus);
  });

  test("should work if request fails and then works", async () => {
    const response = [
      {
        sequence: 10,
        vaa: "AQAAAAABAE1EmozfPWDzAhFd3fJGgvl/uIDlfRQRZK/UKhR+1rH5ROhWlnasC7LaxdkMDE45y5xewLkB5YiNdT2JLulA+5EAZS3I4AAAAAAAAgAAAAAAAAAAAAAAAAppFGcWs6IWIih++hYHQkxmMGmkAAAAAAAAAKPIAQAAAAAAAAAAAAAAAAeGXG6HufcCVTd+AkrOZjDB6qN/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfQAAAAAAAAAAQAAAAAAA5jMAAAAAAAAAAAAAAAAWRXzMU91NFot/YVAi27AFKbyA70AAAAAAAAAAAAAAAB3W+72vA94iLCi+Qbr/j6n29d3mwA/d29ybWhvbGVEZXBvc2l0AAAAAAAAAAAAAAAAWRXzMU91NFot/YVAi27AFKbyA70AAAAAAAAAAAAAAAAZwjdU",
      },
    ];
    const expectedData = response.map(v => ({
      ...v,
      vaa: Buffer.from(v.vaa, "base64"),
    }));
    server.respondWith(500, { message: "Internal Server Error" });
    server.respondWith(200, { data: response });

    const vaasResponse = await client.listVaas(8, "1000", { retries: 2 });

    assertPropertyIsDefined(vaasResponse, "data", "Expected a valid response.");
    expect(JSON.stringify(vaasResponse.data)).toBe(
      JSON.stringify(expectedData),
    );
  });

  test("should fail if retry-after is bigger than max delay", async () => {
    server.respondWith(
      429,
      { message: "Resource exhausted" },
      { "retry-after": "1" },
    );

    const vaasResponse = await client.listVaas(8, "1000", {
      retries: 1,
      maxDelay: 500,
    });

    assertPropertyIsDefined(
      vaasResponse,
      "error",
      "Expected a 'too many requests' error.",
    );
    expect((vaasResponse.error as HttpClientError).status).toBe(429);
  });
});
