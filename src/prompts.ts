import { readFileSync } from "fs";
import path from "path";
import * as core from "@actions/core";
import { Config } from "./config";

/**
 * Prompt template loading and rendering.
 *
 * Template variables (all optional in custom templates; unknown ones render
 * as empty strings so old custom templates keep working):
 *   ${filename} ${title} ${description} ${diff_content} ${diff_changes}
 *   ${digest} ${style_guide} ${full_content}
 */

/**
 * Documentation language, as an ISO-ish code: "en", "zh", "ja", "fr", ...
 * The value "en" is also the fallback when detection is inconclusive.
 */
export type DocLanguage = string;

/**
 * Path-based language conventions: `/zh/`, `docs/ja/guide.md`,
 * `guide_fr.md`, `guide.fr.md`, `i18n/de/...`. A language code must appear
 * as a full path segment or be delimited by `_-.` to avoid matching words
 * like "design" (de) or "portal" (pt).
 */
const PATH_LANGUAGE_RULES: Array<[RegExp, string]> = [
  [/(^|[\/_.-])zh([-_]?cn|[-_]?hans)?([\/_.-]|$)/i, "zh"],
  [/(^|[\/_.-])(ja|jp|ja[-_]jp)([\/_.-]|$)/i, "ja"],
  [/(^|[\/_.-])(ko|kr|ko[-_]kr)([\/_.-]|$)/i, "ko"],
  [/(^|[\/_.-])(fr|fr[-_]fr)([\/_.-]|$)/i, "fr"],
  [/(^|[\/_.-])(de|de[-_]de)([\/_.-]|$)/i, "de"],
  [/(^|[\/_.-])(es|es[-_]es)([\/_.-]|$)/i, "es"],
  [/(^|[\/_.-])(pt|pt[-_]br|pt[-_]pt)([\/_.-]|$)/i, "pt"],
  [/(^|[\/_.-])(it|it[-_]it)([\/_.-]|$)/i, "it"],
  [/(^|[\/_.-])(nl|nl[-_]nl)([\/_.-]|$)/i, "nl"],
  [/(^|[\/_.-])(ru|ru[-_]ru)([\/_.-]|$)/i, "ru"],
  [/(^|[\/_.-])(ar|ar[-_]sa)([\/_.-]|$)/i, "ar"],
];

function countMatches(content: string, re: RegExp): number {
  return (content.match(re) ?? []).length;
}

/**
 * Script-based detection. Order matters: kana marks Japanese before the
 * Han check (Chinese docs contain no kana), Hangul marks Korean. This
 * ordering is what keeps zh-only rules away from Japanese documents.
 */
function detectByScript(content: string): DocLanguage | null {
  if (countMatches(content, /[぀-ヿ]/g) >= 2) return "ja";
  if (countMatches(content, /[가-힯]/g) >= 2) return "ko";
  if (countMatches(content, /[一-鿿]/g) > 20) return "zh";
  if (countMatches(content, /[Ѐ-ӿ]/g) > 20) return "ru";
  if (countMatches(content, /[؀-ۿ]/g) > 20) return "ar";
  if (countMatches(content, /[฀-๿]/g) > 10) return "th";
  if (countMatches(content, /[ऀ-ॿ]/g) > 10) return "hi";
  return null;
}

/** Stop-word scoring for Latin-script languages (fr/de/es). */
const STOPWORDS: Array<[string, string[]]> = [
  [
    "fr",
    [
      "le",
      "la",
      "les",
      "des",
      "une",
      "est",
      "dans",
      "pour",
      "avec",
      "vous",
      "nous",
      "cette",
    ],
  ],
  [
    "de",
    [
      "der",
      "die",
      "das",
      "und",
      "ist",
      "für",
      "mit",
      "eine",
      "einer",
      "nicht",
      "sie",
      "den",
    ],
  ],
  [
    "es",
    [
      "el",
      "la",
      "los",
      "las",
      "una",
      "es",
      "para",
      "con",
      "por",
      "esta",
      "este",
      "como",
    ],
  ],
];

function detectByStopwords(content: string): DocLanguage | null {
  const sample = content.slice(0, 5000).toLowerCase();
  const scores: Array<[string, number]> = STOPWORDS.map(([lang, words]) => [
    lang,
    words.reduce(
      (sum, w) => sum + countMatches(sample, new RegExp(`\\b${w}\\b`, "g")),
      0
    ),
  ]);
  scores.sort((a, b) => b[1] - a[1]);
  const [topLang, topScore] = scores[0];
  const secondScore = scores[1]?.[1] ?? 0;
  // Conservative: require enough hits and a clear margin, else fall back.
  if (topScore >= 5 && topScore >= secondScore + 3) return topLang;
  return null;
}

/**
 * Detect the documentation language of a file.
 * Precedence: explicit override → path conventions → script heuristics →
 * stop-word scoring → "en". Latin-script languages other than fr/de/es are
 * not distinguishable from English by heuristics; use path conventions or
 * the DOC_LANGUAGE override for those.
 */
export function detectLanguage(
  filePath: string,
  content: string | null,
  override?: string
): DocLanguage {
  if (override) return override;
  for (const [re, lang] of PATH_LANGUAGE_RULES) {
    if (re.test(filePath)) return lang;
  }
  if (content) {
    const byScript = detectByScript(content);
    if (byScript) return byScript;
    const byStopwords = detectByStopwords(content);
    if (byStopwords) return byStopwords;
  }
  return "en";
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
  es: "Spanish",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  ru: "Russian",
  ar: "Arabic",
  th: "Thai",
  hi: "Hindi",
};

/** Display name of a language code, for prompt instructions. */
export function languageName(lang: DocLanguage): string {
  return LANGUAGE_NAMES[lang] ?? lang;
}

/**
 * Language-specific sibling of a template path:
 * `prompts/review.txt` + "ja" → `prompts/review.ja.txt`.
 */
export function languageVariantPath(base: string, lang: DocLanguage): string {
  const ext = path.extname(base);
  if (!ext) return `${base}.${lang}`;
  return `${base.slice(0, -ext.length)}.${lang}${ext}`;
}

export const DEFAULT_PROMPT_EN = `As a technical writer who has profound knowledge of databases, your task is to review pull requests of user documentation.

IMPORTANT: You MUST follow these formatting instructions exactly:
1. Your response MUST be a valid JSON object with the following structure:
   {"reviews": [{"line": <line_number>, "end_line": <optional_line_number>, "severity": "high|medium|low", "category": "accuracy|logic|clarity|terminology|structure|grammar", "comment": "<review comment>", "suggestion": "<improved replacement text>"}]}
2. Do NOT include any markdown code blocks (like \`\`\`json) around your JSON.
3. Ensure all JSON keys and values are properly quoted with double quotes.
4. Do NOT include any explanations or text outside of the JSON object.
5. Line numbers refer to the NEW version of the file. Only comment on lines that appear in the diff below.
6. Use "end_line" only when the suggestion should replace a range of lines (line..end_line inclusive); otherwise omit it.

Review Guidelines:
- Do not give positive comments or compliments.
- Do not improve the wording of UI strings or messages returned by CLI inside code blocks.
- Focus on improving the clarity, accuracy, and readability of the content.
- Ensure the documentation is easy to understand for users.
- Review not just the wording but also the logic and structure of the content.
- When the full document or a PR-wide digest is provided below, use them to check consistency with the surrounding content and with other changed files. Even then, comment ONLY on lines that appear in the diff.
- Provide "reviews" ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the review comment in the language of the documentation.
- For EVERY review comment of a specific line, "suggestion" MUST be the improved replacement for the original line(s). If the beginning of the original line contains Markdown syntax such as blank spaces for indentation, "-", "+", "*" for unordered list, or ">" for notes, keep them unchanged.

Example of a valid response:

{"reviews": [{"line": 42, "severity": "medium", "category": "clarity", "comment": "The sentence is not clear enough. It is recommended to clarify the relationship between compression speed and compression ratio, and to supplement the explanation of the default value.", "suggestion": "Set the compression efficiency of the lz4 compression algorithm used when writing raft log files to raft-engine, ranging from 1 to 16. The lower the value, the higher the compression speed, but the lower the compression ratio; the higher the value, the lower the compression speed, but the higher the compression ratio. The default value is 1, which means prioritizing compression speed."}]}

Review the diff in the file "\${filename}" and take the pull request title and description into account when writing the response.

Pull request title: \${title}
Pull request description:

---
\${description}
---
\${digest}
\${style_guide}
\${full_content}

Git diff to review:

\`\`\`diff
\${diff_content}
\${diff_changes}
\`\`\``;

export const DEFAULT_PROMPT_ZH = `你是一名精通数据库技术的资深技术文档工程师，你的任务是审校优化用户文档的 Pull Request。

重要：你必须严格遵循以下格式要求：

1. 你的响应必须是一个有效的 JSON 对象，结构如下：
   {"reviews": [{"line": <行号>, "end_line": <可选行号>, "severity": "high|medium|low", "category": "accuracy|logic|clarity|terminology|structure|grammar", "comment": "<审查意见>", "suggestion": "<改进后的替换文本>"}]}
2. 不要在你返回的 JSON 前后包含任何 Markdown 代码块（如 \`\`\`json）。
3. 确保所有 JSON 键和值都用双引号正确引用。
4. 不要在 JSON 对象之外包含任何解释或文本。
5. 行号以文件的新版本为准。只评论出现在下方 diff 中的行。
6. 仅当 suggestion 需要替换连续多行（line..end_line，含两端）时才使用 "end_line"，否则省略。

文档审校准则：

- 请勿提供正面评价或赞美。
- 请勿改进代码块中 UI 字符串或 CLI 返回消息的措辞。
- 请专注于提高内容的清晰度、准确性和可读性。
- 请确保文档对于用户来说易于理解。
- 请不仅审查措辞，还要审查内容的逻辑和结构是否合理。
- 当下方提供了完整文档或 PR 级别的变更摘要时，请用它们检查与上下文及其他变更文件的一致性。即便如此，也只评论 diff 中出现的行。
- 只在文档里有需要改进的地方才提供 "reviews"，否则 "reviews" 应为空数组。
- 审查意见使用中文撰写。
- 对于每一行具体的审查意见，"suggestion" 必须是原文的改进版本。如果原文行开头包含 Markdown 语法（如用于缩进的空格、无序列表的 "-"、"+"、"*" 或用于注释的 ">"），请保持它们不变。

有效响应的示例：

{"reviews": [{"line": 42, "severity": "medium", "category": "clarity", "comment": "该句描述不够清晰，建议明确说明压缩速率和压缩率的关系，并补充对默认值的解释。", "suggestion": "设置 raft-engine 在写 raft log 文件时所采用的 lz4 压缩算法的压缩效率，范围 [1, 16]。数值越低，压缩速率越高，但压缩率越低；数值越高，压缩速率越低，但压缩率越高。默认值 1 表示优先考虑压缩速率。"}]}

审查内容为文件 "\${filename}" 中的以下 diff，在撰写响应时请结合 Pull Request 的标题和描述帮助你理解 PR 的主要改动。

Pull Request 标题: \${title}
Pull Request 描述:

---
\${description}
---
\${digest}
\${style_guide}
\${full_content}

需要审查的 Git diff 如下：

\`\`\`diff
\${diff_content}
\${diff_changes}
\`\`\``;

/** Render a template by replacing all ${var} placeholders; unknowns → "". */
export function renderTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\$\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match
  );
}

function resolveFromCwd(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * Load the prompt template: custom file when configured and readable,
 * otherwise the built-in default for the requested language.
 */
export function loadPromptTemplate(cfg: Config, language: DocLanguage): string {
  if (cfg.promptPath) {
    // Language-specific sibling first: `review.txt` → `review.ja.txt`.
    const variantPath = resolveFromCwd(
      languageVariantPath(cfg.promptPath, language)
    );
    if (variantPath !== resolveFromCwd(cfg.promptPath)) {
      try {
        const template = readFileSync(variantPath, "utf8");
        console.log(
          `Using language-specific prompt template from: ${variantPath}`
        );
        return template;
      } catch {
        // no variant for this language; fall through to the base template
      }
    }
    const templatePath = resolveFromCwd(cfg.promptPath);
    try {
      const template = readFileSync(templatePath, "utf8");
      console.log(`Using custom prompt template from: ${templatePath}`);
      return template;
    } catch {
      core.warning(
        `Custom prompt file not found at: ${templatePath}. Using default prompt.`
      );
    }
  }
  return language === "zh" ? DEFAULT_PROMPT_ZH : DEFAULT_PROMPT_EN;
}

/** Load the optional style guide file; empty string when not configured. */
export function loadStyleGuide(cfg: Config): string {
  if (!cfg.styleGuidePath) return "";
  const p = resolveFromCwd(cfg.styleGuidePath);
  try {
    const content = readFileSync(p, "utf8");
    console.log(`Using style guide from: ${p}`);
    return `\nStyle guide to enforce:\n---\n${content}\n---\n`;
  } catch {
    core.warning(`Style guide file not found at: ${p}. Continuing without it.`);
    return "";
  }
}

/** Build the optional full-document section for a prompt. */
export function fullContentSection(fullContent: string | null): string {
  if (!fullContent) return "";
  return `\nFull document at the PR head (for context only; comment ONLY on lines that appear in the diff):\n---\n${fullContent}\n---\n`;
}

/** Build the optional PR-wide digest section for a prompt. */
export function digestSection(digestText: string): string {
  if (!digestText) return "";
  return `\nPR-wide digest of all changes (for context; stay consistent with other changed files):\n---\n${digestText}\n---\n`;
}
