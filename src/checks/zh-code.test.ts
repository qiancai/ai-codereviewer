import { describe, expect, it } from "vitest";
import type { File } from "parse-diff";
import { checkZhTypography } from "./typography/zh";
import { segmentLine } from "./typography/common";
import { checkCodeAnchors, extractFlags, shellFenceLines } from "./code";
import { CheckFile } from "./types";

function makeCheckFile(
  path: string,
  changes: Array<Record<string, unknown>>,
  fullContent: string | null = null
): CheckFile {
  return {
    path,
    file: {
      to: path,
      from: path,
      chunks: [{ content: "@@ -0,0 +1,10 @@", changes }],
    } as unknown as File,
    fullContent,
    isNew: false,
  };
}

describe("segmentLine", () => {
  it("masks inline code, urls, link targets and tags", () => {
    const segments = segmentLine(
      "见 `xx` 和 [链接](a.md) 以及 https://example.com 和 <br> 尾"
    );
    const prose = segments.filter((s) => s.prose).map((s) => s.text);
    expect(prose.join("")).toContain("见 ");
    expect(prose.join("")).toContain("[链接]");
    expect(segments.some((s) => !s.prose && s.text === "`xx`")).toBe(true);
    expect(segments.some((s) => !s.prose && s.text === "(a.md)")).toBe(true);
    expect(
      segments.some((s) => !s.prose && s.text === "https://example.com")
    ).toBe(true);
    expect(segments.some((s) => !s.prose && s.text === "<br>")).toBe(true);
  });
});

describe("checkZhTypography", () => {
  it("adds spaces between CJK and Latin/digits", () => {
    const cf = makeCheckFile("docs/zh/a.md", [
      { type: "add", ln: 2, content: "+使用TiDB进行备份。" },
      { type: "add", ln: 3, content: "+支持16MB写入和3.5倍压缩。" },
    ]);
    const findings = checkZhTypography(cf);
    expect(findings).toHaveLength(2);
    expect(findings[0].suggestion).toBe("使用 TiDB 进行备份。");
    expect(findings[1].suggestion).toBe("支持 16MB 写入和 3.5 倍压缩。");
    expect(findings[0].comment).toContain("空格");
  });

  it("converts halfwidth punctuation between CJK to fullwidth", () => {
    const cf = makeCheckFile("docs/zh/a.md", [
      { type: "add", ln: 2, content: "+注意:该功能(实验特性),慎用!" },
    ]);
    const findings = checkZhTypography(cf);
    expect(findings[0].suggestion).toBe("注意：该功能（实验特性），慎用！");
    expect(findings[0].comment).toContain("全角标点");
  });

  it("masks inline code, urls, link targets and tags", () => {
    const cf = makeCheckFile("docs/zh/a.md", [
      { type: "add", ln: 2, content: "+运行`tiup list`查看版本。" },
      {
        type: "add",
        ln: 3,
        content: "+参考[配置](config.md)和https://docs.example.com页面。",
      },
      {
        type: "add",
        ln: 4,
        content: '+使用<CustomContent plan="dedicated"/>占位。',
      },
    ]);
    expect(checkZhTypography(cf)).toHaveLength(0);
  });

  it("skips lines inside fenced code blocks", () => {
    const content = "# 标题\n\n```bash\ntiup cluster deploy集群\n```\n";
    const cf = makeCheckFile(
      "docs/zh/a.md",
      [{ type: "add", ln: 4, content: "+tiup cluster deploy集群" }],
      content
    );
    expect(checkZhTypography(cf)).toHaveLength(0);
  });

  it("leaves already-correct text and pure-English lines alone", () => {
    const cf = makeCheckFile("docs/zh/a.md", [
      { type: "add", ln: 2, content: "+使用 TiDB 进行备份。" },
      { type: "add", ln: 3, content: "+English only line." },
    ]);
    expect(checkZhTypography(cf)).toHaveLength(0);
  });
});

describe("shellFenceLines", () => {
  it("collects only shell-tagged fence content", () => {
    const content = [
      "text",
      "```bash",
      "echo a",
      "```",
      "```sql",
      "select 1;",
      "```",
      "```",
      "echo untagged",
      "```",
    ].join("\n");
    const lines = shellFenceLines(content);
    expect([...lines]).toEqual([3]);
  });
});

describe("extractFlags", () => {
  it("extracts long flags only", () => {
    expect(
      extractFlags("tiup cluster deploy --tidb v1 -y --config ./c.toml --x9")
    ).toEqual(["--tidb", "--config", "--x9"]);
    expect(extractFlags("no flags here")).toEqual([]);
  });
});

describe("checkCodeAnchors", () => {
  const content = [
    "# Doc",
    "```bash",
    "tiup cluster deploy --gone-flag --ok-flag",
    "```",
  ].join("\n");

  function makeCf(): CheckFile {
    return makeCheckFile(
      "docs/a.md",
      [
        {
          type: "add",
          ln: 3,
          content: "+tiup cluster deploy --gone-flag --ok-flag",
        },
      ],
      content
    );
  }

  it("flags flags that do not exist in the source repo", async () => {
    const queries: string[] = [];
    const findings = await checkCodeAnchors(makeCf(), {
      codeRepo: "pingcap/tidb",
      searchCode: async (q) => {
        queries.push(q);
        return q.includes("gone-flag") ? 0 : 5;
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      line: 3,
      severity: "low",
      source: "check",
    });
    expect(findings[0].comment).toContain("--gone-flag");
    expect(findings[0].comment).toContain("not an assertion");
    expect(queries.every((q) => q.includes("repo:pingcap/tidb"))).toBe(true);
  });

  it("does nothing without a codeRepo or full content", async () => {
    const cf = makeCf();
    expect(
      await checkCodeAnchors(cf, { codeRepo: "", searchCode: async () => 0 })
    ).toEqual([]);
    expect(
      await checkCodeAnchors(makeCheckFile("docs/a.md", [], null), {
        codeRepo: "pingcap/tidb",
        searchCode: async () => 0,
      })
    ).toEqual([]);
  });

  it("survives search failures", async () => {
    const findings = await checkCodeAnchors(makeCf(), {
      codeRepo: "pingcap/tidb",
      searchCode: async () => {
        throw new Error("rate limit");
      },
    });
    expect(findings).toEqual([]);
  });
});
