/* global document */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const GEMINI_EDITOR =
  '.ql-editor[contenteditable="true"][role="textbox"]';

export const GEMINI_SMOKE_PROMPT = `這是 Gemini Web Bridge 的工具循環測試。
任務：先列出測試專案目錄，再讀取 package.json，最後說明專案名稱、scripts 和 bridge_probe 的值。
你不能直接存取電腦。外部測試程式會執行工具，並回傳真實結果。不得編造工具結果。
可用工具 local_exec，參數為 {"command":"PowerShell 指令"}。
只允許列出目前目錄，以及讀取目前目錄的 package.json。
每次只輸出一個 JSON 物件，不要 Markdown、程式碼框或額外說明。
工具呼叫格式：{"type":"tool_call","id":"call_1","name":"local_exec","arguments":{"command":"Get-ChildItem -Name"}}
每次呼叫使用不同 id，輸出後立刻停止，等待我回傳對應的 tool_result。
工具結果包含 id、stdout、stderr 和 exit_code。依實際結果決定下一步。
完成格式：{"type":"final","text":"繁體中文結論，必須包含專案名稱、兩個 script 名稱與指令，以及 bridge_probe 的完整值"}
現在只做第一步：列出目前目錄的檔案名稱。`;

export async function createGeminiSmokeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-gemini-smoke-"));
  const manifest = {
    name: "gemini-bridge-test",
    scripts: { dev: "vite", build: "tsc && vite build" },
    bridge_probe: randomUUID(),
  };
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(manifest, null, 2),
  );
  await writeFile(
    join(directory, "README.txt"),
    "Disposable Gemini Bridge smoke fixture.\n",
  );
  return { directory, manifest };
}

export async function disposeGeminiSmokeFixture(fixture) {
  const directory = resolve(fixture.directory);
  assert.equal(
    dirname(directory),
    resolve(tmpdir()),
    "Fixture must be directly inside the temporary directory.",
  );
  assert.ok(
    basename(directory).startsWith("bridge-gemini-smoke-"),
    "Unexpected fixture directory.",
  );
  await rm(directory, { recursive: true, force: true });
}

export function parseGeminiSmokeReply(text) {
  const reply = JSON.parse(text.trim());
  assert.ok(
    reply && typeof reply === "object" && !Array.isArray(reply),
    "Expected one JSON object.",
  );
  if (reply.type === "final") {
    assert.equal(typeof reply.text, "string", "Final reply must contain text.");
  } else {
    assert.equal(reply.type, "tool_call", "Expected tool_call or final.");
    assert.match(reply.id, /^[a-zA-Z0-9_-]{1,100}$/u);
    assert.equal(reply.name, "local_exec", "Unadvertised tool.");
    assert.equal(typeof reply.arguments?.command, "string");
  }
  return reply;
}

export async function executeGeminiSmokeTool(reply, fixture) {
  // Match complete commands; never pass model output to a shell. These two
  // read operations use only the disposable fixture, never the user's project.
  const command = reply.arguments.command.trim();
  let stdout;
  let operation;
  if (/^(?:Get-ChildItem|gci)\s+-Name$/iu.test(command)) {
    operation = "list";
    stdout = (await readdir(fixture.directory)).sort().join("\n");
  } else if (
    /^Get-Content\s+(?:(?:-Path|-LiteralPath)\s+)?(?:package\.json|'package\.json'|"package\.json")\s+-Raw$/iu.test(
      command,
    ) ||
    /^Get-Content\s+-Raw\s+(?:(?:-Path|-LiteralPath)\s+)?(?:package\.json|'package\.json'|"package\.json")$/iu.test(
      command,
    )
  ) {
    operation = "read";
    stdout = await readFile(join(fixture.directory, "package.json"), "utf8");
  } else {
    throw new Error(
      "Smoke test only allows Get-ChildItem -Name and Get-Content package.json -Raw.",
    );
  }
  return {
    operation,
    result: {
      type: "tool_result",
      id: reply.id,
      stdout,
      stderr: "",
      exit_code: 0,
    },
  };
}

export async function runGeminiSmoke(
  exchange,
  fixture,
  { onTurn = () => {}, maxTurns = 6 } = {},
) {
  const seen = new Set();
  const operations = [];
  const turns = [];
  let prompt = GEMINI_SMOKE_PROMPT;
  for (let index = 0; index < maxTurns; index++) {
    const text = await exchange(prompt);
    const reply = parseGeminiSmokeReply(text);
    turns.push({ prompt, reply });
    onTurn(reply);
    if (reply.type === "final") {
      assert.deepEqual(
        operations,
        ["list", "read"],
        "Expected directory listing, then package read, before final.",
      );
      for (const expected of [
        fixture.manifest.name,
        "dev",
        fixture.manifest.scripts.dev,
        "build",
        fixture.manifest.scripts.build,
        fixture.manifest.bridge_probe,
      ]) {
        assert.ok(
          reply.text.includes(expected),
          `Final reply omitted ${expected}.`,
        );
      }
      return { final: reply.text, turns };
    }
    assert.ok(!seen.has(reply.id), "Duplicate tool call ID.");
    seen.add(reply.id);
    const { operation, result } = await executeGeminiSmokeTool(reply, fixture);
    assert.equal(
      operation,
      operations.length === 0 ? "list" : "read",
      "Unexpected tool operation order.",
    );
    assert.ok(operations.length < 2, "Unexpected extra tool call.");
    operations.push(operation);
    turns.at(-1).result = result;
    prompt = JSON.stringify(result);
  }
  throw new Error("Gemini smoke test exceeded its turn limit.");
}

// This function is serialized into the renderer. It uses rendered page content
// only, with selectors observed on Gemini Web; no private network endpoints.
export function observeGeminiSmokePage() {
  return [
    ...document.querySelectorAll(
      "model-response-content message-content .markdown",
    ),
  ].map((element) => ({
    id: element.id,
    text: element.innerText,
    busy:
      element.getAttribute("aria-busy") === "true" ||
      Boolean(
        element
          .closest(".response-content")
          ?.querySelector('[aria-busy="true"]'),
      ),
    complete: Boolean(
      element
        .closest(".response-content")
        ?.querySelector(".response-footer.complete"),
    ),
  }));
}

export class GeminiSmokeReplyTracker {
  #candidate;
  constructor(previousIds, settleMs = 1000) {
    this.previousIds = new Set(previousIds);
    this.settleMs = settleMs;
  }
  observe(responses, now) {
    const response = responses.at(-1);
    if (
      !response?.id ||
      this.previousIds.has(response.id) ||
      !response.text.trim() ||
      response.busy ||
      !response.complete
    ) {
      this.#candidate = undefined;
      return undefined;
    }
    if (
      response.id !== this.#candidate?.id ||
      response.text !== this.#candidate?.text
    ) {
      this.#candidate = { id: response.id, text: response.text, since: now };
      return undefined;
    }
    if (now - this.#candidate.since >= this.settleMs) return response.text;
    return undefined;
  }
}
