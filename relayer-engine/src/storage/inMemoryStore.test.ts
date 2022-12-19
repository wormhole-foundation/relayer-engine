import { WatchError } from "redis";
import { dbg } from "../helpers/logHelper";
import { InMemory } from "./inMemoryStore";

describe("Basic in memory tests for storage", () => {
  const key1 = "key1";
  const key2 = "key2";
  const one = "one";
  const two = "two";
  const three = "three";

  test("basic kv ops", async () => {
    const store = new InMemory();
    await store.set(key1, one);
    expect(await store.get(key1)).toBe(one);

    await store.set(key1, two);
    expect(await store.get(key1)).toBe(two);

    expect(await store.get(key2)).toBe(null);
  });

  test("basic hash map ops", async () => {
    const hKey = "hKey";
    const store = new InMemory();

    expect(await store.hGet(hKey, key1)).toBe(undefined);
    expect(await store.hKeys(hKey)).toStrictEqual([]);
    expect(await store.hDel(hKey, key1)).toBe(0);
    expect(await store.hSet(hKey, key1, one)).toBe(1);
    expect(await store.hGet(hKey, key1)).toBe(one);
    expect(await store.hLen(hKey)).toBe(1);
    expect(await store.hKeys(hKey)).toStrictEqual([key1]);
    expect(await store.hSet(hKey, key2, one)).toBe(1);
    expect(await store.hKeys(hKey)).toStrictEqual([key1, key2]);
    expect(await store.hDel(hKey, key2)).toBe(1);
    expect(await store.hSet("other key", key1, two)).toBe(1);
    expect(await store.hSet(hKey, key1, two)).toBe(1);
    expect(await store.hGet(hKey, key1)).toBe(two);
    expect(await store.hLen(hKey)).toBe(1);
  });

  test("basic list ops", async () => {
    const store = new InMemory();

    expect(await store.rPop(key1)).toBe(null);
    expect(await store.lPush(key1, one)).toBe(1);
    expect(await store.lPush(key1, two)).toBe(2);
    expect(await store.rPop(key1)).toBe(one);
    expect(await store.rPop(key1)).toBe(two);
    expect(await store.rPop(key1)).toBe(null);

    expect(await store.lPush(key2, one)).toBe(1);
    expect(await store.lPush(key2, two)).toBe(2);
    expect(await store.lPush(key2, one)).toBe(3);
    expect(await store.lPush(key2, one)).toBe(4);
    expect(await store.lRem(key2, 2, one)).toBe(2);
    expect(await store.rPop(key2)).toBe(two);
    expect(await store.rPop(key2)).toBe(one);
  });

  test("multi", async () => {
    const store = new InMemory();

    expect(await store.set(key1, one)).toBe("OK");
    expect(await store.watch(key1)).toBe("OK");
    await store.multi().set(key1, two).exec();
    expect(await store.get(key1)).toBe(two);

    expect(await store.watch(key1)).toBe("OK");
    expect(await store.set(key1, one)).toBe("OK");
    await expect(store.multi().set(key1, three).exec()).rejects.toThrow(
      WatchError,
    );
    expect(await store.get(key1)).toBe(one);

    expect(await store.watch(key1)).toBe("OK");
    expect(await store.set(key1, two)).toBe("OK");
    await expect(
      store.multi().set(key1, three).lPush(key2, one).hDel("key3", one).exec(),
    ).rejects.toThrow(WatchError);
    expect(await store.get(key1)).toBe(two);

    expect(await store.watch(key1)).toBe("OK");
    await expect(
      store.multi().set(key1, three).lPush(key2, one).hDel("key3", one).exec(),
    ).resolves.toStrictEqual([]);
    expect(await store.get(key1)).toBe(three);
    expect(await store.rPop(key2)).toBe(one);
  });
});
