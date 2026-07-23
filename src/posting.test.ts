import { describe, expect, it } from "vitest";
import {
  dedupeAgainstExisting,
  dedupeWithinBatch,
  formatBody,
  validateFindings,
} from "./posting";
import { CommentableLines } from "./context";
import { Finding } from "./types";

function finding(overrides: Partial<Finding>): Finding {
  return {
    path: "docs/a.md",
    line: 10,
    severity: "medium",
    category: "clarity",
    comment: "c",
    source: "llm",
    ...overrides,
  };
}

describe("formatBody", () => {
  it("includes severity, category and suggestion block", () => {
    const body = formatBody(finding({ suggestion: "better text" }));
    expect(body).toContain("[medium · clarity]");
    expect(body).toContain("````suggestion\nbetter text\n````");
  });

  it("omits the suggestion block when absent", () => {
    expect(formatBody(finding({}))).not.toContain("suggestion");
  });
});

describe("dedupeWithinBatch", () => {
  it("keeps the highest severity on the same path+line", () => {
    const { unique, dropped } = dedupeWithinBatch([
      finding({ severity: "low", comment: "low one" }),
      finding({ severity: "high", comment: "high one" }),
      finding({ line: 99, comment: "other line" }),
    ]);
    expect(unique).toHaveLength(2);
    expect(unique.find((f) => f.line === 10)?.comment).toBe("high one");
    expect(dropped).toHaveLength(1);
  });
});

describe("dedupeAgainstExisting", () => {
  it("drops findings already posted by a bot on the same line", () => {
    const { unique, dropped } = dedupeAgainstExisting(
      [finding({ line: 10 }), finding({ line: 11 })],
      [{ path: "docs/a.md", line: 10, body: "old", isBot: true }]
    );
    expect(unique.map((f) => f.line)).toEqual([11]);
    expect(dropped).toHaveLength(1);
  });

  it("ignores human comments", () => {
    const { unique } = dedupeAgainstExisting(
      [finding({ line: 10 })],
      [{ path: "docs/a.md", line: 10, body: "human", isBot: false }]
    );
    expect(unique).toHaveLength(1);
  });
});

describe("validateFindings", () => {
  const commentable = new Map<string, CommentableLines>([
    [
      "docs/a.md",
      { commentable: new Set([10, 11, 12, 20]), added: new Set([11, 12, 20]) },
    ],
  ]);

  it("keeps commentable lines as-is", () => {
    const out = validateFindings([finding({ line: 10 })], commentable);
    expect(out.comments[0].line).toBe(10);
    expect(out.degraded).toHaveLength(0);
  });

  it("remaps near-miss lines to the closest added line", () => {
    const out = validateFindings([finding({ line: 19 })], commentable);
    expect(out.comments[0].line).toBe(20);
  });

  it("degrades unmappable findings instead of emitting bad lines", () => {
    const out = validateFindings([finding({ line: 500 })], commentable);
    expect(out.comments).toHaveLength(0);
    expect(out.degraded).toHaveLength(1);
  });

  it("degrades findings on files outside the diff", () => {
    const out = validateFindings([finding({ path: "other.md" })], commentable);
    expect(out.degraded).toHaveLength(1);
  });

  it("builds multi-line comments for endLine ranges", () => {
    const out = validateFindings(
      [finding({ line: 10, endLine: 12, suggestion: "range" })],
      commentable
    );
    expect(out.comments[0]).toMatchObject({
      line: 12,
      start_line: 10,
      start_side: "RIGHT",
    });
  });

  it("falls back to single-line when endLine is not commentable", () => {
    const out = validateFindings(
      [finding({ line: 10, endLine: 99, suggestion: "range" })],
      commentable
    );
    expect(out.comments[0].start_line).toBeUndefined();
  });
});
