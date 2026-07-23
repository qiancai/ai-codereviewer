import OpenAI from "openai";
import { Config } from "../config";

/**
 * Provider-agnostic LLM client.
 *
 * Hard guarantees (the failure modes the old implementation hid):
 * - JSON mode is enabled explicitly for both providers; no model-name sniffing.
 * - finish_reason === "length" triggers one retry with doubled max_tokens;
 *   if it still truncates, an LlmError is thrown. Truncation is never
 *   reported back as "no findings".
 * - 429/5xx/network errors are retried with exponential backoff.
 * - chatJson throws on unparseable/invalid output instead of returning [].
 */

export class LlmError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LlmError";
  }
}

export interface ChatOptions {
  model: string;
  prompt: string;
  system?: string;
  maxTokens: number;
  temperature?: number;
}

export interface ChatResult {
  content: string;
  finishReason: string;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (status === undefined) return true; // network-level failure
  return status === 429 || status >= 500;
}

/** Run fn with exponential backoff on transient failures. */
async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS) {
        throw new LlmError(
          `LLM request failed after ${attempt} attempt(s): ${
            error instanceof Error ? error.message : String(error)
          }`,
          error
        );
      }
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 500;
      console.log(
        `LLM request failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${Math.round(
          delay
        )}ms: ${error instanceof Error ? error.message : String(error)}`
      );
      await sleep(delay);
    }
  }
  throw new LlmError("unreachable");
}

async function callOpenAI(cfg: Config, opts: ChatOptions): Promise<ChatResult> {
  const openai = new OpenAI({ apiKey: cfg.openaiApiKey });
  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });

  const response = await openai.chat.completions.create({
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.maxTokens,
    response_format: { type: "json_object" },
  });

  const choice = response.choices[0];
  return {
    content: choice?.message?.content?.trim() ?? "",
    finishReason: choice?.finish_reason ?? "unknown",
  };
}

async function callDeepseek(
  cfg: Config,
  opts: ChatOptions
): Promise<ChatResult> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });

  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(
      `Deepseek API error: ${response.status} ${response.statusText} - ${errorText}`
    ) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = data.choices?.[0];
  if (!choice?.message?.content) {
    throw new LlmError("No content in Deepseek response");
  }
  return {
    content: choice.message.content.trim(),
    finishReason: choice.finish_reason ?? "unknown",
  };
}

function chatOnce(cfg: Config, opts: ChatOptions): Promise<ChatResult> {
  return cfg.provider === "openai"
    ? callOpenAI(cfg, opts)
    : callDeepseek(cfg, opts);
}

function ensureContent(result: ChatResult): ChatResult {
  if (!result.content) throw new LlmError("Empty content in model response");
  return result;
}

/**
 * Send a chat request with retry on transient failures and one
 * truncation-escalation retry. Throws LlmError on unrecoverable failure.
 */
export async function chat(
  cfg: Config,
  opts: ChatOptions
): Promise<ChatResult> {
  const first = ensureContent(
    await withRetries(() =>
      chatOnce(cfg, { ...opts, maxTokens: opts.maxTokens })
    )
  );
  if (first.finishReason !== "length") return first;

  const doubled = opts.maxTokens * 2;
  console.log(
    `Response truncated (finish_reason=length), retrying with max_tokens=${doubled}`
  );
  const second = ensureContent(
    await withRetries(() => chatOnce(cfg, { ...opts, maxTokens: doubled }))
  );
  if (second.finishReason === "length") {
    throw new LlmError("Response truncated even after doubling max_tokens");
  }
  return second;
}

/**
 * Extract the first JSON object from a model response, tolerating code
 * fences and surrounding prose despite JSON mode being enabled.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Fast path: the whole response is JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to salvage
  }

  // Strip a single enclosing code fence if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // fall through
    }
  }

  // Last resort: first '{' to last '}'.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // give up
    }
  }
  throw new LlmError("Could not extract valid JSON from model response");
}

/**
 * Chat + JSON extraction + schema validation.
 * Throws LlmError when the response cannot be parsed or validated —
 * callers must treat that as a stage failure, never as "no findings".
 */
export async function chatJson<T>(
  cfg: Config,
  opts: ChatOptions,
  validate: (u: unknown) => T | null
): Promise<T> {
  const result = await chat(cfg, opts);
  const parsed = extractJson(result.content);
  const validated = validate(parsed);
  if (validated === null) {
    throw new LlmError(
      `Model response did not match the expected schema (first 300 chars: ${result.content.slice(
        0,
        300
      )})`
    );
  }
  return validated;
}
