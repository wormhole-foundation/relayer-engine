"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaaBundleBuilder = void 0;
const utils_1 = require("./utils");
const defaultOpts = {
    maxAttempts: 10,
    delayBetweenAttemptsInMs: 1000,
};
class VaaBundleBuilder {
    fetchVaa;
    fetchedVaas;
    pendingVaas;
    opts;
    constructor(fetchVaa, opts) {
        this.fetchVaa = fetchVaa;
        this.opts = Object.assign({}, defaultOpts, opts);
        this.pendingVaas = {};
        for (const id of this.opts.vaaIds) {
            this.pendingVaas[this.idToKey(id)] = id;
        }
        this.fetchedVaas = {};
    }
    idToKey = (id) => `${id.emitterChain}/${id.emitterAddress.toString("hex")}/${id.sequence.toString()}`;
    // returns true if all remaining vaas have been fetched, false otherwise
    async fetchPending() {
        if (this.isComplete) {
            return true;
        }
        const fetched = await Promise.all(Object.values(this.pendingVaas).map(async ({ emitterChain, emitterAddress, sequence }) => {
            try {
                return await this.fetchVaa(emitterChain, emitterAddress, sequence);
            }
            catch (e) {
                return null;
            }
        }));
        const vaas = fetched.filter((vaa) => vaa !== null);
        this.addVaaPayloads(vaas);
        return this.isComplete;
    }
    addVaaPayload(parsedVaa) {
        const key = this.idToKey(parsedVaa);
        delete this.pendingVaas[key];
        this.fetchedVaas[key] = parsedVaa;
    }
    /**
     * Adds a vaa payload to the builder. If this vaa was marked as pending, then it's moved to completed.
     * @param vaaBytesArr
     * @private
     */
    addVaaPayloads(vaaBytesArr) {
        for (const vaaBytes of vaaBytesArr) {
            this.addVaaPayload(vaaBytes);
        }
    }
    get isComplete() {
        const pendingCount = Object.keys(this.pendingVaas).length;
        return pendingCount === 0;
    }
    get pctComplete() {
        const fetchedCount = Object.keys(this.fetchedVaas).length;
        const pendingCount = Object.keys(this.pendingVaas).length;
        return Math.floor(fetchedCount / (fetchedCount + pendingCount)) * 100;
    }
    serialize() {
        return {
            vaaBytes: Object.values(this.fetchedVaas).map((parsedVaas) => parsedVaas.bytes.toString("base64")),
            vaaIds: this.opts.vaaIds,
            txHash: this.opts.txHash,
        };
    }
    static deserialize(serialized, fetchVaa) {
        const vaaBytes = serialized.vaaBytes.map((str) => Buffer.from(str, "base64"));
        const builder = new VaaBundleBuilder(fetchVaa, {
            vaaIds: serialized.vaaIds,
            txHash: serialized.txHash,
        });
        const parsedVaasWithBytes = vaaBytes.map((buf) => (0, utils_1.parseVaaWithBytes)(buf));
        builder.addVaaPayloads(parsedVaasWithBytes);
        return builder;
    }
    export() {
        const vaas = Object.values(this.fetchedVaas);
        return {
            transactionId: this.opts.txHash,
            vaas,
        };
    }
    async build() {
        if (this.isComplete) {
            return this.export();
        }
        let complete = await this.fetchPending();
        let attempts = 0;
        while (!complete && attempts < this.opts.maxAttempts) {
            await (0, utils_1.sleep)(this.opts.maxAttempts);
            complete = await this.fetchPending();
        }
        if (!complete) {
            throw new Error("could not fetch all vaas");
        }
        return this.export();
    }
}
exports.VaaBundleBuilder = VaaBundleBuilder;
//# sourceMappingURL=bundle-builder.helper.js.map