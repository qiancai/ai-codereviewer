import { Finding } from "../../types";
import { addedLines, CheckFile, fencedLines } from "../types";
import { segmentLine } from "./common";

/**
 * Spanish typography rule: question and exclamation marks need their
 * opening counterpart — "¿Cómo?", "¡Atención!". For each closing mark
 * without a matching opening mark since the last sentence boundary, the
 * opening mark is inserted at the sentence start.
 */

/** Where does the sentence start? After sentence-final punctuation plus
 * whitespace, or at the segment start (skipping list/quote markers). */
function sentenceStart(segment: string, before: number): number {
  const head = segment.slice(0, before);
  const boundary = /[.!?…]\s+(?!.*[.!?…]\s)/.exec(head);
  let start = boundary ? boundary.index + boundary[0].length : 0;
  // Skip list markers and quote markers at the start.
  const marker = /^(?:\s*(?:[-*+]|\d+\.)\s+|\s*>\s+)/.exec(
    segment.slice(start)
  );
  if (marker) start += marker[0].length;
  return start;
}

function fixProseSegment(text: string): { fixed: string; changed: boolean } {
  let fixed = text;
  let changed = false;

  // Work right-to-left so insertions do not shift earlier positions.
  const marks: Array<{ index: number; mark: string }> = [];
  for (const m of text.matchAll(/[?!]/g)) {
    marks.push({ index: m.index ?? 0, mark: m[0] });
  }
  for (let i = marks.length - 1; i >= 0; i--) {
    const { index, mark } = marks[i];
    const opening = mark === "?" ? "¿" : "¡";
    const start = sentenceStart(text, index);
    if (text.slice(start, index).includes(opening)) continue;
    if (!/[A-Za-zÀ-ɏ]/.test(text.slice(start, index))) continue; // no words before the mark
    fixed = fixed.slice(0, start) + opening + fixed.slice(start);
    changed = true;
  }
  return { fixed, changed };
}

export function checkEsTypography(checkFile: CheckFile): Finding[] {
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
        "Español: faltan los signos de apertura «¿» o «¡» en esta frase.",
      suggestion: rebuilt,
      source: "check",
    });
  }
  return findings;
}
