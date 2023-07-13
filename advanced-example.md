# Example Relayer Engine Application

This example details a more complex implementation of a Relayer Application. For a simple example see this [example](./README.md#simple-relayer-code-example)

The source for this example is available [here](https://github.com/wormhole-foundation/relayer-engine/blob/main/example-app/src/app.ts)

## Setup

> note: In order to run the Spy and Redis for this tutorial, you must have `docker` installed.

### Get the code

Clone the repository, `cd` into the directory, and install the requirements.

```sh
git clone https://github.com/wormhole-foundation/relayer-engine.git
cd relayer-engine/example-app
npm i
```

## Run it

### Start the background services

Start the Spy to subscribe to gossiped messages on the Guardian network.

```sh
npm run testnet-spy
```

In another CLI window, start Redis. For this application, Redis is used as the persistence layer to keep track of VAAs we've seen.

```sh
npm run redis
```

### Start the relayer

Once the background processes are running, we can start the relayer. This will subscribe to relevant messages from the Spy and track VAAs, taking some action when one is received.

```sh
npm run start
```

## Code Walkthrough

### Context

The first meaningful line is a Type declaration for the `Context` we want to provide our Relayer app.

```ts
export type MyRelayerContext = LoggingContext &
  StorageContext &
  SourceTxContext &
  TokenBridgeContext &
  StagingAreaContext &
  WalletContext;
```

This type, which we later use to parameterize the generic `RelayerApp`, specifies the union of `Context` objects that are available to the `RelayerApp`.

Because the `Context` object is passed to the callback for processors, providing a type parameterized type definition ensures the appropriate fields are available within the callback on the `Context` object.

### App Creation

Next we instantiate a `RelayerApp`, passing our `Context` type to parameterize it.

```ts
const app = new RelayerApp<MyRelayerContext>(Environment.TESTNET);
```

For this example we've defined a class, `ApiController`, to provide methods we'll pass to our processor callbacks. Note that the `ctx` argument type matches the `Context` type we defined.

```ts
export class ApiController {
  processFundsTransfer = async (ctx: MyRelayerContext, next: Next) => {
    // ...
  };
}
```

This is not required but a pattern like this helps organize the codebase as the `RelayerApp` grows.

We instantiate our controller class and begin to configure our application by passing the Spy URL, storage layer, and logger.

```ts
const fundsCtrl = new ApiController();
const namespace = "simple-relayer-example";
const store = new RedisStorage({
  attempts: 3,
  namespace, // used for redis key namespace
  queueName: "relays",
});

// ...

app.spy("localhost:7073");
app.useStorage(store);
app.logger(rootLogger);
```

### Middleware

With our app configured, we can begin to add `Middleware`.

`Middleware` is the term for the functional components we wish to apply to each VAA received.

The `RelayerApp` defines a `use` method which accepts one or more `Middleware` instances, also parameterized with a `Context` type.

```ts
use(...middleware: Middleware<ContextT>[] | ErrorMiddleware<ContextT>[])
```

By passing the `use` method an instance of some `Middleware`, we add it to the pipeline of handlers invoked by the `RelayerApp`.

> Note that the order the `Middleware` is added here matters since a VAA is passed through each in the same order.

```ts
// we want an instance of a logger available on the context
app.use(logging(rootLogger));
// we want to check for any missed VAAs if we receive out of order sequence ids
app.use(missedVaas(app, { namespace: "simple", logger: rootLogger }));
// we want to apply the chain specific providers to the context passed downstream
app.use(providers());

// make wallets available within the context
app.use(
  wallets(Environment.TESTNET, {
    privateKeys,
    namespace,
    metrics: { enabled: true, registry: store.registry },
  }),
);

// enrich the context with details about the token bridge
app.use(tokenBridgeContracts());
// ensure we use redis safely in a concurrent environment
app.use(stagingArea());
// make sure we have the source tx hash
app.use(sourceTx());
```

### Subscriptions

With our `Middleware` setup, we can configure a subscription to receive only the VAAs we care about.

Here we set up a subscription request to receive VAAs that originated from Solana and were emitted by the address `DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe`.

On receipt of a VAA that matches this filter, the `fundsCtrl.processFundsTransfer` callback is invoked with an instance of the `Context` object that has already been passed through the `Middleware` we set up before.

```ts
app
  .chain(CHAIN_ID_SOLANA)
  .address(
    "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
    fundsCtrl.processFundsTransfer,
  );
```

To subscribe to more chains or addresses, this pattern can be repeated or the `multiple` method can be called with an object of `ChainId` to `Address`

```ts
app.multiple(
  {
    [CHAIN_ID_SOLANA]: "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe"
    [CHAIN_ID_ETH]: ["0xabc1230000000...","0xdef456000....."]
  },
  fundsCtrl.processFundsTransfer,
);
```

### Error Handling

The last `Middleware` we apply is an error handler, which will be called any time an upstream `Middleware` component throws an error.

Note that there are 3 arguments to this function which hints to the `RelayerApp` that it should be used to process errors.

```ts
app.use(async (err, ctx, next) => {
  ctx.logger.error("error middleware triggered");
});
```

### Start listening

Finally, calling `app.listen()` will start the `RelayerApp`, issuing subscription requests and handling VAAs as we've configured it.

The `listen` method is async and `await`-ing it will block until the program dies from an unrecoverable error, the process is killed, or the app is stopped with `app.stop()`.

### Bonus UI

For this example, we've provided a default UI using `koa`.

When the program is running, you may open a browser to `http://localhost:3000/ui` to see details about the running application.

## Going further

The included default functionality may be insufficient for your use case.

If you'd like to apply some specific intermediate processing steps, consider implementing some custom `Middleware`. Be sure to include the appropriate `Context` in the `RelayerApp` type parameterization for any fields you wish to have added to the `Context` object passed to downstream `Middleware`.

If you'd prefer a storage layer besides redis, simply implement the [storage](https://github.com/wormhole-foundation/relayer-engine/blob/main/relayer/storage/storage.ts) interface.
