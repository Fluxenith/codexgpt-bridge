export interface GeminiResponseObservation {
  readonly id: string;
  readonly text: string;
  readonly complete: boolean;
  readonly nativeToolResponse?: boolean;
}
export interface GeminiGenerationObservation {
  readonly responses: readonly GeminiResponseObservation[];
  readonly busy: boolean;
  readonly waitingForTool: boolean;
}

/** Match the actual Gemini native-tool permission card, never an entire reply. */
export function geminiPermissionScope(
  text: string,
  connectorName: string,
  turnToken: string,
): "match" | "mismatch" | "unknown" {
  if (turnToken.length < 40 || !/^turn_[A-Za-z0-9_-]+$/u.test(turnToken))
    return "unknown";
  const normalized = text.replace(/\s+/gu, " ").trim();
  const name = connectorName.replace(/\s+/gu, " ").trim();
  const titles = [
    "codex tool inventory",
    "codex tool call",
    "codex exec",
    "codex write stdin",
    "codex apply patch",
    "codex view image",
    "codex wait tool result",
    // Bridge refuses it for automatic turns and tells Gemini to reply normally.
    "codex manual complete",
  ];
  if (
    !titles.some((tool) =>
      normalized.startsWith(
        `${name} Let Gemini use "${tool}" from ${name} Tool: ${tool} `,
      ),
    )
  )
    return "unknown";
  const fields = [...normalized.matchAll(/\bturn_token\s*:\s*([^\s,]+)/gu)];
  if (!fields.length) return "unknown";
  return fields.length === 1 && fields[0]![1] === turnToken
    ? "match"
    : "mismatch";
}
export function geminiPermissionMatches(
  text: string,
  connectorName: string,
  turnToken: string,
): boolean {
  return geminiPermissionScope(text, connectorName, turnToken) === "match";
}

/** Only unwrap a sole code block; prose containing examples stays prose. */
export function geminiRenderedReplyText(
  text: string,
  blocks: readonly { readonly text: string; readonly code: string | null }[],
): string {
  const block = blocks.length === 1 ? blocks[0] : undefined;
  return block?.code !== null &&
    block?.code !== undefined &&
    text.trim() === block.text.trim()
    ? block.code
    : text;
}

export class GeminiGenerationError extends Error {
  constructor(
    readonly code:
      | "gemini_generation_timeout"
      | "gemini_generation_failed"
      | "gemini_tool_timeout"
      | "gemini_login_required"
      | "gemini_quota_exhausted"
      | "gemini_verification_required"
      | "gemini_page_changed"
      | "gemini_tool_scope_mismatch"
      | "gemini_submission_uncertain",
    message: string,
  ) {
    super(message);
    this.name = "GeminiGenerationError";
  }
}

/** A new answer ID, explicit footer and stable text are all required. */
export class GeminiReplyTracker {
  readonly #baseline: Set<string>;
  #candidate: { id: string; text: string; since: number } | undefined;
  #lastAt: number;
  #wasWaiting = false;
  #generationMs = 0;
  #toolMs = 0;
  constructor(
    ids: readonly string[],
    now: number,
    private readonly textTimeoutMs = 600000,
    private readonly toolTimeoutMs = 30 * 60 * 1000,
    private readonly settleMs = 1000,
  ) {
    this.#baseline = new Set(ids);
    this.#lastAt = now;
  }
  observe(value: GeminiGenerationObservation, now: number): string | undefined {
    const elapsed = Math.max(0, now - this.#lastAt);
    this.#lastAt = now;
    if (this.#wasWaiting) this.#toolMs += elapsed;
    else this.#generationMs += elapsed;
    if (this.#wasWaiting && !value.waitingForTool) this.#generationMs = 0;
    if (!this.#wasWaiting && value.waitingForTool) this.#toolMs = 0;
    this.#wasWaiting = value.waitingForTool;
    if (this.#toolMs > this.toolTimeoutMs)
      throw new GeminiGenerationError(
        "gemini_tool_timeout",
        "Gemini exceeded the separate tool-wait deadline. The submitted task was not resent.",
      );
    if (this.#generationMs > this.textTimeoutMs)
      throw new GeminiGenerationError(
        "gemini_generation_timeout",
        "Gemini exceeded its generation deadline. The submitted task was not resent.",
      );
    const last = value.responses.at(-1);
    if (
      !last ||
      !last.id ||
      this.#baseline.has(last.id) ||
      !last.text.trim() ||
      !last.complete ||
      last.nativeToolResponse === true ||
      value.busy ||
      value.waitingForTool
    ) {
      this.#candidate = undefined;
      return undefined;
    }
    if (
      /^(?:I seem to be encountering an error\. Can I try something else for you\?|I'm having a hard time fulfilling your request\. Can I help you with something else instead\?|I encountered an error doing what you asked\. Could you try again\?)$/u.test(
        last.text.trim(),
      )
    )
      throw new GeminiGenerationError(
        "gemini_generation_failed",
        "Gemini returned a generation error. The submitted task was not resent.",
      );
    if (this.#candidate?.id !== last.id || this.#candidate.text !== last.text) {
      this.#candidate = { id: last.id, text: last.text, since: now };
      return undefined;
    }
    return now - this.#candidate.since >= this.settleMs ? last.text : undefined;
  }
}

/** Gemini disables a model in its picker once that model's usage limit is hit. */
export function geminiLockedModelError(
  model: string,
  note: string,
): GeminiGenerationError {
  const reset = note.replace(/\s+/gu, " ").trim();
  return new GeminiGenerationError(
    "gemini_quota_exhausted",
    `Gemini ${model} reached its usage limit${reset ? ` (${reset})` : ""}. No prompt was submitted.`,
  );
}

export function geminiAlertError(
  text: string,
): GeminiGenerationError | undefined {
  if (/limit|quota|try again (?:tomorrow|later)|too many requests/iu.test(text))
    return new GeminiGenerationError("gemini_quota_exhausted", text);
  if (/verify|verification|captcha|unusual activity/iu.test(text))
    return new GeminiGenerationError("gemini_verification_required", text);
  if (/sign in|session expired|log in/iu.test(text))
    return new GeminiGenerationError("gemini_login_required", text);
  return undefined;
}
