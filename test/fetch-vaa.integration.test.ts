import { publicrpc } from "@certusone/wormhole-sdk-proto-node";

import {
    Server,
    ServerCredentials,
    ServerUnaryCall,
    UntypedServiceImplementation,
    sendUnaryData,
} from "@grpc/grpc-js";
import {
    GetSignedVAARequest,
    GetSignedVAAResponse,
} from "@certusone/wormhole-sdk-proto-node/lib/cjs/publicrpc/v1/publicrpc";
import { beforeAll } from "@jest/globals";
import { getSignedVAA } from "@certusone/wormhole-sdk";
import { NodeHttpTransport } from "@improbable-eng/grpc-web-node-http-transport";

type WormholeMockConfig = {
    grpcUri: string;
};

/**
 * A mock for Wormhole RPCa.
 */
class WormholeMock {

    private grpcServer?: Server;

    public async start(): Promise<WormholeMockConfig> {
        const spyAddress = "127.0.0.1:55898";
        const url = "http://" + spyAddress;

        this.grpcServer = new Server();
        // FIXME: This is not working, getSignedVAA from wormhole SDK is not being able to connect to the mocked server
        this.grpcServer.addService(
            publicrpc.PublicRPCServiceService,
            this.publicRpcHandler()
        );
        await new Promise((resolve) => {
            this.grpcServer?.bindAsync(
                spyAddress,
                ServerCredentials.createInsecure(),
                resolve
            );
        });
        this.grpcServer.start();

        return {
            grpcUri: url,
        };
    }

    public async stop() {
        this.grpcServer?.forceShutdown();
    }

    private publicRpcHandler(): UntypedServiceImplementation {
        return {
            getSignedVAA: (
                call: ServerUnaryCall<GetSignedVAARequest, GetSignedVAAResponse>,
                callback: sendUnaryData<GetSignedVAAResponse>
            ) => {
                const response = { vaaBytes: Buffer.from("") };
                callback(null, response);
            },
        };
    }
}


describe("fetch-vaa.integration.test.ts", () => {
    const server = new WormholeMock();
    let url: string;

    beforeAll(async () => {
        url = (await server.start()).grpcUri;
    }, 120_000);

    test("fetchVaa", async () => {
        const x = await getSignedVAA(url, "acala", "0x01", "0", { transport: NodeHttpTransport(), metadata: { "grpc-timeout": "10S" } });
        console.log(x);
        expect(x).toBeDefined();
    }, 30_000);
});