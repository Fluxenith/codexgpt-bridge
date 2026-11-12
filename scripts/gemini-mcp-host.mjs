import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  FullTurnBroker,
  FullTurnMcpServer,
  GeminiMcpGateway,
} from "../packages/responses-gateway/dist/index.js";

const { values } = parseArgs({
  options: {
    "public-url": { type: "string" },
    upstream: { type: "string" },
    port: { type: "string", default: "17942" },
    "data-dir": {
      type: "string",
      default: join(homedir(), ".codexgpt-bridge", "gemini-mcp"),
    },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !values["public-url"]) {
  process.stdout.write(
    "Gemini authenticated MCP ingress.\nUsage: pnpm gemini:mcp:host --public-url https://your-hostname\nDefault is a disposable read-only probe, without workspace tools.\nFor the full native broker, explicitly supply --upstream http://127.0.0.1:<port>/mcp.\nOptions: --port 17942 --data-dir <private-directory>\nPublish only this ingress port. Pairing code and probe prompt are saved locally, never printed.\n",
  );
} else {
  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid ingress port.");
  const data = resolve(values["data-dir"]);
  await mkdir(data, { recursive: true, mode: 0o700 });
  const store = join(data, "credentials.json");
  let credentials;
  try {
    credentials = JSON.parse(await readFile(store, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const broker = new FullTurnBroker();
  let native;
  let upstreamUrl = values.upstream;
  let turnToken;
  let stopped = false;
  if (!upstreamUrl) {
    native = new FullTurnMcpServer(broker);
    upstreamUrl = (await native.start()).url;
    turnToken = broker.register(
      `gemini-mcp-probe-${randomUUID()}`,
      [
        {
          kind: "function",
          wireName: "bridge_probe",
          name: "bridge_probe",
          description:
            "Return a unique readiness marker. Read-only test; no filesystem or command access.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      false,
    );
    const expected = `GEMINI_MCP_READY_${randomUUID()}`;
    await writeFile(
      join(data, "probe-prompt.txt"),
      `Use the connected custom MCP app at ${values["public-url"]}/mcp (Google may display its domain as the app name). First call codex_tool_inventory with turn_token ${turnToken} and query bridge_probe. Then call codex_tool_call with the same turn_token, wire_name bridge_probe, and arguments {}. Return the exact readiness marker from the tool result. Do not simulate any call.`,
      { mode: 0o600 },
    );
    await writeFile(
      join(data, "probe-session.json"),
      JSON.stringify({ mode: "read-only-probe", expected, executed: false }),
      { mode: 0o600 },
    );
    void (async () => {
      while (!stopped) {
        const batch = await broker.nextBatch(turnToken);
        for (const request of batch) {
          if (request.wireName !== "bridge_probe")
            throw new Error("Unexpected probe tool.");
          broker.complete(turnToken, request.callId, {
            content: [{ type: "text", text: expected }],
          });
          await writeFile(
            join(data, "probe-session.json"),
            JSON.stringify({
              mode: "read-only-probe",
              expected,
              executed: true,
              at: new Date().toISOString(),
            }),
            { mode: 0o600 },
          );
        }
      }
    })().catch((error) => {
      if (!stopped) process.stderr.write(`Probe broker: ${error.message}\n`);
    });
  }
  const gateway = new GeminiMcpGateway({
    publicBaseUrl: values["public-url"],
    upstreamUrl,
    ...(credentials ? { credentials } : {}),
    persist: async (state) => {
      const temporary = `${store}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, store);
    },
    onEvent: (event) => {
      void appendFile(
        join(data, "events.jsonl"),
        `${JSON.stringify(event)}\n`,
        { mode: 0o600 },
      ).catch(() => {});
    },
  });
  try {
    const address = await gateway.start(port);
    await writeFile(
      join(data, "pairing-code.txt"),
      gateway.auth.createPairingCode(),
      { mode: 0o600 },
    );
    await writeFile(
      join(data, "status.json"),
      JSON.stringify({
        mode: values.upstream ? "native-broker" : "read-only-probe",
        localUrl: address.url,
        publicUrl: gateway.auth.resource,
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    process.stdout.write(
      `Gemini MCP ingress ready on ${address.url}; mode=${values.upstream ? "native-broker" : "read-only-probe"}.\nPrivate pairing code${values.upstream ? "" : " and probe prompt"} saved in ${data}.\n`,
    );
    const stop = () => {
      stopped = true;
      broker.close();
      void gateway.close().finally(() => native?.close());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    stopped = true;
    broker.close();
    await gateway.close();
    await native?.close();
    throw error;
  }
}
