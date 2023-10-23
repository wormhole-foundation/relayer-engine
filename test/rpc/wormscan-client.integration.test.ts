import { beforeEach, beforeAll, afterAll, describe, test } from "@jest/globals";
import { WormscanClient } from "../../relayer/rpc/wormscan-client";
import { WormholeMock } from "../infrastructure/mock-wormscan-api";
import { HttpClientError } from "../../relayer/rpc/http-client";

let client: WormscanClient;
let timeout: number = 100; // 100ms

describe("wormscan-client", () => {
  const server = new WormholeMock();
  let url: string;

  beforeAll(async () => {
    url = (await server.start()).uri;
    client = new WormscanClient(new URL(url), { retries: 0, timeout });
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
    expect(vaasResponse?.data).toBeDefined();
    expect(vaasResponse?.data?.length).toBeGreaterThan(0);
    expect(vaasResponse?.data[0].vaa.toString()).not.toContain("object");
  });

  test("should fail if request fails and no retries set", async () => {
    const expectedStatus = 500;
    server.respondWith(expectedStatus, { message: "Internal Server Error" });
    const vaasResponse = await client.listVaas(8, "100", { retries: 0 });

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

    expect(vaasResponse.error).toBeUndefined();
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

    expect((vaasResponse.error as HttpClientError).status).toBe(429);
  });
});
