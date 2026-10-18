import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";

export const TUNNEL_CLIENT_VERSION = "0.0.16";
const RELEASE_URL = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_CLIENT_VERSION}`;
// Pinned from the official release's SHA256SUMS.txt. Updates require review.
const ARCHIVE_HASHES: Readonly<Record<string, string>> = {
  "darwin-amd64":
    "57b3dd73f2d042c7aeb5664681f7538078359f55538b9e048640f1df71a0c83f",
  "darwin-arm64":
    "a160820d45089b5253d8d671fe2a689bde0f73d78c135d1497a7b33f28a3ac62",
  "linux-amd64":
    "d60cdba019bce451bcc3a15478cc5b9cb11270b049f5b56ea39a80b517f8b117",
  "linux-arm64":
    "963d0384aaa7c798778479c45673f9051a4039dd891aef8f8978d2a1a628b74f",
  "windows-amd64":
    "edef7241b0c647fcb30f1a80ff376b6b25c51927960f257a3f01e21b17c2aba6",
  "windows-arm64":
    "ecd748288b9bd9cc8f5a963855eb143f4788b831475156703d0bafdcd2dcb149",
};
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;
const installs = new Map<string, Promise<string>>();

export interface TunnelClientRelease {
  readonly version: string;
  readonly asset: string;
  readonly sha256: string;
  readonly binary: string;
  readonly companion: string;
}

export type TunnelClientRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

export function tunnelClientRelease(
  platform: string = process.platform,
  arch: string = process.arch,
): TunnelClientRelease {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" ? "amd64" : arch;
  const sha256 = ARCHIVE_HASHES[`${os}-${cpu}`];
  if (!sha256)
    throw new Error(
      `Automatic Tunnel installation does not support ${platform}/${arch}. Set a compatible client path in advanced Tunnel settings.`,
    );
  const suffix = platform === "win32" ? ".exe" : "";
  return {
    version: TUNNEL_CLIENT_VERSION,
    asset: `tunnel-client-v${TUNNEL_CLIENT_VERSION}-${os}-${cpu}.zip`,
    sha256,
    binary: `tunnel-client${suffix}`,
    companion: `cloudflared${suffix}`,
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/u.test(name);
}

async function downloadArchive(
  url: string,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Official Tunnel download failed (HTTP ${response.status}).`,
    );
  }
  if (!response.body)
    throw new Error("Official Tunnel download returned no data.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (Number(response.headers.get("content-length")) > MAX_ARCHIVE_BYTES) {
      throw new Error("Tunnel download exceeded 100 MiB.");
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ARCHIVE_BYTES)
        throw new Error("Tunnel download exceeded 100 MiB.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, length);
}

async function verifyVersion(
  binary: string,
  release: TunnelClientRelease,
  run: TunnelClientRunner,
): Promise<void> {
  const version = await run(binary, ["--version"], 15_000);
  const output = `${version.stdout}\n${version.stderr}`;
  const versions = Array.from(
    output.matchAll(/\bv?(\d+\.\d+\.\d+)\b/gu),
    (match) => match[1],
  );
  if (version.status !== 0 || !versions.includes(release.version)) {
    throw new Error(
      "Downloaded Tunnel client did not report the expected version.",
    );
  }
  const help = await run(binary, ["runtimes", "connect", "--help"], 15_000);
  if (help.status !== 0)
    throw new Error(
      "Downloaded Tunnel client does not support managed runtimes.",
    );
}

async function validCache(
  directory: string,
  release: TunnelClientRelease,
  run: TunnelClientRunner,
): Promise<boolean> {
  try {
    const manifest = JSON.parse(
      await readFile(join(directory, "bridge-install.json"), "utf8"),
    ) as {
      version?: unknown;
      archiveSha256?: unknown;
      files?: Record<string, unknown>;
    };
    if (
      manifest.version !== release.version ||
      manifest.archiveSha256 !== release.sha256 ||
      !manifest.files
    )
      return false;
    const entries = Object.entries(manifest.files);
    if (
      entries.length < 3 ||
      entries.length > 32 ||
      ![release.binary, release.companion, "cloudflared-manifest.json"].every(
        (name) => manifest.files?.[name],
      )
    )
      return false;
    for (const [name, hash] of entries) {
      if (
        !safeName(name) ||
        typeof hash !== "string" ||
        digest(await readFile(join(directory, name))) !== hash
      )
        return false;
    }
    await verifyVersion(join(directory, release.binary), release, run);
    return true;
  } catch {
    return false;
  }
}

/** Installs the complete official distribution, including its Cloudflare companion and licenses. */
export function ensureTunnelClient(
  dataDirectory: string,
  run: TunnelClientRunner,
  release: TunnelClientRelease = tunnelClientRelease(),
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const parent = join(dataDirectory, "tunnel", "client");
  const directory = join(parent, release.sha256);
  const pending = installs.get(directory);
  if (pending) return pending;
  const operation = (async () => {
    if (await validCache(directory, release, run))
      return join(directory, release.binary);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(parent, ".install-"));
    try {
      const archive = await downloadArchive(
        `${RELEASE_URL}/${release.asset}`,
        fetcher,
      );
      if (digest(archive) !== release.sha256)
        throw new Error(
          "Tunnel download checksum verification failed. Nothing was installed.",
        );
      let total = 0;
      let count = 0;
      const files = unzipSync(archive, {
        filter: (entry) => {
          total += entry.originalSize;
          count += 1;
          if (
            !safeName(entry.name) ||
            entry.name === "bridge-install.json" ||
            total > MAX_EXTRACTED_BYTES ||
            count > 32
          ) {
            throw new Error("Official Tunnel archive has unexpected contents.");
          }
          return true;
        },
      });
      for (const name of [
        release.binary,
        release.companion,
        "cloudflared-manifest.json",
      ]) {
        if (!files[name]?.byteLength)
          throw new Error(`Official Tunnel archive is missing ${name}.`);
      }
      const hashes: Record<string, string> = {};
      for (const [name, bytes] of Object.entries(files)) {
        await writeFile(join(staging, name), bytes, {
          mode: 0o600,
          flag: "wx",
        });
        hashes[name] = digest(bytes);
      }
      for (const name of [release.binary, release.companion])
        await chmod(join(staging, name), 0o700);
      await verifyVersion(join(staging, release.binary), release, run);
      await writeFile(
        join(staging, "bridge-install.json"),
        JSON.stringify({
          version: release.version,
          archiveSha256: release.sha256,
          files: hashes,
        }),
        { mode: 0o600, flag: "wx" },
      );
      // Re-check in case another Bridge process finished installing while we downloaded.
      if (await validCache(directory, release, run))
        return join(directory, release.binary);
      // Preserve the previous directory until the verified replacement is in place.
      const previous = `${directory}.previous-${randomUUID()}`;
      let moved = false;
      try {
        await rename(directory, previous);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await rename(staging, directory);
      } catch (error) {
        if (moved) await rename(previous, directory);
        throw error;
      }
      if (moved) await rm(previous, { recursive: true, force: true });
      return join(directory, release.binary);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Unknown download error.";
      throw new Error(
        `Automatic Tunnel client setup failed: ${detail} Check your internet connection and retry, or set a client path in advanced Tunnel settings.`,
        { cause: error },
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  })();
  installs.set(directory, operation);
  void operation
    .finally(() => installs.delete(directory))
    .catch(() => undefined);
  return operation;
}
