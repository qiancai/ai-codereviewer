import { describe, expect, it } from "vitest";
import { findComparableGroups } from "./crosscheck";
import { Digest } from "../llm/schemas";

describe("findComparableGroups", () => {
  it("keeps only groups spanning 2+ distinct files", () => {
    const digest: Digest = {
      intent: "",
      files: [],
      claims: [
        { type: "default", name: "x", value: "1", file: "a.md", line: 1 },
        { type: "default", name: "x", value: "2", file: "b.md", line: 2 },
        { type: "default", name: "y", value: "1", file: "a.md", line: 3 },
        { type: "default", name: "y", value: "1", file: "a.md", line: 4 }, // same file
        { type: "term", name: "Z", value: "def", file: "b.md", line: 5 },
      ],
    };
    const groups = findComparableGroups(digest);
    expect(groups).toHaveLength(1);
    expect(groups[0][0].name).toBe("x");
  });

  it("matches names case-insensitively", () => {
    const digest: Digest = {
      intent: "",
      files: [],
      claims: [
        { type: "term", name: "TiDB", value: "a", file: "a.md", line: 1 },
        { type: "term", name: "tidb", value: "b", file: "b.md", line: 2 },
      ],
    };
    expect(findComparableGroups(digest)).toHaveLength(1);
  });
});
