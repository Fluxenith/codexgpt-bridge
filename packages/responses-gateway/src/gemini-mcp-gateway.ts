import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  GeminiMcpAuth,
  McpAuthError,
  type GeminiMcpAuthOptions,
} from "./gemini-mcp-auth.js";

const MAX_REQUEST = 8 * 1024 * 1024;
const MAX_RESPONSE = 64 * 1024 * 1024;
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST)
      throw new McpAuthError("request_too_large", "Request too large.", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
async function parameters(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  let result: unknown;
  if (type === "application/x-www-form-urlencoded")
    result = Object.fromEntries(new URLSearchParams(body.toString("utf8")));
  else if (type === "application/json") {
    try {
      result = JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      throw new McpAuthError("invalid_request", "Invalid JSON.");
    }
  } else
    throw new McpAuthError(
      "invalid_request",
      "JSON or form body required.",
      415,
    );
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new McpAuthError("invalid_request", "Object body required.");
  const record = result as Record<string, unknown>;
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Basic ")) {
    if (record.client_id !== undefined || record.client_secret !== undefined)
      throw new McpAuthError(
        "invalid_request",
        "Use one client authentication method.",
      );
    const decoded = Buffer.from(authorization.slice(6), "base64").toString(
      "utf8",
    );
    const colon = decoded.indexOf(":");
    if (colon < 0)
      throw new McpAuthError(
        "invalid_client",
        "Invalid Basic credentials.",
        401,
      );
    try {
      record.client_id = decodeURIComponent(decoded.slice(0, colon));
      record.client_secret = decodeURIComponent(decoded.slice(colon + 1));
    } catch {
      throw new McpAuthError(
        "invalid_client",
        "Invalid Basic credentials.",
        401,
      );
    }
  }
  return record;
}
export interface GeminiMcpGatewayEvent {
  method: string;
  path: string;
  status: number;
  at: number;
  elapsedMs: number;
  completion: "finished" | "aborted";
  responseBytes?: number;
  rpcMethod?: string;
  rpcIdHash?: string;
  toolName?: string;
  sessionHash?: string;
  transport?: "json" | "sse";
  heartbeats?: number;
}
export interface GeminiMcpGatewayOptions extends GeminiMcpAuthOptions {
  readonly upstreamUrl: string;
  readonly onEvent?: (event: GeminiMcpGatewayEvent) => void;
  readonly toolHeartbeatMs?: number;
}

/** Only this authenticated, deliberately narrow gateway is published. The
 * native MCP server, Responses gateway and desktop controls stay on loopback. */
export class GeminiMcpGateway {
  readonly auth: GeminiMcpAuth;
  readonly #upstream: string;
  readonly #sessions = new Map<string, string>();
  readonly #onEvent: GeminiMcpGatewayOptions["onEvent"];
  readonly #toolHeartbeatMs: number;
  readonly #requests = new Set<AbortController>();
  readonly #diagnostics = new WeakMap<
    ServerResponse,
    Partial<GeminiMcpGatewayEvent>
  >();
  #server: Server | undefined;
  #rateWindow = 0;
  #registrations = 0;

  constructor(options: GeminiMcpGatewayOptions) {
    this.auth = new GeminiMcpAuth(options);
    const upstream = new URL(options.upstreamUrl);
    if (
      upstream.protocol !== "http:" ||
      upstream.hostname !== "127.0.0.1" ||
      upstream.pathname !== "/mcp" ||
      upstream.username ||
      upstream.password ||
      upstream.search ||
      upstream.hash
    )
      throw new Error("Gemini MCP upstream must be a loopback /mcp endpoint.");
    this.#upstream = upstream.href;
    this.#onEvent = options.onEvent;
    this.#toolHeartbeatMs = options.toolHeartbeatMs ?? 15000;
    if (
      !Number.isSafeInteger(this.#toolHeartbeatMs) ||
      this.#toolHeartbeatMs < 10 ||
      this.#toolHeartbeatMs > 60000
    )
      throw new Error("Invalid Gemini MCP heartbeat interval.");
  }
  async start(
    port = 0,
  ): Promise<{ readonly url: string; readonly port: number }> {
    if (this.#server) throw new Error("Gemini MCP gateway already running.");
    const server = createServer((request, response) => {
      const startedAt = Date.now();
      response.setHeader("X-Content-Type-Options", "nosniff");
      // no-referrer also makes ordinary browser form POSTs send Origin: null,
      // which conflicts with the strict consent-origin check below. Keep the
      // origin for our own form while withholding referrers from OAuth callbacks.
      response.setHeader("Referrer-Policy", "same-origin");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      request.on("error", () => response.destroy());
      response.on("error", () => request.destroy());
      const report = (completion: "finished" | "aborted"): void => {
        this.#onEvent?.({
          method: request.method ?? "",
          path: (request.url ?? "").split("?", 1)[0]!,
          status: response.statusCode,
          at: Date.now(),
          elapsedMs: Date.now() - startedAt,
          completion,
          ...this.#diagnostics.get(response),
        });
      };
      response.once("finish", () => report("finished"));
      response.once("close", () => {
        if (!response.writableFinished) report("aborted");
      });
      void this.#handle(request, response).catch((error: unknown) => {
        if (response.writableEnded || response.destroyed) return;
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const authError =
          error instanceof McpAuthError
            ? error
            : new McpAuthError("server_error", "MCP gateway failed.", 500);
        if (authError.status === 401)
          response.setHeader(
            "WWW-Authenticate",
            `Bearer resource_metadata="${this.auth.issuer}/.well-known/oauth-protected-resource", scope="codex:tools"`,
          );
        send(response, authError.status, {
          error: authError.code,
          error_description: authError.message,
        });
      });
    });
    server.headersTimeout = 15000;
    server.requestTimeout = 30000;
    server.maxHeadersCount = 100;
    server.on("clientError", (_error, socket) => socket.destroy());
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing gateway address.");
      return { url: `http://127.0.0.1:${address.port}`, port: address.port };
    } catch (error) {
      this.#server = undefined;
      server.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const abort of this.#requests) abort.abort();
    this.#requests.clear();
    this.#sessions.clear();
    if (server)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
  }
  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", this.auth.issuer);
    const origin = request.headers.origin;
    if (origin && origin !== this.auth.issuer)
      throw new McpAuthError(
        "invalid_origin",
        "Unexpected browser origin.",
        403,
      );
    const host = request.headers.host;
    const localPort = this.#server?.address();
    const allowedLocal =
      typeof localPort === "object" && localPort
        ? `127.0.0.1:${localPort.port}`
        : "";
    if (host !== new URL(this.auth.issuer).host && host !== allowedLocal)
      throw new McpAuthError("invalid_host", "Unexpected host.", 403);
    if (url.searchParams.has("access_token"))
      throw new McpAuthError(
        "invalid_request",
        "Access tokens are not accepted in URLs.",
      );
    if (
      request.method === "GET" &&
      (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp")
    ) {
      send(response, 200, {
        resource: this.auth.resource,
        authorization_servers: [this.auth.issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: ["codex:tools"],
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      send(response, 200, this.auth.metadata());
      return;
    }
    if (request.method === "POST" && url.pathname === "/register") {
      if (Date.now() - this.#rateWindow > 10 * 60_000) {
        this.#rateWindow = Date.now();
        this.#registrations = 0;
      }
      if (++this.#registrations > 10)
        throw new McpAuthError(
          "registration_limit",
          "Try client registration later.",
          429,
        );
      send(response, 201, await this.auth.register(await parameters(request)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/authorize") {
      const authorization = this.auth.beginAuthorization(url.searchParams);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect Gemini to CodexGPT Bridge</title><h1>Connect Gemini to CodexGPT Bridge</h1><p>Client: ${escapeHtml(authorization.clientName)}</p><p>Return address: ${escapeHtml(authorization.redirect)}</p><p>Codex keeps control of tools, permissions and approvals. Enter the single-use pairing code shown in your local Bridge to authorize this connector.</p><form method="post" action="/authorize"><input type="hidden" name="ticket" value="${escapeHtml(authorization.ticket)}"><label>Bridge pairing code <input name="pairing_code" type="password" autocomplete="off" required></label><button type="submit">Authorize connector</button></form></html>`,
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/authorize") {
      // A same-origin browser form and the unguessable single-use local pairing
      // code are both required. Remote registration itself grants no access.
      if (origin !== this.auth.issuer)
        throw new McpAuthError(
          "invalid_origin",
          "Same-origin authorization form required.",
          403,
        );
      const body = await parameters(request);
      if (
        typeof body.ticket !== "string" ||
        typeof body.pairing_code !== "string"
      )
        throw new McpAuthError("invalid_request", "Pairing code required.");
      const redirect = this.auth.approve(body.ticket, body.pairing_code);
      // End the form submission before navigating to the registered callback.
      // Chromium applies form-action to the entire HTTP redirect chain, which
      // otherwise blocks Google's relay and its subsequent return to Gemini.
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
      });
      response.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(redirect)}"><title>Return to Gemini</title><h1>Connector authorized</h1><p><a href="${escapeHtml(redirect)}" rel="noreferrer">Continue to Gemini</a></p></html>`,
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      send(response, 200, await this.auth.token(await parameters(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/revoke") {
      await this.auth.revoke(await parameters(request));
      send(response, 200, {});
      return;
    }
    if (url.pathname !== "/mcp") {
      send(response, 404, { error: "not_found" });
      return;
    }
    const clientId = this.auth.authenticate(request.headers.authorization);
    if (!["GET", "POST", "DELETE"].includes(request.method ?? "")) {
      send(response, 405, { error: "method_not_allowed" });
      return;
    }
    const sessionId = request.headers["mcp-session-id"];
    // After a restart the map is empty; let the authenticated connector keep
    // its old id (the upstream resumes it) rather than 404 into a failing
    // Gemini recovery. An id already bound to another connector stays refused.
    if (
      typeof sessionId === "string" &&
      sessionId.length <= 100 &&
      !this.#sessions.has(sessionId) &&
      this.#sessions.size < 1000
    )
      this.#sessions.set(sessionId, clientId);
    if (
      sessionId !== undefined &&
      (typeof sessionId !== "string" ||
        this.#sessions.get(sessionId) !== clientId)
    )
      throw new McpAuthError(
        "session_not_found",
        "MCP session does not belong to this connector.",
        404,
      );
    const body =
      request.method === "POST" ? await readBody(request) : undefined;
    // Log identities and transport progress only: never arguments, tokens,
    // session capabilities, OAuth parameters or tool output.
    const diagnostics: Partial<GeminiMcpGatewayEvent> = {};
    let rpcId: string | number | undefined;
    if (typeof sessionId === "string")
      diagnostics.sessionHash = createHash("sha256")
        .update(sessionId)
        .digest("hex");
    if (body) {
      try {
        const rpc = JSON.parse(body.toString("utf8")) as Record<
          string,
          unknown
        >;
        if (
          typeof rpc.method === "string" &&
          /^(?:initialize|notifications\/[a-z_]+|tools\/(?:list|call)|ping)$/u.test(
            rpc.method,
          )
        )
          diagnostics.rpcMethod = rpc.method;
        if (typeof rpc.id === "string" || typeof rpc.id === "number") {
          if (rpc.jsonrpc === "2.0") rpcId = rpc.id;
          diagnostics.rpcIdHash = createHash("sha256")
            .update(JSON.stringify(rpc.id))
            .digest("hex");
        }
        const params = rpc.params as { name?: unknown } | undefined;
        if (
          rpc.method === "tools/call" &&
          typeof params?.name === "string" &&
          /^codex_(?:exec|write_stdin|apply_patch|view_image|tool_inventory|tool_call|manual_complete|wait_tool_result)$/u.test(
            params.name,
          )
        )
          diagnostics.toolName = params.name;
      } catch {
        /* The upstream retains MCP JSON validation. */
      }
    }
    this.#diagnostics.set(response, diagnostics);
    if (request.method === "POST" && sessionId === undefined) {
      let rpc: unknown;
      try {
        rpc = JSON.parse(body!.toString("utf8")) as unknown;
      } catch {
        throw new McpAuthError("invalid_request", "Invalid MCP JSON.");
      }
      if (
        !rpc ||
        typeof rpc !== "object" ||
        (rpc as Record<string, unknown>).method !== "initialize"
      )
        throw new McpAuthError(
          "session_required",
          "Initialize a connector session first.",
          400,
        );
    }
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "x-bridge-tool-wait-ms": "20000",
    };
    for (const name of [
      "content-type",
      "mcp-session-id",
      "mcp-protocol-version",
      "last-event-id",
    ]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const abort = new AbortController();
    this.#requests.add(abort);
    const cancel = () => {
      if (!response.writableFinished) abort.abort();
    };
    response.once("close", cancel);
    // Flush a real Streamable HTTP response before waiting for Codex. A cold
    // native sandbox can take longer than the public proxy's read timeout.
    // SSE comments carry no tool result, capability or execution instruction.
    const streaming =
      diagnostics.rpcMethod === "tools/call" &&
      rpcId !== undefined &&
      typeof sessionId === "string" &&
      request.headers.accept
        ?.split(",")
        .some(
          (value) => value.trim().split(";", 1)[0] === "text/event-stream",
        ) === true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    diagnostics.transport = streaming ? "sse" : "json";
    if (streaming) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      const keepAlive = () => {
        if (
          !response.destroyed &&
          !response.writableEnded &&
          !response.writableNeedDrain
        ) {
          response.write(": keepalive\n\n");
          diagnostics.heartbeats = (diagnostics.heartbeats ?? 0) + 1;
        }
      };
      keepAlive();
      heartbeat = setInterval(keepAlive, this.#toolHeartbeatMs);
      heartbeat.unref();
    }
    try {
      const upstream = await fetch(this.#upstream, {
        method: request.method!,
        headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
        signal: abort.signal,
        redirect: "error",
      });
      const assignedSession = upstream.headers.get("mcp-session-id");
      if (assignedSession && upstream.ok) {
        if (this.#sessions.size >= 1000)
          throw new McpAuthError(
            "session_limit",
            "Too many MCP sessions.",
            429,
          );
        this.#sessions.set(assignedSession, clientId);
        if (!response.headersSent)
          response.setHeader("Mcp-Session-Id", assignedSession);
      }
      if (streaming) {
        if (!upstream.ok) throw new Error("Native MCP rejected this request.");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (upstream.body)
          for await (const chunk of upstream.body) {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE)
              throw new Error("MCP response exceeded maximum size.");
            chunks.push(chunk);
          }
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          jsonrpc?: unknown;
          id?: unknown;
        };
        if (result.jsonrpc !== "2.0" || result.id !== rpcId)
          throw new Error("Native MCP response did not match this request.");
        diagnostics.responseBytes = bytes;
        response.end(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
        return;
      }
      response.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      });
      let bytes = 0;
      if (upstream.body)
        for await (const chunk of upstream.body) {
          bytes += chunk.length;
          diagnostics.responseBytes = bytes;
          if (bytes > MAX_RESPONSE) {
            abort.abort();
            throw new Error("MCP response exceeded maximum size.");
          }
          if (!response.write(chunk))
            await once(response, "drain", { signal: abort.signal });
        }
      response.end();
      if (
        request.method === "DELETE" &&
        typeof sessionId === "string" &&
        upstream.ok
      )
        this.#sessions.delete(sessionId);
    } catch (error) {
      if (!streaming || response.destroyed || response.writableEnded)
        throw error;
      response.end(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpcId, error: { code: -32000, message: "MCP transport failed. Retry only with the same request ID; do not repeat the tool as a new operation." } })}\n\n`,
      );
    } finally {
      clearInterval(heartbeat);
      response.off("close", cancel);
      this.#requests.delete(abort);
    }
  }
}
