"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compose = void 0;
function compose(middleware) {
    return async function (ctx, next = () => { }) {
        async function callNext(i) {
            if (i >= middleware.length) {
                return next();
            }
            let fn = middleware[i];
            return fn(ctx, callNext.bind(null, i + 1));
        }
        await callNext(0);
    };
}
exports.compose = compose;
//# sourceMappingURL=compose.middleware.js.map