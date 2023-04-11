# Relayer Engine

Specify how to relay wormhole messages for your app using an idiomatic an express/koa middleware inspired api and let the library handle all the details!

Checkout the [example app](./example-app/README.md) or check out the [quickstart](#quick-start)

### Quick Start

`npm i wormhole-foundation/relayer-engine`

`yarn add wormhole-foundation/relayer-engine`

#### Minimal code necessary to get started

```typescript
import { CHAIN_ID_ETH } from "@certusone/wormhole-sdk";

async function main() {
  const app = new StandardRelayerApp<AppContext>(Environment.MAINNET, {
    name: "ExampleRelayer",
  });

  app
    .chain(CHAIN_ID_SOLANA)
    .address(
      "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
      async (ctx, nest) => {
        const vaa = ctx.vaa;
        const hash = ctx.sourceTxHash;
      },
    );

  app.listen();
}
```

**Run a wormhole network spy**

Testnet:

```bash
docker run --platform=linux/amd64 -p 7073:7073 --entrypoint /guardiand ghcr.io/wormhole-foundation/guardiand:latest spy --nodeKey /node.key --spyRPC "[::]:7073" --network /wormhole/testnet/2/1 --bootstrap /dns4/wormhole-testnet-v2-bootstrap.certus.one/udp/8999/quic/p2p/12D3KooWAkB9ynDur1Jtoa97LBUp8RXdhzS5uHgAfdTquJbrbN7i
```

Mainnet:

```bash
docker run --platform=linux/amd64 -p 7073:7073 --entrypoint /guardiand ghcr.io/wormhole-foundation/guardiand:latest spy --nodeKey /node.key --spyRPC "[::]:7073" --network /wormhole/mainnet/2 --bootstrap /dns4/wormhole-mainnet-v2-bootstrap.certus.one/udp/8999/quic/p2p/12D3KooWQp644DK27fd3d4Km3jr7gHiuJJ5ZGmy8hH4py7fP4FP7
```

**Run redis**

```bash
docker run --rm -p 6379:6379 --name redis-docker -d redis
```

## Objective

Make it easy to write the off-chain component of a wormhole cross-chain app (aka [xDapp](https://book.wormhole.com/dapps/4_whatIsanXdapp.html)).

An xDapp developer can write their app specific logic for filtering what wormhole messages they care about, how to parse custom payloads and what actions to take on chain (or across many chains!).

# Contributors

The Goal is to create a project that is:

- Immediately intuitive
- Idiomatic
- Minimal footprint
- Composable
- Easily extensible
- Good separation of concerns
- Reliable
- Convention over configuration
