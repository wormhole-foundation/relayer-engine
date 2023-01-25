"use strict";
/*
 * Loads config files and env vars, resolves them into untyped objects
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.privateKeyEnvVarLoader = exports.loadFileAndParseToObject = exports.loadUntypedEnvs = void 0;
const yaml = require("js-yaml");
const fs = require("fs");
const nodePath = require("path");
const _1 = require(".");
async function loadUntypedEnvs(dir, mode, { privateKeyEnv = false } = {
    privateKeyEnv: false,
}) {
    const rawCommonEnv = await loadCommon(dir, mode);
    rawCommonEnv.mode = mode;
    console.log("Successfully loaded the common config file.");
    const rawListenerEnv = await loadListener(dir, mode);
    const rawExecutorEnv = await loadExecutor(dir, mode, rawCommonEnv, privateKeyEnv);
    console.log("Successfully loaded the mode config file.");
    return {
        rawCommonEnv,
        rawListenerEnv,
        rawExecutorEnv,
        mode,
    };
}
exports.loadUntypedEnvs = loadUntypedEnvs;
async function loadCommon(dir, mode) {
    const obj = await loadFileAndParseToObject(`${dir}/common.json`);
    obj.mode = mode;
    return obj;
}
async function loadExecutor(dir, mode, rawCommonEnv, privateKeyEnv) {
    if (mode == _1.Mode.EXECUTOR || mode == _1.Mode.BOTH) {
        const rawExecutorEnv = await loadFileAndParseToObject(`${dir}/${_1.Mode.EXECUTOR.toLowerCase()}.json`);
        if (privateKeyEnv) {
            rawExecutorEnv.privateKeys = Object.assign(rawExecutorEnv.privateKeys, await privateKeyEnvVarLoader(rawCommonEnv.supportedChains.map(c => c.chainId)));
        }
        return rawExecutorEnv;
    }
    return undefined;
}
async function loadListener(dir, mode) {
    if (mode == _1.Mode.LISTENER || mode == _1.Mode.BOTH) {
        return await loadFileAndParseToObject(`${dir}/${_1.Mode.LISTENER.toLowerCase()}.json`);
    }
    return undefined;
}
// todo: extend to take path w/o extension and look for all supported extensions
async function loadFileAndParseToObject(path) {
    console.log("About to read contents of : " + path);
    const fileContent = fs.readFileSync(path, { encoding: "utf-8" });
    console.log("Successfully read file contents");
    const ext = nodePath.extname(path);
    switch (ext) {
        case ".json":
            return JSON.parse(fileContent);
        case ".yaml":
            return yaml.load(fileContent, {
                schema: yaml.JSON_SCHEMA,
            });
        case ".yml":
            return yaml.load(fileContent, {
                schema: yaml.JSON_SCHEMA,
            });
        default:
            const err = new Error("Config file has unsupported extension");
            err.ext = ext;
            err.path = path;
            throw err;
    }
}
exports.loadFileAndParseToObject = loadFileAndParseToObject;
// Helper to parse private keys from env vars.
// For Solana format is PRIVATE_KEYS_CHAIN_1 => [ 14, 173, 153, ... ]
// For ETH format is PRIVATE_KEYS_CHAIN_2 =>  ["0x4f3 ..."]
function privateKeyEnvVarLoader(chains) {
    const pkeys = {};
    for (const chain of chains) {
        const str = process.env[`PRIVATE_KEYS_CHAIN_${chain}`];
        if (!str) {
            console.log(`No PRIVATE_KEYS_CHAIN_${chain} env var, falling back to executor.json`);
            continue;
        }
        pkeys[chain] = JSON.parse(str);
    }
    return pkeys;
}
exports.privateKeyEnvVarLoader = privateKeyEnvVarLoader;
//# sourceMappingURL=loadConfig.js.map