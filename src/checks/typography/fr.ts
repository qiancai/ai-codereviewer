import { Finding } from "../../types";
import { addedLines, CheckFile, fencedLines } from "../types";
import { segmentLine } from "./common";

/**
 * French typography rule: a no-break space (U+00A0) is required before the
 * "high" punctuation marks ; : ! ? — "Allons-y !", not "Allons-y!".
 * Colons followed by a digit (times, ratios) are excluded.
 */

const LATIN = "A-Za-zÀ-ɏ0-9";
const NBSP = " ";

function fixProseSegment(text: string): { fixed: string; changed: boolean } {
  const fixed = text.replace(
    new RegExp(`([${LATIN}»”\\]\\)])([;:!?])(?=\\s|$)`, "g"),
    "$1" + NBSP + "$2"
  );
  return { fixed, changed: fixed !== text };
}

export function checkFrTypography(checkFile: CheckFile): Finding[] {
  const findings: Finding[] = [];
  const fenced = checkFile.fullContent
    ? fencedLines(checkFile.fullContent)
    : new Set<number>();

  for (const { line, text } of addedLines(checkFile.file)) {
    if (fenced.has(line)) continue;

    const rebuilt = segmentLine(text)
      .map((seg) => (seg.prose ? fixProseSegment(seg.text).fixed : seg.text))
      .join("");

    if (rebuilt === text) continue;

    findings.push({
      path: checkFile.path,
      line,
      severity: "low",
      category: "grammar",
      comment:
        "Typographie française : une espace insécable est requise avant les ponctuations hautes « ; : ! ? ».",
      suggestion: rebuilt,
      source: "check",
    });
  }
  return findings;
}
