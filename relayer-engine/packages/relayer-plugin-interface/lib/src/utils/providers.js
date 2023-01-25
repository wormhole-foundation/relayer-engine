"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.providersFromChainConfig = void 0;
const wormhole_sdk_1 = require("@certusone/wormhole-sdk");
const web3_js_1 = require("@solana/web3.js");
const ethers_1 = require("ethers");
function providersFromChainConfig(chainConfigs) {
    const evmEntries = chainConfigs.flatMap((chain) => {
        if ((0, wormhole_sdk_1.isEVMChain)(chain.chainId)) {
            return [
                [chain.chainId, new ethers_1.ethers.providers.JsonRpcProvider(chain.nodeUrl)],
            ];
        }
        return [];
    });
    const evm = Object.fromEntries(evmEntries);
    let solanaUrl = chainConfigs.find((info) => info.chainId === wormhole_sdk_1.CHAIN_ID_SOLANA)?.nodeUrl;
    if (!solanaUrl) {
        // todo: change me!!!!!!
        solanaUrl = "http://localhost:8899";
        // todo: generalize this
        // throw new Error("Expected solana rpc url to be defined");
    }
    return {
        evm,
        solana: new web3_js_1.Connection(solanaUrl, "confirmed"),
    };
}
exports.providersFromChainConfig = providersFromChainConfig;
//# sourceMappingURL=providers.js.map