"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Storage = exports.StorageContext = void 0;
const bullmq_1 = require("bullmq");
const wormhole_sdk_1 = require("@certusone/wormhole-sdk");
const context_1 = require("./context");
function serializeVaa(vaa) {
    return {
        sequence: vaa.sequence.toString(),
        hash: vaa.hash.toString("base64"),
        emitterChain: vaa.emitterChain,
        emitterAddress: vaa.emitterAddress.toString("hex"),
        payload: vaa.payload.toString("base64"),
        nonce: vaa.nonce,
        timestamp: vaa.timestamp,
        version: vaa.version,
        guardianSignatures: vaa.guardianSignatures.map((sig) => ({
            signature: sig.signature.toString("base64"),
            index: sig.index,
        })),
        consistencyLevel: vaa.consistencyLevel,
        guardianSetIndex: vaa.guardianSetIndex,
    };
}
function deserializeVaa(vaa) {
    return {
        sequence: BigInt(vaa.sequence),
        hash: Buffer.from(vaa.hash, "base64"),
        emitterChain: vaa.emitterChain,
        emitterAddress: Buffer.from(vaa.emitterAddress, "hex"),
        payload: Buffer.from(vaa.payload, "base64"),
        nonce: vaa.nonce,
        timestamp: vaa.timestamp,
        version: vaa.version,
        guardianSignatures: vaa.guardianSignatures.map((sig) => ({
            signature: Buffer.from(sig.signature, "base64"),
            index: sig.index,
        })),
        consistencyLevel: vaa.consistencyLevel,
        guardianSetIndex: vaa.guardianSetIndex,
    };
}
class StorageContext extends context_1.Context {
    job;
}
exports.StorageContext = StorageContext;
class Storage {
    relayer;
    storageOptions;
    logger;
    vaaQueue;
    worker;
    prefix;
    constructor(relayer, storageOptions) {
        this.relayer = relayer;
        this.storageOptions = storageOptions;
        this.prefix = `{${storageOptions.namespace ?? storageOptions.queueName}}`;
        this.vaaQueue = new bullmq_1.Queue(storageOptions.queueName, {
            prefix: this.prefix,
        });
    }
    async addVaaToQueue(vaaBytes) {
        const parsedVaa = (0, wormhole_sdk_1.parseVaa)(vaaBytes);
        const id = this.vaaId(parsedVaa);
        const idWithoutHash = id.substring(0, id.length - 6);
        return this.vaaQueue.add(idWithoutHash, {
            parsedVaa: serializeVaa(parsedVaa),
            vaaBytes: vaaBytes.toString("base64"),
        }, {
            jobId: id,
            removeOnComplete: 1000,
            removeOnFail: 5000,
            attempts: this.storageOptions.attempts,
        });
    }
    vaaId(vaa) {
        const emitterAddress = vaa.emitterAddress.toString("hex");
        const hash = vaa.hash.toString("base64").substring(0, 5);
        let sequence = vaa.sequence.toString();
        return `${vaa.emitterChain}/${emitterAddress}/${sequence}/${hash}`;
    }
    startWorker() {
        this.worker = new bullmq_1.Worker(this.storageOptions.queueName, async (job) => {
            await job.log(`processing by..${this.worker.id}`);
            let vaaBytes = Buffer.from(job.data.vaaBytes, "base64");
            await this.relayer.handleVaa(vaaBytes, { job });
            await job.updateProgress(100);
            return [""];
        }, { prefix: this.prefix });
    }
}
exports.Storage = Storage;
//# sourceMappingURL=storage.js.map