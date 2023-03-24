"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RelayerApp = exports.defaultWormholeRpcs = exports.UnrecoverableError = exports.Environment = void 0;
const wormholeSdk = require("@certusone/wormhole-sdk");
const wormhole_sdk_1 = require("@certusone/wormhole-sdk");
const compose_middleware_1 = require("./compose.middleware");
const wormhole_spydk_1 = require("@certusone/wormhole-spydk");
const storage_1 = require("./storage");
const koa_1 = require("@bull-board/koa");
const api_1 = require("@bull-board/api");
const bullMQAdapter_1 = require("@bull-board/api/bullMQAdapter");
const bullmq_1 = require("bullmq");
Object.defineProperty(exports, "UnrecoverableError", { enumerable: true, get: function () { return bullmq_1.UnrecoverableError; } });
const utils_1 = require("./utils");
const grpcWebNodeHttpTransport = require("@improbable-eng/grpc-web-node-http-transport");
const logging_1 = require("./logging");
const bundle_fetcher_helper_1 = require("./bundle-fetcher.helper");
var Environment;
(function (Environment) {
    Environment["MAINNET"] = "mainnet";
    Environment["TESTNET"] = "testnet";
    Environment["DEVNET"] = "devnet";
})(Environment = exports.Environment || (exports.Environment = {}));
exports.defaultWormholeRpcs = {
    [Environment.MAINNET]: ["https://api.wormscan.io"],
    [Environment.TESTNET]: [
        "https://wormhole-v2-testnet-api.certus.one",
        "https://api.testnet.wormscan.io",
    ],
    [Environment.DEVNET]: [""],
};
const defaultOpts = (env) => ({
    wormholeRpcs: exports.defaultWormholeRpcs[env],
    concurrency: 1,
});
class RelayerApp {
    env;
    pipeline;
    errorPipeline;
    chainRouters = {};
    spyUrl;
    rootLogger;
    storage;
    filters;
    opts;
    constructor(env = Environment.TESTNET, opts = {}) {
        this.env = env;
        this.opts = (0, utils_1.mergeDeep)({}, defaultOpts(env), opts);
    }
    multiple(chainsAndAddresses, ...middleware) {
        for (let [chain, addresses] of Object.entries(chainsAndAddresses)) {
            addresses = Array.isArray(addresses) ? addresses : [addresses];
            const chainRouter = this.chain(Number(chain));
            for (const address of addresses) {
                chainRouter.address(address, ...middleware);
            }
        }
    }
    use(...middleware) {
        if (!middleware.length) {
            return;
        }
        // adding error middleware
        if (middleware[0].length > 2) {
            if (this.errorPipeline) {
                middleware.unshift(this.errorPipeline);
            }
            this.errorPipeline = (0, compose_middleware_1.composeError)(middleware);
            return;
        }
        // adding regular middleware
        if (this.pipeline) {
            middleware.unshift(this.pipeline);
        }
        this.pipeline = (0, compose_middleware_1.compose)(middleware);
    }
    fetchVaas(opts) {
        const bundle = new bundle_fetcher_helper_1.VaaBundleFetcher(this.fetchVaa, {
            vaaIds: opts.ids,
            maxAttempts: opts.attempts,
            delayBetweenAttemptsInMs: opts.delayBetweenRequestsInMs,
        });
        return bundle.build();
    }
    async fetchVaa(chain, emitterAddress, sequence, { retryTimeout = 100, retries = 2, } = {
        retryTimeout: 100,
        retries: 2,
    }) {
        const res = await (0, wormhole_sdk_1.getSignedVAAWithRetry)(this.opts.wormholeRpcs, Number(chain), emitterAddress.toString("hex"), sequence.toString(), { transport: grpcWebNodeHttpTransport.NodeHttpTransport() }, retryTimeout, retries);
        return (0, utils_1.parseVaaWithBytes)(res.vaaBytes);
    }
    async processVaa(vaa, opts) {
        if (this.storage) {
            await this.storage.addVaaToQueue(vaa);
        }
        else {
            this.pushVaaThroughPipeline(vaa).catch((err) => { }); // error already handled by middleware, catch to swallow remaining error.
        }
    }
    async pushVaaThroughPipeline(vaa, opts) {
        const parsedVaa = wormholeSdk.parseVaa(vaa);
        let ctx = {
            vaa: parsedVaa,
            vaaBytes: vaa,
            env: this.env,
            fetchVaa: this.fetchVaa.bind(this),
            fetchVaas: this.fetchVaas.bind(this),
            processVaa: this.processVaa.bind(this),
            config: {
                spyFilters: await this.spyFilters(),
            },
        };
        Object.assign(ctx, opts);
        try {
            await this.pipeline?.(ctx, () => { });
        }
        catch (e) {
            this.errorPipeline?.(e, ctx, () => { });
            throw e;
        }
    }
    chain(chainId) {
        if (!this.chainRouters[chainId]) {
            this.chainRouters[chainId] = new ChainRouter(chainId);
        }
        return this.chainRouters[chainId];
    }
    tokenBridge(chains, ...handlers) {
        for (const chainIdOrName of chains) {
            const chainName = typeof chainIdOrName === "string"
                ? chainIdOrName
                : wormhole_sdk_1.CHAIN_ID_TO_NAME[chainIdOrName];
            const chainId = typeof chainIdOrName === "string"
                ? wormhole_sdk_1.CHAINS[chainIdOrName]
                : chainIdOrName;
            let address = 
            // @ts-ignore TODO
            wormhole_sdk_1.CONTRACTS[this.env.toUpperCase()][chainName].token_bridge;
            this.chain(chainId).address(address, ...handlers);
        }
        return this;
    }
    async spyFilters() {
        const spyFilters = new Set();
        for (const [chainId, chainRouter] of Object.entries(this.chainRouters)) {
            for (const filter of await chainRouter.spyFilters()) {
                spyFilters.add(filter);
            }
        }
        return Array.from(spyFilters.values());
    }
    spy(url) {
        this.spyUrl = url;
        return this;
    }
    logger(logger) {
        this.rootLogger = logger;
        if (this.storage) {
            this.storage.logger = logger;
        }
    }
    useStorage(storageOptions) {
        this.storage = new storage_1.Storage(this, storageOptions);
        if (this.rootLogger) {
            this.storage.logger = this.rootLogger;
        }
    }
    storageKoaUI(path) {
        // UI
        const serverAdapter = new koa_1.KoaAdapter();
        serverAdapter.setBasePath(path);
        (0, api_1.createBullBoard)({
            queues: [new bullMQAdapter_1.BullMQAdapter(this.storage.vaaQueue)],
            serverAdapter: serverAdapter,
        });
        return serverAdapter.registerPlugin();
    }
    generateChainRoutes() {
        let chainRouting = async (ctx, next) => {
            let router = this.chainRouters[ctx.vaa.emitterChain];
            if (!router) {
                this.rootLogger.error("received a vaa but we don't have a router for it");
                return;
            }
            await router.process(ctx, next);
        };
        return chainRouting;
    }
    async listen() {
        this.rootLogger = this.rootLogger ?? logging_1.defaultLogger;
        if (this.storage && !this.storage.logger) {
            this.storage.logger = this.rootLogger;
        }
        this.use(this.generateChainRoutes());
        this.filters = await this.spyFilters();
        this.rootLogger.debug(JSON.stringify(this.filters, null, 2));
        if (this.filters.length > 0 && !this.spyUrl) {
            throw new Error("you need to setup the spy url");
        }
        this.storage?.startWorker();
        while (true) {
            const client = (0, wormhole_spydk_1.createSpyRPCServiceClient)(this.spyUrl);
            try {
                const stream = await (0, wormhole_spydk_1.subscribeSignedVAA)(client, {
                    filters: this.filters,
                });
                this.rootLogger.info(`connected to the spy at: ${this.spyUrl}`);
                for await (const vaa of stream) {
                    this.rootLogger.debug(`Received VAA through spy`);
                    this.processVaa(vaa.vaaBytes).catch();
                }
            }
            catch (err) {
                this.rootLogger.error("error connecting to the spy");
            }
            await (0, utils_1.sleep)(300); // wait a bit before trying to reconnect.
        }
    }
    stop() {
        return this.storage.stopWorker();
    }
}
exports.RelayerApp = RelayerApp;
class ChainRouter {
    chainId;
    _addressHandlers = {};
    constructor(chainId) {
        this.chainId = chainId;
    }
    address = (address, ...handlers) => {
        address = (0, utils_1.encodeEmitterAddress)(this.chainId, address);
        if (!this._addressHandlers[address]) {
            this._addressHandlers[address] = (0, compose_middleware_1.compose)(handlers);
        }
        else {
            this._addressHandlers[address] = (0, compose_middleware_1.compose)([
                this._addressHandlers[address],
                ...handlers,
            ]);
        }
        return this;
    };
    spyFilters() {
        let addresses = Object.keys(this._addressHandlers);
        const filters = addresses.map((address) => ({
            emitterFilter: { chainId: this.chainId, emitterAddress: address },
        }));
        return filters;
    }
    async process(ctx, next) {
        let addr = ctx.vaa.emitterAddress.toString("hex");
        let handler = this._addressHandlers[addr];
        if (!handler) {
            throw new Error("route undefined");
        }
        return handler?.(ctx, next);
    }
}
//# sourceMappingURL=application.js.map