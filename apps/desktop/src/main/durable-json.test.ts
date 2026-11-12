import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { spawn } from "node:child_process";
import { writeDurableJson } from "./durable-json.js";
import {
  CompletionDiagnosticStore,
  CompletionTrace,
} from "./completion-diagnostics.js";

it(
  "preserves atomic JSON replacement while a Windows reader temporarily denies delete sharing",
  { skip: process.platform !== "win32", timeout: 30000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-durable-sharing-"));
    const file = join(directory, "state.json");
    await writeDurableJson(file, '{"generation":1}');
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '$lease=[System.IO.File]::Open($env:BRIDGE_JSON_LOCK_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite); try { [Console]::WriteLine("LOCKED"); [Console]::Out.Flush(); Start-Sleep -Milliseconds 1500 } finally { $lease.Dispose() }',
      ],
      {
        env: { ...process.env, BRIDGE_JSON_LOCK_PATH: file },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("LOCKED")) resolve();
        });
        child.once("error", reject);
        child.once("close", () => {
          if (!output.includes("LOCKED"))
            reject(
              new Error("Windows reader did not acquire its fixture lock."),
            );
        });
      });
      await writeDurableJson(file, '{"generation":2}');
      assert.equal(await closed, 0);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
        generation: 2,
      });
      assert.deepEqual(JSON.parse(await readFile(file + ".previous", "utf8")), {
        generation: 1,
      });
      assert.deepEqual((await readdir(directory)).sort(), [
        "state.json",
        "state.json.previous",
      ]);
    } finally {
      child.kill();
      await closed;
      assert.ok(
        directory.startsWith(join(tmpdir(), "bridge-durable-sharing-")),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("keeps the last valid state when the primary is zero-filled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-durable-json-"));
  try {
    const file = join(directory, "state.json");
    await writeDurableJson(file, '{"generation":1}');
    await writeDurableJson(file, '{"generation":2}');
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      generation: 2,
    });
    assert.deepEqual(JSON.parse(await readFile(`${file}.previous`, "utf8")), {
      generation: 1,
    });
    await writeFile(file, Buffer.alloc(512));
    await assert.rejects(writeDurableJson(file, '{"generation":3}'));
    assert.deepEqual(JSON.parse(await readFile(`${file}.previous`, "utf8")), {
      generation: 1,
    });
    assert.deepEqual((await readdir(directory)).sort(), [
      "state.json",
      "state.json.previous",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("diagnostics retain a valid recovery copy across a restart", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "bridge-durable-diagnostics-"),
  );
  try {
    const file = join(directory, "diagnostics.json");
    await new CompletionDiagnosticStore(file).record(
      new CompletionTrace("first").finish("completed"),
    );
    await new CompletionDiagnosticStore(file).record(
      new CompletionTrace("second").finish("completed"),
    );
    assert.equal(JSON.parse(await readFile(file, "utf8")).length, 2);
    assert.equal(
      JSON.parse(await readFile(`${file}.previous`, "utf8"))[0].operationId,
      "first",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
