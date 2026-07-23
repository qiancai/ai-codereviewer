import { readFileSync } from "fs";
import { Octokit } from "@octokit/rest";
import { Config } from "./config";
import { GhComment, PRDetails } from "./types";

/** GitHub API access layer: event parsing, diff retrieval, comment posting. */

export type EventData = Record<string, any>;

export function readEventData(): EventData {
  const eventPath = process.env.GITHUB_EVENT_PATH || "";
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH environment variable is not set");
  }
  return JSON.parse(readFileSync(eventPath, "utf8"));
}

export function isCommentTrigger(): boolean {
  return process.env.GITHUB_EVENT_NAME === "issue_comment";
}

export async function getPRDetails(
  octokit: Octokit,
  eventData: EventData
): Promise<PRDetails> {
  let owner: string;
  let repo: string;
  let pull_number: number;

  if (process.env.GITHUB_EVENT_NAME === "issue_comment") {
    if (!eventData.issue?.pull_request) {
      throw new Error("Comment is not on a pull request");
    }
    const urlParts: string[] = eventData.issue.pull_request.url.split("/");
    pull_number = parseInt(urlParts[urlParts.length - 1], 10);
    repo = urlParts[urlParts.length - 3];
    owner = urlParts[urlParts.length - 4];
  } else {
    if (!eventData.repository?.owner) {
      throw new Error("Invalid event data: missing repository information");
    }
    owner = eventData.repository.owner.login;
    repo = eventData.repository.name;
    pull_number = eventData.number || eventData.pull_request?.number;
    if (!pull_number) {
      throw new Error("Invalid event data: missing pull request number");
    }
  }

  const pr = await octokit.pulls.get({ owner, repo, pull_number });
  return {
    owner,
    repo,
    pull_number,
    title: pr.data.title ?? "",
    description: pr.data.body ?? "",
    headSha: pr.data.head.sha,
  };
}

async function getPRDiff(octokit: Octokit, pr: PRDetails): Promise<string> {
  const response = await octokit.pulls.get({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pull_number,
    mediaType: { format: "diff" },
  });
  return response.data as unknown as string;
}

/** Resolve the diff according to REVIEW_MODE and the triggering event. */
export async function getDiff(
  octokit: Octokit,
  cfg: Config,
  pr: PRDetails,
  eventData: EventData
): Promise<string | null> {
  if (isCommentTrigger()) {
    if (cfg.reviewMode === "invalid") return null; // caller handles the reply

    if (cfg.reviewMode === "single_commit" && cfg.commitSha) {
      console.log(`Reviewing single commit: ${cfg.commitSha}`);
      const response = await octokit.repos.getCommit({
        owner: pr.owner,
        repo: pr.repo,
        ref: cfg.commitSha,
        mediaType: { format: "diff" },
      });
      return response.data as unknown as string;
    }

    if (cfg.reviewMode === "commit_range" && cfg.baseSha) {
      let baseSha = cfg.baseSha;
      let headSha = cfg.headSha;
      if (baseSha.includes("..")) {
        const parts = baseSha.split("..");
        baseSha = parts[0];
        headSha = parts.length > 1 ? parts[1] : headSha;
      }
      baseSha = baseSha.trim();
      headSha = headSha.trim();
      if (!baseSha || !headSha) {
        throw new Error(`Invalid commit range: ${baseSha}..${headSha}`);
      }
      console.log(`Comparing commit range: ${baseSha} → ${headSha}`);
      const response = await octokit.repos.compareCommits({
        owner: pr.owner,
        repo: pr.repo,
        base: baseSha,
        head: headSha,
        headers: { accept: "application/vnd.github.v3.diff" },
      });
      return typeof response.data === "string"
        ? response.data
        : String(response.data);
    }

    // default / "latest": the whole PR diff
    return getPRDiff(octokit, pr);
  }

  if (eventData.action === "opened") {
    return getPRDiff(octokit, pr);
  }

  if (eventData.action === "synchronize") {
    const response = await octokit.repos.compareCommits({
      owner: pr.owner,
      repo: pr.repo,
      base: eventData.before,
      head: eventData.after,
      headers: { accept: "application/vnd.github.v3.diff" },
    });
    return typeof response.data === "string"
      ? response.data
      : String(response.data);
  }

  console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
  return null;
}

/** Fetch the full text of a file at a given ref; null when it does not exist. */
export async function getFileContent(
  octokit: Octokit,
  pr: PRDetails,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const response = await octokit.repos.getContent({
      owner: pr.owner,
      repo: pr.repo,
      path,
      ref,
      mediaType: { format: "raw" },
    });
    return response.data as unknown as string;
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 404) return null;
    throw error;
  }
}

export interface ExistingReviewComment {
  path: string;
  line: number | undefined;
  body: string;
  isBot: boolean;
}

/** All review comments on the PR (paginated), for re-run dedupe. */
export async function listReviewComments(
  octokit: Octokit,
  pr: PRDetails
): Promise<ExistingReviewComment[]> {
  const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pull_number,
    per_page: 100,
  });
  return comments.map((c) => ({
    path: c.path,
    line: c.line ?? c.original_line,
    body: c.body ?? "",
    isBot: c.user?.type === "Bot",
  }));
}

export const SUMMARY_MARKER = "<!-- ai-doc-reviewer:summary -->";

/** Create or update the single summary issue-comment for this action. */
export async function upsertSummaryComment(
  octokit: Octokit,
  pr: PRDetails,
  body: string
): Promise<void> {
  const existing = await octokit.paginate(octokit.issues.listComments, {
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.pull_number,
    per_page: 100,
  });
  const mine = existing.find(
    (c) => c.user?.type === "Bot" && (c.body ?? "").includes(SUMMARY_MARKER)
  );
  const fullBody = `${SUMMARY_MARKER}\n${body}`;
  if (mine) {
    await octokit.issues.updateComment({
      owner: pr.owner,
      repo: pr.repo,
      comment_id: mine.id,
      body: fullBody,
    });
  } else {
    await octokit.issues.createComment({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.pull_number,
      body: fullBody,
    });
  }
}

export function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Resource not accessible by integration")
  );
}

/** Post one review with all inline comments; fall back to a plain issue comment. */
export async function postReview(
  octokit: Octokit,
  pr: PRDetails,
  comments: GhComment[]
): Promise<void> {
  try {
    await octokit.pulls.createReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.pull_number,
      commit_id: pr.headSha,
      comments,
      event: "COMMENT",
    });
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    console.log(
      "Permissions issue; posting findings as a regular comment instead"
    );
    const commentBody = `### AI Review Comments\n\n${comments
      .map(
        (c) => `**File:** ${c.path}, **Line:** ${c.line}\n${c.body}\n\n---\n`
      )
      .join("\n")}`;
    await octokit.issues.createComment({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.pull_number,
      body: commentBody,
    });
  }
}

/** Post a plain issue comment (used for command-feedback and error reporting). */
export async function postIssueComment(
  octokit: Octokit,
  pr: PRDetails,
  body: string
): Promise<void> {
  await octokit.issues.createComment({
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.pull_number,
    body,
  });
}
