
# Wormhole-relayer

The Goal is to create a project that is:

* Immediately intuitive
* Idiomatic
* Minimal footprint
* Composable
* Easily extensible
* Good separation of concerns
* Reliable
* Convention over configuration

### Get Started

`npm i gabzim/wormhole-relayer`

`yarn add gabzim/wormhole-relayer`

#### Minimal code necessary to get started

```typescript
import { CHAIN_ID_ETH } from "@certusone/wormhole-sdk";

async function main() {
  const app = new StandardRelayerApp<AppContext>(Environment.MAINNET, { name: "" });

  app
    .chain(CHAIN_ID_SOLANA)
    .address(
      "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
      async (ctx, nest) => {
        const vaa = ctx.vaa;
        const hash = ctx.sourceTxHash
      }
    );

  app.listen();
}
```
