import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

const profile = await mkdtemp(join(tmpdir(), "bridge-connector-e2e-"));
let scenario = "normal";
const visits = [];
const server = createServer((req, res) => {
  if (req.url === "/api/auth/session") {
    res.setHeader("content-type", "application/json");
    res.end('{"user":{"id":"connector-fixture"}}');
    return;
  }
  const temporary = req.url.includes("temporary-chat=true");
  visits.push(req.url);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><header>${temporary ? '<button aria-label="Turn off temporary chat">Temporary chat</button>' : ""}</header>
    <main><form onsubmit="return false"><div data-composer-markdown contenteditable="true" style="width:600px;min-height:40px"></div>
    <button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu">High</button>
    <button type="button" data-testid="send-button">Send</button></form><div id="messages"></div></main>
    <script>
      window.sends=0;window.activations=0;window.nonAppClicks=0;
      const composer=document.querySelector('[data-composer-markdown]');
      const clearMenu=()=>document.querySelector('[data-connector-menu]')?.remove();
      document.addEventListener('keydown',e=>{if(e.key==='Escape')clearMenu();});
      composer.addEventListener('input',()=>{
        clearMenu();if(!composer.textContent.startsWith('@'))return;
        const menu=document.createElement('div');menu.dataset.connectorMenu='true';
        const file=document.createElement('button');file.textContent='project-plan.md';file.onclick=()=>window.nonAppClicks++;menu.append(file);
        if(!${temporary && scenario === "temporary-filtered"})for(let i=0;i<${scenario === "duplicate" ? 2 : 1};i++){
          const row=document.createElement('button');row.innerHTML='<span>CodexGPT Bridge</span><span>Use local tools</span>';
          row.onclick=()=>{window.activations++;composer.innerHTML='<span app-mention-name="bridge" app-mention-display-name="CodexGPT Bridge" app-mention-path="app://bridge-fixture" contenteditable="false">CodexGPT Bridge</span> ';clearMenu();};menu.append(row);
        }
        document.body.append(menu);
      });
      document.querySelector('[data-testid="send-button"]').onclick=()=>{
        window.sends++;const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=composer.textContent;composer.textContent='';
        const reply=document.createElement('div');reply.dataset.testid='conversation-turn-'+window.sends;reply.innerHTML='<div data-message-author-role="assistant">CONNECTOR_OK</div><button aria-label="Open tool call list">Called tool</button><button data-testid="copy-turn-button">Copy</button>';document.querySelector('#messages').append(user,reply);
      };
    </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: profile },
  });
  for (const [name, temporary, expected] of [
    ["temporary-filtered", true, "full-mcp-temporary-connector-unavailable"],
    ["normal", false, undefined],
    ["temporary-available", true, undefined],
    ["duplicate", false, "full-mcp-connector-unavailable"],
  ]) {
    scenario = name;
    visits.length = 0;
    const result = await app.evaluate(
      async ({ BrowserWindow }, { baseUrl, name, temporary }) => {
        const traces = [];
        const controller = new globalThis.ChatGptBrowserController(
          baseUrl,
          undefined,
          undefined,
          async (trace) => traces.push(trace),
        );
        let error, code, output;
        try {
          output = await controller.runTurn({
            mode: "high",
            prompt: "connector fixture",
            images: [],
            allowWebNativeTools: true,
            connectorName: "CodexGPT Bridge",
            temporaryChat: temporary,
            threadId: name,
            turnId: name,
            operationId: name,
            signal: globalThis.AbortSignal.timeout(45000),
          });
        } catch (caught) {
          error = caught.message;
          code = caught.diagnosticCode;
        }
        const window = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith(baseUrl),
        );
        const state = await window.webContents.executeJavaScript(
          `({sends:window.sends,activations:window.activations,nonAppClicks:window.nonAppClicks,text:document.querySelector('[data-composer-markdown]').textContent,selections:document.querySelectorAll('[app-mention-path]').length})`,
        );
        await controller.close();
        return { error, code, output, state, traces };
      },
      { baseUrl, name, temporary },
    );
    process.stdout.write(
      JSON.stringify({
        name,
        code: result.code,
        output: result.output,
        state: result.state,
        visits: visits.length,
      }) + "\n",
    );
    assert.equal(result.code, expected, result.error);
    assert.equal(result.state.nonAppClicks, 0);
    if (expected) {
      assert.equal(result.state.sends, 0);
      assert.equal(result.state.activations, 0);
      assert.equal(result.state.text, "");
      assert.equal(result.state.selections, 0);
      if (temporary) {
        assert.equal(
          visits.length,
          1,
          "A filtered Temporary App must not reload or fall back to normal chat",
        );
        assert.match(result.error, /Temporary Chat/);
        assert.doesNotMatch(result.error, /Create or enable/);
        assert.equal(result.traces.at(-1).failure.code, expected);
      }
    } else {
      assert.equal(result.output, "CONNECTOR_OK");
      assert.equal(result.state.sends, 1);
      assert.equal(result.state.activations, 1);
    }
  }
  process.stdout.write(
    "Connector E2E passed: modern App rows, Temporary filtering, supported Temporary Apps, duplicate rejection, no wrong-row clicks or failed sends.\n",
  );
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
