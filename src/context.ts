import { Chunk, File } from "parse-diff";

/**
 * Diff/text context utilities: which lines are commentable, and
 * Markdown heading/anchor extraction (used by the deterministic checks).
 */

/**
 * GitHub-style anchor slug for a heading: lowercase, strip everything that
 * is not a letter/number/space/hyphen/underscore, spaces become hyphens.
 */
export function anchorize(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

export interface Heading {
  depth: number;
  text: string;
  anchor: string;
  /** 1-based line number in the document. */
  line: number;
}

const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Extract ATX headings, skipping fenced code blocks. */
export function extractHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  const anchorsSeen = new Map<string, number>();
  let inFence = false;
  let fenceMarker = "";

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const m = line.match(ATX_HEADING);
    if (!m) continue;

    const text = m[2].trim();
    let anchor = anchorize(text);
    // GitHub de-duplicates repeated anchors with -1, -2, ...
    const seen = anchorsSeen.get(anchor) ?? 0;
    anchorsSeen.set(anchor, seen + 1);
    if (seen > 0) anchor = `${anchor}-${seen}`;

    headings.push({ depth: m[1].length, text, anchor, line: i + 1 });
  }
  return headings;
}

export interface CommentableLines {
  /** Context + added lines on the RIGHT side (anything visible in a hunk). */
  commentable: Set<number>;
  /** Added lines only (valid anchor points for suggestions). */
  added: Set<number>;
}

/**
 * Build per-file sets of commentable and added lines from the parsed diff.
 * GitHub only accepts review comments on lines that appear in the diff.
 */
export function buildCommentableLines(
  files: File[]
): Map<string, CommentableLines> {
  const map = new Map<string, CommentableLines>();
  for (const file of files) {
    if (!file.to || file.to === "/dev/null") continue;
    const entry = map.get(file.to) ?? {
      commentable: new Set<number>(),
      added: new Set<number>(),
    };
    for (const chunk of file.chunks) {
      collectChunkLines(chunk, entry);
    }
    map.set(file.to, entry);
  }
  return map;
}

function collectChunkLines(chunk: Chunk, entry: CommentableLines): void {
  for (const change of chunk.changes) {
    if (change.type === "add") {
      entry.commentable.add(change.ln);
      entry.added.add(change.ln);
    } else if (change.type === "normal") {
      entry.commentable.add(change.ln2);
    }
    // deletions have no RIGHT-side line; they cannot anchor comments
  }
}

/**
 * Map a (possibly hallucinated) line number onto the diff:
 * exact commentable hit → itself; otherwise the nearest added line within
 * `tolerance`; otherwise null (the finding degrades to the summary).
 */
export function remapLine(
  entry: CommentableLines | undefined,
  line: number,
  tolerance = 5
): number | null {
  if (!entry) return null;
  if (entry.commentable.has(line)) return line;
  for (let delta = 1; delta <= tolerance; delta++) {
    if (entry.added.has(line + delta)) return line + delta;
    if (entry.added.has(line - delta)) return line - delta;
  }
  return null;
}
