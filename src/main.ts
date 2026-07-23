import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff, { File } from "parse-diff";
import minimatch from "minimatch";
import { readFileSync } from "fs";
import path from "path";
import { Config, loadConfig, validateApiKeys } from "./config";
import { buildCommentableLines } from "./context";
import { parseGlossary, runChecks } from "./checks";
import { CheckFile, TermRule } from "./checks/types";
import {
  getDiff,
  getFileContent,
  getPRDetails,
  isCommentTrigger,
  isPermissionError,
  listReviewComments,
  postIssueComment,
  postReview,
  readEventData,
  upsertSummaryComment,
} from "./github";
import { detectLanguage, loadStyleGuide } from "./prompts";
import { digestToText, runDigest } from "./pipeline/digest";
import { runCrosscheck } from "./pipeline/crosscheck";
import { reviewFile } from "./pipeline/review";
import { runVerify } from "./pipeline/verify";
import {
  dedupeAgainstExisting,
  dedupeWithinBatch,
  formatBody,
  validateFindings,
} from "./posting";
import { Finding, PRDetails } from "./types";
import { mapPool } from "./util/pool";

const INVALID_COMMAND_HELP = `❌ Invalid command format. Valid formats are:
- \`/bot-review\` - Review latest changes
- \`/bot-review: <commit-sha>\` - Review a single commit
- \`/bot-review: <base>..<head>\` - Review a commit range`;

async function run(): Promise<void> {
  const cfg = loadConfig();
  const keyError = validateApiKeys(cfg);
  if (keyError) {
    core.setFailed(keyError);
    return;
  }

  const octokit = new Octokit({ auth: cfg.githubToken });
  const eventData = readEventData();
  const pr = await getPRDetails(octokit, eventData);
  const commentTrigger = isCommentTrigger();

  if (commentTrigger && cfg.reviewMode === "invalid") {
    await postIssueComment(octokit, pr, INVALID_COMMAND_HELP);
    return;
  }

  let diff: string | null;
  try {
    diff = await getDiff(octokit, cfg, pr, eventData);
  } catch (error) {
    if (isPermissionError(error) && commentTrigger) {
      await postIssueComment(
        octokit,
        pr,
        "❌ Review failed: Insufficient permissions to access repository data. Please check the GitHub token permissions."
      );
    }
    throw error;
  }

  if (diff === null) return; // unsupported event, already logged
  if (diff.trim() === "")
    throw new Error("Failed to retrieve diff from GitHub API");

  const parsedDiff = parseDiff(diff);
  if (!parsedDiff || parsedDiff.length === 0) {
    throw new Error("Failed to parse diff from GitHub API");
  }

  const files = parsedDiff.filter(
    (file) =>
      file.to &&
      file.to !== "/dev/null" &&
      !cfg.exclude.some((pattern) => minimatch(file.to ?? "", pattern))
  );

  if (files.length === 0) {
    console.log("No files to review after filtering");
    if (commentTrigger) {
      await upsertSummaryComment(
        octokit,
        pr,
        "## AI Doc Review\n\n✅ Review completed, no files to review after filtering."
      );
    }
    return;
  }

  console.log(`Reviewing ${files.length} file(s)`);
  const styleGuideSection = loadStyleGuide(cfg);
  const failures: string[] = [];

  // Fetch full documents first (also used for verify excerpts later).
  const fullContents = new Map<string, string | null>();
  await mapPool(files, cfg.concurrency, async (file) => {
    fullContents.set(
      file.to ?? "",
      await fetchFullContent(octokit, cfg, pr, file)
    );
  });

  // --- Deterministic checks (no LLM): run in parallel with the LLM stages
  const checksPromise = runChecks(
    files.map((file): CheckFile => {
      const p = file.to ?? "";
      return {
        path: p,
        file,
        fullContent: fullContents.get(p) ?? null,
        isNew: file.from === "/dev/null" || file.new === true,
      };
    }),
    buildCheckDeps(octokit, cfg, pr)
  );

  // --- Digest stage: PR-wide intent + structured claims ------------------
  let digestText = "";
  let digestSummary = "";
  let digestClaims: import("./llm/schemas").Digest | null = null;
  try {
    digestClaims = await runDigest(cfg, files, pr);
    digestText = digestToText(digestClaims);
    digestSummary = digestText;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Digest stage failed (continuing without it): ${message}`);
    failures.push(`digest stage: ${message}`);
  }

  // --- Review stage: one call per file, full document + digest as context
  const perFile = await mapPool(files, cfg.concurrency, async (file) => {
    const path = file.to ?? "";
    try {
      const findings = await reviewFile(cfg, pr, file, {
        fullContent: fullContents.get(path) ?? null,
        digestText,
        styleGuideSection,
        language: detectLanguage(
          path,
          fullContents.get(path) ?? null,
          cfg.docLanguage || undefined
        ),
      });
      return { findings, failure: null as string | null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Review failed for ${path}: ${message}`);
      return { findings: [] as Finding[], failure: `\`${path}\`: ${message}` };
    }
  });

  let findings = perFile.flatMap((r) => r.findings);
  const fileFailures = perFile.filter((r) => r.failure !== null).length;
  failures.push(...perFile.flatMap((r) => (r.failure ? [r.failure] : [])));

  // --- Cross-check stage: contradictions between files -------------------
  if (digestClaims) {
    try {
      const crossFindings = await runCrosscheck(cfg, digestClaims);
      if (crossFindings.length > 0) {
        console.log(
          `Cross-check found ${crossFindings.length} inconsistency(ies)`
        );
        findings = findings.concat(crossFindings);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Cross-check stage failed (continuing): ${message}`);
      failures.push(`cross-check stage: ${message}`);
    }
  }

  // --- Verify stage: fact-check candidates before posting ----------------
  const droppedByVerify: Array<{ finding: Finding; reason: string }> = [];
  if (findings.length > 0) {
    try {
      const getExcerpt = buildExcerptProvider(files, fullContents);
      const outcome = await runVerify(cfg, findings, getExcerpt);
      findings = outcome.kept;
      droppedByVerify.push(...outcome.dropped);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Verify stage failed, posting findings unverified: ${message}`
      );
      failures.push(`verify stage (findings posted unverified): ${message}`);
    }
  }

  // --- Deterministic check results (skip verify; still validated/deduped)
  const checkResults = await checksPromise;
  if (checkResults.findings.length > 0) {
    console.log(
      `Deterministic checks produced ${checkResults.findings.length} finding(s)`
    );
    findings = findings.concat(checkResults.findings);
  }
  failures.push(...checkResults.failures);

  // --- Posting stage: validate, dedupe, post, report ---------------------
  // Order matters: remap line numbers first, then dedupe against the
  // comments already on the PR using the final (remapped) line numbers.
  const batchDeduped = dedupeWithinBatch(findings);
  const validated = validateFindings(
    batchDeduped.unique,
    buildCommentableLines(files)
  );
  const rerunDeduped = dedupeAgainstExisting(
    validated.kept,
    await listReviewComments(octokit, pr)
  );

  const survivingKeys = new Set(
    rerunDeduped.unique.map((f) => `${f.path}:${f.line}`)
  );
  const finalComments = validated.comments.filter((c) =>
    survivingKeys.has(`${c.path}:${c.line}`)
  );
  const finalKept = rerunDeduped.unique;
  const degraded = validated.degraded;
  const droppedCount =
    batchDeduped.dropped.length + rerunDeduped.dropped.length;

  if (finalComments.length > 0) {
    await postReview(octokit, pr, finalComments);
  }

  await upsertSummaryComment(
    octokit,
    pr,
    buildSummary({
      digestSummary,
      filesReviewed: files.length - fileFailures,
      filesTotal: files.length,
      posted: finalKept,
      degraded,
      droppedCount: droppedCount + droppedByVerify.length,
      verifyDropped: droppedByVerify,
      failures,
    })
  );

  console.log(
    `Done: ${finalKept.length} comment(s) posted, ${
      degraded.length
    } degraded, ${droppedCount + droppedByVerify.length} dropped, ${
      failures.length
    } failure(s)`
  );
}

/** Fetch the full file at the PR head; null when too large or unavailable. */
async function fetchFullContent(
  octokit: Octokit,
  cfg: Config,
  pr: PRDetails,
  file: File
): Promise<string | null> {
  const path = file.to;
  if (!path) return null;
  try {
    const content = await getFileContent(octokit, pr, path, pr.headSha);
    if (content && content.length / 1024 > cfg.maxFileKb) {
      console.log(
        `${path} is ${(content.length / 1024).toFixed(0)}KB (> ${
          cfg.maxFileKb
        }KB), reviewing diff hunks only`
      );
      return null;
    }
    return content;
  } catch (error) {
    console.log(
      `Could not fetch full content for ${path} (${
        error instanceof Error ? error.message : String(error)
      }); reviewing diff hunks only`
    );
    return null;
  }
}

/** Load and parse the glossary file for the terms check. */
function loadGlossary(cfg: Config): TermRule[] {
  if (!cfg.glossaryPath) return [];
  const p = path.isAbsolute(cfg.glossaryPath)
    ? cfg.glossaryPath
    : path.resolve(process.cwd(), cfg.glossaryPath);
  try {
    const rules = parseGlossary(readFileSync(p, "utf8"));
    console.log(`Loaded ${rules.length} terminology rule(s) from ${p}`);
    return rules;
  } catch {
    core.warning(`Glossary file not found at: ${p}. Terms check disabled.`);
    return [];
  }
}

/** Wire the side-effecting operations the deterministic checks need. */
function buildCheckDeps(
  octokit: Octokit,
  cfg: Config,
  pr: PRDetails
): import("./checks").CheckDeps {
  const contentCache = new Map<string, Promise<string | null>>();
  const readFileAtHead = (p: string): Promise<string | null> => {
    if (!contentCache.has(p)) {
      contentCache.set(
        p,
        getFileContent(octokit, pr, p, pr.headSha).catch((error) => {
          console.log(
            `Could not read ${p} at head: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return null;
        })
      );
    }
    return contentCache.get(p)!;
  };

  return {
    fileExistsAtHead: async (p) => (await readFileAtHead(p)) !== null,
    readFileAtHead,
    searchRepo: async (query) => {
      const result = await octokit.search.code({
        q: `${query} repo:${pr.owner}/${pr.repo}`,
        per_page: 20,
      });
      return result.data.items.map((item) => item.path);
    },
    searchCode: async (query) => {
      const result = await octokit.search.code({ q: query, per_page: 1 });
      return result.data.total_count;
    },
    glossary: loadGlossary(cfg),
    tocPath: cfg.tocPath,
    codeRepo: cfg.codeRepo,
    docLanguage: cfg.docLanguage,
    enabled: cfg.checks,
  };
}

/**
 * Excerpt provider for the verify stage: prefer the full document (±2 lines
 * around the finding), fall back to the lines visible in the diff.
 */
function buildExcerptProvider(
  files: File[],
  fullContents: Map<string, string | null>
): (path: string, line: number) => string {
  const diffLines = new Map<string, Map<number, string>>();
  for (const file of files) {
    if (!file.to) continue;
    const byLine = diffLines.get(file.to) ?? new Map<number, string>();
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === "add")
          byLine.set(change.ln, change.content.slice(1));
        else if (change.type === "normal")
          byLine.set(change.ln2, change.content.slice(1));
      }
    }
    diffLines.set(file.to, byLine);
  }

  const fullLines = new Map<string, string[]>();
  for (const [path, content] of fullContents) {
    if (content) fullLines.set(path, content.split("\n"));
  }

  return (path, line) => {
    const full = fullLines.get(path);
    if (full) {
      const start = Math.max(1, line - 2);
      const end = Math.min(full.length, line + 2);
      const rows: string[] = [];
      for (let n = start; n <= end; n++) rows.push(`${n}: ${full[n - 1]}`);
      return rows.join("\n");
    }
    const byLine = diffLines.get(path);
    if (!byLine) return "";
    const rows: string[] = [];
    for (let n = line - 2; n <= line + 2; n++) {
      const text = byLine.get(n);
      if (text !== undefined) rows.push(`${n}: ${text}`);
    }
    return rows.join("\n");
  };
}

interface SummaryInput {
  digestSummary: string;
  filesReviewed: number;
  filesTotal: number;
  posted: Finding[];
  degraded: Finding[];
  droppedCount: number;
  verifyDropped: Array<{ finding: Finding; reason: string }>;
  failures: string[];
}

function buildSummary(input: SummaryInput): string {
  const lines: string[] = ["## AI Doc Review", ""];

  if (input.digestSummary) {
    lines.push("### What this PR changes", "", input.digestSummary, "");
  }

  if (
    input.failures.length === 0 &&
    input.posted.length === 0 &&
    input.degraded.length === 0
  ) {
    lines.push("✅ Review completed, no issues found.");
  } else {
    lines.push(
      `Reviewed ${input.filesReviewed}/${input.filesTotal} file(s): ` +
        `**${input.posted.length}** inline comment(s) posted` +
        (input.droppedCount > 0
          ? `, ${input.droppedCount} filtered or duplicate`
          : "") +
        (input.failures.length > 0
          ? `, **${input.failures.length} failure(s)**`
          : "") +
        "."
    );
  }

  if (input.degraded.length > 0) {
    lines.push("", "### Findings that could not be anchored to the diff", "");
    for (const f of input.degraded) {
      lines.push(`- \`${f.path}\` (line ~${f.line}): ${formatBody(f)}`);
    }
  }

  if (input.failures.length > 0) {
    lines.push("", "### ❌ Failures", "");
    for (const f of input.failures) lines.push(`- ${f}`);
  }

  return lines.join("\n");
}

run().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(`Error in AI Review: ${message}`);
  console.error("Error details:", error);

  // Best-effort error feedback on the PR for comment-triggered runs.
  try {
    if (isCommentTrigger()) {
      const cfg = loadConfig();
      const octokit = new Octokit({ auth: cfg.githubToken });
      const pr = await getPRDetails(octokit, readEventData());
      await postIssueComment(octokit, pr, `❌ AI review failed: ${message}`);
    }
  } catch (nested) {
    console.error("Failed to post error comment:", nested);
  }
});
