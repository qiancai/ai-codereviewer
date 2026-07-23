import { Config, helperModel } from "../config";
import { chatJson } from "../llm/client";
import { validateVerdicts } from "../llm/schemas";
import { Finding } from "../types";

/**
 * Verify stage: re-check every candidate finding against its source excerpt
 * before anything is posted. This is the noise-control knob that makes it
 * safe to run higher-recall review stages. Findings below the confidence
 * threshold are dropped with a reason.
 */

const KEEP_CONFIDENCE_THRESHOLD = 50;
const BATCH_SIZE = 20;

export interface VerifyOutcome {
  kept: Finding[];
  dropped: Array<{ finding: Finding; reason: string }>;
}

/** Provide the text around a finding's line so the verifier can fact-check. */
export type ExcerptProvider = (path: string, line: number) => string;

interface Candidate {
  id: number;
  finding: Finding;
  excerpt: string;
}

function buildVerifyPrompt(candidates: Candidate[]): string {
  const rendered = candidates
    .map(
      (c) =>
        `{"id": ${c.id}, "file": ${JSON.stringify(c.finding.path)}, "line": ${
          c.finding.line
        }, "category": ${JSON.stringify(
          c.finding.category
        )}, "comment": ${JSON.stringify(
          c.finding.comment
        )}, "excerpt": ${JSON.stringify(c.excerpt)}}`
    )
    .join("\n");

  return `You are verifying candidate documentation review findings before they are posted to a pull request. For each candidate, decide whether it is a genuine, actionable issue.

Drop a candidate when:
- The comment is factually wrong or contradicts the excerpt.
- It nitpicks something that is already correct and clear.
- It misreads Markdown syntax or code-block content as prose.

Keep genuine issues of accuracy, logic, clarity, terminology, or structure.

Respond with JSON only:
{"verdicts": [{"id": <number>, "keep": <true|false>, "confidence": <0-100>, "reason": "<one short sentence>"}]}

Candidates (one per line):

${rendered}`;
}

/**
 * Verify findings in batches. Fail-open design: callers decide what to do
 * when this stage throws (the failure is reported in the summary).
 */
export async function runVerify(
  cfg: Config,
  findings: Finding[],
  getExcerpt: ExcerptProvider
): Promise<VerifyOutcome> {
  const kept: Finding[] = [];
  const dropped: VerifyOutcome["dropped"] = [];
  if (findings.length === 0) return { kept, dropped };

  const candidates: Candidate[] = findings.map((finding, id) => ({
    id,
    finding,
    excerpt: getExcerpt(finding.path, finding.line),
  }));

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const { verdicts } = await chatJson(
      cfg,
      {
        model: helperModel(cfg),
        prompt: buildVerifyPrompt(batch),
        maxTokens: Math.min(cfg.maxTokens, 2048),
        temperature: 0,
      },
      validateVerdicts
    );

    const byId = new Map(verdicts.map((v) => [v.id, v]));
    for (const candidate of batch) {
      const verdict = byId.get(candidate.id);
      if (!verdict) {
        // Missing verdict: keep the finding but say so (never a silent drop).
        kept.push(candidate.finding);
        continue;
      }
      if (verdict.keep && verdict.confidence >= KEEP_CONFIDENCE_THRESHOLD) {
        kept.push(candidate.finding);
      } else {
        dropped.push({
          finding: candidate.finding,
          reason:
            verdict.reason ||
            `filtered by verification (confidence ${verdict.confidence})`,
        });
      }
    }
  }

  return { kept, dropped };
}
