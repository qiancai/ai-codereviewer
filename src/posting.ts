import { CommentableLines, remapLine } from "./context";
import { ExistingReviewComment } from "./github";
import { Finding, GhComment, Severity } from "./types";

/**
 * Turn findings into GitHub comments safely:
 * - validate every line number against the parsed diff (never send a line
 *   that GitHub would reject with a 422, sinking the whole review);
 * - remap near-miss line numbers onto the closest added line;
 * - degrade unmappable findings to the summary instead of dropping them;
 * - dedupe within the batch and against existing bot comments (re-runs).
 */

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export function formatBody(f: Finding): string {
  const header = `[${f.severity} · ${f.category}] `;
  if (!f.suggestion) return `${header}${f.comment}`;
  // Four backticks so the body survives suggestions containing ``` fences.
  return `${header}${f.comment}\n\n\`\`\`\`suggestion\n${f.suggestion}\n\`\`\`\``;
}

export interface ValidatedComments {
  comments: GhComment[];
  kept: Finding[];
  degraded: Finding[];
}

export function validateFindings(
  findings: Finding[],
  commentable: Map<string, CommentableLines>
): ValidatedComments {
  const comments: GhComment[] = [];
  const kept: Finding[] = [];
  const degraded: Finding[] = [];

  for (const f of findings) {
    const entry = commentable.get(f.path);
    let line = f.line;
    if (!entry?.commentable.has(line)) {
      const remapped = remapLine(entry, line);
      if (remapped === null) {
        degraded.push(f);
        continue;
      }
      line = remapped;
    }

    const comment: GhComment = {
      path: f.path,
      line,
      side: "RIGHT",
      body: formatBody({ ...f, line }),
    };

    // Multi-line suggestion: GitHub uses start_line..line. endLine in a
    // Finding is the inclusive end, so it becomes the comment's `line`.
    if (f.endLine && f.endLine > line) {
      const endOk = entry?.commentable.has(f.endLine);
      if (endOk) {
        comment.start_line = line;
        comment.start_side = "RIGHT";
        comment.line = f.endLine;
      }
    }

    comments.push(comment);
    kept.push({ ...f, line: comment.line });
  }
  return { comments, kept, degraded };
}

/** Drop duplicates inside one batch: same path+line keeps the highest severity. */
export function dedupeWithinBatch(findings: Finding[]): {
  unique: Finding[];
  dropped: Array<{ finding: Finding; reason: string }>;
} {
  const byKey = new Map<string, Finding>();
  const dropped: Array<{ finding: Finding; reason: string }> = [];

  for (const f of findings) {
    const key = `${f.path}:${f.line}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, f);
      continue;
    }
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) {
      dropped.push({
        finding: prev,
        reason: "duplicate of a higher-severity finding",
      });
      byKey.set(key, f);
    } else {
      dropped.push({
        finding: f,
        reason: `duplicate of an existing finding on ${key}`,
      });
    }
  }
  return { unique: [...byKey.values()], dropped };
}

/** Drop findings already posted by a bot on the same path+line (re-runs). */
export function dedupeAgainstExisting(
  findings: Finding[],
  existing: ExistingReviewComment[]
): { unique: Finding[]; dropped: Array<{ finding: Finding; reason: string }> } {
  const taken = new Set(
    existing
      .filter((c) => c.isBot && c.line !== undefined)
      .map((c) => `${c.path}:${c.line}`)
  );
  const unique: Finding[] = [];
  const dropped: Array<{ finding: Finding; reason: string }> = [];
  for (const f of findings) {
    if (taken.has(`${f.path}:${f.line}`)) {
      dropped.push({ finding: f, reason: "already posted on a previous run" });
    } else {
      unique.push(f);
    }
  }
  return { unique, dropped };
}
