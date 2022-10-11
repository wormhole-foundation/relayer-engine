import { Queue } from "@datastructures-js/queue";
import { KVStore, QueueStore, Store } from ".";

export class InMemoryKVStore<V> implements KVStore<V> {
  kv: Map<string, V>;
  constructor() {
    this.kv = new Map();
  }

  async keys(): Promise<AsyncIterable<string>> {
    const kv = this.kv;
    return {
      async *[Symbol.asyncIterator]() {
        for (const key of kv.keys()) {
          yield key;
        }
      },
    };
  }

  async set(key: string, value: V): Promise<void> {
    this.kv.set(key, value);
  }

  async get(key: string): Promise<V | undefined> {
    return this.kv.get(key);
  }

  async delete(key: string): Promise<boolean> {
    return this.kv.delete(key);
  }

  async compareAndSwap(
    key: string,
    expectedValue: V | undefined,
    newValue: V
  ): Promise<boolean> {
    if (this.kv.get(key) != expectedValue) {
      return false;
    }
    this.kv.set(key, newValue);
    return true;
  }
}

export class InMemoryQueueStore<Q> implements QueueStore<Q> {
  queue: Queue<Q>;

  constructor() {
    this.queue = new Queue();
  }
  async push(value: Q): Promise<void> {
    this.queue.push(value);
  }
  async pop(): Promise<Q> {
    return this.queue.pop();
  }
  async length(): Promise<number> {
    return this.queue.size();
  }
}

export class InMemoryStore implements Store {
  queues: Map<string, InMemoryQueueStore<any>>;
  kvs: Map<string, InMemoryKVStore<any>>;

  constructor() {
    this.kvs = new Map();
    this.queues = new Map();
  }
  queue<Q>(prefix?: string | undefined): QueueStore<Q> {
    const key = prefix ? prefix : "__default";
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new InMemoryQueueStore();
      this.queues.set(key, queue);
    }
    return queue;
  }
  kv<V>(prefix?: string): InMemoryKVStore<V> {
    const key = prefix ? prefix : "__default";
    let kv = this.kvs.get(key);
    if (!kv) {
      kv = new InMemoryKVStore();
      this.kvs.set(key, kv);
    }
    return kv;
  }
}
