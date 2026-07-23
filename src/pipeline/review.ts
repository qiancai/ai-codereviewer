import { Chunk, File } from "parse-diff";
import { Config, mainModel } from "../config";
import { chatJson } from "../llm/client";
import { validateReviews } from "../llm/schemas";
import {
  digestSection,
  DocLanguage,
  fullContentSection,
  languageName,
  loadPromptTemplate,
  renderTemplate,
} from "../prompts";
import { Finding, PRDetails } from "../types";

/**
 * Per-file review stage: one LLM call per file (not per hunk), with the
 * full document, the PR-wide digest, and the style guide as context.
 */

export interface ReviewFileContext {
  fullContent: string | null;
  digestText: string;
  styleGuideSection: string;
  language: DocLanguage;
}

function formatChunkChanges(chunk: Chunk): string {
  return chunk.changes
    .map((c) => {
      const line = c.type === "del" ? c.ln : c.type === "add" ? c.ln : c.ln2;
      return `${line} ${c.content}`;
    })
    .join("\n");
}

function formatFileDiff(file: File): {
  diffContent: string;
  diffChanges: string;
} {
  const diffContent = file.chunks.map((c) => c.content).join("\n");
  const diffChanges = file.chunks.map(formatChunkChanges).join("\n");
  return { diffContent, diffChanges };
}

const SYSTEM_PROMPT =
  "You are an expert technical writer who provides detailed, helpful documentation reviews in JSON format.";

/** Review one file; returns findings (empty only when the model truly found none). */
export async function reviewFile(
  cfg: Config,
  pr: PRDetails,
  file: File,
  ctx: ReviewFileContext
): Promise<Finding[]> {
  const template = loadPromptTemplate(cfg, ctx.language);
  const { diffContent, diffChanges } = formatFileDiff(file);

  const prompt =
    renderTemplate(template, {
      filename: file.to ?? "",
      title: pr.title,
      description: pr.description,
      diff_content: diffContent,
      diff_changes: diffChanges,
      digest: digestSection(ctx.digestText),
      style_guide: ctx.styleGuideSection,
      full_content: fullContentSection(ctx.fullContent),
    }) +
    `\n\nThe documentation is written in ${languageName(
      ctx.language
    )}. Write every review comment and suggestion in that language.`;

  const { reviews } = await chatJson(
    cfg,
    {
      model: mainModel(cfg),
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: cfg.maxTokens,
    },
    (u) => validateReviews(u, file.to ?? "")
  );
  return reviews;
}
