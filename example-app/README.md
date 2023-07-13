# Example Relayer Engine Application

This example details a more complex implementation of a Relayer Application. For a simple example see this [example](../README.md#simple-relayer-code-example)


## Setup 

> note: In order to run the Spy and Redis for this tutorial, you must have `docker` installed


### Get the code

Clone the repository, `cd` into the directory, and install the requirements.

```sh
git clone https://github.com/wormhole-foundation/relayer-engine.git
cd relayer-engine/example-app
npm i
```

### Start the background services


Start the Spy to subscribe to gossiped messages on the Guardian network.

```sh
npm run testnet-spy
```

In another CLI window, start Redis.

```sh
npm run redis
```

### Start the relayer

```sh
npm run start
```

