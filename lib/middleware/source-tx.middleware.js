"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sourceTx = void 0;
const application_1 = require("../application");
const utils_1 = require("../utils");
const defaultOptsByEnv = {
    [application_1.Environment.MAINNET]: {
        wormscanEndpoint: "https://api.wormscan.io"
    },
    [application_1.Environment.TESTNET]: {
        wormscanEndpoint: "https://api.testnet.wormscan.io"
    },
    [application_1.Environment.DEVNET]: {
        wormscanEndpoint: ""
    }
};
function sourceTx(optsWithoutDefaults) {
    let opts;
    return async (ctx, next) => {
        if (!opts) {
            opts = Object.assign({}, defaultOptsByEnv[ctx.env], optsWithoutDefaults);
        }
        const { emitterChain, emitterAddress, sequence } = ctx.vaa;
        let attempt = 0;
        let txHash = "";
        do {
            try {
                txHash = await fetchVaaHash(opts.wormscanEndpoint, emitterChain, emitterAddress, sequence);
            }
            catch (e) {
                ctx.logger?.error(`could not obtain txHash, attempt: ${attempt} of ${opts.retries}.`, e);
                await (0, utils_1.sleep)(attempt * 100); // linear wait
            }
        } while (attempt < opts.retries && txHash === "");
        ctx.sourceTxHash = txHash;
        await next();
    };
}
exports.sourceTx = sourceTx;
async function fetchVaaHash(baseEndpoint, emitterChain, emitterAddress, sequence) {
    const res = await fetch(`${baseEndpoint}/api/v1/vaas/${emitterChain}/${emitterAddress.toString("hex")}/${sequence.toString()}`);
    if (res.status === 404) {
        throw new Error("Not found yet.");
    }
    else if (res.status > 500) {
        throw new Error(`Got: ${res.status}`);
    }
    return (await res.json()).data?.txHash;
}
//# sourceMappingURL=source-tx.middleware.js.map