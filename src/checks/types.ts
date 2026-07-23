import { File } from "parse-diff";

/** Shared types for deterministic (no-LLM) documentation checks. */

export interface CheckFile {
  path: string;
  /** Parsed-diff entry for this file. */
  file: File;
  /** Full content at the PR head; null when unavailable. */
  fullContent: string | null;
  /** True when the file is added by this PR. */
  isNew: boolean;
}

export interface TermRule {
  preferred: string;
  banned: string[];
}

/** Side-effecting operations the checks need, supplied by the caller. */
export interface CheckDeps {
  /** Whether a path exists at the PR head. */
  fileExistsAtHead(path: string): Promise<boolean>;
  /** File content at the PR head; null when missing/unreadable. */
  readFileAtHead(path: string): Promise<string | null>;
  /** Repo-wide search; returns paths of files containing the query string. */
  searchRepo(query: string): Promise<string[]>;
  /** Arbitrary code-search query; resolves to the total result count. */
  searchCode(query: string): Promise<number>;
  glossary: TermRule[];
  /** Literal path of the docs navigation file (empty disables the toc check). */
  tocPath: string;
  /** "owner/repo" of the product source repo for the code check (empty disables it). */
  codeRepo: string;
  /** Forced document language for detection (empty = auto-detect). */
  docLanguage: string;
  /** Enabled check names: anchors, links, images, terms, toc, typography, zh, code. */
  enabled: string[];
}

export interface AddedLine {
  line: number;
  text: string;
}

/** Added lines of a file with their new-side line numbers. */
export function addedLines(file: File): AddedLine[] {
  const out: AddedLine[] = [];
  for (const chunk of file.chunks) {
    for (const change of chunk.changes) {
      if (change.type === "add") {
        out.push({ line: change.ln, text: change.content.slice(1) });
      }
    }
  }
  return out;
}

/** Removed heading texts of a file (from deleted diff lines). */
export function removedHeadings(file: File): string[] {
  const out: string[] = [];
  for (const chunk of file.chunks) {
    for (const change of chunk.changes) {
      if (change.type === "del") {
        const m = change.content.slice(1).match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
        if (m) out.push(m[1].trim());
      }
    }
  }
  return out;
}

/** Line numbers that are inside fenced code blocks (1-based). */
export function fencedLines(content: string): Set<number> {
  const fenced = new Set<number>();
  let inFence = false;
  let marker = "";
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      if (!inFence) {
        inFence = true;
        marker = m[1][0];
      } else if (m[1][0] === marker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) fenced.add(i + 1);
  }
  return fenced;
}
