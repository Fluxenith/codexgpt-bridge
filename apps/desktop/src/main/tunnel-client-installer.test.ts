import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  ensureTunnelClient,
  tunnelClientRelease,
  type TunnelClientRelease,
  type TunnelClientRunner,
} from "./tunnel-client-installer.js";

const version = "0.0.16";
const run: TunnelClientRunner = async () => ({
  status: 0,
  stdout: `tunnel-client v${version}`,
  stderr: "",
});
function fixture(extra: Record<string, Uint8Array> = {}) {
  const archive = zipSync({
    "tunnel-client.exe": strToU8("test executable"),
    "cloudflared.exe": strToU8("test companion"),
    "cloudflared-manifest.json": strToU8("{}"),
    LICENSE: strToU8("test license"),
    ...extra,
  });
  const release: TunnelClientRelease = {
    version,
    asset: "fixture.zip",
    binary: "tunnel-client.exe",
    companion: "cloudflared.exe",
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
  let downloads = 0;
  const fetcher: typeof fetch = async (url) => {
    assert.equal(
      String(url),
      `https://github.com/openai/tunnel-client/releases/download/v${version}/fixture.zip`,
    );
    downloads += 1;
    return new Response(Buffer.from(archive));
  };
  return { release, fetcher, downloads: () => downloads };
}

it("selects pinned official assets and rejects unsupported architectures", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    for (const arch of ["x64", "arm64"]) {
      const release = tunnelClientRelease(platform, arch);
      assert.match(release.sha256, /^[a-f0-9]{64}$/u);
      assert.equal(release.binary.endsWith(".exe"), platform === "win32");
      assert.match(release.asset, /(?:amd64|arm64)\.zip$/u);
    }
  }
  assert.throws(
    () => tunnelClientRelease("win32", "ia32"),
    /does not support/u,
  );
});

it("installs the complete distribution once, shares concurrent setup, and reuses it offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-tunnel-install-"));
  try {
    const f = fixture();
    const [first, second] = await Promise.all([
      ensureTunnelClient(root, run, f.release, f.fetcher),
      ensureTunnelClient(root, run, f.release, f.fetcher),
    ]);
    assert.equal(first, second);
    assert.equal(f.downloads(), 1);
    assert.equal(
      await readFile(join(dirname(first), "cloudflared.exe"), "utf8"),
      "test companion",
    );
    assert.equal(
      await readFile(join(dirname(first), "LICENSE"), "utf8"),
      "test license",
    );
    const offline: typeof fetch = async () => {
      throw new Error("offline");
    };
    assert.equal(
      await ensureTunnelClient(root, run, f.release, offline),
      first,
    );
    assert.equal((await readdir(join(root, "tunnel", "client"))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("repairs a modified companion and leaves the previous cache intact when download fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-tunnel-repair-"));
  try {
    const f = fixture();
    const binary = await ensureTunnelClient(root, run, f.release, f.fetcher);
    const companion = join(dirname(binary), "cloudflared.exe");
    await writeFile(companion, "changed");
    const offline: typeof fetch = async () => {
      throw new Error("offline");
    };
    await assert.rejects(
      ensureTunnelClient(root, run, f.release, offline),
      /offline/u,
    );
    assert.equal(await readFile(companion, "utf8"), "changed");
    await ensureTunnelClient(root, run, f.release, f.fetcher);
    assert.equal(await readFile(companion, "utf8"), "test companion");
    assert.equal(f.downloads(), 2);
    assert.equal((await readdir(join(root, "tunnel", "client"))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a bad checksum before executing anything and permits retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-tunnel-checksum-"));
  try {
    const f = fixture();
    let executions = 0;
    const runner: TunnelClientRunner = async (...args) => {
      executions += 1;
      return run(...args);
    };
    const corrupt: typeof fetch = async () => new Response("corrupt");
    await assert.rejects(
      ensureTunnelClient(root, runner, f.release, corrupt),
      /checksum verification failed/u,
    );
    assert.equal(executions, 0);
    assert.deepEqual(await readdir(join(root, "tunnel", "client")), []);
    await ensureTunnelClient(root, runner, f.release, f.fetcher);
    assert.ok(executions > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects unsafe archive paths, missing companions, and the wrong executable version", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-tunnel-unpack-"));
  try {
    let executions = 0;
    const runner: TunnelClientRunner = async (...args) => {
      executions += 1;
      return run(...args);
    };
    for (const extra of [
      { "../outside": strToU8("bad") },
      { "cloudflared.exe": new Uint8Array() },
    ]) {
      const f = fixture(extra);
      await assert.rejects(
        ensureTunnelClient(root, runner, f.release, f.fetcher),
        /unexpected contents|missing cloudflared/u,
      );
    }
    assert.equal(executions, 0);
    const f = fixture();
    await assert.rejects(
      ensureTunnelClient(
        root,
        async () => ({ status: 0, stdout: "v9.9.9", stderr: "" }),
        f.release,
        f.fetcher,
      ),
      /expected version/u,
    );
    assert.deepEqual(await readdir(join(root, "tunnel", "client")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects HTTP and oversized downloads without installing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-tunnel-network-"));
  try {
    const f = fixture();
    const unavailable: typeof fetch = async () =>
      new Response("unavailable", { status: 503 });
    await assert.rejects(
      ensureTunnelClient(root, run, f.release, unavailable),
      /HTTP 503/u,
    );
    const oversized: typeof fetch = async () =>
      new Response("small", {
        headers: { "content-length": String(101 * 1024 * 1024) },
      });
    await assert.rejects(
      ensureTunnelClient(root, run, f.release, oversized),
      /exceeded 100 MiB/u,
    );
    assert.deepEqual(await readdir(join(root, "tunnel", "client")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
