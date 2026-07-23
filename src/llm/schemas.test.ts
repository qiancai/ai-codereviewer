import { describe, expect, it } from "vitest";
import {
  validateDigest,
  validateInconsistencies,
  validateReviews,
  validateVerdicts,
} from "./schemas";

describe("validateReviews", () => {
  it("accepts the current schema", () => {
    const out = validateReviews(
      {
        reviews: [
          {
            line: 42,
            end_line: 45,
            severity: "high",
            category: "accuracy",
            comment: "wrong default",
            suggestion: "fixed",
          },
        ],
      },
      "docs/a.md"
    );
    expect(out?.reviews).toHaveLength(1);
    expect(out?.reviews[0]).toMatchObject({
      path: "docs/a.md",
      line: 42,
      endLine: 45,
      severity: "high",
      category: "accuracy",
      source: "llm",
    });
  });

  it("accepts the legacy schema (lineNumber/reviewComment)", () => {
    const out = validateReviews(
      {
        reviews: [
          { lineNumber: "7", reviewComment: "legacy", suggestion: "s" },
        ],
      },
      "docs/a.md"
    );
    expect(out?.reviews[0]).toMatchObject({
      line: 7,
      comment: "legacy",
      severity: "medium",
      category: "clarity",
    });
  });

  it("drops invalid items but keeps valid ones", () => {
    const out = validateReviews(
      {
        reviews: [
          { line: -1, comment: "bad line" },
          { line: 3 },
          { line: 5, comment: "ok" },
        ],
      },
      "docs/a.md"
    );
    expect(out?.reviews).toHaveLength(1);
    expect(out?.reviews[0].line).toBe(5);
  });

  it("rejects endLine that is not greater than line", () => {
    const out = validateReviews(
      { reviews: [{ line: 10, end_line: 10, comment: "x" }] },
      "docs/a.md"
    );
    expect(out?.reviews[0].endLine).toBeUndefined();
  });

  it("returns null for unusable shapes", () => {
    expect(validateReviews({}, "a")).toBeNull();
    expect(validateReviews({ reviews: "nope" }, "a")).toBeNull();
    expect(validateReviews([1, 2], "a")).toBeNull();
  });
});

describe("validateDigest", () => {
  it("parses intent, files and claims; drops broken claims", () => {
    const out = validateDigest({
      intent: "updates docs",
      files: [{ path: "a.md", summary: "changed" }, { summary: "no path" }],
      claims: [
        { type: "default", name: "x", value: "16", file: "a.md", line: 3 },
        { name: "missing value", file: "a.md" },
      ],
    });
    expect(out?.digest.intent).toBe("updates docs");
    expect(out?.digest.files).toHaveLength(1);
    expect(out?.digest.claims).toHaveLength(1);
    expect(out?.digest.claims[0].line).toBe(3);
  });

  it("returns null for non-objects", () => {
    expect(validateDigest("nope")).toBeNull();
  });
});

describe("validateInconsistencies", () => {
  it("parses findings and marks them as crosscheck", () => {
    const out = validateInconsistencies({
      inconsistencies: [
        { file: "a.md", line: 4, comment: "contradicts b.md:9" },
      ],
    });
    expect(out?.findings[0]).toMatchObject({
      path: "a.md",
      line: 4,
      source: "crosscheck",
      severity: "high",
      category: "accuracy",
    });
  });

  it("returns null without an inconsistencies array", () => {
    expect(validateInconsistencies({})).toBeNull();
  });
});

describe("validateVerdicts", () => {
  it("parses verdicts and clamps confidence", () => {
    const out = validateVerdicts({
      verdicts: [
        { id: 0, keep: true, confidence: 250, reason: "real issue" },
        { id: 1, keep: false, confidence: 10 },
      ],
    });
    expect(out?.verdicts).toHaveLength(2);
    expect(out?.verdicts[0]).toMatchObject({
      id: 0,
      keep: true,
      confidence: 100,
    });
    expect(out?.verdicts[1].keep).toBe(false);
  });

  it("skips verdicts without a numeric id", () => {
    const out = validateVerdicts({ verdicts: [{ keep: true }] });
    expect(out?.verdicts).toHaveLength(0);
  });
});
