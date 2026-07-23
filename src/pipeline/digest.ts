import { File } from "parse-diff";
import { Config, helperModel } from "../config";
import { chatJson } from "../llm/client";
import { Digest, validateDigest } from "../llm/schemas";
import { PRDetails } from "../types";

/**
 * Digest stage: one cheap call over the whole PR producing
 *  - a short intent summary,
 *  - a per-file summary,
 *  - a structured "claims" table (terms, defaults, ranges, versions,
 *    commands) used later for cross-file consistency checking.
 *
 * extract-then-compare: the model is good at extracting structured claims
 * per file; comparing them afterwards is then trivial and reliable.
 */

const PER_FILE_DIFF_CAP = 8000;
const TOTAL_DIFF_CAP = 60000;
const MAX_CLAIMS = 50;

function buildDigestPrompt(files: File[], pr: PRDetails): string {
  const sections: string[] = [];
  let budget = TOTAL_DIFF_CAP;

  for (const file of files) {
    if (budget <= 0) break;
    let diffText = file.chunks
      .map((chunk) => {
        const changes = chunk.changes
          .map((c) => {
            const line =
              c.type === "del" ? c.ln : c.type === "add" ? c.ln : c.ln2;
            return `${line} ${c.content}`;
          })
          .join("\n");
        return `${chunk.content}\n${changes}`;
      })
      .join("\n");
    if (diffText.length > Math.min(PER_FILE_DIFF_CAP, budget)) {
      diffText =
        diffText.slice(0, Math.min(PER_FILE_DIFF_CAP, budget)) +
        "\n... (diff truncated)";
    }
    budget -= diffText.length;
    sections.push(`<file path="${file.to}">\n${diffText}\n</file>`);
  }

  return `You are analyzing a documentation pull request. Produce a JSON digest with this structure:

{"intent": "<2-3 sentences describing what the PR does>", "files": [{"path": "<file path>", "summary": "<one sentence on what changed>"}], "claims": [{"type": "term|parameter|default|range|version|command", "name": "<the term/parameter/command name>", "value": "<the statement made about it>", "file": "<file path>", "line": <line number in the new file, or null>}]}

Claims are statements the documentation makes that could be checked for consistency across files: defined terms, parameter default values, valid ranges, version numbers, command names, paths.
Extract at most ${MAX_CLAIMS} claims, only meaningful ones. Respond with JSON only.

Pull request title: ${pr.title}
Pull request description:

---
${pr.description}
---

Changed files and their diffs (line numbers refer to the new file):

${sections.join("\n\n")}`;
}

export async function runDigest(
  cfg: Config,
  files: File[],
  pr: PRDetails
): Promise<Digest> {
  const { digest } = await chatJson(
    cfg,
    {
      model: helperModel(cfg),
      prompt: buildDigestPrompt(files, pr),
      maxTokens: Math.min(cfg.maxTokens, 4096),
      temperature: 0,
    },
    validateDigest
  );
  return digest;
}

/** Compact text rendering of the digest, injected into per-file review prompts. */
export function digestToText(digest: Digest): string {
  const lines: string[] = [];
  if (digest.intent) lines.push(`Intent: ${digest.intent}`);
  for (const f of digest.files) {
    lines.push(`- ${f.path}: ${f.summary}`);
  }
  return lines.join("\n");
}
