import { Finding } from "../../types";
import { addedLines, CheckFile, fencedLines } from "../types";
import { segmentLine } from "./common";

/**
 * Chinese typography rules (the same rules autocorrect/zhlint enforce):
 *  - Z1: a space is required between a CJK character and a Latin
 *    letter/digit, in both directions ("使用TiDB" → "使用 TiDB");
 *  - Z2: fullwidth punctuation is required in Chinese context
 *    ("注意:xxx" → "注意：xxx", "功能,例如" → "功能，例如").
 *
 * These rules are correct for Chinese ONLY — Japanese and Korean
 * typesetting have different conventions (in particular, no CJK-Latin
 * spacing), which is why this check is gated on language === "zh".
 */

const CJK = "一-鿿豈-﫿";
const CJK_RE = new RegExp(`[${CJK}]`);
/** CJK plus fullwidth punctuation/forms — the "Chinese context" for Z2. */
const CJK_CTX = `${CJK}　-〿＀-￯`;

/** Halfwidth punctuation that must be fullwidth between CJK characters. */
const FULLWIDTH_MAP: Record<string, string> = {
  ",": "，",
  ";": "；",
  ":": "：",
  "!": "！",
  "?": "？",
};

interface ZhFix {
  fixed: string;
  spacing: boolean;
  punctuation: boolean;
}

function fixProseSegment(text: string): ZhFix {
  // Z1: space between CJK and Latin letters/digits (both directions).
  const fixed = text
    .replace(new RegExp(`([${CJK}])([A-Za-z0-9])`, "g"), "$1 $2")
    .replace(new RegExp(`([A-Za-z0-9])([${CJK}])`, "g"), "$1 $2");
  const spacing = fixed !== text;

  // Z2: halfwidth parens wrapping CJK content become fullwidth first, so
  // that a following halfwidth punct sees the fullwidth paren as context.
  const parens = fixed.replace(
    new RegExp(`\\(([^()]*[${CJK}][^()]*)\\)`, "g"),
    "（$1）"
  );
  // Z2: halfwidth punctuation in Chinese context becomes fullwidth —
  // between two CJK-context chars, or after a CJK char at the end of a
  // prose segment / before whitespace (sentence-final).
  const z2 = parens
    .replace(
      new RegExp(`([${CJK_CTX}])([,;:!?])(?=[${CJK_CTX}])`, "g"),
      (_m, cjk: string, punct: string) => cjk + (FULLWIDTH_MAP[punct] ?? punct)
    )
    .replace(
      new RegExp(`([${CJK}])([,;:!?])(?=\\s|$)`, "g"),
      (_m, cjk: string, punct: string) => cjk + (FULLWIDTH_MAP[punct] ?? punct)
    );

  return { fixed: z2, spacing, punctuation: z2 !== fixed };
}

export function checkZhTypography(checkFile: CheckFile): Finding[] {
  const findings: Finding[] = [];
  const fenced = checkFile.fullContent
    ? fencedLines(checkFile.fullContent)
    : new Set<number>();

  for (const { line, text } of addedLines(checkFile.file)) {
    if (fenced.has(line)) continue;
    if (!CJK_RE.test(text)) continue;

    let spacing = false;
    let punctuation = false;
    const rebuilt = segmentLine(text)
      .map((seg) => {
        if (!seg.prose) return seg.text;
        const fix = fixProseSegment(seg.text);
        spacing = spacing || fix.spacing;
        punctuation = punctuation || fix.punctuation;
        return fix.fixed;
      })
      .join("");

    if (rebuilt === text) continue;

    const issues: string[] = [];
    if (spacing) issues.push("中西文/数字之间应加空格");
    if (punctuation) issues.push("中文语境应使用全角标点");
    findings.push({
      path: checkFile.path,
      line,
      severity: "low",
      category: "grammar",
      comment: `中文排版：${issues.join("；")}。`,
      suggestion: rebuilt,
      source: "check",
    });
  }
  return findings;
}
