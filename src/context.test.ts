import { describe, expect, it } from "vitest";
import {
  anchorize,
  buildCommentableLines,
  extractHeadings,
  remapLine,
} from "./context";
import type { File } from "parse-diff";

describe("anchorize", () => {
  it("lowercases and hyphenates", () => {
    expect(anchorize("Hello World Test")).toBe("hello-world-test");
  });

  it("strips punctuation but keeps CJK", () => {
    expect(anchorize("What's New? (v2.0)")).toBe("whats-new-v20");
    expect(anchorize("配置 TiDB 参数")).toBe("配置-tidb-参数");
  });

  it("keeps hyphens and underscores", () => {
    expect(anchorize("my-section_name")).toBe("my-section_name");
  });
});

describe("extractHeadings", () => {
  it("extracts ATX headings with line numbers", () => {
    const content = "# Title\n\nsome text\n\n## Section One\ncontent\n";
    const headings = extractHeadings(content);
    expect(headings).toEqual([
      { depth: 1, text: "Title", anchor: "title", line: 1 },
      { depth: 2, text: "Section One", anchor: "section-one", line: 5 },
    ]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const content = "# Real\n```\n# Not a heading\n```\n## Also real\n";
    const anchors = extractHeadings(content).map((h) => h.anchor);
    expect(anchors).toEqual(["real", "also-real"]);
  });

  it("deduplicates repeated anchors like GitHub", () => {
    const content = "# Intro\n# Intro\n# Intro\n";
    const anchors = extractHeadings(content).map((h) => h.anchor);
    expect(anchors).toEqual(["intro", "intro-1", "intro-2"]);
  });

  it("strips trailing closing hashes", () => {
    expect(extractHeadings("## Title ##\n")[0].text).toBe("Title");
  });
});

function makeFile(changes: Array<Record<string, unknown>>): File {
  return {
    to: "docs/a.md",
    chunks: [{ content: "@@ -1,3 +1,4 @@", changes }],
  } as unknown as File;
}

describe("buildCommentableLines", () => {
  it("collects added and context lines on the right side", () => {
    const file = makeFile([
      { type: "normal", ln1: 1, ln2: 1, content: " ctx" },
      { type: "add", ln: 2, content: "+added" },
      { type: "del", ln: 2, content: "-removed" },
      { type: "normal", ln1: 3, ln2: 3, content: " ctx2" },
    ]);
    const entry = buildCommentableLines([file]).get("docs/a.md")!;
    expect([...entry.commentable].sort()).toEqual([1, 2, 3]);
    expect([...entry.added]).toEqual([2]); // deletions cannot anchor
  });
});

describe("remapLine", () => {
  const entry = {
    commentable: new Set([10, 11, 20]),
    added: new Set([11, 20]),
  };

  it("returns the line itself when commentable", () => {
    expect(remapLine(entry, 10)).toBe(10);
  });

  it("remaps to the nearest added line within tolerance", () => {
    expect(remapLine(entry, 13)).toBe(11);
    expect(remapLine(entry, 18)).toBe(20);
  });

  it("returns null when nothing is near", () => {
    expect(remapLine(entry, 100)).toBeNull();
    expect(remapLine(undefined, 10)).toBeNull();
  });
});
