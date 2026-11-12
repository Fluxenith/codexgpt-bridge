import type { WebProviderCapabilities } from "@codexgpt-bridge/responses-gateway";

export interface GeminiSettings {
  readonly version: 1;
  readonly enabled: boolean;
  readonly connectorName: string;
  readonly publicBaseUrl?: string;
  readonly textTimeoutMs: number;
  readonly toolWaitTimeoutMs: number;
  readonly autoApproveToolCalls: boolean;
  readonly freshConversationPerTurn: boolean;
  readonly simpleTemporaryChat: boolean;
  /** Gemini tasks that may run at once, each in its own page (1-4). */
  readonly maxConcurrentTurns: number;
  /** New tasks in a Codex project start in the same-named Gemini notebook. */
  readonly notebookMapping: boolean;
}
export interface GeminiStatus {
  readonly settings: GeminiSettings;
  readonly login: {
    readonly browserHost?: "embedded" | "chrome";
    readonly phase: "idle" | "waiting" | "ready" | "verifying";
    readonly verified: boolean;
    readonly error?: string;
  };
  readonly capabilities: WebProviderCapabilities;
  readonly busy: boolean;
  readonly mcp: {
    readonly running: boolean;
    readonly url?: string;
    readonly error?: string;
  };
  readonly error?: string;
}
