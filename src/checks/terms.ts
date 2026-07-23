import { Finding } from "../types";
import { addedLines, CheckFile, fencedLines, TermRule } from "./types";

/**
 * Terminology lint: scan added lines for banned terms from the glossary
 * ("preferred: banned1, banned2" per line). Lines inside code fences are
 * skipped — command output and UI strings are not prose.
 */

/** Parse a glossary file. Lines: `preferred: banned1, banned2`. `#` comments. */
export function parseGlossary(content: string): TermRule[] {
  const rules: TermRule[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const preferred = line.slice(0, colon).trim();
    const banned = line
      .slice(colon + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (preferred && banned.length > 0) rules.push({ preferred, banned });
  }
  return rules;
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/; // Hiragana, Katakana, CJK ext-A, CJK unified, compat ideographs

function termRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word boundaries only make sense for Latin terms; CJK terms match literally.
  return CJK.test(term)
    ? new RegExp(escaped, "g")
    : new RegExp(`\\b${escaped}\\b`, "gi");
}

export function checkTerms(
  checkFile: CheckFile,
  glossary: TermRule[]
): Finding[] {
  if (glossary.length === 0) return [];
  const findings: Finding[] = [];
  const fenced = checkFile.fullContent
    ? fencedLines(checkFile.fullContent)
    : new Set<number>();

  for (const { line, text } of addedLines(checkFile.file)) {
    if (fenced.has(line)) continue;
    for (const rule of glossary) {
      for (const banned of rule.banned) {
        const re = termRegex(banned);
        if (!re.test(text)) continue;
        findings.push({
          path: checkFile.path,
          line,
          severity: "low",
          category: "terminology",
          comment: `Terminology: use "${rule.preferred}" instead of "${banned}".`,
          suggestion: text.replace(termRegex(banned), rule.preferred),
          source: "check",
        });
      }
    }
  }
  return findings;
}
