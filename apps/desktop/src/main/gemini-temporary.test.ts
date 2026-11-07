import assert from "node:assert/strict";
import { it } from "node:test";
import { geminiTemporaryChatState } from "./gemini-temporary.js";
import { parseGeminiSettings } from "./gemini-settings.js";

const control = (active: boolean, icon: string, visible = true): Element =>
  ({
    tagName: "BUTTON",
    getBoundingClientRect: () => ({ width: visible ? 32 : 0, height: 32 }),
    closest: (selector: string) =>
      selector === ".temp-chat-on" && active ? {} : null,
    querySelector: () => ({ getAttribute: () => icon }),
  }) as unknown as Element;

it("requires one visible active Gemini control and its close icon to confirm temporary privacy", () => {
  const active = control(true, "close");
  assert.equal(geminiTemporaryChatState([active]), "active");
  assert.equal(
    geminiTemporaryChatState([control(false, "gemini_chat_temp")]),
    "inactive",
  );
  assert.equal(geminiTemporaryChatState([]), "unavailable");
  assert.equal(
    geminiTemporaryChatState([control(true, "close", false)]),
    "unavailable",
  );
  assert.equal(geminiTemporaryChatState([active, active]), "ambiguous");
  assert.equal(
    geminiTemporaryChatState([control(false, "close")]),
    "ambiguous",
  );
  assert.equal(
    geminiTemporaryChatState([control(true, "gemini_chat_temp")]),
    "ambiguous",
  );
});

it("recognizes the native temporary history after Gemini replaces its mode toggle", () => {
  const history = {
    tagName: "INFINITE-SCROLLER",
    classList: { contains: () => true },
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    closest: () => null,
  } as unknown as Element;
  assert.equal(geminiTemporaryChatState([history]), "active");
  assert.equal(
    geminiTemporaryChatState([control(true, "close"), history]),
    "active",
  );
  assert.equal(
    geminiTemporaryChatState([control(false, "gemini_chat_temp"), history]),
    "ambiguous",
  );
  assert.equal(
    geminiTemporaryChatState([
      { ...history, closest: () => ({}) } as unknown as Element,
    ]),
    "ambiguous",
  );
});

it("keeps old fresh-conversation settings separate from opt-in Simple temporary chats", () => {
  assert.equal(parseGeminiSettings({}).simpleTemporaryChat, false);
  assert.equal(
    parseGeminiSettings({ freshConversationPerTurn: true }).simpleTemporaryChat,
    false,
  );
  assert.equal(
    parseGeminiSettings({ simpleTemporaryChat: true }).simpleTemporaryChat,
    true,
  );
});
