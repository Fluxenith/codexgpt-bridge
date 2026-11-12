import type { GeminiSettings } from "./gemini-types.js";

export const DEFAULT_GEMINI_SETTINGS: GeminiSettings = {
  version: 1,
  enabled: false,
  connectorName: "CodexGPT Bridge",
  textTimeoutMs: 600000,
  toolWaitTimeoutMs: 30 * 60 * 1000,
  autoApproveToolCalls: false,
  freshConversationPerTurn: false,
  simpleTemporaryChat: false,
  maxConcurrentTurns: 2,
  notebookMapping: false,
};

export function parseGeminiSettings(value: unknown): GeminiSettings {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  if (record.version !== undefined && record.version !== 1)
    throw new Error("Unsupported Gemini settings version.");
  const timeout = (name: string, fallback: number): number => {
    const selected = record[name] ?? fallback;
    if (
      typeof selected !== "number" ||
      !Number.isSafeInteger(selected) ||
      selected < 1000 ||
      selected > 4 * 60 * 60 * 1000
    )
      throw new Error(`Invalid Gemini ${name}.`);
    return selected;
  };
  const connectorName =
    typeof record.connectorName === "string"
      ? record.connectorName.trim()
      : DEFAULT_GEMINI_SETTINGS.connectorName;
  if (
    !connectorName ||
    connectorName.length > 120 ||
    /[\r\n]/u.test(connectorName)
  )
    throw new Error("Invalid Gemini connector name.");
  let publicBaseUrl: string | undefined;
  if (typeof record.publicBaseUrl === "string" && record.publicBaseUrl.trim()) {
    const url = new URL(record.publicBaseUrl.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Gemini MCP requires a fixed HTTPS origin.");
    publicBaseUrl = url.origin;
  }
  return {
    version: 1,
    enabled: record.enabled === true,
    connectorName,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    textTimeoutMs: timeout("textTimeoutMs", 600000),
    toolWaitTimeoutMs: timeout("toolWaitTimeoutMs", 30 * 60 * 1000),
    autoApproveToolCalls: record.autoApproveToolCalls === true,
    freshConversationPerTurn: record.freshConversationPerTurn === true,
    simpleTemporaryChat: record.simpleTemporaryChat === true,
    notebookMapping: record.notebookMapping === true,
    maxConcurrentTurns: (() => {
      const selected =
        record.maxConcurrentTurns ?? DEFAULT_GEMINI_SETTINGS.maxConcurrentTurns;
      if (
        typeof selected !== "number" ||
        !Number.isSafeInteger(selected) ||
        selected < 1 ||
        selected > 4
      )
        throw new Error("Invalid Gemini maxConcurrentTurns.");
      return selected;
    })(),
  };
}
