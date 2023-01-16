"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEnvs = exports.transformEnvs = exports.loadRelayerEngineConfig = exports.getListenerEnv = exports.getExecutorEnv = exports.getCommonEnv = exports.Mode = exports.validateStringEnum = exports.privateKeyEnvVarLoader = exports.loadUntypedEnvs = exports.loadFileAndParseToObject = void 0;
const loadConfig_1 = require("./loadConfig");
const validateConfig_1 = require("./validateConfig");
var loadConfig_2 = require("./loadConfig");
Object.defineProperty(exports, "loadFileAndParseToObject", { enumerable: true, get: function () { return loadConfig_2.loadFileAndParseToObject; } });
Object.defineProperty(exports, "loadUntypedEnvs", { enumerable: true, get: function () { return loadConfig_2.loadUntypedEnvs; } });
Object.defineProperty(exports, "privateKeyEnvVarLoader", { enumerable: true, get: function () { return loadConfig_2.privateKeyEnvVarLoader; } });
var validateConfig_2 = require("./validateConfig");
Object.defineProperty(exports, "validateStringEnum", { enumerable: true, get: function () { return validateConfig_2.validateStringEnum; } });
var Mode;
(function (Mode) {
    Mode["LISTENER"] = "LISTENER";
    Mode["EXECUTOR"] = "EXECUTOR";
    Mode["BOTH"] = "BOTH";
})(Mode = exports.Mode || (exports.Mode = {}));
// assert CommonEnv is superset of CommonPluginEnv
let _x = {};
let loggingEnv = undefined;
let executorEnv = undefined;
let commonEnv = undefined;
let listenerEnv = undefined;
function getCommonEnv() {
    if (!commonEnv) {
        throw new Error("Tried to get CommonEnv but it does not exist. Has it been loaded yet?");
    }
    return commonEnv;
}
exports.getCommonEnv = getCommonEnv;
function getExecutorEnv() {
    if (!executorEnv) {
        throw new Error("Tried to get ExecutorEnv but it does not exist. Has it been loaded yet?");
    }
    return executorEnv;
}
exports.getExecutorEnv = getExecutorEnv;
function getListenerEnv() {
    if (!listenerEnv) {
        throw new Error("Tried to get ListenerEnv but it does not exist. Has it been loaded yet?");
    }
    return listenerEnv;
}
exports.getListenerEnv = getListenerEnv;
function loadRelayerEngineConfig(dir, mode, { privateKeyEnv = true } = {
    privateKeyEnv: true,
}) {
    return (0, loadConfig_1.loadUntypedEnvs)(dir, mode, { privateKeyEnv }).then(validateEnvs);
}
exports.loadRelayerEngineConfig = loadRelayerEngineConfig;
function transformEnvs({ mode, rawCommonEnv, rawListenerEnv, rawExecutorEnv, }) {
    return {
        mode,
        rawCommonEnv,
        rawListenerEnv,
        rawExecutorEnv: {
            ...rawExecutorEnv,
            privateKeys: (0, validateConfig_1.transformPrivateKeys)(rawExecutorEnv.privateKeys),
        },
    };
}
exports.transformEnvs = transformEnvs;
function validateEnvs(input) {
    console.log("Validating envs...");
    try {
        input = transformEnvs(input);
    }
    catch (e) { }
    commonEnv = (0, validateConfig_1.validateCommonEnv)(input.rawCommonEnv);
    if (input.rawExecutorEnv) {
        executorEnv = (0, validateConfig_1.validateExecutorEnv)(input.rawExecutorEnv, commonEnv.supportedChains.map(c => c.chainId));
    }
    if (input.rawListenerEnv) {
        listenerEnv = (0, validateConfig_1.validateListenerEnv)(input.rawListenerEnv);
    }
    console.log("Validated envs");
    return {
        executorEnv,
        listenerEnv,
        commonEnv,
    };
}
exports.validateEnvs = validateEnvs;
//# sourceMappingURL=index.js.map