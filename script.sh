docker run --platform=linux/amd64 -p 7073:7073 --entrypoint /guardiand ghcr.io/wormhole-foundation/guardiand:latest spy --nodeKey /node.key --spyRPC "[::]:7073" --network /wormhole/testnet/2/1 --bootstrap /dns4/wormhole-testnet-v2-bootstrap.certus.one/udp/8999/quic/p2p/12D3KooWAkB9ynDur1Jtoa97LBUp8RXdhzS5uHgAfdTquJbrbN7i 2> >( 
while read in; do
    echo $in | sed -E "s/^.*{/{/p" | jq '.vaa' | xargs -0 worm parse | grep "emitterChain" 
done )

