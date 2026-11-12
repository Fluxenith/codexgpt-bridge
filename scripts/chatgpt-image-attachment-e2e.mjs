import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { _electron as electron } from "playwright-core";

function fixture(kind) {
  return `<!doctype html><main><form onsubmit="return false">
    <div id="prompt-textarea" contenteditable="true" style="width:500px;min-height:30px"></div>
    <input type="file" accept="image/*" multiple hidden>
    <button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu">High</button>
    <button type="button" data-testid="send-button">Send</button>
    </form><div id="messages"></div></main><script>
    const kind = ${JSON.stringify(kind)};
    const form = document.querySelector('form');
    const send = document.querySelector('[data-testid="send-button"]');
    window.sends = 0; window.uploads = []; window.unsafeSends = 0;
    document.querySelector('input').onchange = event => {
      const files = [...event.target.files];
      window.uploads.push(files.map(f => f.name));
      for (const file of files) {
        const card = document.createElement('div');
        card.className = 'composer-attachment-surface'; card.role = 'button';
        card.style.cssText = 'display:inline-block;width:120px;height:120px';
        card.setAttribute('aria-label', file.name);
        const busy = document.createElement('span'); busy.role = 'progressbar'; busy.textContent = 'Uploading';
        card.append(busy); form.append(card);
        setTimeout(() => {
          const name = kind === 'wrong-name' ? 'unrelated.png'
            : kind === 'invalid-suffix' ? file.name.replace('.png', '(backup).png')
            : kind === 'plain' ? file.name : file.name.replace('.png', '(12).png');
          card.setAttribute('aria-label', name);
          if (kind !== 'uploading') busy.remove();
        }, 350);
      }
      send.disabled = true;
      if (kind !== 'disabled') setTimeout(() => { send.disabled = false; }, 650);
    };
    send.onclick = () => {
      window.sends++;
      if (form.querySelector('[role="progressbar"]') || send.disabled) window.unsafeSends++;
      const composer = document.querySelector('#prompt-textarea');
      const user = document.createElement('div'); user.setAttribute('data-message-author-role','user'); user.textContent = composer.textContent;
      composer.textContent = '';
      const reply = document.createElement('div'); reply.setAttribute('data-testid','conversation-turn-' + window.sends);
      reply.innerHTML = '<div data-message-author-role="assistant">IMAGE_OK</div><button data-testid="copy-turn-button">Copy</button>';
      document.querySelector('#messages').append(user, reply);
      form.querySelectorAll('.composer-attachment-surface').forEach(e => e.remove());
    };
    </script>`;
}

const directory = await mkdtemp(join(tmpdir(), "bridge-image-attachment-e2e-"));
let app;
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [fileURLToPath(new URL("./chatgpt-mode-host.mjs", import.meta.url))],
    env: { ...process.env, CODEXGPT_BRIDGE_DOM_TEST_PROFILE: directory },
  });
  for (const kind of [
    "plain",
    "renamed",
    "wrong-name",
    "invalid-suffix",
    "uploading",
    "disabled",
  ]) {
    const blocked = !["plain", "renamed"].includes(kind);
    const result = await app.evaluate(
      async ({ BrowserWindow }, { html, blocked }) => {
        const abort = new globalThis.AbortController();
        const states = [];
        let target, error;
        const controller = new globalThis.ChatGptBrowserController(
          "data:text/html;charset=utf-8," + encodeURIComponent(html),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          async (options) => {
            target = new BrowserWindow({ ...options, show: false });
            const execute = target.webContents.executeJavaScript.bind(
              target.webContents,
            );
            target.webContents.executeJavaScript = async (code, gesture) => {
              const result = await execute(code, gesture);
              if (code.includes("const expectedNames =")) {
                states.push(result.value);
                if (blocked && states.length === 10) abort.abort();
              }
              return result;
            };
            return target;
          },
        );
        const images = [1, 2].map((index) => ({
          ref: "codex-input-image-" + index,
          imageUrl:
            "data:image/png;base64," + (index === 1 ? "aGVsbG8=" : "d29ybGQ="),
        }));
        try {
          for (let turn = 0; turn < (blocked ? 1 : 2); turn++) {
            await controller.runTurn({
              mode: "high",
              threadId: "images",
              turnId: "image-turn-" + turn,
              operationId: "image-turn-" + turn,
              prompt: "Image fixture test",
              images,
              signal: abort.signal,
            });
          }
        } catch (caught) {
          error = caught.message;
        }
        const state = await target.webContents.executeJavaScript(
          "({sends:window.sends,uploads:window.uploads,unsafeSends:window.unsafeSends})",
        );
        await controller.close();
        return { ...state, states, error };
      },
      { html: fixture(kind), blocked },
    );
    assert.equal(result.unsafeSends, 0, kind);
    assert.ok(
      result.states.some((s) => s.uploading && !s.ready),
      kind,
    );
    if (blocked) {
      assert.equal(result.sends, 0, kind);
      assert.ok(result.error, kind);
      assert.ok(
        result.states.every((s) => !s.ready),
        kind,
      );
      const last = result.states.at(-1);
      if (["wrong-name", "invalid-suffix"].includes(kind))
        assert.equal(last.matchedCount, 0);
      if (kind === "uploading") assert.equal(last.uploading, true);
      if (kind === "disabled") assert.equal(last.sendReady, false);
    } else {
      assert.equal(result.error, undefined, kind);
      assert.equal(result.sends, 2, kind);
      assert.equal(
        new Set(result.uploads.flat()).size,
        4,
        "Repeated turns use distinct file names",
      );
      assert.ok(
        result.states.some((s) => s.ready && s.matchedCount === 2),
        kind,
      );
    }
    process.stdout.write(
      JSON.stringify({ kind, passed: true, sends: result.sends }) + "\n",
    );
  }
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
