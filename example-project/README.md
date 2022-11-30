## Relayer Engine Example Project

- Plugins are located in the plugins directory and should be standalone npm packages
- engine config and a simple main file are in the top level directory
- helper scripts are in the scripts directory

### To run

Launch a testnet spy. Current command:

```
docker run \
    --platform=linux/amd64 \
    -p 7073:7073 \
    --entrypoint /guardiand \
    ghcr.io/wormhole-foundation/guardiand:latest \
spy --nodeKey /node.key --spyRPC "[::]:7073" --network /wormhole/testnet/2/1 --bootstrap /dns4/wormhole-testnet-v2-bootstrap.certus.one/udp/8999/quic/p2p/12D3KooWAkB9ynDur1Jtoa97LBUp8RXdhzS5uHgAfdTquJbrbN7i
```

Launch the relayer

```
ts-node src/main
```

Send a few VAAs from solana devnet

```
ts-node scripts/sendSolanaNative.ts 5
```
