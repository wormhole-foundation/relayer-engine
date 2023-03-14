"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sleep = exports.RelayerApp = exports.UnrecoverableError = exports.Environment = void 0;
const wormholeSdk = require("@certusone/wormhole-sdk");
const compose_middleware_1 = require("./compose.middleware");
const winston = require("winston");
const wormhole_spydk_1 = require("@certusone/wormhole-spydk");
const bech32_1 = require("bech32");
const wormhole_1 = require("@certusone/wormhole-sdk/lib/cjs/solana/wormhole");
const utils_1 = require("ethers/lib/utils");
const storage_1 = require("./storage");
const koa_1 = require("@bull-board/koa");
const api_1 = require("@bull-board/api");
const bullMQAdapter_1 = require("@bull-board/api/bullMQAdapter");
const bullmq_1 = require("bullmq");
Object.defineProperty(exports, "UnrecoverableError", { enumerable: true, get: function () { return bullmq_1.UnrecoverableError; } });
const defaultLogger = winston.createLogger({
    transports: [
        new winston.transports.Console({
            level: "debug",
        }),
    ],
    format: winston.format.combine(winston.format.colorize(), winston.format.splat(), winston.format.simple(), winston.format.timestamp({
        format: "YYYY-MM-DD HH:mm:ss.SSS",
    }), winston.format.errors({ stack: true })),
});
var Environment;
(function (Environment) {
    Environment["MAINNET"] = "mainnet";
    Environment["TESTNET"] = "testnet";
    Environment["DEVNET"] = "devnet";
})(Environment = exports.Environment || (exports.Environment = {}));
class RelayerApp {
    env;
    pipeline;
    errorPipeline;
    chainRouters = {};
    spyUrl;
    rootLogger;
    storage;
    filters;
    constructor(env = Environment.TESTNET) {
        this.env = env;
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
        this.rootLogger = this.rootLogger ?? defaultLogger;
        if (this.storage && !this.storage.logger) {
            this.storage.logger = this.rootLogger;
        }
        this.use(this.generateChainRoutes());
        this.filters = await this.spyFilters();
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
                this.rootLogger.info("connected to the spy");
                for await (const vaa of stream) {
                    this.processVaa(vaa.vaaBytes).catch();
                }
            }
            catch (err) {
                this.rootLogger.error("error connecting to the spy");
            }
            await sleep(300); // wait a bit before trying to reconnect.
        }
    }
    environment(env) {
        this.env = env;
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
        address = encodeEmitterAddress(this.chainId, address);
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
function encodeEmitterAddress(myChainId, emitterAddressStr) {
    if (myChainId === wormholeSdk.CHAIN_ID_SOLANA ||
        myChainId === wormholeSdk.CHAIN_ID_PYTHNET) {
        return (0, wormhole_1.deriveWormholeEmitterKey)(emitterAddressStr)
            .toBuffer()
            .toString("hex");
    }
    if (wormholeSdk.isTerraChain(myChainId)) {
        return Buffer.from((0, utils_1.zeroPad)(bech32_1.bech32.fromWords(bech32_1.bech32.decode(emitterAddressStr).words), 32)).toString("hex");
    }
    if (wormholeSdk.isEVMChain(myChainId)) {
        return wormholeSdk.getEmitterAddressEth(emitterAddressStr);
    }
    throw new Error(`Unrecognized wormhole chainId ${myChainId}`);
}
function sleep(ms) {
    return new Promise((resolve, reject) => setTimeout(resolve, ms));
}
exports.sleep = sleep;
//# sourceMappingURL=application.js.map