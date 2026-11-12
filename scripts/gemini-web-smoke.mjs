import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { URL } from "node:url";
import { chromium } from "playwright-core";
import {
  createGeminiSmokeFixture,
  disposeGeminiSmokeFixture,
  GEMINI_EDITOR,
  GeminiSmokeReplyTracker,
  observeGeminiSmokePage,
  runGeminiSmoke,
} from "./gemini-web-smoke-lib.mjs";

const { values } = parseArgs({
  options: {
    login: { type: "boolean", default: false },
    profile: {
      type: "string",
      default: join(homedir(), ".codexgpt-bridge", "gemini-web-smoke-profile"),
    },
    timeout: { type: "string", default: "180000" },
    help: { type: "boolean", default: false },
  },
});
const timeout = Number(values.timeout);
if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600000)
  throw new Error("--timeout must be 1000..600000 milliseconds.");
if (values.help) {
  process.stdout.write(
    "Gemini Web experimental smoke test (separate from the installed Bridge).\nFirst: pnpm gemini:web:login (sign in, then close its dedicated Chrome).\nThen: pnpm gemini:web:smoke\nOptions: --profile <dedicated-directory> --timeout <milliseconds>\nOnly disposable fixture data is sent. No API key or general shell access.\n",
  );
} else {
  const profile = resolve(values.profile);
  const executablePath =
    process.env.CODEXGPT_BRIDGE_CHROME_PATH ||
    (process.platform === "win32"
      ? join(
          process.env.PROGRAMFILES || "C:\\Program Files",
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        )
      : process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "/usr/bin/google-chrome");
  await access(executablePath);
  await mkdir(profile, { recursive: true });
  if (values.login) {
    process.stdout.write(
      "Sign in to Gemini in the dedicated Chrome window, then close that window and run pnpm gemini:web:smoke.\n",
    );
    const child = spawn(
      executablePath,
      [
        `--user-data-dir=${profile}`,
        "--new-window",
        "--disable-background-mode",
        "--no-first-run",
        "--no-default-browser-check",
        "https://gemini.google.com/app",
      ],
      { stdio: "ignore" },
    );
    await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
  } else {
    const fixture = await createGeminiSmokeFixture();
    let context;
    let page;
    const output = resolve(
      "reports",
      `gemini-web-smoke-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
    );
    await mkdir(output, { recursive: true });
    try {
      context = await chromium.launchPersistentContext(profile, {
        executablePath,
        headless: false,
        viewport: null,
      });
      page = await context.newPage();
      await page.goto("https://gemini.google.com/app", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page
        .locator(GEMINI_EDITOR)
        .waitFor({ state: "visible", timeout: 60000 })
        .catch(() => {
          throw new Error(
            "Gemini composer unavailable. Run pnpm gemini:web:login to sign in first; check login, quota or page changes.",
          );
        });
      const report = await runGeminiSmoke(
        async (prompt) => {
          if (new URL(page.url()).origin !== "https://gemini.google.com")
            throw new Error("Unexpected page origin.");
          const editor = page.locator(GEMINI_EDITOR);
          if ((await editor.innerText()).trim())
            throw new Error(
              "Composer has an existing draft; refusing to replace it.",
            );
          const before = await page.evaluate(observeGeminiSmokePage);
          const tracker = new GeminiSmokeReplyTracker(
            before.map((response) => response.id),
          );
          await editor.fill(prompt);
          const send = page.getByRole("button", {
            name: /^(?:Send message|傳送訊息|发送消息)$/u,
          });
          await send.click({ timeout: 10000 });
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            if (new URL(page.url()).origin !== "https://gemini.google.com")
              throw new Error("Gemini navigated away during generation.");
            const completed = tracker.observe(
              await page.evaluate(observeGeminiSmokePage),
              Date.now(),
            );
            if (completed !== undefined) return completed;
            await delay(250);
          }
          throw new Error(
            "Gemini reply timeout; request was not resubmitted. Check generation, quota or page structure.",
          );
        },
        fixture,
        {
          onTurn: (reply) =>
            process.stdout.write(
              `${reply.type}${reply.id ? ` ${reply.id}: ${reply.arguments.command}` : ""}\n`,
            ),
        },
      );
      await writeFile(
        join(output, "result.json"),
        JSON.stringify({ passed: true, url: page.url(), ...report }, null, 2),
      );
      await page.screenshot({ path: join(output, "result.png") });
      process.stdout.write(
        `PASS: two fixture tools and nonce verified. Report: ${output}\n`,
      );
    } catch (error) {
      await writeFile(
        join(output, "result.json"),
        JSON.stringify({ passed: false, error: error.message }, null, 2),
      );
      if (page)
        await page
          .screenshot({ path: join(output, "failure.png") })
          .catch(() => {});
      throw error;
    } finally {
      try {
        await context?.close();
      } finally {
        await disposeGeminiSmokeFixture(fixture);
      }
    }
  }
}
