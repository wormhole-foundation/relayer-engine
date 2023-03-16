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
        await next();
    };
}
exports.logging = logging;
//# sourceMappingURL=logger.middleware.js.map