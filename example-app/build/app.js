"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const yargs_1 = require("yargs");
const Koa = require("koa");
const wormhole_relayer_1 = require("wormhole-relayer");
const wormhole_sdk_1 = require("@certusone/wormhole-sdk");
const logger_middleware_1 = require("wormhole-relayer/middleware/logger.middleware");
const tokenBridge_middleware_1 = require("wormhole-relayer/middleware/tokenBridge.middleware");
const missedVaas_middleware_1 = require("wormhole-relayer/middleware/missedVaas.middleware");
const providers_middleware_1 = require("wormhole-relayer/middleware/providers.middleware");
const staging_area_middleware_1 = require("wormhole-relayer/middleware/staging-area.middleware");
const log_1 = require("./log");
const controller_1 = require("./controller");
const privateKeys = {
    [wormhole_sdk_1.CHAIN_ID_ETH]: [process.env.ETH_KEY],
};
async function main() {
    let opts = (0, yargs_1.default)(process.argv.slice(2)).argv;
    const app = new wormhole_relayer_1.RelayerApp(wormhole_relayer_1.Environment.TESTNET);
    const fundsCtrl = new controller_1.ApiController();
    // Config
    configRelayer(app);
    // Set up middleware
    app.use((0, logger_middleware_1.logging)(log_1.rootLogger)); // <-- logging middleware
    app.use((0, missedVaas_middleware_1.missedVaas)(app, { namespace: "simple", logger: log_1.rootLogger }));
    app.use((0, providers_middleware_1.providers)());
    // app.use(wallets({ logger: rootLogger, namespace: "simple", privateKeys })); // <-- you need a valid private key to turn on this middleware
    app.use((0, tokenBridge_middleware_1.tokenBridgeContracts)());
    app.use((0, staging_area_middleware_1.stagingArea)());
    app
        .chain(wormhole_sdk_1.CHAIN_ID_SOLANA)
        .address("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe", fundsCtrl.processFundsTransfer);
    // Another way to do it if you want to listen to multiple addresses on different chaints:
    // let contractAddresses = {
    //   [CHAIN_ID_SOLANA]: ["DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe"],
    // };
    // app.multiple(contractAddresses, fundsCtrl.processFundsTransfer);
    app.use(async (err, ctx, next) => {
        ctx.logger.error("error middleware triggered");
    }); // <-- if you pass in a function with 3 args, it'll be used to process errors (whenever you throw from your middleware)
    app.listen();
    runUI(app, opts, log_1.rootLogger);
}
function configRelayer(app) {
    app.spy("localhost:7073");
    app.useStorage({ attempts: 3, namespace: "simple", queueName: "relays" });
    app.logger(log_1.rootLogger);
}
function runUI(relayer, { port }, logger) {
    const app = new Koa();
    app.use(relayer.storageKoaUI("/ui"));
    port = Number(port) || 3000;
    app.listen(port, () => {
        logger.info(`Running on ${port}...`);
        logger.info(`For the UI, open http://localhost:${port}/ui`);
        logger.info("Make sure Redis is running on port 6379 by default");
    });
}
main();
//# sourceMappingURL=app.js.map