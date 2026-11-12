import assert from "node:assert/strict";
import { it } from "node:test";
import {
  geminiNotebookId,
  geminiNotebookName,
  geminiNotebookUrl,
  matchGeminiNotebook,
} from "./gemini-notebooks.js";
import { parseGeminiSettings } from "./gemini-settings.js";

const id = "d0de3d2a-31f1-4d50-a6c1-621b65356052";

it("reads only exact Gemini notebook paths", () => {
  assert.equal(geminiNotebookId(`/notebook/${id}`), id);
  assert.equal(
    geminiNotebookId(`https://gemini.google.com/notebook/${id}?hl=en`),
    id,
  );
  for (const bad of [
    "/notebooks/create",
    `/notebook/${id}/extra`,
    `https://example.com/notebook/${id}`,
    "/app/ca1f53e0545292c7",
    "/notebook/not-a-uuid",
  ])
    assert.equal(geminiNotebookId(bad), undefined);
  assert.equal(
    geminiNotebookUrl(id),
    `https://gemini.google.com/notebook/${id}?hl=en`,
  );
  assert.throws(() => geminiNotebookUrl("../app"));
});

it("matches one notebook by exact name and refuses duplicates", () => {
  const other = "11111111-2222-4333-8444-555555555555";
  const links = [
    { href: `/notebook/${id}`, name: "codexgpt-bridge" },
    { href: `/notebook/${other}`, name: "codexgpt-bridge-old" },
    { href: "/notebooks/create", name: "codexgpt-bridge" },
  ];
  assert.equal(matchGeminiNotebook(links, "codexgpt-bridge"), id);
  assert.equal(matchGeminiNotebook(links, " codexgpt-bridge "), id);
  assert.equal(matchGeminiNotebook(links, "missing"), undefined);
  assert.equal(
    matchGeminiNotebook([...links, links[0]!], "codexgpt-bridge"),
    id,
  );
  assert.throws(
    () =>
      matchGeminiNotebook(
        [...links, { href: `/notebook/${other}`, name: "codexgpt-bridge" }],
        "codexgpt-bridge",
      ),
    /more than one notebook/u,
  );
});

it("keeps notebook mapping opt-in and validates names", () => {
  assert.equal(parseGeminiSettings({}).notebookMapping, false);
  assert.equal(
    parseGeminiSettings({ notebookMapping: true }).notebookMapping,
    true,
  );
  assert.equal(geminiNotebookName("  my   project "), "my project");
  assert.throws(() => geminiNotebookName("   "));
  assert.throws(() => geminiNotebookName("x".repeat(101)));
});
