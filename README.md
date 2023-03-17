
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

`npm i wormhole-relayer`

`yarn add wormhole-relayer`

#### Minimal code necessary to get started

```typescript
async function main() {
  const app = new StandardRelayerApp<AppContext>(Environment.MAINNET, {name: ""});

  app.tokenBridge([CHAIN_ID_ETH], async (ctx, next) => { // listen to the token bridge vaas on eth.
    console.log(`received vaa ${ctx.vaa.sequence}`);
  });

  app.listen();
}
```
