# Relayer Engine

Specify how to relay wormhole messages for your app using an idiomatic an express/koa middleware inspired api and let the library handle all the details!

Checkout the [example app](./example-app) or check out the [quickstart](#quick-start)

## Quick Start

`npm i wormhole-foundation/relayer-engine`

`yarn add wormhole-foundation/relayer-engine`

### Minimal code necessary to get started

```typescript
import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";

import { CHAIN_ID_SOLANA } from "@certusone/wormhole-sdk";

(async function main() {
  const app = new StandardRelayerApp<StandardRelayerContext>(
    Environment.MAINNET,
    {
      // other app specific config options can be set here for things
      // like retries, logger, or redis connection settings.
      name: "ExampleRelayer",
    },
  );

  app.chain(CHAIN_ID_SOLANA).address(
    // emitter address on Solana
    "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
    // callback function to invoke on new message
    async (ctx, next) => {
      const vaa = ctx.vaa;
      const hash = ctx.sourceTxHash;
    },
  );

  app.listen();
})();
```

### Minimal Processes to track the VAAs

:memo: These proceses must be running in order for the code above to work

**Wormhole Network Spy**

In order for the Relayer app created above to receive messages, a local Spy must be running that watches the guardian network.

For testnet:

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

For mainnet:

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

**Run redis**

A Redis instance must also be available to persist job data for fetching VAAs from the Spy.

```bash
docker run --rm -p 6379:6379 --name redis-docker -d redis
```

## Objective

Make it easy to write the off-chain component of a wormhole cross-chain app (aka [xDapp](https://book.wormhole.com/dapps/4_whatIsanXdapp.html)).

An xDapp developer can write their app specific logic for filtering what wormhole messages they care about, how to parse custom payloads and what actions to take on chain (or across many chains!).

The Goal is to create a project that is:

- Immediately intuitive
- Idiomatic
- Minimal footprint
- Composable
- Easily extensible
- Good separation of concerns
- Reliable
- Convention over configuration
