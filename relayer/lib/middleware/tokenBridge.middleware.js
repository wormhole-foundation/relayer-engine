"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenBridgeContracts = void 0;
const wormhole_sdk_1 = require("@certusone/wormhole-sdk");
const bullmq_1 = require("bullmq");
const ethers_contracts_1 = require("@certusone/wormhole-sdk/lib/cjs/ethers-contracts");
const application_1 = require("../application");
const consts_1 = require("@certusone/wormhole-sdk/lib/cjs/utils/consts");
const addresses = {
    [application_1.Environment.MAINNET]: {
        [wormhole_sdk_1.CHAIN_ID_SOLANA]: "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb",
        [wormhole_sdk_1.CHAIN_ID_ETH]: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
        [wormhole_sdk_1.CHAIN_ID_BSC]: "0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E7",
        [consts_1.CHAIN_ID_POLYGON]: "0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE",
        [consts_1.CHAIN_ID_AVAX]: "0x0e082F06FF657D94310cB8cE8B0D9a04541d8052",
        [consts_1.CHAIN_ID_FANTOM]: "0x7C9Fc5741288cDFdD83CeB07f3ea7e22618D79D2",
        [wormhole_sdk_1.CHAIN_ID_CELO]: "0x796Dff6D74F3E27060B71255Fe517BFb23C93eed",
        [wormhole_sdk_1.CHAIN_ID_MOONBEAM]: "0xb1731c586ca89a23809861c6103f0b96b3f57d92",
    },
    [application_1.Environment.TESTNET]: {
        [wormhole_sdk_1.CHAIN_ID_SOLANA]: "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
        [wormhole_sdk_1.CHAIN_ID_ETH]: "0xF890982f9310df57d00f659cf4fd87e65adEd8d7",
        [wormhole_sdk_1.CHAIN_ID_BSC]: "0x9dcF9D205C9De35334D646BeE44b2D2859712A09",
        [consts_1.CHAIN_ID_POLYGON]: "0x377D55a7928c046E18eEbb61977e714d2a76472a",
        [consts_1.CHAIN_ID_AVAX]: "0x61E44E506Ca5659E6c0bba9b678586fA2d729756",
        [consts_1.CHAIN_ID_FANTOM]: "0x599CEa2204B4FaECd584Ab1F2b6aCA137a0afbE8",
        [wormhole_sdk_1.CHAIN_ID_CELO]: "0x05ca6037eC51F8b712eD2E6Fa72219FEaE74E153",
        [wormhole_sdk_1.CHAIN_ID_MOONBEAM]: "0xb1731c586ca89a23809861c6103f0b96b3f57d92",
    },
    [application_1.Environment.DEVNET]: {},
};
function instantiateReadEvmContracts(env, chainRpcs) {
    const evmChainContracts = {};
    for (const [chainIdStr, chainRpc] of Object.entries(chainRpcs)) {
        const chainId = Number(chainIdStr);
        // @ts-ignore
        const address = addresses[env][chainId];
        const contracts = chainRpc.map((rpc) => ethers_contracts_1.ITokenBridge__factory.connect(address, rpc));
        evmChainContracts[chainId] = contracts;
    }
    return evmChainContracts;
}
function tokenBridgeContracts() {
    return async (ctx, next) => {
        if (!ctx.providers) {
            throw new bullmq_1.UnrecoverableError("You need to first use the providers middleware.");
        }
        const evmContracts = instantiateReadEvmContracts(ctx.env, ctx.providers.evm);
        ctx.tokenBridge = {
            addresses: addresses[ctx.env],
            contractConstructor: ethers_contracts_1.ITokenBridge__factory.connect,
            contracts: {
                read: {
                    evm: evmContracts,
                },
            },
        };
        await next();
    };
}
exports.tokenBridgeContracts = tokenBridgeContracts;
const defaultProviders = {};
//# sourceMappingURL=tokenBridge.middleware.js.map