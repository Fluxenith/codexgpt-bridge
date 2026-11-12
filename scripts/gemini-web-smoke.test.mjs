import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import {
  createGeminiSmokeFixture,
  disposeGeminiSmokeFixture,
  executeGeminiSmokeTool,
  GeminiSmokeReplyTracker,
  parseGeminiSmokeReply,
  runGeminiSmoke,
} from "./gemini-web-smoke-lib.mjs";

const call = (id, command) => ({
  type: "tool_call",
  id,
  name: "local_exec",
  arguments: { command },
});

test("runs actual fixture reads and validates the unseen nonce in the final answer", async () => {
  const fixture = await createGeminiSmokeFixture();
  try {
    let step = 0;
    const result = await runGeminiSmoke(async (prompt) => {
      if (step++ === 0)
        return JSON.stringify(call("call_1", "Get-ChildItem -Name"));
      const reply = JSON.parse(prompt);
      assert.equal(reply.type, "tool_result");
      assert.equal(reply.exit_code, 0);
      if (step === 2) {
        assert.ok(reply.stdout.includes("package.json"));
        return JSON.stringify(
          call("call_2", "Get-Content -Path package.json -Raw"),
        );
      }
      const manifest = JSON.parse(reply.stdout);
      return JSON.stringify({
        type: "final",
        text: `${manifest.name} dev: vite; build: tsc && vite build; ${manifest.bridge_probe}`,
      });
    }, fixture);
    assert.equal(result.turns.length, 3);
    assert.ok(result.final.includes(fixture.manifest.bridge_probe));
  } finally {
    await disposeGeminiSmokeFixture(fixture);
  }
});

test("rejects fabricated completion and repeated call IDs", async () => {
  const fixture = await createGeminiSmokeFixture();
  try {
    await assert.rejects(
      runGeminiSmoke(
        async () => JSON.stringify({ type: "final", text: "Done" }),
        fixture,
      ),
      /before final/u,
    );
    await assert.rejects(
      runGeminiSmoke(
        async () => JSON.stringify(call("same", "Get-ChildItem -Name")),
        fixture,
      ),
      /Duplicate/u,
    );
  } finally {
    await disposeGeminiSmokeFixture(fixture);
  }
});

test("rejects command injection, other files and unadvertised tools", async () => {
  for (const command of [
    "Get-ChildItem -Name; whoami",
    "Get-Content ../package.json -Raw",
    "Get-Content package.json -Raw | Invoke-Expression",
    "Remove-Item package.json",
  ]) {
    await assert.rejects(
      executeGeminiSmokeTool(call("c", command), { directory: "unused" }),
      /only allows/u,
    );
  }
  assert.throws(
    () =>
      parseGeminiSmokeReply(
        JSON.stringify({ ...call("c", "Get-ChildItem -Name"), name: "other" }),
      ),
    /Unadvertised/u,
  );
  assert.throws(() => parseGeminiSmokeReply("Here is JSON: {}"));
  assert.throws(() => parseGeminiSmokeReply("{} {}"));
});

test("rejects a final answer that does not prove the package result was read", async () => {
  const fixture = await createGeminiSmokeFixture();
  const replies = [
    call("call_1", "Get-ChildItem -Name"),
    call("call_2", "Get-Content -Raw package.json"),
    {
      type: "final",
      text: "gemini-bridge-test dev: vite; build: tsc && vite build",
    },
  ];
  try {
    await assert.rejects(
      runGeminiSmoke(async () => JSON.stringify(replies.shift()), fixture),
      /Final reply omitted/u,
    );
  } finally {
    await disposeGeminiSmokeFixture(fixture);
  }
});

test("fixture cleanup refuses a path outside the owned temporary directory", async () => {
  await assert.rejects(
    disposeGeminiSmokeFixture({ directory: process.cwd() }),
    /Fixture must/u,
  );
});

test("requires a new completed response and restarts settling after streaming changes", () => {
  const tracker = new GeminiSmokeReplyTracker(["old"], 1000);
  const response = {
    id: "old",
    text: "old response",
    busy: false,
    complete: true,
  };
  assert.equal(tracker.observe([response], 0), undefined);
  response.id = "new";
  response.busy = true;
  assert.equal(tracker.observe([response], 1000), undefined);
  response.busy = false;
  response.complete = false;
  assert.equal(tracker.observe([response], 2000), undefined);
  response.complete = true;
  assert.equal(tracker.observe([response], 3000), undefined);
  response.text = "final response";
  assert.equal(tracker.observe([response], 3500), undefined);
  assert.equal(tracker.observe([response], 4000), undefined);
  assert.equal(tracker.observe([response], 4500), "final response");
});
