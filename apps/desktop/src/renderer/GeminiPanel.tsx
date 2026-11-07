import type { GeminiStatus, WebProviderStatus } from "../main/preload.cjs";
import type { Translator } from "./i18n.js";

interface Props {
  readonly status: GeminiStatus | undefined;
  readonly busy: boolean;
  readonly t: Translator;
  readonly run: (action: () => Promise<void>) => Promise<void>;
  readonly onChange: (status: GeminiStatus) => void;
  readonly onProviderChange: (status: WebProviderStatus) => void;
  readonly onMessage: (text: string) => void;
}

export function GeminiPanel({
  status,
  busy,
  t,
  run,
  onChange,
  onProviderChange,
  onMessage,
}: Props) {
  if (!status)
    return (
      <section className="card">
        <h2>{t("geminiHeading")}</h2>
        <p>{t("loading")}</p>
      </section>
    );
  const settings = status.settings;
  const blocked = busy || status.busy;
  const save = (
    value: Parameters<typeof window.codexgptBridge.setGeminiSettings>[0],
  ) =>
    void run(async () => {
      onChange(await window.codexgptBridge.setGeminiSettings(value));
      onMessage(t("geminiSaved"));
    });
  return (
    <section className="card providerCard" data-testid="gemini-provider">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow">GEMINI WEB</p>
          <h2>{t("geminiHeading")}</h2>
        </div>
        <span>
          {status.login.verified ? t("geminiLoginVerified") : t("geminiLogin")}
        </span>
      </div>
      <p>{t("geminiHelp")}</p>
      <label className="projectToggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={blocked}
          onChange={(event) => save({ enabled: event.currentTarget.checked })}
        />
        {t("geminiEnable")}
      </label>
      <form
        className="geminiSettings"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          save({
            publicBaseUrl: String(form.get("publicBaseUrl") ?? ""),
            connectorName: String(form.get("connectorName") ?? ""),
            textTimeoutMs: Number(form.get("textTimeoutSeconds")) * 1000,
            toolWaitTimeoutMs: Number(form.get("toolWaitMinutes")) * 60000,
            maxConcurrentTurns: Number(form.get("maxConcurrentTurns")),
          });
        }}
      >
        <label>
          {t("geminiPublicOrigin")}
          <input
            name="publicBaseUrl"
            type="url"
            placeholder="https://gemini-mcp.example.com"
            key={settings.publicBaseUrl ?? ""}
            defaultValue={settings.publicBaseUrl ?? ""}
            disabled={blocked}
          />
        </label>
        <label>
          {t("geminiConnector")}
          <input
            name="connectorName"
            required
            maxLength={120}
            key={settings.connectorName}
            defaultValue={settings.connectorName}
            disabled={blocked}
          />
        </label>
        <label>
          {t("geminiTextTimeout")}
          <input
            name="textTimeoutSeconds"
            type="number"
            min={1}
            max={14400}
            key={settings.textTimeoutMs}
            defaultValue={settings.textTimeoutMs / 1000}
            disabled={blocked}
          />
        </label>
        <label>
          {t("geminiToolTimeout")}
          <input
            name="toolWaitMinutes"
            type="number"
            min={1}
            max={240}
            key={settings.toolWaitTimeoutMs}
            defaultValue={settings.toolWaitTimeoutMs / 60000}
            disabled={blocked}
          />
        </label>
        <label>
          {t("geminiMaxConcurrent")}
          <input
            name="maxConcurrentTurns"
            type="number"
            min={1}
            max={4}
            key={settings.maxConcurrentTurns}
            defaultValue={settings.maxConcurrentTurns}
            disabled={blocked}
          />
        </label>
        <button type="submit" className="secondary" disabled={blocked}>
          {t("saveAdvanced")}
        </button>
      </form>
      <label className="projectToggle">
        <input
          type="checkbox"
          checked={settings.autoApproveToolCalls}
          disabled={blocked}
          onChange={(event) =>
            save({ autoApproveToolCalls: event.currentTarget.checked })
          }
        />
        {t("geminiAutoApprove")}
      </label>
      <label className="projectToggle">
        <input
          type="checkbox"
          checked={settings.simpleTemporaryChat}
          disabled={blocked}
          onChange={(event) =>
            save({ simpleTemporaryChat: event.currentTarget.checked })
          }
        />
        {t("geminiSimpleTemporary")}
      </label>
      <p className="projectHelp">{t("geminiSimpleTemporaryHelp")}</p>
      <label className="projectToggle">
        <input
          type="checkbox"
          checked={settings.notebookMapping}
          disabled={blocked}
          onChange={(event) =>
            save({ notebookMapping: event.currentTarget.checked })
          }
        />
        {t("geminiNotebookMapping")}
      </label>
      <p className="projectHelp">{t("geminiNotebookMappingHelp")}</p>
      <label className="projectToggle">
        <input
          type="checkbox"
          checked={settings.freshConversationPerTurn}
          disabled={blocked}
          onChange={(event) =>
            save({ freshConversationPerTurn: event.currentTarget.checked })
          }
        />
        {t("geminiFreshConversation")}
      </label>
      <p role="status">
        {status.login.phase === "verifying"
          ? t("geminiDiscovering")
          : t("geminiLoginHelp")}
      </p>
      <div className="actions">
        <button
          className="secondary"
          disabled={
            blocked ||
            (status.login.browserHost !== "embedded" &&
              ["waiting", "ready"].includes(status.login.phase)) ||
            status.login.phase === "verifying"
          }
          onClick={() =>
            void run(async () => {
              onChange(await window.codexgptBridge.openGeminiLogin());
              onMessage(t("geminiLoginHelp"));
            })
          }
        >
          {t("geminiLogin")}
        </button>
        <button
          disabled={blocked || status.login.phase !== "ready"}
          onClick={() =>
            void run(async () => {
              onChange(await window.codexgptBridge.continueGeminiLogin());
              onMessage(t("geminiLoginVerified"));
            })
          }
        >
          {t("geminiContinue")}
        </button>
        <button
          className="secondary"
          disabled={blocked || !status.login.verified}
          onClick={() =>
            void run(async () => {
              onChange(await window.codexgptBridge.discoverGemini());
              onMessage(t("geminiSaved"));
            })
          }
        >
          {t("geminiDiscover")}
        </button>
        <button
          disabled={
            blocked || !settings.enabled || !status.capabilities.routes.length
          }
          onClick={() =>
            void run(async () => {
              onProviderChange(
                await window.codexgptBridge.installGeminiModels(),
              );
              onMessage(t("geminiCatalogInstalled"));
            })
          }
        >
          {t("geminiInstall")}
        </button>
        <button
          className="secondary"
          disabled={!status.busy || status.login.phase === "verifying"}
          onClick={() =>
            void run(async () => {
              onChange(await window.codexgptBridge.cancelGemini());
            })
          }
        >
          {t("cancel")}
        </button>
        {status.login.browserHost === "embedded" && (
          <button
            className="secondary"
            disabled={!settings.enabled}
            onClick={() =>
              void run(async () => {
                onChange(await window.codexgptBridge.showGeminiWindow());
              })
            }
          >
            {t("geminiShowWindow")}
          </button>
        )}
      </div>
      <section className="projectSettings">
        <h3>
          {status.mcp.running
            ? t("geminiNativeReady")
            : t("geminiNativeOffline")}
        </h3>
        {status.mcp.url && (
          <p>
            <code>{status.mcp.url}</code>
          </p>
        )}
        <button
          className="secondary"
          disabled={blocked || !status.mcp.running}
          onClick={() =>
            void run(async () => {
              await window.codexgptBridge.copyGeminiPairingCode();
              onMessage(t("geminiPairingCopied"));
            })
          }
        >
          {t("geminiCopyPairing")}
        </button>
        {status.mcp.error && (
          <p className="providerError">{status.mcp.error}</p>
        )}
      </section>
      {status.error && <p className="providerError">{status.error}</p>}
      {status.login.error && (
        <p className="providerError">{status.login.error}</p>
      )}
      <h3>{t("geminiModels", { count: status.capabilities.routes.length })}</h3>
      {!!status.capabilities.routes.length && (
        <div className="geminiModels">
          <table>
            <thead>
              <tr>
                <th>{t("geminiModel")}</th>
                <th>{t("geminiThinking")}</th>
                <th>{t("geminiTransport")}</th>
              </tr>
            </thead>
            <tbody>
              {status.capabilities.routes.map((route) => (
                <tr key={route.slug}>
                  <td>{route.selection.model}</td>
                  <td>{route.selection.thinking ?? "—"}</td>
                  <td>{route.toolMode === "full" ? "Full MCP" : "Simple"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="projectHelp">{t("geminiPendingFeatures")}</p>
    </section>
  );
}
