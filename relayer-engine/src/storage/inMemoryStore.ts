import { Queue } from "@datastructures-js/queue";
import { RedisCommandRawReply } from "@node-redis/client/dist/lib/commands";
import { Mutex } from "async-mutex";
import { WatchError } from "redis";
import { IRedis, Multi, Op, RedisWrapper, WriteOp } from ".";
import { dbg } from "../helpers/logHelper";

export class InMemory implements IRedis, RedisWrapper {
  locks: Record<string, string | null> = {};
  kv: Record<string, string> = {};
  hsets: Record<string, Map<string, string> | undefined> = {};
  lists: Record<string, Queue<string> | undefined> = {};

  // don't need to do anything fancy since there is only 1 "connection" to the in memory store
  async withRedis<T>(op: Op<T>): Promise<T> {
    return await op(this);
  }

  // again no connection to fail, so reduces to just always succeeding
  async runOpWithRetry(op: WriteOp): Promise<void> {
    await op(this);
  }

  multi(): Multi {
    return new InMemoryMulti(this);
  }
  async watch(keys: string | string[]): Promise<string> {
    if (typeof keys == "string") {
      keys = [keys];
    }
    for (const key of keys) {
      const val = this.locks[key];
      if (val) {
        throw new Error("Watching already watched key");
      }
      this.locks[key] = this.kv[key];
    }
    return "OK";
  }
  async get(key: string): Promise<string | null> {
    return this.kv[key] || null;
  }
  async set(key: string, value: string): Promise<string> {
    this.kv[key] = value;
    return "OK";
  }
  async unwatch(): Promise<string> {
    this.locks = {};
    return "OK";
  }
  async hLen(key: string): Promise<number> {
    return this.hsets[key]?.size || 0;
  }
  async hSet(key: string, field: string, val: string): Promise<number> {
    if (!this.hsets[key]) {
      this.hsets[key] = new Map();
    }
    this.hsets[key]!.set(field, val);
    return 1;
  }
  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hsets[key]?.get(field);
  }

  async rPop(key: string): Promise<string | null> {
    return this.lists[key]?.pop() || null;
  }
  async lPush(key: string, val: string): Promise<number> {
    if (!this.lists[key]) {
      this.lists[key] = new Queue();
    }
    this.lists[key]!.push(val);
    return this.lists[key]?.size() || 0;
  }
  async hDel(key: string, field: string): Promise<number> {
    return this.hsets[key]?.delete(field) ? 1 : 0;
  }
  async hKeys(key: string): Promise<string[]> {
    return Array.from(this.hsets[key]?.keys() || []);
  }
  async executeIsolated<T>(fn: (redis: IRedis) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

class InMemoryMulti implements Multi {
  constructor(
    private store: InMemory,
    private ops: (() => Promise<any>)[] = [],
  ) {}

  protected new(op: () => Promise<any>): InMemoryMulti {
    return new InMemoryMulti(this.store, [...this.ops, op]);
  }

  hDel(key: string, field: string): Multi {
    return this.new(() => this.store.hDel(key, field));
  }
  lPush(key: string, element: string): Multi {
    return this.new(() => this.store.lPush(key, element));
  }
  set(key: string, value: string): Multi {
    return this.new(async () => {
      if (
        this.store.locks[key] &&
        this.store.locks[key] !== (await this.store.get(key))
      ) {
        throw new WatchError();
      }
      await this.store.set(key, value);
    });
  }
  async exec(pipeline: boolean = false): Promise<RedisCommandRawReply[]> {
    try {
      await Promise.all(this.ops.map(op => op()));
    } catch (e) {
      await this.store.unwatch();
      throw e;
    }
    // todo: make this more like real redis?
    await this.store.unwatch();
    return [];
  }
}
