# AI Doc Reviewer

AI Doc Reviewer is a GitHub Action that reviews documentation pull requests with AI and posts inline review comments with one-click-applicable suggestions. It is designed specifically for **documentation** — not adapted from a code reviewer — so it checks the things documentation PRs actually break: prose quality, cross-file consistency, anchors, links, and terminology.

## How it works

Instead of sending isolated diff hunks to an LLM, the action runs a pipeline:

```
PR diff
  │
  ├─ 0. Deterministic checks (no LLM): anchors, links, images, terms, TOC
  ├─ 1. Digest      — one cheap call: PR intent + per-file summary + structured claims
  ├─ 2. Review      — one call per file: full document + its diff + digest + style guide
  ├─ 3. Cross-check — compares the extracted claims across files, finds contradictions
  ├─ 4. Verify      — re-checks every candidate comment against the source text, drops noise
  └─ 5. Posting     — line validation, re-run dedupe, one review + a summary comment
```

Key properties:

- **Full-document context**: every file is reviewed with its complete content at the PR head, not just the changed lines. Large files (over `MAX_FILE_KB`) fall back to diff-hunk review.
- **Cross-file consistency**: the digest extracts claims (terms, parameter defaults, ranges, versions, commands) from all changed files; the cross-check stage compares them and flags contradictions such as two files stating different default values.
- **Noise control**: a verify stage fact-checks every candidate comment against the source excerpt before posting and drops findings it cannot substantiate.
- **Never silently empty**: truncated or malformed model responses fail loudly and are listed in the run summary — they are never reported as "no issues found".
- **Re-run safe**: line numbers are validated against the diff (hallucinated lines are remapped or degraded to the summary, never rejected by GitHub), and re-runs skip comments the bot already posted on the same lines.

## Deterministic checks (no LLM, zero hallucination)

Enabled via the `CHECKS` input (default: `anchors,links,images,typography`):

| Check        | What it catches                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `anchors`    | A heading renamed/removed in this PR that other files still link to (`file.md#old-anchor`) — the classic docs-PR breakage that diffs cannot show |
| `links`      | New/modified relative links whose target file or `#anchor` does not exist at the PR head                                                         |
| `images`     | New/modified image references pointing to missing files                                                                                          |
| `terms`      | Banned terminology on added lines, driven by your own glossary file                                                                              |
| `toc`        | New `.md` pages not referenced in your navigation file (`TOC_PATH`)                                                                              |
| `typography` | Language-specific typography on added lines (see [Multi-language support](#multi-language-support))                                              |
| `code`       | CLI flags in added shell code blocks that do not exist in the configured source repository (`CODE_REPO`)                                         |

External URLs (`https://...`) are intentionally not fetched. Lines inside code fences are skipped by the terms and typography checks.

Notes on specific checks:

- **`typography`** runs the rule set for the detected document language and is a no-op for English and for languages without a rule set. Inline code, URLs, link targets, and HTML tags are masked. Findings come with a corrected-line `suggestion`. (The legacy check name `zh` still works and is equivalent to `typography`.)
- **`code`** requires `CODE_REPO` (for example `pingcap/tidb`) and full-document context. Each flag is verified via GitHub code search; a flag that is not found is reported as **"please verify"**, not as an assertion — flags may be defined dynamically. At most 15 flags are queried per run to respect search rate limits.

## Multi-language support

The action detects the language of each changed file and adapts three things: the review prompt language, the language the LLM writes comments in, and the typography rule set.

Detection precedence:

1. **`DOC_LANGUAGE`** input — forces one language for all files (recommended for Latin-script languages other than fr/de/es).
2. **Path conventions** — `docs/ja/guide.md`, `guide_fr.md`, `i18n/de/...` (a language code as a full path segment or delimited by `_-.`).
3. **Script heuristics** — kana → `ja`, Hangul → `ko`, Han → `zh` (no kana), Cyrillic → `ru`, Arabic → `ar`, Thai → `th`, Devanagari → `hi`.
4. **Stop-word scoring** — distinguishes `fr` / `de` / `es` conservatively; ambiguous text falls back to `en`.

Per language today:

| Language                             | Review prompt                               | Typography rules                                                  |
| ------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------- |
| `en`                                 | built-in English                            | —                                                                 |
| `zh`                                 | built-in Chinese                            | CJK–Latin/digit spacing, fullwidth punctuation in Chinese context |
| `fr`                                 | English + "write in French" directive       | No-break space before `; : ! ?`                                   |
| `es`                                 | English + "write in Spanish" directive      | Opening `¿` / `¡` marks                                           |
| others (`ja`, `ko`, `ru`, `de`, ...) | English + "write in `<language>`" directive | — (rule sets are pluggable per language)                          |

Two deliberate design choices: typography rules are strictly per-language (Chinese spacing rules, for example, are _wrong_ for Japanese, so detection distinguishes kana from Han), and every review prompt gets an explicit "write every comment and suggestion in `<language>`" directive, so comments always arrive in the language of the document.

### Glossary format (`GLOSSARY_PATH`)

One rule per line: `Preferred term: banned1, banned2`. Lines starting with `#` are comments.

```text
# Always use the official product name
TiDB: tidb, Tidb
TiKV: tikv, TiKV Cloud Serverless
```

Findings come with a ready-to-apply `suggestion` that replaces the banned term.

### Coexisting with Vale

If your repository already runs [Vale](https://vale.sh/) in its own CI (for example via `errata-ai/vale-action` or reviewdog), keep it there and do **not** set `GLOSSARY_PATH` — Vale already covers prose style and terminology, and running it twice produces duplicate comments. The built-in `terms` check is a zero-dependency fallback for repositories without Vale.

The action's other deterministic checks do not overlap with Vale: Vale lints prose _style within a file_, while `anchors`, `links`, `images`, and `toc` check _structure across files_ (link targets, renamed-heading breakage, navigation reachability) — Vale does not look at links at all. For external URLs, the standard practice is a scheduled repo-wide scan (for example with [lychee](https://github.com/lycheeverse/lychee-action)), not a per-PR check, so the action intentionally skips them. Similarly, if your docs site generator validates links at build time (for example Docusaurus `onBrokenLinks`/`onBrokenAnchors`), prefer that layer and trim `CHECKS` accordingly — the closer to the build, the better.

## Setup

1. Add an `OPENAI_API_KEY` or `DEEPSEEK_API_KEY` secret to your repository.

2. Create `.github/workflows/doc_review.yml`:

```yaml
name: AI Doc Review

on:
  workflow_dispatch:

  issue_comment:
    types:
      - created

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    if: >
      github.event_name == 'workflow_dispatch' ||
      (
        github.event_name == 'issue_comment' &&
        contains(github.event.comment.body, '/bot-review') &&
        contains('username1, username2, username3', github.event.comment.user.login)
      )
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Extract review parameters
        id: extract
        if: github.event_name == 'issue_comment'
        run: |
          COMMENT="${{ github.event.comment.body }}"

          # Match commit range
          if [[ "$COMMENT" =~ \/bot-review:[[:space:]]*([a-f0-9]{7,40})[[:space:]]*\.\.[[:space:]]*([a-f0-9]{7,40}) ]]; then
            echo "BASE_SHA=${BASH_REMATCH[1]}" >> $GITHUB_OUTPUT
            echo "HEAD_SHA=${BASH_REMATCH[2]}" >> $GITHUB_OUTPUT
            echo "REVIEW_MODE=commit_range" >> $GITHUB_OUTPUT

          # Match a single commit
          elif [[ "$COMMENT" =~ \/bot-review:[[:space:]]+([a-f0-9]{7,40}) ]]; then
            echo "COMMIT_SHA=${BASH_REMATCH[1]}" >> $GITHUB_OUTPUT
            echo "REVIEW_MODE=single_commit" >> $GITHUB_OUTPUT

          # Match "/bot-review" or "/bot-review "
          elif [[ "$COMMENT" =~ ^\/bot-review[[:space:]]*$ ]]; then
            echo "REVIEW_MODE=latest" >> $GITHUB_OUTPUT

          # Invalid format
          else
            echo "REVIEW_MODE=invalid" >> $GITHUB_OUTPUT
          fi

      - name: AI Doc Reviewer
        uses: qiancai/ai-codereviewer@test-gpt
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          API_PROVIDER: "deepseek" # or "openai"
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          DEEPSEEK_API_MODEL: "deepseek-chat"
          FAST_MODEL: "deepseek-chat" # cheaper model for digest/verify; optional
          exclude: "**/*.json"
          REVIEW_MODE: ${{ steps.extract.outputs.REVIEW_MODE || 'default' }}
          COMMIT_SHA: ${{ steps.extract.outputs.COMMIT_SHA || '' }}
          BASE_SHA: ${{ steps.extract.outputs.BASE_SHA || '' }}
          HEAD_SHA: ${{ steps.extract.outputs.HEAD_SHA || '' }}
          PROMPT_PATH: "doc-review-prompt-en.txt"
          # STYLE_GUIDE_PATH: "docs-style-guide.md"
          # GLOSSARY_PATH: "docs-glossary.txt"
          # CHECKS: "anchors,links,images,typography,terms,toc,code"
          # TOC_PATH: "TOC.md"
          # CODE_REPO: "pingcap/tidb"  # source repo for the code check
          # DOC_LANGUAGE: ""           # force one language for all files
```

To use OpenAI, set `API_PROVIDER: "openai"` and pass `OPENAI_API_KEY` / `OPENAI_API_MODEL` instead.

## Configuration parameters

| Parameter            | Required          | Default                           | Description                                                    |
| -------------------- | ----------------- | --------------------------------- | -------------------------------------------------------------- |
| `GITHUB_TOKEN`       | Yes               | N/A                               | GitHub token for API access                                    |
| `API_PROVIDER`       | No                | `openai`                          | AI provider (`openai` or `deepseek`)                           |
| `OPENAI_API_KEY`     | If using OpenAI   | N/A                               | Your OpenAI API key                                            |
| `OPENAI_API_MODEL`   | If using OpenAI   | N/A                               | Model for review and cross-check stages                        |
| `DEEPSEEK_API_KEY`   | If using DeepSeek | N/A                               | Your DeepSeek API key                                          |
| `DEEPSEEK_API_MODEL` | If using DeepSeek | N/A                               | Model for review and cross-check stages                        |
| `FAST_MODEL`         | No                | main model                        | Cheaper model for the digest and verify stages                 |
| `exclude`            | No                | N/A                               | Comma-separated glob patterns for files to skip                |
| `PROMPT_PATH`        | No                | built-in                          | Path to a custom review prompt template                        |
| `STYLE_GUIDE_PATH`   | No                | N/A                               | Style guide file injected into every review prompt             |
| `GLOSSARY_PATH`      | No                | N/A                               | Terminology file for the `terms` check                         |
| `CHECKS`             | No                | `anchors,links,images,typography` | Deterministic checks to run                                    |
| `TOC_PATH`           | No                | N/A                               | Navigation file path for the `toc` check                       |
| `CODE_REPO`          | No                | N/A                               | Source repo (`owner/repo`) for the `code` check                |
| `DOC_LANGUAGE`       | No                | auto-detect                       | Force one language for all files (`en`, `zh`, `ja`, `fr`, ...) |
| `MAX_FILE_KB`        | No                | `50`                              | Files larger than this are reviewed from diff hunks only       |
| `MAX_TOKENS`         | No                | `4096`                            | Max output tokens per LLM call (doubled on truncation)         |
| `CONCURRENCY`        | No                | `4`                               | Files reviewed in parallel                                     |

`REVIEW_MODE`, `COMMIT_SHA`, `BASE_SHA`, `HEAD_SHA` are populated by the workflow snippet above; see the next section.

## How to trigger a review

Add a `/bot-review` command in a PR comment:

- **Review the latest PR changes:** `/bot-review`
- **Review a specific commit:** `/bot-review: 1a2b3c4d`
- **Review changes between two commits:** `/bot-review: 1a2b3c4d..5e6f7g8h` (from `1a2b3c4d`, exclusive, to `5e6f7g8h`, inclusive)

Only users listed in the workflow's `if:` condition can trigger reviews. After the run, the bot posts inline comments and maintains a single summary comment (updated on every re-run) containing the PR digest, counts, unanchorable findings, and any stage failures. Re-running `/bot-review` does not duplicate comments already posted on the same lines.

## Customize prompts

You can provide your own prompt template via `PROMPT_PATH` (see [doc-review-prompt-en.txt](/doc-review-prompt-en.txt) and [doc-review-prompt-zh.txt](/doc-review-prompt-zh.txt) for examples). Available placeholders:

| Placeholder                           | Content                                      |
| ------------------------------------- | -------------------------------------------- |
| `${filename}`                         | Path of the file being reviewed              |
| `${title}` / `${description}`         | PR title and description                     |
| `${diff_content}` / `${diff_changes}` | The file's diff hunks with line numbers      |
| `${digest}`                           | PR-wide digest (intent + per-file summaries) |
| `${style_guide}`                      | Content of `STYLE_GUIDE_PATH`                |
| `${full_content}`                     | Full document at the PR head                 |

Without a custom prompt, built-in English and Chinese templates are used; other languages use the English template plus an explicit "write in `<language>`" directive (see [Multi-language support](#multi-language-support)). For a custom `PROMPT_PATH`, you can also provide per-language variants: with `PROMPT_PATH: "prompts/review.txt"`, a file detected as Japanese first tries `prompts/review.ja.txt`, then falls back to the base template. Legacy templates using `lineNumber`/`reviewComment` keep working — responses are normalized automatically.

## What the review covers (and what it does not)

The pipeline is strong at: language and clarity issues, structural and logic problems within a document, consistency between the changed files, and broken anchors/links/terminology.

It does **not** verify statements against the actual product source code (for example, whether a documented default value matches the code). Treat accuracy comments as well-informed suggestions, and keep human review for ground-truth verification. Deleted files that other documents still link to are also not yet detected.

## Contributing

1. Clone the repository and install dependencies with `npm install`.
2. Make your changes in `src/`.
3. Run `npx tsc --noEmit` and `npm test`.
4. Regenerate the packaged action with `npm run build && npm run package` and commit `dist/` — CI fails if `dist/` is out of sync with `src/`.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENCE) file for more information.
