import { describe, expect, it } from "vitest";
import { extractJson, LlmError } from "./client";

describe("extractJson", () => {
  it("parses a clean JSON object", () => {
    expect(extractJson('{"reviews": []}')).toEqual({ reviews: [] });
  });

  it("strips an enclosing code fence", () => {
    expect(extractJson('```json\n{"reviews": [1]}\n```')).toEqual({
      reviews: [1],
    });
  });

  it("salvages JSON surrounded by prose", () => {
    expect(extractJson('Here you go:\n{"a": 1}\nHope that helps')).toEqual({
      a: 1,
    });
  });

  it("throws LlmError on unrecoverable input", () => {
    expect(() => extractJson("no json here")).toThrow(LlmError);
    expect(() => extractJson("{broken")).toThrow(LlmError);
  });
});
