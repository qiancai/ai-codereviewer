import { Finding } from "../types";
import { addedLines, CheckFile } from "./types";

/**
 * Lightweight code-anchoring check (Swimm's idea, minimal version).
 *
 * CLI flags in docs rot silently when the product renames them. This check
 * extracts `--flags` from shell code blocks added by the PR and verifies
 * each one against a configured source repository via GitHub code search.
 *
 * Deliberately hedged: a flag that is not found produces a "please verify"
 * note, not an assertion — flags can be defined dynamically or generated,
 * and code search has blind spots. Ground-truth for humans, not a gate.
 */

const SHELL_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "console",
  "zsh",
  "shell-session",
]);

const MAX_FLAGS_PER_RUN = 15;

/** Line numbers that are inside shell-tagged fenced code blocks (1-based). */
export function shellFenceLines(content: string): Set<number> {
  const result = new Set<number>();
  let inFence = false;
  let isShell = false;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*```(\S*)/);
    if (m) {
      if (!inFence) {
        inFence = true;
        isShell = SHELL_LANGS.has(m[1].toLowerCase());
      } else {
        inFence = false;
        isShell = false;
      }
      continue;
    }
    if (inFence && isShell) result.add(i + 1);
  }
  return result;
}

/** Extract `--long-flags` from a line of shell text. */
export function extractFlags(text: string): string[] {
  const flags = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/g)) {
    flags.add(m[1]);
  }
  return [...flags];
}

export interface CodeAnchorDeps {
  /** Run an arbitrary code-search query; resolves to the total result count. */
  searchCode(query: string): Promise<number>;
  /** "owner/repo" of the product source repository; empty disables the check. */
  codeRepo: string;
}

export async function checkCodeAnchors(
  checkFile: CheckFile,
  deps: CodeAnchorDeps
): Promise<Finding[]> {
  if (!deps.codeRepo || !checkFile.fullContent) return [];

  const shellLines = shellFenceLines(checkFile.fullContent);
  if (shellLines.size === 0) return [];

  // First occurrence line of each flag, added lines only, shell fences only.
  const flagLines = new Map<string, number>();
  for (const { line, text } of addedLines(checkFile.file)) {
    if (!shellLines.has(line)) continue;
    for (const flag of extractFlags(text)) {
      if (!flagLines.has(flag)) flagLines.set(flag, line);
    }
  }
  if (flagLines.size === 0) return [];

  const findings: Finding[] = [];
  let queried = 0;
  for (const [flag, line] of flagLines) {
    if (queried >= MAX_FLAGS_PER_RUN) break;
    queried++;
    let count: number;
    try {
      count = await deps.searchCode(`"${flag}" repo:${deps.codeRepo}`);
    } catch (error) {
      console.log(
        `Code search failed for "${flag}" (${
          error instanceof Error ? error.message : String(error)
        }); skipping`
      );
      continue;
    }
    if (count === 0) {
      findings.push({
        path: checkFile.path,
        line,
        severity: "low",
        category: "accuracy",
        comment:
          `Flag \`${flag}\` was not found in [${deps.codeRepo}](https://github.com/${deps.codeRepo}) ` +
          `via code search. Please verify it still exists in the CLI — it may have been renamed, ` +
          `or it may be defined dynamically (auto-check, not an assertion).`,
        source: "check",
      });
    }
  }
  return findings;
}
