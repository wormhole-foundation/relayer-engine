"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiController = void 0;
class ApiController {
    processFundsTransfer = async (ctx, next) => {
        let seq = ctx.vaa.sequence.toString();
        ctx.logger.info(`chain middleware - ${seq}`);
        await ctx.kv.withKey(["counter"], async ({ counter }) => {
            ctx.logger.debug(`Original counter value ${counter}`);
            counter = (counter ? counter : 0) + 1;
            ctx.logger.debug(`Counter value after update ${counter}`);
            return {
                newKV: { counter },
                val: counter,
            };
        });
        await next();
    };
}
exports.ApiController = ApiController;
//# sourceMappingURL=controller.js.map