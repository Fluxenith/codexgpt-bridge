import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const secret = () => randomBytes(32).toString("base64url");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const equal = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
type RecordValue = Record<string, unknown>;
/** Gemini reuses cached connector tokens without refreshing them, so a short
 * lifetime leaves a turn stuck on 401. Each tool call still needs its own task token. */
const ACCESS_TOKEN_MS = 8 * 60 * 60_000;

export function mcpAuthRecord(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new McpAuthError("invalid_request", "Expected an object.");
  return value as RecordValue;
}
function required(value: unknown, name: string, max = 2048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new McpAuthError("invalid_request", `Invalid ${name}.`);
  return value;
}
function httpsUrl(value: unknown): string {
  const raw = required(value, "redirect_uri");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpAuthError("invalid_redirect_uri", "Invalid redirect URI.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new McpAuthError(
      "invalid_redirect_uri",
      "Redirect URI must use HTTPS without credentials or fragment.",
    );
  return raw;
}

export class McpAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
interface Client {
  readonly id: string;
  readonly secretHash: string;
  readonly redirects: readonly string[];
  readonly name: string;
  readonly createdAt: number;
  readonly method: "client_secret_post" | "client_secret_basic" | "none";
}
interface Authorization {
  readonly clientId: string;
  readonly redirect: string;
  readonly state: string;
  readonly challenge: string;
  readonly expiresAt: number;
}
interface Grant extends Omit<Authorization, "state"> {
  readonly codeHash: string;
}
interface Token {
  readonly clientId: string;
  readonly expiresAt: number;
}
export interface GeminiMcpCredentialState {
  readonly version: 1;
  readonly issuer: string;
  readonly clients: readonly Client[];
  readonly access: readonly (Token & { readonly hash: string })[];
  readonly refresh: readonly (Token & { readonly hash: string })[];
}
export interface GeminiMcpAuthOptions {
  readonly publicBaseUrl: string;
  readonly now?: () => number;
  readonly credentials?: GeminiMcpCredentialState;
  readonly persist?: (state: GeminiMcpCredentialState) => Promise<void>;
}

/** OAuth credentials authenticate the connector. FullTurnBroker separately
 * validates every turn token and the exact tools granted by native Codex. */
export class GeminiMcpAuth {
  readonly issuer: string;
  readonly resource: string;
  readonly #now: () => number;
  readonly #persist: GeminiMcpAuthOptions["persist"];
  readonly #clients = new Map<string, Client>();
  readonly #pending = new Map<string, Authorization>();
  readonly #codes = new Map<string, Grant>();
  readonly #access = new Map<string, Token>();
  readonly #refresh = new Map<string, Token>();
  #pairing: { hash: string; expiresAt: number } | undefined;
  #saveTail: Promise<void> = Promise.resolve();

  constructor(options: GeminiMcpAuthOptions) {
    const url = new URL(options.publicBaseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Gemini MCP public URL must be an HTTPS origin.");
    this.issuer = url.origin;
    this.resource = `${this.issuer}/mcp`;
    this.#now = options.now ?? Date.now;
    this.#persist = options.persist;
    if (options.credentials) {
      const state = options.credentials;
      if (state.version !== 1 || state.issuer !== this.issuer)
        throw new Error("Gemini MCP credentials belong to a different issuer.");
      for (const client of state.clients) {
        required(client.id, "client id", 128);
        if (
          !/^[a-f0-9]{64}$/u.test(client.secretHash) ||
          !Array.isArray(client.redirects) ||
          !["client_secret_post", "client_secret_basic", "none"].includes(
            client.method,
          )
        )
          throw new Error("Invalid saved Gemini MCP client.");
        client.redirects.forEach(httpsUrl);
        this.#clients.set(client.id, client);
      }
      for (const [entries, target] of [
        [state.access, this.#access],
        [state.refresh, this.#refresh],
      ] as const)
        for (const token of entries) {
          if (
            !/^[a-f0-9]{64}$/u.test(token.hash) ||
            !this.#clients.has(token.clientId) ||
            !Number.isFinite(token.expiresAt)
          )
            throw new Error("Invalid saved Gemini MCP token.");
          if (token.expiresAt > this.#now())
            target.set(token.hash, {
              clientId: token.clientId,
              expiresAt: token.expiresAt,
            });
        }
    }
  }

  #snapshot(): GeminiMcpCredentialState {
    return {
      version: 1,
      issuer: this.issuer,
      clients: [...this.#clients.values()],
      access: [...this.#access].map(([digest, token]) => ({
        ...token,
        hash: digest,
      })),
      refresh: [...this.#refresh].map(([digest, token]) => ({
        ...token,
        hash: digest,
      })),
    };
  }
  async #save(): Promise<void> {
    const snapshot = this.#snapshot();
    const save = this.#saveTail.then(() => this.#persist?.(snapshot));
    this.#saveTail = save.catch(() => {});
    await save;
  }
  #prune(): void {
    for (const map of [this.#pending, this.#codes, this.#access, this.#refresh])
      for (const [key, value] of map)
        if (value.expiresAt <= this.#now()) map.delete(key);
  }
  /** Call only from the local trusted UI/CLI, never from a public route. */
  createPairingCode(): string {
    const code = secret();
    this.#pairing = { hash: hash(code), expiresAt: this.#now() + 10 * 60_000 };
    return code;
  }
  metadata(): RecordValue {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      revocation_endpoint: `${this.issuer}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
        "none",
      ],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["codex:tools"],
    };
  }
  async register(input: unknown): Promise<RecordValue> {
    this.#prune();
    // Public registration can never authorize tools. It is bounded separately
    // from the local single-use pairing approval.
    if (this.#clients.size >= 100)
      throw new McpAuthError(
        "registration_limit",
        "Client registration limit reached.",
        429,
      );
    const body = mcpAuthRecord(input);
    if (
      !Array.isArray(body.redirect_uris) ||
      body.redirect_uris.length < 1 ||
      body.redirect_uris.length > 8
    )
      throw new McpAuthError(
        "invalid_redirect_uri",
        "One to eight redirect URIs are required.",
      );
    const redirects = body.redirect_uris.map(httpsUrl);
    const method = body.token_endpoint_auth_method ?? "client_secret_post";
    if (
      method !== "client_secret_post" &&
      method !== "client_secret_basic" &&
      method !== "none"
    )
      throw new McpAuthError(
        "invalid_client_metadata",
        "Unsupported token endpoint authentication method.",
      );
    const id = secret();
    const clientSecret = secret();
    const client: Client = {
      id,
      secretHash: hash(clientSecret),
      redirects,
      name:
        typeof body.client_name === "string"
          ? body.client_name.slice(0, 200)
          : "Gemini MCP connector",
      createdAt: this.#now(),
      method,
    };
    this.#clients.set(id, client);
    try {
      await this.#save();
    } catch (error) {
      this.#clients.delete(id);
      throw error;
    }
    return {
      client_id: id,
      ...(method === "none" ? {} : { client_secret: clientSecret }),
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_secret_expires_at: 0,
      redirect_uris: redirects,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }
  beginAuthorization(query: URLSearchParams): {
    ticket: string;
    clientName: string;
    redirect: string;
  } {
    this.#prune();
    if (this.#pending.size >= 100)
      throw new McpAuthError(
        "request_limit",
        "Too many pending authorizations.",
        429,
      );
    const client = this.#clients.get(
      required(query.get("client_id"), "client_id"),
    );
    if (!client) throw new McpAuthError("invalid_client", "Unknown client.");
    const redirect = required(query.get("redirect_uri"), "redirect_uri");
    if (!client.redirects.includes(redirect))
      throw new McpAuthError(
        "invalid_redirect_uri",
        "Redirect URI was not registered.",
      );
    if (
      query.get("response_type") !== "code" ||
      query.get("code_challenge_method") !== "S256"
    )
      throw new McpAuthError(
        "invalid_request",
        "Authorization code with PKCE S256 is required.",
      );
    const challenge = required(
      query.get("code_challenge"),
      "code_challenge",
      43,
    );
    if (!/^[A-Za-z0-9_-]{43}$/u.test(challenge))
      throw new McpAuthError("invalid_request", "Invalid PKCE challenge.");
    const resource = query.get("resource");
    if (resource !== null && resource !== this.resource)
      throw new McpAuthError("invalid_target", "Wrong MCP resource.");
    const scope = query.get("scope");
    if (
      scope &&
      scope
        .split(" ")
        .some((item) => item !== "codex:tools" && item !== "offline_access")
    )
      throw new McpAuthError("invalid_scope", "Unsupported scope.");
    const ticket = secret();
    this.#pending.set(hash(ticket), {
      clientId: client.id,
      redirect,
      state: required(query.get("state"), "state"),
      challenge,
      expiresAt: this.#now() + 5 * 60_000,
    });
    return { ticket, clientName: client.name, redirect };
  }
  approve(ticket: string, pairingCode: string): string {
    this.#prune();
    const request = this.#pending.get(hash(ticket));
    if (!request)
      throw new McpAuthError(
        "invalid_request",
        "Authorization request expired.",
      );
    if (
      !this.#pairing ||
      this.#pairing.expiresAt <= this.#now() ||
      !equal(this.#pairing.hash, hash(pairingCode))
    )
      throw new McpAuthError(
        "access_denied",
        "Pairing code is invalid or expired.",
        403,
      );
    this.#pairing = undefined;
    this.#pending.delete(hash(ticket));
    const code = secret();
    this.#codes.set(hash(code), {
      ...request,
      codeHash: hash(code),
      expiresAt: this.#now() + 60_000,
    });
    const redirect = new URL(request.redirect);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", request.state);
    redirect.searchParams.set("iss", this.issuer);
    return redirect.href;
  }
  #client(input: RecordValue): Client {
    const client = this.#clients.get(required(input.client_id, "client_id"));
    if (
      !client ||
      (client.method !== "none" &&
        (typeof input.client_secret !== "string" ||
          !equal(client.secretHash, hash(input.client_secret))))
    )
      throw new McpAuthError(
        "invalid_client",
        "Invalid client credentials.",
        401,
      );
    return client;
  }
  async token(input: unknown): Promise<RecordValue> {
    this.#prune();
    const body = mcpAuthRecord(input);
    const client = this.#client(body);
    if (body.resource !== undefined && body.resource !== this.resource)
      throw new McpAuthError("invalid_target", "Wrong MCP resource.");
    if (body.grant_type === "authorization_code") {
      const digest = hash(required(body.code, "code"));
      const grant = this.#codes.get(digest);
      const verifier = required(body.code_verifier, "code_verifier", 128);
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      if (
        !grant ||
        grant.clientId !== client.id ||
        grant.redirect !== body.redirect_uri ||
        !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) ||
        !equal(grant.challenge, challenge)
      )
        throw new McpAuthError(
          "invalid_grant",
          "Invalid or expired authorization code.",
        );
      this.#codes.delete(digest);
    } else if (body.grant_type === "refresh_token") {
      const digest = hash(required(body.refresh_token, "refresh_token"));
      const grant = this.#refresh.get(digest);
      if (!grant || grant.clientId !== client.id)
        throw new McpAuthError(
          "invalid_grant",
          "Invalid or expired refresh token.",
        );
      this.#refresh.delete(digest);
    } else
      throw new McpAuthError(
        "unsupported_grant_type",
        "Unsupported grant type.",
      );
    const accessToken = secret();
    const refreshToken = secret();
    this.#access.set(hash(accessToken), {
      clientId: client.id,
      expiresAt: this.#now() + ACCESS_TOKEN_MS,
    });
    this.#refresh.set(hash(refreshToken), {
      clientId: client.id,
      expiresAt: this.#now() + 30 * 24 * 60 * 60_000,
    });
    try {
      await this.#save();
    } catch (error) {
      this.#access.delete(hash(accessToken));
      this.#refresh.delete(hash(refreshToken));
      throw error;
    }
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_MS / 1000,
      refresh_token: refreshToken,
      scope: "codex:tools",
    };
  }
  authenticate(header: string | undefined): string {
    this.#prune();
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header ?? "");
    const token = match ? this.#access.get(hash(match[1]!)) : undefined;
    if (!token)
      throw new McpAuthError("invalid_token", "Authentication required.", 401);
    return token.clientId;
  }
  async revoke(input: unknown): Promise<void> {
    const body = mcpAuthRecord(input);
    const client = this.#client(body);
    const digest = hash(required(body.token, "token"));
    for (const map of [this.#access, this.#refresh])
      if (map.get(digest)?.clientId === client.id) map.delete(digest);
    await this.#save();
  }
}
