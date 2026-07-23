import { describe, expect, it } from "vitest";
import { mapPool } from "./pool";

describe("mapPool", () => {
  it("preserves order and processes every item", async () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const out = await mapPool(input, 4, async (n) => {
      await new Promise((r) => setTimeout(r, Math.random() * 10));
      return n * 2;
    });
    expect(out).toEqual(input.map((n) => n * 2));
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const input = Array.from({ length: 15 }, (_, i) => i);
    await mapPool(input, 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles an empty input", async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
  });
});
