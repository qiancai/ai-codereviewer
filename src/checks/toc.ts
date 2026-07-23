import path from "path";
import { Finding } from "../types";
import { CheckDeps, CheckFile } from "./types";

/**
 * TOC check: a newly added Markdown file should be referenced by the docs
 * navigation file (e.g. TOC.md). Unreferenced pages are unreachable.
 */
export async function checkToc(
  checkFile: CheckFile,
  deps: Pick<CheckDeps, "readFileAtHead"> & { tocPath: string }
): Promise<Finding[]> {
  if (!deps.tocPath || !checkFile.isNew || !checkFile.path.endsWith(".md")) {
    return [];
  }

  const tocContent = await deps.readFileAtHead(deps.tocPath);
  if (!tocContent) return [];

  const base = path.posix.basename(checkFile.path);
  if (tocContent.includes(checkFile.path) || tocContent.includes(base)) {
    return [];
  }

  return [
    {
      path: checkFile.path,
      line: 1,
      severity: "low",
      category: "structure",
      comment: `This new page is not referenced in \`${deps.tocPath}\`. Readers will not be able to navigate to it.`,
      source: "check",
    },
  ];
}
