import { anchorize } from "../context";
import { Finding } from "../types";
import { CheckDeps, CheckFile, removedHeadings } from "./types";

/**
 * Anchor breakage check — the classic docs-PR landmine: renaming a heading
 * breaks `#old-anchor` links in OTHER files, invisible in the diff.
 *
 * For each heading removed from a changed file, search the repo for
 * references to the old anchor and report every referencing location.
 * Those files are usually not in the diff, so these findings degrade to
 * the run summary (line validation handles that).
 */

const MAX_REMOVED_HEADINGS = 20;
const MAX_REFERENCES_PER_ANCHOR = 5;

export async function checkAnchorBreakage(
  checkFile: CheckFile,
  deps: Pick<CheckDeps, "searchRepo" | "readFileAtHead">
): Promise<Finding[]> {
  const removed = removedHeadings(checkFile.file).slice(
    0,
    MAX_REMOVED_HEADINGS
  );
  if (removed.length === 0) return [];

  const findings: Finding[] = [];
  for (const heading of removed) {
    const anchor = anchorize(heading);
    if (!anchor) continue;

    // References look like `file.md#anchor` or `(#anchor` in other files.
    let referrers: string[] = [];
    try {
      referrers = await deps.searchRepo(`#${anchor}`);
    } catch (error) {
      console.log(
        `Repo search failed for anchor "${anchor}" (${
          error instanceof Error ? error.message : String(error)
        }); skipping`
      );
      continue;
    }

    for (const refPath of referrers
      .filter((p) => p !== checkFile.path)
      .slice(0, MAX_REFERENCES_PER_ANCHOR)) {
      const line = await locateReference(deps, refPath, anchor);
      findings.push({
        path: refPath,
        line: line ?? 1,
        severity: "high",
        category: "accuracy",
        comment:
          `This file links to \`${checkFile.path}#${anchor}\`, but the heading "${heading}" ` +
          `is removed or renamed in this PR. The anchor link will break.`,
        source: "check",
      });
    }
  }
  return findings;
}

/** Find the first line in `refPath` that references `#anchor`. */
async function locateReference(
  deps: Pick<CheckDeps, "readFileAtHead">,
  refPath: string,
  anchor: string
): Promise<number | null> {
  const content = await deps.readFileAtHead(refPath);
  if (!content) return null;
  const needle = `#${anchor}`;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return null;
}
