import { DoublyLinkedList } from "@datastructures-js/linked-list";
import { RedisCommandRawReply } from "@node-redis/client/dist/lib/commands";
import { WatchError } from "redis";
import {
  Direction,
  HSETObject,
  IRedis,
  Multi,
  Op,
  RedisWrapper,
  WriteOp,
} from ".";
import { sleep } from "../utils/utils";

export class InMemory implements IRedis, RedisWrapper {
  locks: Record<string, { val: string | null }> = {};
  kv: Record<string, string> = {};
  hsets: Record<string, Map<string, string> | undefined> = {};
  lists: Record<string, DoublyLinkedList<string> | undefined> = {};
  sets: Record<string, { set: Set<string>; values: string[] }> = {};

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
      this.locks[key] = { val: this.kv[key] || null };
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

  async exists(key: string): Promise<boolean> {
    return !!(
      this.locks[key] ||
      this.kv[key] ||
      this.hsets[key] ||
      this.sets[key] ||
      this.lists[key]
    );
  }

  async hSet(key: string, fields: HSETObject): Promise<number>;
  async hSet(key: string, field: string, val: string): Promise<number>;
  async hSet(
    key: string,
    fields: string | HSETObject,
    val?: string,
  ): Promise<number> {
    if (!this.hsets[key]) {
      this.hsets[key] = new Map();
    }
    if (typeof fields === "string") {
      this.hsets[key]!.set(fields, val ?? "");
      return 1;
    }
    let updated = 0;
    for (const [field, val] of Object.entries(fields)) {
      this.hsets[key]!.set(field, val.toString());
      updated++;
    }
    return updated;
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hsets[key]?.get(field);
  }

  async hmGet(key: string, fields: string[]): Promise<(string | null)[]> {
    const obj = this.hsets[key];
    if (!obj) {
      return [];
    }

    const res = [];
    for (const field of fields) {
      res.push(obj.get(field) ?? null);
    }
    return res;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    const obj = Object.fromEntries(this.hsets[key]?.entries() ?? []);
    return obj;
  }

  async rPop(key: string): Promise<string | null> {
    return this.lists[key]?.removeLast()?.getValue() || null;
  }

  async lPush(key: string, val: string | string[]): Promise<number> {
    if (!this.lists[key]) {
      this.lists[key] = new DoublyLinkedList();
    }
    if (Array.isArray(val)) {
      for (const v of val) {
        this.lists[key]!.insertFirst(v);
      }
    } else {
      this.lists[key]!.insertFirst(val);
    }
    return this.lists[key]!.count() || 0;
  }

  async lIndex(key: string, ix: number): Promise<string | null> {
    return this.lists[key]?.toArray()[ix] ?? null;
  }

  async lLen(key: string): Promise<number> {
    return this.lists[key]?.count() ?? 0;
  }

  async lRem(key: string, count: number, element: string): Promise<number> {
    // in redis if you pass in 0 it removes every ocurrence
    count = count === 0 ? Number.MAX_VALUE : count;
    const old = this.lists[key]?.toArray();
    if (!old) {
      return 0;
    }
    const fresh = new DoublyLinkedList<string>();
    let removed = 0;
    for (const x of old) {
      if (x !== element || removed == count) {
        fresh.insertFirst(x);
      } else {
        removed++;
      }
    }
    this.lists[key] = fresh;
    return removed;
  }

  async zRem(key: string, elements: string | string[]): Promise<number> {
    if (!this.sets[key]) {
      return 0;
    }
    const { set, values } = this.sets[key];
    let removedCount = 0;
    let elementsRemoved: Record<string, boolean> = {};
    for (const element of elements) {
      const wasDeleted = set.delete(element);
      if (wasDeleted) {
        removedCount++;
        elementsRemoved[element] = true;
      }
    }
    const newValues = [];
    for (const value of values) {
      if (!elementsRemoved[value]) {
        newValues.push(value);
      }
    }
    this.sets[key] = { set, values: newValues };
    return removedCount;
  }

  async hIncrBy(
    key: string,
    field: string,
    amount: number = 1,
  ): Promise<number> {
    if (!this.hsets[key]) {
      this.hsets[key] = new Map<string, string>();
    }
    let currentValue = Number(this.hsets[key]!.get(field)) || 0;
    currentValue += amount;
    this.hsets[key]!.set(field, currentValue.toString());
    return currentValue;
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

  async blMove(
    source: string,
    destination: string,
    directionSource: Direction,
    directionDestination: Direction,
    timeoutInSeconds: number,
  ): Promise<string | null> {
    if (!this.lists[source]?.count()) {
      // TODO: realistically, we want to check every so often (up until timeout) to see if there's a new item.
      await sleep(timeoutInSeconds * 1000);
      if (!this.lists[source]?.count()) {
        return null;
      }
    }
    let item =
      directionSource == Direction.LEFT
        ? this.lists[source]?.removeFirst()
        : this.lists[source]?.removeLast();
    if (!item || !item.getValue()) {
      return null;
    }
    if (!this.lists[destination]) {
      this.lists[destination] = new DoublyLinkedList<string>();
    }
    if (directionDestination == Direction.LEFT) {
      this.lists[destination]!.insertFirst(item.getValue());
    } else {
      this.lists[destination]!.insertLast(item.getValue());
    }
    return item.getValue();
  }

  del(key: string): Promise<number> {
    return Promise.resolve(0);
  }

  async zAdd(
    key: string,
    elements: { value: string; score: number }[],
  ): Promise<number> {
    if (!this.sets[key]) {
      this.sets[key] = { set: new Set<string>(), values: [] };
    }
    let inserted = 0;
    for (const { value, score } of elements) {
      if (this.sets[key].set.has(value)) {
        continue;
      }
      this.sets[key].set.add(value);
      this.sets[key].values.push(`${score}:${value}`);
      inserted++;
    }
    return inserted;
  }

  async zRangeWithScores(
    key: string,
    start: number,
    end: number,
  ): Promise<{ value: string; score: number }[]> {
    if (!this.sets[key]) {
      return [];
    }
    return this.sets[key].values
      .slice(start, end)
      .sort()
      .map(strings => {
        const values = strings.split(":");
        return { score: Number(values[0]), value: values[1] };
      });
  }

  async pExpire(key: string, ms: number): Promise<boolean> {
    return true;
  }

  async lRange(key: string, start: number, end: number): Promise<string[]> {
    return this.lists[key]?.toArray().slice(start, end) ?? [];
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

  exists(key: string): Multi {
    return this.new(() => this.store.exists(key));
  }

  hDel(key: string, field: string): Multi {
    return this.new(() => this.store.hDel(key, field));
  }
  lPush(key: string, element: string): Multi {
    return this.new(() => this.store.lPush(key, element));
  }
  lRem(key: string, count: number, element: string): Multi {
    return this.new(() => this.store.lRem(key, count, element));
  }
  set(key: string, value: string): Multi {
    return this.new(async () => {
      if (
        this.store.locks[key] &&
        this.store.locks[key].val !== (await this.store.get(key))
      ) {
        throw new WatchError();
      }
      await this.store.set(key, value);
    });
  }
  async exec(pipeline: boolean = true): Promise<RedisCommandRawReply[]> {
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

  del(key: string): Multi {
    return this.new(() => this.store.del(key));
  }

  zAdd(key: string, elements: { value: string; score: number }[]): Multi {
    return this.new(() => this.store.zAdd(key, elements));
  }

  pExpire(key: string, ms: number): Multi {
    return this.new(() => this.store.pExpire(key, ms));
  }

  zRem(key: string, elements: string | string[]): Multi {
    return this.new(() => this.store.zRem(key, elements));
  }

  hGet(key: string, field: string): Multi {
    return this.new(() => this.store.hGet(key, field));
  }

  hmGet(key: string, fields: string[]): Multi {
    return this.new(() => this.store.hmGet(key, fields));
  }

  hIncrBy(key: string, field: string, amount: number): Multi {
    return this.new(() => this.store.hIncrBy(key, field, amount));
  }

  hSet(key: string, fields: HSETObject): Multi;
  hSet(key: string, field: string, val: string): Multi;
  hSet(key: string, fields: string | HSETObject, val?: string): Multi {
    if (typeof fields === "string") {
      return this.new(() => this.store.hSet(key, fields, val ?? ""));
    }
    return this.new(() => this.store.hSet(key, fields));
  }

  hGetAll(key: string): Multi {
    return this.new(() => this.store.hGetAll(key));
  }
}
