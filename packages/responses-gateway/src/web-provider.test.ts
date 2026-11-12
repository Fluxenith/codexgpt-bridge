import assert from "node:assert/strict";
import { it } from "node:test";
import {
  WebProviderRegistry,
  type WebProvider,
  type WebProviderCapabilities,
  type WebProviderRoute,
} from "./web-provider.js";
import { ResponsesGateway, type RunWebTurnInput } from "./responses-server.js";
import { FullTurnBroker } from "./full-turn-broker.js";

const route: WebProviderRoute = {
  provider: "gemini",
  accountKey: "account-a",
  slug: "gemini-web/pro",
  displayName: "Gemini Pro",
  description: "Account-discovered Web model",
  mode: "high",
  effort: "medium",
  contextWindow: 16000,
  selection: { provider: "gemini", model: "3.1 Pro", activity: "chat" },
  contextBudget: {
    contextWindow: 16000,
    hardInputTokenLimit: 16000,
    autoCompactTokenLimit: 14000,
    profile: "gemini-local-v1",
  },
};
const snapshot: WebProviderCapabilities = {
  version: 1,
  provider: "gemini",
  accountKey: route.accountKey,
  observedAt: new Date().toISOString(),
  routes: [route],
};

for (const toolMode of ["full", "simple"] as const)
  it(`honors an explicit Gemini ${toolMode} route without substituting the other transport`, async () => {
    const selected = { ...route, toolMode };
    const broker = new FullTurnBroker();
    let calls = 0;
    const registry = new WebProviderRegistry([
      provider(
        async (job) => {
          calls++;
          assert.equal(job.allowWebNativeTools, undefined);
          return result("<codex_text>SIMPLE_VERIFIED</codex_text>");
        },
        async () => ({ ...snapshot, routes: [selected] }),
      ),
    ]);
    const gateway = new ResponsesGateway({
      port: 0,
      providers: registry,
      fullMcp: {
        broker,
        enabled: () => toolMode === "simple",
        connectorName: () => "Bridge",
      },
      runWebTurn: async () => {
        throw new Error("Wrong provider");
      },
    });
    try {
      const address = await gateway.start();
      const response = await fetch(address.baseUrl + "/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: route.slug, input: "Hello" }),
      });
      if (toolMode === "full") {
        assert.equal(response.status, 400);
        assert.match(await response.text(), /bridge_full_mcp_unavailable/u);
        assert.equal(calls, 0);
      } else {
        assert.equal(response.status, 200);
        assert.match(await response.text(), /SIMPLE_VERIFIED/u);
        assert.equal(calls, 1);
      }
    } finally {
      await gateway.close();
      await registry.close();
      broker.close();
    }
  });

it("preserves Gemini login, quota, verification and deadline failures as distinct Responses errors", async () => {
  let failure = "gemini_login_required";
  const registry = new WebProviderRegistry([
    provider(async () => {
      throw Object.assign(new Error("Provider diagnostic"), { code: failure });
    }),
  ]);
  const gateway = new ResponsesGateway({
    port: 0,
    providers: registry,
    runWebTurn: async () => {
      throw new Error("Wrong provider");
    },
  });
  try {
    const address = await gateway.start();
    for (const [code, status] of [
      ["gemini_login_required", 503],
      ["gemini_quota_exhausted", 429],
      ["gemini_verification_required", 503],
      ["gemini_generation_timeout", 504],
      ["gemini_generation_failed", 502],
      ["gemini_tool_timeout", 504],
      ["gemini_submission_uncertain", 409],
    ] as const) {
      failure = code;
      const response = await fetch(address.baseUrl + "/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: route.slug, input: "Hello" }),
      });
      assert.equal(response.status, status);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        code,
      );
    }
  } finally {
    await gateway.close();
    await registry.close();
  }
});
const input = (
  prompt = "hello",
): RunWebTurnInput & { providerRoute: WebProviderRoute } => ({
  prompt,
  mode: "high",
  signal: new AbortController().signal,
  images: [],
  providerRoute: route,
});
function provider(
  run: WebProvider["runTurn"],
  capabilities = async () => snapshot,
): WebProvider {
  return {
    id: "gemini",
    capabilities,
    login: async () => {},
    close: async () => {},
    runTurn: run,
  };
}
const result = (output: string) => ({
  output,
  selection: route.selection,
  accountKey: route.accountKey,
});

it("keeps Gemini Full MCP on the native broker across a Responses tool-result round", async () => {
  const broker = new FullTurnBroker();
  let runs = 0;
  const registry = new WebProviderRegistry([
    provider(async (job) => {
      runs++;
      assert.equal(job.allowWebNativeTools, true);
      assert.equal(job.connectorName, "Gemini bridge");
      assert.equal(job.isWaitingForNativeTools?.(), false);
      const token = /turn_[A-Za-z0-9_-]{40,}/u.exec(job.contract!)![0]!;
      const pending = broker.invoke(token, "fixture_read", {
        arguments: { path: "package.json" },
      });
      assert.equal(job.isWaitingForNativeTools?.(), true);
      const response = await pending;
      assert.equal(job.isWaitingForNativeTools?.(), false);
      return result(JSON.stringify(response));
    }),
  ]);
  const gateway = new ResponsesGateway({
    port: 0,
    providers: registry,
    fullMcp: {
      broker,
      enabled: () => true,
      connectorName: (id) => {
        assert.equal(id, "gemini");
        return "Gemini bridge";
      },
    },
    runWebTurn: async () => {
      throw new Error("Gemini Full must not fall back to ChatGPT or Simple");
    },
  });
  const address = await gateway.start();
  const headers = {
    authorization: "Bearer native-fixture",
    "content-type": "application/json",
  };
  const request = {
    model: route.slug,
    metadata: {
      thread_id: "gemini-native-broker",
      turn_id: "gemini-native-broker",
    },
    tools: [
      {
        type: "function",
        name: "fixture_read",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
  };
  try {
    const call = async (input: unknown[]) =>
      (await (
        await fetch(address.baseUrl + "/responses", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...request, input }),
        })
      ).json()) as {
        output: { type: string; name?: string; call_id?: string }[];
      };
    const first = await call([{ role: "user", content: "Read the fixture" }]);
    const tool = first.output.find((item) => item.type === "function_call")!;
    assert.equal(tool.name, "fixture_read");
    const final = await call([
      { role: "user", content: "Read the fixture" },
      tool,
      {
        type: "function_call_output",
        call_id: tool.call_id,
        output: "NATIVE_RESULT_NONCE",
      },
    ]);
    assert.match(JSON.stringify(final.output), /NATIVE_RESULT_NONCE/u);
    assert.equal(runs, 1);
  } finally {
    await gateway.close();
    broker.close();
  }
});

it("serializes Gemini tasks and cancels a queued task before it can touch the browser", async () => {
  const started: string[] = [];
  let release!: () => void;
  const firstStarted = new Promise<void>((done) => {
    release = done;
  });
  let finish!: () => void;
  const gate = new Promise<void>((done) => {
    finish = done;
  });
  const registry = new WebProviderRegistry([
    provider(async (job) => {
      started.push(job.prompt);
      if (job.prompt === "one") {
        release();
        await gate;
      }
      return result(job.prompt);
    }),
  ]);
  const first = registry.runTurn(input("one"));
  await firstStarted;
  const controller = new AbortController();
  const cancelled = registry.runTurn({
    ...input("cancelled"),
    signal: controller.signal,
  });
  const last = registry.runTurn(input("two"));
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.deepEqual(started, ["one"]);
  finish();
  assert.equal(await first, "one");
  assert.equal(await last, "two");
  assert.deepEqual(started, ["one", "two"]);
});

it("runs up to the provider's concurrent turn limit and queues the rest", async () => {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  let bothStarted!: () => void;
  const twoRunning = new Promise<void>((done) => {
    bothStarted = done;
  });
  const registry = new WebProviderRegistry([
    {
      ...provider(async (job) => {
        started.push(job.prompt);
        if (started.length === 2) bothStarted();
        await new Promise<void>((done) => gates.set(job.prompt, done));
        return result(job.prompt);
      }),
      maxConcurrentTurns: () => 2,
    },
  ]);
  const one = registry.runTurn(input("one"));
  const two = registry.runTurn(input("two"));
  await twoRunning;
  const controller = new AbortController();
  const cancelled = registry.runTurn({
    ...input("cancelled"),
    signal: controller.signal,
  });
  const three = registry.runTurn(input("three"));
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(started, ["one", "two"]);
  gates.get("one")!();
  assert.equal(await one, "one");
  while (!gates.has("three")) await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(started, ["one", "two", "three"]);
  gates.get("two")!();
  gates.get("three")!();
  assert.equal(await two, "two");
  assert.equal(await three, "three");
});

it("rejects account changes before Send, and never accepts a different model receipt", async () => {
  let calls = 0;
  const registry = new WebProviderRegistry([
    provider(
      async () => {
        calls++;
        return result("bad");
      },
      async () => ({ ...snapshot, accountKey: "account-b" }),
    ),
  ]);
  await assert.rejects(registry.runTurn(input()), /account changed/u);
  assert.equal(calls, 0);
  const mismatch = new WebProviderRegistry([
    provider(async () => ({
      ...result("bad"),
      selection: { ...route.selection, model: "Flash" },
    })),
  ]);
  await assert.rejects(mismatch.runTurn(input()), /did not confirm/u);
});

it("lists both providers, uses Gemini's own context budget and fails unknown Gemini models locally", async () => {
  let geminiCalls = 0,
    chatGptCalls = 0,
    upstreamCalls = 0;
  const registry = new WebProviderRegistry([
    provider(async (job) => {
      geminiCalls++;
      assert.equal(job.providerRoute.selection.model, "3.1 Pro");
      assert.equal(job.execution?.hardInputTokenLimit, 16000);
      return result("GEMINI_RESULT");
    }),
  ]);
  const token = "provider-test-local-key";
  const gateway = new ResponsesGateway({
    port: 0,
    providers: registry,
    webOnly: {
      token,
      models: async () => ({
        models: [{ slug: "native", base_instructions: "Fixture" }],
      }),
    },
    accountContextProfile: () => "pro",
    receiptAwareContextSync: true,
    fetchImpl: async () => {
      upstreamCalls++;
      throw new Error("Unexpected upstream request");
    },
    runWebTurn: async () => {
      chatGptCalls++;
      return "<codex_text>CHATGPT_RESULT</codex_text>";
    },
  });
  const address = await gateway.start();
  const url = address.baseUrl.replace("/v1", "/web/v1");
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  try {
    const catalog = (await (
      await fetch(url + "/models", { headers })
    ).json()) as { models: { slug: string; context_window: number }[] };
    assert.equal(
      catalog.models.find((row) => row.slug === route.slug)?.context_window,
      16000,
    );
    assert.ok(
      catalog.models.some((row) => row.slug === "codexgpt-bridge/high"),
    );
    for (const [model, expected] of [
      [route.slug, "GEMINI_RESULT"],
      ["codexgpt-bridge/high", "CHATGPT_RESULT"],
    ]) {
      const response = await fetch(url + "/responses", {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: "hello" }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.match(await response.text(), new RegExp(expected!));
    }
    for (const model of ["gemini-web/missing", "gemini-web/pro"]) {
      const response = await fetch(url + "/responses", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          reasoning: { effort: "high" },
          input: "hello",
        }),
      });
      assert.equal(response.status, 400);
    }
    const oversized = await fetch(url + "/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: route.slug,
        input: "context budget ".repeat(20000),
      }),
    });
    assert.equal(oversized.status, 400);
    assert.match(await oversized.text(), /bridge_context_limit_exceeded/u);
    assert.deepEqual([geminiCalls, chatGptCalls, upstreamCalls], [1, 1, 0]);
  } finally {
    await gateway.close();
  }
});
