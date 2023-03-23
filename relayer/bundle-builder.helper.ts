import {
  ChainId,
  GuardianSignature,
  ParsedVaa,
  parseVaa,
  SignedVaa,
} from "@certusone/wormhole-sdk";
import { FetchVaaFn } from "./context";
import { parseVaaWithBytes, sleep } from "./utils";
import { ParsedVaaWithBytes } from "./application";

export type VaaId = {
  emitterChain: ParsedVaa["emitterChain"];
  emitterAddress: ParsedVaa["emitterAddress"];
  sequence: ParsedVaa["sequence"];
};

export type SerializedBatchBuilder = {
  vaaBytes: string[];
  vaaIds: VaaId[];
  txHash: string;
};

export type VaaBundle = {
  transactionId?: string;
  vaas: ParsedVaaWithBytes[];
};

// You can pass in an array of vaaIds (chain, addr, seq) or a txHash.
// If you pass in a hash, go to the blockchain, read logs and transform into array of ids
// then fetch the vaas corresponding to those ids
interface VaaBundlerOpts {
  maxAttempts?: number;
  delayBetweenAttemptsInMs?: number;
  vaaIds?: VaaId[];
  txHash?: string;
}

const defaultOpts: VaaBundlerOpts = {
  maxAttempts: 10,
  delayBetweenAttemptsInMs: 1000,
};

export class VaaBundleBuilder {
  private readonly fetchedVaas: Record<string, ParsedVaaWithBytes>;
  private readonly pendingVaas: Record<string, VaaId>;
  private opts: VaaBundlerOpts;

  constructor(private fetchVaa: FetchVaaFn, opts?: VaaBundlerOpts) {
    this.opts = Object.assign({}, defaultOpts, opts);

    this.pendingVaas = {};
    for (const id of this.opts.vaaIds) {
      this.pendingVaas[this.idToKey(id)] = id;
    }
    this.fetchedVaas = {};
  }

  private idToKey = (id: VaaId) =>
    `${id.emitterChain}/${id.emitterAddress.toString(
      "hex"
    )}/${id.sequence.toString()}`;

  // returns true if all remaining vaas have been fetched, false otherwise
  private async fetchPending(): Promise<boolean> {
    if (this.isComplete) {
      return true;
    }
    const fetched = await Promise.all(
      Object.values(this.pendingVaas).map(
        async ({ emitterChain, emitterAddress, sequence }) => {
          try {
            return await this.fetchVaa(
              emitterChain as ChainId,
              emitterAddress,
              sequence
            );
          } catch (e) {
            return null;
          }
        }
      )
    );

    const vaas = fetched.filter((vaa) => vaa !== null);
    this.addVaaPayloads(vaas);
    return this.isComplete;
  }

  addVaaPayload(parsedVaa: ParsedVaaWithBytes) {
    const key = this.idToKey(parsedVaa);
    delete this.pendingVaas[key];
    this.fetchedVaas[key] = parsedVaa;
  }

  /**
   * Adds a vaa payload to the builder. If this vaa was marked as pending, then it's moved to completed.
   * @param vaaBytesArr
   * @private
   */
  private addVaaPayloads(vaaBytesArr: ParsedVaaWithBytes[]) {
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

  serialize(): SerializedBatchBuilder {
    return {
      vaaBytes: Object.values(this.fetchedVaas).map((parsedVaas) =>
        parsedVaas.bytes.toString("base64")
      ),
      vaaIds: this.opts.vaaIds,
      txHash: this.opts.txHash,
    };
  }

  static deserialize(
    serialized: SerializedBatchBuilder,
    fetchVaa: FetchVaaFn
  ): VaaBundleBuilder {
    const vaaBytes = serialized.vaaBytes.map((str) =>
      Buffer.from(str, "base64")
    );
    const builder = new VaaBundleBuilder(fetchVaa, {
      vaaIds: serialized.vaaIds,
      txHash: serialized.txHash,
    });
    const parsedVaasWithBytes = vaaBytes.map((buf) => parseVaaWithBytes(buf));
    builder.addVaaPayloads(parsedVaasWithBytes);
    return builder;
  }

  private export(): VaaBundle {
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
      await sleep(this.opts.maxAttempts);
      complete = await this.fetchPending();
    }
    if (!complete) {
      throw new Error("could not fetch all vaas");
    }
    return this.export();
  }
}
