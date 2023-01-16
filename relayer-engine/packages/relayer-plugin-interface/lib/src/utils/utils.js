"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseVaaWithBytes = exports.assertBool = exports.sleep = exports.assertArray = exports.assertInt = exports.nnull = exports.EngineError = void 0;
const wormhole_sdk_1 = require("@certusone/wormhole-sdk");
class EngineError extends Error {
    args;
    constructor(msg, args) {
        super(msg);
        this.args = args;
    }
}
exports.EngineError = EngineError;
function nnull(x, errMsg) {
    if (x === undefined || x === null) {
        throw new Error("Found unexpected undefined or null. " + errMsg);
    }
    return x;
}
exports.nnull = nnull;
function assertInt(x, fieldName) {
    if (!Number.isInteger(Number(x))) {
        throw new EngineError(`Expected field to be integer, found ${x}`, {
            fieldName,
        });
    }
    return x;
}
exports.assertInt = assertInt;
function assertArray(x, name, elemsPred) {
    if (!Array.isArray(x) || (elemsPred && !x.every(elemsPred))) {
        throw new EngineError(`Expected value to be array, found ${x}`, {
            name,
        });
    }
    return x;
}
exports.assertArray = assertArray;
function sleep(ms) {
    return new Promise((resolve, reject) => setTimeout(resolve, ms));
}
exports.sleep = sleep;
function assertBool(x, fieldName) {
    if (x !== false && x !== true) {
        throw new EngineError(`Expected field to be boolean, found ${x}`, {
            fieldName,
        });
    }
    return x;
}
exports.assertBool = assertBool;
function parseVaaWithBytes(vaa) {
    const parsedVaa = (0, wormhole_sdk_1.parseVaa)(vaa);
    parsedVaa.bytes = Buffer.from(vaa);
    return parsedVaa;
}
exports.parseVaaWithBytes = parseVaaWithBytes;
//# sourceMappingURL=utils.js.map