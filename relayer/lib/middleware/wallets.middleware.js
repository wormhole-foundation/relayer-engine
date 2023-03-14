"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wallets = void 0;
function wallets(pks) {
    return async (ctx, next) => {
        await next();
    };
}
exports.wallets = wallets;
//# sourceMappingURL=wallets.middleware.js.map