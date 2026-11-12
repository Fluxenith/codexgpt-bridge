import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// This test intercepts HTTPS in its own isolated Electron partition. It never
// contacts Google, uses a real account or treats a fixture as live acceptance.
const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "bridge-embedded-gemini-"));
const entry = join(directory, "fixture.cjs");
const moduleUrl = pathToFileURL(
  join(root, "apps/desktop/dist/main/embedded-gemini-host.js"),
).href;
await writeFile(
  entry,
  `
const assert = require('node:assert/strict');
const {app,session}=require('electron');
console.log('EMBEDDED_FIXTURE_ENTRY');
(async()=>{
app.setPath('userData',${JSON.stringify(join(directory, "user-data"))});
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
await app.whenReady();console.log('EMBEDDED_FIXTURE_READY');
try {
 const {EmbeddedGeminiHost}=await import(${JSON.stringify(moduleUrl)});
 const partition=session.fromPartition('persist:gemini-web');
 await partition.protocol.handle('https',request=>{
  assert.equal(new URL(request.url).origin,'https://gemini.google.com');
  return new Response(${JSON.stringify('<!doctype html><button aria-label="Temporary chat"><mat-icon fonticon="gemini_chat_temp"></mat-icon></button><button aria-label="Send message">Send</button><button aria-label="Open mode picker, currently Flash">Flash</button><div role="menuitem" data-mode-id="flash">Flash</div><div role="textbox" contenteditable="true" class="ql-editor"></div><textarea aria-label="Draft"></textarea><div id="result"></div><script>document.querySelector(\'[aria-label="Send message"]\').onclick=()=>document.querySelector(\'#result\').textContent=document.querySelector(\'.ql-editor\').textContent;</script>')},{headers:{'content-type':'text/html'}});
 });
 const host=new EmbeddedGeminiHost();
 assert.equal(await host.restoreSavedLogin(),false);
 await assert.rejects(host.createPage('turn'),/Verify Gemini/u);
 await host.beginManualLogin('https://gemini.google.com/app?hl=en');
 assert.equal(host.manualLoginStatus().phase,'ready');
 assert.equal(host.manualLoginStatus().verified,false);
 host.finishManualLogin();
 const page=await host.createPage('login');
 const prefs=page.window.webContents.getLastWebPreferences();
 assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.sandbox,true);
 assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
 const editor=page.locator('.ql-editor');
 await editor.fill('first');assert.equal(await editor.innerText(),'first');
 await editor.fill('');assert.equal((await editor.innerText()).trim(),'');
 await editor.pressSequentially('@CodexGPT');assert.equal(await editor.innerText(),'@CodexGPT');
 await editor.fill('embedded input verified');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 assert.equal(await page.locator('#result').innerText(),'embedded input verified');
 assert.equal(await page.getByRole('button',{name:/^Open mode picker/u}).count(),1);
 assert.equal(await page.locator('button').and(page.getByRole('button',{name:'Send message',exact:true})).count(),1);
 assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).or(page.getByRole('button',{name:'Temporary chat',exact:true})).count(),2);
 const menus=page.locator('[role="menuitem"]').filter({visible:true});assert.equal((await menus.all()).length,1);
 assert.equal(await menus.nth(0).getAttribute('data-mode-id'),'flash');
 await assert.rejects(page.locator('button').click(),/one element/u);
 await assert.rejects(page.goto('https://example.com/'),/origin/u);
 await partition.cookies.set({url:'https://gemini.google.com',name:'fixture',value:'not-a-credential',expirationDate:Math.floor(Date.now()/1000)+3600});
 host.confirmVerifiedLogin();assert.equal(await host.createPage('turn'),page);
 await host.close();
 const restarted=new EmbeddedGeminiHost();assert.equal(await restarted.restoreSavedLogin(),true);
 assert.equal(restarted.manualLoginStatus().verified,false);
 await assert.rejects(restarted.createPage('turn'),/Verify Gemini/u);
 await restarted.close();
 console.log('EMBEDDED_GEMINI_FIXTURE_PASSED');app.exit(0);
} catch(error) { console.error(error);app.exit(1); }
})().catch(error=>{console.error(error);app.exit(1);});
`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)("electron"), [entry], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (data) => {
  output += data;
  process.stdout.write(data);
});
child.stderr.on("data", (data) => {
  output += data;
});
const timer = setTimeout(() => child.kill(), 45000);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
clearTimeout(timer);
if (code !== 0) console.error(output.slice(-6000));
assert.equal(code, 0);
assert.match(output, /EMBEDDED_GEMINI_FIXTURE_PASSED/u);
console.log(
  "Embedded Gemini fixture passed: isolated session, verified-login gate, trusted input, selectors, restart and origin checks.",
);
