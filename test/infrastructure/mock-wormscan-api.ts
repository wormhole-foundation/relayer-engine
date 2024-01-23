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

      if (req.url?.includes("api/v1/transactions")) {
        // Wormholescan api.
        // Get a transaction.  This will return always the same regardless the input parameters,
        // but it will suffice for the fix we need.
        // TODO:  make this more realistic (check input)
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "8/67e93fa6c8ac5c819990aa7340c0c16b508abb1178be9b30d024b8ac25193d45/6043",
            timestamp: "2024-01-23T11:33:26Z",
            txHash: "F5SMRRBTH4R325BRVYX2DWD4LPGY42IO6OQNZRK2H4Z4VQ77UUPQ",
            emitterChain: 8,
            emitterAddress:
              "67e93fa6c8ac5c819990aa7340c0c16b508abb1178be9b30d024b8ac25193d45",
            emitterNativeAddress:
              "M7UT7JWIVROIDGMQVJZUBQGBNNIIVOYRPC7JWMGQES4KYJIZHVCRZEGFRQ",
            tokenAmount: "607.082703",
            usdAmount: "606.51811608",
            symbol: "USDC",
            payload: {
              amount: "607082703",
              fee: "0",
              fromAddress: null,
              parsedPayload: null,
              payload: "",
              payloadType: 1,
              toAddress:
                "0000000000000000000000008843f611a7510f139db69541aebb33dd2319c093",
              toChain: 6,
              tokenAddress:
                "000000000000000000000000b97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
              tokenChain: 6,
            },
            standardizedProperties: {
              amount: "60708270300",
              appIds: ["PORTAL_TOKEN_BRIDGE"],
              fee: "0",
              feeAddress: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
              feeChain: 6,
              fromAddress: "",
              fromChain: 8,
              toAddress: "0x8843f611a7510f139db69541aebb33dd2319c093",
              toChain: 6,
              tokenAddress: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
              tokenChain: 6,
            },
            globalTx: {
              id: "8/67e93fa6c8ac5c819990aa7340c0c16b508abb1178be9b30d024b8ac25193d45/6043",
              originTx: {
                txHash: "F5SMRRBTH4R325BRVYX2DWD4LPGY42IO6OQNZRK2H4Z4VQ77UUPQ",
                from: "BM26KC3NHYQ7BCDWVMP2OM6AWEZZ6ZGYQWKAQFC7XECOUBLP44VOYNBQTA",
                status: "confirmed",
                attribute: null,
              },
              destinationTx: {
                chainId: 6,
                status: "completed",
                method: "completeTransfer",
                txHash:
                  "c2d6657e1330a50bdc245c4528ca2d61979524263f53f2d65936e92d8f325745",
                from: "0xc35e155fee378dc514d49d78579625489c4a350e",
                to: "0x0e082f06ff657d94310cb8ce8b0d9a04541d8052",
                blockNumber: "40732271",
                timestamp: "2024-01-23T11:33:42Z",
                updatedAt: "2024-01-23T11:33:54.75Z",
              },
            },
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
