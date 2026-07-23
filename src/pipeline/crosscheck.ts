import { Config, mainModel } from "../config";
import { chatJson } from "../llm/client";
import { Claim, Digest, validateInconsistencies } from "../llm/schemas";
import { Finding } from "../types";

/**
 * Cross-check stage: compare the extracted claims across files and report
 * contradictions (different defaults, ranges, or terminology for the same
 * thing). Runs on the structured claims table — the comparison input is
 * small and grouped, which keeps this reliable.
 */

/** Claims worth comparing, grouped by "type:name", only when 2+ files disagree-able. */
function groupClaims(claims: Claim[]): Map<string, Claim[]> {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const key = `${claim.type}:${claim.name.toLowerCase()}`;
    const group = groups.get(key) ?? [];
    group.push(claim);
    groups.set(key, group);
  }
  return groups;
}

/** Only groups spanning at least two distinct files can contradict. */
export function findComparableGroups(digest: Digest): Claim[][] {
  const comparable: Claim[][] = [];
  for (const group of groupClaims(digest.claims).values()) {
    const files = new Set(group.map((c) => c.file));
    if (files.size >= 2) comparable.push(group);
  }
  return comparable;
}

function buildCrosscheckPrompt(groups: Claim[][]): string {
  const rendered = groups
    .map(
      (group, i) =>
        `Group ${i + 1} (${group[0].type} "${group[0].name}"):\n` +
        group
          .map(
            (c) =>
              `- ${c.file}${c.line !== null ? `:${c.line}` : ""} says: ${
                c.value
              }`
          )
          .join("\n")
    )
    .join("\n\n");

  return `You are checking a documentation pull request for cross-file inconsistencies. Below are claims extracted from the changed files, grouped by name. Identify genuine contradictions: the same name described with conflicting values or meanings in different files (for example different default values, different valid ranges, or inconsistent definitions of the same term).

Do NOT report:
- Claims that are consistent or merely phrased differently.
- Different things that happen to share a similar name.
- Style or wording issues (those are handled elsewhere).

Respond with JSON only:
{"inconsistencies": [{"file": "<file to anchor the comment on>", "line": <line in that file>, "comment": "<explain the contradiction and name BOTH files>", "severity": "high|medium|low", "category": "accuracy|terminology"}]}

Only report genuine contradictions; return an empty array if there are none.

Claim groups:

${rendered}`;
}

export async function runCrosscheck(
  cfg: Config,
  digest: Digest
): Promise<Finding[]> {
  const groups = findComparableGroups(digest);
  if (groups.length === 0) return [];

  const { findings } = await chatJson(
    cfg,
    {
      model: mainModel(cfg),
      prompt: buildCrosscheckPrompt(groups),
      maxTokens: Math.min(cfg.maxTokens, 2048),
      temperature: 0,
    },
    validateInconsistencies
  );
  return findings;
}
