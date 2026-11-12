import assert from "node:assert/strict";
import { it } from "node:test";
import {
  GeminiReplyTracker,
  geminiAlertError,
  geminiLockedModelError,
  geminiRenderedReplyText,
  geminiPermissionMatches,
  geminiPermissionScope,
} from "./gemini-generation.js";
import { parseGeminiSettings } from "./gemini-settings.js";
import { geminiFullTransportReminder } from "./gemini-full-protocol.js";

it("distinguishes an invalid native task token from unrelated or incomplete permission cards", () => {
  const token = "turn_" + "a".repeat(43);
  const prefix =
    'CodexGPT Bridge Let Gemini use "codex exec" from CodexGPT Bridge Tool: codex exec ';
  assert.equal(
    geminiPermissionScope(
      prefix + "turn_token: " + token,
      "CodexGPT Bridge",
      token,
    ),
    "match",
  );
  for (const wrong of ["invented-value", "turn_" + "b".repeat(43)])
    assert.equal(
      geminiPermissionScope(
        prefix + "turn_token: " + wrong,
        "CodexGPT Bridge",
        token,
      ),
      "mismatch",
    );
  assert.equal(
    geminiPermissionScope(prefix, "CodexGPT Bridge", token),
    "unknown",
  );
  assert.equal(
    geminiPermissionScope(
      "Some other app turn_token: wrong",
      "CodexGPT Bridge",
      token,
    ),
    "unknown",
  );
});

it("pins the exact current Full capability after history and refuses absent or malformed capabilities", () => {
  const current = "turn_" + "a".repeat(43);
  const text = geminiFullTransportReminder("CodexGPT Bridge", current);
  assert.ok(text.includes(JSON.stringify({ turn_token: current })));
  assert.match(text, /pending call is already running/u);
  for (const bad of [
    undefined,
    "a".repeat(48),
    "turn_short",
    "turn_" + "a".repeat(252),
  ])
    assert.throws(
      () => geminiFullTransportReminder("CodexGPT Bridge", bad),
      /valid current Codex task/u,
    );
});

it("reads a sole rendered XML tool block without its UI label and preserves mixed prose", () => {
  const code =
    '<codex_tool_calls>[{"name":"exec_command","arguments":{"cmd":"node challenge.mjs 1 start"}}]</codex_tool_calls>\n';
  const block = { text: "XML\n" + code, code };
  assert.equal(geminiRenderedReplyText(block.text, [block]), code);
  assert.equal(
    geminiRenderedReplyText("Example:\n" + block.text, [block]),
    "Example:\n" + block.text,
  );
  assert.equal(
    geminiRenderedReplyText("XML\n" + code + code, [block, block]),
    "XML\n" + code + code,
  );
  assert.equal(
    geminiRenderedReplyText("XML", [{ text: "XML", code: null }]),
    "XML",
  );
  assert.equal(
    geminiRenderedReplyText("ordinary answer", []),
    "ordinary answer",
  );
});

it("requires a new answer ID, completion, idle state and stable final text on every round", () => {
  const tracker = new GeminiReplyTracker(["old"], 0, 10000, 10000, 1000);
  const observe = (
    id: string,
    text: string,
    complete: boolean,
    busy: boolean,
    at: number,
  ) =>
    tracker.observe(
      { responses: [{ id, text, complete }], busy, waitingForTool: false },
      at,
    );
  assert.equal(observe("old", "old JSON", true, false, 100), undefined);
  assert.equal(observe("new", '{"half":', false, false, 200), undefined);
  assert.equal(observe("new", '{"ok":true}', true, true, 500), undefined);
  assert.equal(observe("new", '{"ok":true}', true, false, 600), undefined);
  assert.equal(observe("new", '{"ok":false}', true, false, 1000), undefined);
  assert.equal(
    observe("new", '{"ok":false}', true, false, 2000),
    '{"ok":false}',
  );
  const next = new GeminiReplyTracker(["old", "new"], 2000, 10000, 10000, 1000);
  assert.equal(
    next.observe(
      {
        responses: [{ id: "new", text: '{"ok":false}', complete: true }],
        busy: false,
        waitingForTool: false,
      },
      4000,
    ),
    undefined,
  );
});

it("never finalizes a native permission card after Codex finishes but before Gemini consumes its result", () => {
  const tracker = new GeminiReplyTracker([], 0, 10000, 10000, 100);
  const response = {
    id: "native-card",
    text: "Tool argument summary",
    complete: true,
    nativeToolResponse: true,
  };
  assert.equal(
    tracker.observe(
      { responses: [response], busy: false, waitingForTool: true },
      100,
    ),
    undefined,
  );
  assert.equal(
    tracker.observe(
      { responses: [response], busy: false, waitingForTool: false },
      300,
    ),
    undefined,
  );
  assert.equal(
    tracker.observe(
      { responses: [response], busy: false, waitingForTool: false },
      1000,
    ),
    undefined,
  );
  const final = {
    id: "actual-answer",
    text: "Native result checked",
    complete: true,
  };
  assert.equal(
    tracker.observe(
      { responses: [response, final], busy: false, waitingForTool: false },
      1200,
    ),
    undefined,
  );
  assert.equal(
    tracker.observe(
      { responses: [response, final], busy: false, waitingForTool: false },
      1400,
    ),
    "Native result checked",
  );
});

it("fails an explicit completed Gemini generation error instead of accepting it as a tool result", () => {
  const tracker = new GeminiReplyTracker([], 0);
  const state = {
    responses: [
      {
        id: "new",
        text: "I seem to be encountering an error. Can I try something else for you?",
        complete: true,
      },
    ],
    busy: true,
    waitingForTool: false,
  };
  assert.equal(tracker.observe(state, 100), undefined);
  assert.throws(() => tracker.observe({ ...state, busy: false }, 200), {
    code: "gemini_generation_failed",
  });
  assert.throws(
    () =>
      new GeminiReplyTracker([], 0).observe(
        {
          ...state,
          busy: false,
          responses: [
            {
              ...state.responses[0]!,
              text: "I'm having a hard time fulfilling your request. Can I help you with something else instead?",
            },
          ],
        },
        200,
      ),
    { code: "gemini_generation_failed" },
  );
  assert.throws(
    () =>
      new GeminiReplyTracker([], 0).observe(
        {
          ...state,
          busy: false,
          responses: [
            {
              ...state.responses[0]!,
              text: "I encountered an error doing what you asked. Could you try again?",
            },
          ],
        },
        200,
      ),
    { code: "gemini_generation_failed" },
  );
});

it("matches only the exact active task and native Bridge tool in a permission card", () => {
  const token = "turn_" + "a".repeat(48);
  const card = `CodexGPT Bridge Let Gemini use "codex tool call" from CodexGPT Bridge Tool: codex tool call turn_token: ${token} arguments: {"cmd":"node --test"} wire_name: exec_command Deny Allow`;
  assert.equal(geminiPermissionMatches(card, "CodexGPT Bridge", token), true);
  for (const tool of [
    "codex tool inventory",
    "codex exec",
    "codex write stdin",
    "codex apply patch",
    "codex view image",
    "codex wait tool result",
  ])
    assert.equal(
      geminiPermissionMatches(
        card.replaceAll("codex tool call", tool),
        "CodexGPT Bridge",
        token,
      ),
      true,
    );
  for (const invalid of [
    card.replace(token, "turn_" + "b".repeat(48)),
    card.replace(token, token + "extra"),
    card.replaceAll("CodexGPT Bridge", "Other App"),
    "Other App " + card,
    card.replaceAll("codex tool call", "send email"),
    card + " turn_token: " + token,
    `Example: ${card}`,
  ])
    assert.equal(
      geminiPermissionMatches(invalid, "CodexGPT Bridge", token),
      false,
    );
});

it("separates native tool waiting from each generation deadline and rejects permission-card completion", () => {
  const tracker = new GeminiReplyTracker([], 0, 1000, 5000, 100);
  const state = {
    responses: [
      {
        id: "new",
        text: "not final while permission is pending",
        complete: true,
      },
    ],
    busy: false,
    waitingForTool: true,
  };
  assert.equal(tracker.observe(state, 0), undefined);
  assert.equal(tracker.observe(state, 4500), undefined);
  assert.equal(
    tracker.observe({ ...state, waitingForTool: false }, 4600),
    undefined,
  );
  assert.equal(
    tracker.observe({ ...state, waitingForTool: false }, 4700),
    state.responses[0]!.text,
  );
  const timeout = new GeminiReplyTracker([], 0, 1000, 5000);
  timeout.observe(state, 0);
  assert.throws(() => timeout.observe(state, 5001), {
    code: "gemini_tool_timeout",
  });
  const text = new GeminiReplyTracker([], 0, 1000, 5000);
  assert.throws(() => text.observe({ ...state, waitingForTool: false }, 1001), {
    code: "gemini_generation_timeout",
  });
});

it("keeps login, quota and verification failures distinct and validates independent versioned settings", () => {
  assert.equal(
    geminiAlertError("Session expired; sign in")?.code,
    "gemini_login_required",
  );
  assert.equal(
    geminiAlertError("Quota reached; try again tomorrow")?.code,
    "gemini_quota_exhausted",
  );
  assert.equal(
    geminiAlertError("Complete verification")?.code,
    "gemini_verification_required",
  );
  assert.equal(geminiAlertError("Read completed"), undefined);
  const locked = geminiLockedModelError(
    "3.1 Pro",
    " Limit resets Nov 2,  7:45 PM ",
  );
  assert.equal(locked.code, "gemini_quota_exhausted");
  assert.equal(
    locked.message,
    "Gemini 3.1 Pro reached its usage limit (Limit resets Nov 2, 7:45 PM). No prompt was submitted.",
  );
  assert.equal(
    geminiLockedModelError("3.1 Pro", "").message,
    "Gemini 3.1 Pro reached its usage limit. No prompt was submitted.",
  );
  assert.equal(parseGeminiSettings({}).textTimeoutMs, 600000);
  assert.equal(parseGeminiSettings({}).toolWaitTimeoutMs, 1800000);
  assert.equal(parseGeminiSettings({}).maxConcurrentTurns, 2);
  assert.equal(
    parseGeminiSettings({ maxConcurrentTurns: 4 }).maxConcurrentTurns,
    4,
  );
  for (const maxConcurrentTurns of [0, 5, 1.5, "2"])
    assert.throws(
      () => parseGeminiSettings({ maxConcurrentTurns }),
      /maxConcurrentTurns/u,
    );
  for (const publicBaseUrl of [
    "http://example.com",
    "https://example.com/path",
    "https://user:pass@example.com",
    "https://example.com/#fragment",
  ])
    assert.throws(() => parseGeminiSettings({ publicBaseUrl }));
  assert.throws(() => parseGeminiSettings({ version: 2 }));
  assert.throws(() => parseGeminiSettings({ textTimeoutMs: 0 }));
});
