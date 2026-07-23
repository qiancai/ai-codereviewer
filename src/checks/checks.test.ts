import { describe, expect, it } from "vitest";
import type { File } from "parse-diff";
import { checkTerms, parseGlossary } from "./terms";
import { checkLinksAndImages, extractLinks, resolveTarget } from "./links";
import { checkAnchorBreakage } from "./anchors";
import { checkToc } from "./toc";
import { CheckFile } from "./types";

function makeCheckFile(
  path: string,
  changes: Array<Record<string, unknown>>,
  fullContent: string | null = null,
  isNew = false
): CheckFile {
  return {
    path,
    file: {
      to: path,
      from: isNew ? "/dev/null" : path,
      new: isNew,
      chunks: [{ content: "@@ -0,0 +1,10 @@", changes }],
    } as unknown as File,
    fullContent,
    isNew,
  };
}

describe("parseGlossary", () => {
  it("parses rules, skips comments and bad lines", () => {
    const rules = parseGlossary(
      "# comment\nTiDB: tidb, Tidb\n\nno colon line\nPD: pd\n"
    );
    expect(rules).toEqual([
      { preferred: "TiDB", banned: ["tidb", "Tidb"] },
      { preferred: "PD", banned: ["pd"] },
    ]);
  });
});

describe("checkTerms", () => {
  const glossary = parseGlossary("TiDB: tidb\n静默: 沉默\n");

  it("flags banned Latin terms with word boundaries and suggests a fix", () => {
    const cf = makeCheckFile("docs/a.md", [
      { type: "add", ln: 5, content: "+Configure tidb now." },
      { type: "add", ln: 6, content: "+The tidbserver binary." }, // no word-boundary match
    ]);
    const findings = checkTerms(cf, glossary);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      line: 5,
      suggestion: "Configure TiDB now.",
      severity: "low",
      category: "terminology",
      source: "check",
    });
  });

  it("flags banned CJK terms literally", () => {
    const cf = makeCheckFile("docs/a.md", [
      { type: "add", ln: 3, content: "+不要沉默配置项。" },
    ]);
    const findings = checkTerms(cf, glossary);
    expect(findings[0].suggestion).toBe("不要静默配置项。");
  });

  it("skips lines inside code fences", () => {
    const content = "# Doc\n\n```bash\ntidb-server --version\n```\n";
    const cf = makeCheckFile(
      "docs/a.md",
      [{ type: "add", ln: 4, content: "+tidb-server --version" }],
      content
    );
    expect(checkTerms(cf, glossary)).toHaveLength(0);
  });
});

describe("extractLinks", () => {
  it("extracts relative links and images, skips external", () => {
    const refs = extractLinks(
      "see [guide](../b.md#setup) and ![img](images/x.png), plus [ext](https://example.com) and [mail](mailto:a@b.c)",
      7
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      target: "../b.md#setup",
      isImage: false,
      line: 7,
    });
    expect(refs[1]).toMatchObject({ target: "images/x.png", isImage: true });
  });
});

describe("resolveTarget", () => {
  it("resolves relative to the linking file", () => {
    expect(resolveTarget("docs/a/b.md", "../c.md")).toBe("docs/c.md");
    expect(resolveTarget("docs/a/b.md", "img/x.png")).toBe("docs/a/img/x.png");
    expect(resolveTarget("docs/a/b.md", "/root.md")).toBe("root.md");
  });
});

describe("checkLinksAndImages", () => {
  const files: Record<string, string> = {
    "docs/b.md": "# Setup\n\ncontent\n",
    "docs/a/images/x.png": "binary",
  };
  const deps = {
    fileExistsAtHead: async (p: string) => p in files,
    readFileAtHead: async (p: string) => files[p] ?? null,
  };

  it("reports missing link targets and bad anchors", async () => {
    const cf = makeCheckFile("docs/a/page.md", [
      {
        type: "add",
        ln: 2,
        content:
          "+[ok](../b.md#setup) [missing](../nope.md) [badanchor](../b.md#nope)",
      },
    ]);
    const findings = await checkLinksAndImages(cf, deps, {
      links: true,
      images: true,
    });
    expect(findings).toHaveLength(2);
    expect(findings[0].comment).toContain("docs/nope.md");
    expect(findings[0].severity).toBe("high");
    expect(findings[1].comment).toContain("#nope");
    expect(findings[1].severity).toBe("medium");
  });

  it("reports missing images only when images mode is on", async () => {
    const cf = makeCheckFile("docs/a/page.md", [
      { type: "add", ln: 3, content: "+![x](images/gone.png)" },
    ]);
    const on = await checkLinksAndImages(cf, deps, {
      links: true,
      images: true,
    });
    const off = await checkLinksAndImages(cf, deps, {
      links: true,
      images: false,
    });
    expect(on).toHaveLength(1);
    expect(on[0].comment).toContain("Missing image");
    expect(off).toHaveLength(0);
  });

  it("validates same-file anchors against the full content", async () => {
    const content = "# Title\n## Real Section\n";
    const cf = makeCheckFile(
      "docs/a/page.md",
      [
        {
          type: "add",
          ln: 5,
          content: "+jump to [section](#real-section) and [gone](#ghost)",
        },
      ],
      content
    );
    const findings = await checkLinksAndImages(cf, deps, {
      links: true,
      images: false,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].comment).toContain("#ghost");
  });
});

describe("checkAnchorBreakage", () => {
  it("reports external references to removed headings", async () => {
    const cf = makeCheckFile("docs/a.md", [
      { type: "del", ln: 8, content: "-## Old Section" },
    ]);
    const deps = {
      searchRepo: async (q: string) =>
        q === "#old-section" ? ["docs/a.md", "docs/other.md"] : [],
      readFileAtHead: async (p: string) =>
        p === "docs/other.md" ? "intro\nsee [link](a.md#old-section)\n" : null,
    };
    const findings = await checkAnchorBreakage(cf, deps);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      path: "docs/other.md",
      line: 2,
      severity: "high",
      source: "check",
    });
    expect(findings[0].comment).toContain("docs/a.md#old-section");
  });

  it("survives search API failures", async () => {
    const cf = makeCheckFile("docs/a.md", [
      { type: "del", ln: 8, content: "-## Gone" },
    ]);
    const deps = {
      searchRepo: async () => {
        throw new Error("403");
      },
      readFileAtHead: async () => null,
    };
    await expect(checkAnchorBreakage(cf, deps)).resolves.toEqual([]);
  });
});

describe("checkToc", () => {
  it("flags new pages missing from the TOC", async () => {
    const cf = makeCheckFile("docs/new-page.md", [], null, true);
    const deps = {
      readFileAtHead: async (p: string) =>
        p === "TOC.md" ? "- [Other](docs/other.md)\n" : null,
      tocPath: "TOC.md",
    };
    const findings = await checkToc(cf, deps);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      path: "docs/new-page.md",
      line: 1,
      severity: "low",
    });
  });

  it("passes pages referenced in the TOC", async () => {
    const cf = makeCheckFile("docs/new-page.md", [], null, true);
    const deps = {
      readFileAtHead: async (p: string) =>
        p === "TOC.md" ? "- [New](docs/new-page.md)\n" : null,
      tocPath: "TOC.md",
    };
    expect(await checkToc(cf, deps)).toHaveLength(0);
  });

  it("skips when tocPath is empty or file is not new", async () => {
    const cf = makeCheckFile("docs/old.md", [], null, false);
    const deps = { readFileAtHead: async () => null, tocPath: "" };
    expect(await checkToc(cf, deps)).toHaveLength(0);
  });
});
