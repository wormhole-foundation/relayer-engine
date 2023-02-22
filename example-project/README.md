## Relayer Engine Example Project

- Plugins are located in the plugins directory and should be standalone npm packages
- engine config and a simple main file are in the top level directory
- helper scripts are in the scripts directory

### To run

Launch a testnet spy. Current command:

```
npm run testnet-spy
```

Launch the relayer

```
ts-node src/main
```

Send a few VAAs from solana devnet

```
ts-node scripts/sendSolanaNative.ts 5
```
