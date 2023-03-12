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
    chainRouters = {};
    spyUrl;
    rootLogger;
    constructor() { }
    use(...middleware) {
        if (this.pipeline) {
            middleware.unshift(this.pipeline);
        }
        this.pipeline = (0, compose_middleware_1.compose)(middleware);
    }
    handleVaa(vaa) {
        const parsedVaa = wormholeSdk.parseVaa(vaa);
        let ctx = new context_1.Context(this);
        ctx.vaa = parsedVaa;
        ctx.vaaBytes = vaa;
        return this.pipeline?.(ctx, () => { });
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
        this.use(this.generateChainRoutes());
        let filters = await this.spyFilters();
        if (filters.length > 0 && !this.spyUrl) {
            throw new Error("you need to setup the spy url");
        }
        while (true) {
            const client = (0, wormhole_spydk_1.createSpyRPCServiceClient)(this.spyUrl);
            try {
                const stream = await (0, wormhole_spydk_1.subscribeSignedVAA)(client, {
                    filters,
                });
                this.rootLogger.info("connected to the spy");
                for await (const vaa of stream) {
                    this.handleVaa(vaa.vaaBytes);
                }
            }
            catch (err) {
                this.rootLogger.error("error connecting to the spy");
            }
            await sleep(300);
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
        await route.execute(ctx, next);
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