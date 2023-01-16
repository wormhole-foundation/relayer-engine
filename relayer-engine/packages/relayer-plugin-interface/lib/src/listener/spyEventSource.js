"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPluginSpyListener = void 0;
const wormhole_spydk_1 = require("@certusone/wormhole-spydk");
const LRUCache = require("lru-cache");
const utils_1 = require("../utils/utils");
const wormholeSdk = require("@certusone/wormhole-sdk");
const logHelper_1 = require("../helpers/logHelper");
const eventHarness_1 = require("./eventHarness");
let _logger;
const logger = () => {
    if (!_logger) {
        _logger = (0, logHelper_1.getScopedLogger)(["spyEventSource"]);
    }
    return _logger;
};
//used for both rest & spy relayer for now
async function runPluginSpyListener(plugin, storage, client, providers, numGuardians) {
    const vaaHashCache = new LRUCache({
        max: 10000,
    });
    while (true) {
        let stream;
        try {
            const rawFilters = plugin.getFilters();
            const filters = await Promise.all(rawFilters.map(async (x) => {
                return {
                    emitterFilter: await transformEmitterFilter(x),
                };
            }));
            logger().info(`${plugin.pluginName} subscribing to spy with raw filters: ${JSON.stringify(rawFilters)}`);
            logger().debug(`${plugin.pluginName} using transformed filters: ${JSON.stringify(filters)}`);
            stream = await (0, wormhole_spydk_1.subscribeSignedVAA)(client, {
                filters,
            });
            stream.on("data", (vaa) => {
                const parsed = wormholeSdk.parseVaa(vaa.vaaBytes);
                const hash = parsed.hash.toString("base64");
                logger().debug(hash);
                logger().debug(parsed.emitterChain);
                if (parsed.guardianSignatures.length < Math.ceil((numGuardians * 2) / 3)) {
                    logger().debug(`Encountered VAA without enough signatures: ${parsed.guardianSignatures.length}, need ${Math.ceil((numGuardians * 2) / 3)}, ${hash}`);
                    return;
                }
                if (vaaHashCache.get(hash)) {
                    logger().debug(`Duplicate founds for hash ${hash}`);
                    return;
                }
                vaaHashCache.set(hash, true);
                (0, eventHarness_1.consumeEventHarness)(vaa.vaaBytes, plugin, storage, providers);
            });
            let connected = true;
            stream.on("error", (err) => {
                logger().error("spy service returned an error: %o", err);
                connected = false;
            });
            stream.on("close", () => {
                logger().error("spy service closed the connection!");
                connected = false;
            });
            logger().info("connected to spy service, listening for transfer signed VAAs");
            while (connected) {
                await (0, utils_1.sleep)(1000);
            }
        }
        catch (e) {
            logger().error("spy service threw an exception: %o", e);
        }
        stream.destroy();
        await (0, utils_1.sleep)(5 * 1000);
        logger().info("attempting to reconnect to the spy service");
    }
}
exports.runPluginSpyListener = runPluginSpyListener;
async function transformEmitterFilter(x) {
    return {
        chainId: x.chainId,
        emitterAddress: await encodeEmitterAddress(x.chainId, x.emitterAddress),
    };
}
async function encodeEmitterAddress(myChainId, emitterAddressStr) {
    if (myChainId === wormholeSdk.CHAIN_ID_SOLANA ||
        myChainId === wormholeSdk.CHAIN_ID_PYTHNET) {
        return await wormholeSdk.getEmitterAddressSolana(emitterAddressStr);
    }
    if (wormholeSdk.isTerraChain(myChainId)) {
        return await wormholeSdk.getEmitterAddressTerra(emitterAddressStr);
    }
    if (wormholeSdk.isEVMChain(myChainId)) {
        return wormholeSdk.getEmitterAddressEth(emitterAddressStr);
    }
    throw new Error(`Unrecognized wormhole chainId ${myChainId}`);
}
//# sourceMappingURL=spyEventSource.js.map