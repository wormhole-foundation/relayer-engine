"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storage = void 0;
const redis_1 = require("redis");
function storage(cfg) {
    const client = (0, redis_1.createClient)({ url: cfg.redis.url });
    const storage = new StorageService(client);
    return async function (ctx, next) {
        try {
            const logger = ctx.logger;
            const added = await storage.addWorkflow(ctx.vaa);
            if (!added) {
                logger.debug("Vaa already seen... skipping");
                return;
            }
            await next();
        }
        catch (e) { }
    };
}
exports.storage = storage;
class StorageService {
    client;
    constructor(client) {
        this.client = client;
    }
    vaaKey(vaa) {
        let emitterAddress = vaa.emitterAddress.toString("hex");
        let hash = vaa.hash.toString("base64").substring(0, 5);
        return `${vaa.emitterChain}/${emitterAddress}/${vaa.sequence}/${hash}`;
    }
    async addWorkflow(vaa) {
        const key = this.vaaKey(vaa);
        const res = await this.client.zAdd("filters:ready", {
            value: key,
            score: Date.now(),
        });
        if (!res) {
            return false;
        }
        // TODO: fix race condition (redis lua-script?) if crashes after adding to filter but prior to queue
        await this.client.multi().lPush("queues:inprogress", key);
        return true;
    }
}
//# sourceMappingURL=storage.middleware.js.map