"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenBridgeContracts = void 0;
const wormhole_sdk_1 = require("@certusone/wormhole-sdk");
const bullmq_1 = require("bullmq");
const ethers_contracts_1 = require("@certusone/wormhole-sdk/lib/cjs/ethers-contracts");
const application_1 = require("../application");
const utils_1 = require("../utils");
function extractTokenBridgeAddressesFromSdk(env) {
    return Object.fromEntries(Object.entries(wormhole_sdk_1.CONTRACTS[env.toUpperCase()]).map(([chainName, addresses]) => [chainName, addresses.token_bridge]));
}
const tokenBridgeAddresses = {
    [application_1.Environment.MAINNET]: extractTokenBridgeAddressesFromSdk(application_1.Environment.MAINNET),
    [application_1.Environment.TESTNET]: extractTokenBridgeAddressesFromSdk(application_1.Environment.TESTNET),
    [application_1.Environment.DEVNET]: extractTokenBridgeAddressesFromSdk(application_1.Environment.DEVNET),
};
function instantiateReadEvmContracts(env, chainRpcs) {
    const evmChainContracts = {};
    for (const [chainIdStr, chainRpc] of Object.entries(chainRpcs)) {
        const chainId = Number(chainIdStr);
        // @ts-ignore
        const address = tokenBridgeAddresses[env][wormhole_sdk_1.CHAIN_ID_TO_NAME[chainId]];
        const contracts = chainRpc.map((rpc) => ethers_contracts_1.ITokenBridge__factory.connect(address, rpc));
        evmChainContracts[chainId] = contracts;
    }
    return evmChainContracts;
}
function isTokenBridgeVaa(env, vaa) {
    let chainId = vaa.emitterChain;
    const chainName = wormhole_sdk_1.CHAIN_ID_TO_NAME[chainId];
    // @ts-ignore TODO remove
    let tokenBridgeLocalAddress = tokenBridgeAddresses[env][chainName];
    if (!tokenBridgeLocalAddress) {
        return false;
    }
    const emitterAddress = vaa.emitterAddress.toString("hex");
    let tokenBridgeEmitterAddress = (0, utils_1.encodeEmitterAddress)(chainId, tokenBridgeLocalAddress);
    return tokenBridgeEmitterAddress === emitterAddress;
}
function tokenBridgeContracts() {
    return async (ctx, next) => {
        if (!ctx.providers) {
            throw new bullmq_1.UnrecoverableError("You need to first use the providers middleware.");
        }
        const evmContracts = instantiateReadEvmContracts(ctx.env, ctx.providers.evm);
        ctx.tokenBridge = {
            addresses: tokenBridgeAddresses[ctx.env],
            contractConstructor: ethers_contracts_1.ITokenBridge__factory.connect,
            contracts: {
                read: {
                    evm: evmContracts,
                },
            },
            vaa: isTokenBridgeVaa(ctx.env, ctx.vaa)
                ? (0, wormhole_sdk_1.parseTokenTransferVaa)(ctx.vaaBytes)
                : null,
        };
        await next();
    };
}
exports.tokenBridgeContracts = tokenBridgeContracts;
//# sourceMappingURL=tokenBridge.middleware.js.map