import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  bridgeExecutionLimitProblem,
  synchronizeBridgeExecutionPreflight,
  type WebProvider,
  type WebProviderCapabilities,
  type WebProviderResult,
} from "@codexgpt-bridge/responses-gateway";
import { writeDurableJson } from "./durable-json.js";
import { planContextSync, type ContextReceipt } from "./context-sync.js";

/** Isolated desktop acceptance driver. Codex browser tools operate an existing
 * Chrome tab; this transports browser input/results and never executes tools. */
export class GeminiBrowserRelay implements WebProvider {
  readonly id = "gemini" as const;
  #busy = false;
  readonly #conversations = new Map<
    string,
    { url: string; receipt: ContextReceipt }
  >();
  readonly #closing = new AbortController();
  constructor(private readonly directory: string) {}
  get busy(): boolean {
    return this.#busy;
  }
  async login(): Promise<void> {
    await this.capabilities();
  }
  async capabilities(): Promise<WebProviderCapabilities> {
    const snapshot = JSON.parse(
      await readFile(join(this.directory, "capabilities.json"), "utf8"),
    ) as WebProviderCapabilities;
    if (
      snapshot.version !== 1 ||
      snapshot.provider !== "gemini" ||
      !snapshot.accountKey ||
      !snapshot.routes.length
    )
      throw new Error("Existing Chrome capability receipt is missing.");
    return snapshot;
  }
  async runTurn(
    input: Parameters<WebProvider["runTurn"]>[0],
  ): Promise<WebProviderResult> {
    if (this.#busy)
      throw new Error("The existing Gemini browser has an active task.");
    if (
      input.images.length ||
      input.context?.images.length ||
      input.requiredSubagentResults
    )
      throw new Error(
        "The browser relay accepts text tasks without subagent scheduling.",
      );
    const signal = AbortSignal.any([input.signal, this.#closing.signal]);
    signal.throwIfAborted();
    const conversationKey = `${input.providerRoute.accountKey}:${input.threadId ?? input.operationId ?? randomUUID()}`;
    const previous = this.#conversations.get(conversationKey);
    const sync = input.context
      ? planContextSync(
          input.context,
          input.contract ?? "",
          input.forceNewConversation ? undefined : previous?.receipt,
        )
      : undefined;
    const reset =
      input.forceNewConversation === true || !previous || sync?.reset !== false;
    if (input.requireRetainedConversation && reset)
      throw new Error(
        "The requested retained Gemini conversation is not acknowledged.",
      );
    const prompt = [
      sync?.text ?? input.contract,
      "[Current request]",
      input.prompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (
      input.execution &&
      bridgeExecutionLimitProblem(
        synchronizeBridgeExecutionPreflight(input.execution, {
          prompt,
          images: [],
        }),
      )
    )
      throw new Error(
        "The browser relay prompt exceeds the Gemini transport budget.",
      );
    const id = randomUUID();
    const request = {
      version: 1,
      id,
      phase: "awaiting_browser",
      operationId: input.operationId,
      threadId: input.threadId,
      selection: input.providerRoute.selection,
      accountKey: input.providerRoute.accountKey,
      prompt,
      connectorName: input.connectorName,
      allowWebNativeTools: input.allowWebNativeTools === true,
      forceNewConversation: reset,
      ...(reset ? {} : { conversationUrl: previous!.url }),
    };
    this.#busy = true;
    try {
      await writeDurableJson(
        join(this.directory, "request.json"),
        JSON.stringify(request),
      );
      input.onProgress?.("submitting");
      const deadline = Date.now() + 30 * 60 * 1000;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        let reply: Record<string, unknown> | undefined;
        try {
          reply = JSON.parse(
            await readFile(join(this.directory, "result.json"), "utf8"),
          ) as Record<string, unknown>;
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "ENOENT" &&
            !(error instanceof SyntaxError)
          )
            throw error;
        }
        if (reply?.id === id) {
          if (typeof reply.error === "string") throw new Error(reply.error);
          if (
            typeof reply.text !== "string" ||
            typeof reply.answerId !== "string" ||
            !reply.answerId ||
            reply.complete !== true ||
            reply.stable !== true
          )
            throw new Error(
              "The browser has not supplied a completed, stable new answer receipt.",
            );
          if (
            Array.isArray(reply.baselineIds) &&
            reply.baselineIds.includes(reply.answerId)
          )
            throw new Error(
              "An old browser answer cannot complete a new request.",
            );
          const url = new URL(String(reply.conversationUrl));
          if (
            url.origin !== "https://gemini.google.com" ||
            !/^\/app\/[A-Za-z0-9_-]+$/u.test(url.pathname)
          )
            throw new Error(
              "The browser supplied an invalid Gemini conversation URL.",
            );
          const result = {
            output: reply.text,
            selection: reply.selection,
            accountKey: reply.accountKey,
            conversationUrl: url.href,
          } as WebProviderResult;
          const expected = input.providerRoute.selection;
          if (
            result.accountKey !== input.providerRoute.accountKey ||
            !result.selection ||
            result.selection.provider !== expected.provider ||
            result.selection.model !== expected.model ||
            result.selection.thinking !== expected.thinking ||
            result.selection.activity !== expected.activity
          )
            throw new Error(
              "The Gemini browser receipt has a different account or model selection.",
            );
          if (!reset && new URL(previous!.url).pathname !== url.pathname)
            throw new Error(
              "The retained Gemini browser receipt came from a different conversation.",
            );
          await writeDurableJson(
            join(this.directory, "request.json"),
            JSON.stringify({
              ...request,
              phase: "completed",
              answerId: reply.answerId,
            }),
          );
          if (sync) {
            this.#conversations.delete(conversationKey);
            this.#conversations.set(conversationKey, {
              url: url.href,
              receipt: sync.receipt,
            });
            if (this.#conversations.size > 100)
              this.#conversations.delete(
                this.#conversations.keys().next().value!,
              );
          }
          return result;
        }
        await delay(200, undefined, { signal });
      }
      throw new Error(
        "The existing Chrome browser relay exceeded its deadline. The request was not resent.",
      );
    } catch (error) {
      this.#conversations.delete(conversationKey);
      await writeDurableJson(
        join(this.directory, "request.json"),
        JSON.stringify({ ...request, phase: "failed" }),
      );
      throw error;
    } finally {
      this.#busy = false;
    }
  }
  async close(): Promise<void> {
    this.#closing.abort();
  }
}
