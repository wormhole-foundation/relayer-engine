"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.providers = void 0;
const wormhole_sdk_1 = require("@certusone/wormhole-sdk");
const ethers_1 = require("ethers");
const web3_js_1 = require("@solana/web3.js");
const application_1 = require("../application");
const consts_1 = require("@certusone/wormhole-sdk/lib/cjs/utils/consts");
const defaultSupportedChains = {
    [application_1.Environment.MAINNET]: {
        [wormhole_sdk_1.CHAIN_ID_SOLANA]: { nodeUrls: [""] },
        [wormhole_sdk_1.CHAIN_ID_ETH]: { nodeUrls: ["https://rpc.ankr.com/eth"] },
        [wormhole_sdk_1.CHAIN_ID_BSC]: { nodeUrls: ["https://bsc-dataseed1.binance.org/"] },
        [consts_1.CHAIN_ID_POLYGON]: { nodeUrls: ["https://rpc.ankr.com/polygon"] },
        [consts_1.CHAIN_ID_AVAX]: { nodeUrls: ["https://api.avax.network/ext/bc/C/rpc"] },
        [consts_1.CHAIN_ID_FANTOM]: { nodeUrls: ["https://rpc.ftm.tools"] },
        [wormhole_sdk_1.CHAIN_ID_CELO]: { nodeUrls: ["https://forno.celo.org"] },
        [wormhole_sdk_1.CHAIN_ID_MOONBEAM]: { nodeUrls: ["https://rpc.api.moonbeam.network"] },
    },
    [application_1.Environment.TESTNET]: {
        [wormhole_sdk_1.CHAIN_ID_ETH]: {
            nodeUrls: [
                "https://eth-goerli.g.alchemy.com/v2/mvFFcUhFfHujAOewWU8kH5D1R2bgFgLt",
            ],
        },
        [wormhole_sdk_1.CHAIN_ID_BSC]: {
            nodeUrls: ["https://data-seed-prebsc-1-s3.binance.org:8545"],
        },
        [consts_1.CHAIN_ID_POLYGON]: {
            nodeUrls: ["https://matic-mumbai.chainstacklabs.com"],
        },
        [consts_1.CHAIN_ID_AVAX]: {
            nodeUrls: ["https://api.avax-test.network/ext/bc/C/rpc"],
        },
        [consts_1.CHAIN_ID_FANTOM]: { nodeUrls: ["https://rpc.ankr.com/fantom_testnet"] },
        [wormhole_sdk_1.CHAIN_ID_CELO]: { nodeUrls: ["https://alfajores-forno.celo-testnet.org"] },
        [wormhole_sdk_1.CHAIN_ID_MOONBEAM]: { nodeUrls: ["https://rpc.testnet.moonbeam.network"] },
    },
    [application_1.Environment.DEVNET]: {},
};
function buildProviders(env, opts) {
    const supportedChains = Object.assign({}, defaultSupportedChains[env], opts?.supportedChains);
    const providers = {
        evm: {},
        solana: [],
    };
    for (const [chainIdStr, chainCfg] of Object.entries(supportedChains)) {
        const chainId = Number(chainIdStr);
        const { nodeUrls } = chainCfg;
        if ((0, wormhole_sdk_1.isEVMChain)(chainId)) {
            providers.evm[chainId] = nodeUrls.map((url) => new ethers_1.ethers.providers.JsonRpcProvider(url));
        }
        else if (chainId === wormhole_sdk_1.CHAIN_ID_SOLANA) {
            providers.solana = nodeUrls.map((url) => new web3_js_1.Connection(url));
        }
    }
    return providers;
}
function providers(opts) {
    let providers;
    return async (ctx, next) => {
        if (!providers) {
            providers = buildProviders(ctx.env, opts);
        }
        ctx.providers = providers;
        await next();
    };
}
exports.providers = providers;
const defaultProviders = {};
//# sourceMappingURL=providers.middleware.js.map