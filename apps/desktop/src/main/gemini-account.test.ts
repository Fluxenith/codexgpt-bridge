import assert from "node:assert/strict";
import { it } from "node:test";
import { geminiAccountEmails } from "./gemini-account.js";

function anchor(
  email: string,
  role: "button" | "link",
  visible = true,
  href = "https://accounts.google.com/SignOutOptions?hl=en",
): Element {
  return {
    getAttribute: (name: string) =>
      ({ href, role, "aria-label": `Google Account: Fixture (${email})` })[
        name as "href" | "role" | "aria-label"
      ] ?? null,
    getBoundingClientRect: () => ({ width: visible ? 32 : 0, height: 32 }),
  } as unknown as Element;
}

it("recognizes the visible Gemini account when its anchor exposes the button role", () => {
  assert.deepEqual(
    geminiAccountEmails([
      anchor("Fixture@example.com", "button"),
      anchor("other@example.com", "link", false),
    ]),
    ["fixture@example.com"],
  );
  assert.deepEqual(
    geminiAccountEmails([anchor("Fixture@example.com", "link")]),
    ["fixture@example.com"],
  );
});

it("rejects foreign account links, hidden copies and conflicting visible account identities", () => {
  assert.deepEqual(
    geminiAccountEmails([
      anchor(
        "fixture@example.com",
        "button",
        true,
        "https://accounts.google.com.example.com/SignOutOptions",
      ),
      anchor("hidden@example.com", "link", false),
    ]),
    [],
  );
  assert.equal(
    geminiAccountEmails([
      anchor("one@example.com", "button"),
      anchor("two@example.com", "link"),
    ]).length,
    2,
  );
});
it("keeps hidden account metadata separate from fresh login evidence", () => {
  const hidden = anchor("fixture@example.com", "button", false);
  assert.deepEqual(geminiAccountEmails([hidden]), []);
  assert.deepEqual(geminiAccountEmails([hidden], true), [
    "fixture@example.com",
  ]);
  assert.deepEqual(
    geminiAccountEmails(
      [
        anchor(
          "fixture@example.com",
          "button",
          false,
          "https://accounts.google.com.evil.test/SignOutOptions",
        ),
      ],
      true,
    ),
    [],
  );
});
