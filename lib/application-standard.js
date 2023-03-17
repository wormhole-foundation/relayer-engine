"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StandardRelayerApp = void 0;
const application_1 = require("./application");
const logger_middleware_1 = require("./middleware/logger.middleware");
const missedVaas_middleware_1 = require("./middleware/missedVaas.middleware");
const providers_middleware_1 = require("./middleware/providers.middleware");
const wallet_middleware_1 = require("./middleware/wallet/wallet.middleware");
const tokenBridge_middleware_1 = require("./middleware/tokenBridge.middleware");
const staging_area_middleware_1 = require("./middleware/staging-area.middleware");
const utils_1 = require("./utils");
const source_tx_middleware_1 = require("./middleware/source-tx.middleware");
const defaultOpts = {
    spyEndpoint: "localhost:7373",
    workflows: {
        retries: 3,
    },
    fetchSourceTxhash: true
};
class StandardRelayerApp extends application_1.RelayerApp {
    constructor(env, opts) {
        // take logger out before merging because of recursive call stack
        const logger = opts.logger;
        delete opts.logger;
        // now we can merge
        opts = (0, utils_1.mergeDeep)({}, defaultOpts, opts);
        const { privateKeys, name, spyEndpoint, redis, redisCluster, redisClusterEndpoints } = opts;
        super(env, opts);
        this.spy(spyEndpoint);
        this.useStorage({
            redis,
            redisClusterEndpoints,
            redisCluster,
            attempts: opts.workflows.retries ?? 3,
            namespace: name,
            queueName: `${name}-relays`,
        });
        this.logger(logger);
        this.use((0, logger_middleware_1.logging)(logger)); // <-- logging middleware
        this.use((0, missedVaas_middleware_1.missedVaas)(this, { namespace: name, logger, redis, redisCluster, redisClusterEndpoints }));
        this.use((0, providers_middleware_1.providers)());
        if (opts.privateKeys && Object.keys(opts.privateKeys).length) {
            this.use((0, wallet_middleware_1.wallets)({ logger, namespace: name, privateKeys })); // <-- you need valid private keys to turn on this middleware
        }
        this.use((0, tokenBridge_middleware_1.tokenBridgeContracts)());
        this.use((0, staging_area_middleware_1.stagingArea)({ namespace: name, redisCluster, redis, redisClusterEndpoints }));
        if (opts.fetchSourceTxhash) {
            this.use((0, source_tx_middleware_1.sourceTx)());
        }
    }
}
exports.StandardRelayerApp = StandardRelayerApp;
//# sourceMappingURL=application-standard.js.map