import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  GeminiLocator as Locator,
  GeminiPage as Page,
  GeminiBrowserHost,
} from "./gemini-page.js";
import {
  RetainedFullSourceUnavailableError,
  FullMcpUnavailableError,
  WebProviderError,
  bridgeExecutionLimitProblem,
  synchronizeBridgeExecutionPreflight,
  type BridgeExecutionPreflight,
  type RunWebTurnInput,
  type WebProvider,
  type WebProviderCapabilities,
  type WebProviderRoute,
  type WebProviderResult,
  type WebProviderSelection,
} from "@codexgpt-bridge/responses-gateway";
import { ChromeChatGptHost } from "./chrome-chatgpt-window.js";
import { geminiAccountEmails } from "./gemini-account.js";
import { geminiTemporaryChatState } from "./gemini-temporary.js";
import {
  geminiNotebookId,
  geminiNotebookName,
  geminiNotebookUrl,
  matchGeminiNotebook,
} from "./gemini-notebooks.js";
import { geminiFullTransportReminder } from "./gemini-full-protocol.js";
import { planContextSync, type ContextReceipt } from "./context-sync.js";
import { writeDurableJson } from "./durable-json.js";
import {
  DEFAULT_GEMINI_SETTINGS,
  parseGeminiSettings,
} from "./gemini-settings.js";
import type { GeminiSettings, GeminiStatus } from "./gemini-types.js";
import {
  GeminiGenerationError,
  GeminiReplyTracker,
  geminiAlertError,
  geminiLockedModelError,
  geminiRenderedReplyText,
  geminiPermissionScope,
} from "./gemini-generation.js";

const HOME = "https://gemini.google.com/app?hl=en";
const EDITOR = '.ql-editor[contenteditable="true"][role="textbox"]';
const PICKER = /^Open mode picker, currently /u;
// Gemini lists models as menuitemradio; older pages used menuitem.
const MENU_ITEM = ':is([role="menuitem"],[role="menuitemradio"])';
const MODEL_ITEM = `[data-mode-id]${MENU_ITEM}`;
const TEMPORARY_MODE_CONTROLS =
  'button[aria-label="Temporary chat"],infinite-scroller.temporary-chat';
const CAPABILITY_NOTICE =
  "[Gemini Bridge capabilities] This adapter delivers text and the Codex tool protocol. Gemini native media, attachments, Canvas, research, learning and notebooks are not integrated. Do not start those built-in activities; report an unsupported request clearly. Codex retains control of workspace tools. [/Gemini Bridge capabilities]";
const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const normalize = (text: string): string => text.replace(/\s+/gu, " ").trim();
const safeError = (error: unknown): string =>
  (error instanceof Error ? error.message : "Gemini operation failed.").replace(
    /turn_[A-Za-z0-9_-]+/gu,
    "[task capability]",
  );
const emptyCapabilities = (): WebProviderCapabilities => ({
  version: 1,
  provider: "gemini",
  accountKey: "unverified",
  observedAt: new Date().toISOString(),
  routes: [],
});

interface Conversation {
  readonly url: string;
  readonly receipt?: ContextReceipt;
  readonly accountKey: string;
}
interface Operation {
  readonly temporaryChat?: boolean;
  readonly baselineUserCount?: number;
  readonly submittedAt?: number;
  readonly answerId?: string;
  readonly failureCode?: string;
  readonly execution?: BridgeExecutionPreflight;
  readonly phase: "submitting" | "submitted" | "completed" | "failed";
  readonly promptHash: string;
  readonly capabilityHash: string;
  readonly accountKey: string;
  readonly selection: WebProviderSelection;
  readonly baseline: readonly string[];
  readonly conversationUrl?: string;
  readonly output?: string;
  readonly at: number;
}

function conversationUrl(value: string): string | undefined {
  const url = new URL(value);
  return url.origin === "https://gemini.google.com" &&
    /^\/app\/[a-zA-Z0-9_-]+$/u.test(url.pathname)
    ? `${url.origin}${url.pathname}?hl=en`
    : undefined;
}
async function jsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
async function pageObservation(page: Page) {
  const observation = await page.evaluate(() => {
    const shown = (element: Element): boolean =>
      element.getBoundingClientRect().width > 0 &&
      element.getBoundingClientRect().height > 0;
    const responses = [...document.querySelectorAll("model-response")].map(
      (response) => {
        const content = response.querySelector("message-content");
        const markdown = content?.querySelector<HTMLElement>(".markdown");
        return {
          id: content?.id ?? "",
          text: markdown?.innerText ?? "",
          codeBlocks: [
            ...(markdown?.querySelectorAll<HTMLElement>("code-block") ?? []),
          ].map((block) => ({
            text: block.innerText,
            code:
              block.querySelector<HTMLElement>("pre code, pre")?.innerText ??
              null,
          })),
          complete: !!response.querySelector(".response-footer.complete"),
          nativeToolResponse: !!response.querySelector(
            "remy-confirmation-card",
          ),
          footerClasses: [...response.querySelectorAll('[class*="footer"]')]
            .map((element) => element.className)
            .slice(0, 8),
          responseActions: [...response.querySelectorAll("button[aria-label]")]
            .filter(shown)
            .map((element) => element.getAttribute("aria-label")),
        };
      },
    );
    const buttons = [...document.querySelectorAll("button")].filter(shown);
    return {
      responses,
      busy: buttons.some(
        (button) => button.getAttribute("aria-label") === "Stop response",
      ),
      permission: buttons.some(
        (button) => button.textContent?.trim() === "Allow" && !button.disabled,
      ),
      users: [...document.querySelectorAll("user-query")].map(
        (element) => (element as HTMLElement).innerText,
      ),
      alerts: [...document.querySelectorAll('[role="alert"]')]
        .filter(shown)
        .map((element) => (element as HTMLElement).innerText)
        .filter(Boolean),
    };
  });
  return {
    ...observation,
    responses: observation.responses.map(({ codeBlocks, ...response }) => ({
      ...response,
      text: geminiRenderedReplyText(response.text, codeBlocks),
    })),
  };
}

/** Gemini owns only its browser state. Every tool still goes through Codex. */
export class GeminiBrowserProvider implements WebProvider {
  readonly id = "gemini" as const;
  readonly #host: GeminiBrowserHost;
  #loaded: Promise<void> | undefined;
  #settings = DEFAULT_GEMINI_SETTINGS;
  #capabilities = emptyCapabilities();
  #conversations = new Map<string, Conversation>();
  #operations = new Map<string, Operation>();
  #page: Page | undefined;
  #verified = false;
  #verifying = false;
  /** Login, discovery and verification need the browser to themselves. */
  #exclusive = false;
  #activeTurns = 0;
  /** Pages currently leased by turns; the first turn uses the primary page. */
  readonly #turnPages = new Set<Page>();
  readonly #idlePages: Page[] = [];
  readonly #aborts = new Set<AbortController>();
  #writes: Promise<void> = Promise.resolve();
  /** Notebook lookup and creation run one at a time so two tasks never create twins. */
  #notebookQueue: Promise<unknown> = Promise.resolve();
  get #busy(): boolean {
    return this.#exclusive || this.#activeTurns > 0;
  }
  maxConcurrentTurns(): number {
    return this.#host.createExtraPage ? this.#settings.maxConcurrentTurns : 1;
  }
  /** Serialize record writes so concurrent turns cannot interleave them. */
  #persist(file: string, text: string): Promise<void> {
    const run = this.#writes.then(() => writeDurableJson(file, text));
    this.#writes = run.catch(() => undefined);
    return run;
  }
  async #leaseTurnPage(): Promise<Page> {
    const primary = await this.#browser("turn");
    if (!this.#turnPages.has(primary)) {
      this.#turnPages.add(primary);
      return primary;
    }
    let extra = this.#idlePages.pop();
    while (extra?.isClosed()) extra = this.#idlePages.pop();
    if (!extra) {
      if (!this.#host.createExtraPage)
        throw new Error("This Gemini browser runs one task at a time.");
      extra = await this.#host.createExtraPage();
    }
    this.#turnPages.add(extra);
    return extra;
  }
  #releaseTurnPage(page: Page): void {
    this.#turnPages.delete(page);
    if (page !== this.#page && !page.isClosed()) this.#idlePages.push(page);
  }
  #error: string | undefined;
  #automaticPermissionApprovals = 0;
  readonly #steps: { step: string; at: number; model?: string }[] = [];
  #step(step: string, model?: string): void {
    this.#steps.push({ step, at: Date.now(), ...(model ? { model } : {}) });
    if (this.#steps.length > 40) this.#steps.shift();
  }
  async diagnostics(): Promise<unknown> {
    const page = this.#page;
    let screenshotPath: string | undefined;
    if (
      page &&
      !page.isClosed() &&
      new URL(page.url()).origin === "https://gemini.google.com"
    ) {
      screenshotPath = join(this.directory, "browser-diagnostics.png");
      await page
        .screenshot({ path: screenshotPath, timeout: 5000 })
        .catch(() => {
          screenshotPath = undefined;
        });
    }
    return {
      version: 1,
      busy: this.#busy,
      ...(page &&
      !page.isClosed() &&
      new URL(page.url()).origin === "https://gemini.google.com"
        ? {
            generation: await pageObservation(page).then((observation) => ({
              busy: observation.busy,
              userCount: observation.users.length,
              responses: observation.responses.map((response) => ({
                id: response.id,
                complete: response.complete,
                textLength: response.text.length,
                footerClasses: response.footerClasses,
                responseActions: response.responseActions,
              })),
              alerts: observation.alerts.map((text) =>
                safeError(new Error(text)),
              ),
            })),
          }
        : {}),
      automaticPermissionApprovals: this.#automaticPermissionApprovals,
      ...(page && !page.isClosed()
        ? {
            temporaryChatState: await page
              .locator(TEMPORARY_MODE_CONTROLS)
              .evaluateAll(geminiTemporaryChatState),
          }
        : {}),
      steps: [...this.#steps],
      ...(screenshotPath ? { screenshotPath } : {}),
      ...(page && !page.isClosed()
        ? {
            surface: await page.evaluate(() => ({
              path: location.pathname,
              accountAnchors: [
                ...document.querySelectorAll(
                  'a[href^="https://accounts.google.com/"]',
                ),
              ].map((e) => ({
                path: new URL((e as HTMLAnchorElement).href).pathname,
                hasLabel: !!e.getAttribute("aria-label"),
                width: e.getBoundingClientRect().width,
                height: e.getBoundingClientRect().height,
              })),
              pageReady: document.readyState,
              visibility: document.visibilityState,
              permissions: [...document.querySelectorAll("button")]
                .filter(
                  (button) =>
                    button.textContent?.trim() === "Allow" &&
                    !button.disabled &&
                    button.getBoundingClientRect().width > 0,
                )
                .map((button) => {
                  const roots = [
                    ...document.querySelectorAll("model-response"),
                  ];
                  const parents: {
                    tag: string;
                    role: string | null;
                    classes: string;
                    text: string;
                  }[] = [];
                  let element: Element | null = button.parentElement;
                  for (
                    let depth = 0;
                    element && depth < 10;
                    depth++, element = element.parentElement
                  ) {
                    parents.push({
                      tag: element.tagName.toLowerCase(),
                      role: element.getAttribute("role"),
                      classes: element.className.toString().slice(0, 160),
                      text: (element.textContent ?? "")
                        .replace(/turn_[A-Za-z0-9_-]+/gu, "[task capability]")
                        .replace(/\s+/gu, " ")
                        .slice(0, 500),
                    });
                    if (element.tagName.toLowerCase() === "model-response")
                      break;
                  }
                  return {
                    responseIndex: roots.indexOf(
                      button.closest("model-response")!,
                    ),
                    parents,
                  };
                }),
              pickers: [...document.querySelectorAll("button")]
                .filter((e) =>
                  /mode picker/iu.test(e.getAttribute("aria-label") ?? ""),
                )
                .map((e) => ({
                  label: e.getAttribute("aria-label"),
                  expanded: e.getAttribute("aria-expanded"),
                })),
              items: [
                ...document.querySelectorAll(
                  '[role="menuitem"],[data-mode-id]',
                ),
              ].map((e) => ({
                tag: e.tagName,
                role: e.getAttribute("role"),
                id: e.getAttribute("data-mode-id"),
                text: (e as HTMLElement).innerText.slice(0, 100),
                width: e.getBoundingClientRect().width,
                height: e.getBoundingClientRect().height,
                selected:
                  !!e.querySelector('[aria-label="Selected"]') ||
                  e.getAttribute("aria-checked") === "true",
                expanded: e.getAttribute("aria-expanded"),
              })),
            })),
          }
        : {}),
    };
  }

  constructor(
    private readonly directory: string,
    host: string | GeminiBrowserHost,
    /** Codex sidebar project for a task, read locally; never from the prompt. */
    private readonly resolveProjectName?: (input: {
      readonly threadId?: string;
      readonly cwd?: string;
    }) => Promise<string | undefined>,
  ) {
    // Playwright supplies this subset too; its locator combinators use its own
    // larger Locator type, so narrow that legacy host at this boundary only.
    this.#host =
      typeof host === "string"
        ? (new ChromeChatGptHost(
            host,
            undefined,
            true,
          ) as unknown as GeminiBrowserHost)
        : host;
  }
  async #load(): Promise<void> {
    return (this.#loaded ??= (async () => {
      this.#settings = parseGeminiSettings(
        await jsonFile(
          join(this.directory, "settings.json"),
          DEFAULT_GEMINI_SETTINGS,
        ),
      );
      this.#capabilities = await jsonFile(
        join(this.directory, "capabilities.json"),
        emptyCapabilities(),
      );
      const conversations = await jsonFile<{
        version: number;
        entries: [string, Conversation][];
      }>(join(this.directory, "conversations.json"), {
        version: 1,
        entries: [],
      });
      const operations = await jsonFile<{
        version: number;
        entries: [string, Operation][];
      }>(join(this.directory, "operations.json"), { version: 1, entries: [] });
      if (
        conversations.version !== 1 ||
        operations.version !== 1 ||
        this.#capabilities.version !== 1 ||
        this.#capabilities.provider !== "gemini"
      )
        throw new Error("Unsupported Gemini state version.");
      this.#conversations = new Map(conversations.entries);
      this.#operations = new Map(operations.entries);
    })());
  }
  async settings(): Promise<GeminiSettings> {
    try {
      await this.#load();
      return this.#settings;
    } catch (error) {
      this.#error = safeError(error);
      return DEFAULT_GEMINI_SETTINGS;
    }
  }
  async configure(value: Partial<GeminiSettings>): Promise<GeminiSettings> {
    await this.#load();
    if (this.#busy)
      throw new Error(
        "Wait for the active Gemini task before changing its settings.",
      );
    const settings = parseGeminiSettings({
      ...this.#settings,
      ...value,
      version: 1,
    });
    await writeDurableJson(
      join(this.directory, "settings.json"),
      JSON.stringify(settings),
    );
    this.#settings = settings;
    return settings;
  }
  async status(): Promise<Omit<GeminiStatus, "mcp">> {
    try {
      await this.#load();
    } catch (error) {
      return {
        settings: DEFAULT_GEMINI_SETTINGS,
        login: { phase: "idle", verified: false },
        capabilities: emptyCapabilities(),
        busy: false,
        error: safeError(error),
      };
    }
    const login = this.#host.manualLoginStatus();
    return {
      settings: this.#settings,
      login: {
        ...login,
        browserHost: this.#host.kind ?? "chrome",
        phase: this.#verifying ? "verifying" : login.phase,
        verified: this.#verified,
      },
      capabilities: await this.capabilities(),
      busy: this.#busy,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }
  async capabilities(): Promise<WebProviderCapabilities> {
    try {
      await this.#load();
    } catch (error) {
      this.#error = safeError(error);
      return emptyCapabilities();
    }
    return this.#settings.enabled && this.#verified
      ? {
          ...this.#capabilities,
          routes: this.#capabilities.routes.filter(
            (route) =>
              route.toolMode === "simple" || !!this.#settings.publicBaseUrl,
          ),
        }
      : { ...this.#capabilities, routes: [] };
  }
  async login(): Promise<void> {
    await this.#load();
    if (this.#busy) throw new Error("Gemini has an active task.");
    this.#verified = false;
    this.#page = undefined;
    this.#error = undefined;
    await this.#host.beginManualLogin(HOME);
  }
  async finishLogin(): Promise<WebProviderCapabilities> {
    this.#host.finishManualLogin();
    return this.discover();
  }
  async restoreLogin(): Promise<void> {
    // A fresh window can briefly sit off gemini.google.com while it loads or
    // redirects; retry that case so one slow start does not hide every route.
    for (let attempt = 1; ; attempt += 1) {
      await this.#restoreLoginOnce();
      if (
        this.#verified ||
        attempt >= 3 ||
        !this.#error?.includes("left its expected origin")
      )
        return;
      await delay(5000);
    }
  }
  async #restoreLoginOnce(): Promise<void> {
    try {
      await this.#load();
      if (!this.#settings.enabled || !(await this.#host.restoreSavedLogin()))
        return;
      if (this.#capabilities.routes.length) {
        this.#verifying = true;
        this.#exclusive = true;
        try {
          const page = await this.#browser("login");
          await this.#newChat(page);
          if ((await this.#account(page)) === this.#capabilities.accountKey) {
            this.#host.confirmVerifiedLogin();
            this.#verified = true;
            this.#error = undefined;
            return;
          }
        } finally {
          this.#verifying = false;
          this.#exclusive = false;
        }
      }
      await this.discover();
    } catch (error) {
      this.#error = safeError(error);
      if (
        error instanceof GeminiGenerationError &&
        error.code === "gemini_login_required"
      ) {
        this.#verified = false;
        this.#host.invalidateVerifiedLogin();
      }
    }
  }
  async #browser(purpose: "login" | "turn"): Promise<Page> {
    if (!this.#page || this.#page.isClosed())
      this.#page = await this.#host.createPage(purpose);
    return this.#page;
  }
  async #account(page: Page, continuityAccount?: string): Promise<string> {
    const origin = new URL(page.url()).origin;
    if (origin === "https://accounts.google.com")
      throw new GeminiGenerationError(
        "gemini_login_required",
        "Complete Gemini sign-in in the Bridge browser.",
      );
    if (origin !== "https://gemini.google.com")
      throw new GeminiGenerationError(
        "gemini_page_changed",
        "Gemini left its expected origin. The operation was not automatically resent.",
      );
    // Gemini's account anchor can expose either the button or link role.
    // Only the visible Google account destination identifies this profile;
    // conversation text and hidden account-menu duplicates do not qualify.
    const deadline = Date.now() + 15000;
    let emails: string[] = [];
    while (Date.now() < deadline) {
      emails = await page
        .locator(
          'a[href^="https://accounts.google.com/SignOutOptions"][aria-label]',
        )
        .evaluateAll(geminiAccountEmails);
      // Gemini hides the Google account control while rendering an answer.
      // Hidden metadata may confirm this already-verified account, never log in
      // or establish a new identity. Visible identities always take precedence.
      if (
        !emails.length &&
        this.#verified &&
        continuityAccount === this.#capabilities.accountKey
      ) {
        const known = await page
          .locator(
            'a[href^="https://accounts.google.com/SignOutOptions"][aria-label]',
          )
          .evaluateAll(geminiAccountEmails, true);
        const signIn = page
          .getByRole("link", { name: "Sign in", exact: true })
          .or(page.getByRole("button", { name: "Sign in", exact: true }));
        if (
          !(await signIn.first().isVisible()) &&
          known.length === 1 &&
          hash(known[0]!.toLowerCase()) === continuityAccount
        )
          emails = known;
      }
      if (emails.length) break;
      await delay(200);
    }
    const email = emails.length === 1 ? emails[0] : undefined;
    if (!email) {
      const diagnostic = await page.evaluate(() => {
        const visible = (element: Element): boolean =>
          element.getBoundingClientRect().width > 0 &&
          element.getBoundingClientRect().height > 0;
        return {
          origin: location.origin,
          path: location.pathname,
          headings: [...document.querySelectorAll("h1,h2")]
            .filter(visible)
            .slice(0, 3)
            .map((element) => (element as HTMLElement).innerText),
          accountControls: [...document.querySelectorAll("[aria-label]")]
            .filter(visible)
            .filter((element) =>
              /Google|帳戶|账号|アカウント|계정/u.test(
                element.getAttribute("aria-label") ?? "",
              ),
            )
            .map((element) => ({
              tag: element.tagName,
              role: element.getAttribute("role"),
              label: element
                .getAttribute("aria-label")
                ?.replace(/[^\s()]+@[^\s()]+/gu, "[account]"),
            })),
          signInVisible: [...document.querySelectorAll("a,button")]
            .filter(visible)
            .some((element) =>
              /^Sign in$/iu.test((element as HTMLElement).innerText.trim()),
            ),
        };
      });
      await writeDurableJson(
        join(this.directory, "login-diagnostics.json"),
        JSON.stringify({
          version: 1,
          at: new Date().toISOString(),
          ...diagnostic,
        }),
      );
      throw new GeminiGenerationError(
        diagnostic.signInVisible
          ? "gemini_login_required"
          : "gemini_page_changed",
        diagnostic.signInVisible
          ? "Complete Gemini sign-in in the Bridge browser. The page still shows Sign in."
          : "Gemini did not expose one verifiable Google account. The operation was not automatically resent.",
      );
    }
    await page
      .locator(EDITOR)
      .waitFor({ state: "visible", timeout: 15000 })
      .catch(() => {
        throw new GeminiGenerationError(
          "gemini_page_changed",
          "Gemini did not expose its expected composer. No prompt was submitted.",
        );
      });
    return hash(email.toLowerCase());
  }
  async #temporaryState(page: Page) {
    return page
      .locator(TEMPORARY_MODE_CONTROLS)
      .evaluateAll(geminiTemporaryChatState);
  }
  async #requireTemporaryMode(page: Page, expected: boolean): Promise<void> {
    const state = await this.#temporaryState(page);
    if (
      (expected && state !== "active") ||
      (!expected && (state === "active" || state === "ambiguous"))
    )
      throw new WebProviderError(
        "selection_mismatch",
        "The requested Gemini temporary-chat mode could not be verified. The request was not submitted or resent through another mode.",
      );
  }
  async #newChat(page: Page, temporary = false): Promise<void> {
    await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
    await this.#account(page);
    const control = page.getByRole("button", {
      name: "Temporary chat",
      exact: true,
    });
    if (temporary)
      await control.waitFor({ state: "visible", timeout: 10000 }).catch(() => {
        throw new WebProviderError(
          "provider_unavailable",
          "This Gemini account did not expose Temporary chat. No prompt was submitted.",
        );
      });
    const state = await this.#temporaryState(page);
    if (
      (temporary && state === "inactive") ||
      (!temporary && state === "active")
    ) {
      await control.click();
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (
          (await this.#temporaryState(page)) ===
          (temporary ? "active" : "inactive")
        )
          break;
        await delay(100);
      }
    }
    await this.#requireTemporaryMode(page, temporary);
    this.#step(temporary ? "temporary-chat-started" : "regular-chat-started");
  }
  /** Start a new chat inside the same-named notebook, creating it when missing. */
  #notebookChat(page: Page, projectName: string): Promise<void> {
    const run = this.#notebookQueue.then(() =>
      this.#notebookChatNow(page, geminiNotebookName(projectName)),
    );
    this.#notebookQueue = run.catch(() => undefined);
    return run;
  }
  async #notebookChatNow(page: Page, name: string): Promise<void> {
    await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
    await this.#account(page);
    let id = await this.#findNotebook(page, name);
    if (!id) {
      id = await this.#createNotebook(page, name);
      // A first message sent on the just-created page never gets an answer;
      // reloading the notebook first makes it behave like an existing one.
      await delay(2000);
    }
    await page.goto(geminiNotebookUrl(id), {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page
      .locator(EDITOR)
      .first()
      .waitFor({ state: "visible", timeout: 30000 })
      .catch(() => {
        throw new GeminiGenerationError(
          "gemini_page_changed",
          `Gemini notebook "${name}" did not show its composer. No prompt was submitted.`,
        );
      });
    if (geminiNotebookId(page.url()) !== id)
      throw new WebProviderError(
        "selection_mismatch",
        `Gemini did not stay in notebook "${name}". No prompt was submitted.`,
      );
    await this.#requireTemporaryMode(page, false);
    this.#step("notebook-chat-started");
  }
  async #notebookLinks(page: Page) {
    return page.locator('a[href^="/notebook/"]').evaluateAll((elements) =>
      elements.map((element) => ({
        href: element.getAttribute("href") ?? "",
        name:
          element.getAttribute("aria-label") ??
          element.querySelector(".title-text")?.textContent ??
          "",
      })),
    );
  }
  async #findNotebook(page: Page, name: string): Promise<string | undefined> {
    // The sidebar renders its notebook section after the composer.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (
        (await page.locator('[data-test-id="new-notebook-button"]').count()) > 0
      )
        break;
      await delay(250);
    }
    if (
      (await page.locator('[data-test-id="new-notebook-button"]').count()) === 0
    )
      throw new GeminiGenerationError(
        "gemini_page_changed",
        "Gemini did not show its notebook list. No prompt was submitted.",
      );
    // The notebook list loads after its "New notebook" entry; creating too early
    // would make a same-named twin, so keep looking for a while first.
    const listDeadline = Date.now() + 10000;
    for (;;) {
      const id = matchGeminiNotebook(await this.#notebookLinks(page), name);
      if (id || Date.now() >= listDeadline) return id;
      await delay(500);
    }
  }
  async #createNotebook(page: Page, name: string): Promise<string> {
    await page.goto("https://gemini.google.com/notebooks/create?hl=en", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const input = page.locator("input.project-name-input");
    const ready = () =>
      input
        .first()
        .waitFor({ state: "visible", timeout: 10000 })
        .then(
          () => true,
          () => false,
        );
    if (!(await ready())) {
      // First use shows a one-time introduction before the create form.
      await page
        .getByRole("button", { name: /^(Get started|開始使用)$/u })
        .first()
        .click()
        .catch(() => undefined);
      if (!(await ready()))
        throw new GeminiGenerationError(
          "gemini_page_changed",
          "Gemini did not show its create-notebook form. No prompt was submitted.",
        );
    }
    await input.first().fill(name);
    const create = page.getByRole("button", {
      name: /^(Create notebook|建立筆記本)$/u,
    });
    if (
      await create
        .first()
        .waitFor({ state: "visible", timeout: 5000 })
        .then(
          () => true,
          () => false,
        )
    )
      await create.first().click();
    else {
      await input.first().focus();
      await page.keyboard.press("Enter");
    }
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const id = geminiNotebookId(page.url());
      if (id) {
        this.#step("notebook-created");
        return id;
      }
      await delay(250);
    }
    throw new GeminiGenerationError(
      "gemini_page_changed",
      `Gemini did not create notebook "${name}". No prompt was submitted.`,
    );
  }
  async probeTemporaryFullMcp(): Promise<unknown> {
    await this.#load();
    if (this.#busy) throw new Error("Gemini has an active task.");
    this.#exclusive = true;
    const evidence: {
      temporary: boolean;
      mode: string;
      appVisible: boolean;
    }[] = [];
    try {
      const page = await this.#browser("login");
      for (const temporary of [false, true]) {
        await this.#newChat(page, temporary);
        if ((await this.#account(page)) !== this.#capabilities.accountKey)
          throw new WebProviderError(
            "account_changed",
            "The Gemini account changed before the compatibility probe.",
          );
        const editor = page.locator(EDITOR);
        await editor.fill("");
        await editor.pressSequentially(
          "@" + this.#settings.connectorName.split(/\s+/u)[0]!,
        );
        const app = page.getByRole("menuitem", {
          name: this.#settings.connectorName,
          exact: true,
        });
        const appVisible = await app
          .waitFor({ state: "visible", timeout: 5000 })
          .then(
            () => true,
            () => false,
          );
        evidence.push({
          temporary,
          mode: await this.#temporaryState(page),
          appVisible,
        });
        await editor.fill("");
      }
      const result = { version: 1, at: new Date().toISOString(), evidence };
      await writeDurableJson(
        join(this.directory, "temporary-mcp-compatibility.json"),
        JSON.stringify(result),
      );
      return result;
    } finally {
      this.#exclusive = false;
    }
  }
  async #attachApp(page: Page): Promise<void> {
    const editor = page.locator(EDITOR);
    await editor.fill("");
    await editor.pressSequentially(
      "@" + this.#settings.connectorName.split(/\s+/u)[0]!,
    );
    const app = page.getByRole("menuitem", {
      name: this.#settings.connectorName,
      exact: true,
    });
    await app.waitFor({ state: "visible", timeout: 10000 }).catch(() => {
      throw new Error(
        "The exact Gemini MCP app is not connected. Open Gemini connectors and finish its normal OAuth linking flow before using Full MCP.",
      );
    });
    await app.click();
  }
  async #openPicker(page: Page): Promise<void> {
    this.#step("open-picker");
    const models = page.locator(MODEL_ITEM).filter({ visible: true });
    if (await models.first().isVisible()) return;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (await models.first().isVisible()) return;
        if (attempt) await page.keyboard.press("Escape");
        await page.getByRole("button", { name: PICKER }).click();
        try {
          await models.first().waitFor({ state: "visible", timeout: 12000 });
          return;
        } catch (error) {
          if (attempt) throw error;
        }
      }
    } catch (error) {
      const surface = await page.evaluate(() => ({
        path: location.pathname,
        pickers: [...document.querySelectorAll("button")]
          .filter((e) =>
            /mode picker/iu.test(e.getAttribute("aria-label") ?? ""),
          )
          .map((e) => ({
            label: e.getAttribute("aria-label"),
            expanded: e.getAttribute("aria-expanded"),
          })),
        items: [
          ...document.querySelectorAll('[role="menuitem"],[data-mode-id]'),
        ].map((e) => ({
          tag: e.tagName,
          role: e.getAttribute("role"),
          id: e.getAttribute("data-mode-id"),
          text: (e as HTMLElement).innerText.slice(0, 100),
          width: e.getBoundingClientRect().width,
          height: e.getBoundingClientRect().height,
        })),
      }));
      await writeDurableJson(
        join(this.directory, "capability-diagnostics.json"),
        JSON.stringify({
          version: 1,
          at: new Date().toISOString(),
          phase: "open-picker",
          ...surface,
        }),
      );
      throw error;
    }
  }
  async #closePicker(page: Page): Promise<void> {
    this.#step("close-picker");
    const models = page.locator(MODEL_ITEM).filter({ visible: true });
    if (await models.first().isVisible())
      await page.getByRole("button", { name: PICKER }).click({ force: true });
    await page
      .locator(MODEL_ITEM)
      .filter({ visible: true })
      .first()
      .waitFor({ state: "hidden", timeout: 10000 });
  }
  async #models(page: Page): Promise<
    {
      id: string;
      name: string;
      selected: boolean;
      locked: boolean;
      note: string;
    }[]
  > {
    return page.locator(MODEL_ITEM).evaluateAll((elements) =>
      elements
        .filter((element) => element.getBoundingClientRect().width > 0)
        .map((element) => {
          const lines = (element as HTMLElement).innerText.split("\n");
          return {
            id: element.getAttribute("data-mode-id")!,
            name: lines[0]!.trim(),
            selected:
              !!element.querySelector('[aria-label="Selected"]') ||
              element.getAttribute("aria-checked") === "true",
            // A model past its usage limit stays listed but disabled,
            // with "Limit resets <time>" as its description.
            locked: element.getAttribute("aria-disabled") === "true",
            note: lines.slice(1).join(" ").trim(),
          };
        }),
    );
  }
  async #thinkingOptions(
    page: Page,
    expected = false,
  ): Promise<Locator | undefined> {
    const parent = page.getByRole("menuitem", {
      name: /^Thinking level(?:\s|$)/u,
    });
    if (expected) {
      try {
        await parent.waitFor({ state: "visible", timeout: 5000 });
      } catch {
        const items = await page
          .locator('[role="menuitem"],[data-mode-id]')
          .evaluateAll((elements) =>
            elements.map((element) => ({
              role: element.getAttribute("role"),
              label: element.getAttribute("aria-label"),
              text: (element as HTMLElement).innerText.slice(0, 160),
              visible: element.getBoundingClientRect().width > 0,
            })),
          );
        await writeDurableJson(
          join(this.directory, "capability-diagnostics.json"),
          JSON.stringify({
            version: 1,
            at: new Date().toISOString(),
            phase: "thinking-options",
            items,
          }),
        );
        return undefined;
      }
    } else if (!(await parent.count())) return undefined;
    if ((await parent.getAttribute("aria-expanded")) !== "true")
      await parent.click();
    const options = page
      .locator(`${MENU_ITEM}:not([data-mode-id]):not([aria-expanded])`)
      .filter({ visible: true });
    await options.first().waitFor({ state: "visible", timeout: 10000 });
    return options;
  }
  async #selection(
    page: Page,
    expectedThinking = false,
  ): Promise<{ model: string; thinking?: string }> {
    await this.#openPicker(page);
    const selected = (await this.#models(page)).filter(
      (model) => model.selected,
    );
    if (selected.length !== 1)
      throw new Error("Gemini did not confirm one selected model.");
    let thinking: string | undefined;
    const options = await this.#thinkingOptions(page, expectedThinking);
    if (options) {
      this.#step("read-thinking");
      thinking = await options.evaluateAll((elements) =>
        (
          elements.find(
            (element) =>
              element.getBoundingClientRect().width > 0 &&
              (!!element.querySelector('[aria-label="Selected"]') ||
                element.getAttribute("aria-checked") === "true"),
          ) as HTMLElement | undefined
        )?.innerText
          .trim()
          .split("\n")[0]
          ?.trim(),
      );
    }
    await this.#closePicker(page);
    return { model: selected[0]!.name, ...(thinking ? { thinking } : {}) };
  }
  async #select(page: Page, route: WebProviderRoute): Promise<void> {
    this.#step(
      "check-selection",
      route.selection.model + " / " + (route.selection.thinking ?? "default"),
    );
    await this.#openPicker(page);
    const models = await this.#models(page);
    const model = models.find(
      (candidate) => candidate.name === route.selection.model,
    );
    if (!model)
      throw new WebProviderError(
        "model_unavailable",
        "The requested Gemini model is not available. No prompt was submitted.",
      );
    if (model.locked) {
      await this.#closePicker(page);
      throw geminiLockedModelError(model.name, model.note);
    }
    let changed = false;
    if (!model.selected) {
      this.#step("select-model", route.selection.model);
      await page
        .locator(MENU_ITEM + "[data-mode-id=" + JSON.stringify(model.id) + "]")
        .filter({ visible: true })
        .click();
      changed = true;
      await this.#closePicker(page);
    }
    if (route.selection.thinking) {
      await this.#openPicker(page);
      const options = await this.#thinkingOptions(page, true);
      if (!options)
        throw new WebProviderError(
          "model_unavailable",
          "The requested Gemini thinking level is unavailable.",
        );
      const names = await options.evaluateAll((elements) =>
        elements.map((element, index) => ({
          index,
          name: (element as HTMLElement).innerText.split("\n")[0]?.trim(),
          visible: element.getBoundingClientRect().width > 0,
          selected:
            !!element.querySelector('[aria-label="Selected"]') ||
            element.getAttribute("aria-checked") === "true",
        })),
      );
      const matches = names.filter(
        (option) => option.visible && option.name === route.selection.thinking,
      );
      if (matches.length !== 1)
        throw new Error(
          "Gemini did not expose the exact requested thinking level.",
        );
      if (!matches[0]!.selected) {
        this.#step(
          "select-thinking",
          route.selection.model + " / " + route.selection.thinking,
        );
        await options.nth(matches[0]!.index).click();
        changed = true;
      }
    }
    await this.#closePicker(page);
    if (
      !changed &&
      route.selection.thinking &&
      models.filter((candidate) => candidate.selected).length === 1
    ) {
      this.#step("selection-confirmed");
      return;
    }
    const selected = await this.#selection(page, !!route.selection.thinking);
    if (
      selected.model !== route.selection.model ||
      selected.thinking !== route.selection.thinking
    )
      throw new Error(
        "Gemini selected a different model or thinking level. No prompt was submitted.",
      );
  }
  async discover(): Promise<WebProviderCapabilities> {
    await this.#load();
    if (this.#busy) throw new Error("Gemini has an active task.");
    this.#exclusive = true;
    this.#verifying = true;
    this.#error = undefined;
    let retainedAccountVerified = false;
    try {
      const page = await this.#browser("login");
      await this.#newChat(page);
      const accountKey = await this.#account(page);
      retainedAccountVerified =
        this.#capabilities.accountKey === accountKey &&
        this.#capabilities.routes.length > 0;
      const routes: WebProviderRoute[] = [];
      const toolModes: readonly ("simple" | "full")[] = this.#settings
        .publicBaseUrl
        ? ["simple", "full"]
        : ["simple"];
      for (const toolMode of toolModes) {
        await this.#newChat(page);
        if (toolMode === "full") {
          try {
            await this.#attachApp(page);
          } catch (error) {
            this.#error = safeError(error);
            // Keep earlier verified Full routes whose Simple selection is
            // still offered, instead of dropping them on a failed attach.
            routes.push(
              ...this.#capabilities.routes.filter(
                (previous) =>
                  previous.toolMode === "full" &&
                  previous.accountKey === accountKey &&
                  routes.some(
                    (simple) =>
                      simple.toolMode === "simple" &&
                      simple.selection.model === previous.selection.model &&
                      simple.selection.thinking === previous.selection.thinking,
                  ),
              ),
            );
            break;
          }
        }
        await this.#openPicker(page);
        const models = await this.#models(page);
        await this.#closePicker(page);
        for (const model of models) {
          if (model.locked) {
            // A limited model cannot be opened to read its thinking levels;
            // keep its earlier routes so Codex still lists it after the reset.
            this.#step("discover-model-locked", model.name);
            routes.push(
              ...this.#capabilities.routes.filter(
                (previous) =>
                  previous.toolMode === toolMode &&
                  previous.accountKey === accountKey &&
                  previous.selection.model === model.name,
              ),
            );
            continue;
          }
          this.#step("discover-model", model.name);
          await this.#openPicker(page);
          await page
            .locator(
              MENU_ITEM + "[data-mode-id=" + JSON.stringify(model.id) + "]",
            )
            .filter({ visible: true })
            .click();
          await this.#closePicker(page);
          await this.#openPicker(page);
          const options = await this.#thinkingOptions(page);
          let levels: string[] = [];
          if (options) {
            levels = await options.evaluateAll((elements) =>
              elements
                .filter(
                  (element) =>
                    element.getBoundingClientRect().width > 0 &&
                    element.getAttribute("aria-haspopup") !== "true",
                )
                .map((element) =>
                  (element as HTMLElement).innerText.split("\n")[0]!.trim(),
                )
                .filter((text) => !!text && text !== "Thinking level"),
            );
          }
          await this.#closePicker(page);
          for (const thinking of levels.length ? levels : [undefined]) {
            const level = thinking?.toLowerCase();
            const route: WebProviderRoute = {
              provider: "gemini",
              accountKey,
              toolMode,
              inputModalities: ["text"],
              slug: `gemini-web/${model.id}/${level ?? "default"}/${toolMode}`,
              displayName: `Gemini ${model.name}${thinking ? ` · ${thinking}` : ""} · ${toolMode === "full" ? "Full MCP" : "Simple"}`,
              description:
                "Gemini Web account selection; text and native Codex tools. This selectable combination is not a claim of completed acceptance testing.",
              selection: {
                provider: "gemini",
                model: model.name,
                ...(thinking ? { thinking } : {}),
                activity: "chat",
              },
              effort:
                level === "high"
                  ? "high"
                  : level === "medium"
                    ? "medium"
                    : "low",
              mode: level === "high" ? "high" : "medium",
              contextWindow: 32000,
              contextBudget: {
                contextWindow: 32000,
                hardInputTokenLimit: 32000,
                autoCompactTokenLimit: 28000,
                profile: "gemini-transport-v1",
              },
            };
            try {
              await this.#select(page, route);
              routes.push(route);
            } catch {
              await this.#closePicker(page);
            }
          }
        }
      }
      this.#capabilities = {
        version: 1,
        provider: "gemini",
        accountKey,
        observedAt: new Date().toISOString(),
        routes,
      };
      await writeDurableJson(
        join(this.directory, "capabilities.json"),
        JSON.stringify(this.#capabilities),
      );
      this.#host.confirmVerifiedLogin();
      this.#verified = true;
      return this.#capabilities;
    } catch (error) {
      this.#verified = retainedAccountVerified;
      if (!retainedAccountVerified) this.#host.invalidateVerifiedLogin();
      this.#error = safeError(error);
      throw error;
    } finally {
      this.#exclusive = false;
      this.#verifying = false;
    }
  }
  /** Verify one observed Simple selection in the connected native MCP context.
   * Catalog publication is separate so a real tool acceptance can run first. */
  async verifyFullRoute(simpleSlug: string): Promise<WebProviderCapabilities> {
    await this.#load();
    if (!this.#settings.enabled || !this.#settings.publicBaseUrl)
      throw new FullMcpUnavailableError();
    if (this.#busy) throw new Error("Gemini has an active task.");
    const simple = this.#capabilities.routes.find(
      (route) => route.slug === simpleSlug && route.toolMode === "simple",
    );
    if (!simple)
      throw new WebProviderError(
        "model_unavailable",
        "Verify the requested Simple model selection before probing Full MCP.",
      );
    let sameAccount = false;
    this.#exclusive = true;
    this.#verifying = true;
    try {
      const page = await this.#browser("login");
      await this.#newChat(page);
      const accountKey = await this.#account(page);
      if (accountKey !== simple.accountKey)
        throw new WebProviderError(
          "account_changed",
          "The Gemini account changed. Discover its selectable models before probing Full MCP.",
        );
      sameAccount = true;
      await this.#attachApp(page);
      const route: WebProviderRoute = {
        ...simple,
        toolMode: "full",
        slug: simple.slug.replace(/\/simple$/u, "/full"),
        displayName: simple.displayName.replace(/Simple$/u, "Full MCP"),
      };
      await this.#select(page, route);
      this.#capabilities = {
        ...this.#capabilities,
        observedAt: new Date().toISOString(),
        routes: [
          ...this.#capabilities.routes.filter(
            (existing) => existing.slug !== route.slug,
          ),
          route,
        ],
      };
      await writeDurableJson(
        join(this.directory, "capabilities.json"),
        JSON.stringify(this.#capabilities),
      );
      this.#host.confirmVerifiedLogin();
      this.#verified = true;
      this.#error = undefined;
      return this.#capabilities;
    } catch (error) {
      this.#error = safeError(error);
      this.#verified = sameAccount;
      if (!sameAccount) this.#host.invalidateVerifiedLogin();
      throw error;
    } finally {
      this.#exclusive = false;
      this.#verifying = false;
    }
  }
  async #saveOperation(key: string, operation: Operation): Promise<void> {
    this.#operations.delete(key);
    this.#operations.set(key, operation);
    while (this.#operations.size > 100) {
      const removable = [...this.#operations].find(
        ([, item]) => item.phase === "completed" || item.phase === "failed",
      );
      if (!removable) break;
      this.#operations.delete(removable[0]);
    }
    await this.#persist(
      join(this.directory, "operations.json"),
      JSON.stringify({ version: 1, entries: [...this.#operations] }),
    );
  }
  async runTurn(
    input: RunWebTurnInput & { readonly providerRoute: WebProviderRoute },
  ): Promise<WebProviderResult> {
    await this.#load();
    if (!this.#settings.enabled || !this.#verified)
      throw new GeminiGenerationError(
        "gemini_login_required",
        "Verify the dedicated Gemini account before starting a task.",
      );
    if (this.#exclusive)
      throw new Error(
        "Gemini is verifying its account or models. Try again shortly.",
      );
    if (this.#activeTurns >= this.maxConcurrentTurns())
      throw new Error("Gemini is already running its maximum number of tasks.");
    if (!input.operationId || input.providerRoute.selection.activity !== "chat")
      throw new Error(
        "This Gemini adapter currently supports identified text/chat tasks only.",
      );
    if (input.images.length || input.context?.images.length)
      throw new Error(
        "Gemini attachment delivery is not integrated yet. No prompt was submitted.",
      );
    if (input.requiredSubagentResults)
      throw new Error(
        "Gemini native subagent scheduling is not verified yet. No prompt was submitted.",
      );
    if (
      input.providerRoute.toolMode === "full" &&
      !input.allowWebNativeTools &&
      input.execution?.toolTransport !== "none"
    )
      throw new FullMcpUnavailableError();
    const abort = new AbortController();
    this.#aborts.add(abort);
    input = { ...input, signal: AbortSignal.any([input.signal, abort.signal]) };
    this.#activeTurns += 1;
    let turnPage: Page | undefined;
    this.#error = undefined;
    const route = input.providerRoute;
    const temporary =
      this.#settings.simpleTemporaryChat && route.toolMode === "simple";
    this.#automaticPermissionApprovals = 0;
    const key = hash(
      JSON.stringify({
        account: route.accountKey,
        operation: input.operationId,
        model: route.slug,
        prompt: input.prompt,
        transport: input.allowWebNativeTools
          ? "full"
          : (input.execution?.toolTransport ?? "none"),
        ...(temporary ? { temporaryChat: true } : {}),
      }),
    );
    const capabilityHash = hash(input.turnToken ?? "simple");
    const thread = hash(
      `${route.accountKey}:${input.threadId ?? input.operationId}:${route.slug}${temporary ? ":temporary" : ""}`,
    );
    let record = this.#operations.get(key);
    try {
      input.signal.throwIfAborted();
      if (record?.phase === "completed" && record.output !== undefined)
        return {
          output: record.output,
          selection: record.selection,
          accountKey: record.accountKey,
          ...(record.conversationUrl
            ? { conversationUrl: record.conversationUrl }
            : {}),
        };
      const page = (turnPage = await this.#leaseTurnPage());
      const saved = temporary ? undefined : this.#conversations.get(thread);
      const providerContract =
        CAPABILITY_NOTICE + "\n" + (input.contract ?? "");
      const sync = input.context
        ? planContextSync(
            input.context,
            providerContract,
            input.forceNewConversation ||
              this.#settings.freshConversationPerTurn ||
              temporary
              ? undefined
              : saved?.receipt,
            input.images,
          )
        : undefined;
      const prompt = [
        sync?.text ?? providerContract,
        "[Current request]",
        input.prompt,
        input.allowWebNativeTools
          ? geminiFullTransportReminder(
              input.connectorName ?? this.#settings.connectorName,
              input.turnToken,
            )
          : "[Simple transport reminder: Follow the supplied Codex text/tool frames. Return tool requests only in the formal <codex_tool_calls> JSON array envelope. Never invoke Gemini connected apps or built-in activities.]",
      ]
        .filter(Boolean)
        .join("\n\n");
      const execution = input.execution
        ? synchronizeBridgeExecutionPreflight(input.execution, {
            prompt,
            images: [],
          })
        : undefined;
      if (execution && bridgeExecutionLimitProblem(execution))
        throw Object.assign(
          new Error(
            "The synchronized Gemini prompt exceeds its own transport budget. No prompt was submitted.",
          ),
          { code: "bridge_context_limit_exceeded" },
        );
      if (record) {
        if (temporary)
          throw new GeminiGenerationError(
            "gemini_submission_uncertain",
            "An unfinished Gemini temporary chat cannot be restored after interruption. The submitted request was not resent.",
          );
        if (
          record.phase === "failed" ||
          !record.conversationUrl ||
          record.capabilityHash !== capabilityHash ||
          record.promptHash !== hash(prompt)
        )
          throw new GeminiGenerationError(
            "gemini_submission_uncertain",
            "The submitted Gemini operation cannot be safely resumed with this scope. It was not resent.",
          );
        const resumeUrl = conversationUrl(record.conversationUrl);
        if (!resumeUrl)
          throw new GeminiGenerationError(
            "gemini_submission_uncertain",
            "The saved Gemini destination is invalid. The task was not resent.",
          );
        if (conversationUrl(page.url()) !== resumeUrl)
          await page.goto(resumeUrl, { waitUntil: "domcontentloaded" });
      } else {
        if (input.requireRetainedConversation && (!saved || sync?.reset))
          throw new RetainedFullSourceUnavailableError();
        if (
          saved &&
          !sync?.reset &&
          !input.forceNewConversation &&
          !this.#settings.freshConversationPerTurn
        ) {
          const retainedUrl = conversationUrl(saved.url);
          if (!retainedUrl) throw new RetainedFullSourceUnavailableError();
          if (conversationUrl(page.url()) !== retainedUrl)
            await page.goto(retainedUrl, { waitUntil: "domcontentloaded" });
        } else {
          const projectName =
            !temporary && this.#settings.notebookMapping
              ? await this.resolveProjectName?.(input)
              : undefined;
          if (projectName) await this.#notebookChat(page, projectName);
          else await this.#newChat(page, temporary);
        }
        if ((await this.#account(page, route.accountKey)) !== route.accountKey)
          throw new WebProviderError(
            "account_changed",
            "The Gemini account changed before submission.",
          );
        if (input.allowWebNativeTools) await this.#attachApp(page);
        else await page.locator(EDITOR).fill("");
        await this.#select(page, route);
        input.signal.throwIfAborted();
        const editor = page.locator(EDITOR);
        await editor.focus();
        await page.keyboard.press("End");
        await page.keyboard.insertText(" " + prompt);
        if (!normalize(await editor.innerText()).includes(normalize(prompt)))
          throw new Error(
            "Gemini did not retain the complete prompt. No request was submitted.",
          );
        const beforeSend = await this.#selection(
          page,
          !!route.selection.thinking,
        );
        if (
          beforeSend.model !== route.selection.model ||
          beforeSend.thinking !== route.selection.thinking
        )
          throw new Error(
            "Gemini selection changed before Send. No prompt was submitted.",
          );
        const initial = await pageObservation(page);
        await this.#requireTemporaryMode(page, temporary);
        const baseline = initial.responses.map((response) => response.id);
        input.signal.throwIfAborted();
        record = {
          phase: "submitting",
          promptHash: hash(prompt),
          capabilityHash,
          accountKey: route.accountKey,
          selection: route.selection,
          baseline,
          baselineUserCount: initial.users.length,
          at: Date.now(),
          ...(execution ? { execution } : {}),
          ...(temporary ? { temporaryChat: true } : {}),
        };
        await this.#saveOperation(key, record);
        input.onProgress?.("submitting");
        this.#step("submit");
        input.signal.throwIfAborted();
        await page
          .getByRole("button", { name: "Send message", exact: true })
          .click();
        const confirmationDeadline = Date.now() + 30000;
        let confirmed = false;
        while (!input.signal.aborted && Date.now() < confirmationDeadline) {
          const observation = await pageObservation(page);
          if (
            observation.users
              .slice(initial.users.length)
              .some((text) => normalize(text).includes(normalize(prompt)))
          ) {
            confirmed = true;
            break;
          }
          await delay(200, undefined, { signal: input.signal });
        }
        if (!confirmed)
          throw new GeminiGenerationError(
            "gemini_submission_uncertain",
            "Gemini did not confirm the submitted user message. It was not resent.",
          );
        record = {
          ...record,
          phase: "submitted",
          submittedAt: Date.now(),
          ...(!temporary && conversationUrl(page.url())
            ? { conversationUrl: conversationUrl(page.url())! }
            : {}),
        };
        await this.#saveOperation(key, record);
        this.#step("submitted");
      }
      const tracker = new GeminiReplyTracker(
        record.baseline,
        Date.now(),
        this.#settings.textTimeoutMs,
        this.#settings.toolWaitTimeoutMs,
      );
      const approvedCards = new Set<string>();
      const invalidCards = new Map<
        string,
        { fingerprint: string; since: number }
      >();
      for (;;) {
        input.signal.throwIfAborted();
        const observation = await pageObservation(page);
        for (const alert of observation.alerts) {
          const problem = geminiAlertError(alert);
          if (problem) throw problem;
        }
        if ((await this.#account(page, route.accountKey)) !== route.accountKey)
          throw new Error(
            "The Gemini account changed while a task was active.",
          );
        const waitingForTool =
          observation.permission || input.isWaitingForNativeTools?.() === true;
        input.onProgress?.(waitingForTool ? "waiting_web_tool" : "generating");
        if (
          observation.permission &&
          this.#settings.autoApproveToolCalls &&
          input.turnToken
        ) {
          const cards = page
            .locator("remy-confirmation-card")
            .filter({ visible: true });
          for (const card of await cards.all()) {
            input.signal.throwIfAborted();
            const evidence = await card.evaluate((element) => {
              const response = element.closest("model-response");
              return {
                text: element.textContent ?? "",
                responseId:
                  response?.querySelector("message-content")?.id ?? "",
                responseIndex: [
                  ...document.querySelectorAll("model-response"),
                ].indexOf(response!),
                cardIndex: response
                  ? [
                      ...response.querySelectorAll("remy-confirmation-card"),
                    ].indexOf(element)
                  : -1,
              };
            });
            if (
              evidence.responseIndex < 0 ||
              (evidence.responseId
                ? record.baseline.includes(evidence.responseId)
                : evidence.responseIndex < record.baseline.length)
            )
              continue;
            const scope = geminiPermissionScope(
              evidence.text,
              this.#settings.connectorName,
              input.turnToken,
            );
            if (scope !== "match") {
              if (scope === "mismatch") {
                const position = `${evidence.responseId || evidence.responseIndex}:${evidence.cardIndex}`;
                const fingerprint = hash(evidence.text);
                const previous = invalidCards.get(position);
                if (previous?.fingerprint !== fingerprint)
                  invalidCards.set(position, {
                    fingerprint,
                    since: Date.now(),
                  });
                else if (Date.now() - previous.since >= 1500)
                  throw new GeminiGenerationError(
                    "gemini_tool_scope_mismatch",
                    "Gemini supplied a different task capability. The tool was not authorized or executed; this turn has ended instead of requesting manual Allow.",
                  );
              }
              continue;
            }
            const identity = hash(
              JSON.stringify([
                key,
                evidence.responseId || evidence.responseIndex,
                evidence.cardIndex,
                evidence.text,
              ]),
            );
            if (approvedCards.has(identity)) continue;
            const allow = card
              .getByRole("button", { name: "Allow", exact: true })
              .and(page.locator("button:enabled"));
            if ((await allow.count()) !== 1) continue;
            await allow.click();
            approvedCards.add(identity);
            this.#automaticPermissionApprovals += 1;
            this.#step("permission-approved");
          }
        }
        const text = tracker.observe(
          { ...observation, waitingForTool },
          Date.now(),
        );
        const currentUrl = temporary ? undefined : conversationUrl(page.url());
        if (currentUrl && currentUrl !== record.conversationUrl) {
          record = { ...record, conversationUrl: currentUrl };
          await this.#saveOperation(key, record);
        }
        if (text !== undefined) {
          await this.#requireTemporaryMode(page, temporary);
          this.#step("answer-complete");
          const selected = await this.#selection(
            page,
            !!route.selection.thinking,
          );
          if (
            selected.model !== route.selection.model ||
            selected.thinking !== route.selection.thinking
          )
            throw new Error(
              "Gemini completed using a different model or thinking level.",
            );
          if (!temporary && !currentUrl)
            throw new Error(
              "Gemini did not retain a task-bound conversation URL.",
            );
          record = {
            ...record,
            phase: "completed",
            answerId: observation.responses.at(-1)?.id ?? "",
            output: text,
            ...(!temporary && currentUrl
              ? { conversationUrl: currentUrl }
              : {}),
            at: Date.now(),
          };
          await this.#saveOperation(key, record);
          if (!temporary && currentUrl) {
            this.#conversations.set(thread, {
              url: currentUrl,
              accountKey: route.accountKey,
              ...(sync ? { receipt: sync.receipt } : {}),
            });
            await this.#persist(
              join(this.directory, "conversations.json"),
              JSON.stringify({ version: 1, entries: [...this.#conversations] }),
            );
          }
          return {
            output: text,
            selection: route.selection,
            accountKey: route.accountKey,
            ...(!temporary && currentUrl
              ? { conversationUrl: currentUrl }
              : {}),
          };
        }
        await delay(250, undefined, { signal: input.signal });
      }
    } catch (error) {
      this.#error = safeError(error);
      if (
        error instanceof GeminiGenerationError &&
        error.code === "gemini_login_required"
      ) {
        this.#verified = false;
        this.#host.invalidateVerifiedLogin();
      }
      // Keep what the page showed when a turn failed; a timeout otherwise
      // leaves no evidence of whether Gemini was thinking, stuck or erroring.
      const failedPage = turnPage;
      if (
        record &&
        record.phase !== "completed" &&
        !(error instanceof Error && error.name === "AbortError") &&
        failedPage &&
        !failedPage.isClosed()
      ) {
        await failedPage
          .screenshot({
            path: join(this.directory, "failure-diagnostics.png"),
            timeout: 5000,
          })
          .catch(() => undefined);
        const observation = await pageObservation(failedPage).catch(
          () => undefined,
        );
        await writeDurableJson(
          join(this.directory, "failure-diagnostics.json"),
          JSON.stringify({
            version: 1,
            at: new Date().toISOString(),
            failure:
              error instanceof GeminiGenerationError ? error.code : "other",
            path: (() => {
              try {
                return new URL(failedPage.url()).pathname;
              } catch {
                return undefined;
              }
            })(),
            ...(observation
              ? {
                  busy: observation.busy,
                  permission: observation.permission,
                  users: observation.users.length,
                  responses: observation.responses.map((response) => ({
                    complete: response.complete,
                    textLength: response.text.length,
                  })),
                  alerts: observation.alerts.map((text) =>
                    safeError(new Error(text)),
                  ),
                }
              : {}),
          }),
        ).catch(() => undefined);
      }
      if (record && record.phase !== "completed")
        await this.#saveOperation(key, {
          ...record,
          phase: "failed",
          failureCode:
            error instanceof Error && error.name === "AbortError"
              ? "cancelled"
              : error instanceof GeminiGenerationError
                ? error.code
                : "provider_error",
          at: Date.now(),
        });
      const stop = turnPage?.getByRole("button", {
        name: "Stop response",
        exact: true,
      });
      if (input.signal.aborted && stop && (await stop.count()))
        await stop.click().catch(() => undefined);
      if (error instanceof Error) {
        error.message = this.#error;
        throw error;
      }
      throw new Error(this.#error, { cause: error });
    } finally {
      if (turnPage) this.#releaseTurnPage(turnPage);
      this.#activeTurns -= 1;
      this.#aborts.delete(abort);
    }
  }
  cancel(): void {
    for (const abort of this.#aborts) abort.abort();
  }
  async showWindow(): Promise<void> {
    if (!this.#host.showWindow)
      throw new Error("This Gemini browser has no Bridge window to show.");
    await this.#host.showWindow();
  }
  async close(): Promise<void> {
    this.cancel();
    this.#verified = false;
    this.#page = undefined;
    this.#idlePages.length = 0;
    this.#turnPages.clear();
    await this.#host.close();
  }
}
