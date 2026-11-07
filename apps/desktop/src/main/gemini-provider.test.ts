import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  ResponsesGateway,
  WebProviderRegistry,
} from "@codexgpt-bridge/responses-gateway";
import { GeminiBrowserProvider } from "./gemini-browser.js";
import { GeminiMcpService } from "./gemini-mcp-service.js";
import { DEFAULT_GEMINI_SETTINGS } from "./gemini-settings.js";
import { stat } from "node:fs/promises";

it("isolates invalid Gemini state from the existing ChatGPT gateway without opening Chrome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-gemini-isolation-"));
  const state = join(directory, "state");
  await mkdir(state);
  await writeFile(
    join(state, "settings.json"),
    JSON.stringify({ version: 99 }),
  );
  const gemini = new GeminiBrowserProvider(state, join(directory, "chrome"));
  const registry = new WebProviderRegistry([gemini]);
  const gateway = new ResponsesGateway({
    port: 0,
    providers: registry,
    runWebTurn: async () => "<codex_text>CHATGPT_STILL_AVAILABLE</codex_text>",
  });
  try {
    assert.deepEqual(await registry.routes(), []);
    assert.equal((await gemini.status()).login.verified, false);
    assert.match((await gemini.status()).error!, /version/u);
    const address = await gateway.start();
    const response = await fetch(address.baseUrl + "/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer fixture",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "codexgpt-bridge/high", input: "Hello" }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /CHATGPT_STILL_AVAILABLE/u);
  } finally {
    await gateway.close();
    await registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports an occupied Gemini ingress port without claiming a connection or leaking a pairing code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-gemini-ingress-"));
  const occupied = createServer();
  await new Promise<void>((done) => occupied.listen(0, "127.0.0.1", done));
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  const service = new GeminiMcpService(directory, address.port);
  try {
    await assert.rejects(
      service.start(
        {
          ...DEFAULT_GEMINI_SETTINGS,
          enabled: true,
          publicBaseUrl: "https://gemini-mcp.example.com",
        },
        "http://127.0.0.1:12345/mcp",
      ),
      /EADDRINUSE/u,
    );
    assert.equal(service.status().running, false);
    await assert.rejects(service.pairingCode(), /before pairing/u);
  } finally {
    await service.close();
    await new Promise<void>((done) => occupied.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
it("rejects Full MCP probes without configured transport or an observed selection before launching Chrome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-gemini-probe-"));
  const profile = join(directory, "chrome");
  const provider = new GeminiBrowserProvider(join(directory, "state"), profile);
  try {
    await provider.configure({ enabled: true });
    await assert.rejects(
      provider.verifyFullRoute("gemini-web/unknown/low/simple"),
      (error: { code?: string }) =>
        error.code === "bridge_full_mcp_unavailable",
    );
    await provider.configure({
      publicBaseUrl: "https://gemini-mcp.example.com",
    });
    await assert.rejects(
      provider.verifyFullRoute("gemini-web/unknown/low/simple"),
      (error: { code?: string }) => error.code === "model_unavailable",
    );
    await assert.rejects(
      stat(profile),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
