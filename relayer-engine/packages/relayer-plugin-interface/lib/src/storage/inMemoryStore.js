"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemory = void 0;
const linked_list_1 = require("@datastructures-js/linked-list");
const redis_1 = require("redis");
const _1 = require(".");
const utils_1 = require("../utils/utils");
class InMemory {
    locks = {};
    kv = {};
    hsets = {};
    lists = {};
    sets = {};
    // don't need to do anything fancy since there is only 1 "connection" to the in memory store
    async withRedis(op) {
        return await op(this);
    }
    // again no connection to fail, so reduces to just always succeeding
    async runOpWithRetry(op) {
        await op(this);
    }
    multi() {
        return new InMemoryMulti(this);
    }
    async watch(keys) {
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
    async get(key) {
        return this.kv[key] || null;
    }
    async set(key, value) {
        this.kv[key] = value;
        return "OK";
    }
    async unwatch() {
        this.locks = {};
        return "OK";
    }
    async hLen(key) {
        return this.hsets[key]?.size || 0;
    }
    async hSet(key, field, val) {
        if (!this.hsets[key]) {
            this.hsets[key] = new Map();
        }
        this.hsets[key].set(field, val);
        return 1;
    }
    async hGet(key, field) {
        return this.hsets[key]?.get(field);
    }
    async rPop(key) {
        return this.lists[key]?.removeLast()?.getValue() || null;
    }
    async lPush(key, val) {
        if (!this.lists[key]) {
            this.lists[key] = new linked_list_1.DoublyLinkedList();
        }
        if (Array.isArray(val)) {
            for (const v of val) {
                this.lists[key].insertFirst(v);
            }
        }
        else {
            this.lists[key].insertFirst(val);
        }
        return this.lists[key].count() || 0;
    }
    async lIndex(key, ix) {
        return this.lists[key]?.toArray()[ix] ?? null;
    }
    async lLen(key) {
        return this.lists[key]?.count() ?? 0;
    }
    async lRem(key, count, element) {
        // in redis if you pass in 0 it removes every ocurrence
        count = count === 0 ? Number.MAX_VALUE : count;
        const old = this.lists[key]?.toArray();
        if (!old) {
            return 0;
        }
        const fresh = new linked_list_1.DoublyLinkedList();
        let removed = 0;
        for (const x of old) {
            if (x !== element || removed == count) {
                fresh.insertFirst(x);
            }
            else {
                removed++;
            }
        }
        this.lists[key] = fresh;
        return removed;
    }
    async zRem(key, elements) {
        if (!this.sets[key]) {
            return 0;
        }
        const { set, values } = this.sets[key];
        let removedCount = 0;
        let elementsRemoved = {};
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
    async hDel(key, field) {
        return this.hsets[key]?.delete(field) ? 1 : 0;
    }
    async hKeys(key) {
        return Array.from(this.hsets[key]?.keys() || []);
    }
    async executeIsolated(fn) {
        return fn(this);
    }
    async blMove(source, destination, directionSource, directionDestination, timeoutInSeconds) {
        if (!this.lists[source]?.count()) {
            // TODO: realistically, we want to check every so often (up until timeout) to see if there's a new item.
            await (0, utils_1.sleep)(timeoutInSeconds * 1000);
            if (!this.lists[source]?.count()) {
                return null;
            }
        }
        let item = directionSource == _1.Direction.LEFT
            ? this.lists[source]?.removeFirst()
            : this.lists[source]?.removeLast();
        if (!item || !item.getValue()) {
            return null;
        }
        if (!this.lists[destination]) {
            this.lists[destination] = new linked_list_1.DoublyLinkedList();
        }
        if (directionDestination == _1.Direction.LEFT) {
            this.lists[destination].insertFirst(item.getValue());
        }
        else {
            this.lists[destination].insertLast(item.getValue());
        }
        return item.getValue();
    }
    del(key) {
        return Promise.resolve(0);
    }
    async zAdd(key, elements) {
        if (!this.sets[key]) {
            this.sets[key] = { set: new Set(), values: [] };
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
    async zRangeWithScores(key, start, end) {
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
}
exports.InMemory = InMemory;
class InMemoryMulti {
    store;
    ops;
    constructor(store, ops = []) {
        this.store = store;
        this.ops = ops;
    }
    new(op) {
        return new InMemoryMulti(this.store, [...this.ops, op]);
    }
    hDel(key, field) {
        return this.new(() => this.store.hDel(key, field));
    }
    lPush(key, element) {
        return this.new(() => this.store.lPush(key, element));
    }
    lRem(key, count, element) {
        return this.new(() => this.store.lRem(key, count, element));
    }
    set(key, value) {
        return this.new(async () => {
            if (this.store.locks[key] &&
                this.store.locks[key].val !== (await this.store.get(key))) {
                throw new redis_1.WatchError();
            }
            await this.store.set(key, value);
        });
    }
    async exec(pipeline = true) {
        try {
            await Promise.all(this.ops.map(op => op()));
        }
        catch (e) {
            await this.store.unwatch();
            throw e;
        }
        // todo: make this more like real redis?
        await this.store.unwatch();
        return [];
    }
    del(key) {
        return this.new(() => this.store.del(key));
    }
    zAdd(key, elements) {
        return this.new(() => this.store.zAdd(key, elements));
    }
    zRem(key, elements) {
        return this.new(() => this.store.zRem(key, elements));
    }
    hGet(key, field) {
        return this.new(() => this.store.hGet(key, field));
    }
    hSet(key, field, val) {
        return this.new(() => this.store.hSet(key, field, val));
    }
}
//# sourceMappingURL=inMemoryStore.js.map