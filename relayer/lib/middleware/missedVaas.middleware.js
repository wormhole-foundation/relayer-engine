"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.missedVaas = void 0;
const grpcWebNodeHttpTransport = require("@improbable-eng/grpc-web-node-http-transport");
const ioredis_1 = require("ioredis");
const wormhole_sdk_1 = require("@certusone/wormhole-sdk");
const application_1 = require("../application");
const defaultRpcs = {
    [application_1.Environment.MAINNET]: ["https://api.wormscan.io"],
    [application_1.Environment.TESTNET]: [
        "https://wormhole-v2-testnet-api.certus.one",
        "https://api.testnet.wormscan.io",
    ],
    [application_1.Environment.DEVNET]: [""],
};
function missedVaas(app, opts) {
    opts.redis = opts.redis || { host: "localhost", port: 6379 };
    opts.redis.keyPrefix = opts.namespace;
    opts.checkForMissedVaasEveryMs = opts.checkForMissedVaasEveryMs || 30_000;
    const redis = new ioredis_1.default(opts.redis);
    setTimeout(() => startMissedVaaWorker(redis, app, opts), 100); // start worker once config is done.
    return async (ctx, next) => {
        const wormholeRpcs = opts.wormholeRpcs || defaultRpcs[ctx.env];
        let vaa = ctx.vaa;
        if (!vaa) {
            await next();
            return;
        }
        const lastSeenSequence = await getLastSequenceForContract(redis, vaa.emitterChain, vaa.emitterAddress);
        if (lastSeenSequence && lastSeenSequence.lastSequence + 1n < vaa.sequence) {
            // possibly missed some vaas
            for (let currentSeq = lastSeenSequence.lastSequence; currentSeq < vaa.sequence; currentSeq++) {
                const fetchedVaa = await fetchVaa(wormholeRpcs, vaa.emitterChain, vaa.emitterAddress, currentSeq);
                let addr = vaa.emitterAddress.toString("hex");
                let seq = currentSeq.toString();
                ctx.logger?.info(`Possibly missed a vaa: ${vaa.emitterChain}/${addr}/${seq}. Adding to queue.`);
                try {
                    await ctx.processVaa(Buffer.from(fetchedVaa.vaaBytes));
                }
                catch (e) {
                    ctx.logger?.error(`Could not process recovered vaa: ${vaa.emitterChain}/${addr}/${seq}`, e);
                } // push the missed vaa through all the middleware / storage service if used.
            }
        }
        try {
            await next(); // <-- process the current vaa
        }
        finally {
            await setLastSequenceForContract(redis, vaa.emitterChain, vaa.emitterAddress, vaa.sequence, ctx.logger);
        }
    };
}
exports.missedVaas = missedVaas;
function getKey(emitterChain, emitterAddress) {
    let emitterAddressStr = emitterAddress.toString("hex");
    return `${emitterChain}:${emitterAddressStr}`;
}
async function getLastSequenceForContract(redis, emitterChain, emitterAddress) {
    let key = getKey(emitterChain, emitterAddress);
    let lastSeqRaw = await redis.hget("missedVaas", key);
    if (!lastSeqRaw) {
        return null;
    }
    let { lastSequence, timestamp } = JSON.parse(lastSeqRaw);
    return { lastSequence: BigInt(lastSequence), timestamp: new Date(timestamp) };
}
// TODO concurrency issue. This should be done in a lua script or use watch to avoid racing between step 1 and step 3
async function setLastSequenceForContract(redis, emitterChain, emitterAddress, seq, logger) {
    // step 1. fetch current last sequence
    let lastSeq = await getLastSequenceForContract(redis, emitterChain, emitterAddress);
    // step 2. if we have already seen an older seq, skip
    if (lastSeq && BigInt(lastSeq.lastSequence) > seq) {
        logger?.debug(`Did not update last sequence due to an older one being processed. Last seen${lastSeq.lastSequence.toString()}, Current: ${seq.toString()}.`);
        return false;
    }
    // step 3. if we haven't seen an older seq, set this one as the last seen.
    await redis.hset("missedVaas", getKey(emitterChain, emitterAddress), JSON.stringify({ lastSequence: seq.toString(), timestamp: Date.now() }));
    return true;
}
async function fetchVaa(rpc, chain, emitterAddress, sequence) {
    const resp = await (0, wormhole_sdk_1.getSignedVAAWithRetry)(rpc, chain, emitterAddress.toString("hex"), sequence.toString(), { transport: grpcWebNodeHttpTransport.NodeHttpTransport() }, 100, 2);
    return resp;
}
async function startMissedVaaWorker(redis, app, opts) {
    const wormholeRpcs = opts.wormholeRpcs || defaultRpcs[app.env];
    try {
        while (true) {
            let addressWithLastSequence = await Promise.all(app.filters
                .map((filter) => ({
                emitterChain: filter.emitterFilter.chainId,
                emitterAddress: Buffer.from(filter.emitterFilter.emitterAddress, "hex"),
            }))
                .map(async (address) => {
                const lastSequence = await getLastSequenceForContract(redis, address.emitterChain, address.emitterAddress);
                return { address, lastSequence };
            }));
            for (const { address, lastSequence } of addressWithLastSequence) {
                if (!lastSequence) {
                    continue;
                }
                try {
                    let nextSequence = lastSequence.lastSequence + 1n;
                    while (true) {
                        // iterate until fetchVaa throws because we couldn't find a next vaa.
                        let vaa = await fetchVaa(wormholeRpcs, address.emitterChain, address.emitterAddress, nextSequence);
                        opts.logger?.info(`Found missed VAA via the missedVaaWorker.`, {
                            emitterChain: address.emitterChain,
                            emitterAddress: address.emitterAddress.toString("hex"),
                            sequence: nextSequence.toString(),
                        });
                        app.processVaa(Buffer.from(vaa.vaaBytes));
                        nextSequence++;
                    }
                }
                catch (e) {
                    if (e.code !== 5) {
                        // 5: requested VAA not found in store
                        throw e;
                    }
                }
            }
            await (0, application_1.sleep)(opts.checkForMissedVaasEveryMs);
        }
    }
    catch (e) {
        opts.logger?.error(`startMissedVaaWorker loop failed with error`, e);
    }
}
//# sourceMappingURL=missedVaas.middleware.js.map