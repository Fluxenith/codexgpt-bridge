/** The browser operations used by Gemini, shared by Chrome and Electron. */
export interface GeminiLocator {
  first(): GeminiLocator;
  all(): Promise<GeminiLocator[]>;
  nth(index: number): GeminiLocator;
  filter(options: { visible: boolean }): GeminiLocator;
  or(other: GeminiLocator): GeminiLocator;
  and(other: GeminiLocator): GeminiLocator;
  getByRole(
    role: string,
    options: { name: string | RegExp; exact?: boolean },
  ): GeminiLocator;
  evaluateAll<R, A = undefined>(
    fn: (elements: Element[], arg: A) => R | Promise<R>,
    arg?: A,
  ): Promise<R>;
  evaluate<R, A = undefined>(
    fn: (element: HTMLElement | SVGElement, arg: A) => R | Promise<R>,
    arg?: A,
  ): Promise<R>;
  waitFor(options: {
    state: "visible" | "hidden";
    timeout?: number;
  }): Promise<void>;
  click(options?: { force?: boolean }): Promise<void>;
  fill(value: string): Promise<void>;
  focus(): Promise<void>;
  pressSequentially(value: string): Promise<void>;
  innerText(): Promise<string>;
  isVisible(): Promise<boolean>;
  count(): Promise<number>;
  getAttribute(name: string): Promise<string | null>;
}

export interface GeminiPage {
  isClosed(): boolean;
  url(): string;
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded"; timeout?: number },
  ): Promise<unknown>;
  evaluate<R, A = undefined>(
    fn: (arg: A) => R | Promise<R>,
    arg?: A,
  ): Promise<R>;
  locator(selector: string): GeminiLocator;
  getByRole(
    role: string,
    options: { name: string | RegExp; exact?: boolean },
  ): GeminiLocator;
  screenshot(options: { path: string; timeout?: number }): Promise<unknown>;
  readonly keyboard: {
    press(key: string): Promise<void>;
    insertText(value: string): Promise<void>;
  };
}

export interface GeminiBrowserHost {
  readonly kind?: "embedded" | "chrome";
  manualLoginStatus(): {
    phase: "idle" | "waiting" | "ready";
    verified: boolean;
    error?: string;
  };
  beginManualLogin(url: string): Promise<void>;
  finishManualLogin(): void;
  confirmVerifiedLogin(): void;
  invalidateVerifiedLogin(): void;
  restoreSavedLogin(): Promise<boolean>;
  createPage(purpose: "login" | "turn"): Promise<GeminiPage>;
  /** Another page on the same signed-in session, for concurrent turns. */
  createExtraPage?(): Promise<GeminiPage>;
  /** Shows the Gemini browser window(s); hosts without one may omit this. */
  showWindow?(): Promise<void>;
  close(): Promise<void>;
}
