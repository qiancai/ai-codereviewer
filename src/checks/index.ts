import { detectLanguage } from "../prompts";
import { Finding } from "../types";
import { checkAnchorBreakage } from "./anchors";
import { checkCodeAnchors } from "./code";
import { checkLinksAndImages } from "./links";
import { checkTerms } from "./terms";
import { checkToc } from "./toc";
import { CheckDeps, CheckFile } from "./types";
import { checkTypography } from "./typography";

export { parseGlossary } from "./terms";
export type { CheckDeps, CheckFile } from "./types";

/**
 * Run the enabled deterministic checks over the changed files.
 * Deterministic findings skip the LLM verify stage but still go through
 * line validation and dedupe like everything else. Individual check
 * failures degrade to a log line — never fatal.
 */
export async function runChecks(
  files: CheckFile[],
  deps: CheckDeps
): Promise<{ findings: Finding[]; failures: string[] }> {
  const findings: Finding[] = [];
  const failures: string[] = [];
  const enabled = new Set(deps.enabled);

  for (const checkFile of files) {
    if (enabled.has("terms") && deps.glossary.length > 0) {
      try {
        findings.push(...checkTerms(checkFile, deps.glossary));
      } catch (error) {
        failures.push(`terms check on \`${checkFile.path}\`: ${msg(error)}`);
      }
    }

    if (enabled.has("links") || enabled.has("images")) {
      try {
        findings.push(
          ...(await checkLinksAndImages(checkFile, deps, {
            links: enabled.has("links"),
            images: enabled.has("images"),
          }))
        );
      } catch (error) {
        failures.push(
          `links/images check on \`${checkFile.path}\`: ${msg(error)}`
        );
      }
    }

    if (enabled.has("anchors")) {
      try {
        findings.push(...(await checkAnchorBreakage(checkFile, deps)));
      } catch (error) {
        failures.push(`anchors check on \`${checkFile.path}\`: ${msg(error)}`);
      }
    }

    if (enabled.has("toc")) {
      try {
        findings.push(
          ...(await checkToc(checkFile, { ...deps, tocPath: deps.tocPath }))
        );
      } catch (error) {
        failures.push(`toc check on \`${checkFile.path}\`: ${msg(error)}`);
      }
    }

    // Typography checks are per-language (zh, fr, es, ...). The legacy
    // check name "zh" still enables the dispatcher for compatibility.
    if (enabled.has("typography") || enabled.has("zh")) {
      const language = detectLanguage(
        checkFile.path,
        checkFile.fullContent,
        deps.docLanguage
      );
      if (language !== "en") {
        try {
          findings.push(...checkTypography(checkFile, language));
        } catch (error) {
          failures.push(
            `typography check on \`${checkFile.path}\`: ${msg(error)}`
          );
        }
      }
    }

    if (enabled.has("code") && deps.codeRepo) {
      try {
        findings.push(...(await checkCodeAnchors(checkFile, deps)));
      } catch (error) {
        failures.push(`code check on \`${checkFile.path}\`: ${msg(error)}`);
      }
    }
  }

  return { findings, failures };
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
