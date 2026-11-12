import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  GeminiMcpAuth,
  type GeminiMcpCredentialState,
} from "./gemini-mcp-auth.js";
import { GeminiMcpGateway } from "./gemini-mcp-gateway.js";
import { FullTurnBroker } from "./full-turn-broker.js";
import { FullTurnMcpServer } from "./full-turn-mcp-server.js";
import { setTimeout as delay } from "node:timers/promises";

const publicUrl = "https://gemini-mcp.example.com";
const redirect = "https://gemini.google.com/test-oauth-callback";
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

test(
  "SSE flushes and heartbeats before native completion, and a reconnect joins the same RPC",
  { timeout: 15000 },
  async () => {
    const broker = new FullTurnBroker();
    const token = broker.register(
      "slow-gemini-sse",
      [
        {
          kind: "function",
          wireName: "exec_command",
          name: "exec_command",
          description: "fixture",
          parameters: { type: "object" },
        },
      ],
      true,
    );
    const native = new FullTurnMcpServer(broker);
    const nativeAddress = await native.start();
    const events: { heartbeats?: number; transport?: string }[] = [];
    const gateway = new GeminiMcpGateway({
      publicBaseUrl: publicUrl,
      upstreamUrl: nativeAddress.url,
      toolHeartbeatMs: 20,
      onEvent: (event) => events.push(event),
    });
    const address = await gateway.start();
    try {
      const { tokens } = await grant(gateway.auth);
      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${String(tokens.access_token)}`,
      };
      const initialized = await fetch(address.url + "/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        }),
      });
      const session = initialized.headers.get("mcp-session-id")!;
      await initialized.json();
      const call = {
        jsonrpc: "2.0",
        id: "slow-owned-call",
        method: "tools/call",
        params: {
          name: "codex_exec",
          arguments: { turn_token: token, cmd: "fixture read" },
        },
      };
      const request = () =>
        fetch(address.url + "/mcp", {
          method: "POST",
          headers: {
            ...headers,
            accept: "application/json, text/event-stream",
            "mcp-session-id": session,
          },
          body: JSON.stringify(call),
          signal: AbortSignal.timeout(5000),
        });
      const first = await request();
      assert.match(first.headers.get("content-type")!, /text\/event-stream/u);
      const reader = first.body!.getReader();
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /: keepalive/u,
      );
      const [pending] = await broker.nextBatch(
        token,
        AbortSignal.timeout(3000),
      );
      assert.equal(pending!.arguments.cmd, "fixture read");
      await delay(60);
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /: keepalive/u,
      );
      await reader.cancel();
      const second = await request();
      assert.equal(broker.status().pendingTools, 1);
      broker.complete(token, pending!.callId, {
        content: [{ type: "text", text: "real fixture result\nsecond line" }],
      });
      const text = await second.text();
      const messages = text
        .split(/\n/u)
        .filter((line) => line.startsWith("data: "))
        .map(
          (line) =>
            JSON.parse(line.slice(6)) as {
              id: string;
              result: { content: { text: string }[] };
            },
        );
      assert.equal(messages.length, 1);
      assert.equal(messages[0]!.id, call.id);
      assert.equal(
        messages[0]!.result.content[0]!.text,
        "real fixture result\nsecond line",
      );
      assert.equal(broker.outstanding(token).length, 0);
      assert.ok(
        events.some(
          (event) => event.transport === "sse" && (event.heartbeats ?? 0) > 1,
        ),
      );
    } finally {
      await gateway.close();
      await native.close();
      broker.close();
    }
  },
);
function authQuery(clientId: string): URLSearchParams {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    state: "test-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${publicUrl}/mcp`,
  });
}
async function grant(auth: GeminiMcpAuth) {
  const client = await auth.register({
    redirect_uris: [redirect],
    client_name: "Gemini test",
  });
  const pending = auth.beginAuthorization(
    authQuery(client.client_id as string),
  );
  const callback = new URL(
    auth.approve(pending.ticket, auth.createPairingCode()),
  );
  const request = {
    grant_type: "authorization_code",
    client_id: client.client_id,
    client_secret: client.client_secret,
    code: callback.searchParams.get("code"),
    code_verifier: verifier,
    redirect_uri: redirect,
  };
  const tokens = await auth.token(request);
  return { client, tokens, request };
}

test("OAuth requires local pairing and PKCE; codes cannot be replayed", async () => {
  const auth = new GeminiMcpAuth({ publicBaseUrl: publicUrl });
  const client = await auth.register({
    redirect_uris: [redirect],
    client_name: "<script>untrusted</script>",
  });
  const query = authQuery(client.client_id as string);
  query.set("redirect_uri", "https://attacker.example/callback");
  assert.throws(() => auth.beginAuthorization(query), /not registered/u);
  const pending = auth.beginAuthorization(
    authQuery(client.client_id as string),
  );
  assert.throws(() => auth.approve(pending.ticket, "wrong"), /Pairing code/u);
  const callback = new URL(
    auth.approve(pending.ticket, auth.createPairingCode()),
  );
  assert.equal(callback.searchParams.get("state"), "test-state");
  assert.equal(callback.searchParams.get("iss"), publicUrl);
  const tokenRequest = {
    grant_type: "authorization_code",
    client_id: client.client_id,
    client_secret: client.client_secret,
    code: callback.searchParams.get("code"),
    redirect_uri: redirect,
    code_verifier: verifier,
  };
  await assert.rejects(
    auth.token({ ...tokenRequest, code_verifier: "x".repeat(43) }),
    /Invalid or expired authorization code/u,
  );
  const tokens = await auth.token(tokenRequest);
  assert.equal(
    auth.authenticate(`Bearer ${tokens.access_token as string}`),
    client.client_id,
  );
  await assert.rejects(
    auth.token(tokenRequest),
    /Invalid or expired authorization code/u,
  );
  assert.throws(() => auth.approve(pending.ticket, "anything"), /expired/u);
});

test("refresh rotates, expires and persists only hashes bound to the issuer", async () => {
  let now = 1_000;
  let saved: GeminiMcpCredentialState | undefined;
  const auth = new GeminiMcpAuth({
    publicBaseUrl: publicUrl,
    now: () => now,
    persist: async (state) => {
      saved = state;
    },
  });
  const { client, tokens } = await grant(auth);
  assert.ok(saved);
  const savedState = saved;
  const serialized = JSON.stringify(saved);
  for (const raw of [
    client.client_secret,
    tokens.access_token,
    tokens.refresh_token,
  ])
    assert.ok(!serialized.includes(raw as string));
  const resumed = new GeminiMcpAuth({
    publicBaseUrl: publicUrl,
    credentials: saved,
    now: () => now,
  });
  assert.equal(
    resumed.authenticate(`Bearer ${tokens.access_token as string}`),
    client.client_id,
  );
  assert.throws(
    () =>
      new GeminiMcpAuth({
        publicBaseUrl: "https://other.example.com",
        credentials: savedState,
      }),
    /different issuer/u,
  );
  now += 8 * 60 * 60_000 + 1_000;
  assert.throws(
    () => resumed.authenticate(`Bearer ${tokens.access_token as string}`),
    /Authentication/u,
  );
  const refresh = {
    grant_type: "refresh_token",
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: tokens.refresh_token,
  };
  await assert.rejects(
    resumed.token({ ...refresh, resource: "https://wrong.example/mcp" }),
    /Wrong MCP resource/u,
  );
  const renewed = await resumed.token(refresh);
  await assert.rejects(resumed.token(refresh), /refresh token/u);
  assert.equal(
    resumed.authenticate(`Bearer ${renewed.access_token as string}`),
    client.client_id,
  );
  await resumed.revoke({
    client_id: client.client_id,
    client_secret: client.client_secret,
    token: renewed.access_token,
  });
  assert.throws(
    () => resumed.authenticate(`Bearer ${renewed.access_token as string}`),
    /Authentication/u,
  );
});

test("public registration alone never grants access and rejects insecure callbacks", async () => {
  const auth = new GeminiMcpAuth({ publicBaseUrl: publicUrl });
  for (const bad of [
    "http://127.0.0.1/callback",
    "https://user:password@example.com/callback",
    "https://example.com/#secret",
  ]) {
    await assert.rejects(auth.register({ redirect_uris: [bad] }), /HTTPS/u);
  }
  const client = await auth.register({
    redirect_uris: [redirect],
    token_endpoint_auth_method: "none",
  });
  assert.throws(
    () => auth.authenticate(`Bearer ${client.client_id as string}`),
    /Authentication/u,
  );
  const pending = auth.beginAuthorization(
    authQuery(client.client_id as string),
  );
  auth.createPairingCode();
  assert.throws(() => auth.approve(pending.ticket, ""), /Pairing/u);
});

test(
  "gateway authenticates and isolates sessions while native broker owns execution and replay",
  { timeout: 15_000 },
  async () => {
    const broker = new FullTurnBroker();
    const turnToken = broker.register(
      "gemini-gateway-test",
      [
        {
          kind: "function",
          wireName: "exec_command",
          name: "exec_command",
          description: "Fixture command tool",
          parameters: { type: "object" },
        },
      ],
      true,
    );
    const native = new FullTurnMcpServer(broker);
    const nativeAddress = await native.start();
    const events: unknown[] = [];
    const gateway = new GeminiMcpGateway({
      publicBaseUrl: publicUrl,
      upstreamUrl: nativeAddress.url,
      onEvent: (event) => events.push(event),
    });
    const address = await gateway.start();
    try {
      const denied = await fetch(`${address.url}/mcp`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(denied.status, 401);
      assert.match(
        denied.headers.get("www-authenticate")!,
        /oauth-protected-resource/u,
      );
      assert.equal((await fetch(`${address.url}/admin/command`)).status, 404);
      assert.equal(
        (await fetch(`${address.url}/token?access_token=secret`)).status,
        400,
      );
      const metadata = (await fetch(
        `${address.url}/.well-known/oauth-protected-resource/mcp`,
      ).then((response) => response.json())) as Record<string, unknown>;
      assert.equal(metadata.resource, `${publicUrl}/mcp`);
      const { tokens } = await grant(gateway.auth);
      const request = (
        value: unknown,
        session?: string,
        access = tokens.access_token,
      ) =>
        fetch(`${address.url}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${access as string}`,
            ...(session ? { "Mcp-Session-Id": session } : {}),
          },
          body: JSON.stringify(value),
          signal: AbortSignal.timeout(10_000),
        });
      const initialized = await request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2099-01-01" },
      });
      assert.equal(initialized.status, 200);
      const initialization = (await initialized.json()) as {
        result: { protocolVersion: string };
      };
      assert.equal(initialization.result.protocolVersion, "2025-03-26");
      const session = initialized.headers.get("mcp-session-id")!;
      const second = await grant(gateway.auth);
      assert.equal(
        (
          await request(
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
            session,
            second.tokens.access_token,
          )
        ).status,
        404,
      );
      const listed = (await request(
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        session,
      ).then((response) => response.json())) as {
        result: { tools: { name: string }[] };
      };
      assert.ok(
        listed.result.tools.some(
          (tool) => tool.name === "codex_tool_inventory",
        ),
      );
      const call = {
        jsonrpc: "2.0",
        id: "owned-call",
        method: "tools/call",
        params: {
          name: "codex_exec",
          arguments: { turn_token: turnToken, cmd: "fixture only" },
        },
      };
      const pending = request(call, session);
      const [nativeCall] = await broker.nextBatch(
        turnToken,
        AbortSignal.timeout(5000),
      );
      assert.ok(nativeCall);
      assert.equal(nativeCall.arguments.cmd, "fixture only");
      broker.complete(turnToken, nativeCall.callId, {
        content: [{ type: "text", text: "native lifecycle result" }],
      });
      const result = await (await pending).json();
      assert.deepEqual(
        await request(call, session).then((response) => response.json()),
        result,
      );
      broker.revoke(turnToken);
      const stale = (await request({ ...call, id: "stale-call" }, session).then(
        (response) => response.json(),
      )) as { result: { isError: boolean } };
      assert.equal(stale.result.isError, true);
      assert.ok(!JSON.stringify(events).includes(turnToken));
      assert.ok(
        !JSON.stringify(events).includes(tokens.access_token as string),
      );
      for (const privateValue of [
        session,
        "owned-call",
        "fixture only",
        "native lifecycle result",
      ])
        assert.ok(!JSON.stringify(events).includes(privateValue));
      const calls = events.filter(
        (event) => (event as { toolName?: string }).toolName === "codex_exec",
      ) as {
        rpcMethod: string;
        rpcIdHash: string;
        sessionHash: string;
        elapsedMs: number;
        responseBytes: number;
        completion: string;
      }[];
      assert.ok(calls.length >= 2);
      assert.equal(calls[0]!.rpcMethod, "tools/call");
      assert.equal(calls[0]!.completion, "finished");
      assert.equal(calls[0]!.rpcIdHash, calls[1]!.rpcIdHash);
      assert.match(calls[0]!.sessionHash, /^[a-f0-9]{64}$/u);
      assert.ok(calls[0]!.elapsedMs >= 0 && calls[0]!.responseBytes > 0);
    } finally {
      await gateway.close();
      await native.close();
      broker.close();
    }
  },
);

test("HTTP OAuth protects consent origin and escapes untrusted registration metadata", async () => {
  const gateway = new GeminiMcpGateway({
    publicBaseUrl: publicUrl,
    upstreamUrl: "http://127.0.0.1:9/mcp",
  });
  const address = await gateway.start();
  try {
    const client = (await fetch(`${address.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "<script>bad</script>",
        redirect_uris: [redirect],
      }),
    }).then((response) => response.json())) as Record<string, unknown>;
    const query = authQuery(client.client_id as string);
    const consent = await fetch(`${address.url}/authorize?${query}`);
    assert.equal(consent.headers.get("referrer-policy"), "same-origin");
    assert.equal(
      consent.headers.get("content-security-policy"),
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    const page = await consent.text();
    assert.ok(!page.includes("<script>bad</script>"));
    assert.ok(page.includes("&lt;script&gt;bad&lt;/script&gt;"));
    const ticket = /name="ticket" value="([^"]+)"/u.exec(page)![1]!;
    const pairing = gateway.auth.createPairingCode();
    const form = new URLSearchParams({ ticket, pairing_code: pairing });
    for (const origin of ["null", "https://attacker.example"]) {
      assert.equal(
        (
          await fetch(`${address.url}/authorize`, {
            method: "POST",
            headers: { Origin: origin },
            body: form,
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (await fetch(`${address.url}/authorize`, { method: "POST", body: form }))
        .status,
      403,
    );
    const response = await fetch(`${address.url}/authorize`, {
      method: "POST",
      headers: { Origin: publicUrl },
      body: form,
      redirect: "manual",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const completion = await response.text();
    assert.match(completion, /http-equiv="refresh"/u);
    const callback = /href="([^"]+)"/u
      .exec(completion)![1]!
      .replaceAll("&amp;", "&");
    assert.ok(callback.startsWith(`${redirect}?`));
    const code = new URL(callback).searchParams.get("code")!;
    const token = (await fetch(`${address.url}/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id as string,
        client_secret: client.client_secret as string,
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
      }),
    }).then((result) => result.json())) as Record<string, unknown>;
    assert.equal(typeof token.access_token, "string");
  } finally {
    await gateway.close();
  }
});
