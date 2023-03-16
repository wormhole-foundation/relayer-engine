"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.composeError = exports.compose = void 0;
function compose(middleware) {
    return async function (ctx, next = () => { }) {
        async function callNext(i) {
            if (i === middleware.length) {
                return next();
            }
            let fn = middleware[i];
            return fn(ctx, callNext.bind(null, i + 1));
        }
        return callNext(0);
    };
}
exports.compose = compose;
// error middleware. TODO: cleanup
function composeError(middleware) {
    return async function (err, ctx, next = () => { }) {
        async function callNext(i) {
            if (i === middleware.length) {
                return next();
            }
            let fn = middleware[i];
            return fn(err, ctx, callNext.bind(null, i + 1));
        }
        return callNext(0);
    };
}
exports.composeError = composeError;
//# sourceMappingURL=compose.middleware.js.map