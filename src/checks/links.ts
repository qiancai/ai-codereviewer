import path from "path";
import { anchorize, extractHeadings } from "../context";
import { Finding } from "../types";
import { addedLines, CheckDeps, CheckFile } from "./types";

/**
 * Link and image checking on added lines:
 * - relative page links must resolve to an existing file at the PR head;
 * - `#anchor` parts must resolve to a heading in the target file;
 * - image sources must exist.
 * External URLs (http/https/mailto/...) are skipped by design.
 */

interface LinkRef {
  line: number;
  target: string;
  isImage: boolean;
  raw: string;
}

const LINK_RE = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL_RE = /^[a-z][a-z0-9+.-]*:/i;

export function extractLinks(text: string, line: number): LinkRef[] {
  const refs: LinkRef[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const target = m[2].trim();
    if (EXTERNAL_RE.test(target)) continue; // http:, mailto:, tel:, data:, ...
    refs.push({ line, target, isImage: m[1] === "!", raw: m[0] });
  }
  return refs;
}

function splitTarget(target: string): { filePart: string; anchorPart: string } {
  const hash = target.indexOf("#");
  if (hash === -1) return { filePart: target, anchorPart: "" };
  return {
    filePart: target.slice(0, hash),
    anchorPart: decodeURIComponent(target.slice(hash + 1)),
  };
}

/** Resolve a link target relative to the linking file's directory. */
export function resolveTarget(fromFile: string, filePart: string): string {
  const decoded = decodeURIComponent(filePart);
  if (decoded.startsWith("/")) return decoded.slice(1);
  const dir = path.posix.dirname(fromFile);
  return path.posix.normalize(path.posix.join(dir, decoded));
}

export async function checkLinksAndImages(
  checkFile: CheckFile,
  deps: Pick<CheckDeps, "fileExistsAtHead" | "readFileAtHead">,
  mode: { links: boolean; images: boolean }
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const ownHeadings = checkFile.fullContent
    ? new Set(extractHeadings(checkFile.fullContent).map((h) => h.anchor))
    : null;
  const headingCache = new Map<string, Set<string> | null>();

  async function headingsOf(file: string): Promise<Set<string> | null> {
    if (file === checkFile.path && ownHeadings) return ownHeadings;
    if (!headingCache.has(file)) {
      const content = await deps.readFileAtHead(file);
      headingCache.set(
        file,
        content ? new Set(extractHeadings(content).map((h) => h.anchor)) : null
      );
    }
    return headingCache.get(file) ?? null;
  }

  for (const { line, text } of addedLines(checkFile.file)) {
    for (const ref of extractLinks(text, line)) {
      if (ref.isImage && !mode.images) continue;
      if (!ref.isImage && !mode.links) continue;

      const { filePart, anchorPart } = splitTarget(ref.target);

      // Same-file anchor reference.
      if (filePart === "") {
        if (
          anchorPart &&
          ownHeadings &&
          !ownHeadings.has(anchorize(anchorPart)) &&
          !ownHeadings.has(anchorPart)
        ) {
          findings.push({
            path: checkFile.path,
            line,
            severity: "medium",
            category: "accuracy",
            comment: `Broken anchor: no heading matches \`#${anchorPart}\` in this document.`,
            source: "check",
          });
        }
        continue;
      }

      const resolved = resolveTarget(checkFile.path, filePart);
      const exists = await deps.fileExistsAtHead(resolved);
      if (!exists) {
        findings.push({
          path: checkFile.path,
          line,
          severity: "high",
          category: "accuracy",
          comment: ref.isImage
            ? `Missing image: \`${resolved}\` does not exist at the PR head.`
            : `Broken link: \`${resolved}\` does not exist at the PR head.`,
          source: "check",
        });
        continue;
      }

      if (anchorPart && !ref.isImage) {
        const anchors = await headingsOf(resolved);
        if (
          anchors &&
          !anchors.has(anchorPart) &&
          !anchors.has(anchorize(anchorPart))
        ) {
          findings.push({
            path: checkFile.path,
            line,
            severity: "medium",
            category: "accuracy",
            comment: `Broken anchor: \`${resolved}\` has no heading matching \`#${anchorPart}\`.`,
            source: "check",
          });
        }
      }
    }
  }
  return findings;
}
