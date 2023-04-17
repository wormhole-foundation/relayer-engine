import { ChainId, ParsedVaa } from "@certusone/wormhole-sdk";
import { FetchVaaFn } from "./context";
import { EngineError, parseVaaWithBytes, sleep } from "./utils";
import { ParsedVaaWithBytes } from "./application";

export type VaaId = {
  emitterChain: ParsedVaa["emitterChain"];
  emitterAddress: ParsedVaa["emitterAddress"];
  sequence: ParsedVaa["sequence"];
};

export type SerializedBatchFetcher = {
  vaaBytes: string[];
  vaaIds: VaaId[];
};

// You can pass in an array of vaaIds (chain, addr, seq) or a txHash.
// If you pass in a hash, go to the blockchain, read logs and transform into array of ids
// then fetch the vaas corresponding to those ids
interface VaaBundlerOpts {
  maxAttempts?: number;
  delayBetweenAttemptsInMs?: number;
  vaaIds: VaaId[];
}

const defaultOpts: Omit<VaaBundlerOpts, "vaaIds"> = {
  maxAttempts: 10,
  delayBetweenAttemptsInMs: 1000,
};

export class VaaBundleFetcher {
  private readonly fetchedVaas: Record<string, ParsedVaaWithBytes> = {};
  private readonly pendingVaas: Record<string, VaaId> = {};
  private readonly fetchErrors: Record<string, Error> = {};
  private opts: VaaBundlerOpts;

  constructor(private fetchVaa: FetchVaaFn, opts?: VaaBundlerOpts) {
    this.opts = Object.assign({}, defaultOpts, opts);

    for (const id of this.opts.vaaIds) {
      this.pendingVaas[this.idToKey(id)] = id;
    }
  }

  private idToKey = (id: VaaId) =>
    `${id.emitterChain}/${id.emitterAddress.toString(
      "hex",
    )}/${id.sequence.toString()}`;

  // returns true if all remaining vaas have been fetched, false otherwise
  private async fetchPending(): Promise<boolean> {
    if (this.isComplete) {
      return true;
    }
    const fetched = await Promise.all(
      Object.values(this.pendingVaas).map(async id => {
        try {
          return await this.fetchVaa(
            id.emitterChain as ChainId,
            id.emitterAddress,
            id.sequence,
          );
        } catch (e) {
          this.fetchErrors[this.idToKey(id)] = e;
          return null;
        }
      }),
    );

    const vaas = fetched.filter(vaa => vaa !== null);
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

  serialize(): SerializedBatchFetcher {
    return {
      vaaBytes: Object.values(this.fetchedVaas).map(parsedVaas =>
        parsedVaas.bytes.toString("base64"),
      ),
      vaaIds: this.opts.vaaIds,
    };
  }

  static deserialize(
    serialized: SerializedBatchFetcher,
    fetchVaa: FetchVaaFn,
  ): VaaBundleFetcher {
    const vaaBytes = serialized.vaaBytes.map(str => Buffer.from(str, "base64"));
    const builder = new VaaBundleFetcher(fetchVaa, {
      vaaIds: serialized.vaaIds,
    });
    const parsedVaasWithBytes = vaaBytes.map(buf => parseVaaWithBytes(buf));
    builder.addVaaPayloads(parsedVaasWithBytes);
    return builder;
  }

  private export(): ParsedVaaWithBytes[] {
    return Object.values(this.fetchedVaas);
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
      throw new EngineError("could not fetch all vaas", {
        fetchErrors: this.fetchErrors,
      }) as any;
    }
    return this.export();
  }
}
