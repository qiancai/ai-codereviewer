import { Category, Finding, Severity } from "../types";

/**
 * Validators for LLM JSON outputs. All validators are total functions:
 * they never throw on malformed input, they return `null` when the shape
 * is unusable, and they sanitize/coerce individual items so one bad item
 * does not sink the whole response.
 */

const SEVERITIES: Severity[] = ["high", "medium", "low"];
const CATEGORIES: Category[] = [
  "accuracy",
  "logic",
  "clarity",
  "terminology",
  "structure",
  "grammar",
];

function asRecord(u: unknown): Record<string, unknown> | null {
  if (u && typeof u === "object" && !Array.isArray(u)) {
    return u as Record<string, unknown>;
  }
  return null;
}

function asNumber(u: unknown): number | null {
  if (typeof u === "number" && Number.isFinite(u)) return Math.floor(u);
  if (typeof u === "string" && u.trim() !== "") {
    const n = Number(u);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return null;
}

function asNonEmptyString(u: unknown): string | null {
  return typeof u === "string" && u.trim() !== "" ? u : null;
}

function pick<T extends string>(u: unknown, allowed: T[], fallback: T): T {
  return typeof u === "string" && (allowed as string[]).includes(u)
    ? (u as T)
    : fallback;
}

/**
 * Validate the per-file review response. Accepts both the current schema
 * (line/end_line/severity/category/comment/suggestion) and the legacy one
 * (lineNumber/reviewComment/suggestion) so old custom prompt templates keep
 * working. Individual invalid items are dropped, not fatal.
 */
export function validateReviews(
  u: unknown,
  path: string
): { reviews: Finding[] } | null {
  const root = asRecord(u);
  if (!root || !Array.isArray(root.reviews)) return null;

  const reviews: Finding[] = [];
  for (const item of root.reviews) {
    const rec = asRecord(item);
    if (!rec) continue;

    const line = asNumber(rec.line ?? rec.lineNumber);
    const comment = asNonEmptyString(rec.comment ?? rec.reviewComment);
    if (line === null || line <= 0 || !comment) continue;

    const endLine = asNumber(rec.end_line ?? rec.endLine);
    const suggestion =
      typeof rec.suggestion === "string" && rec.suggestion !== ""
        ? rec.suggestion
        : undefined;

    reviews.push({
      path,
      line,
      endLine: endLine !== null && endLine > line ? endLine : undefined,
      severity: pick(rec.severity, SEVERITIES, "medium"),
      category: pick(rec.category, CATEGORIES, "clarity"),
      comment,
      suggestion,
      source: "llm",
    });
  }
  return { reviews };
}

export interface Claim {
  type: string;
  name: string;
  value: string;
  file: string;
  line: number | null;
}

export interface Digest {
  intent: string;
  files: Array<{ path: string; summary: string }>;
  claims: Claim[];
}

export function validateDigest(u: unknown): { digest: Digest } | null {
  const root = asRecord(u);
  if (!root) return null;

  const files: Digest["files"] = [];
  if (Array.isArray(root.files)) {
    for (const f of root.files) {
      const rec = asRecord(f);
      if (!rec) continue;
      const path = asNonEmptyString(rec.path);
      const summary = asNonEmptyString(rec.summary);
      if (path && summary) files.push({ path, summary });
    }
  }

  const claims: Claim[] = [];
  if (Array.isArray(root.claims)) {
    for (const c of root.claims) {
      const rec = asRecord(c);
      if (!rec) continue;
      const name = asNonEmptyString(rec.name);
      const value = asNonEmptyString(rec.value);
      const file = asNonEmptyString(rec.file);
      if (!name || !value || !file) continue;
      claims.push({
        type: asNonEmptyString(rec.type) ?? "term",
        name,
        value,
        file,
        line: asNumber(rec.line),
      });
    }
  }

  return {
    digest: {
      intent: asNonEmptyString(root.intent) ?? "",
      files,
      claims,
    },
  };
}

/** Cross-check response: inconsistencies found by comparing claims across files. */
export function validateInconsistencies(
  u: unknown
): { findings: Finding[] } | null {
  const root = asRecord(u);
  if (!root || !Array.isArray(root.inconsistencies)) return null;

  const findings: Finding[] = [];
  for (const item of root.inconsistencies) {
    const rec = asRecord(item);
    if (!rec) continue;
    const path = asNonEmptyString(rec.file);
    const line = asNumber(rec.line);
    const comment = asNonEmptyString(rec.comment);
    if (!path || line === null || line <= 0 || !comment) continue;
    findings.push({
      path,
      line,
      severity: pick(rec.severity, SEVERITIES, "high"),
      category: pick(rec.category, CATEGORIES, "accuracy"),
      comment,
      source: "crosscheck",
    });
  }
  return { findings };
}

export interface Verdict {
  id: number;
  keep: boolean;
  confidence: number;
  reason: string;
}

/** Verify-stage response: one verdict per candidate finding. */
export function validateVerdicts(u: unknown): { verdicts: Verdict[] } | null {
  const root = asRecord(u);
  if (!root || !Array.isArray(root.verdicts)) return null;

  const verdicts: Verdict[] = [];
  for (const item of root.verdicts) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = asNumber(rec.id);
    if (id === null) continue;
    const confidence = asNumber(rec.confidence) ?? 0;
    verdicts.push({
      id,
      keep: rec.keep === true || rec.keep === "true" || rec.keep === "keep",
      confidence: Math.max(0, Math.min(100, confidence)),
      reason: asNonEmptyString(rec.reason) ?? "",
    });
  }
  return { verdicts };
}
