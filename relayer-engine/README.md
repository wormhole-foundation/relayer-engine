## Running locally against testnet 


```
# pwd = wormhole
docker pull redis
docker run --rm -p 6379:6379 --name redis-docker -d redis
docker build --target go-export -f Dockerfile.proto -o type=local,dest=node .
cd node
docker build --platform linux/amd64 -f Dockerfile -t guardian .
docker run -p 7073:7073 --entrypoint /guardiand guardian spy --nodeKey /node.key --spyRPC "[::]:7073" --network /wormhole/testnet/2/1 --bootstrap /dns4/wormhole-testnet-v2-bootstrap.certus.one/udp/8999/quic/p2p/12D3KooWBY9ty9CXLBXGQzMuqkziLntsVcyz4pk1zWaJRvJn6Mmt

# new terminal (pwd = wormhole/node) 
cd ../relayer/plugin_relayer

# for all plugins you wish to run
npm i $PLUGIN_URI
mkdir config/$PLUGIN_NAME
touch config/$PLUGIN_NAME/devnet.yml

# if there are locally defined plugins (e.g. dummy_plugin)
cd wormhole/relayer/plugins/dummy_plugin
npm ci 
npm run build

# after installing plugins
npm ci
npm run build
npm run devnet_listener

# new terminal (pwd wormhole/relayer/plugin_relayer)
npm run devnet_executor
```