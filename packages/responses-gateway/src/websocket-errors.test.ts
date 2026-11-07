import assert from "node:assert/strict";
import { it } from "node:test";
import { once } from "node:events";
import WebSocket from "ws";
import { ResponsesGateway } from "./responses-server.js";
import { FullTurnBroker } from "./full-turn-broker.js";

async function nextEvent(socket: WebSocket): Promise<Record<string, unknown>> {
  const [data] = await once(socket, "message", {
    signal: AbortSignal.timeout(2_000),
  });
  return JSON.parse(String(data)) as Record<string, unknown>;
}

async function connect(gateway: ResponsesGateway): Promise<WebSocket> {
  const address = await gateway.start();
  const socket = new WebSocket(
    `${address.baseUrl.replace(/^http/, "ws")}/responses`,
    { headers: { authorization: "Bearer test" } },
  );
  await once(socket, "open", { signal: AbortSignal.timeout(2_000) });
  return socket;
}

it("returns a terminal Codex WebSocket error for stale low effort and accepts a corrected turn", async () => {
  let browserCalls = 0;
  const gateway = new ResponsesGateway({
    port: 0,
    availableWebModes: () => ["instant", "medium", "high", "extra-high", "pro"],
    accountContextProfile: () => "pro",
    nativeModelFamilies: () => ["6"],
    fullMcp: {
      broker: new FullTurnBroker(),
      enabled: () => true,
      connectorName: () => "Bridge",
    },
    runWebTurn: async (input) => {
      browserCalls++;
      assert.equal(input.mode, "medium");
      assert.equal(input.execution?.toolTransport, "full");
      return "corrected-turn-ok";
    },
  });
  const socket = await connect(gateway);
  try {
    let event = nextEvent(socket);
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "codexgpt-bridge/gpt-6-sol",
        reasoning: { effort: "low" },
        input: "test",
      }),
    );
    assert.deepEqual(await event, {
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        code: "bridge_reasoning_effort_unavailable",
        message:
          'Unsupported reasoning effort "low" for codexgpt-bridge/gpt-6-sol; choose medium, high, xhigh. No prompt was submitted.',
        param: null,
      },
      sequence_number: 0,
    });
    assert.equal(browserCalls, 0);
    const completed = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const result = JSON.parse(String(data)) as Record<string, unknown>;
        if (result.type === "response.completed") resolve(result);
      });
    });
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "codexgpt-bridge/gpt-6-sol",
        reasoning: { effort: "medium" },
        input: "test",
        metadata: { thread_id: "corrected-thread", turn_id: "corrected-turn" },
      }),
    );
    event = Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Corrected turn stalled.")),
          2_000,
        );
        timer.unref();
        void completed.then(() => clearTimeout(timer));
      }),
    ]);
    assert.equal((await event).type, "response.completed");
    assert.equal(browserCalls, 1);
    assert.equal(gateway.lifecycleStatus().activeHttpTurns, 0);
  } finally {
    socket.terminate();
    await gateway.close();
  }
});

it("wraps malformed events and unavailable models as HTTP 400 WebSocket errors", async () => {
  const gateway = new ResponsesGateway({
    port: 0,
    runWebTurn: async () =>
      assert.fail("Invalid requests must not reach the browser."),
  });
  const socket = await connect(gateway);
  try {
    for (const [request, code] of [
      ["{", "invalid_json"],
      [JSON.stringify({ type: "unknown" }), "unsupported_event"],
      [
        JSON.stringify({
          type: "response.create",
          model: "codexgpt-bridge/unknown",
        }),
        "unsupported_bridge_web_model",
      ],
    ]) {
      const event = nextEvent(socket);
      socket.send(request!);
      const result = await event;
      assert.equal(result.status, 400);
      assert.equal((result.error as Record<string, unknown>).code, code);
    }
  } finally {
    socket.terminate();
    await gateway.close();
  }
});

it("preserves server failures and draining status in the Codex WebSocket envelope", async () => {
  const gateway = new ResponsesGateway({
    port: 0,
    admin: { token: "test-admin-capability" },
    availableWebModes: () => {
      throw new Error("Capability snapshot unavailable.");
    },
    runWebTurn: async () =>
      assert.fail("Preflight failures must not reach the browser."),
  });
  const socket = await connect(gateway);
  try {
    let event = nextEvent(socket);
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "codexgpt-bridge/high",
      }),
    );
    assert.deepEqual(await event, {
      type: "error",
      status: 500,
      error: {
        type: "server_error",
        code: "codexgpt_bridge_provider_error",
        message: "Capability snapshot unavailable.",
        param: null,
      },
      sequence_number: 0,
    });
    const drainUrl = new URL(socket.url);
    drainUrl.protocol = "http:";
    drainUrl.pathname = "/admin/drain";
    await fetch(drainUrl, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-capability" },
    });
    event = nextEvent(socket);
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "codexgpt-bridge/high",
      }),
    );
    const result = await event;
    assert.equal(result.status, 503);
    assert.equal(
      (result.error as Record<string, unknown>).code,
      "provider_draining",
    );
    assert.deepEqual(result.headers, { "retry-after": "5" });
  } finally {
    socket.terminate();
    await gateway.close();
  }
});

function sseResponse(events: readonly Record<string, unknown>[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function eventsUntilTerminal(
  socket: WebSocket,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const events: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`No terminal event: ${JSON.stringify(events)}`));
    }, 2_000);
    const onMessage = (data: WebSocket.RawData): void => {
      const event = JSON.parse(String(data)) as Record<string, unknown>;
      events.push(event);
      if (
        event.type === "response.completed" ||
        event.type === "response.failed" ||
        event.type === "error"
      ) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(events);
      }
    };
    socket.on("message", onMessage);
  });
}

it("forwards native models over WebSocket to the original provider and rebuilds history", async () => {
  const calls: {
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }[] = [];
  const gateway = new ResponsesGateway({
    port: 0,
    upstreamBaseUrl: "http://upstream.test/backend-api/codex",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body,
      });
      const id = `resp_native_${calls.length}`;
      const item = {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `answer ${calls.length}` }],
      };
      return sseResponse([
        { type: "response.created", response: { id, status: "in_progress" } },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, status: "completed" } },
      ]);
    }) as typeof fetch,
    runWebTurn: async () =>
      assert.fail("Native models must not reach the browser."),
  });
  const socket = await connect(gateway);
  try {
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-6.1-sol",
        instructions: "be brief",
        input: [{ role: "user", content: "first" }],
      }),
    );
    const first = await eventsUntilTerminal(socket);
    assert.deepEqual(
      first.map((event) => event.type),
      ["response.created", "response.output_item.done", "response.completed"],
    );
    assert.equal(
      calls[0]!.url,
      "http://upstream.test/backend-api/codex/responses",
    );
    assert.equal(calls[0]!.headers.get("authorization"), "Bearer test");
    assert.equal(calls[0]!.headers.get("accept"), "text/event-stream");
    assert.equal(calls[0]!.headers.get("sec-websocket-key"), null);
    assert.equal(calls[0]!.headers.get("upgrade"), null);
    assert.equal(calls[0]!.body.type, undefined);
    assert.equal(calls[0]!.body.stream, true);
    assert.equal(calls[0]!.body.model, "gpt-6.1-sol");

    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-6.1-sol",
        previous_response_id: "resp_native_1",
        input: [{ role: "user", content: "second" }],
      }),
    );
    const second = await eventsUntilTerminal(socket);
    assert.equal(second.at(-1)!.type, "response.completed");
    assert.equal(calls[1]!.body.previous_response_id, undefined);
    assert.equal(calls[1]!.body.instructions, "be brief");
    assert.deepEqual(calls[1]!.body.input, [
      { role: "user", content: "first" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "answer 1" }],
      },
      { role: "user", content: "second" },
    ]);
    assert.equal(gateway.lifecycleStatus().activeHttpTurns, 0);
  } finally {
    socket.terminate();
    await gateway.close();
  }
});

it("answers native WebSocket warm-ups locally and continues from them", async () => {
  const bodies: Record<string, unknown>[] = [];
  const gateway = new ResponsesGateway({
    port: 0,
    upstreamBaseUrl: "http://upstream.test",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse([
        { type: "response.completed", response: { id: "resp_after_warmup" } },
      ]);
    }) as typeof fetch,
    runWebTurn: async () =>
      assert.fail("Native models must not reach the browser."),
  });
  const socket = await connect(gateway);
  try {
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-6.1-sol",
        generate: false,
        input: [{ role: "user", content: "hello" }],
      }),
    );
    const warmup = await eventsUntilTerminal(socket);
    assert.equal(bodies.length, 0);
    const completed = warmup.at(-1)!;
    assert.equal(completed.type, "response.completed");
    const warmupId = (completed.response as Record<string, unknown>).id;
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-6.1-sol",
        previous_response_id: warmupId,
        input: [],
      }),
    );
    await eventsUntilTerminal(socket);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.generate, undefined);
    assert.deepEqual(bodies[0]!.input, [{ role: "user", content: "hello" }]);
  } finally {
    socket.terminate();
    await gateway.close();
  }
});

it("relays original provider HTTP errors for native WebSocket turns", async () => {
  const gateway = new ResponsesGateway({
    port: 0,
    upstreamBaseUrl: "http://upstream.test",
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          error: {
            type: "usage_limit_reached",
            code: "rate_limited",
            message: "Slow down.",
          },
        }),
        { status: 429 },
      )) as typeof fetch,
    runWebTurn: async () =>
      assert.fail("Native models must not reach the browser."),
  });
  const socket = await connect(gateway);
  try {
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-6.1-sol",
        input: "hi",
      }),
    );
    const [event] = await eventsUntilTerminal(socket);
    assert.equal(event!.status, 429);
    assert.deepEqual(event!.error, {
      type: "usage_limit_reached",
      code: "rate_limited",
      message: "Slow down.",
      param: null,
    });
  } finally {
    socket.terminate();
    await gateway.close();
  }
});
