import * as core from "@actions/core";

export interface Config {
  githubToken: string;
  provider: "openai" | "deepseek";
  openaiApiKey: string;
  openaiModel: string;
  deepseekApiKey: string;
  deepseekModel: string;
  /** Cheaper model for digest/verify stages. Falls back to the main model when empty. */
  fastModel: string;
  reviewMode: string;
  commitSha: string;
  baseSha: string;
  headSha: string;
  promptPath: string;
  /** Extra context file injected into every review prompt (style guide). */
  styleGuidePath: string;
  /** Terminology file for deterministic term linting ("preferred: banned1, banned2"). */
  glossaryPath: string;
  /** Deterministic checks to run: anchors, links, images, terms, toc, zh, code. */
  checks: string[];
  /** Literal path of the docs navigation file for the toc check. */
  tocPath: string;
  /** "owner/repo" of the product source repo for the code check. */
  codeRepo: string;
  /** Force the documentation language for all files (empty = auto-detect). */
  docLanguage: string;
  exclude: string[];
  /** Files larger than this fall back to diff-hunk-only review. */
  maxFileKb: number;
  maxTokens: number;
  concurrency: number;
}

function getInt(name: string, fallback: number): number {
  const raw = core.getInput(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    core.warning(
      `Invalid value for ${name}: "${raw}", falling back to ${fallback}`
    );
    return fallback;
  }
  return Math.floor(n);
}

export function loadConfig(): Config {
  const provider = (core.getInput("API_PROVIDER") || "openai").toLowerCase();
  if (provider !== "openai" && provider !== "deepseek") {
    throw new Error(`Unsupported API_PROVIDER: ${provider}`);
  }

  const openaiModel = core.getInput("OPENAI_API_MODEL");
  const deepseekModel = core.getInput("DEEPSEEK_API_MODEL");
  const fastModel = core.getInput("FAST_MODEL");

  return {
    githubToken: core.getInput("GITHUB_TOKEN", { required: true }),
    provider,
    openaiApiKey: core.getInput("OPENAI_API_KEY"),
    openaiModel,
    deepseekApiKey: core.getInput("DEEPSEEK_API_KEY"),
    deepseekModel,
    fastModel,
    reviewMode: core.getInput("REVIEW_MODE") || "default",
    commitSha: core.getInput("COMMIT_SHA") || "",
    baseSha: core.getInput("BASE_SHA") || "",
    headSha: core.getInput("HEAD_SHA") || "",
    promptPath: core.getInput("PROMPT_PATH") || "",
    styleGuidePath: core.getInput("STYLE_GUIDE_PATH") || "",
    glossaryPath: core.getInput("GLOSSARY_PATH") || "",
    checks: (core.getInput("CHECKS") || "anchors,links,images,typography")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    tocPath: core.getInput("TOC_PATH") || "",
    codeRepo: core.getInput("CODE_REPO") || "",
    docLanguage: core.getInput("DOC_LANGUAGE") || "",
    exclude: (core.getInput("exclude") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxFileKb: getInt("MAX_FILE_KB", 50),
    maxTokens: getInt("MAX_TOKENS", 4096),
    concurrency: getInt("CONCURRENCY", 4),
  };
}

/** The model used for the strong review stages. */
export function mainModel(cfg: Config): string {
  return cfg.provider === "openai" ? cfg.openaiModel : cfg.deepseekModel;
}

/** The model used for cheap helper stages (digest, verify). */
export function helperModel(cfg: Config): string {
  return cfg.fastModel || mainModel(cfg);
}

export function validateApiKeys(cfg: Config): string | null {
  if (cfg.provider === "openai" && !cfg.openaiApiKey) {
    return "OPENAI_API_KEY is required when API_PROVIDER is set to 'openai'";
  }
  if (cfg.provider === "deepseek" && !cfg.deepseekApiKey) {
    return "DEEPSEEK_API_KEY is required when API_PROVIDER is set to 'deepseek'";
  }
  return null;
}
