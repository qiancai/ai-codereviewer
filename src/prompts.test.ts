import { describe, expect, it } from "vitest";
import { detectLanguage, renderTemplate } from "./prompts";

describe("renderTemplate", () => {
  it("replaces known placeholders and leaves unknown ones", () => {
    expect(
      renderTemplate("file ${filename} by ${title}, ${unknown}", {
        filename: "a.md",
        title: "t",
      })
    ).toBe("file a.md by t, ${unknown}");
  });

  it("replaces repeated placeholders", () => {
    expect(renderTemplate("${a}-${a}", { a: "x" })).toBe("x-x");
  });
});

describe("detectLanguage", () => {
  it("detects zh from path conventions", () => {
    expect(detectLanguage("docs/zh/guide.md", null)).toBe("zh");
    expect(detectLanguage("docs/guide_zh.md", null)).toBe("zh");
    expect(detectLanguage("zh-cn/a.md", null)).toBe("zh");
  });

  it("detects zh from CJK content", () => {
    expect(
      detectLanguage(
        "docs/a.md",
        "这是一段中文文档内容，包含很多汉字。".repeat(3)
      )
    ).toBe("zh");
  });

  it("defaults to en", () => {
    expect(detectLanguage("docs/a.md", "# English content")).toBe("en");
    expect(detectLanguage("docs/a.md", null)).toBe("en");
  });
});
