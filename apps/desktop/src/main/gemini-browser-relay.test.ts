import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import type {
  WebProvider,
  WebProviderRoute,
} from "@codexgpt-bridge/responses-gateway";
import { GeminiBrowserRelay } from "./gemini-browser-relay.js";

const route: WebProviderRoute = {
  provider: "gemini",
  accountKey: "fixture-account",
  slug: "gemini-web/fixture/low/full",
  displayName: "Fixture",
  description: "Fixture",
  mode: "medium",
  effort: "low",
  contextWindow: 32000,
  contextBudget: {
    contextWindow: 32000,
    hardInputTokenLimit: 32000,
    autoCompactTokenLimit: 28000,
    profile: "fixture",
  },
  selection: {
    provider: "gemini",
    model: "Fixture",
    thinking: "Low",
    activity: "chat",
  },
};
const input = (): Parameters<WebProvider["runTurn"]>[0] => ({
  prompt: "Disposable browser task",
  images: [],
  mode: "medium",
  signal: new AbortController().signal,
  providerRoute: route,
  operationId: "fixture-operation",
});
async function request(
  directory: string,
  afterId?: string,
): Promise<{
  id: string;
  prompt: string;
  forceNewConversation: boolean;
  conversationUrl?: string;
}> {
  for (let i = 0; i < 100; i++) {
    try {
      const job = JSON.parse(
        await readFile(join(directory, "request.json"), "utf8"),
      );
      if (job.id !== afterId) return job;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error("No browser request was published.");
}

it("sends only acknowledged context additions and discards retention after a wrong-conversation receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-gemini-relay-"));
  const relay = new GeminiBrowserRelay(directory);
  const context = {
    instructions: "UNIQUE_NATIVE_INSTRUCTIONS",
    history: ["OLD_HISTORY"],
    ledger: ["old-hash"],
    images: [],
  };
  const reply = (
    id: string,
    conversationUrl = "https://gemini.google.com/app/fixture",
  ) =>
    writeFile(
      join(directory, "result.json"),
      JSON.stringify({
        id,
        text: "UNIT_REPLY",
        selection: route.selection,
        accountKey: route.accountKey,
        conversationUrl,
        answerId: `answer-${id}`,
        baselineIds: [],
        complete: true,
        stable: true,
      }),
    );
  try {
    const first = relay.runTurn({
      ...input(),
      threadId: "same-thread",
      context,
      contract: "UNIQUE_TOOL_CONTRACT",
    });
    const firstJob = await request(directory);
    assert.equal(firstJob.forceNewConversation, true);
    assert.match(firstJob.prompt, /UNIQUE_NATIVE_INSTRUCTIONS/u);
    assert.match(firstJob.prompt, /OLD_HISTORY/u);
    await reply(firstJob.id);
    await first;
    const nextContext = {
      ...context,
      history: [...context.history, "NEW_HISTORY"],
      ledger: [...context.ledger, "new-hash"],
    };
    const second = relay.runTurn({
      ...input(),
      threadId: "same-thread",
      context: nextContext,
      contract: "UNIQUE_TOOL_CONTRACT",
    });
    const rejected = assert.rejects(second, /different conversation/u);
    const secondJob = await request(directory, firstJob.id);
    assert.equal(secondJob.forceNewConversation, false);
    assert.equal(
      secondJob.conversationUrl,
      "https://gemini.google.com/app/fixture",
    );
    assert.match(secondJob.prompt, /NEW_HISTORY/u);
    assert.doesNotMatch(
      secondJob.prompt,
      /UNIQUE_NATIVE_INSTRUCTIONS|UNIQUE_TOOL_CONTRACT|OLD_HISTORY/u,
    );
    await reply(secondJob.id, "https://gemini.google.com/app/wrong");
    await rejected;
    const third = relay.runTurn({
      ...input(),
      threadId: "same-thread",
      context: nextContext,
      contract: "UNIQUE_TOOL_CONTRACT",
    });
    const thirdJob = await request(directory, secondJob.id);
    assert.equal(thirdJob.forceNewConversation, true);
    assert.match(thirdJob.prompt, /UNIQUE_NATIVE_INSTRUCTIONS/u);
    assert.match(thirdJob.prompt, /OLD_HISTORY/u);
    await reply(thirdJob.id);
    await third;
  } finally {
    await relay.close();
    assert.ok(directory.startsWith(join(tmpdir(), "bridge-gemini-relay-")));
    await rm(directory, { recursive: true, force: true });
  }
});
for (const oldAnswer of [false, true])
  it(`requires a completed new browser answer receipt (${oldAnswer ? "old answer rejected" : "fresh answer accepted"})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-gemini-relay-"));
    const relay = new GeminiBrowserRelay(directory);
    try {
      const running = relay.runTurn(input());
      const job = await request(directory);
      const rejected = oldAnswer
        ? assert.rejects(running, /old browser answer/u)
        : undefined;
      await writeFile(
        join(directory, "result.json"),
        JSON.stringify({
          id: job.id,
          text: "ACTUAL_REPLY",
          selection: route.selection,
          accountKey: route.accountKey,
          conversationUrl: "https://gemini.google.com/app/fixture",
          answerId: "answer-new",
          baselineIds: oldAnswer ? ["answer-new"] : ["answer-old"],
          complete: true,
          stable: true,
        }),
      );
      if (rejected) await rejected;
      else assert.equal((await running).output, "ACTUAL_REPLY");
      assert.equal(relay.busy, false);
    } finally {
      await relay.close();
      assert.ok(directory.startsWith(join(tmpdir(), "bridge-gemini-relay-")));
      await rm(directory, { recursive: true, force: true });
    }
  });

it("cancels an existing-browser wait without creating a replacement request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-gemini-relay-"));
  const relay = new GeminiBrowserRelay(directory);
  const controller = new AbortController();
  try {
    const running = relay.runTurn({ ...input(), signal: controller.signal });
    const job = await request(directory);
    const rejected = assert.rejects(running, { name: "AbortError" });
    controller.abort();
    await rejected;
    const failed = JSON.parse(
      await readFile(join(directory, "request.json"), "utf8"),
    ) as { id: string; phase: string };
    assert.equal(failed.id, job.id);
    assert.equal(failed.phase, "failed");
  } finally {
    await relay.close();
    assert.ok(directory.startsWith(join(tmpdir(), "bridge-gemini-relay-")));
    await rm(directory, { recursive: true, force: true });
  }
});
