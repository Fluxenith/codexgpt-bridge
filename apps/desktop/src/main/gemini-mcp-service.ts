import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GeminiMcpGateway,
  type GeminiMcpCredentialState,
  type GeminiMcpGatewayEvent,
} from "@codexgpt-bridge/responses-gateway";
import { writeDurableJson } from "./durable-json.js";
import type { GeminiSettings, GeminiStatus } from "./gemini-types.js";

/** Owns only the public OAuth/MCP ingress; native tools remain task-scoped. */
export class GeminiMcpService {
  #gateway: GeminiMcpGateway | undefined;
  #url: string | undefined;
  #error: string | undefined;
  #events: GeminiMcpGatewayEvent[] = [];
  #save: Promise<void> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly port = 17942,
  ) {}

  status(): GeminiStatus["mcp"] {
    return {
      running: !!this.#gateway,
      ...(this.#url ? { url: this.#url } : {}),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }
  async start(settings: GeminiSettings, upstreamUrl: string): Promise<void> {
    if (!settings.enabled || !settings.publicBaseUrl || this.#gateway) return;
    this.#error = undefined;
    try {
      let file = join(this.directory, "credentials.json");
      let credentials: GeminiMcpCredentialState | undefined;
      try {
        credentials = JSON.parse(
          await readFile(file, "utf8"),
        ) as GeminiMcpCredentialState;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (credentials && credentials.issuer !== settings.publicBaseUrl) {
        file = join(
          this.directory,
          `credentials.${createHash("sha256").update(settings.publicBaseUrl).digest("hex")}.json`,
        );
        try {
          credentials = JSON.parse(
            await readFile(file, "utf8"),
          ) as GeminiMcpCredentialState;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          credentials = undefined;
        }
      }
      const gateway = new GeminiMcpGateway({
        publicBaseUrl: settings.publicBaseUrl,
        upstreamUrl,
        ...(credentials ? { credentials } : {}),
        persist: (state) => writeDurableJson(file, JSON.stringify(state)),
        onEvent: (event) => {
          this.#events.push(event);
          if (this.#events.length > 100) this.#events.shift();
          const text = JSON.stringify({ version: 1, events: this.#events });
          this.#save = this.#save
            .then(() =>
              writeDurableJson(join(this.directory, "diagnostics.json"), text),
            )
            .catch(() => undefined);
        },
      });
      try {
        await gateway.start(this.port);
      } catch (error) {
        await gateway.close().catch(() => undefined);
        throw error;
      }
      this.#gateway = gateway;
      this.#url = `${settings.publicBaseUrl}/mcp`;
    } catch (error) {
      this.#error =
        error instanceof Error ? error.message : "Gemini MCP ingress failed.";
      throw error;
    }
  }
  async pairingCode(): Promise<string> {
    if (!this.#gateway)
      throw new Error("Start the Gemini MCP ingress before pairing.");
    return this.#gateway.auth.createPairingCode();
  }
  async close(): Promise<void> {
    const gateway = this.#gateway;
    this.#gateway = undefined;
    this.#url = undefined;
    await gateway?.close();
    await this.#save;
  }
}
