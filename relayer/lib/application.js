"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sleep = exports.transformEmitterFilter = exports.RelayerApp = void 0;
const wormholeSdk = require("@certusone/wormhole-sdk");
const compose_middleware_1 = require("./compose.middleware");
const context_1 = require("./context");
const winston = require("winston");
const wormhole_spydk_1 = require("@certusone/wormhole-spydk");
const bech32_1 = require("bech32");
const wormhole_1 = require("@certusone/wormhole-sdk/lib/cjs/solana/wormhole");
const utils_1 = require("ethers/lib/utils");
const storage_1 = require("./storage");
const koa_1 = require("@bull-board/koa");
const api_1 = require("@bull-board/api");
const bullMQAdapter_1 = require("@bull-board/api/bullMQAdapter");
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
class RelayerApp {
    pipeline;
    errorPipeline;
    chainRouters = {};
    spyUrl;
    rootLogger;
    storage;
    constructor() { }
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
    async handleVaa(vaa, opts) {
        const parsedVaa = wormholeSdk.parseVaa(vaa);
        let ctx = new context_1.Context(this);
        Object.assign(ctx, opts);
        ctx.vaa = parsedVaa;
        ctx.vaaBytes = vaa;
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
        let filters = await this.spyFilters();
        if (filters.length > 0 && !this.spyUrl) {
            throw new Error("you need to setup the spy url");
        }
        this.storage?.startWorker();
        while (true) {
            const client = (0, wormhole_spydk_1.createSpyRPCServiceClient)(this.spyUrl);
            try {
                const stream = await (0, wormhole_spydk_1.subscribeSignedVAA)(client, {
                    filters,
                });
                this.rootLogger.info("connected to the spy");
                for await (const vaa of stream) {
                    if (this.storage) {
                        await this.storage.addVaaToQueue(vaa.vaaBytes);
                    }
                    else {
                        this.handleVaa(vaa.vaaBytes).catch((err) => { }); // error already handled by middleware, catch to swallow remaining error.
                    }
                }
            }
            catch (err) {
                this.rootLogger.error("error connecting to the spy");
            }
            await sleep(300); // wait a bit before trying to reconnect.
        }
    }
}
exports.RelayerApp = RelayerApp;
class ChainRouter {
    chainId;
    _routes = {};
    constructor(chainId) {
        this.chainId = chainId;
    }
    address = (address, ...handlers) => {
        address = encodeEmitterAddress(this.chainId, address);
        if (!this._routes[address]) {
            const route = new VaaRoute(this.chainId, address, handlers);
            this._routes[address] = route;
        }
        else {
            this._routes[address].addMiddleware(handlers);
        }
        return this;
    };
    spyFilters = () => {
        return this.routes().map((route) => route.spyFilter());
    };
    routes = () => {
        return Object.values(this._routes);
    };
    async process(ctx, next) {
        let addr = ctx.vaa.emitterAddress.toString("hex");
        let route = this._routes[addr];
        return route.execute(ctx, next);
    }
}
class VaaRoute {
    chainId;
    address;
    handler;
    constructor(chainId, address, handlers) {
        this.chainId = chainId;
        this.address = address;
        this.handler = (0, compose_middleware_1.compose)(handlers);
    }
    execute(ctx, next) {
        return this.handler(ctx, next);
    }
    addMiddleware(handlers) {
        this.handler = (0, compose_middleware_1.compose)([this.handler, ...handlers]);
    }
    spyFilter() {
        const filter = {
            chainId: this.chainId,
            emitterAddress: this.address,
        };
        return { emitterFilter: filter };
    }
}
function transformEmitterFilter(x) {
    return {
        chainId: x.chainId,
        emitterAddress: encodeEmitterAddress(x.chainId, x.emitterAddress),
    };
}
exports.transformEmitterFilter = transformEmitterFilter;
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