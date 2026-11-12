import type { BridgeGeneratedImagesResult } from "./tool-protocol.js";
import type {
  BridgeContextBudget,
  BridgeWebModelRoute,
  RunWebTurnInput,
} from "./responses-server.js";

export type WebProviderId = "chatgpt" | "gemini";
export type WebActivity =
  | "chat"
  | "image"
  | "video"
  | "music"
  | "canvas"
  | "research"
  | "learning"
  | "notebook";

/** One observed, selectable combination. Never construct a Cartesian product. */
export interface WebProviderSelection {
  readonly provider: WebProviderId;
  readonly model: string;
  readonly thinking?: string;
  readonly activity: WebActivity;
}

export interface WebProviderRoute extends BridgeWebModelRoute {
  readonly provider: WebProviderId;
  readonly selection: WebProviderSelection;
  /** Opaque local account identity, not an email address or a credential. */
  readonly accountKey: string;
  readonly contextBudget: BridgeContextBudget;
}

export interface WebProviderCapabilities {
  readonly version: 1;
  readonly provider: WebProviderId;
  readonly accountKey: string;
  readonly observedAt: string;
  readonly routes: readonly WebProviderRoute[];
}

export interface WebProviderResult {
  readonly output: string | BridgeGeneratedImagesResult;
  readonly selection: WebProviderSelection;
  readonly accountKey: string;
  readonly conversationUrl?: string;
}

export interface WebProvider {
  readonly id: WebProviderId;
  login(): Promise<void>;
  capabilities(): Promise<WebProviderCapabilities>;
  runTurn(
    input: RunWebTurnInput & { readonly providerRoute: WebProviderRoute },
  ): Promise<WebProviderResult>;
  close(): Promise<void>;
  /** Turns this provider can run at once; omitted means one at a time. */
  maxConcurrentTurns?(): number;
}

export class WebProviderError extends Error {
  constructor(
    readonly code:
      | "provider_unavailable"
      | "model_unavailable"
      | "selection_mismatch"
      | "account_changed",
    message: string,
  ) {
    super(message);
    this.name = "WebProviderError";
  }
}

function sameSelection(
  left: WebProviderSelection,
  right: WebProviderSelection,
): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.thinking === right.thinking &&
    left.activity === right.activity
  );
}

/** Provider accounts, queues and model IDs stay independent of ChatGPT state. */
export class WebProviderRegistry {
  readonly #providers = new Map<WebProviderId, WebProvider>();
  readonly #slots = new Map<
    WebProviderId,
    { active: number; readonly waiting: (() => void)[] }
  >();
  readonly #closing = new AbortController();

  constructor(providers: readonly WebProvider[]) {
    for (const provider of providers) {
      if (this.#providers.has(provider.id))
        throw new Error("Duplicate Web provider.");
      this.#providers.set(provider.id, provider);
    }
  }

  async routes(): Promise<readonly WebProviderRoute[]> {
    const snapshots = await Promise.all(
      [...this.#providers.values()].map((provider) => provider.capabilities()),
    );
    const routes: WebProviderRoute[] = [];
    const slugs = new Set<string>();
    for (const snapshot of snapshots) {
      if (
        snapshot.version !== 1 ||
        !snapshot.accountKey ||
        !Number.isFinite(Date.parse(snapshot.observedAt))
      )
        throw new Error("Invalid Web capability snapshot.");
      for (const route of snapshot.routes) {
        if (
          route.provider !== snapshot.provider ||
          route.selection.provider !== snapshot.provider ||
          route.accountKey !== snapshot.accountKey ||
          !route.selection.model ||
          !route.slug.startsWith(`${snapshot.provider}-web/`) ||
          slugs.has(route.slug)
        )
          throw new Error("Invalid or duplicate provider model route.");
        const budget = route.contextBudget;
        if (
          ![
            budget.contextWindow,
            budget.hardInputTokenLimit,
            budget.autoCompactTokenLimit,
          ].every((value) => Number.isSafeInteger(value) && value > 0) ||
          budget.autoCompactTokenLimit > budget.hardInputTokenLimit
        )
          throw new Error("Invalid provider context budget.");
        slugs.add(route.slug);
        routes.push(route);
      }
    }
    return routes;
  }

  async runTurn(
    input: RunWebTurnInput & { readonly providerRoute: WebProviderRoute },
  ): Promise<string | BridgeGeneratedImagesResult> {
    const route = input.providerRoute;
    const provider = this.#providers.get(route.provider);
    if (!provider)
      throw new WebProviderError(
        "provider_unavailable",
        `The ${route.provider} Web provider is unavailable.`,
      );
    const signal = AbortSignal.any([input.signal, this.#closing.signal]);
    let release: (() => void) | undefined;
    try {
      release = await this.#acquire(provider, signal);
      signal.throwIfAborted();
      const snapshot = await provider.capabilities();
      if (snapshot.accountKey !== route.accountKey)
        throw new WebProviderError(
          "account_changed",
          "The Web account changed before submission.",
        );
      const actual = snapshot.routes.find(
        (candidate) =>
          candidate.slug === route.slug &&
          sameSelection(candidate.selection, route.selection),
      );
      if (!actual)
        throw new WebProviderError(
          "model_unavailable",
          `Requested Web model ${route.slug} is no longer available. No request was submitted.`,
        );
      const result = await provider.runTurn({
        ...input,
        signal,
        providerRoute: actual,
      });
      if (
        result.accountKey !== route.accountKey ||
        !sameSelection(result.selection, route.selection)
      )
        throw new WebProviderError(
          "selection_mismatch",
          "The browser did not confirm the requested account, model, thinking level and activity.",
        );
      return result.output;
    } finally {
      release?.();
    }
  }

  #limit(provider: WebProvider): number {
    const limit = provider.maxConcurrentTurns?.() ?? 1;
    return Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, 8) : 1;
  }

  /** Wait for one of the provider's turn slots; waiting turns stay cancellable. */
  async #acquire(
    provider: WebProvider,
    signal: AbortSignal,
  ): Promise<() => void> {
    let slot = this.#slots.get(provider.id);
    if (!slot) {
      slot = { active: 0, waiting: [] };
      this.#slots.set(provider.id, slot);
    }
    const owned = slot;
    if (signal.aborted)
      throw new DOMException("Web provider turn was cancelled.", "AbortError");
    if (owned.active >= this.#limit(provider) || owned.waiting.length > 0)
      await new Promise<void>((resolve, reject) => {
        const enter = (): void => {
          signal.removeEventListener("abort", aborted);
          resolve();
        };
        const aborted = (): void => {
          const index = owned.waiting.indexOf(enter);
          if (index >= 0) owned.waiting.splice(index, 1);
          reject(
            new DOMException("Web provider turn was cancelled.", "AbortError"),
          );
        };
        signal.addEventListener("abort", aborted, { once: true });
        owned.waiting.push(enter);
      });
    owned.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      owned.active -= 1;
      while (owned.waiting.length > 0 && owned.active < this.#limit(provider))
        owned.waiting.shift()!();
    };
  }

  async close(): Promise<void> {
    this.#closing.abort();
    await Promise.all(
      [...this.#providers.values()].map((provider) => provider.close()),
    );
  }
}
