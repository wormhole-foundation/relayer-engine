import {
  ChainId,
  GuardianSignature,
  ParsedVaa,
  parseVaa,
} from "@certusone/wormhole-sdk";
import { FetchVaaFn } from "./context";
import { sleep } from "./utils";

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
  // non standard fields because we're dealing with synthetic batches and not headless vaas.
  transactionId: string;
  vaas: ParsedVaa[];
  vaaBytes: Buffer[];
};

interface VaaBundlerOpts {
  maxAttempts?: number;
  delayBetweenAttemptsInMs?: number;
}

const defaultOpts: VaaBundlerOpts = {
  maxAttempts: 10,
  delayBetweenAttemptsInMs: 1000,
};

export class VaaBundleBuilder {
  public vaaBytes: Record<string, Buffer>;
  private readonly fetchedVaas: Record<string, ParsedVaa>;
  private readonly pendingVaas: Record<string, VaaId>;
  public id: string;
  public emitterChain: ChainId;
  private opts: VaaBundlerOpts;
  constructor(
    public txHash: string,
    private vaaIds: VaaId[],
    private fetchVaa: FetchVaaFn,
    opts?: VaaBundlerOpts
  ) {
    this.opts = Object.assign({}, defaultOpts, opts);
    this.id = txHash;

    this.pendingVaas = {};
    for (const id of vaaIds) {
      this.pendingVaas[this.idToKey(id)] = id;
    }
    this.fetchedVaas = {};
    this.vaaBytes = {};
  }

  private idToKey = (id: VaaId) =>
    `${id.emitterChain}/${id.emitterAddress.toString(
      "hex"
    )}/${id.sequence.toString()}`;

  // returns true if all remaining vaas have been fetched, false otherwise
  async fetchPending(): Promise<boolean> {
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

    const vaas = fetched.filter((vaa) => vaa !== null && vaa.length > 0);
    this.addVaaPayloads(vaas);
    return this.isComplete;
  }

  addVaaPayload(vaaBytes: Buffer) {
    const parsedVaa = parseVaa(vaaBytes);
    const key = this.idToKey(parsedVaa);
    delete this.pendingVaas[key];
    this.fetchedVaas[key] = parsedVaa;
    this.vaaBytes[key] = vaaBytes;
  }

  /**
   * Adds a vaa payload to the builder. If this vaa was marked as pending, then it's moved to completed.
   * @param vaaBytesArr
   * @private
   */
  private addVaaPayloads(vaaBytesArr: Buffer[]) {
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
      vaaBytes: Object.values(this.vaaBytes).map((buffer) =>
        buffer.toString("base64")
      ),
      vaaIds: this.vaaIds,
      txHash: this.txHash,
    };
  }

  static deserialize(
    serialized: SerializedBatchBuilder,
    fetchVaa: FetchVaaFn
  ): VaaBundleBuilder {
    const vaaBytes = serialized.vaaBytes.map((str) =>
      Buffer.from(str, "base64")
    );
    const builder = new VaaBundleBuilder(
      serialized.txHash,
      serialized.vaaIds,
      fetchVaa
    );
    builder.addVaaPayloads(vaaBytes);
    return builder;
  }

  build(): VaaBundle {
    const vaas = Object.values(this.fetchedVaas);
    const vaaBytes = Object.values(this.vaaBytes);
    return {
      transactionId: this.txHash,
      vaas,
      vaaBytes,
    };
  }

  async then() {
    if (this.isComplete) {
      return this.build();
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
    return this.build();
  }
}
