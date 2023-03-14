"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sleep = exports.encodeEmitterAddress = void 0;
const wormholeSdk = require("@certusone/wormhole-sdk");
const bech32_1 = require("bech32");
const wormhole_1 = require("@certusone/wormhole-sdk/lib/cjs/solana/wormhole");
const utils_1 = require("ethers/lib/utils");
function encodeEmitterAddress(chainId, emitterAddressStr) {
    if (chainId === wormholeSdk.CHAIN_ID_SOLANA ||
        chainId === wormholeSdk.CHAIN_ID_PYTHNET) {
        return (0, wormhole_1.deriveWormholeEmitterKey)(emitterAddressStr)
            .toBuffer()
            .toString("hex");
    }
    if (wormholeSdk.isCosmWasmChain(chainId)) {
        return Buffer.from((0, utils_1.zeroPad)(bech32_1.bech32.fromWords(bech32_1.bech32.decode(emitterAddressStr).words), 32)).toString("hex");
    }
    if (wormholeSdk.isEVMChain(chainId)) {
        return wormholeSdk.getEmitterAddressEth(emitterAddressStr);
    }
    if (wormholeSdk.CHAIN_ID_ALGORAND === chainId) {
        return wormholeSdk.getEmitterAddressAlgorand(BigInt(emitterAddressStr));
    }
    if (wormholeSdk.CHAIN_ID_NEAR === chainId) {
        return wormholeSdk.getEmitterAddressNear(emitterAddressStr);
    }
    throw new Error(`Unrecognized wormhole chainId ${chainId}`);
}
exports.encodeEmitterAddress = encodeEmitterAddress;
function sleep(ms) {
    return new Promise((resolve, reject) => setTimeout(resolve, ms));
}
exports.sleep = sleep;
//# sourceMappingURL=utils.js.map