import { DoublyLinkedList } from "@datastructures-js/linked-list";
import { Direction, IRedis, Multi, Op, RedisWrapper, WriteOp } from ".";
export declare class InMemory implements IRedis, RedisWrapper {
    locks: Record<string, {
        val: string | null;
    }>;
    kv: Record<string, string>;
    hsets: Record<string, Map<string, string> | undefined>;
    lists: Record<string, DoublyLinkedList<string> | undefined>;
    sets: Record<string, {
        set: Set<string>;
        values: string[];
    }>;
    withRedis<T>(op: Op<T>): Promise<T>;
    runOpWithRetry(op: WriteOp): Promise<void>;
    multi(): Multi;
    watch(keys: string | string[]): Promise<string>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<string>;
    unwatch(): Promise<string>;
    hLen(key: string): Promise<number>;
    hSet(key: string, field: string, val: string): Promise<number>;
    hGet(key: string, field: string): Promise<string | undefined>;
    rPop(key: string): Promise<string | null>;
    lPush(key: string, val: string | string[]): Promise<number>;
    lIndex(key: string, ix: number): Promise<string | null>;
    lLen(key: string): Promise<number>;
    lRem(key: string, count: number, element: string): Promise<number>;
    zRem(key: string, elements: string | string[]): Promise<number>;
    hDel(key: string, field: string): Promise<number>;
    hKeys(key: string): Promise<string[]>;
    executeIsolated<T>(fn: (redis: IRedis) => Promise<T>): Promise<T>;
    blMove(source: string, destination: string, directionSource: Direction, directionDestination: Direction, timeoutInSeconds: number): Promise<string | null>;
    del(key: string): Promise<number>;
    zAdd(key: string, elements: {
        value: string;
        score: number;
    }[]): Promise<number>;
    zRangeWithScores(key: string, start: number, end: number): Promise<{
        value: string;
        score: number;
    }[]>;
}
