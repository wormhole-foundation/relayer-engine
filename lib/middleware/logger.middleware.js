"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logging = void 0;
function logging(logger) {
    return async (ctx, next) => {
        ctx.logger = ctx.vaa
            ? logger.child({
                emitterChain: ctx.vaa.emitterChain,
                emitterAddress: ctx.vaa.emitterAddress.toString("hex"),
                sequence: ctx.vaa.sequence,
            })
            : logger;
        ctx.logger.debug(`Starting VAA processing`);
        try {
            await next();
        }
        catch (e) {
            ctx.logger.debug(`Error during VAA processing`, e);
            throw e;
        }
        finally {
            ctx.logger.debug(`Finished VAA processing`);
        }
    };
}
exports.logging = logging;
//# sourceMappingURL=logger.middleware.js.map