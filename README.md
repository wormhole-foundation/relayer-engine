# Relayer Engine

The Relayer Engine is a package meant to provide the structure and a starting point for a custom relayer.

With the Relayer Engine, a developer can write specific logic for filtering to receive only the messages they care about.

Once a wormhole message is received, the developer may apply additional logic to parse custom payloads or submit the VAA to one or many destination chains.

To use the Relayer engine, a developer may specify how to relay wormhole messages for their app using an idiomatic express/koa middleware inspired api then let the library handle all the details!

Checkout the full [example app](https://github.com/wormhole-foundation/relayer-engine/tree/main/example-app) or follow the instructions in the [quickstart](#quick-start)

# Quick Start

## Install Package

First, install the relayer engine package with `npm` or `yarn`

```sh
npm i @wormhole-foundation/relayer-engine
```

## Start Background Processes

> note: These processes _must_ be running in order for the relayer app below to work

Next, we must start a Spy to listen for available VAAs published on the guardian network as well as a persistence layer, in this case we're using Redis.

### Wormhole Network Spy

In order for our Relayer app to receive messages, a local Spy must be running that watches the guardian network. Our relayer app will receive updates from this Spy.

<details>
<summary><b>Testnet Spy</b></summary>

```bash
docker run --platform=linux/amd64 \
-p 7073:7073 \
--entrypoint /guardiand ghcr.io/wormhole-foundation/guardiand:latest \
spy \
--nodeKey /node.key \
--spyRPC "[::]:7073" \
--network /wormhole/testnet/2/1 \
--bootstrap /dns4/wormhole-testnet-v2-bootstrap.certus.one/udp/8999/quic/p2p/12D3KooWAkB9ynDur1Jtoa97LBUp8RXdhzS5uHgAfdTquJbrbN7i
```

</details>

<details>
<summary><b>Mainnet Spy</b></summary>

```bash
docker run --platform=linux/amd64 \
-p 7073:7073 \
--entrypoint /guardiand ghcr.io/wormhole-foundation/guardiand:latest \
spy \
--nodeKey /node.key \
--spyRPC "[::]:7073" \
--network /wormhole/mainnet/2 \
--bootstrap /dns4/wormhole-mainnet-v2-bootstrap.certus.one/udp/8999/quic/p2p/12D3KooWQp644DK27fd3d4Km3jr7gHiuJJ5ZGmy8hH4py7fP4FP7
```

</details>

### Redis Persistence

A Redis instance must also be available to persist job data for fetching VAAs from the Spy.

```bash
docker run --rm -p 6379:6379 --name redis-docker -d redis
```

> Note: While we're using Redis here, the persistence layer can be swapped out for some other db by implementing the appropriate [interface](https://github.com/wormhole-foundation/relayer-engine/blob/main/relayer/storage/redis-storage.ts).

## Simple Relayer Code Example

In the following example, we'll:

1. Set up a StandardRelayerApp, passing configuration options for our Relayer
2. Add a filter to capture only those messages our app cares about with a callback to do _something_ with the VAA once we've gotten it
3. Start the Relayer app

```ts
import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";
import { CHAIN_ID_SOLANA } from "@certusone/wormhole-sdk";

(async function main() {
  // initialize relayer engine app, pass relevant config options
  const app = new StandardRelayerApp<StandardRelayerContext>(
    Environment.TESTNET,
    {
      // other app specific config options can be set here for things
      // like retries, logger, or redis connection settings.
      name: "ExampleRelayer",
    },
  );

  // add a filter with a callback that will be
  // invoked on finding a VAA that matches the filter
  app.chain(CHAIN_ID_SOLANA).address(
    // emitter address on Solana
    "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
    // callback function to invoke on new message
    async (ctx, next) => {
      const vaa = ctx.vaa;
      const hash = ctx.sourceTxHash;
      console.log(
        `Got a VAA with sequence: ${vaa.sequence} from with txhash: ${hash}`,
      );
    },
  );

  // start app, blocks until unrecoverable error or process is stopped
  await app.listen();
})();
```
