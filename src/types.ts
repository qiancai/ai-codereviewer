/** Shared types for the review pipeline. */

export interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
  /** Head SHA of the PR, used to fetch file contents and anchor review comments. */
  headSha: string;
}

export type Severity = "high" | "medium" | "low";

export type Category =
  | "accuracy"
  | "logic"
  | "clarity"
  | "terminology"
  | "structure"
  | "grammar";

export type FindingSource = "llm" | "crosscheck" | "check";

/** A single review finding, normalized across all pipeline stages. */
export interface Finding {
  path: string;
  line: number;
  /** Optional end line for multi-line suggestions (GitHub start_line..line). */
  endLine?: number;
  severity: Severity;
  category: Category;
  comment: string;
  /** Replacement text for line..endLine (rendered as a ```suggestion block). */
  suggestion?: string;
  source: FindingSource;
}

/** A comment ready to be sent to the GitHub Pull Review API. */
export interface GhComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export interface ReviewRunResult {
  /** Findings that passed line validation and dedupe, posted as inline comments. */
  posted: Finding[];
  /** Findings whose line could not be mapped onto the diff; reported in the summary. */
  degraded: Finding[];
  /** Findings dropped by verification or dedupe. */
  dropped: Array<{ finding: Finding; reason: string }>;
  /** Per-file or per-stage failures, reported in the summary. Never silent. */
  failures: string[];
}
