import { DocLanguage } from "../../prompts";
import { Finding } from "../../types";
import { CheckFile } from "../types";
import { checkEsTypography } from "./es";
import { checkFrTypography } from "./fr";
import { checkZhTypography } from "./zh";

/**
 * Typography dispatcher: run the rule set for the document's language.
 * Languages without a deterministic rule set (ja, ko, ru, ...) return no
 * findings — adding a language means adding a module here. Note that these
 * rules are per-language by design: Chinese spacing rules, for example,
 * are wrong for Japanese.
 */
export function checkTypography(
  checkFile: CheckFile,
  language: DocLanguage
): Finding[] {
  switch (language) {
    case "zh":
      return checkZhTypography(checkFile);
    case "fr":
      return checkFrTypography(checkFile);
    case "es":
      return checkEsTypography(checkFile);
    default:
      return [];
  }
}
