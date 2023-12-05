import { describe, expect, it } from "@jest/globals";
import { mapConcurrent } from "../../relayer/utils.js";

describe("mapConcurrent", () => {
  it("should map when concurrency below array length", async () => {
    const items = [1, 2, 3, 4, 5];
    const expected = [1, 2, 3, 4, 5];
    const markers: number[] = [];

    await mapConcurrent(
      items,
      async (item: number) => markers.push(item),
      items.length - 2,
    );

    expect(markers).toEqual(expected);
  });

  it("should not affect input array", async () => {
    const items = [1, 2, 3, 4, 5, 6];
    const markers: number[] = [];

    await mapConcurrent(
      items,
      async (item: number) => markers.push(item),
      items.length / 2,
    );

    expect(items).toEqual(markers);
  });
});
