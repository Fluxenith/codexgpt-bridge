import { BrowserWindow, session } from "electron";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type {
  GeminiBrowserHost,
  GeminiLocator,
  GeminiPage,
} from "./gemini-page.js";

export type GeminiQuery =
  | { css: string }
  | { role: string; name: string; flags?: string; exact?: boolean }
  | {
      parent: GeminiQuery;
      role: string;
      name: string;
      flags?: string;
      exact?: boolean;
    }
  | { source: GeminiQuery; visible?: boolean; index?: number }
  | { left: GeminiQuery; right: GeminiQuery; union: boolean };

/** Serialized into the isolated webpage; queries contain data, never page code. */
export function resolveGeminiElements(query: GeminiQuery): Element[] {
  const visible = (e: Element) => {
    const box = e.getBoundingClientRect();
    const style = getComputedStyle(e);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  const resolve = (q: GeminiQuery): Element[] => {
    if ("css" in q) return [...document.querySelectorAll(q.css)];
    if ("source" in q) {
      const result = resolve(q.source).filter(
        (e) => q.visible === undefined || visible(e) === q.visible,
      );
      return q.index === undefined
        ? result
        : result.slice(q.index, q.index + 1);
    }
    if ("left" in q) {
      const left = resolve(q.left),
        right = resolve(q.right);
      return q.union
        ? [...new Set([...left, ...right])]
        : left.filter((e) => right.includes(e));
    }
    const roots = "parent" in q ? resolve(q.parent) : [document];
    const implicit: Record<string, string> = {
      button: "button",
      link: "a[href]",
    };
    const selector = `[role="${q.role}"]${implicit[q.role] ? "," + implicit[q.role] : ""}`;
    return [
      ...new Set(roots.flatMap((root) => [...root.querySelectorAll(selector)])),
    ].filter((e) => {
      const labelled = e
        .getAttribute("aria-labelledby")
        ?.split(/\s+/u)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const name = normalize(
        e.getAttribute("aria-label") ??
          labelled ??
          (e as HTMLElement).innerText ??
          e.textContent ??
          "",
      );
      return q.flags !== undefined
        ? new RegExp(q.name, q.flags).test(name)
        : q.exact
          ? name === normalize(q.name)
          : name.toLowerCase().includes(normalize(q.name).toLowerCase());
    });
  };
  return resolve(query);
}

function roleQuery(
  role: string,
  options: { name: string | RegExp; exact?: boolean },
  parent?: GeminiQuery,
): GeminiQuery {
  if (!/^[a-z]+$/u.test(role)) throw new Error("Invalid Gemini role.");
  return {
    ...(parent ? { parent } : {}),
    role,
    name: typeof options.name === "string" ? options.name : options.name.source,
    ...(typeof options.name === "string" ? {} : { flags: options.name.flags }),
    ...(options.exact ? { exact: true } : {}),
  };
}

class EmbeddedLocator implements GeminiLocator {
  constructor(
    readonly page: EmbeddedGeminiPage,
    readonly query: GeminiQuery,
  ) {}
  first() {
    return this.nth(0);
  }
  async all() {
    return Array.from({ length: await this.count() }, (_, index) =>
      this.nth(index),
    );
  }
  nth(index: number) {
    return new EmbeddedLocator(this.page, { source: this.query, index });
  }
  filter(options: { visible: boolean }) {
    return new EmbeddedLocator(this.page, { source: this.query, ...options });
  }
  or(other: GeminiLocator): EmbeddedLocator {
    return this.combine(other, true);
  }
  and(other: GeminiLocator): EmbeddedLocator {
    return this.combine(other, false);
  }
  private combine(other: GeminiLocator, union: boolean): EmbeddedLocator {
    if (!(other instanceof EmbeddedLocator) || other.page !== this.page)
      throw new Error("Gemini locators must share a page.");
    return new EmbeddedLocator(this.page, {
      left: this.query,
      right: other.query,
      union,
    });
  }
  getByRole(role: string, options: { name: string | RegExp; exact?: boolean }) {
    return new EmbeddedLocator(this.page, roleQuery(role, options, this.query));
  }
  async evaluateAll<R, A = undefined>(
    fn: (elements: Element[], arg: A) => R | Promise<R>,
    arg?: A,
  ): Promise<R> {
    return this.page.run(
      `(${fn.toString()})((${resolveGeminiElements.toString()})(${JSON.stringify(this.query)}),${JSON.stringify(arg) ?? "undefined"})`,
    );
  }
  async evaluate<R, A = undefined>(
    fn: (element: HTMLElement | SVGElement, arg: A) => R | Promise<R>,
    arg?: A,
  ): Promise<R> {
    return this.page.run(
      `(() => { const elements = (${resolveGeminiElements.toString()})(${JSON.stringify(this.query)}); if (elements.length !== 1) throw new Error("Gemini locator must resolve to one element."); return (${fn.toString()})(elements[0],${JSON.stringify(arg) ?? "undefined"}); })()`,
    );
  }
  async count() {
    return this.evaluateAll((elements) => elements.length);
  }
  async isVisible() {
    return this.evaluateAll((elements) =>
      elements.some((e) => {
        const b = e.getBoundingClientRect();
        return (
          b.width > 0 &&
          b.height > 0 &&
          getComputedStyle(e).visibility !== "hidden"
        );
      }),
    );
  }
  async getAttribute(name: string) {
    return this.evaluate((e, key) => e.getAttribute(key!), name);
  }
  async innerText() {
    return this.evaluate((e) => (e as HTMLElement).innerText);
  }
  async waitFor(options: { state: "visible" | "hidden"; timeout?: number }) {
    const deadline = Date.now() + (options.timeout ?? 10000);
    do {
      if ((await this.isVisible()) === (options.state === "visible")) return;
      await delay(100);
    } while (Date.now() < deadline);
    throw new Error(`Gemini element did not become ${options.state}.`);
  }
  async focus() {
    await this.evaluate((e) => {
      e.focus();
    });
  }
  async click(_options?: { force?: boolean }) {
    await this.waitFor({ state: "visible" });
    await this.evaluate((e) => {
      if (
        !(e instanceof HTMLElement) ||
        (e as HTMLButtonElement).disabled ||
        e.getAttribute("aria-disabled") === "true"
      )
        throw new Error("Gemini control is disabled or not clickable.");
      e.scrollIntoView({ block: "center", inline: "nearest" });
      const b = e.getBoundingClientRect();
      const hit = document.elementFromPoint(
        b.x + b.width / 2,
        b.y + b.height / 2,
      );
      if (!hit || !(hit === e || e.contains(hit)))
        throw new Error("Gemini control is covered.");
      e.click();
    });
  }
  async fill(value: string) {
    await this.evaluate((e) => {
      e.focus();
      if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement)
        e.select();
      else {
        if (!(e instanceof HTMLElement) || !e.isContentEditable)
          throw new Error("Gemini control is not editable.");
        const range = document.createRange();
        range.selectNodeContents(e);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    });
    await this.page.keyboard.insertText(value);
  }
  async pressSequentially(value: string) {
    await this.focus();
    for (const character of value)
      await this.page.keyboard.insertText(character);
  }
}

export class EmbeddedGeminiPage implements GeminiPage {
  #revealed = false;
  constructor(readonly window: BrowserWindow) {
    // Gemini only lays out and paints while its window is shown, so the
    // window stays shown but transparent, click-through and off the taskbar.
    window.setOpacity(0);
    window.setSkipTaskbar(true);
    window.setIgnoreMouseEvents(true);
    window.showInactive();
    // Reveal it when Google needs the user, such as an expired sign-in or a
    // verification page.
    window.webContents.on("did-navigate", (_event, url) => {
      if (!url.startsWith("https://gemini.google.com/")) this.reveal();
    });
  }
  /** Makes the window visible and usable; it stays that way until closed. */
  reveal(focus = false) {
    if (this.window.isDestroyed()) return;
    if (!this.#revealed) {
      this.#revealed = true;
      this.window.setIgnoreMouseEvents(false);
      this.window.setSkipTaskbar(false);
      this.window.setOpacity(1);
    }
    if (this.window.isMinimized()) this.window.restore();
    if (focus) {
      this.window.show();
      this.window.focus();
    } else if (!this.window.isVisible()) this.window.showInactive();
  }
  isClosed() {
    return this.window.isDestroyed();
  }
  url() {
    return this.window.webContents.getURL();
  }
  async goto(url: string, options?: { timeout?: number }) {
    if (new URL(url).origin !== "https://gemini.google.com")
      throw new Error("Unexpected Gemini navigation origin.");
    // A minimized window stops painting; keep it laid out for page operations.
    if (this.#revealed) this.reveal();
    else if (!this.window.isVisible()) this.window.showInactive();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.window.loadURL(url),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("Gemini navigation timed out; request not resent."),
              ),
            options?.timeout ?? 60000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async run<R>(script: string): Promise<R> {
    const origin = new URL(this.url()).origin;
    if (origin !== "https://gemini.google.com")
      throw new Error(
        "Gemini is not on its expected origin. Complete sign-in in the browser.",
      );
    const result = (await this.window.webContents.executeJavaScript(
      `(async () => { try { return { ok: true, value: await (${script}) }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Gemini page operation failed." }; } })()`,
    )) as { ok: boolean; value?: R; error?: string };
    if (!result.ok)
      throw new Error(result.error ?? "Gemini page operation failed.");
    return result.value as R;
  }
  async evaluate<R, A = undefined>(
    fn: (arg: A) => R | Promise<R>,
    arg?: A,
  ): Promise<R> {
    return this.run(
      `(${fn.toString()})(${JSON.stringify(arg) ?? "undefined"})`,
    );
  }
  locator(selector: string) {
    return new EmbeddedLocator(this, { css: selector });
  }
  getByRole(role: string, options: { name: string | RegExp; exact?: boolean }) {
    return new EmbeddedLocator(this, roleQuery(role, options));
  }
  async screenshot(options: { path: string }) {
    await writeFile(
      options.path,
      (
        await this.window.webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        })
      ).toPNG(),
    );
  }
  readonly keyboard = {
    press: async (key: string) => {
      if (!["End", "Escape", "Backspace"].includes(key))
        throw new Error("Unsupported Gemini keyboard action.");
      if (key === "End") {
        await this.evaluate(() => {
          const active = document.activeElement;
          if (
            active instanceof HTMLInputElement ||
            active instanceof HTMLTextAreaElement
          )
            active.setSelectionRange(active.value.length, active.value.length);
          else window.getSelection()?.collapseToEnd();
        });
        return;
      }
      this.window.webContents.focus();
      this.window.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
      this.window.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
      await delay(25);
    },
    insertText: async (value: string) => {
      await this.window.webContents.insertText(value);
    },
  };
}

/** No extension, Chrome process, debugging endpoint or credential copying. */
export class EmbeddedGeminiHost implements GeminiBrowserHost {
  readonly kind = "embedded" as const;
  readonly partition = "persist:gemini-web";
  #page: EmbeddedGeminiPage | undefined;
  readonly #extraPages = new Set<EmbeddedGeminiPage>();
  #phase: "idle" | "ready" = "idle";
  #verified = false;
  manualLoginStatus() {
    return { phase: this.#phase, verified: this.#verified };
  }
  confirmVerifiedLogin() {
    this.#verified = true;
    this.#phase = "idle";
  }
  invalidateVerifiedLogin() {
    this.#verified = false;
  }
  async beginManualLogin(url: string) {
    this.#verified = false;
    const page = await this.createPage("login");
    this.#phase = "ready";
    page.reveal(true);
    await page.goto(url);
  }
  finishManualLogin() {
    if (this.#phase !== "ready") throw new Error("Open Gemini sign-in first.");
  }
  async restoreSavedLogin() {
    return (
      (
        await session
          .fromPartition(this.partition)
          .cookies.get({ url: "https://gemini.google.com" })
      ).length > 0
    );
  }
  async createPage(purpose: "login" | "turn") {
    if (purpose === "turn" && !this.#verified)
      throw new Error("Verify Gemini sign-in before starting a task.");
    if (!this.#page || this.#page.isClosed())
      this.#page = this.#newPage("Gemini — CodexGPT Bridge");
    return this.#page;
  }
  /** Brings the hidden Gemini windows to the front, opening one if needed. */
  async showWindow() {
    const pages = [this.#page, ...this.#extraPages].filter(
      (page): page is EmbeddedGeminiPage => !!page && !page.isClosed(),
    );
    if (!pages.length) {
      const page = await this.createPage("login");
      pages.push(page);
      if (!page.url()) await page.goto("https://gemini.google.com/app");
    }
    for (const page of pages) page.reveal();
    pages[0]!.reveal(true);
  }
  async createExtraPage() {
    if (!this.#verified)
      throw new Error("Verify Gemini sign-in before starting a task.");
    const page = this.#newPage(
      `Gemini — CodexGPT Bridge (${this.#extraPages.size + 2})`,
    );
    this.#extraPages.add(page);
    page.window.on("closed", () => this.#extraPages.delete(page));
    return page;
  }
  #newPage(title: string): EmbeddedGeminiPage {
    const window = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      title,
      autoHideMenuBar: true,
      webPreferences: {
        partition: this.partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      const target = new URL(url);
      if (
        target.protocol !== "https:" ||
        !["accounts.google.com", "gemini.google.com"].includes(target.hostname)
      )
        return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: {
            partition: this.partition,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    });
    window.on("closed", () => {
      void session.fromPartition(this.partition).flushStorageData();
    });
    return new EmbeddedGeminiPage(window);
  }
  async close() {
    if (this.#page && !this.#page.isClosed()) this.#page.window.close();
    this.#page = undefined;
    for (const page of this.#extraPages)
      if (!page.isClosed()) page.window.close();
    this.#extraPages.clear();
    this.#verified = false;
    this.#phase = "idle";
    session.fromPartition(this.partition).flushStorageData();
    await session.fromPartition(this.partition).cookies.flushStore();
  }
}
