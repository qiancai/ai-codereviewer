import { describe, expect, it } from "vitest";
import type { File } from "parse-diff";
import { detectLanguage, languageName, languageVariantPath } from "../prompts";
import { checkTypography } from "./typography";
import { CheckFile } from "./types";

describe("detectLanguage", () => {
  it("respects the explicit override above everything", () => {
    expect(detectLanguage("docs/zh/a.md", "中文内容", "fr")).toBe("fr");
    expect(detectLanguage("docs/a.md", null, "ja")).toBe("ja");
  });

  it("detects from path conventions without matching lookalike words", () => {
    expect(detectLanguage("docs/ja/guide.md", null)).toBe("ja");
    expect(detectLanguage("docs/guide_fr.md", null)).toBe("fr");
    expect(detectLanguage("i18n/de/intro.md", null)).toBe("de");
    expect(detectLanguage("docs/design/portal.md", null)).toBe("en"); // de/pt lookalikes
  });

  it("distinguishes Japanese from Chinese by kana", () => {
    const ja = "これは日本語のドキュメントです。設定方法を説明します。";
    const zh = "这是一段中文文档内容，介绍配置方法。".repeat(2);
    expect(detectLanguage("docs/a.md", ja)).toBe("ja");
    expect(detectLanguage("docs/a.md", zh)).toBe("zh");
  });

  it("detects Korean and Russian by script", () => {
    expect(
      detectLanguage(
        "docs/a.md",
        "이것은 한국어 문서입니다. 설정 방법을 설명합니다."
      )
    ).toBe("ko");
    expect(
      detectLanguage(
        "docs/a.md",
        "Это русская документация. Здесь описывается настройка системы."
      )
    ).toBe("ru");
  });

  it("detects French/German/Spanish via stop words", () => {
    const fr =
      "Cette section décrit la configuration du cluster. Pour commencer, vous devez installer le binaire, puis modifier les paramètres dans le fichier de configuration. Nous recommandons une valeur par défaut pour la plupart des cas.";
    expect(detectLanguage("docs/a.md", fr)).toBe("fr");
    const de =
      "Dieser Abschnitt beschreibt die Konfiguration und die wichtigsten Parameter. Für die Installation ist eine aktuelle Version nicht erforderlich, aber sie wird empfohlen. Der Standardwert ist in den meisten Fällen eine gute Wahl.";
    expect(detectLanguage("docs/a.md", de)).toBe("de");
    const es =
      "Esta sección describe la configuración del clúster. Para empezar, el usuario debe instalar el binario y modificar los parámetros en el archivo de configuración. Como regla general, el valor por defecto es adecuado para la mayoría de los casos.";
    expect(detectLanguage("docs/a.md", es)).toBe("es");
  });

  it("falls back to en for short or ambiguous Latin text", () => {
    expect(detectLanguage("docs/a.md", "la la la")).toBe("en");
    expect(detectLanguage("docs/a.md", "# English content here")).toBe("en");
  });
});

describe("languageName / languageVariantPath", () => {
  it("maps codes to display names and falls back to the code", () => {
    expect(languageName("fr")).toBe("French");
    expect(languageName("zh")).toBe("Chinese");
    expect(languageName("xx")).toBe("xx");
  });

  it("builds language-specific template paths", () => {
    expect(languageVariantPath("prompts/review.txt", "ja")).toBe(
      "prompts/review.ja.txt"
    );
    expect(languageVariantPath("review", "fr")).toBe("review.fr");
  });
});

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

describe("checkTypography dispatcher", () => {
  it("routes zh and returns no findings for unsupported languages", () => {
    const cf = makeCheckFile("docs/zh/a.md", [
      { type: "add", ln: 2, content: "+使用TiDB进行备份。" },
    ]);
    expect(checkTypography(cf, "zh")).toHaveLength(1);
    expect(checkTypography(cf, "ja")).toHaveLength(0);
    expect(checkTypography(cf, "en")).toHaveLength(0);
  });

  it("fr: inserts a no-break space before high punctuation", () => {
    const cf = makeCheckFile("docs/fr/a.md", [
      {
        type: "add",
        ln: 2,
        content: "+Allons-y! Voir la section suivante; puis continuez.",
      },
      { type: "add", ln: 3, content: "+Déjà correct !" },
    ]);
    const findings = checkTypography(cf, "fr");
    expect(findings).toHaveLength(1);
    expect(findings[0].suggestion).toBe(
      "Allons-y ! Voir la section suivante ; puis continuez."
    );
    expect(findings[0].suggestion).toContain(" ");
    expect(findings[0].comment).toContain("espace insécable");
  });

  it("fr: does not touch colons followed by digits or non-prose spans", () => {
    const cf = makeCheckFile("docs/fr/a.md", [
      {
        type: "add",
        ln: 2,
        content:
          "+La durée est 12:30 et voir `code: x` ou https://example.com/a:b.",
      },
    ]);
    expect(checkTypography(cf, "fr")).toHaveLength(0);
  });

  it("es: inserts missing opening marks at sentence start", () => {
    const cf = makeCheckFile("docs/es/a.md", [
      {
        type: "add",
        ln: 2,
        content: "+Cómo funciona? Mira la sección siguiente.",
      },
      { type: "add", ln: 3, content: "+¿Ya es correcto? Sí." },
    ]);
    const findings = checkTypography(cf, "es");
    expect(findings).toHaveLength(1);
    expect(findings[0].suggestion).toBe(
      "¿Cómo funciona? Mira la sección siguiente."
    );
  });

  it("es: handles list markers and exclamations", () => {
    const cf = makeCheckFile("docs/es/a.md", [
      { type: "add", ln: 2, content: "+- Atención! Esto es importante." },
    ]);
    const findings = checkTypography(cf, "es");
    expect(findings[0].suggestion).toBe("- ¡Atención! Esto es importante.");
  });
});
